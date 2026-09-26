# LLD: Agent Harness (Jira + GitHub)

Implements `docs/PRD-agent-harness.md`. Read `docs/design.md` and
`docs/requirements.md` first. This extends the GitHub polling flow in
`src/github-poll.ts`, `src/run-service.ts`, and `src/storage.ts`. It does not
replace it.

**Prior art:** [openai/symphony](https://github.com/openai/symphony) (SPEC.md)
solves the same class of problem — poll a tracker, dispatch an isolated agent
session per unit of work, reconcile state. Two of its design choices are
adopted here because they close gaps this LLD's first draft had:

1. **Per-link workspace isolation.** Symphony gives every issue its own
   workspace directory so concurrent agent runs never share a working tree.
   Our v1 draft didn't say anything about workspace isolation between
   sessions — §4a below fixes that.
2. **Adapter never writes.** Symphony's tracker adapter is read/normalize
   only; ticket comments, state transitions, and PR links are written by the
   agent itself through provider-native tools, using credentials the
   orchestrator hands it, not a second write path in the orchestrator. This
   resolves an open question in the first draft (who actually posts the reply
   comment, and with what auth) — see §6.2 below.

We do not adopt Symphony's full normalized `Issue`/`dispatchable` model or its
Elixir/OTP process supervision; those are architectural choices for a
different runtime and out of scope for this extension of the existing
poll-loop design in `github-poll.ts`.

## 1. Modules

New:

```
src/jira-auth.ts         # Jira client (API token), per tenant
src/jira-poll.ts         # Jira poll loop, same shape as github-poll.ts
src/jira-types.ts        # Jira REST response types we use
src/session-links.ts     # session_link CRUD and resolution (PRD R3)
src/opencode-session.ts  # opencode adapter: create, append turn, status, share URL
src/harness.ts           # routes poll events -> session-links -> opencode
```

Changed:

```
src/github-poll.ts             # PR-assignee trigger (R2); send linked events to harness.ts
src/storage.ts                 # session_link + jira_poll_state methods
sql/schema.sql                 # new tables (Postgres)
sql/schema.sqlite.sql          # new tables (SQLite)
src/config.ts, src/types.ts    # tenant.jira, tenant.opencode, tenant.harness
src/index.ts                   # start jira-poll next to github-poll
```

Schema lives in `sql/*.sql`, not in `storage.ts`. SQLite column changes also
need an entry in `ensureSqliteRunSchemaMigrations`.

## 2. Data model

Same two drivers as today (SQLite for dev, Postgres for prod). No new DB library.

```sql
CREATE TABLE session_link (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL,
  opencode_session_id   TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'active', -- active|idle|completed
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (tenant_id, opencode_session_id),
  UNIQUE (id)
);

-- One row can be linked to MANY identifiers (a ticket with 3 PRs, a PR closing
-- 2 issues). This is the fix for review finding #2 (one row could only hold
-- one Jira key + one issue + one PR + one repo).
--
-- `repo` is nullable (Jira keys have no repo), and NULL does not collide with
-- itself under SQL uniqueness (`NULL <> NULL` for constraint purposes) in
-- both Postgres and SQLite. The bare 3-column UNIQUE below silently allows
-- the same Jira key to be claimed twice -- reproduced against local Postgres
-- 17 and SQLite: two inserts of `(tenant, 'jira', NULL, 'PROJ-1')` both
-- succeed. Fixed with a generated/stored non-null substitute column so the
-- constraint actually applies to Jira rows:
CREATE TABLE session_link_key (
  link_id     TEXT NOT NULL,   -- FK added AFTER session_link row exists; see claim order below
  kind        TEXT NOT NULL,   -- 'jira' | 'gh_issue' | 'gh_pr'
  repo        TEXT,            -- 'owner/repo', null for kind='jira'
  repo_key    TEXT NOT NULL,   -- Postgres/SQLite portable substitute for `repo`:
                                -- set to `repo` when not null, else the literal
                                -- string '' so uniqueness actually fires for
                                -- Jira rows too. Application code sets this,
                                -- not a generated column, to stay portable
                                -- across the two schema files.
  value       TEXT NOT NULL,   -- jira issue key, or issue/PR number as text
  tenant_id   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  -- This is the actual race fix (review finding #1): a given identifier can
  -- belong to only one link, globally, enforced by the DB, not app logic.
  -- Uses repo_key, not repo, so NULL never bypasses the constraint.
  UNIQUE (tenant_id, kind, repo_key, value)
);
CREATE INDEX idx_session_link_key_link ON session_link_key (link_id);

CREATE TABLE jira_poll_state (
  tenant_id    TEXT PRIMARY KEY,
  last_cursor  TEXT NOT NULL,   -- `updated` timestamp of the newest issue seen
  updated_at   TEXT NOT NULL
);
```

**Creation order (claim-then-create), fixes review finding #1's second half:**

The naive "insert key row before session_link exists" approach breaks under a
real foreign key: Postgres rejects the insert (FK violation, no row to
reference yet); SQLite silently accepts it because `storage.ts` never turns on
`PRAGMA foreign_keys = ON`, so the two backends diverge. Fix: no DB-level FK
from `session_link_key.link_id` to `session_link.id`. The relationship is an
application invariant, checked in code and by tests, not the database. This
also matches how `session_link_key` is deliberately allowed to exist
momentarily with no corresponding row during the claim window below.

1. Generate a new `link_id` (uuid) client-side, before either table is
   touched.
2. Insert the `session_link_key` row with that `link_id`, inside a
   transaction. If the insert fails (unique violation on
   `(tenant_id, kind, repo_key, value)`), someone else claimed this
   identifier first — stop, look up their `link_id` via `resolveLink`, and
   follow the existing-row path instead of creating a session.
3. Only after the claim succeeds, call `createSession` (opencode) and then
   insert the `session_link` row using the same `link_id`.
4. If step 3 fails (opencode down), delete the claimed key row so a retry
   is possible; do not leave an orphan claim.
5. **Claim window:** between step 2 and step 3 succeeding, a `session_link_key`
   row exists with no matching `session_link` row yet. Any comment event that
   resolves to this `link_id` during that window must be treated as "link
   exists but session not ready" (queue the comment / return a transient
   retry), not as "no link" (which would create a second claim attempt) and
   not as a null-pointer read of a nonexistent session_link row. This state is
   normally sub-second (one DB insert plus one opencode API call) but must be
   handled, not assumed away.

