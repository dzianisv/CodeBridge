import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { execFile } from "node:child_process"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer as createNetServer } from "node:net"
import { tmpdir } from "node:os"
import os from "node:os"
import path from "node:path"
import { once } from "node:events"
import { promisify } from "node:util"
import Database from "better-sqlite3"
import { createSqliteStore, HARNESS_RUN_STATUS, type RunStore } from "../src/storage.js"
import { claimAndCreateLink } from "../src/session-links.js"
import { appendTurn, createSession, getSessionMessage } from "../src/opencode-session.js"
import { handleOptInIssueAssignment } from "../src/issue-assignment.js"
import { createJiraPollLoop } from "../src/jira-poll.js"
import { createHarnessBackedJiraPoller } from "../src/jira-poll.js"
import { textToAdf } from "../src/jira-types.js"
import { deliverIssueCommentWebhook, deliverIssuesAssignedWebhook } from "../src/github.js"
import { deliverPolledIssueComment, pollAssignedIssues, pollAssignedPullRequests } from "../src/github-poll.js"
import { createQueue, startWorker } from "../src/queue.js"
import { createRunService } from "../src/run-service.js"
import { createRunner } from "../src/runner.js"
import type { AppConfig, TenantConfig } from "../src/types.js"
import type { HarnessCtx } from "../src/harness.js"

// Real pollAssignedIssues / deliverIssuesAssignedWebhook / comment entrypoints.
// Local opencode serve. Fake GitHub client and fake Jira HTTP. No live writes.

const execFileAsync = promisify(execFile)
const OPENCODE_BIN = process.env.OPENCODE_BIN ?? path.join(os.homedir(), ".opencode", "bin", "opencode")
const version = (await execFileAsync(OPENCODE_BIN, ["--version"])).stdout.trim()
console.log(`opencode version tested: ${version} (${OPENCODE_BIN})`)

const port = await freePort()
const baseUrl = `http://127.0.0.1:${port}`
const repoPath = await mkdtemp(path.join(os.tmpdir(), "codebridge-issue-assignment-"))
const opencodeHome = await mkdtemp(path.join(os.tmpdir(), "codebridge-opencode-home-"))
const dataHome = path.join(opencodeHome, "share")
const configHome = path.join(opencodeHome, "config")
await mkdir(path.join(dataHome, "opencode"), { recursive: true })
await mkdir(path.join(configHome, "opencode"), { recursive: true })
const authSource = path.join(os.homedir(), ".local", "share", "opencode", "auth.json")
await cp(authSource, path.join(dataHome, "opencode", "auth.json"))
await writeFile(path.join(configHome, "opencode", "opencode.json"), JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  model: "github-copilot/gpt-5-mini",
  small_model: "github-copilot/gpt-5-mini",
  permission: { edit: "deny", bash: "deny", webfetch: "deny", skill: "deny" }
}))
const stderr: Buffer[] = []
const child = spawn(OPENCODE_BIN, ["serve", "--port", String(port), "--hostname", "127.0.0.1", "--print-logs"], {
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    XDG_DATA_HOME: dataHome,
    XDG_CONFIG_HOME: configHome,
    XDG_STATE_HOME: path.join(opencodeHome, "state")
  }
})
child.stderr?.on("data", chunk => {
  stderr.push(Buffer.from(chunk))
  if (stderr.length > 40) stderr.shift()
})
child.stdout?.on("data", chunk => {
  stderr.push(Buffer.from(chunk))
  if (stderr.length > 40) stderr.shift()
})
const turns: Array<{ sessionId: string; prompt: string }> = []
const sessions = {
  createSession: (params: { repoPath: string; title: string }, config?: { baseUrl?: string; shareBaseUrl?: string | null }) => {
    assert.equal(config?.shareBaseUrl ?? null, null, "public share gate must stay unset")
    return createSession(params, config)
  },
  appendTurn: async (sessionId: string, prompt: string, config?: { baseUrl?: string; shareBaseUrl?: string | null }) => {
    assert.equal(config?.shareBaseUrl ?? null, null, "public share gate must stay unset")
    turns.push({ sessionId, prompt })
    return appendTurn(sessionId, prompt, config)
  }
}

