import { spawn, type ChildProcess } from "node:child_process"
import { execFile } from "node:child_process"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { once } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer as createNetServer } from "node:net"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import Database from "better-sqlite3"
import { execa } from "execa"
import { createSqliteStore, type RunStore } from "../src/storage.js"
import { attachIdentifier, resolveLink } from "../src/session-links.js"
import { getSessionStatus } from "../src/opencode-session.js"
import { createJiraPollLoop } from "../src/jira-poll.js"
import { startGitHubPolling, type GitHubPollEnv } from "../src/github-poll.js"
import { textToAdf } from "../src/jira-types.js"
import { loadConfig, loadEnv } from "../src/config.js"
import type { RunService } from "../src/run-service.js"
import type { AppConfig, RunRecord } from "../src/types.js"

// LLD §8 item 7. Drives the real poll loops, not handleAssignmentEvent /
// handleCommentEvent. Jira is a local fake (same shape as test-jira-poll.ts).
// GitHub is a real repo/PR. opencode serve is a real child process.
//
// The PR key is attached with attachIdentifier after the Jira assignment
// creates the session. That is the "linked PR" precondition, not the routing
// under test. pollAssignedPullRequests only sees PRs assigned to the bot, and
// the bot is not assignable in the protocol repo (docs/test-protocol.md).

const execFileAsync = promisify(execFile)
const OPENCODE_BIN = process.env.OPENCODE_BIN ?? path.join(os.homedir(), ".opencode", "bin", "opencode")
const AGENT = "712020:e2e-agent"
const HUMAN = "712020:e2e-human"
const EMAIL = "e2e@example.com"
const TOKEN = "e2e-token"

type CaseStatus = "pass" | "fail" | "blocked"
type CaseResult = { name: string; status: CaseStatus; details: string; url?: string }

type Args = {
  repo?: string
  timeoutSec: number
  pollSec: number
  keep: boolean
}

const args = parseArgs(process.argv.slice(2))
const stamp = Date.now()
const issueKey = `E2E-${stamp}`
const ghMarker = `harness-e2e-${stamp}-gh-comment`
const jiraMarker = `harness-e2e-${stamp}-jira-comment`
const results: CaseResult[] = []
const runs: Array<{ prompt: string; issueNumber?: number }> = []

const jiraRequests: Array<{ method?: string; url?: string }> = []
let jiraIssue = issuePayload({ comments: [] })

const jiraServer = createServer((req, res) => {
  void readBody(req).then(body => {
    jiraRequests.push({ method: req.method, url: req.url })
    if (req.method === "POST" && req.url?.startsWith("/rest/api/3/search/jql")) {
      sendJson(res, 200, { issues: [jiraIssue], isLast: true, nextPageToken: null })
      return
    }
    if (req.method === "GET" && req.url?.includes("/comment")) {
      const comments = jiraIssue.fields.comment.comments
      sendJson(res, 200, { comments, total: comments.length, startAt: 0, maxResults: 100 })
      return
    }
    sendJson(res, 404, { error: "not found", method: req.method, url: req.url, body })
  }).catch(error => {
    sendJson(res, 500, { error: error instanceof Error ? error.message : "jira fake failed" })
  })
})

let failed = 0
let opencode: ChildProcess | null = null
let stopGitHub: (() => void) | undefined
let repoPath = ""
let dbDir = ""
let dbPath = ""
let resolvedRepo = ""
const pr: { number?: number; url?: string; branch?: string } = {}