## 3. `session-links.ts` (PRD R3)

```ts
type LinkKey =
  | { kind: "jira"; issueKey: string }
  | { kind: "gh_issue"; repo: string; number: number }
  | { kind: "gh_pr"; repo: string; number: number }

export async function resolveLink(store, tenantId: string, keys: LinkKey[]): Promise<SessionLink | null>
// Looks up session_link_key rows matching ANY key, joins to session_link.
// If keys match more than one DISTINCT link_id, that is a conflict (3.1).
// Never pick one silently.

export async function attachIdentifier(store, linkId: string, key: LinkKey): Promise<void>
// Inserts a session_link_key row for (tenantId, key.kind, repo, value) with
// this link_id. The UNIQUE constraint on session_link_key does the
// conflict detection: if the identifier is already claimed by a different
// link_id, the insert fails -- catch that, throw SessionLinkConflictError.
// The caller posts a bot comment ("this PR looks linked to two different
// tickets"). Never delete/reassign the other link's key row.

export async function claimAndCreateLink(store, tenantId, initialKey: LinkKey, createSession: () => Promise<OpencodeSession>): Promise<SessionLink>
// Implements the claim-then-create order from section 2: insert the key row
// first (the real concurrency guard), then call createSession, then insert
// session_link. On key-insert conflict, look up and return the existing link
// instead of creating a new session. On createSession failure, delete the
// claimed key row and rethrow.
```

Building the candidate `LinkKey[]` before `resolveLink`:

1. **Explicit hint** in the comment or ticket: `gh:<owner/repo>#123`,
   `jira:<KEY>`, a GitHub PR/issue URL, or a Jira browse URL.
   `commands.ts` already parses `tenant:<id>`, `owner/repo#N`, and `#N`.
   Extend it for `jira:` and `gh:`; do not write a second parser.
2. **Convention:** `Closes/Fixes/Resolves #N` in the PR body. Branch names
   matching `[A-Z]+-\d+` count as Jira keys.
3. **Existing row:** if a row already holds one of the event's own identifiers
   (for example, the second comment on a linked PR), that row wins over new
   hints from steps 1–2, unless they conflict (3.1).

This is one fixed order (hint → convention → existing row), not the two
different orders the first draft gave in the PRD vs this doc.

### 3.2 Attaching a PR the agent opens (review finding #4)

When `harness.ts` opens a PR on behalf of a linked Jira ticket, it must:
1. Name the branch `<config.branchPrefix>/<jira-key>-<slug>` (harness picks
   the name, not a guess after the fact).
