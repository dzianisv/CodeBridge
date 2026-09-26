import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer as createNetServer } from "node:net"
import os from "node:os"
import path from "node:path"
import { once } from "node:events"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  OpencodeUnreachableError,
  appendTurn,
  createSession,
  getSessionStatus
} from "../src/opencode-session.ts"

// Integration test against a real `opencode serve` child process.
// CI must install opencode first (official installer) or set OPENCODE_BIN.
// Default binary: ~/.opencode/bin/opencode. Do not mock the session API.

const execFileAsync = promisify(execFile)
const OPENCODE_BIN = process.env.OPENCODE_BIN ?? path.join(os.homedir(), ".opencode", "bin", "opencode")

const version = (await execFileAsync(OPENCODE_BIN, ["--version"])).stdout.trim()
console.log(`opencode version tested: ${version} (${OPENCODE_BIN})`)

const port = await freePort()
const baseUrl = `http://127.0.0.1:${port}`
const repoPath = await mkdtemp(path.join(os.tmpdir(), "codebridge-opencode-"))
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

try {
  await waitForServer(baseUrl, child)
  const config = { baseUrl, timeoutMs: 120_000 }

  const created = await createSession({ repoPath, title: "codebridge session probe" }, config)
  assert.equal(typeof created.sessionId, "string")
  assert.ok(created.sessionId.length > 0)
  assert.equal(created.shareUrl, null, "shareUrl must be null when shareBaseUrl is unset")

  const raw = await fetch(`${baseUrl}/session/${encodeURIComponent(created.sessionId)}`)
  assert.equal(raw.status, 200)
  const rawBody = await raw.json() as { id: string; title: string; directory: string; version?: string; share?: unknown }
  assert.equal(rawBody.id, created.sessionId)
  assert.equal(rawBody.title, "codebridge session probe")
  assert.equal(rawBody.share, undefined)
  assert.ok(rawBody.directory.endsWith(path.basename(repoPath)), `directory ${rawBody.directory} should include ${repoPath}`)
  console.log(`session version field: ${rawBody.version ?? "(absent)"}`)

  const idle = await getSessionStatus(created.sessionId, config)
  assert.equal(idle, "idle")

  const missing = await getSessionStatus("ses_codebridge_missing_session", config)
  assert.equal(missing, "not_found")

  // v1.18.32 kept GET /session/status as {} for the whole synchronous
  // /message turn and for prompt_async (probed 2026-09-25). busy/retry is still
  // mapped to running, but this server did not emit it, so do not require it.
  const turn = await appendTurn(created.sessionId, "Reply with exactly the word pong and nothing else.", config)
  assert.equal(typeof turn.reply, "string")
  assert.match(turn.reply, /pong/i)

  const after = await getSessionStatus(created.sessionId, config)
  assert.equal(after, "idle")

  const shared = await createSession(
    { repoPath, title: "codebridge share probe" },
    { ...config, shareBaseUrl: "https://opncd.ai" }
  )
  assert.equal(typeof shared.shareUrl, "string")
  assert.match(shared.shareUrl ?? "", /^https?:\/\//)

  await assert.rejects(
    () => createSession({ repoPath, title: "down" }, { baseUrl: "http://127.0.0.1:1", timeoutMs: 2000 }),
    (error: unknown) => {
      assert.ok(error instanceof OpencodeUnreachableError)
      assert.equal(error.name, "OpencodeUnreachableError")
      assert.equal(error.kind, "network")
      return true
    }
  )

  await assertMalformedJsonIsTyped()

  console.log("test:opencode-session passed")
} catch (error) {
  const log = Buffer.concat(stderr).toString("utf8").slice(-4000)
  console.error(log)
  throw error
} finally {
  await stopChild(child)
  await rm(repoPath, { recursive: true, force: true })
}

async function assertMalformedJsonIsTyped() {
  const server = createServer((_req, res) => {
    res.statusCode = 200
    res.setHeader("content-type", "application/json")
    res.end("not-json")
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("failed to bind malformed-json server")
  try {
    await assert.rejects(
      () => createSession(
        { repoPath: "/tmp", title: "bad json" },
        { baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 2000 }
      ),
      (error: unknown) => {
        assert.ok(error instanceof OpencodeUnreachableError)
        assert.equal(error.kind, "parse")
        assert.ok(error.cause instanceof SyntaxError)
        return true
      }
    )
  } finally {
    server.close()
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

async function waitForServer(url: string, child: ChildProcess) {
  const deadline = Date.now() + 40_000
  let last = "not started"
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`opencode serve exited ${child.exitCode} before ready: ${last}`)
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

async function stopChild(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return
  try {
    process.kill(-child.pid, "SIGTERM")
  } catch {
    child.kill("SIGTERM")
  }
  const exited = new Promise<void>(resolve => {
    child.once("exit", () => resolve())
  })
  await Promise.race([exited, delay(2000)])
  if (child.exitCode === null && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {
      child.kill("SIGKILL")
    }
  }
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
