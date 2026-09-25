# LLD: CodeBridge Agent Harness (Jira + GitHub Event Loop)

Implements `docs/PRD-agent-harness.md`. Read `docs/design.md` and `docs/requirements.md`
first — this extends, not replaces, the existing GitHub polling architecture in
`src/github-poll.ts`, `src/run-service.ts`, `src/storage.ts`.

## 1. Module map

New modules (mirror existing naming):

```
src/jira-auth.ts        # Jira client construction (API token auth), tenant-scoped
src/jira-poll.ts        # Jira polling loop, mirrors github-poll.ts structure
src/jira-types.ts        # Jira REST response shapes we actually consume
src/session-links.ts     # session_link CRUD + resolution (the cross-ref core, R3)
src/opencode-session.ts  # opencode adapter: create/resume/append-turn/get-share-url
src/harness.ts           # top-level orchestrator wiring poll events -> session-links -> opencode
```

Modified:

```
src/github-poll.ts   # add PR-assignee trigger (R2), route through harness.ts instead
                      # of run-service.ts directly for linked events
src/storage.ts        # add session_link table + jira poll high-water mark table
src/config.ts / types.ts  # tenant.jira config block, tenant.harness.mirrorReplies
src/index.ts           # bootstrap jira-poll alongside github-poll
```

## 2. Data model (storage.ts)

Two new tables (SQLite dev / Postgres prod — reuse existing `storage.ts` dual-driver
pattern, do not add a second DB library).

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
CREATE INDEX idx_session_link_jira   ON session_link (tenant_id, jira_issue_key);
CREATE INDEX idx_session_link_ghiss  ON session_link (tenant_id, github_repo, github_issue_number);
CREATE INDEX idx_session_link_ghpr   ON session_link (tenant_id, github_repo, github_pr_number);

CREATE TABLE jira_poll_state (
  tenant_id      TEXT PRIMARY KEY,
  last_cursor    TEXT NOT NULL,   -- Jira `updated` JQL cursor (ISO timestamp) or nextPageToken
  updated_at     TEXT NOT NULL
);
```

Note the `UNIQUE (tenant_id, opencode_session_id)` constraint is what enforces
PRD AC5 (no two rows share a session) at the DB layer, not just app logic —
required, not optional, because two poll loops (Jira + GitHub) can race.

## 3. `session-links.ts` — resolution algorithm (implements PRD R3)

```ts
type LinkKey =
  | { kind: "jira"; issueKey: string }
  | { kind: "gh_issue"; repo: string; number: number }
  | { kind: "gh_pr"; repo: string; number: number }

export async function resolveLink(store, tenantId: string, keys: LinkKey[]): Promise<SessionLink | null>
// Query session_link where ANY of the provided keys match. If keys resolve to
// MORE THAN ONE distinct row, this is a conflict (two previously-separate threads
// now claim to be the same work) -- see section 3.1, do not silently pick one.

export async function attachIdentifier(store, linkId: string, key: LinkKey): Promise<void>
// Sets the corresponding column IF NULL. If the column is already set to a
// DIFFERENT value, throws SessionLinkConflictError -- caller must surface this
// as a bot comment ("this PR looks linked to two different tickets") rather than
// overwrite (PRD R3 "fail loudly, not silently overwrite").

export async function createLink(store, tenantId, initialKey: LinkKey, opencodeSessionId: string): Promise<SessionLink>
```

Precedence for building the `LinkKey[]` candidate list before calling `resolveLink`
(implements PRD R3 precedence order 1-4):

1. Explicit hint parsed from the triggering comment/ticket body
   (`gh:<owner/repo>#123`, `jira:<KEY>`, a GitHub PR/issue URL, or a Jira browse
   URL) — reuse `commands.ts`'s existing hint-parsing patterns, extend rather than
   duplicate.
2. Convention-derived keys: PR body `Closes/Fixes/Resolves #N`; branch name regex
   `[A-Z]+-\d+` matched as a Jira key.
3. If a `session_link` already contains ANY of the triggering event's own
   identifiers (e.g. this is the 2nd comment on a PR whose link row already
   exists), that row wins regardless of new hints found in step 1/2 UNLESS the new
   hint conflicts (see 3.1).

### 3.1 Conflict handling

