# Objection: PR-assignee trigger (PRD R2)

Stopped before editing `src/github-poll.ts`. The brief conflicts with `docs/LLD-agent-harness.md` §3 / §6 and with the helpers it says to reuse. Implementing would mean picking a convention those sources do not define.

No files under `src/` were changed. `harness.ts`, `session-links.ts`, `jira-poll.ts`, and `opencode-session.ts` were not modified.

## 1. Linked-issue precedence does not match LLD §3 or `candidateKeys`

Brief order (exclusive):

1. `Closes` / `Fixes` / `Resolves` #123, or a bare `#123`
2. branch name (issue number or Jira key)
3. `jira:<KEY>` or `tenant:<id>` in the body
4. else a standalone `github_pr` key

LLD §3 ("Building the candidate `LinkKey[]`") is a different fixed order, and it is a union, not a first-match:

1. Explicit hint (`gh:`, `jira:`, GitHub/Jira URLs). `commands.ts` already parses `tenant:<id>` for tenant routing, not as a link key.
2. Convention: `Closes` / `Fixes` / `Resolves` #N, and branch names matching `[A-Z]+-\d+` as Jira keys.
3. Existing row via `resolveLink`.

`src/harness.ts` `candidateKeys()` already implements that union. It scans `ev.body` and `ev.branch` with `extractLinkHints`, `extractClosingRefs`, and `jiraKeysFromBranch`, and it always keeps `ev.keys`. `handleAssignmentEvent` claims `ev.keys[0]` first. A poller-side exclusive precedence would either duplicate that scan or fight it.

PRD R2 lists the same signals (`#123`, `Closes #123`, branch, `jira:<KEY>` / `tenant:<id>`) but does not define this exclusive order. PRD R3's order is hint, then existing row, then convention. Three orders, one implementation in harness. Not guessing which one this card should enforce.

## 2. Bare `#123` is not a closing ref in the helper the brief says to reuse

`extractClosingRefs` only matches `closes|fixes|resolves` plus `#N` or `owner/repo#N`. It does not match a bare `#123`.

LLD §3 convention text is the same: `Closes/Fixes/Resolves #N` only.

`parseLocalIssueRef` matches the first bare `#N`, but it is private and used by command parsing (`parseIssueReference`), not by closing-ref extraction. Treating it as a closing keyword would be a second parser. The brief forbids that.

## 3. `jiraKeysFromBranch` does not read a GitHub issue number

Actual behavior (`src/commands.ts`):

```ts
export function jiraKeysFromBranch(branch: string): string[]
```

It returns uppercased matches of `[A-Za-z][A-Za-z0-9]+-\d+` only. It does not return a GitHub issue number embedded in a branch (`issue-123`, `pr-45`, `fix/123-foo`). No other exported helper defines that convention. The brief says not to invent one. The "issue number in the branch name" example therefore cannot be implemented from the existing helper.

## 4. `tenant:<id>` is not a `LinkKey`

`AssignmentEvent.keys` is `LinkKey[]` (`jira` | `gh_issue` | `gh_pr`). `extractLinkHints` emits `jira:<KEY>` and does not emit `tenant:`. `tenant:<id>` is a tenant-routing hint inside `extractCommand` / `extractTenantHint`. It does not identify an issue or PR. Passing it as a link key would require a new kind or a made-up mapping. Tenant for this event is already the poll tenant (`tenantId`).

## 5. Test file has no fixture convention to extend

`scripts/test-github-polling.ts` is a live `gh` script: it creates a real issue, posts a comment, and waits for a Codex reply. It has no fixtures, mocks, or assertions.

`npm run test:github-polling` runs that script. Adding an in-process PR-assignee fixture to it, while leaving the live path as the default, cannot pass here without GitHub credentials. Replacing the live path would change a protocol script the brief said to follow. A new test file is what `test-jira-poll.ts` does, and the brief said not to add one if this script already covers triggers. It does not.

## What is not in dispute

These parts match the code and could be done once the conflicts above are decided:

- New trigger beside issue-assignment and mention. Do not remove `if (issue.pull_request) continue` from the existing `createRun` path; PRs must not also bootstrap a Codex run.
- Identity: `resolveGithubAppIdentity` plus `resolveAssignmentAssignees` / `buildAssigneeMentionPrefixes`. `pollAssignedIssues` already lists issues assigned to `appIdentity.botLogin` and `assignmentAssignees`. Do not hardcode a login.
- Event shape that already exists on `AssignmentEvent`: `{ source: "github_pr", tenantId, keys, repoPath, title, body, branch }`. `keys` must include `{ kind: "gh_pr", repo, number }` for the standalone path. `body` and `branch` are what `candidateKeys` scans. `issues.listForRepo` does not include `head.ref`; branch has to come from the pull request payload (`pulls.get`), not from the issue object.
- `handleAssignmentEvent(ctx, ev)` needs a `HarnessCtx`. `startGitHubPolling` does not take one today. Injecting it the way `startJiraPolling` injects a harness does not require editing `harness.ts`. Wiring that from `src/index.ts` is outside the "do not touch harness/session-links/jira-poll/opencode-session" rule, but it is required for production. Not done here, because the key-resolution conflicts block the poller change.

## Decision needed

Pick one resolution rule and say whether bare `#123` and branch issue-numbers are in scope. Until then this card should not guess.
