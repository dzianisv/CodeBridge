// Standalone real-Jira integration check. Does NOT modify or replace
// scripts/test-harness-e2e.ts (which intentionally uses a local fake Jira).
// This exercises the exact same production code (createJiraPollLoop,
// attachIdentifier, resolveLink) against a real Jira Cloud sandbox instance.
import { createSqliteStore } from "../dist/storage.js"
import { attachIdentifier, resolveLink } from "../dist/session-links.js"
import { createJiraPollLoop } from "../dist/jira-poll.js"

const BASE_URL = process.env.JIRA_BASE_URL
const EMAIL = process.env.JIRA_EMAIL
const TOKEN = process.env.JIRA_API_TOKEN
const ISSUE_KEY = process.env.JIRA_ISSUE_KEY || "KAN-4"

if (!BASE_URL || !EMAIL || !TOKEN) {
  console.error("Missing JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN env vars")
  process.exit(1)
}

const store = createSqliteStore(":memory:")
await store.ensureSchema()

const fakeSessionId = `real-jira-verify-${Date.now()}`
await attachIdentifier(store, fakeSessionId, "e2e-real-jira", { kind: "jira", issueKey: ISSUE_KEY })
await store.promoteSessionLinkClaim({ linkId: fakeSessionId, tenantId: "e2e-real-jira", opencodeSessionId: fakeSessionId })

const PROJECT_KEY = process.env.JIRA_PROJECT_KEY || "KAN"
const FAKE_REPO = "vibeteaichnologies/real-jira-verify-placeholder"

const config = {
  tenants: [{
    id: "e2e-real-jira",
    name: "e2e-real-jira",
    repos: [{ fullName: FAKE_REPO, path: process.cwd() }],
    jira: {
      baseUrl: BASE_URL,
      projectKey: PROJECT_KEY,
      repo: FAKE_REPO,
      pollIntervalSec: 10,
    },
    harness: { mirrorReplies: "origin-only", reactivationWindowMinutes: 60 },
  }],
}

const loop = createJiraPollLoop({
  store,
  config,
  env: { jiraEmail: EMAIL, jiraApiToken: TOKEN },
})

if (!loop) {
  console.error("createJiraPollLoop returned null (env/config not accepted)")
  process.exit(1)
}

console.log("Running real jira-poll tick against", BASE_URL, "issue", ISSUE_KEY)
await loop.tick()

const linked = await resolveLink(store, "e2e-real-jira", [{ kind: "jira", issueKey: ISSUE_KEY }])
console.log("resolveLink result:", linked)

if (linked?.opencodeSessionId === fakeSessionId) {
  console.log("=== RESULT: PASS === real jira-poll tick ran against live Jira REST API without throwing, link resolved correctly")
  process.exit(0)
} else {
  console.log("=== RESULT: FAIL === link did not resolve as expected")
  process.exit(1)
}
