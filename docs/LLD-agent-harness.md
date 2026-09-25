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
CREATE TABLE session_link_key (
  link_id    TEXT NOT NULL REFERENCES session_link(id),
  kind       TEXT NOT NULL,   -- 'jira' | 'gh_issue' | 'gh_pr'
  repo       TEXT,            -- 'owner/repo', null for kind='jira'
  value      TEXT NOT NULL,   -- jira issue key, or issue/PR number as text
  tenant_id  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- This is the actual race fix (review finding #1): a given identifier can
  -- belong to only one link, globally, enforced by the DB, not app logic.
  UNIQUE (tenant_id, kind, repo, value)
);
CREATE INDEX idx_session_link_key_link ON session_link_key (link_id);

CREATE TABLE jira_poll_state (
  tenant_id    TEXT PRIMARY KEY,
  last_cursor  TEXT NOT NULL,   -- `updated` timestamp of the newest issue seen
  updated_at   TEXT NOT NULL
);
```

`UNIQUE (tenant_id, opencode_session_id)` enforces AC5 (no two rows share a
session). `UNIQUE (tenant_id, kind, repo, value)` on `session_link_key`
enforces the actual race condition callers care about: two pollers cannot both
insert a key row for the same Jira ticket / GitHub issue / GitHub PR, because
the second insert fails the constraint. This replaces the old design where
`session_link` embedded exactly one of each identifier — that could not model
"one ticket, three PRs" and did not stop a genuine double-bootstrap race
(review finding #1 and #2).

**Creation order (claim-then-create), fixes review finding #1's second half:**
1. Insert the `session_link_key` row for the triggering identifier FIRST,
   inside a transaction, with a placeholder `link_id` that does not yet have a
   `session_link` row. If the insert fails (unique violation), someone else
   claimed this identifier — stop, look up their `link_id`, and follow the
   existing-row path instead of creating a session.
2. Only after the claim succeeds, call `createSession` (opencode) and then
   insert the `session_link` row using the same `link_id`.
3. If step 2 fails (opencode down), delete the claimed key row so a retry
   is possible; do not leave an orphan claim.

This avoids the old ordering problem: `opencode_session_id NOT NULL` meant the
session had to exist before the row could be inserted, which left no way to
claim an identifier atomically before paying the cost of creating a session.
Claiming the identifier first is cheap (a DB insert) and is the actual
concurrency guard; the session gets created once, by whichever caller wins.

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

## 4a. Workspace isolation (Symphony-inspired)

Each `session_link` gets its own workspace directory,
`<workspaceRoot>/<tenant_id>/<link_id>/`, checked out from `repoPath` on
first use. This is the missing half of the repo-binding question in §4:

- The harness, not opencode, owns the checkout. It clones/worktrees the repo
  into the link's workspace directory before the first `createSession` call
  for that link, and passes that directory to whatever repo-binding mechanism
  the opencode spike settles on (one `opencode serve` per workspace directory
  is the leading candidate — confirm in the spike).
- Two links for the same repo never share a workspace, even if both are
  active at once — this is what actually prevents one session's uncommitted
  changes from bleeding into another's.
- Workspace directories persist across reactivation (§6) so a resumed session
  sees its own prior branch state, not a fresh clone.
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
  PRs/issues arriving via webhook bypass the harness entirely. This is a
  required change to `src/github.ts`, not optional — added to the build
  order in §8 as part of step 6.
- `appendTurn` for a running turn: use `prompt_async` (§4) so a poll tick
  never blocks on a multi-minute opencode turn. Concurrent comments on the
  same session queue in `harness.ts` behind a per-session in-process lock
  (single instance for v1); a second harness instance is out of scope until
  the queue is externalized.

### 6.2 Who writes back to Jira/GitHub (Symphony-inspired)

The first draft left this implicit. Following Symphony's adapter-never-writes
rule:

- The harness does not post replies itself using a bot API token. Instead, the
  opencode session is given the tracker credentials (a scoped Jira API token
  and a GitHub token, per tenant) as tool access, and the agent's own reply —
  the actual comment, status transition, or PR update — is written by the
  agent through those tools as part of its turn.
- `harness.ts` is responsible only for: routing the event to the right
  session, and (only as a fallback, e.g. the opencode call itself failed) for
  posting a bot error comment saying the run failed. It is not responsible for
  mirroring the agent's own successful reply.
- This changes `mirrorReplies` in config (§7): it no longer means "the harness
  copies text between surfaces" — it means "the harness's prompt to the agent
  instructs it to reply on the other linked surfaces too." Document this
  distinction in the prompt template, not just the config comment.
- Credential scoping: the tenant's Jira/GitHub tokens used by the agent must
  be least-privilege (comment + status-transition on the linked ticket, not
  admin/org-wide), since the token now lives inside the agent's tool-call
  surface, not just the harness process.

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

1. **Storage:** `session_link` and `jira_poll_state` in both schema files, store
   methods, tests.
2. **`session-links.ts`:** resolve, attach, conflicts. Unit tests for AC5 and §3.1.
3. **`opencode-session.ts`:** tests against a real local `opencode serve`. It is
   under our control, so do not mock it.
4. **`jira-poll.ts`:** poll loop and client. Unit tests use a fake Jira server,
   since Jira Cloud is outside local test control.
5. **`harness.ts`:** wire 2–4. Real tests for AC1–AC4 live here.
6. **`github-poll.ts` PR trigger (R2):** smallest change, done last so it routes
   into a tested harness.
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