try {
  const version = (await execFileAsync(OPENCODE_BIN, ["--version"])).stdout.trim()
  console.log(`opencode version tested: ${version} (${OPENCODE_BIN})`)

  resolvedRepo = args.repo ?? process.env.CODEBRIDGE_TEST_REPO ?? ""
  if (!resolvedRepo.includes("/")) {
    throw new Error("Pass --repo owner/name or set CODEBRIDGE_TEST_REPO. No default repo is hardcoded.")
  }
  const repo = resolvedRepo

  const env = loadEnv()
  const loaded = await loadConfig(env.configPath)
  const appId = env.githubAppId ?? loaded.secrets?.githubAppId
  const privateKey = env.githubPrivateKey ?? loaded.secrets?.githubPrivateKey
  const installationId = loaded.tenants.find(tenant =>
    tenant.repos.some(item => item.fullName.toLowerCase() === repo.toLowerCase())
    || tenant.github?.repoAllowlist?.some(item => item.toLowerCase() === repo.toLowerCase())
  )?.github?.installationId
  if (!appId || !privateKey || !installationId) {
    results.push({
      name: "preconditions",
      status: "blocked",
      details: `Missing GitHub App id, private key, or installation id for ${repo}. config=${env.configPath}`
    })
    throw new Error("blocked")
  }

  jiraServer.listen(0, "127.0.0.1")
  await once(jiraServer, "listening")
  const address = jiraServer.address()
  if (!address || typeof address === "string") throw new Error("fake Jira did not bind")
  const jiraBaseUrl = `http://127.0.0.1:${address.port}`

  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  repoPath = await mkdtemp(path.join(os.tmpdir(), "codebridge-harness-e2e-"))
  opencode = spawn(OPENCODE_BIN, ["serve", "--port", String(port), "--hostname", "127.0.0.1", "--print-logs"], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  })
  await waitForServer(baseUrl, opencode)

  dbDir = mkdtempSync(path.join(os.tmpdir(), "codebridge-harness-e2e-db-"))
  dbPath = path.join(dbDir, "store.db")
  const store = createSqliteStore(dbPath)
  await store.ensureSchema()

  const config: AppConfig = {
    tenants: [{
      id: "e2e",
      name: "e2e",
      repos: [{ fullName: repo, path: repoPath }],
      github: {
        installationId,
        repoAllowlist: [repo],
        assignmentAssignees: []
      },
      jira: {
        baseUrl: jiraBaseUrl,
        projectKey: "E2E",
        repo,
        agentAccountId: AGENT,
        pollIntervalSec: 10
      },
      harness: { mirrorReplies: "origin-only", reactivationWindowMinutes: 60 }
    }]
  }
  const jiraLoop = createJiraPollLoop({
    config,
    store,
    env: { jiraEmail: EMAIL, jiraApiToken: TOKEN }
  })
  if (!jiraLoop) throw new Error("createJiraPollLoop returned null")

  await jiraLoop.tick()
  const linked = await resolveLink(store, "e2e", [{ kind: "jira", issueKey }])
  const linkCount = countRows(dbPath, "SELECT COUNT(*) AS n FROM session_link WHERE tenant_id = ?", ["e2e"])
  const postedOnTicket = jiraRequests.some(item => item.method === "POST" && item.url?.includes("/comment"))
  if (!linked || linkCount !== 1) {
    results.push({
      name: "jira-assignment-creates-session",
      status: "fail",
      details: `expected 1 session_link for ${issueKey}, got links=${linkCount} resolved=${linked?.opencodeSessionId ?? "none"} jiraRequests=${jiraRequests.length}`
    })
    throw new Error("jira assignment did not create a session")
  }
  const sessionId = linked.opencodeSessionId
  const status = await getSessionStatus(sessionId, { baseUrl, timeoutMs: 20_000 })
  if (status === "not_found") {
    results.push({
      name: "jira-assignment-creates-session",
      status: "fail",
      details: `session ${sessionId} was stored but opencode returned not_found`
    })
    throw new Error("session missing")
  }
  results.push({
    name: "jira-assignment-creates-session",
    status: postedOnTicket ? "pass" : "fail",
    details: postedOnTicket
      ? `one session ${sessionId} and a comment POST to the ticket`
      : `one session ${sessionId} created via jira-poll, but no comment was posted on the ticket (AC1 share/resume link)`
  })
  console.log(`${postedOnTicket ? "ok" : "not ok"} - jira-assignment-creates-session ${sessionId}`)

  const created = await createPullRequest(repo, issueKey)
  pr.number = created.number
  pr.url = created.url
  pr.branch = created.branch
  await attachIdentifier(store, linked.id, "e2e", { kind: "gh_pr", repo, number: created.number })
  const byPr = await resolveLink(store, "e2e", [{ kind: "gh_pr", repo, number: created.number }])
  if (byPr?.opencodeSessionId !== sessionId || countRows(dbPath, "SELECT COUNT(*) AS n FROM session_link WHERE tenant_id = ?", ["e2e"]) !== 1) {
    results.push({
      name: "github-pr-comment-same-session",
      status: "fail",
      details: "attaching the PR key did not resolve to the Jira session"
    })
    throw new Error("PR link precondition failed")
  }

  const pollEnv: GitHubPollEnv = {
    githubAppId: appId,
    githubPrivateKey: privateKey,
    githubPollIntervalSec: 10,
    githubPollBackfill: false
  }
  const runService: RunService = {
    async createRun(input) {
      runs.push({ prompt: input.prompt, issueNumber: input.github?.issueNumber })
      const now = new Date().toISOString()
      const record: RunRecord = {
        id: `e2e-run-${runs.length}`,
        tenantId: input.tenantId,
        repoFullName: input.repoFullName,
        repoPath: input.repoPath,
        sourceKey: input.sourceKey,
        status: "queued",
        prompt: input.prompt,
        createdAt: now,
        updatedAt: now,
        github: input.github
      }
      return record
    }
  }
  stopGitHub = startGitHubPolling({
    config,
    store,
    runService,
    harness: { store, config, opencodeConfig: { baseUrl, timeoutMs: 120_000 } },
    env: pollEnv
  })
  if (!stopGitHub) {
    results.push({
      name: "github-pr-comment-same-session",
      status: "blocked",
      details: "startGitHubPolling returned without starting (missing app credentials or interval)"
    })
    throw new Error("blocked")
  }

  const baseline = await waitForPollState(store, repo, args.timeoutSec)
  if (!baseline) {
    results.push({
      name: "github-pr-comment-same-session",
      status: "fail",
      details: `github-poll did not write a high-water mark for ${repo} within ${args.timeoutSec}s`
    })
    throw new Error("github poll did not start")
  }

  const commentUrl = await gh([
    "pr", "comment", String(created.number),
    "--repo", repo,
    "--body", ghMarker
  ])
  const commentId = await newestIssueCommentId(repo, created.number, ghMarker)
  const seen = await waitForCommentObserved(store, repo, commentId, baseline.lastCommentId, args.timeoutSec)
  const messagesAfterGh = await listMessages(baseUrl, sessionId, repoPath)
  const ghLanded = messagesAfterGh.includes(ghMarker)
  const routedToRunService = runs.some(run => run.issueNumber === created.number && run.prompt.includes(ghMarker))
  const linkCountAfterGh = countRows(dbPath, "SELECT COUNT(*) AS n FROM session_link WHERE tenant_id = ?", ["e2e"])
  const sameLink = (await resolveLink(store, "e2e", [{ kind: "gh_pr", repo, number: created.number }]))?.opencodeSessionId === sessionId
    && linkCountAfterGh === 1
  if (!seen) {
    results.push({
      name: "github-pr-comment-same-session",
      status: "fail",
      details: `github-poll high-water did not advance to comment ${commentId} on ${created.url}`,
      url: created.url
    })
  } else if (!ghLanded || !sameLink) {
    results.push({
      name: "github-pr-comment-same-session",
      status: "fail",
      details: `PR comment ${commentId} was observed by github-poll (lastCommentId advanced) but did not land in session ${sessionId}. messagesContainMarker=${ghLanded} sameLink=${sameLink} linkCount=${linkCountAfterGh} runServiceHits=${routedToRunService} url=${commentUrl}`,
      url: created.url
    })
  } else {
    results.push({
      name: "github-pr-comment-same-session",
      status: "pass",
      details: `comment ${commentId} landed in session ${sessionId}`,
      url: created.url
    })
  }
  console.log(`${ghLanded && sameLink ? "ok" : "not ok"} - github-pr-comment-same-session`)

  jiraIssue = issuePayload({
    comments: [comment("c-jira", new Date().toISOString(), HUMAN, jiraMarker)]
  })
  await jiraLoop.tick()
  const messagesAfterJira = await listMessages(baseUrl, sessionId, repoPath)
  const jiraLanded = messagesAfterJira.includes(jiraMarker)
  const linkCountAfterJira = countRows(dbPath, "SELECT COUNT(*) AS n FROM session_link WHERE tenant_id = ?", ["e2e"])
  const stillSame = (await resolveLink(store, "e2e", [{ kind: "jira", issueKey }]))?.opencodeSessionId === sessionId
    && linkCountAfterJira === 1
  results.push({
    name: "jira-comment-same-session",
    status: jiraLanded && stillSame ? "pass" : "fail",
    details: jiraLanded && stillSame
      ? `Jira comment landed in session ${sessionId}`
      : `Jira comment did not land in session ${sessionId}. messagesContainMarker=${jiraLanded} sameLink=${stillSame} linkCount=${linkCountAfterJira}`
  })
  console.log(`${jiraLanded && stillSame ? "ok" : "not ok"} - jira-comment-same-session`)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (message !== "blocked" && results.every(item => item.status !== "fail")) {
    results.push({ name: "runner", status: "fail", details: message })
  }
  if (message !== "blocked") console.error(message)
} finally {
  stopGitHub?.()
  if (opencode) await stopChild(opencode)
  jiraServer.close()
  if (!args.keep && pr.number && resolvedRepo) {
    await gh(["pr", "close", String(pr.number), "--repo", resolvedRepo, "--delete-branch"]).catch(() => undefined)
  }
  if (repoPath) await rm(repoPath, { recursive: true, force: true })
  if (dbDir) rmSync(dbDir, { recursive: true, force: true })
}