const cases: Array<[string, () => Promise<void>]> = [
  ["opt-in poll and webhook share one session, one harness run, one initial turn", optInOnce],
  ["repeat and concurrent delivery do not add a session, run, or turn", noExtraWork],
  ["crash after append reconciles the stored message and does not replay", crashAfterAppend],
  ["stale in_progress with no remote message is indeterminate and does not replay", staleAbsent],
  ["run row saved before the link is reused and still sends one turn", runBeforeLink],
  ["linked issue, PR, and Jira comments use the same session", linkedComments],
  ["poll and webhook delivery of the same comment do not append twice", duplicateComment],
  ["assigned PR that closes the issue reuses the same link", linkedPr],
  ["conflicting keys are visible and do not overwrite", conflict],
  ["default-off keeps the Codex assignment path", legacyCodex],
  ["managed label still skips the legacy path and does not start Codex", legacyManaged],
  ["runner refuses a harness run and does not mark it running", runnerRefuses]
]

let failed = 0
const dbDir = await mkdtemp(path.join(os.tmpdir(), "codebridge-issue-assignment-db-"))
const shared = {
  sessionId: "",
  runId: "",
  linkId: "",
  dbPath: ""
}
try {
  await waitForServer(baseUrl, child)
  for (const [name, fn] of cases) {
    try {
      await fn()
      console.log(`ok - ${name}`)
    } catch (error) {
      failed += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  }
} catch (error) {
  failed += 1
  console.error(Buffer.concat(stderr).toString("utf8").slice(-2000))
  console.error(error)
} finally {
  await stopChild(child)
  await rm(repoPath, { recursive: true, force: true }).catch(() => {})
  await rm(opencodeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
  await rm(dbDir, { recursive: true, force: true }).catch(() => {})
}

if (failed > 0) {
  console.error(`test:issue-assignment failed (${failed})`)
  process.exit(1)
}
console.log("test:issue-assignment passed")

async function optInOnce() {
  turns.length = 0
  const tenant = tenantConfig(`${dbDir}/opt.db`, true)
  const store = createSqliteStore(`sqlite://${tenant.dbPath}`)
  shared.dbPath = tenant.dbPath
  const harness = harnessFor(store, tenant.config)
  const issue = openIssue(7, "Fix the gate", "jira:PROJ-1\nReply with exactly the word pong and nothing else.", true)
  const client = fakeClient([issue])
  const webhook = deliverIssuesAssignedWebhook({
    config: tenant.config,
    routing: { store, harness },
    onCommand: async () => {
      throw new Error("webhook opted-in assignment called Codex onCommand")
    },
    installationId: 9,
    repoFullName: "acme/widget",
    owner: "acme",
    repoName: "widget",
    assigneeLogin: "codex-operator",
    botLogin: "codex-operator",
    issue
  })
  const poll = pollAssignedIssues({
    tenant: tenant.config.tenants[0],
    repo: tenant.config.tenants[0].repos[0],
    owner: "acme",
    repoName: "widget",
    client,
    store,
    runService: { createRun: async () => { throw new Error("poll opted-in assignment called createRun") } },
    harness,
    appIdentityPromise: Promise.resolve({ botLogin: "codex-operator" })
  })
  const [webhookResult] = await Promise.all([webhook, poll])
  assert.notEqual(webhookResult, "ignored")
  if (webhookResult !== "ignored" && webhookResult.path === "conflict") {
    throw new Error(`assignment conflict: ${webhookResult.reason}`)
  }
  assert.equal(turns.length, 1)
  assert.match(turns[0].prompt, /Work on GitHub issue #7/)
  const proof = proofRows(tenant.dbPath)
  assert.equal(proof.length, 1, "expected exactly one harness run joined to one session link")
  assert.equal(proof[0].status, HARNESS_RUN_STATUS)
  assert.notEqual(proof[0].status, "queued")
  assert.notEqual(proof[0].status, "succeeded")
  assert.equal(proof[0].turn_state, "completed")
  assert.equal(proof[0].opencode_session_id, turns[0].sessionId)
  assert.equal(proof[0].source_key, "github-assigned:9:acme/widget:7")
  assert.equal(countKeys(tenant.dbPath, "gh_issue", "7"), 1)
  assert.equal(countKeys(tenant.dbPath, "jira", "proj-1"), 1)
  const raw = await fetch(`${baseUrl}/session/${encodeURIComponent(proof[0].opencode_session_id)}`)
  assert.equal(raw.status, 200)
  const body = await raw.json() as { id: string; share?: unknown }
  assert.equal(body.id, proof[0].opencode_session_id)
  assert.equal(body.share, undefined)
  shared.sessionId = proof[0].opencode_session_id
  shared.runId = proof[0].run_id
  shared.linkId = proof[0].link_id
  await store.close?.()
}

async function noExtraWork() {
  const tenant = reopen(shared.dbPath)
  const store = createSqliteStore(`sqlite://${shared.dbPath}`)
  const harness = harnessFor(store, tenant)
  const before = turns.length
  const issue = openIssue(7, "Fix the gate", "jira:PROJ-1\nReply with exactly the word pong and nothing else.", true)
  await Promise.all([
    deliverIssuesAssignedWebhook({
      config: tenant,
      routing: { store, harness },
      onCommand: async () => { throw new Error("repeat webhook called Codex") },
      installationId: 9,
      repoFullName: "acme/widget",
      owner: "acme",
      repoName: "widget",
      assigneeLogin: "codex-operator",
      botLogin: "codex-operator",
      issue
    }),
    pollAssignedIssues({
      tenant: tenant.tenants[0],
      repo: tenant.tenants[0].repos[0],
      owner: "acme",
      repoName: "widget",
      client: fakeClient([issue]),
      store,
      runService: { createRun: async () => { throw new Error("repeat poll called createRun") } },
      harness,
      appIdentityPromise: Promise.resolve({ botLogin: "codex-operator" })
    })
  ])
  assert.equal(turns.length, before)
  assert.equal(proofRows(shared.dbPath).length, 1)
  await store.close?.()
}

async function crashAfterAppend() {
  const store = createSqliteStore(`sqlite://${shared.dbPath}`)
  const db = new Database(shared.dbPath)
  const recorded = db.prepare("SELECT turn_message_id, turn_prompt FROM session_link WHERE id = ?").get(shared.linkId) as {
    turn_message_id: string
    turn_prompt: string
  }
  assert.ok(recorded.turn_message_id, "assignment must persist the client message id before relying on it")
  assert.equal(recorded.turn_prompt, turns.find(turn => turn.sessionId === shared.sessionId)?.prompt)
  const beforeMessages = await listUserTexts(shared.sessionId)
  const before = turns.length
  const stale = new Date(Date.now() - 10 * 60_000).toISOString()
  db.prepare("UPDATE session_link SET turn_state = 'in_progress', updated_at = ? WHERE id = ?").run(stale, shared.linkId)
  db.close()
  const tenant = reopen(shared.dbPath)
  const harness = harnessFor(store, tenant)
  await pollAssignedIssues({
    tenant: tenant.tenants[0],
    repo: tenant.tenants[0].repos[0],
    owner: "acme",
    repoName: "widget",
    client: fakeClient([openIssue(7, "Fix the gate", "jira:PROJ-1\nReply with exactly the word pong and nothing else.")]),
    store,
    runService: { createRun: async () => { throw new Error("crash reconcile called createRun") } },
    harness,
    appIdentityPromise: Promise.resolve({ botLogin: "codex-operator" })
  })
  assert.equal(turns.length, before, "stale reclaim after a stored message must not append again")
  const proof = proofRows(shared.dbPath)
  assert.equal(proof.length, 1)
  assert.equal(proof[0].turn_state, "completed")
  assert.equal(proof[0].status, HARNESS_RUN_STATUS)
  assert.equal(proof[0].run_id, shared.runId)
  const lookup = await getSessionMessage(shared.sessionId, recorded.turn_message_id, { baseUrl })
  assert.equal(lookup.found, true)
  if (lookup.found) {
    assert.deepEqual(lookup.texts, [recorded.turn_prompt])
  }
  const afterMessages = await listUserTexts(shared.sessionId)
  assert.equal(afterMessages.filter(text => text === recorded.turn_prompt).length, 1)
  assert.equal(afterMessages.length, beforeMessages.length)
  await store.close?.()
}

async function staleAbsent() {
  const dbPath = path.join(dbDir, "absent.db")
  const tenant = tenantConfig(dbPath, true)
  const store = createSqliteStore(`sqlite://${dbPath}`)
  const harness = harnessFor(store, tenant.config)
  const issue = openIssue(11, "Absent", "Reply with exactly the word pong and nothing else.")
  const before = turns.length
  await pollAssignedIssues({
    tenant: tenant.config.tenants[0],
    repo: tenant.config.tenants[0].repos[0],
    owner: "acme",
    repoName: "widget",
    client: fakeClient([issue]),
    store,
    runService: { createRun: async () => { throw new Error("absent setup called createRun") } },
    harness,
    appIdentityPromise: Promise.resolve({ botLogin: "codex-operator" })
  })
  assert.equal(turns.length, before + 1)
  const proof = proofRows(dbPath)
  assert.equal(proof.length, 1)
  const readDb = new Database(dbPath, { readonly: true })
  const originalId = readDb.prepare("SELECT turn_message_id FROM session_link WHERE id = ?").get(proof[0].link_id) as { turn_message_id: string }
  readDb.close()
  const absentId = "msg_absent_not_created_0001"
  const stale = new Date(Date.now() - 10 * 60_000).toISOString()
  const db = new Database(dbPath)
  db.prepare("UPDATE session_link SET turn_state = 'in_progress', turn_message_id = ?, updated_at = ? WHERE id = ?").run(absentId, stale, proof[0].link_id)
  db.close()
  const replay = await handleOptInIssueAssignment({
    store,
    harness,
    tenant: tenant.config.tenants[0],
    repo: tenant.config.tenants[0].repos[0],
    owner: "acme",
    repoName: "widget",
    installationId: 9,
    issueNumber: 11,
    title: issue.title,
    body: issue.body,
    repoPath,
    runId: "absent-replay"
  })
  assert.equal(replay.path, "indeterminate")
  if (replay.path === "indeterminate") {
    assert.match(replay.reason, /absent|not found|cannot prove|Not replaying/i)
    assert.equal(replay.messageId, absentId)
  }
  await pollAssignedIssues({
    tenant: tenant.config.tenants[0],
    repo: tenant.config.tenants[0].repos[0],
    owner: "acme",
    repoName: "widget",
    client: fakeClient([issue]),
    store,
    runService: { createRun: async () => { throw new Error("absent poll called createRun") } },
    harness,
    appIdentityPromise: Promise.resolve({ botLogin: "codex-operator" })
  })
  assert.equal(turns.length, before + 1, "poll must not replay an unproven stale turn")
  assert.equal(proofRows(dbPath)[0].turn_state, "indeterminate")
  assert.equal(proofRows(dbPath)[0].status, HARNESS_RUN_STATUS)
  const remote = await getSessionMessage(proof[0].opencode_session_id, originalId.turn_message_id, { baseUrl })
  assert.equal(remote.found, true)
  if (remote.found) assert.equal(remote.texts.length, 1)
  const missing = await getSessionMessage(proof[0].opencode_session_id, absentId, { baseUrl })
  assert.equal(missing.found, false)
  await store.close?.()
}

async function runBeforeLink() {
  const dbPath = path.join(dbDir, "run-before-link.db")
  const tenant = tenantConfig(dbPath, true)
  const store = createSqliteStore(`sqlite://${dbPath}`)
  let crashed = false
  const harness = harnessFor(store, tenant.config)
  const realCreate = harness.sessions!.createSession
  harness.sessions = {
    createSession: async (params, config) => {
      if (!crashed) {
        crashed = true
        throw new Error("crash after run row, before session link")
      }
      return realCreate(params, config)
    },
    appendTurn: harness.sessions!.appendTurn
  }
  const issue = openIssue(12, "Run first", "Reply with exactly the word pong and nothing else.")
  const before = turns.length
  await pollAssignedIssues({
    tenant: tenant.config.tenants[0],
    repo: tenant.config.tenants[0].repos[0],
    owner: "acme",
    repoName: "widget",
    client: fakeClient([issue]),
    store,
    runService: { createRun: async () => { throw new Error("run-before-link called createRun") } },
    harness,
    appIdentityPromise: Promise.resolve({ botLogin: "codex-operator" })
  })
  assert.equal(crashed, true)
  assert.equal(turns.length, before)
  assert.equal(proofRows(dbPath).length, 0)
  assert.equal(countRuns(dbPath), 1)
  await pollAssignedIssues({
    tenant: tenant.config.tenants[0],
    repo: tenant.config.tenants[0].repos[0],
    owner: "acme",
    repoName: "widget",
    client: fakeClient([issue]),
    store,
    runService: { createRun: async () => { throw new Error("run-before-link retry called createRun") } },
    harness,
    appIdentityPromise: Promise.resolve({ botLogin: "codex-operator" })
  })
  assert.equal(turns.length, before + 1)
  const proof = proofRows(dbPath)
  assert.equal(proof.length, 1)
  assert.equal(proof[0].status, HARNESS_RUN_STATUS)
  assert.equal(countRuns(dbPath), 1)
  assert.equal(countSessions(dbPath), 1)
  await store.close?.()
}

async function linkedComments() {
  const store = createSqliteStore(`sqlite://${shared.dbPath}`)
  const tenant = reopen(shared.dbPath)
  const harness = harnessFor(store, tenant)
  const before = turns.length
  const issueComment = await deliverIssueCommentWebhook({
    config: tenant,
    routing: { store, harness },
    onCommand: async () => { throw new Error("linked issue comment started Codex") },
    installationId: 9,
    repoFullName: "acme/widget",
    owner: "acme",
    repoName: "widget",
    defaultPrefixes: ["@codex-operator"],
    issue: { number: 7, title: "Fix the gate", labels: [{ name: "agent:managed" }] },
    comment: { id: 50, body: "Reply with exactly the word pong and nothing else.", userType: "User", userLogin: "ada" }
  })
  assert.equal(issueComment, "routed")
  const prComment = await deliverPolledIssueComment({
    store,
    harness,
    tenantId: "local",
    repoFullName: "acme/widget",
    issueNumber: 8,
    isPullRequest: true,
    title: "PR",
    commentBody: "Reply with exactly the word pong and nothing else.",
    authorIsBot: false,
    repoPath,
    commentId: 80
  })
  // PR is not linked yet; this must not start a session. The linked PR comment
  // is sent after pollAssignedPullRequests attaches it.
  assert.equal(prComment, "unlinked")
  await pollAssignedPullRequests({
    tenant: tenant.tenants[0],
    repo: tenant.tenants[0].repos[0],
    owner: "acme",
    repoName: "widget",
    client: fakePrClient(8, "Closes #7"),
    harness,
    appIdentityPromise: Promise.resolve({ botLogin: "codex-operator" })
  })
  const linkedPr = await deliverPolledIssueComment({
    store,
    harness,
    tenantId: "local",
    repoFullName: "acme/widget",
    issueNumber: 8,
    isPullRequest: true,
    title: "PR",
    commentBody: "Reply with exactly the word pong and nothing else.",
    authorIsBot: false,
    repoPath,
    commentId: 81
  })
  assert.equal(linkedPr, "routed")
  await jiraComment(store, harness)
  assert.equal(turns.length, before + 3)
  for (const turn of turns.slice(before)) assert.equal(turn.sessionId, shared.sessionId)
  const proof = proofRows(shared.dbPath)
  assert.equal(proof.length, 1)
  assert.equal(proof[0].opencode_session_id, shared.sessionId)
  await store.close?.()
}

async function duplicateComment() {
  const store = createSqliteStore(`sqlite://${shared.dbPath}`)
  const tenant = reopen(shared.dbPath)
  const harness = harnessFor(store, tenant)
  const before = turns.length
  const beforeTexts = await listUserTexts(shared.sessionId)
  const issue = { number: 7, title: "Fix the gate", labels: [{ name: "agent:managed" }] }
  const comment = { id: 50, body: "Reply with exactly the word pong and nothing else.", userType: "User", userLogin: "ada" }
  const [webhook, poll] = await Promise.all([
    deliverIssueCommentWebhook({
      config: tenant,
      routing: { store, harness },
      onCommand: async () => { throw new Error("duplicate webhook started Codex") },
      installationId: 9,
      repoFullName: "acme/widget",
      owner: "acme",
      repoName: "widget",
      defaultPrefixes: ["@codex-operator"],
      issue,
      comment
    }),
    deliverPolledIssueComment({
      store,
      harness,
      tenantId: "local",
      repoFullName: "acme/widget",
      issueNumber: 7,
      isPullRequest: false,
      title: "Fix the gate",
      commentBody: comment.body,
      authorIsBot: false,
      repoPath,
      commentId: comment.id
    })
  ])
  assert.ok(webhook === "routed" || webhook === "indeterminate")
  assert.ok(poll === "routed" || poll === "indeterminate")
  assert.equal(turns.length, before, "the same comment id must not append a second turn")
  const texts = await listUserTexts(shared.sessionId)
  assert.equal(texts.length, beforeTexts.length, "duplicate poll/webhook delivery must not add a user message part")
  const deliveryDb = new Database(shared.dbPath, { readonly: true })
  const delivery = deliveryDb.prepare(
    "SELECT state FROM github_comment_delivery WHERE comment_id = ?"
  ).get("50") as { state: string }
  deliveryDb.close()
  assert.equal(delivery.state, "delivered")
  await store.close?.()
}

async function linkedPr() {
  const before = proofRows(shared.dbPath)
  assert.equal(before.length, 1)
  assert.equal(countKeys(shared.dbPath, "gh_pr", "8"), 1)
  assert.equal(before[0].opencode_session_id, shared.sessionId)
  const store = createSqliteStore(`sqlite://${shared.dbPath}`)
  const tenant = reopen(shared.dbPath)
  await pollAssignedPullRequests({
    tenant: tenant.tenants[0],
    repo: tenant.tenants[0].repos[0],
    owner: "acme",
    repoName: "widget",
    client: fakePrClient(8, "Closes #7"),
    harness: harnessFor(store, tenant),
    appIdentityPromise: Promise.resolve({ botLogin: "codex-operator" })
  })
  const after = proofRows(shared.dbPath)
  assert.equal(after.length, 1)
  assert.equal(after[0].run_id, before[0].run_id)
  assert.equal(after[0].opencode_session_id, shared.sessionId)
  assert.equal(countSessions(shared.dbPath), 1)
  assert.equal(countKeys(shared.dbPath, "gh_pr", "8"), 1)
  await store.close?.()
}

async function conflict() {
  const dbPath = path.join(dbDir, "conflict.db")
  const tenant = tenantConfig(dbPath, true)
  const store = createSqliteStore(`sqlite://${dbPath}`)
  await claimAndCreateLink(store, "local", { kind: "jira", issueKey: "PROJ-1" }, async () => ({ sessionId: "ses-a" }))
  await claimAndCreateLink(store, "local", { kind: "jira", issueKey: "PROJ-2" }, async () => ({ sessionId: "ses-b" }))
  const harness = harnessFor(store, tenant.config)
  const issue = openIssue(3, "split", "jira:PROJ-1\njira:PROJ-2")
  const result = await deliverIssuesAssignedWebhook({
    config: tenant.config,
    routing: { store, harness },
    onCommand: async () => { throw new Error("conflict called Codex") },
    installationId: 9,
    repoFullName: "acme/widget",
    owner: "acme",
    repoName: "widget",
    assigneeLogin: "codex-operator",
    botLogin: "codex-operator",
    issue
  })
  assert.equal(result.path, "conflict")
  if (result.path === "conflict") {
    assert.ok(result.reason.includes("more than one session"))
    assert.equal(result.linkIds?.length, 2)
  }
  await pollAssignedIssues({
    tenant: tenant.config.tenants[0],
    repo: tenant.config.tenants[0].repos[0],
    owner: "acme",
    repoName: "widget",
    client: fakeClient([issue]),
    store,
    runService: { createRun: async () => { throw new Error("conflict poll called createRun") } },
    harness,
    appIdentityPromise: Promise.resolve({ botLogin: "codex-operator" })
  })
  assert.equal(proofRows(dbPath).length, 0)
  assert.equal(countSessions(dbPath), 2)
  await store.close?.()
}

async function legacyCodex() {
  const dbPath = path.join(dbDir, "legacy.db")
  const tenant = tenantConfig(dbPath, false)
  const store = createSqliteStore(`sqlite://${dbPath}`)
  const { queue } = createQueue(undefined, "memory")
  const queued: string[] = []
  const worker = startWorker(undefined, async job => {
    queued.push(job.runId)
  }, "memory")
  const runService = createRunService({ store, queue })
  const harness = harnessFor(store, tenant.config)
  harness.sessions = {
    createSession: async () => { throw new Error("legacy path created an opencode session") },
    appendTurn: async () => { throw new Error("legacy path appended a turn") }
  }
  const issue = openIssue(4, "Legacy", "do the legacy thing")
  await pollAssignedIssues({
    tenant: tenant.config.tenants[0],
    repo: tenant.config.tenants[0].repos[0],
    owner: "acme",
    repoName: "widget",
    client: fakeClient([issue]),
    store,
    runService,
    harness,
    appIdentityPromise: Promise.resolve({ botLogin: "codex-operator" })
  })
  await waitFor(() => queued.length === 1)
  const row = new Database(dbPath).prepare("SELECT status, source_key FROM runs").get() as { status: string; source_key: string }
  assert.equal(row.status, "queued")
  assert.equal(row.source_key, "github-assigned:9:acme/widget:4")
  assert.equal(countSessions(dbPath), 0)
  await worker.worker.close()
  await store.close?.()
}

async function legacyManaged() {
  const dbPath = path.join(dbDir, "managed.db")
  const tenant = tenantConfig(dbPath, false)
  const store = createSqliteStore(`sqlite://${dbPath}`)
  let calls = 0
  const result = await deliverIssuesAssignedWebhook({
    config: tenant.config,
    routing: { store, harness: harnessFor(store, tenant.config) },
    onCommand: async () => { calls += 1 },
    installationId: 9,
    repoFullName: "acme/widget",
    owner: "acme",
    repoName: "widget",
    assigneeLogin: "codex-operator",
    botLogin: "codex-operator",
    issue: openIssue(5, "Managed", "body", true)
  })
  assert.equal(result, "ignored")
  assert.equal(calls, 0)
  assert.equal(countSessions(dbPath), 0)
  await store.close?.()
}

async function runnerRefuses() {
  const dbPath = path.join(dbDir, "runner.db")
  const tenant = tenantConfig(dbPath, true)
  const store = createSqliteStore(`sqlite://${dbPath}`)
  const inserted = await store.insertHarnessRun({
    id: "harness-run-refuse",
    tenantId: "local",
    repoFullName: "acme/widget",
    repoPath,
    sourceKey: "github-assigned:9:acme/widget:99",
    prompt: "do not start codex",
    github: { owner: "acme", repo: "widget", issueNumber: 99, installationId: 9 }
  })
  assert.equal(inserted.outcome, "created")
  const runner = createRunner({
    store,
    env: { codexTurnTimeoutMs: 30_000 }
  })
  await assert.rejects(() => runner({ runId: inserted.run.id }), /refusing Codex worker/)
  const status = new Database(dbPath).prepare("SELECT status FROM runs WHERE id = ?").get(inserted.run.id) as { status: string }
  assert.equal(status.status, HARNESS_RUN_STATUS)
  assert.notEqual(status.status, "running")
  await store.close?.()
}

async function jiraComment(store: RunStore, harness: HarnessCtx) {
  const jira = await fakeJira()
  const config: AppConfig = {
    tenants: [{
      ...reopen(shared.dbPath).tenants[0],
      jira: {
        baseUrl: jira.baseUrl,
        projectKey: "PROJ",
        repo: "acme/widget",
        agentAccountId: "agent-1",
        pollIntervalSec: 30
      }
    }]
  }
  const loop = createJiraPollLoop({
    config,
    store,
    harness: createHarnessBackedJiraPoller(harness),
    env: { jiraEmail: "agent@example.com", jiraApiToken: "local-test-token" },
    now: () => new Date()
  })
  if (!loop) throw new Error("jira poll loop did not start")
  await loop.tick()
  await jira.close()
}

function tenantConfig(dbPath: string, optIn: boolean): { dbPath: string; config: AppConfig } {
  const tenant: TenantConfig = {
    id: "local",
    name: "Local",
    github: {
      installationId: 9,
      assignmentAssignees: ["codex-operator"],
      repoAllowlist: ["acme/widget"]
    },
    harness: optIn ? { issueAssignmentRepos: ["acme/widget"] } : {},
    repos: [{ fullName: "acme/widget", path: repoPath }]
  }
  return { dbPath, config: { tenants: [tenant] } }
}

function reopen(dbPath: string): AppConfig {
  return tenantConfig(dbPath, true).config
}

function harnessFor(store: RunStore, config: AppConfig): HarnessCtx {
  return {
    store,
    config,
    opencodeConfig: { baseUrl, timeoutMs: 90_000 },
    sessions
  }
}

function openIssue(number: number, title: string, body: string, managed = false) {
  return {
    number,
    title,
    body,
    labels: managed ? [{ name: "agent:managed" }] : [],
    pull_request: undefined
  }
}

function fakeClient(issues: Array<ReturnType<typeof openIssue>>): any {
  return {
    octokit: {
      issues: {
        listForRepo: async () => ({ data: issues })
      }
    }
  }
}

function fakePrClient(number: number, body: string): any {
  return {
    octokit: {
      issues: {
        listForRepo: async () => ({
          data: [{ number, pull_request: { url: "x" }, title: "PR" }]
        })
      },
      pulls: {
        get: async () => ({
          data: { title: "PR", body, head: { ref: "feature/PROJ-1-gate" } }
        })
      }
    }
  }
}

function proofRows(dbPath: string) {
  const db = new Database(dbPath, { readonly: true })
  const rows = db.prepare(`
    SELECT r.id AS run_id, r.status, r.source_key, s.id AS link_id, s.run_id AS link_run_id,
           s.source_key AS link_source_key, s.opencode_session_id, s.turn_state
    FROM runs r
    JOIN session_link s ON s.run_id = r.id AND s.source_key = r.source_key
  `).all() as Array<{
    run_id: string
    status: string
    source_key: string
    link_id: string
    link_run_id: string
    link_source_key: string
    opencode_session_id: string
    turn_state: string
  }>
  db.close()
  return rows
}

function countKeys(dbPath: string, kind: string, value: string): number {
  const db = new Database(dbPath, { readonly: true })
  const row = db.prepare("SELECT COUNT(*) AS n FROM session_link_key WHERE kind = ? AND value = ?").get(kind, value) as { n: number }
  db.close()
  return row.n
}

function countRuns(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true })
  const row = db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }
  db.close()
  return row.n
}

