import http from "node:http"
import type { AddressInfo } from "node:net"
import express from "express"
import { createHealthHandler } from "../src/health.js"
import { getLoggerHealth, logger } from "../src/logger.js"
import { createSqliteStore, type RunStore } from "../src/storage.js"

type JsonBody = { status?: string; database?: string; logging?: string }

const cases: string[] = []

function pass(name: string): void {
  cases.push(name)
}

function fail(name: string, detail: string): never {
  throw new Error(`${name}: ${detail}`)
}

function listen(app: express.Express): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1")
    server.once("error", reject)
    server.once("listening", () => resolve(server))
  })
}

function portOf(server: http.Server): number {
  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("health server did not bind a TCP port on 127.0.0.1")
  }
  return (address as AddressInfo).port
}

function getHealth(port: number, path: string): Promise<{ statusCode: number; body: JsonBody }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method: "GET" },
      res => {
        const chunks: Buffer[] = []
        res.on("data", chunk => chunks.push(chunk))
        res.on("error", reject)
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8")
          let body: JsonBody = {}
          try {
            body = raw ? (JSON.parse(raw) as JsonBody) : {}
          } catch (error) {
            reject(new Error(`non-JSON health body from ${path}: ${raw} (${String(error)})`))
            return
          }
          resolve({ statusCode: res.statusCode ?? 0, body })
        })
      }
    )
    req.on("error", reject)
    req.end()
  })
}

async function closeStore(store: RunStore | undefined): Promise<void> {
  if (!store?.close) return
  try {
    await store.close()
  } catch {
    // Closing the DB is the real checkWritable failure; a second close is fine.
  }
}

function closeServer(server: http.Server | undefined): Promise<void> {
  if (!server) return Promise.resolve()
  return new Promise(resolve => {
    server.close(() => resolve())
  })
}

async function main(): Promise<void> {
  const databaseStore = createSqliteStore(":memory:")
  const loggingStore = createSqliteStore(":memory:")
  let server: http.Server | undefined

  try {
    await databaseStore.checkWritable()
    await loggingStore.checkWritable()
    if (getLoggerHealth().degraded) {
      fail("setup", "logger already degraded before ENOSPC; refusing to run a contaminated process")
    }

    const app = express()
    app.get("/health", createHealthHandler(databaseStore, getLoggerHealth))
    app.get("/health-logging", createHealthHandler(loggingStore, getLoggerHealth))
    server = await listen(app)
    const port = portOf(server)
    if (port <= 0) fail("setup", `ephemeral port invalid: ${port}`)

    const healthy = await getHealth(port, "/health")
    if (healthy.statusCode !== 200 || healthy.body.status !== "ok") {
      fail("healthy-200", `expected 200 {status:ok}, got ${healthy.statusCode} ${JSON.stringify(healthy.body)}`)
    }
    const healthyLogging = await getHealth(port, "/health-logging")
    if (healthyLogging.statusCode !== 200 || healthyLogging.body.status !== "ok") {
      fail("healthy-200", `separate store was not healthy: ${healthyLogging.statusCode} ${JSON.stringify(healthyLogging.body)}`)
    }
    pass("healthy-200")

    await databaseStore.close?.()
    const unwritable = await getHealth(port, "/health")
    if (unwritable.statusCode !== 503 || unwritable.body.database !== "unwritable" || unwritable.body.status !== "degraded") {
      fail(
        "database-unwritable-503",
        `expected 503 database unwritable, got ${unwritable.statusCode} ${JSON.stringify(unwritable.body)}`
      )
    }
    const stillUp = await getHealth(port, "/health-logging")
    if (stillUp.statusCode !== 200 || stillUp.body.status !== "ok") {
      fail(
        "database-unwritable-503",
        `server stopped responding after DB close: ${stillUp.statusCode} ${JSON.stringify(stillUp.body)}`
      )
    }
    pass("database-unwritable-503")

    const enospc = Object.assign(new Error("ENOSPC: no space left on device"), {
      code: "ENOSPC",
      errno: -28,
      syscall: "write"
    })
    process.stdout.emit("error", enospc)
    // Same shape as github-poll catch logging: logger.error(error, message).
    try {
      logger.error(new Error("probe"), "poll failure after ENOSPC")
    } catch (error) {
      fail(
        "logging-unwritable-503",
        `logger.error threw synchronously after ENOSPC: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    if (!getLoggerHealth().degraded || getLoggerHealth().code !== "ENOSPC") {
      fail("logging-unwritable-503", `stdout ENOSPC did not degrade logger: ${JSON.stringify(getLoggerHealth())}`)
    }

    const logging = await getHealth(port, "/health-logging")
    if (logging.statusCode !== 503 || logging.body.logging !== "unwritable" || logging.body.status !== "degraded") {
      fail(
        "logging-unwritable-503",
        `expected 503 logging unwritable from healthy store, got ${logging.statusCode} ${JSON.stringify(logging.body)}`
      )
    }
    if (logging.body.database) {
      fail("logging-unwritable-503", `healthy store was reported unwritable: ${JSON.stringify(logging.body)}`)
    }
    pass("logging-unwritable-503")

    if (!process.pid || process.exitCode) {
      fail("process-alive-route-responds", `process not alive after ENOSPC (pid=${process.pid} exitCode=${process.exitCode})`)
    }
    const after = await getHealth(port, "/health-logging")
    if (after.statusCode !== 503 || after.body.logging !== "unwritable") {
      fail("process-alive-route-responds", `route did not respond after ENOSPC: ${after.statusCode} ${JSON.stringify(after.body)}`)
    }
    pass("process-alive-route-responds")

    console.log(`RESULT: PASS cases=${cases.length} passed=${cases.length} failed=0`)
  } finally {
    await closeStore(databaseStore)
    await closeStore(loggingStore)
    await closeServer(server)
  }
}

main().catch(error => {
  const passed = cases.length
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  console.log(`RESULT: FAIL cases=${passed + 1} passed=${passed} failed=1`)
  process.exitCode = 1
})
