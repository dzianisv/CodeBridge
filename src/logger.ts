import pino from "pino"

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info"
})

let degraded = false
let code: string | null = null

function sanitizeCode(err: NodeJS.ErrnoException | undefined): string {
  const value = err && typeof err.code === "string" ? err.code : ""
  return /^[A-Z0-9_]{1,32}$/.test(value) ? value : "UNKNOWN"
}

function onStdoutError(err: NodeJS.ErrnoException): void {
  degraded = true
  code = sanitizeCode(err)
}

process.stdout.on("error", onStdoutError)

export function getLoggerHealth(): { degraded: boolean; code: string | null } {
  return { degraded, code }
}
