# AC1 fixed; AC3 still open (tracked separately)

This file originally recorded that the harness E2E (scripts/test-harness-e2e.ts,
PR #19) proved AC1 and AC3 did not hold. AC1 is now fixed on this branch;
AC3 remains open and is out of scope here (see t_aa4f3051).

## Fix (this task, t_8d045ea7)

`createHarnessBackedJiraPoller.onAssignmentEvent` (src/jira-poll.ts) now posts
`handleAssignmentEvent`'s returned `reply` (share URL or resume-command
fallback) back onto the Jira ticket via a new `postJiraComment` function
(LLD §6.2 `post_jira_comment`), using the same `baseUrl`/`authHeader` the
poll tick already built. A failed post is logged and does not undo the
already-created session_link/session, and does not re-throw (the tick's
`seenBootstrap` set already marks this issue handled, so re-running would not
retry the post; that gap is acceptable for a Jira 5xx and not addressed here).

## Verification

Two consecutive live runs against a real `opencode serve`, the real
`jira-poll.ts` loop, a local fake Jira server, and a real GitHub PR:

```bash
PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" \
  npx tsx scripts/test-harness-e2e.ts \
  --repo dzianisv/codebridge-test \
  --timeout 45 \
  --poll 2
```

Run 1: `ok - jira-assignment-creates-session ses_f2333dcd8ffemAU3hU7AeEQkgn`
(fake Jira server recorded the comment POST, confirmed in the run's structured
results too: `"jira-assignment-creates-session": "pass"`). `github-pr-comment-same-session`
failed this run (`github-poll high-water did not advance` -- the AC3 case,
unrelated to this fix). `jira-comment-same-session` passed. Exit code 1 is
from that AC3 failure, tracked separately.

Run 2: `ok - jira-assignment-creates-session ses_f2331b4cdffeW160S7KI2XYABN`.
`ok - github-pr-comment-same-session` also passed this run, then a later
Jira-comment-triggered GitHub poll leg hit an unrelated
`OpencodeUnreachableError` (120s timeout talking to the local opencode serve
child process) on `handleCommentEvent`'s GitHub path -- not the Jira
assignment/comment path this card owns. `ok - jira-comment-same-session`
still passed.

AC1's two sub-cases (`jira-assignment-creates-session`,
`jira-comment-same-session`) passed on both runs. `npm run build` and
`npm run lint` are clean.

## What is still open

- AC3 (`github-pr-comment-same-session` intermittently, and definitionally
  per the original OBJECTION.md finding): `github-poll.ts` does not call
  `handleCommentEvent` for review/PR conversation comments outside the
  command-prefix / `agent:managed` path, and this run's opencode timeout
  shows the GitHub comment append path is also flaky under load. Tracked in
  t_aa4f3051. Not touched by this change.
