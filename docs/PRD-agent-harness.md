# PRD: CodeBridge Agent Harness (Jira + GitHub Event Loop)

## Status
Draft. Owner: engineering (VP Eng). Feeds `docs/LLD-agent-harness.md`.

## Problem

CodeBridge today only reacts to GitHub (issues/PR/discussion comments, assignment)
via webhook or polling. Coding work is frequently tracked in Jira, not GitHub, and a
single logical unit of work spans three surfaces that today have no durable link:

- a Jira ticket (assigned to a human or a bot handle),
- a GitHub issue it maps to (if any),
- a GitHub PR that implements it.

There is no agent harness that:
1. Watches Jira for ticket assignment/comments the same way it watches GitHub.
2. Starts a coding-agent session in reaction to an assignment event (Jira ticket
   assigned, or GitHub PR assigned/mentioned).
3. Makes that session **shareable** — a durable, resumable, human-inspectable
   session (an opencode session) rather than a one-shot CLI invocation whose
   transcript disappears when the process exits.
4. Keeps a stable **cross-reference** between Jira ticket ↔ GitHub issue ↔ GitHub PR
   so that a comment posted on ANY of the three routes into the SAME opencode
   session instead of starting a disconnected new one.

## Goals

- G1. Poll Jira (REST API, polling — no webhook dependency, matching the existing
  GitHub polling philosophy) for ticket assignment and new comments.
- G2. On Jira ticket assignment to the bot/agent identity: start (or resume) a
  shareable opencode session bound to that ticket.
- G3. On GitHub PR assignment to the bot/agent identity: start (or resume) a
  shareable opencode session bound to that PR.
- G4. Maintain a persistent link table: `jira_issue_key <-> github_issue <-> github_pr
  <-> opencode_session_id`. Any one of the four being known must resolve the others
  when present.
- G5. Route a follow-up comment on ANY linked surface (Jira comment, GitHub issue
  comment, GitHub PR review comment) into the SAME session via the link table,
  not a new one — this is the direct ask ("address comments from github pr/jira
  comment into one opencode session").
- G6. Session must be shareable: durable session id/URL a human can open to watch
  or intervene, independent of the polling process's lifetime.
- G7. Mirror status/progress back to whichever surface(s) are linked (label/comment
  parity with the existing GitHub lifecycle labels; Jira transition/comment
  equivalent).

## Non-goals (this phase)

- Jira webhook ingestion (polling only, matching R... in `docs/requirements.md`
  non-goals for GitHub).
- Bi-directional Jira status transition automation beyond posting comments and a
  best-effort status label/transition on completion.
- Multi-tenant Jira (single Jira site per tenant is sufficient for v1; extend the
  existing `tenants.yaml` tenant model, do not invent a parallel config system).
- Replacing Codex SDK runner with opencode for the existing GitHub-only flows —
  this PRD only requires opencode sessions to be usable as the SHAREABLE session
  backing HOWEVER the harness is triggered (Jira or GitHub). If opencode is not
  already integrated, the LLD must specify the adapter; it must not become a full
  rewrite of the Codex runner.

## Primary user stories

- U1. As an engineer, I assign a Jira ticket to "CodeBridge Agent". A session
  starts against the mapped local repo. I can open a link and watch/steer it.
- U2. As an engineer, I assign a GitHub PR to the bot. A session starts scoped to
  that PR's branch/diff.
- U3. As a reviewer, I leave a PR review comment on a PR whose Jira ticket already
  has an active session. My comment is delivered into that SAME session as a new
  turn, and the agent's reply is posted back to the PR thread (and optionally
  mirrored to the Jira ticket).
- U4. As a PM, I comment on the Jira ticket asking for a scope change. That comment
  reaches the same running session that is also handling GitHub PR comments for
  the same piece of work.

## Functional requirements

### R1. Jira polling ingestion
- Poll interval configurable per tenant (`jira.pollIntervalSec`), same shape as
  `github.pollIntervalSec`.
- Auth: Jira API token (Basic auth: email + token, or OAuth 2.0 3LO) — token-based
  for v1, matching "no public endpoint needed" polling philosophy.
- Detected events, each carrying a stable "source key" for dedupe (same dedupe
  discipline as `github-poll.ts`):
  - `issue.assigned` — `fields.assignee.accountId` changed to the configured agent
    account id.
  - `comment.created` — new comment on a ticket already linked to a session
    (conversational follow-up, no prefix required — same UX rule as R2 in the
    GitHub requirements).
  - `comment.created` with explicit mention/bootstrap token on an unlinked ticket
    (bootstrap parity with GitHub mention bootstrap).
- High-water mark persisted per tenant+Jira site (poll cursor), same pattern as
  existing GitHub poll state in `storage.ts`.

### R2. GitHub PR assignment trigger
- Extend the existing GitHub poller (`github-poll.ts`) to also treat
  `pull_request.assignees` containing the configured bot/agent identity as a
  bootstrap trigger, in addition to today's issue-assignment and mention triggers.
