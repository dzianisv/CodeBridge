# Objection: harness E2E does not prove AC1 or AC3

The E2E runner was implemented and executed against a real `opencode serve`,
the real `jira-poll.ts` / `github-poll.ts` loops, a local fake Jira server, and
a real GitHub PR. It did not pass. `src/harness.ts`, `src/jira-poll.ts`, and
`src/github-poll.ts` were not patched.

## Command

Node v22.23.1.

```bash
PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" \
  npx tsx scripts/test-harness-e2e.ts \
  --repo dzianisv/codebridge-test \
  --timeout 45 \
  --poll 2
```

Exit code: 1.

## Log excerpt

```text
opencode version tested: 1.18.32 (/Users/engineer/.opencode/bin/opencode)
not ok - jira-assignment-creates-session ses_f234055e5ffe3dsP4IZca6ro11
{"level":30,"time":1790409951228,"pid":81629,"hostname":"gray-knight-m1.local","intervalSec":10,"msg":"GitHub polling enabled"}
not ok - github-pr-comment-same-session
ok - jira-comment-same-session
{
  "issueKey": "E2E-1790409933301",
  "pr": {
    "number": 715,
    "url": "https://github.com/dzianisv/codebridge-test/pull/715",
    "branch": "e2e/E2E-1790409933301-harness"
  },
  "results": [
    {
      "name": "jira-assignment-creates-session",
      "status": "fail",
      "details": "one session ses_f234055e5ffe3dsP4IZca6ro11 created via jira-poll, but no comment was posted on the ticket (AC1 share/resume link)"
    },
    {
      "name": "github-pr-comment-same-session",
      "status": "fail",
      "details": "PR comment 5844478655 was observed by github-poll (lastCommentId advanced) but did not land in session ses_f234055e5ffe3dsP4IZca6ro11. messagesContainMarker=false sameLink=true linkCount=1 runServiceHits=false url=https://github.com/dzianisv/codebridge-test/pull/715#issuecomment-5844478655"
    },
    {
      "name": "jira-comment-same-session",
      "status": "pass",
      "details": "Jira comment landed in session ses_f234055e5ffe3dsP4IZca6ro11"
    }
  ]
}
```

PR #715 was closed by the runner after the run.

## What held

- AC1, first half: the real Jira poll loop created exactly one `session_link`
  row and one opencode session for the assigned ticket.
- AC4: a later Jira comment on that ticket, delivered by the same Jira poll
  loop, landed in that session. The link count stayed 1.

## What did not hold

- AC1, second sentence: "The session link is posted on the ticket." The fake
  Jira server recorded no comment POST. `createHarnessBackedJiraPoller` ignores
  the reply from `handleAssignmentEvent`, and `harness.ts` documents that it
  does not write to Jira.
- AC3: a conversation comment on the linked PR was visible to `github-poll`
  (`lastCommentId` advanced to `5844478655`) and the PR key already resolved to
  the Jira session, but the comment never became a turn in that session.
  `run-service` was not called for it either. `github-poll.ts` does not call
  `handleCommentEvent` and does not list review comments. The comment loop
  still requires a command prefix or `agent:managed`, then sends the event to
  `run-service`.

AC3 cannot pass through the merged poll loop. Fixing that means changing
`src/github-poll.ts` (and the missing ticket write-back means changing the
Jira poll / harness write path). This task was not supposed to paper over that.