async function listUserTexts(sessionId: string): Promise<string[]> {
  const directory = encodeURIComponent(repoPath)
  const response = await fetch(`${baseUrl}/session/${encodeURIComponent(sessionId)}/message?directory=${directory}`)
  assert.equal(response.status, 200)
  const rows = await response.json() as Array<{ info?: { role?: string }; parts?: Array<{ type?: string; text?: string }> }>
  return rows
    .filter(row => row.info?.role === "user")
    .flatMap(row => (row.parts ?? []).filter(part => part.type === "text").map(part => part.text ?? ""))
}

function countSessions(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true })
  const row = db.prepare("SELECT COUNT(*) AS n FROM session_link").get() as { n: number }
  db.close()
  return row.n
}

async function fakeJira() {
  const comments = [{
    id: "c1",
    created: new Date().toISOString(),
    author: { accountId: "human-1" },
    body: textToAdf("Reply with exactly the word pong and nothing else.")
  }]
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/rest/api/3/myself")) {
      sendJson(res, 200, { timeZone: "UTC" })
      return
    }
    void readBody(req).then(() => {
      if (req.url?.includes("/comment")) {
        sendJson(res, 200, { comments, total: comments.length, startAt: 0 })
        return
      }
      sendJson(res, 200, {
        issues: [{
          id: "10001",
          key: "PROJ-1",
          fields: {
            summary: "Fix the gate",
            updated: new Date().toISOString(),
            assignee: { accountId: "someone-else" },
            comment: { comments, total: comments.length, startAt: 0 }
          }
        }],
        isLast: true,
        nextPageToken: null
      })
    })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no jira port")
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve()))
  }
}

function sendJson(res: ServerResponse, status: number, json: unknown) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(json))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", chunk => chunks.push(Buffer.from(chunk)))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for legacy queue")
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function freePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no port")
  await new Promise<void>(resolve => server.close(() => resolve()))
  return address.port
}

async function waitForServer(url: string, proc: ChildProcess) {
  const deadline = Date.now() + 90_000
  let last = "not started"
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`opencode exited ${proc.exitCode}: ${last}`)
    for (const path of ["/global/health", "/session/status"]) {
      try {
        const response = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(1_000) })
        if (response.ok) return
        last = `${path} HTTP ${response.status}`
      } catch (error) {
        last = error instanceof Error ? error.message : String(error)
      }
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`opencode serve did not become ready: ${last}`)
}

async function stopChild(proc: ChildProcess) {
  if (proc.pid && proc.exitCode === null) {
    try { process.kill(-proc.pid, "SIGTERM") } catch { proc.kill("SIGTERM") }
  }
  const deadline = Date.now() + 5_000
  while (proc.exitCode === null && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (proc.pid && proc.exitCode === null) {
    try { process.kill(-proc.pid, "SIGKILL") } catch { proc.kill("SIGKILL") }
  }
}