If `resolveLink` finds keys pointing at two different existing rows (e.g. a PR
already linked to ticket A, but its body now says `Closes #999` which belongs to a
row linked to ticket B): do NOT merge automatically. Post one bot comment on the
triggering surface naming both linked ids and stop routing until a human/agent
explicitly resolves it (mirrors the "escalate ambiguous state" posture already used
for tenant-resolution failures in `docs/design.md`). Log at `warn`.

## 4. `opencode-session.ts` — adapter contract

v1 target mode (per PRD open question default): a local `opencode serve` HTTP API
process per tenant (or one shared instance handling multiple sessions — prefer
one shared instance keyed by session id, simpler ops). CodeBridge does NOT spawn a
new `opencode` process per session; it creates/resumes SESSIONS against one running
server.

```ts
export interface OpencodeSession {
  sessionId: string
  shareUrl: string | null   // null if opencode instance has no configured public/share base URL
}

export async function createSession(params: {
  repoPath: string
  title: string             // e.g. "PROJ-123: fix flaky CI"
}): Promise<OpencodeSession>

export async function appendTurn(sessionId: string, prompt: string): Promise<{ reply: string }>

export async function getSessionStatus(sessionId: string): Promise<"running" | "idle" | "completed" | "not_found">
```

Config: `tenant.opencode.baseUrl` (default `http://127.0.0.1:4096`, opencode's
default serve port), `tenant.opencode.shareBaseUrl` (optional, used to build
`shareUrl` for humans; if unset, `shareUrl` is null and the harness falls back to
posting the raw session id + local resume command instead of a URL).

Failure handling: opencode server unreachable must be treated exactly like a
Codex runner failure in the existing code — post an actionable error comment,
mark the run/link `idle`, never crash the poll loop (PRD AC7 pattern extended to
opencode as a third external dependency).

## 5. `jira-poll.ts` — polling loop (implements PRD R1)

Structure directly mirrors `github-poll.ts`'s `startGitHubPolling`:

```ts
export function startJiraPolling(params: {
  config: AppConfig
  store: RunStore
  harness: Harness          // see section 6
  env: JiraPollEnv
}) {
  // same `running` re-entrancy guard, same per-tenant isolation (try/catch per
  // tenant so one tenant's Jira outage doesn't stop others), same min-interval
  // floor (10s) as github-poll.ts.
}
```

Jira query per tick, per tenant with `tenant.jira` configured:

```
GET /rest/api/3/search/jql
  jql: project = {projectKey} AND updated >= "{lastCursor}" ORDER BY updated ASC
  fields: assignee,comment,status,summary
```

- Advance `lastCursor` to the max `fields.updated` seen, persisted to
  `jira_poll_state` after each successful tick (same "high-water mark" pattern as
  GitHub poll state in `storage.ts`).
- For each returned issue:
  - if `fields.assignee.accountId === tenant.jira.agentAccountId` AND no existing
    `session_link` for this Jira key → bootstrap event (R1 issue.assigned).
  - for each comment newer than the last time we processed this issue (track
    per-issue last-seen comment id/timestamp, can reuse the same `jira_poll_state`
    row keyed finer, or a second small table if per-issue tracking is needed —
    prefer per-issue tracking with a `jira_seen_comment` table if comment volume
    per tick can be >1 per issue) AND not authored by the bot's own Jira account →
    comment event (R1 comment.created).
