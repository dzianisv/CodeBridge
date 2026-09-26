# GitHub Surface Test Protocol

This protocol validates the exact interaction surfaces required for CodeBridge:

1. issue assigned to `@githubapphandle`
2. `@githubapphandle` mention in GitHub issue comments
3. `@githubapphandle` mention in GitHub PR conversation comments
4. `@githubapphandle` mention in GitHub discussion comments

## Preconditions

- CodeBridge is running in polling mode:
  - `GITHUB_POLL_INTERVAL` set (for example `10`)
  - `GITHUB_POLL_BACKFILL=false`
- Target repos are in tenant `repoAllowlist` and `repos` config.
- App handle is resolvable (for example `@codexengineer`).
- For assignment bootstrap:
  - the app handle must be assignable in that repo (`/assignees/<login>` returns `204`).
- For discussions:
  - repository has discussions enabled;
  - GitHub App has Discussions permission (read/write).

## Runner

Use:

```bash
pnpm test:github-protocol \
  --issue-repo <owner/repo> \
  --pr-repo <owner/repo> \
  --discussion-repo <owner/repo> \
  --discussion-number <existing-discussion-number>
```

Output is JSON:

- `pass`: case succeeded end-to-end
- `blocked`: external platform prerequisite missing (assignability/permissions/settings)
- `fail`: bridge behavior failed for a valid preconditioned case

The script exits non-zero only when at least one case is `fail`.

## Notes On GitHub Platform Constraints

- Some repos do not allow assigning GitHub App bot identities as issue assignees.
  - In that case, assignment case is reported as `blocked`.
  - Mention-based bootstrap remains the functional path.
- Discussions require explicit app permissions beyond Issues/PR permissions.
  - Without Discussions permission, discussion case is `blocked` with
    `Resource not accessible by integration`.
- Discussion case now targets an existing discussion thread (no `createDiscussion` mutation required).
  - Use `--discussion-number` to force a stable target.
  - If omitted, the script uses the most recently updated discussion.

## Last Verified Run

Date: March 4, 2026 (America/Los_Angeles)

Command:

```bash
pnpm test:github-protocol \
  --issue-repo dzianisv/codebridge-test \
  --pr-repo VibeTechnologies/VibeWebAgent \
  --discussion-repo VibeTechnologies/vibeteam-eval-hello-world \
  --discussion-number 6 \
  --timeout 240 \
  --poll 5
```

Result matrix:

- `assignment-to-app-handle`: `blocked`
  - reason: `codexengineer[bot]` / `codexengineer` not assignable in `dzianisv/codebridge-test`
- `issue-mention`: `pass`
  - evidence: [issue #22](https://github.com/dzianisv/codebridge-test/issues/22)
- `pr-mention`: `pass`
  - evidence: [PR #638](https://github.com/VibeTechnologies/VibeWebAgent/pull/638)
- `discussion-mention`: `blocked`
  - reason: app installation lacks Discussions permission on `VibeTechnologies/vibeteam-eval-hello-world`

## Agent Harness E2E (Jira + linked PR + Jira comment)

LLD section 8 item 7. This is not `scripts/test-harness.ts`. That script calls
`handleAssignmentEvent` / `handleCommentEvent` directly. This scenario starts the
real `jira-poll.ts` and `github-poll.ts` loops.

What it validates:

- **AC1.** Assigning a Jira ticket to the agent creates one `session_link` row
  and one opencode session, and the session link is posted on the ticket.
- **AC3.** A comment on the PR linked to that ticket is a new turn in that same
  session. No second link row.
- **AC4.** A later Jira comment on the same ticket is a new turn in that same
  session.

### Preconditions

- Node 22, matching CI.
- Real `opencode serve` (`OPENCODE_BIN` or `~/.opencode/bin/opencode`). The
  runner starts its own process. Do not mock it.
- GitHub App credentials and an installation id for the target repo
  (`CONFIG_PATH`, or `~/.config/codebridge/config.yaml`, or `GITHUB_APP_ID` /
  `GITHUB_PRIVATE_KEY`). The poller reads with the app. Comments are posted
  with `gh`.
- `--repo owner/name` (or `CODEBRIDGE_TEST_REPO`). No repo is hardcoded.
- No live Jira account. The runner starts a local fake Jira HTTP server, same
  search/comment shape as `scripts/test-jira-poll.ts`.

The bot is not assignable in `dzianisv/codebridge-test` (see the assignment
case above). The runner therefore attaches the PR key with `attachIdentifier`
after the Jira assignment creates the session. That is the linked-PR
precondition. Comment routing still has to come from `startGitHubPolling`.

### Runner

```bash
npm run test:harness-e2e -- --repo <owner/repo> --timeout 45 --poll 2
```

Output is the same JSON vocabulary as the GitHub protocol:

- `pass`: case succeeded end-to-end
- `blocked`: external platform prerequisite missing
- `fail`: harness behavior failed for a valid preconditioned case

The script exits non-zero when at least one case is `fail`.

### Last Verified Run

Date: September 26, 2026

Command (Node v22.23.1):

```bash
PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" \
  npx tsx scripts/test-harness-e2e.ts \
  --repo dzianisv/codebridge-test \
  --timeout 45 \
  --poll 2
```

Exit code: 1

Result matrix:

- `jira-assignment-creates-session`: `fail`
  - one opencode session was created (`ses_f234055e5ffe3dsP4IZca6ro11`) via the
    real Jira poll loop, but no comment was posted on the ticket
- `github-pr-comment-same-session`: `fail`
  - evidence: [PR #715](https://github.com/dzianisv/codebridge-test/pull/715)
    comment `5844478655`
  - github-poll advanced `lastCommentId` to that comment and left the single
    link row in place, but the comment did not land in the session
  - run-service was not called for that comment either
- `jira-comment-same-session`: `pass`
  - the later Jira comment landed in `ses_f234055e5ffe3dsP4IZca6ro11`

This run does not prove the PRD. See `OBJECTION.md`.
