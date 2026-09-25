# PRD: Agent Harness (Jira + GitHub)

**Status:** Draft. **Owner:** Engineering. **Design:** `docs/LLD-agent-harness.md`.

## Problem

CodeBridge only listens to GitHub today. Much of our work is tracked in Jira.
One piece of work often lives in three places with no link between them:

- a Jira ticket,
- a GitHub issue (sometimes),
- a GitHub PR.

Today CodeBridge cannot:

1. Watch Jira for assignments and comments.
2. Start an agent session when a Jira ticket or GitHub PR is assigned to the bot.
3. Give humans a session they can open, watch, and steer. The current Codex
   runner starts a new thread for every run (`runner.ts` calls `startThread`
   each time), so there is no lasting session to share.
4. Send a comment from any of the three places into the same session.

## Goals

- **G1.** Poll Jira for ticket assignments and new comments. Polling only, like GitHub.
- **G2.** When a Jira ticket is assigned to the agent account, start or resume
  an opencode session for it.
- **G3.** When a GitHub PR is assigned to the bot, start or resume an opencode
  session for it.
- **G4.** Keep a link table: Jira key ↔ GitHub issue ↔ GitHub PR ↔ opencode
  session. Any known identifier finds the rest.
- **G5.** A comment on any linked surface (Jira comment, GitHub issue comment,
  GitHub PR comment) goes into the same session. It never starts a new one.
- **G6.** The session is shareable: a session id or URL a human can open. It
  outlives the poller process.
- **G7.** Report status back to linked surfaces: GitHub labels as today, and a
  Jira comment (plus an optional transition).

## Non-goals (this phase)

- Jira webhooks.
- Jira workflow automation beyond comments and one optional transition on completion.
- More than one Jira site per tenant. Extend the tenant config in `config.ts`;
  do not add a second config system.
- Replacing the Codex runner for existing GitHub-only flows. opencode backs the
  new harness only. If this needs more than an adapter, stop and revisit.

## User stories

- **U1.** I assign a Jira ticket to "CodeBridge Agent". A session starts in the
  mapped repo. I get a link to watch and steer it.
- **U2.** I assign a GitHub PR to the bot. A session starts on that PR's branch.
- **U3.** I leave a review comment on a PR whose Jira ticket already has a
  session. My comment lands in that session. The reply is posted on the PR, and
  optionally on the Jira ticket.
- **U4.** A PM comments on the Jira ticket to change scope. The comment reaches
  the same session that handles the PR comments.

## Requirements

### R1. Jira polling

- Per-tenant interval: `jira.pollIntervalSec`. (GitHub polling uses the global
  `GITHUB_POLL_INTERVAL` env var, not a per-tenant setting.)
- Auth: Jira API token (email + token, Basic auth) for v1. OAuth later.
- Events, each with a stable source key for dedupe (same approach as `github-poll.ts`):
  - `issue.assigned`: assignee becomes the configured agent account id.
  - `comment.created` on a linked ticket: treated as a follow-up. No prefix needed.
  - `comment.created` on an unlinked ticket: starts a session only if it mentions
    the agent.
- Store a poll cursor per tenant, like `github_poll_state`.

### R2. GitHub PR assignment

- Extend `github-poll.ts` so a PR assigned to the bot starts a session.
  (Today `pollAssignedIssues` skips PRs.)
- Before starting, find or create the link row. Look for a linked issue or Jira
  key in: `#123`, `Closes #123`, the branch name, or an explicit `jira:<KEY>` /
  `tenant:<id>` hint. If nothing matches, create a PR-only link.

### R3. Link table (core of this PRD)

Table `session_link`:

| Column | Notes |
|---|---|
| `id` | |
| `tenant_id` | |
| `jira_issue_key` | nullable |
| `github_repo` | nullable, `owner/repo` |
| `github_issue_number` | nullable |
| `github_pr_number` | nullable |
| `opencode_session_id` | set once a session exists |
| `status` | `active` \| `idle` \| `completed` |
| `created_at`, `updated_at` | |

- Lookup works from any identifier. A comment resolves to at most one active row.
- Linking order (same idea as tenant resolution in `docs/design.md`):
  1. Explicit hint in the text: `gh:<owner/repo>#123`, `jira:<KEY>`, or a PR URL.
  2. An existing row that already holds one of the identifiers.
  3. Convention: `Closes/Fixes #N` in the PR body, or a Jira key in the branch
     name (`feature/PROJ-123-...`).
  4. No match: create a row for the one surface that fired. Later matches add
     identifiers to this row. They do not create a new row.
- Safety:
  - Two rows never share an `opencode_session_id`.
  - Adding an identifier already linked to a different session fails with a
    visible error. It never overwrites.

### R4. Session lifecycle

- "Shareable" means the session:
  - survives a poller restart,
  - can be opened by a human to see the transcript and state,
  - accepts a new turn without the harness replaying history.
- One link row owns one live session.
- A comment on a `completed` link inside the reactivation window resumes the
  same session. Outside the window, start a new session and update the row.
- Post the share link once, when the session is created, to each linked surface.

### R5. Comment routing

- For each new comment on a linked surface:
  1. Resolve the link row.
  2. Send the comment to the existing session as a new turn.
  3. Post the reply to the surface the comment came from.
  4. Post to the other linked surfaces only if `mirrorReplies: all`.
     Default is `origin-only`, to avoid triple-posting every turn.
- Never ingest the bot's own comments. Extend the current bot-author filter to Jira.

### R6. Status

- GitHub: reuse `agent:managed`, `agent:in-progress`, `agent:idle`, `agent:completed`.
- Jira: always post status as a comment. If the tenant maps statuses to Jira
  transitions, also transition. A failed transition logs and moves on.

## Acceptance criteria

- **AC1.** Assigning a Jira ticket to the agent creates one link row and one
  session. The session link is posted on the ticket.
- **AC2.** Assigning a GitHub PR to the bot creates one link row and one
  session, or reuses the row if the PR references a linked ticket or issue.
- **AC3.** A PR review comment on a PR whose Jira ticket has an active session
  shows up as a new turn in that session. No new session id.
- **AC4.** A Jira comment on a ticket whose PR has an active session shows up
  as a new turn in that session.
- **AC5.** No two link rows share an `opencode_session_id`.
- **AC6.** After a CodeBridge restart, links and sessions still resolve. Links
  are stored in the existing SQLite/Postgres store.
- **AC7.** A Jira failure (auth, rate limit, network) does not stop GitHub
  polling, and the reverse.

## Open questions (decide before build)

- **opencode mode.** Default: talk to a running `opencode serve` over HTTP.
  Note: `opencode serve` binds `127.0.0.1` by default, so "a URL a human can open
  without SSH" still needs either opencode's share feature or an exposed server.
  Which one?
- **Jira auth.** Default: API token (email + token). Confirm it is allowed on the
  target Jira site.