- Auth: `Authorization: Basic base64(email:apiToken)` built once per tenant, cached
  (no token TTL/refresh needed for API tokens, unlike GitHub App installation
  tokens — simpler than `github-poll.ts`'s client cache).

## 6. `harness.ts` — orchestrator (ties R1-R6 together)

Single entry point both pollers call instead of talking to `run-service.ts`
directly, so link-resolution logic lives in ONE place:

```ts
export async function handleAssignmentEvent(ctx: HarnessCtx, ev: AssignmentEvent): Promise<void>
// ev: { source: "jira" | "github_pr" | "github_issue", tenantId, keys: LinkKey[], repoPath, title }
// 1. candidateKeys = buildCandidateKeys(ev)   // section 3 precedence
// 2. existing = await resolveLink(store, tenantId, candidateKeys)
// 3. if existing && existing.status !== 'completed': reuse its session (idempotent
//    re-assignment, e.g. Jira fires assigned twice) -- do NOT create a second session.
// 4. if existing && existing.status === 'completed' && withinReactivationWindow:
//    resume same opencode session id (R4), set status back to 'active'.
// 5. else: create opencode session, createLink(...), post share link/id back to
//    ev.source (and mirror per tenant.harness.mirrorReplies).

export async function handleCommentEvent(ctx: HarnessCtx, ev: CommentEvent): Promise<void>
// ev: { source, tenantId, keys: LinkKey[], commentBody, authorIsBot }
// 1. if ev.authorIsBot: return (dedupe, R5)
// 2. link = await resolveLink(store, tenantId, ev.keys)
// 3. if !link: treat as a fresh bootstrap only if the comment carries an explicit
//    mention/prefix (same "unmanaged issue needs a mention" rule as existing
//    GitHub logic) -- else ignore.
// 4. { reply } = await appendTurn(link.opencodeSessionId, ev.commentBody)
// 5. post `reply` back to ev.source always; to other linked surfaces only if
//    tenant.harness.mirrorReplies === 'all'.
// 6. update session_link.updated_at, status='active'.
```

`github-poll.ts` and `jira-poll.ts` become thin event producers; all cross-linking
and session lifecycle logic is centralized in `harness.ts` — this is the piece that
directly satisfies the PRD's core ask ("keep track of jira-github issue-github pr
references to address comments ... into one opencode session").

## 7. Config schema additions (`config.ts`, `types.ts`, `config/tenants.yaml`)

```yaml
tenants:
  - id: local
    repos: [...]
    github: {...}          # existing
    jira:
      baseUrl: "https://yourorg.atlassian.net"
      projectKey: "PROJ"
      agentAccountId: "712020:xxxx-xxxx"   # the bot/agent Jira account
      email: "${JIRA_EMAIL}"
      apiToken: "${JIRA_API_TOKEN}"
      pollIntervalSec: 30
    opencode:
      baseUrl: "http://127.0.0.1:4096"
      shareBaseUrl: null       # optional
    harness:
      mirrorReplies: "origin-only"   # or "all"
      reactivationWindowMinutes: 60
```

Validate with the existing `zod` schemas in `config.ts`; Jira block optional (a
tenant with no `jira` key simply never gets a Jira poller — same opt-in pattern as
current optional Slack/mirror blocks).

## 8. Sequencing / rollout plan (issue breakdown for the kanban board)

1. **Storage migration**: `session_link` + `jira_poll_state` tables, both DB
   drivers, migration tests.
2. **`session-links.ts`**: resolution + attach + conflict handling, unit tests
   covering PRD AC5 and the 3.1 conflict path.
3. **`opencode-session.ts`** adapter against a real local `opencode serve`
   instance (integration test spins one up, or documents why it's mocked with a
   fake HTTP server — never mock the thing under test per project mock-test rules
   in `docs/testing.md`; this adapter's OWN tests may run against a real local
   opencode process since that's fully within test control, not a third-party
   dependency like OAuth).
4. **`jira-poll.ts`**: polling loop + Jira API client, against a fixture/mock Jira
   server for unit tests (Jira Cloud itself is out of local test control, same
   reasoning as why `google-workspace.test.js` needs real creds but general unit
   tests use fixtures).
5. **`harness.ts`**: orchestrator wiring 2+3+4 together; this is where
   `handleAssignmentEvent`/`handleCommentEvent` get their real tests (AC1-AC4).
6. **`github-poll.ts` PR-assignee trigger** (R2): smallest diff, add last so it can
   route directly into the already-tested `harness.ts`.
7. **E2E test extending `docs/test-protocol.md`**: Jira ticket assign → session
   created → GitHub PR comment on linked PR → same session → Jira comment → same
   session. This is the test that actually proves the PRD's core ask.

Each numbered item is one kanban card with an explicit dependency edge on the
previous (session-links before harness before github-poll wiring).

## 9. Explicit risks / things NOT to guess

- If the target opencode version does not expose a stable REST session API,
  `opencode-session.ts`'s contract must be re-verified against the installed
  opencode version FIRST — do not implement against assumed endpoints. This is a
  spike task, not an assumption to bake into the schema above.
- Jira Cloud REST v3 `/search/jql` endpoint (used above) replaced the deprecated
  `/search` GET-with-jql-param endpoint; verify against the org's actual Jira
  Cloud vs Server/Data Center distinction before writing the client (Server/DC
  uses different auth and a different search endpoint shape).