const summary = { issueKey, pr, results }
console.log(JSON.stringify(summary, null, 2))
failed = results.filter(item => item.status === "fail").length
if (failed > 0) process.exit(1)

function parseArgs(argv: string[]): Args {
  const parsed: Args = { timeoutSec: 45, pollSec: 2, keep: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1]
    if (arg === "--repo" && next) {
      parsed.repo = next
      i += 1
    } else if (arg === "--timeout" && next) {
      parsed.timeoutSec = Number(next)
      i += 1
    } else if (arg === "--poll" && next) {
      parsed.pollSec = Number(next)
      i += 1
    } else if (arg === "--keep") {
      parsed.keep = true
    }
  }
  return parsed
}

function issuePayload(input: { comments: ReturnType<typeof comment>[] }) {
  const now = new Date().toISOString()
  return {
    id: "9001",
    key: issueKey,
    fields: {
      summary: `${issueKey}: harness e2e`,
      updated: now,
      assignee: { accountId: AGENT },
      status: { name: "To Do", id: "1" },
      comment: {
        comments: input.comments,
        total: input.comments.length,
        startAt: 0,
        maxResults: Math.max(input.comments.length, 1)
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

async function createPullRequest(repo: string, key: string): Promise<{ number: number; url: string; branch: string }> {
  const base = (await gh(["api", `repos/${repo}`, "--jq", ".default_branch"])).trim()
  const baseSha = (await gh(["api", `repos/${repo}/git/ref/heads/${base}`, "--jq", ".object.sha"])).trim()
  const blob = (await gh([
    "api", "--method", "POST", `repos/${repo}/git/blobs`,
    "-f", `content=harness e2e ${key}`,
    "-f", "encoding=utf-8",
    "--jq", ".sha"
  ])).trim()
  const baseTree = (await gh(["api", `repos/${repo}/git/commits/${baseSha}`, "--jq", ".tree.sha"])).trim()
  const tree = JSON.parse(await gh([
    "api", "--method", "POST", `repos/${repo}/git/trees`,
    "--input", "-"
  ], JSON.stringify({
    base_tree: baseTree,
    tree: [{ path: `.e2e-${key}.txt`, mode: "100644", type: "blob", sha: blob }]
  }))) as { sha: string }
  const commit = JSON.parse(await gh([
    "api", "--method", "POST", `repos/${repo}/git/commits`,
    "--input", "-"
  ], JSON.stringify({
    message: `test: harness e2e ${key}`,
    tree: tree.sha,
    parents: [baseSha]
  }))) as { sha: string }
  const branch = `e2e/${key}-harness`
  await gh([
    "api", "--method", "POST", `repos/${repo}/git/refs`,
    "--input", "-"
  ], JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }))
  const pull = JSON.parse(await gh([
    "api", "--method", "POST", `repos/${repo}/pulls`,
    "--input", "-"
  ], JSON.stringify({
    title: `Harness E2E ${key}`,
    head: branch,
    base,
    body: `jira:${key}\n\nFixture for scripts/test-harness-e2e.ts. Safe to close.`
  }))) as { number: number; html_url: string }
  return { number: pull.number, url: pull.html_url, branch }
}

async function newestIssueCommentId(repo: string, number: number, marker: string): Promise<number> {
  const raw = await gh(["api", `repos/${repo}/issues/${number}/comments?per_page=100`])
  const comments = JSON.parse(raw) as Array<{ id: number; body?: string }>
  const match = comments.find(item => item.body?.includes(marker))
  if (!match) throw new Error(`posted comment ${marker} was not readable on ${repo}#${number}`)
  return match.id
}

async function waitForPollState(store: RunStore, repo: string, timeoutSec: number) {
  const deadline = Date.now() + timeoutSec * 1000
  while (Date.now() < deadline) {
    const state = await store.getGithubPollState("e2e", repo)
    if (state) return state
    await delay(args.pollSec * 1000)
  }
  return null
}

async function waitForCommentObserved(
  store: RunStore,
  repo: string,
  commentId: number,
  previousId: number | null,
  timeoutSec: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutSec * 1000
  while (Date.now() < deadline) {
    const state = await store.getGithubPollState("e2e", repo)
    if (state?.lastCommentId != null && state.lastCommentId >= commentId && state.lastCommentId !== previousId) {
      return true
    }
    await delay(args.pollSec * 1000)
  }
  return false
}

async function listMessages(baseUrl: string, sessionId: string, directory: string): Promise<string> {
  const url = new URL(`/session/${encodeURIComponent(sessionId)}/message`, baseUrl)
  url.searchParams.set("directory", directory)
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  if (!response.ok) {
    throw new Error(`GET session messages failed (${response.status})`)
  }
  return await response.text()
}

function countRows(file: string, sql: string, params: string[]): number {
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    const row = db.prepare(sql).get(...params) as { n: number }
    return row.n
  } finally {
    db.close()
  }
}

async function gh(ghArgs: string[], input?: string): Promise<string> {
  const result = await execa("gh", ghArgs, { input, stdio: ["pipe", "pipe", "pipe"] })
  return result.stdout.trim()
}

function readBody(req: IncomingMessage): Promise<unknown> {
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

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.listen(0, "127.0.0.1", () => {
      const bound = server.address()
      if (!bound || typeof bound === "string") {
        reject(new Error("failed to allocate a port"))
        return
      }
      const chosen = bound.port
      server.close(() => resolve(chosen))
    })
    server.on("error", reject)
  })
}

async function waitForServer(url: string, proc: ChildProcess) {
  const deadline = Date.now() + 40_000
  let last = "not started"
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`opencode serve exited ${proc.exitCode}: ${last}`)
    try {
      const response = await fetch(`${url}/session/status`, { signal: AbortSignal.timeout(20_000) })
      if (response.ok) return
      last = `HTTP ${response.status}`
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    await delay(200)
  }
  throw new Error(`opencode serve did not become ready: ${last}`)
}

async function stopChild(proc: ChildProcess) {
  if (!proc.pid || proc.exitCode !== null) return
  try {
    process.kill(-proc.pid, "SIGTERM")
  } catch {
    proc.kill("SIGTERM")
  }
  await Promise.race([
    new Promise<void>(resolve => proc.once("exit", () => resolve())),
    delay(2000)
  ])
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