2. After the PR is created, call `attachIdentifier(linkId, {kind: "gh_pr", ...})`
   immediately, in the same code path that created the PR. Do not rely on
   polling to notice the branch-name convention later — that is a race and a
   silent-miss risk if the convention match ever fails.

### 3.1 Conflicts

Example: a PR is linked to ticket A, and its body now says `Closes #999`, which
belongs to a row for ticket B.

- Do not merge.
- Post one bot comment on the triggering surface naming both links.
- Stop routing for that surface until someone resolves it.
- Log at `warn`.

This matches how `docs/design.md` handles failed tenant resolution.

## 4. `opencode-session.ts` (adapter)

**Everything in this section is unverified against the installed opencode
version and must be spiked first (review findings #6, #7 — these were stated
as fact in the first draft and were wrong or unconfirmed).**

```ts
export interface OpencodeSession {
  sessionId: string
  shareUrl: string | null   // see privacy note below before ever setting this
}

export async function createSession(params: {
  title: string             // e.g. "PROJ-123: fix flaky CI"
}): Promise<OpencodeSession>
// `POST /session` takes no directory/repoPath field in the documented API.
// Spike required: confirm whether repo binding is per-server (one `opencode
// serve` process per repo/worktree, started by the harness) or per-request.
// Do not build session-links.ts's repoPath assumption on an unverified API.

export async function appendTurn(sessionId: string, prompt: string): Promise<{ reply: string }>
// POST /session/:id/message blocks for the whole turn (can be minutes).
// Calling this synchronously from a poll tick stalls that tenant's poller.
// Default to prompt_async + poll getSessionStatus, not the blocking call,
// unless the spike shows turns are reliably short.

export async function getSessionStatus(sessionId: string): Promise<"running" | "idle" | "completed" | "not_found">
```

| Adapter call | Endpoint |
|---|---|
| `createSession` | `POST /session` (body: `{ parentID?, title? }`) |
| `appendTurn` | `POST /session/:id/message` (waits) or `POST /session/:id/prompt_async` |
| `getSessionStatus` | `GET /session/status` |
| share URL | `POST /session/:id/share` |

**Repo mapping (review finding #3):** `AssignmentEvent` needs a `repoPath`,
but nothing maps a Jira project to a repo. `tenant.jira` config gets a
required `repo: "owner/repo"` field (one project key -> one repo for v1;
multi-repo projects are out of scope and must be split into separate tenant
entries). `jira-poll.ts` sets `ev.repoPath` from this config field, not from
guessing.

**Privacy (review finding #6):** `opencode serve` binds `127.0.0.1` by
default, so a raw session URL is not reachable by a human without a tunnel.
`POST /session/:id/share` publishes the transcript to opencode's own hosted
share service — a PUBLIC link, not a private one. For a private repo, sharing
can leak code and comments. Before wiring `shareUrl` into any bot comment:
confirm the org is fine with public share links, or drop the share feature
and post `sessionId` + a local `opencode --resume` command instead. Do not
ship an assumed private/local share URL — that string does not exist in the
current opencode API.

**Permissions:** the server exposes `POST /session/:id/permissions/:id` for
approving tool-use prompts. A session running headless with no one polling
that endpoint will stall on the first permission prompt. Decide the default
permission mode (e.g. run opencode with `--yolo`/auto-approve equivalent) or
build a permission-auto-approve loop into the harness; this was undefined
in the first draft.

Config:

- `tenant.opencode.baseUrl`: default `http://127.0.0.1:4096` (opencode's default).
- `tenant.opencode.sharingEnabled`: default `false`. Only call `POST
  /session/:id/share` when explicitly turned on per tenant, given the public
  link caveat above. (Replaces the invented `shareBaseUrl` config key, which
  is not an opencode concept.)

Failures: if the opencode server is down, treat it like a Codex runner failure.
Post an actionable error comment, set the link to `idle`, keep polling.

## 4a. Workspace isolation (Symphony-inspired, with second-review fixes)

Each `session_link` gets its own workspace directory,
`<workspaceRoot>/<sanitized(tenant_id)>/<link_id>/`, checked out from
`repoPath` on first use. `link_id` is a server-generated uuid (§2), never
user input; `tenant_id` MUST be validated against an allowlist pattern
(`^[a-z0-9_-]+$`) before being used as a path segment — untrusted or
malformed tenant config must not reach the filesystem layer unchecked.

