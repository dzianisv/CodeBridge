# LLD: Agent Harness (Jira + GitHub)

Implements `docs/PRD-agent-harness.md`. Read `docs/design.md` and
`docs/requirements.md` first. This extends the GitHub polling flow in
`src/github-poll.ts`, `src/run-service.ts`, and `src/storage.ts`. It does not
replace it.

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
  jira_issue_key        TEXT,
  github_repo           TEXT,          -- 'owner/repo'
  github_issue_number   INTEGER,
  github_pr_number      INTEGER,
  opencode_session_id   TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'active', -- active|idle|completed
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (tenant_id, opencode_session_id)
);
CREATE INDEX idx_session_link_jira  ON session_link (tenant_id, jira_issue_key);
CREATE INDEX idx_session_link_ghiss ON session_link (tenant_id, github_repo, github_issue_number);
CREATE INDEX idx_session_link_ghpr  ON session_link (tenant_id, github_repo, github_pr_number);

CREATE TABLE jira_poll_state (
  tenant_id    TEXT PRIMARY KEY,
  last_cursor  TEXT NOT NULL,   -- `updated` timestamp of the newest issue seen
  updated_at   TEXT NOT NULL
);
```

`UNIQUE (tenant_id, opencode_session_id)` enforces AC5 in the database. It is
required: the Jira and GitHub loops can race.

## 3. `session-links.ts` (PRD R3)

```ts
type LinkKey =
  | { kind: "jira"; issueKey: string }
  | { kind: "gh_issue"; repo: string; number: number }
  | { kind: "gh_pr"; repo: string; number: number }

export async function resolveLink(store, tenantId: string, keys: LinkKey[]): Promise<SessionLink | null>
// Finds rows matching ANY key. If keys match more than one row, that is a
// conflict (see 3.1). Never pick one silently.

export async function attachIdentifier(store, linkId: string, key: LinkKey): Promise<void>
// Sets the column if it is NULL. If it holds a different value, throws
// SessionLinkConflictError. The caller posts a bot comment
// ("this PR looks linked to two different tickets"). Never overwrite.

export async function createLink(store, tenantId, initialKey: LinkKey, opencodeSessionId: string): Promise<SessionLink>
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

### 3.1 Conflicts

Example: a PR is linked to ticket A, and its body now says `Closes #999`, which
belongs to a row for ticket B.

- Do not merge.
- Post one bot comment on the triggering surface naming both links.
- Stop routing for that surface until someone resolves it.
- Log at `warn`.

This matches how `docs/design.md` handles failed tenant resolution.

## 4. `opencode-session.ts` (adapter)

v1 talks to one shared `opencode serve` process over HTTP. It creates and
resumes sessions on that server. It does not spawn one `opencode` per session.

```ts
export interface OpencodeSession {
  sessionId: string
  shareUrl: string | null   // null when sharing is off
}

export async function createSession(params: {
  repoPath: string
  title: string             // e.g. "PROJ-123: fix flaky CI"
}): Promise<OpencodeSession>

export async function appendTurn(sessionId: string, prompt: string): Promise<{ reply: string }>

export async function getSessionStatus(sessionId: string): Promise<"running" | "idle" | "completed" | "not_found">
```

opencode server endpoints this maps to (from opencode.ai/docs/server; verify
against the installed version):

| Adapter call | Endpoint |
|---|---|
| `createSession` | `POST /session` (body: `{ parentID?, title? }`) |
| `appendTurn` | `POST /session/:id/message` (waits) or `POST /session/:id/prompt_async` |
| `getSessionStatus` | `GET /session/status` |
| share URL | `POST /session/:id/share` |

`POST /session` has no repo/directory field. How a session is bound to
`repoPath` is still open (see §9).

Config:

- `tenant.opencode.baseUrl`: default `http://127.0.0.1:4096` (opencode's default).
- `tenant.opencode.shareBaseUrl`: optional. If unset, `shareUrl` is null and the
  harness posts the session id and a local resume command instead.

Failures: if the opencode server is down, treat it like a Codex runner failure.
Post an actionable error comment, set the link to `idle`, keep polling.

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
// 5. otherwise: create a session, createLink(...), post the share link to
//    ev.source (and to other surfaces per mirrorReplies).

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
      agentAccountId: "712020:xxxx-xxxx"   # the agent's Jira account
      pollIntervalSec: 30
    opencode:
      baseUrl: "http://127.0.0.1:4096"
      shareBaseUrl: null       # optional
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