- A PR-assignment bootstrap must resolve (or create) the link row before starting
  a session, using the PR's linked issue if the PR body/branch references one
  (`#123`, `Closes #123`, branch name convention, or explicit `jira:<KEY>` /
  `tenant:<id>` hint), falling back to a standalone PR-scoped session.

### R3. Cross-reference link table (the core of this PRD)
- New durable entity `session_link`:
  - `id`
  - `tenant_id`
  - `jira_issue_key` (nullable)
  - `github_repo` (nullable)
  - `github_issue_number` (nullable)
  - `github_pr_number` (nullable)
  - `opencode_session_id` (not null once a session exists)
  - `status` (`active` | `idle` | `completed`)
  - `created_at`, `updated_at`
- Lookup must work from ANY non-null identifying field (Jira key, GH issue number,
  GH PR number) — a comment event on any surface resolves to at most one active
  `session_link` row.
- Linking rules (in order of precedence, mirroring existing GitHub tenant
  resolution precedence in `docs/design.md`):
  1. Explicit hint in comment/ticket text (`gh:<owner/repo>#123`, `jira:<KEY>`,
     PR URL).
  2. Existing link row already covering one of the other two identifiers.
  3. Convention: PR body "Closes/Fixes #N", branch name containing the Jira key
     (e.g. `feature/PROJ-123-...`).
  4. No match → create a new link row scoped to whichever single surface
     triggered it; later events may attach additional identifiers to the same row
     once a convention match is found (this is an update, not a new row).
- Merge-safety: two link rows must never both claim to own the same
  `opencode_session_id`, and attaching a new identifier to a row must fail loudly
  (not silently overwrite) if that identifier is already linked to a DIFFERENT
  session.

### R4. Shareable opencode session lifecycle
- "Shareable" means: a session identifier (and, if the opencode deployment
  supports it, a URL) that:
  - persists across the poller process restarting,
  - can be opened by a human to view transcript/state,
  - accepts a new turn (comment) appended by the harness without the harness
    needing to replay full history.
- One `session_link` row owns exactly one live opencode session at a time. A
  completed/idle session may be resumed (same session id) rather than a new one
  created, when a new comment arrives for a `completed` link within a configurable
  reactivation window; otherwise a fresh session is started and the link updated.
- The harness posts the session's share link back to whichever surface(s) are
  linked, once, on first creation (comment on GitHub issue/PR, comment on Jira
  ticket) — not on every subsequent turn.

### R5. Comment routing into the session
- For every detected Jira comment or GitHub (issue/PR/discussion) comment on a
  linked surface: resolve the `session_link`, append the comment as a new turn to
  the existing opencode session (do not start a competing session), then relay
  the agent's reply to:
  - the originating surface always,
  - other linked surfaces per tenant config (`mirrorReplies: all | origin-only`,
    default `origin-only` to avoid comment storms across three surfaces for every
    turn).
- Dedupe: a comment already mirrored by the bot identity itself must never be
  re-ingested as a new user turn (existing bot-authored comment filtering must be
  reused/extended for Jira).

### R6. Status/label parity
- GitHub side reuses existing lifecycle labels (`agent:managed`, `agent:in-progress`,
  `agent:idle`, `agent:completed`).
- Jira side: post equivalent status as a comment at minimum; if the tenant config
  supplies a Jira transition/status mapping, additionally transition the ticket.
  Comment-only must always work with zero Jira workflow configuration (fail soft
  on transition permission errors, never block progress on a transition failure).

## Acceptance criteria

- AC1. Assigning a Jira ticket to the configured agent account creates exactly one
  `session_link` row and exactly one opencode session; the session id/link is
  posted back as a ticket comment.
- AC2. Assigning a GitHub PR to the bot creates exactly one `session_link` row
  (reusing an existing row if the PR references an already-linked Jira ticket or
  issue) and exactly one opencode session.
- AC3. A GitHub PR review comment on a PR whose Jira ticket has an active session
  is delivered into that same session (verified by session transcript containing
  the comment as a new turn, not a new session id).
- AC4. A Jira comment on a ticket whose GitHub PR has an active session is
  delivered into that same session (symmetric to AC3).
- AC5. No two link rows ever reference the same `opencode_session_id`.
- AC6. Restarting the CodeBridge process does not lose the link table or the
  ability to resume an existing session (both persisted in the existing
  SQLite/Postgres `storage.ts` store, same durability guarantee as current runs).
- AC7. Jira polling failure (auth error, rate limit, network) never crashes the
  GitHub polling loop or vice versa — independent failure domains, same as the
  existing per-tenant isolation in `github-poll.ts`.

## Open questions (must be resolved in LLD or by explicit decision before build)

- Which opencode deployment mode is targeted for v1 — local opencode server the
  harness talks to over its API, vs. spawning `opencode` CLI per session? This
  determines what "shareable" concretely means (a served URL vs. a local session
  directory + `opencode` resume command). Default assumption for LLD: local
  `opencode serve` HTTP API with session ids, since that is the only mode that
  yields a URL a human can open without SSH access.
- Jira auth: which auth mode (API token vs OAuth) is available for the target
  Jira site — LLD should default to API token (email + token) for v1 as the
  lowest-friction, config-file-compatible option.