- **Checkout timing vs. the claim window (§2 step 5):** the checkout must
  happen only after the `session_link` row exists (§2 step 3), not during the
  claim window between steps 2 and 3. Doing it earlier means a workspace can
  exist for a `link_id` that's later rolled back (step 4, opencode failed) —
  now an orphaned checkout with nothing referencing it.
- **Cleanup of crashed/rolled-back claims:** if step 3 fails and step 4 rolls
  back the key row, and a workspace was already created (should not happen per
  the ordering above, but crashes mid-sequence are real), a periodic sweep
  compares `<workspaceRoot>/*/*` directories against live `link_id`s in
  `session_link` and deletes any with no matching row and no session_link_key
  claim younger than a short grace period (e.g. 5 minutes, to avoid deleting
  an in-flight claim).
- **No shared checkout with `run-service.ts`:** `run-service.ts` already does
  `git checkout -B` against its own working directory for unlinked runs (§6.1).
  The harness's per-link workspace MUST be a separate directory tree, never the
  same checkout `run-service.ts` uses for a repo — otherwise a harness session
  and an unlinked run-service run on the same repo can stomp each other's
  branch state. Use `git worktree add` from a single bare/mirror clone per
  repo under `<workspaceRoot>/.bare/<repo>` if disk usage from N full clones
  becomes a problem; out of scope for v1, which does N full clones.
- Two links for the same repo never share a workspace, even if both are
  active at once.
- Workspace directories persist across reactivation (§6) so a resumed session
  sees its own prior branch state, not a fresh clone.
- **opencode server lifetime vs. harness restart (PRD AC6):** if the
  opencode-per-workspace-directory model from the §4/§9 spike is confirmed, a
  per-workspace server process dies when the harness process dies, and
  restarting the harness does not automatically restart it. The harness's
  startup/reconciliation path (referenced in Symphony's own restart-recovery
  goal, §2.1) must re-launch a server for every `session_link` with
  `status IN ('active','idle')` before it can accept new turns for that link,
  or AC6 (resume within the reactivation window) silently fails after any
  harness restart. This is a required build item for step 5 (`harness.ts`),
  not an assumption.
- Cleanup: delete the workspace directory only when `status = 'completed'`
  and past `reactivationWindowMinutes`, same lifecycle as the DB row's
  `completed` state. Never delete a workspace for an `active`/`idle` link.

## 5. `jira-poll.ts` (PRD R1)

Same structure as `startGitHubPolling`:

```ts
export function startJiraPolling(params: {
  config: AppConfig
  store: RunStore
  harness: Harness          // see §6
  env: JiraPollEnv
}) {
  // Same `running` re-entrancy guard, same per-tenant try/catch,
  // same 10s minimum interval as github-poll.ts.
}
```

Query per tick, for each tenant with `tenant.jira`:

```
GET /rest/api/3/search/jql
  jql: project = {projectKey} AND updated >= "{lastCursor}" ORDER BY updated ASC
  fields: assignee,comment,status,summary
```

