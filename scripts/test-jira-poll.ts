import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { once } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadConfig, loadEnv } from "../src/config.js"
import { createJiraPollLoop, formatJqlUpdated, jiraPollIntervalMs, startJiraPolling } from "../src/jira-poll.js"
import type { JiraAssignmentEvent, JiraCommentEvent, JiraPollHarness } from "../src/jira-poll.js"
import { adfToText, textToAdf } from "../src/jira-types.js"
import { buildJiraBasicAuthHeader } from "../src/jira-auth.js"
import { createStore } from "../src/storage.js"
import type { AppConfig } from "../src/types.js"

const AGENT = "712020:agent"
const EMAIL = "agent@example.com"
const TOKEN = "secret-token"
const AUTH = buildJiraBasicAuthHeader(EMAIL, TOKEN)

type Recorded = {
  method?: string
  url?: string
  authorization?: string
  body: any
}

const recorded: Recorded[] = []
let myselfTimeZone = "UTC"
let handler: (req: IncomingMessage, body: any) => Promise<{ status: number; json: unknown }> = async () => ({
  status: 200,
  json: { issues: [], isLast: true, nextPageToken: null }
})

const server = createServer((req, res) => {
  if (req.url?.startsWith("/rest/api/3/myself")) {
    recorded.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: undefined })
    sendJson(res, 200, { timeZone: myselfTimeZone })
    return
  }
  void readBody(req).then(async body => {
    recorded.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      body
    })
    try {
      const result = await handler(req, body)
      sendJson(res, result.status, result.json)
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : "handler failed" })
    }
  })
})

server.listen(0, "127.0.0.1")
await once(server, "listening")
const address = server.address()
if (!address || typeof address === "string") throw new Error("no port")
const baseUrl = `http://127.0.0.1:${address.port}`

const dir = await mkdtemp(path.join(tmpdir(), "jira-poll-"))
const dbPath = path.join(dir, "codebridge.db")

try {
  await testAdfRoundTrip()
  await testAuthHeader()
  await testIntervalFloor()
  await testConfigSchema(dir)
  await testPollStatePersists()
  await testNonUtcSiteTimezoneUsedInJql()
  await testCursorOverlapDedupeAndPagination()
  await testPartialCommentPage()
  await testTenantIsolationAndFailedTick()
  await testReentrancy()
  await testIntervalTimerFloor()
  console.log("test:jira-poll passed")
} finally {
  server.close()
  await once(server, "close")
  await rm(dir, { recursive: true, force: true })
}

async function testAdfRoundTrip() {
  const text = "Fix the flaky checkout."
  const adf = textToAdf(text)
  assert.equal(adf.type, "doc")
  assert.equal(adf.version, 1)
  assert.equal(adf.content?.[0]?.type, "paragraph")
  assert.equal(adf.content?.[0]?.content?.[0]?.type, "text")
  assert.equal(adf.content?.[0]?.content?.[0]?.text, text)
  assert.equal(adfToText(adf), text)
  assert.equal(adfToText({
    type: "doc",
    version: 1,
    content: [{
      type: "paragraph",
      content: [
        { type: "text", text: "Hello " },
        { type: "text", text: "world", marks: [{ type: "strong" }] }
      ]
    }]
  }), "Hello world")
}

async function testAuthHeader() {
  assert.equal(AUTH, `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`, "utf8").toString("base64")}`)
  assert.equal(jiraPollIntervalMs(1), 10000)
  assert.equal(jiraPollIntervalMs(30), 30000)
  assert.equal(formatJqlUpdated(new Date("2024-01-01T00:01:30.000Z"), "UTC"), "2024-01-01 00:01")
  // Non-UTC site timezone: this is the regression this task exists for. If
  // formatJqlUpdated ever goes back to hardcoding UTC math, this assertion
  // catches it -- America/Los_Angeles is UTC-8 in January (no DST), so the
  // same instant must format 8 hours earlier in wall-clock terms.
  assert.equal(formatJqlUpdated(new Date("2024-01-01T00:01:30.000Z"), "America/Los_Angeles"), "2023-12-31 16:01")
  // DST case: America/Los_Angeles is UTC-7 in July.
  assert.equal(formatJqlUpdated(new Date("2024-07-01T00:01:30.000Z"), "America/Los_Angeles"), "2024-06-30 17:01")
}

async function testIntervalFloor() {
  const loop = createJiraPollLoop({
    config: configFor("floor", 1),
    store: createStore(`sqlite:${dbPath}`),
    env: { jiraEmail: EMAIL, jiraApiToken: TOKEN }
  })
  assert.ok(loop)
  assert.equal(loop.intervalMs, 10000)
  assert.equal(createJiraPollLoop({
    config: { tenants: [] },
    store: createStore(`sqlite:${dbPath}`),
    env: { jiraEmail: EMAIL, jiraApiToken: TOKEN }
  }), null)
  assert.equal(createJiraPollLoop({
    config: configFor("nocreds"),
    store: createStore(`sqlite:${dbPath}`),
    env: {}
  }), null)
}

async function testConfigSchema(root: string) {
  const good = path.join(root, "good.yaml")
  await writeFile(good, `
