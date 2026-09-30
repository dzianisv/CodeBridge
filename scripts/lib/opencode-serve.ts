import { spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"

const LOG_LIMIT = 8_000

export type OpencodeServeHandle = {
  proc: ChildProcess
  port: number
  baseUrl: string
  recentLogs: () => string
  stop: () => Promise<void>
}

export function redact(text: string): string {
  return text
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?token|password|private[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
}

export async function startOpencodeServe(options: {
  bin: string
  hostname?: string
  readyTimeoutMs?: number
}): Promise<OpencodeServeHandle> {
  const hostname = options.hostname ?? "127.0.0.1"
  const port = await freePort()
  const baseUrl = `http://${hostname}:${port}`
  const logs = createLogBuffer()
  let spawnError: Error | null = null
  const proc = spawn(options.bin, ["serve", "--port", String(port), "--hostname", hostname, "--print-logs"], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  })
  proc.on("error", error => {
    spawnError = error
  })
  const onChunk = (chunk: Buffer | string) => {
    logs.push(redact(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)))
  }
  proc.stdout?.on("data", onChunk)
  proc.stderr?.on("data", onChunk)
  try {
    await waitForServer(baseUrl, proc, options.readyTimeoutMs ?? 40_000, () => spawnError)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    let stopMessage = ""
    try {
      await stopChild(proc)
    } catch (stopError) {
      stopMessage = stopError instanceof Error ? stopError.message : String(stopError)
    }
    // Do not attach child logs. Bounded redaction cannot prove they are secret-free.
    throw new Error(stopMessage ? `${message}; ${stopMessage}` : message)
  }
  return {
    proc,
    port,
    baseUrl,
    recentLogs: () => logs.text(),
    stop: () => stopChild(proc)
  }
}

function createLogBuffer(): { push: (text: string) => void; text: () => string } {
  let retained = ""
  return {
    push(text: string) {
      retained = (retained + text).slice(-LOG_LIMIT)
    },
    text() {
      return retained
    }
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
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

async function waitForServer(
  url: string,
  proc: ChildProcess,
  timeoutMs: number,
  spawnError: () => Error | null
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = "not started"
  let exitHow = describeExit(proc)
  const onExit = (code: number | null, signalName: NodeJS.Signals | null) => {
    exitHow = signalName ? `signal ${signalName}` : String(code)
  }
  proc.on("exit", onExit)
  try {
    while (Date.now() < deadline) {
      const failed = spawnError()
      if (failed) throw new Error(`opencode serve failed to start: ${failed.message}`)
      const stopped = exitHow ?? describeExit(proc)
      if (stopped) throw new Error(`opencode serve exited ${stopped}: ${last}`)
      try {
        const response = await fetchStatus(proc, `${url}/session/status`)
        if (response.ok) return
        last = `HTTP ${response.status}`
      } catch (error) {
        const stoppedAfter = exitHow ?? describeExit(proc)
        if (stoppedAfter) throw new Error(`opencode serve exited ${stoppedAfter}: ${last}`)
        last = error instanceof Error ? error.message : String(error)
      }
      await delay(200)
    }
  } finally {
    proc.off("exit", onExit)
  }
  const stopped = exitHow ?? describeExit(proc)
  if (stopped) throw new Error(`opencode serve exited ${stopped}: ${last}`)
  throw new Error(`opencode serve did not become ready: ${last}`)
}

async function fetchStatus(proc: ChildProcess, url: string): Promise<Response> {
  const exitAbort = new AbortController()
  const abortOnExit = () => exitAbort.abort()
  if (isStopped(proc)) exitAbort.abort()
  proc.on("exit", abortOnExit)
  try {
    // Per-attempt cap stays 20s. Exit abort only stops attributing a dead process to that timeout.
    return await fetch(url, {
      signal: AbortSignal.any([AbortSignal.timeout(20_000), exitAbort.signal])
    })
  } finally {
    proc.off("exit", abortOnExit)
  }
}

async function stopChild(proc: ChildProcess): Promise<void> {
  const problems: string[] = []
  try {
    if (!isStopped(proc) && proc.pid) {
      signal(proc, "SIGTERM", problems)
      let stopped = await waitForExit(proc, 2000)
      if (!stopped) {
        signal(proc, "SIGKILL", problems)
        stopped = await waitForExit(proc, 2000)
      }
      if (!stopped) problems.push("process still running after SIGKILL")
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
  }
  destroyStream(proc.stdout, problems)
  destroyStream(proc.stderr, problems)
  if (problems.length > 0) throw new Error(`opencode serve stop failed: ${problems.join("; ")}`)
}

// exitCode stays null when Node reaps a signal death. signalCode and the exit event are the stopped bits.
function isStopped(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null
}

function describeExit(proc: ChildProcess): string | null {
  if (proc.signalCode) return `signal ${proc.signalCode}`
  if (proc.exitCode !== null) return String(proc.exitCode)
  return null
}

function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (isStopped(proc)) return Promise.resolve(true)
  return new Promise(resolve => {
    let settled = false
    const finish = (stopped: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      proc.off("exit", onExit)
      resolve(stopped || isStopped(proc))
    }
    const onExit = () => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    proc.on("exit", onExit)
    if (isStopped(proc)) finish(true)
  })
}

function signal(proc: ChildProcess, signalName: NodeJS.Signals, problems: string[]): void {
  if (!proc.pid) return
  try {
    process.kill(-proc.pid, signalName)
    return
  } catch (groupError) {
    if (!isMissing(groupError)) {
      // Group signal failed for a reason other than "already gone". Still try the child pid.
    }
  }
  try {
    proc.kill(signalName)
  } catch (error) {
    if (!isMissing(error)) problems.push(error instanceof Error ? error.message : String(error))
  }
}

function destroyStream(stream: ChildProcess["stdout"], problems: string[]): void {
  try {
    stream?.destroy()
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ESRCH"
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
