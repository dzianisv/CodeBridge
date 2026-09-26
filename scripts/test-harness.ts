import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { execFile } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer as createNetServer } from "node:net"
import { tmpdir } from "node:os"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import Database from "better-sqlite3"
import { createSqliteStore, type RunStore } from "../src/storage.js"
import { resolveLink } from "../src/session-links.js"
import { getSessionStatus } from "../src/opencode-session.js"
import {
  handleAssignmentEvent,
  handleCommentEvent,
  type HarnessCtx,
  type HarnessSessionFns
} from "../src/harness.js"
import type { AppConfig } from "../src/types.js"

// Real `opencode serve` for AC1–AC4 and AC8–AC9, same as scripts/test-opencode-session.ts.
// AC7 stubs createSession/appendTurn on HarnessCtx.sessions only. A real server
// outage is not a reliable way to fail one of two concurrent calls and leave
// the other healthy, so that one case injects the failure in-process.
// AC8/AC9 call handleAssignmentEvent with the payload github-poll.ts builds for
// a PR assignee: source github_pr, keys only the PR itself, plus body and branch.
// They do not pre-resolve Closes/branch keys; harness candidateKeys does that.

const execFileAsync = promisify(execFile)
const OPENCODE_BIN = process.env.OPENCODE_BIN ?? path.join(os.homedir(), ".opencode", "bin", "opencode")

const version = (await execFileAsync(OPENCODE_BIN, ["--version"])).stdout.trim()
console.log(`opencode version tested: ${version} (${OPENCODE_BIN})`)

const port = await freePort()
const baseUrl = `http://127.0.0.1:${port}`
const repoPath = await mkdtemp(path.join(os.tmpdir(), "codebridge-harness-"))
const stderr: Buffer[] = []
const child = spawn(OPENCODE_BIN, ["serve", "--port", String(port), "--hostname", "127.0.0.1", "--print-logs"], {
  detached: true,
  stdio: ["ignore", "pipe", "pipe"]
})
child.stderr?.on("data", chunk => {
  stderr.push(Buffer.from(chunk))
  if (stderr.length > 40) stderr.shift()
})
child.stdout?.on("data", chunk => {
  stderr.push(Buffer.from(chunk))
  if (stderr.length > 40) stderr.shift()
})

const tests: Array<[string, () => Promise<void>]> = [
  ["AC1: jira ticket assignment creates exactly one session_link row + one opencode session, share reply is returned", ac1],
  ["AC2: github PR assignment reuses an existing session_link row when the PR references an already-linked ticket", ac2],
  ["AC3/AC4: comment on either linked surface routes into the same session", ac34],
  ["AC7: a simulated Jira failure does not affect a concurrent GitHub-sourced event", ac7],
  ["AC8: PR assignee with a Closes #N body reuses the linked ticket's session", ac8],
  ["AC9: PR assignee with no linked reference gets a standalone github_pr session", ac9]
]

