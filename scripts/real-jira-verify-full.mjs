// Extended real-Jira verification (does not replace real-jira-verify.mjs or
// scripts/test-harness-e2e.ts). Exercises three additional production code
// paths against the live sandbox that the fake-server E2E cannot prove:
//   1. createJiraPollLoop assignment detection (onAssignmentEvent fires when
//      the poller sees KAN-4 assigned to the agent account).
//   2. postJiraComment posting successfully to a real ticket (real response
//      shape, real auth, real network).
//   3. The posted comment is readable back via the same REST path jira-poll
//      uses to read comments.
import { createSqliteStore } from "../dist/storage.js"
import { createJiraPollLoop, postJiraComment } from "../dist/jira-poll.js"
import { buildJiraBasicAuthHeader } from "../dist/jira-auth.js"

const BASE_URL = process.env.JIRA_BASE_URL
const EMAIL = process.env.JIRA_EMAIL
const TOKEN = process.env.JIRA_API_TOKEN
const ISSUE_KEY = process.env.JIRA_ISSUE_KEY || "KAN-4"
const PROJECT_KEY = process.env.JIRA_PROJECT_KEY || "KAN"
const AGENT_ACCOUNT_ID = process.env.JIRA_AGENT_ACCOUNT_ID

if (!BASE_URL || !EMAIL || !TOKEN || !AGENT_ACCOUNT_ID) {
  console.error("Missing JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN / JIRA_AGENT_ACCOUNT_ID env vars")
  process.exit(1)
}

const store = createSqliteStore(":memory:")
const FAKE_REPO = "vibeteaichnologies/real-jira-verify-placeholder"

const config = {
  tenants: [{
    id: "e2e-real-jira-full",
    name: "e2e-real-jira-full",
    repos: [{ fullName: FAKE_REPO, path: process.cwd() }],
    jira: {
      baseUrl: BASE_URL,
      projectKey: PROJECT_KEY,
      repo: FAKE_REPO,
      agentAccountId: AGENT_ACCOUNT_ID,
      pollIntervalSec: 10
    },
    harness: { mirrorReplies: "origin-only", reactivationWindowMinutes: 60 }
  }]
}

let assignmentEventFired = false
let assignmentEventPayload = null

const harness = {
  async onAssignmentEvent(ev) {
    assignmentEventFired = true
    assignmentEventPayload = ev
  },
  async onCommentEvent() {}
}

const loop = createJiraPollLoop({
  store,
  config,
  harness,
  env: { jiraEmail: EMAIL, jiraApiToken: TOKEN }
})

if (!loop) {
  console.error("createJiraPollLoop returned null")
  process.exit(1)
}

console.log(`--- 1. assignment detection: polling ${ISSUE_KEY} (expect assignee=${AGENT_ACCOUNT_ID}) ---`)
await loop.tick()
console.log("onAssignmentEvent fired:", assignmentEventFired)
if (assignmentEventFired) {
  console.log("event issueKey:", assignmentEventPayload.issueKey, "assigneeAccountId:", assignmentEventPayload.assigneeAccountId)
}

let assignPass = assignmentEventFired && assignmentEventPayload?.issueKey === ISSUE_KEY

console.log(`\n--- 2. postJiraComment: posting to real ticket ${ISSUE_KEY} ---`)
const marker = `real-jira-verify-full-${Date.now()}`
let postPass = false
try {
  await postJiraComment({
    baseUrl: BASE_URL,
    authHeader: buildJiraBasicAuthHeader(EMAIL, TOKEN),
    issueKey: ISSUE_KEY,
    body: `Automated verification comment (harmless, safe to delete): ${marker}`
  })
  postPass = true
  console.log("postJiraComment did not throw")
} catch (error) {
  console.log("postJiraComment threw:", error instanceof Error ? error.message : error)
}

console.log(`\n--- 3. read-back: verifying comment ${marker} is visible via GET .../comment ---`)
let readBackPass = false
if (postPass) {
  const res = await fetch(`${BASE_URL}/rest/api/3/issue/${ISSUE_KEY}/comment?orderBy=-created&maxResults=5`, {
    headers: { authorization: buildJiraBasicAuthHeader(EMAIL, TOKEN), accept: "application/json" }
  })
  const body = await res.json()
  readBackPass = res.ok && JSON.stringify(body).includes(marker)
  console.log("read-back status:", res.status, "found marker:", readBackPass)
}

console.log("\n=== SUMMARY ===")
console.log("assignment-detection:", assignPass ? "PASS" : "FAIL")
console.log("post-jira-comment:", postPass ? "PASS" : "FAIL")
console.log("comment-read-back:", readBackPass ? "PASS" : "FAIL")

if (assignPass && postPass && readBackPass) {
  console.log("=== RESULT: PASS ===")
  process.exit(0)
} else {
  console.log("=== RESULT: FAIL ===")
  process.exit(1)
}