**Cursor precision and dedupe (review finding #8):** JQL `updated >=` has
minute precision and evaluates in the searching user's Jira timezone, not
UTC/ISO seconds. Two issues can share a minute and land on either side of a
tick boundary. To avoid dropping one:
- Re-query one minute of overlap on every tick (subtract 60s from `lastCursor`
  before the query) and dedupe against `jira_seen_comment`/an
  already-processed-issue check, rather than trusting the boundary is exact.
- `nextPageToken` from `/search/jql` is a same-request pagination token, not a
  cross-tick cursor. Do not reuse it as `lastCursor` between ticks — only
  `fields.updated` is safe for that.

**Comment bodies are ADF, not text (review finding #8):** Jira Cloud v3
comment bodies are Atlassian Document Format (JSON), not plain strings.
`appendTurn` needs plain text, and any reply posted back to Jira needs ADF.
Add an `adfToText`/`textToAdf` pair in `jira-types.ts` (or a small vendored
converter) as a required build item, not an afterthought — this was assumed
away in the first draft.

- After each successful tick, set `lastCursor` to the newest `fields.updated`
  seen and save it to `jira_poll_state`.
- For each issue:
  - **Bootstrap:** `fields.assignee.accountId === tenant.jira.agentAccountId`
    and no link row for the key.
  - **Comment:** a comment newer than the last one processed for this issue and
    not written by the agent account. Track the last seen comment per issue.
    Use a `jira_seen_comment` table if an issue can get more than one comment
    per tick.
- Auth header: `Basic base64(email:apiToken)`, built once per tenant. API tokens
  do not expire like GitHub installation tokens, so no refresh cache.

## 6. `harness.ts` (orchestrator)

Both pollers call the harness instead of `run-service.ts`. All linking and
session logic lives here.

```ts
export async function handleAssignmentEvent(ctx: HarnessCtx, ev: AssignmentEvent): Promise<void>
// ev: { source: "jira" | "github_pr" | "github_issue", tenantId, keys: LinkKey[], repoPath, title }
// 1. candidateKeys = buildCandidateKeys(ev)          // §3 order
// 2. existing = await resolveLink(store, tenantId, candidateKeys)
// 3. existing and not completed: reuse its session. Re-assignment is a no-op.
// 4. existing, completed, inside reactivation window: resume the same
//    session id, set status 'active'.
// 5. otherwise: claimAndCreateLink(...) (§2/§3 claim-then-create order), post
//    the share link (or resume command, see §4) to ev.source and to other
//    surfaces per mirrorReplies.

export async function handleCommentEvent(ctx: HarnessCtx, ev: CommentEvent): Promise<void>
// ev: { source, tenantId, keys: LinkKey[], commentBody, authorIsBot }
// 1. authorIsBot: return.
// 2. link = await resolveLink(store, tenantId, ev.keys)
// 3. no link: bootstrap only if the comment mentions the agent, else ignore
//    (same rule as unmanaged GitHub issues today).
// 4. { reply } = await appendTurn(link.opencodeSessionId, ev.commentBody)
// 5. post reply to ev.source; to other linked surfaces only if mirrorReplies === 'all'.
// 6. set updated_at, status = 'active'.
```

`github-poll.ts` and `jira-poll.ts` only produce events.

### 6.1 Boundary with `run-service.ts` (review finding #5)

`run-service.ts` today owns: labels, status comments, branch/PR creation
(`updateRunPr`), `run_events`, the Vibe mirror, and the redis/memory run
queue (`ROLE=api|worker`). The harness does not replace any of that — it is
a second entry point that decides WHICH runner path an event takes:

- **Linked event** (has a `session_link` row, or its keys match one after
  step 1-3 of `handleAssignmentEvent`/`handleCommentEvent`): routed to
  `harness.ts` -> opencode. `run-service.ts` is not called for this event.
- **Unlinked GitHub issue/PR** (today's normal flow, no Jira involvement):
  unchanged, goes to `run-service.ts` -> Codex runner, exactly as it does now.
- Decision point: `github-poll.ts` checks `resolveLink` first. A hit routes to
  the harness; a miss falls through to the existing `run-service.ts` call.
- The webhook path (`src/github.ts`, mounted in `index.ts`) is a second
  GitHub entry point that also creates runs today. It needs the same
  `resolveLink` check before its existing `run-service.ts` call, or linked
  PRs/issues arriving via webhook bypass the harness entirely. **This is not
  yet in the §8 build order below** — a second review caught that the
  original text claimed it was in step 6 when it wasn't. Added as step 6a.
- `appendTurn` for a running turn: use `prompt_async` (§4) so a poll tick
  never blocks on a multi-minute opencode turn. Concurrent comments on the
  same session queue in `harness.ts` behind a per-session in-process lock
  (single instance for v1); a second harness instance is out of scope until
  the queue is externalized.

### 6.2 Who writes back to Jira/GitHub (Symphony-inspired, corrected)

The first draft got Symphony's model backwards, and a second review caught
it: Symphony does not hand the agent raw tracker credentials. Its own spec
says the agent's tool calls are executed by Symphony itself, with the
orchestrator holding the credential; "the child receives tool results, not a
raw token." opencode's SDK also has no per-session credential/environment
parameter to inject one — confirmed by inspecting its generated types. Handing
the opencode process itself a scoped Jira/GitHub token is not something the
current API supports, and even if it were, it would defeat the point (the
credential would live inside the untrusted agent process).

Corrected model:

- The harness runs a small MCP tool server (or reuses opencode's existing MCP
  wiring) that exposes `post_jira_comment`, `post_github_comment`,
  `transition_jira_status`, etc. as tools. This server, not the opencode
  process, holds the tenant's Jira/GitHub credentials.
- The opencode session calls these tools like any other MCP tool; the harness
  process executes the actual API call server-side and returns only the
  result to the agent. The agent never sees the token.
- This also fixes §3.2 (PR attachment): the `post_github_comment`/"open PR"
  tool call is the same code path that calls `attachIdentifier`, so the
  attach happens atomically with the write, not via branch-name convention
  matching after the fact.
- Tool scope is per-link: the MCP server only exposes write access to the
  ticket/repo identifiers already attached to the calling session's
  `link_id` — enforced by the harness, not by trusting the agent's prompt.
- `mirrorReplies` (§7) means: after a tool call succeeds on the origin
  surface, the harness (not the agent) decides whether to also call the
  matching tool on other linked surfaces, based on config. This keeps the
  mirroring policy in one place instead of depending on prompt wording.
- Bot identity, token refresh, and ADF conversion (Jira) all live in this
  MCP tool server, alongside `jira-auth.ts`. This is new required build work,
  not already covered elsewhere in this doc — add it to §8 step 5
  (`harness.ts`), since the tool server and the orchestrator are delivered
  together.

### GitHub poller changes this needs

- `pollAssignedIssues` skips PRs today (`if (issue.pull_request) continue`).
  Remove that for the PR trigger.
- The comment loop drops loose follow-ups on issues without `agent:managed`.
  A linked PR or issue must count as managed even without the label.
- The comment loop reads `issues.listCommentsForRepo` only. That covers PR
  conversation comments, not inline review comments. AC3 needs review
  comments, so add a `pulls.listReviewCommentsForRepo` pass.

## 7. Config

```yaml
tenants:
  - id: local
    repos: [...]
    github: {...}          # existing
    jira:
      baseUrl: "https://yourorg.atlassian.net"
      projectKey: "PROJ"
      repo: "owner/repo"                   # review finding #3: explicit mapping, one repo per project in v1
      agentAccountId: "712020:xxxx-xxxx"   # the agent's Jira account
      pollIntervalSec: 30
    opencode:
      baseUrl: "http://127.0.0.1:4096"
      sharingEnabled: false     # see §4 privacy note before enabling
    harness:
      mirrorReplies: "origin-only"   # or "all"
      reactivationWindowMinutes: 60
```

- Validate with the `zod` schemas in `config.ts`.
- `jira` is optional. No `jira` block means no Jira poller, like the optional
  `slack` block.
- Credentials: `config.ts` does not expand `${VAR}` in YAML. Read
  `JIRA_EMAIL` and `JIRA_API_TOKEN` from env in `loadEnv()`, or add them to the
  `secrets` block. Never put them in the tenants file in git.

## 8. Build order

Each step is one card and depends on the one before it.

1. **Storage:** `session_link`, `session_link_key` (no DB-level FK between
   them, per §2), and `jira_poll_state` in both schema files, store
   methods, tests covering the claim-then-create sequence and the
   Jira-NULL-repo unique-constraint case.
2. **`session-links.ts`:** resolve, attach, conflicts. Unit tests for AC5, §3.1,
   and the claim-window state from §2 step 5.
3. **`opencode-session.ts`:** tests against a real local `opencode serve`. It is
   under our control, so do not mock it.
4. **`jira-poll.ts`:** poll loop and client. Unit tests use a fake Jira server,
   since Jira Cloud is outside local test control.
5. **`harness.ts`:** wire 2–4, plus the MCP tool server from §6.2
   (`post_jira_comment`, `post_github_comment`, `transition_jira_status`).
   Real tests for AC1–AC4 live here.
6. **`github-poll.ts` PR trigger (R2):** smallest change, done last so it routes
   into a tested harness.
6a. **`src/github.ts` webhook path:** add the same `resolveLink` check ahead
   of its existing `run-service.ts` call (§6.1). Depends on step 5 being
   done; without this step, linked PRs/issues arriving via webhook silently
   bypass the harness.
7. **E2E**, added to `docs/test-protocol.md` and a `scripts/test-*.ts` runner:
   assign Jira ticket → session created → comment on linked PR → same session
   → Jira comment → same session. This test proves the PRD.

## 9. Risks and open items

- **opencode API.** Check the installed version's `/doc` spec before writing
  the adapter. Treat it as a spike. Do not build on assumed endpoints.
- **Repo binding.** `POST /session` takes no directory. Decide how a session
  gets its repo: one server per repo, a per-request directory parameter, or
  something else.
- **Sharing.** Confirm what `POST /session/:id/share` publishes and where,
  before posting share links on public repos.
- **Jira search.** `/rest/api/3/search/jql` replaced the old `/search`. It is
  Jira Cloud only. Server/Data Center uses a different endpoint and auth.
  Confirm which one the target site runs.
