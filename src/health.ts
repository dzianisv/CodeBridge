import type { RequestHandler } from "express"
import type { RunStore } from "./storage.js"

export function createHealthHandler(
  store: Pick<RunStore, "checkWritable">,
  loggerHealth: () => { degraded: boolean; code: string | null },
  extras?: () => Record<string, unknown>
): RequestHandler {
  return async (_req, res) => {
    const extra = extras?.() ?? {}
    try {
      await store.checkWritable()
    } catch {
      res.status(503).json({ status: "degraded", database: "unwritable", ...extra })
      return
    }

    if (loggerHealth().degraded) {
      res.status(503).json({ status: "degraded", logging: "unwritable", ...extra })
      return
    }

    res.status(200).json({ status: "ok", ...extra })
  }
}