let failed = 0
try {
  await waitForServer(baseUrl, child)
  for (const [name, fn] of tests) {
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
  console.error(Buffer.concat(stderr).toString("utf8").slice(-4000))
  console.error(error)
} finally {
  await stopChild(child)
  await rm(repoPath, { recursive: true, force: true })
}

console.log(`\n${tests.length - failed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

async function ac1() {
  await withStore(async (store, dbPath) => {
    const tenantId = "ac1"
    const key = { kind: "jira" as const, issueKey: "AC1-1" }
    const result = await handleAssignmentEvent(ctxFor(store, tenantId), {
      source: "jira",
      tenantId,
      keys: [key],
      repoPath,
      title: "AC1-1: fix flaky CI"
    })
    assert.equal(countLinks(dbPath, tenantId), 1)
    const linked = await resolveLink(store, tenantId, [key])
    assert.equal(linked?.opencodeSessionId, result.sessionId)
    assert.equal(countKeys(dbPath, tenantId, "jira", "ac1-1"), 1)
    const status = await getSessionStatus(result.sessionId, { baseUrl, timeoutMs: 20_000 })
    assert.notEqual(status, "not_found")
    assert.ok(result.reply.length > 0)
    assert.ok(result.reply.includes(result.sessionId))
  })
}

async function ac2() {
  await withStore(async (store, dbPath) => {
    const tenantId = "ac2"
    const jiraKey = { kind: "jira" as const, issueKey: "AC2-1" }
    const prKey = { kind: "gh_pr" as const, repo: "acme/widget", number: 9 }
    const created = await handleAssignmentEvent(ctxFor(store, tenantId), {
      source: "jira",
      tenantId,
      keys: [jiraKey],
      repoPath,
      title: "AC2-1: linked ticket"
    })
    const again = await handleAssignmentEvent(ctxFor(store, tenantId), {
      source: "github_pr",
      tenantId,
      keys: [jiraKey, prKey],
      repoPath,
      title: "jira:AC2-1 referenced by PR",
      body: "Closes #9"
    })
    assert.equal(countLinks(dbPath, tenantId), 1)
    assert.equal(again.sessionId, created.sessionId)
    const linked = await resolveLink(store, tenantId, [prKey])
    assert.equal(linked?.opencodeSessionId, created.sessionId)
    assert.equal(linked?.id, (await resolveLink(store, tenantId, [jiraKey]))?.id)
  })
}

async function ac34() {
  await withStore(async store => {
    const tenantId = "ac34"
    const jiraKey = { kind: "jira" as const, issueKey: "AC34-1" }
    const prKey = { kind: "gh_pr" as const, repo: "acme/widget", number: 34 }
    const created = await handleAssignmentEvent(ctxFor(store, tenantId), {
      source: "jira",
      tenantId,
      keys: [jiraKey],
      repoPath,
      title: "AC34-1: comment routing"
    })
    await handleAssignmentEvent(ctxFor(store, tenantId), {
      source: "github_pr",
      tenantId,
      keys: [jiraKey, prKey],
      repoPath,
      title: "AC34 PR"
    })
    const prompt = "Reply with exactly the word pong and nothing else."
    const fromJira = await handleCommentEvent(ctxFor(store, tenantId), {
      source: "jira",
      tenantId,
      keys: [jiraKey],
      commentBody: prompt,
      authorIsBot: false,
      repoPath
    })
    const fromPr = await handleCommentEvent(ctxFor(store, tenantId), {
      source: "github_pr",
      tenantId,
      keys: [prKey],
      commentBody: prompt,
      authorIsBot: false,
      repoPath
    })
    assert.ok(fromJira)
    assert.ok(fromPr)
    assert.equal(fromJira.sessionId, fromPr.sessionId)
    assert.equal(fromJira.sessionId, created.sessionId)
    assert.equal((await resolveLink(store, tenantId, [jiraKey]))?.opencodeSessionId, fromJira.sessionId)
    assert.equal((await resolveLink(store, tenantId, [prKey]))?.opencodeSessionId, fromPr.sessionId)
  })
}

async function ac7() {
  await withStore(async (store, dbPath) => {
    const tenantId = "ac7"
    const jiraKey = { kind: "jira" as const, issueKey: "AC7-1" }
    const prKey = { kind: "gh_pr" as const, repo: "acme/widget", number: 70 }
    let jiraEntered = false
    let githubEntered = false
    let releaseJira: () => void = () => {}
    let releaseGithub: () => void = () => {}
    const jiraEnteredPromise = new Promise<void>(resolve => { releaseJira = resolve })
    const githubEnteredPromise = new Promise<void>(resolve => { releaseGithub = resolve })
    const sessions: HarnessSessionFns = {
      async createSession(params) {
        if (params.title.startsWith("jira-ac7")) {
          jiraEntered = true
          releaseJira()
          await githubEnteredPromise
          throw new Error("simulated jira opencode failure")
        }
        githubEntered = true
        releaseGithub()
        await jiraEnteredPromise
        return { sessionId: "gh-ac7", shareUrl: null }
      },
      async appendTurn() {
        throw new Error("appendTurn should not run in AC7")
      }
    }
    const ctx = ctxFor(store, tenantId, sessions)
    const settled = await Promise.race([
      Promise.allSettled([
        handleAssignmentEvent(ctx, {
          source: "jira",
          tenantId,
          keys: [jiraKey],
          repoPath,
          title: "jira-ac7 failure"
        }),
        handleAssignmentEvent(ctx, {
          source: "github_pr",
          tenantId,
          keys: [prKey],
          repoPath,
          title: "github-ac7 ok"
        })
      ]),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("AC7 concurrent calls did not overlap within 5s")), 5000)
      })
    ])
    assert.equal(jiraEntered, true)
    assert.equal(githubEntered, true)
    assert.equal(settled[0].status, "rejected")
    if (settled[0].status === "rejected") {
      assert.match(String(settled[0].reason), /simulated jira opencode failure/)
    }
    assert.equal(settled[1].status, "fulfilled")
    if (settled[1].status === "fulfilled") {
      assert.equal(settled[1].value.sessionId, "gh-ac7")
    }
    assert.equal(await resolveLink(store, tenantId, [jiraKey]), null)
    assert.equal(countKeys(dbPath, tenantId, "jira", "ac7-1"), 0)
    assert.equal(countOrphans(dbPath, tenantId), 0)
    assert.equal((await resolveLink(store, tenantId, [prKey]))?.opencodeSessionId, "gh-ac7")
    assert.equal(countLinks(dbPath, tenantId), 1)

    const retry = await handleAssignmentEvent(ctxFor(store, tenantId, {
      async createSession() {
        return { sessionId: "jira-ac7-retry", shareUrl: null }
      },
      async appendTurn() {
        return { reply: "unused" }
      }
    }), {
      source: "jira",
      tenantId,
      keys: [jiraKey],
      repoPath,
      title: "jira-ac7 retry"
    })
    assert.equal(retry.sessionId, "jira-ac7-retry")
    assert.equal(countLinks(dbPath, tenantId), 2)
    assert.equal(countKeys(dbPath, tenantId, "jira", "ac7-1"), 1)
    assert.equal((await resolveLink(store, tenantId, [jiraKey]))?.opencodeSessionId, "jira-ac7-retry")
    assert.equal((await resolveLink(store, tenantId, [prKey]))?.opencodeSessionId, "gh-ac7")
    assert.equal(countOrphans(dbPath, tenantId), 0)
  })
}

async function ac8() {
  await withStore(async (store, dbPath) => {
    const tenantId = "ac8"
    const repo = "acme/widget"
    const issueKey = { kind: "gh_issue" as const, repo, number: 81 }
    const prKey = { kind: "gh_pr" as const, repo, number: 810 }
    const created = await handleAssignmentEvent(ctxFor(store, tenantId), {
      source: "github_issue",
      tenantId,
      keys: [issueKey],
      repoPath,
      title: "AC8 issue 81"
    })
    // Same shape github-poll.ts sends: the PR key only. Closes #81 is in the body.
    const again = await handleAssignmentEvent(ctxFor(store, tenantId), {
      source: "github_pr",
      tenantId,
      keys: [prKey],
      repoPath,
      title: "AC8 PR assignee",
      body: "Closes #81",
      branch: "feature/no-jira-key"
    })
    assert.equal(countLinks(dbPath, tenantId), 1)
    assert.equal(again.sessionId, created.sessionId)
    const byPr = await resolveLink(store, tenantId, [prKey])
    const byIssue = await resolveLink(store, tenantId, [issueKey])
    assert.equal(byPr?.opencodeSessionId, created.sessionId)
    assert.equal(byPr?.id, byIssue?.id)
    assert.equal(countKeys(dbPath, tenantId, "gh_pr", "810"), 1)
    assert.equal(countKeys(dbPath, tenantId, "gh_issue", "81"), 1)
  })
}

async function ac9() {
  await withStore(async (store, dbPath) => {
    const tenantId = "ac9"
    const prKey = { kind: "gh_pr" as const, repo: "acme/widget", number: 90 }
    const result = await handleAssignmentEvent(ctxFor(store, tenantId), {
      source: "github_pr",
      tenantId,
      keys: [prKey],
      repoPath,
      title: "AC9 standalone PR",
      body: "See #123 for context. No closing keyword.",
      branch: "fix/123-foo"
    })
    assert.equal(countLinks(dbPath, tenantId), 1)
    assert.equal((await resolveLink(store, tenantId, [prKey]))?.opencodeSessionId, result.sessionId)
    assert.equal(countKeys(dbPath, tenantId, "gh_pr", "90"), 1)
    assert.equal(countKeys(dbPath, tenantId, "gh_issue", "123"), 0)
    assert.equal(countKeys(dbPath, tenantId, "jira", "123"), 0)
    const status = await getSessionStatus(result.sessionId, { baseUrl, timeoutMs: 20_000 })
    assert.notEqual(status, "not_found")
    assert.ok(result.reply.includes(result.sessionId))
  })
}

function ctxFor(store: RunStore, tenantId: string, sessions?: HarnessSessionFns): HarnessCtx {
  const config: AppConfig = {
    tenants: [{
      id: tenantId,
      name: tenantId,
      repos: [{ fullName: "acme/widget", path: repoPath }],
      harness: { mirrorReplies: "origin-only", reactivationWindowMinutes: 60 },
      jira: {
        baseUrl: "https://example.atlassian.net",
        projectKey: "AC",
        repo: "acme/widget",
        agentAccountId: "agent-account",
        pollIntervalSec: 30
      }
    }]
  }
  return {
    store,
    config,
    opencodeConfig: { baseUrl, timeoutMs: 120_000 },
    sessions
  }
}

function countLinks(dbPath: string, tenantId: string): number {
  return scalar(dbPath, "SELECT COUNT(*) AS n FROM session_link WHERE tenant_id = ?", [tenantId])
}

function countKeys(dbPath: string, tenantId: string, kind: string, value: string): number {
  return scalar(
    dbPath,
    "SELECT COUNT(*) AS n FROM session_link_key WHERE tenant_id = ? AND kind = ? AND value = ?",
    [tenantId, kind, value]
  )
}

function countOrphans(dbPath: string, tenantId: string): number {
  return scalar(
    dbPath,
    `SELECT COUNT(*) AS n FROM session_link_key k
     WHERE k.tenant_id = ?
       AND NOT EXISTS (SELECT 1 FROM session_link s WHERE s.id = k.link_id)`,
    [tenantId]
  )
}

function scalar(dbPath: string, sql: string, params: string[]): number {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const row = db.prepare(sql).get(...params) as { n: number }
    return row.n
  } finally {
    db.close()
  }
}

async function withStore(fn: (store: RunStore, dbPath: string) => Promise<void>) {
  const dir = mkdtempSync(path.join(tmpdir(), "codebridge-harness-db-"))
  const dbPath = path.join(dir, "store.db")
  const store = createSqliteStore(dbPath)
  await store.ensureSchema()
  try {
    await fn(store, dbPath)
  } finally {
    await store.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("failed to allocate a port"))
        return
      }
      const chosen = address.port
      server.close(() => resolve(chosen))
    })
    server.on("error", reject)
  })
}

async function waitForServer(url: string, proc: ChildProcess) {
  const deadline = Date.now() + 40_000
  let last = "not started"
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`opencode serve exited ${proc.exitCode} before ready: ${last}`)
    }
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