secrets:
  jiraEmail: "agent@example.com"
  jiraApiToken: "from-secrets"
tenants:
  - id: local
    name: Local
    jira:
      baseUrl: "https://example.atlassian.net"
      projectKey: "PROJ"
      repo: "owner/repo"
      agentAccountId: "712020:agent"
      pollIntervalSec: 30
    repos:
      - fullName: "owner/repo"
        path: "/tmp/repo"
`)
  const loaded = await loadConfig(good)
  assert.equal(loaded.tenants[0]?.jira?.projectKey, "PROJ")
  assert.equal(loaded.tenants[0]?.jira?.repo, "owner/repo")
  assert.equal(loaded.secrets?.jiraEmail, "agent@example.com")
  assert.equal(loaded.tenants[0]?.jira && "apiToken" in loaded.tenants[0].jira, false)

  const bad = path.join(root, "bad.yaml")
  await writeFile(bad, `
tenants:
  - id: local
    name: Local
    jira:
      baseUrl: "https://example.atlassian.net"
      projectKey: "proj"
      repo: "owner/repo"
      agentAccountId: "712020:agent"
      pollIntervalSec: 30
    repos: []
`)
  await assert.rejects(() => loadConfig(bad), /projectKey/)

  const previousEmail = process.env.JIRA_EMAIL
  const previousToken = process.env.JIRA_API_TOKEN
  process.env.JIRA_EMAIL = "env@example.com"
  process.env.JIRA_API_TOKEN = "env-token"
  try {
    const env = loadEnv()
    assert.equal(env.jiraEmail, "env@example.com")
    assert.equal(env.jiraApiToken, "env-token")
  } finally {
    if (previousEmail == null) delete process.env.JIRA_EMAIL
    else process.env.JIRA_EMAIL = previousEmail
    if (previousToken == null) delete process.env.JIRA_API_TOKEN
    else process.env.JIRA_API_TOKEN = previousToken
  }
}

async function testPollStatePersists() {
  const file = path.join(dir, "state.db")
  const store = createStore(`sqlite:${file}`)
  await store.ensureSchema()
  assert.equal(await store.getJiraPollState("local"), null)
  await store.updateJiraPollState({ tenantId: "local", lastCursor: "2024-01-01T00:05:00.000+0000" })
  const reloaded = createStore(`sqlite:${file}`)
  await reloaded.ensureSchema()
  const state = await reloaded.getJiraPollState("local")
  assert.equal(state?.lastCursor, "2024-01-01T00:05:00.000+0000")
  assert.ok(state?.updatedAt)
  await store.updateJiraPollState({ tenantId: "local", lastCursor: "2024-01-01T00:06:00.000+0000" })
  assert.equal((await reloaded.getJiraPollState("local"))?.lastCursor, "2024-01-01T00:06:00.000+0000")
}

// Regression for the bug this task exists for: an unqualified JQL `updated`
// literal is interpreted in the SITE's configured timezone, not UTC. Injects
// a non-UTC /rest/api/3/myself response and asserts the JQL literal on the
// wire reflects that zone's wall-clock time, not a UTC-only formatting.
async function testNonUtcSiteTimezoneUsedInJql() {
  recorded.length = 0
  myselfTimeZone = "America/Los_Angeles"
  try {
    const file = path.join(dir, "tz.db")
    const store = createStore(`sqlite:${file}`)
    await store.ensureSchema()
    // Fixed instant far enough from any DST edge for a stable, hand-verifiable
    // offset: 2024-01-15T00:02:00Z, PST (UTC-8) -> 2024-01-14 16:02 local.
    await store.updateJiraPollState({ tenantId: "local", lastCursor: "2024-01-15T00:02:00.000Z" })
    const events = collect()
    handler = async () => ({ status: 200, json: { issues: [], isLast: true, nextPageToken: null } })
    const loop = loopFor(store, events.harness)
    await loop.tick()
    const myselfCalls = recorded.filter(item => item.url?.startsWith("/rest/api/3/myself"))
    assert.equal(myselfCalls.length, 1)
    const search = recorded.filter(item => item.url === "/rest/api/3/search/jql")
    assert.equal(search.length, 1)
    assert.match(search[0]?.body.jql, /updated >= "2024-01-14 16:01"/)

    // Second tick within the same loop must not re-fetch /myself -- cached
    // per tenant for the loop's lifetime.
    await loop.tick()
    assert.equal(recorded.filter(item => item.url?.startsWith("/rest/api/3/myself")).length, 1)
  } finally {
    myselfTimeZone = "UTC"
  }
}

async function testCursorOverlapDedupeAndPagination() {
  recorded.length = 0
  const file = path.join(dir, "cursor.db")
  const store = createStore(`sqlite:${file}`)
  await store.ensureSchema()
  await store.updateJiraPollState({ tenantId: "local", lastCursor: "2024-01-01T00:02:30.000Z" })
  const events = collect()
  let phase: "page" | "overlap" | "new-comment" = "page"

  handler = async (_req, body) => {
    if (phase === "page") {
      if (!body?.nextPageToken) {
        return {
          status: 200,
          json: {
            issues: [issue({
              id: "1",
              key: "PROJ-1",
              updated: "2024-01-01T00:03:00.000+0000",
              comments: [comment("c1", "2024-01-01T00:02:40.000+0000", "human", "first note")]
            })],
            nextPageToken: "page-2",
            isLast: false
          }
        }
      }
      assert.equal(body.nextPageToken, "page-2")
      return {
        status: 200,
        json: {
          issues: [issue({
            id: "2",
            key: "PROJ-2",
            updated: "2024-01-01T00:04:00.000+0000",
            assignee: "someone-else",
            comments: [
              comment("old", "2023-01-01T00:00:00.000+0000", "human", "ancient"),
              comment("c-agent", "2024-01-01T00:03:30.000+0000", AGENT, "bot note"),
              comment("c2", "2024-01-01T00:03:40.000+0000", "human", "please check")
            ]
          })],
          nextPageToken: null,
          isLast: true
        }
      }
    }
    return {
      status: 200,
      json: {
        issues: [
          issue({
            id: "1",
            key: "PROJ-1",
            updated: "2024-01-01T00:03:00.000+0000",
            comments: [
              comment("c1", "2024-01-01T00:02:40.000+0000", "human", "first note"),
              ...(phase === "new-comment"
                ? [comment("c3", "2024-01-01T00:04:10.000+0000", "human", "follow up")]
                : [])
            ]
          }),
          issue({
            id: "2",
            key: "PROJ-2",
            updated: "2024-01-01T00:04:00.000+0000",
            assignee: "someone-else",
            comments: [
              comment("old", "2023-01-01T00:00:00.000+0000", "human", "ancient"),
              comment("c-agent", "2024-01-01T00:03:30.000+0000", AGENT, "bot note"),
              comment("c2", "2024-01-01T00:03:40.000+0000", "human", "please check")
            ]
          })
        ],
        nextPageToken: null,
        isLast: true
      }
    }
  }

  const loop = loopFor(store, events.harness)
  await loop.tick()

  const search = recorded.filter(item => item.url === "/rest/api/3/search/jql")
  assert.equal(search.length, 2)
  assert.equal(search[0]?.method, "POST")
  assert.equal(search[0]?.authorization, AUTH)
  assert.match(search[0]?.body.jql, /project = PROJ AND updated >= "2024-01-01 00:01" ORDER BY updated ASC/)
  assert.deepEqual(search[0]?.body.fields, ["assignee", "comment", "status", "summary", "updated"])
  assert.equal(search[1]?.body.nextPageToken, "page-2")
  assert.equal(events.assignments.length, 1)
  assert.equal(events.assignments[0]?.issueKey, "PROJ-1")
  assert.equal(events.assignments[0]?.repoPath, "/tmp/repo")
  assert.equal(events.assignments[0]?.title, "Fix CI")
  assert.deepEqual(events.comments.map(item => item.commentId), ["c1", "c2"])
  assert.equal(events.comments[0]?.commentBody, "first note")
  assert.equal(events.comments[1]?.commentBody, "please check")
  assert.equal((await store.getJiraPollState("local"))?.lastCursor, "2024-01-01T00:04:00.000+0000")
  assert.notEqual((await store.getJiraPollState("local"))?.lastCursor, "page-2")

  phase = "overlap"
  recorded.length = 0
  await loop.tick()
  assert.equal(events.assignments.length, 1)
  assert.deepEqual(events.comments.map(item => item.commentId), ["c1", "c2"])
  assert.equal((await store.getJiraPollState("local"))?.lastCursor, "2024-01-01T00:04:00.000+0000")

  phase = "new-comment"
  await loop.tick()
  assert.equal(events.assignments.length, 1)
  assert.deepEqual(events.comments.map(item => item.commentId), ["c1", "c2", "c3"])
  assert.equal(events.comments[2]?.commentBody, "follow up")
}

async function testPartialCommentPage() {
  recorded.length = 0
  const file = path.join(dir, "comments.db")
  const store = createStore(`sqlite:${file}`)
  await store.ensureSchema()
  await store.updateJiraPollState({ tenantId: "local", lastCursor: "2024-01-01T00:00:00.000Z" })
  const events = collect()
  handler = async (req) => {
    if (req.url?.startsWith("/rest/api/3/issue/PROJ-9/comment")) {
      return {
        status: 200,
        json: {
          startAt: 0,
          maxResults: 100,
          total: 2,
          comments: [
            comment("p1", "2024-01-01T00:01:00.000+0000", "human", "page one"),
            comment("p2", "2024-01-01T00:02:00.000+0000", AGENT, "ignored")
          ]
        }
      }
    }
    return {
      status: 200,
      json: {
        issues: [issue({
          id: "9",
          key: "PROJ-9",
          updated: "2024-01-01T00:02:30.000+0000",
          commentPage: {
            comments: [comment("p1", "2024-01-01T00:01:00.000+0000", "human", "page one")],
            total: 2,
            startAt: 0,
            maxResults: 1
          }
        })],
        isLast: true,
        nextPageToken: null
      }
    }
  }
  const loop = loopFor(store, events.harness)
  await loop.tick()
  assert.ok(recorded.some(item => item.url?.startsWith("/rest/api/3/issue/PROJ-9/comment")))
  assert.deepEqual(events.comments.map(item => item.commentId), ["p1"])
  assert.equal(events.comments[0]?.commentBody, "page one")
}

async function testTenantIsolationAndFailedTick() {
  recorded.length = 0
  const file = path.join(dir, "isolate.db")
  const store = createStore(`sqlite:${file}`)
  await store.ensureSchema()
  await store.updateJiraPollState({ tenantId: "broken", lastCursor: "2024-01-01T00:00:00.000Z" })
  await store.updateJiraPollState({ tenantId: "ok", lastCursor: "2024-01-01T00:00:00.000Z" })
  const events = collect()
  handler = async (_req, body) => {
    if (String(body?.jql).includes("project = BROKEN")) {
      return { status: 500, json: { message: "nope" } }
    }
    return {
      status: 200,
      json: {
        issues: [issue({
          id: "3",
          key: "OK-1",
          updated: "2024-01-01T00:08:00.000+0000"
        })],
        isLast: true,
        nextPageToken: null
      }
    }
  }
  const loop = createJiraPollLoop({
    config: {
      tenants: [
        tenant("broken", "BROKEN"),
        tenant("ok", "OK")
      ]
    },
    store,
    harness: events.harness,
    env: { jiraEmail: EMAIL, jiraApiToken: TOKEN }
  })
  assert.ok(loop)
  await loop.tick()
  assert.equal(events.assignments.length, 1)
  assert.equal(events.assignments[0]?.tenantId, "ok")
  assert.equal((await store.getJiraPollState("broken"))?.lastCursor, "2024-01-01T00:00:00.000Z")
  assert.equal((await store.getJiraPollState("ok"))?.lastCursor, "2024-01-01T00:08:00.000+0000")

  const throwing = collect()
  throwing.harness.onAssignmentEvent = async () => {
    throw new Error("harness down")
  }
  handler = async () => ({
    status: 200,
    json: {
      issues: [issue({ id: "4", key: "PROJ-4", updated: "2024-06-01T00:00:00.000+0000" })],
      isLast: true,
      nextPageToken: null
    }
  })
  const retryStore = createStore(`sqlite:${path.join(dir, "retry.db")}`)
  await retryStore.ensureSchema()
  await retryStore.updateJiraPollState({ tenantId: "local", lastCursor: "2024-05-01T00:00:00.000Z" })
  const retryLoop = loopFor(retryStore, throwing.harness)
  await retryLoop.tick()
  assert.equal((await retryStore.getJiraPollState("local"))?.lastCursor, "2024-05-01T00:00:00.000Z")
  const second = collect()
  const retryLoop2 = createJiraPollLoop({
    config: configFor("local"),
    store: retryStore,
    harness: second.harness,
    env: { jiraEmail: EMAIL, jiraApiToken: TOKEN }
  })
  assert.ok(retryLoop2)
  await retryLoop2.tick()
  assert.equal(second.assignments.length, 1)
}

async function testReentrancy() {
  recorded.length = 0
  const file = path.join(dir, "reenter.db")
  const store = createStore(`sqlite:${file}`)
  await store.ensureSchema()
  await store.updateJiraPollState({ tenantId: "local", lastCursor: "2024-01-01T00:00:00.000Z" })
  let release: (value: { status: number; json: unknown }) => void = () => {}
  let started: () => void = () => {}
  const startedPromise = new Promise<void>(resolve => { started = resolve })
  handler = () => new Promise(resolve => {
    release = resolve
    started()
  })
  const loop = loopFor(store, collect().harness)
  const first = loop.tick()
  await startedPromise
  const second = loop.tick()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(recorded.filter(item => item.url === "/rest/api/3/search/jql").length, 1)
  release({ status: 200, json: { issues: [], isLast: true, nextPageToken: null } })
  await first
  await second
  assert.equal(recorded.filter(item => item.url === "/rest/api/3/search/jql").length, 1)
}

async function testIntervalTimerFloor() {
  recorded.length = 0
  const file = path.join(dir, "timer.db")
  const store = createStore(`sqlite:${file}`)
  await store.ensureSchema()
  await store.updateJiraPollState({ tenantId: "local", lastCursor: "2024-01-01T00:00:00.000Z" })
  handler = async () => ({ status: 200, json: { issues: [], isLast: true, nextPageToken: null } })
  const stop = startJiraPolling({
    config: configFor("local", 1),
    store,
    env: { jiraEmail: EMAIL, jiraApiToken: TOKEN }
  })
  assert.equal(typeof stop, "function")
  const deadline = Date.now() + 2000
  while (recorded.filter(item => item.url === "/rest/api/3/search/jql").length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(recorded.filter(item => item.url === "/rest/api/3/search/jql").length, 1)
  await new Promise(resolve => setTimeout(resolve, 2500))
  stop?.()
  assert.equal(recorded.filter(item => item.url === "/rest/api/3/search/jql").length, 1)
}

function loopFor(store: ReturnType<typeof createStore>, harness: JiraPollHarness) {
  const loop = createJiraPollLoop({
    config: configFor("local"),
    store,
    harness,
    env: { jiraEmail: EMAIL, jiraApiToken: TOKEN }
  })
  if (!loop) throw new Error("expected loop")
  return loop
}

function configFor(id: string, pollIntervalSec = 30): AppConfig {
  return { tenants: [tenant(id, "PROJ", pollIntervalSec)] }
}

function tenant(id: string, projectKey: string, pollIntervalSec = 30) {
  return {
    id,
    name: id,
    jira: {
      baseUrl,
      projectKey,
      repo: "owner/repo",
      agentAccountId: AGENT,
      pollIntervalSec
    },
    repos: [{ fullName: "owner/repo", path: "/tmp/repo" }]
  }
}

function collect() {
  const assignments: JiraAssignmentEvent[] = []
  const comments: JiraCommentEvent[] = []
  const harness: JiraPollHarness = {
    onAssignmentEvent(ev) { assignments.push(ev) },
    onCommentEvent(ev) { comments.push(ev) }
  }
  return { assignments, comments, harness }
}

function issue(input: {
  id: string
  key: string
  updated: string
  assignee?: string | null
  comments?: ReturnType<typeof comment>[]
  commentPage?: { comments: ReturnType<typeof comment>[]; total: number; startAt: number; maxResults: number }
}) {
  const comments = input.comments ?? []
  return {
    id: input.id,
    key: input.key,
    fields: {
      summary: "Fix CI",
      updated: input.updated,
      assignee: input.assignee === null ? null : { accountId: input.assignee ?? AGENT },
      status: { name: "To Do", id: "1" },
      comment: input.commentPage ?? {
        comments,
        total: comments.length,
        startAt: 0,
        maxResults: Math.max(comments.length, 1)
      }
    }
  }
}

function comment(id: string, created: string, accountId: string, text: string) {
  return {
    id,
    created,
    updated: created,
    author: { accountId },
    body: textToAdf(text)
  }
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", chunk => chunks.push(Buffer.from(chunk)))
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      if (!raw) return resolve(null)
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(error)
      }
    })
    req.on("error", reject)
  })
}

function sendJson(res: ServerResponse, status: number, json: unknown) {
  res.statusCode = status
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify(json))
}
