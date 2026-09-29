import type { EventEmitter } from "node:events"
import pino from "pino"

// Pino v9 does not write through process.stdout. It opens a distinct SonicBoom
// on fd 1 and only swallows EPIPE. ENOSPC on that stream is re-emitted and
// kills the process unless we handle it here.
const destination = pino.destination({ fd: 1, sync: false })

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? "info"
  },
  destination
)

let degraded = false
let code: string | null = null

function sanitizeCode(err: NodeJS.ErrnoException | undefined): string {
  const value = err && typeof err.code === "string" ? err.code : ""
  return /^[A-Z0-9_]{1,32}$/.test(value) ? value : "UNKNOWN"
}

function onOutputError(err: NodeJS.ErrnoException): void {
  degraded = true
  code = sanitizeCode(err)
}

destination.on("error", onOutputError)
// Direct writes can still surface the same class of error on stdout itself.
process.stdout.on("error", onOutputError)

export interface LogDestination extends EventEmitter {
  fd: number
  write(chunk: string): boolean
}

/** Production stream passed to Pino. Tests inject write errors on this object. */
export function getLogDestination(): LogDestination {
  return destination as unknown as LogDestination
}

export function getLoggerHealth(): { degraded: boolean; code: string | null } {
  return { degraded, code }
}
