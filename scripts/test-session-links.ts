import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import {
  SessionLinkPromoteError,
  SessionLinkResolveConflictError,
  createSqliteStore,
  type RunStore,
  type SessionLinkKeyInput
} from "../src/storage.js"
import {
  SessionLinkConflictError,
  SessionLinkPendingError,
  attachIdentifier,
  claimAndCreateLink,
  resolveLink
} from "../src/session-links.js"

async function main() {
  const tests: Array<[string, () => Promise<void>]> = [
    ["claim window is pending, not a missing link", claimWindow],
    ["createSession failure abandons the claim so a retry can proceed", createFailureAbandons],
    ["existing linked key is returned without a second session", existingLinkReturned],
    ["in-flight claim is pending and does not create a second session", inFlightClaimDoesNotCreate],
    ["AC5: duplicate opencode_session_id is rejected and not retried onto a second link", duplicateSessionId],
    ["AC5: attachIdentifier does not write opencode_session_id", attachDoesNotTouchSessionId],
    ["3.1: attachIdentifier names both links and leaves both rows", attachConflict],
    ["3.1: resolveLink across two links is a conflict and does not merge", resolveConflict],
    ["re-attaching the same key to the same link is idempotent", idempotentAttach]
  ]

  let failed = 0
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
  console.log(`\n${tests.length - failed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

async function claimWindow() {
  await withStore(async store => {
    const tenantId = "tenant-window"
    const key: SessionLinkKeyInput = { kind: "jira", issueKey: "WIN-1" }
    let sawPending = false
    const link = await claimAndCreateLink(store, tenantId, key, async () => {
      await assert.rejects(
        () => resolveLink(store, tenantId, [key]),
        (error: unknown) => {
          assert.ok(error instanceof SessionLinkPendingError)
          assert.ok(error.linkId)
          assert.ok(error.createdAt)
          sawPending = true
          return true
        }
      )
      assert.equal(await resolveLink(store, tenantId, [{ kind: "jira", issueKey: "MISSING-1" }]), null)
      return { sessionId: "oc-window" }
    })
    assert.equal(sawPending, true)
    assert.equal(link.opencodeSessionId, "oc-window")
    const resolved = await resolveLink(store, tenantId, [key])
    assert.equal(resolved?.id, link.id)
    assert.equal(resolved?.opencodeSessionId, "oc-window")
  })
}

async function createFailureAbandons() {
  await withStore(async store => {
    const tenantId = "tenant-fail"
    const key: SessionLinkKeyInput = { kind: "gh_issue", repo: "acme/widget", number: 3 }
    let calls = 0
    await assert.rejects(
      () => claimAndCreateLink(store, tenantId, key, async () => {
        calls += 1
        throw new Error("opencode down")
      }),
      (error: unknown) => error instanceof Error && error.message === "opencode down"
    )
    assert.equal(calls, 1)
    assert.equal(await resolveLink(store, tenantId, [key]), null)
    const link = await claimAndCreateLink(store, tenantId, key, async () => {
      calls += 1
      return { sessionId: "oc-retry" }
    })
    assert.equal(calls, 2)
    assert.equal(link.opencodeSessionId, "oc-retry")
    assert.equal((await resolveLink(store, tenantId, [key]))?.id, link.id)
  })
}

async function existingLinkReturned() {
  await withStore(async store => {
    const tenantId = "tenant-existing"
    const key: SessionLinkKeyInput = { kind: "gh_pr", repo: "acme/widget", number: 9 }
    const created = await claimAndCreateLink(store, tenantId, key, async () => ({ sessionId: "oc-existing" }))
    let calls = 0
    const again = await claimAndCreateLink(store, tenantId, key, async () => {
      calls += 1
      return { sessionId: "oc-should-not-run" }
    })
    assert.equal(calls, 0)
    assert.equal(again.id, created.id)
    assert.equal(again.opencodeSessionId, "oc-existing")
  })
}

async function inFlightClaimDoesNotCreate() {
  await withStore(async store => {
    const tenantId = "tenant-inflight"
    const key: SessionLinkKeyInput = { kind: "jira", issueKey: "FLY-1" }
    const linkId = randomUUID()
    await store.claimSessionLinkKey({ linkId, tenantId, key })
    let calls = 0
    await assert.rejects(
      () => claimAndCreateLink(store, tenantId, key, async () => {
        calls += 1
        return { sessionId: "oc-second" }
      }),
      (error: unknown) => error instanceof SessionLinkPendingError && error.linkId === linkId
    )
    assert.equal(calls, 0)
    const pending = await store.resolveSessionLink({ tenantId, keys: [key] })
    assert.equal(pending.state, "pending")
    if (pending.state === "pending") assert.equal(pending.linkId, linkId)
  })
}

async function duplicateSessionId() {
  await withStore(async store => {
    const tenantId = "tenant-ac5"
    const keyA: SessionLinkKeyInput = { kind: "jira", issueKey: "AC5-1" }
    const keyB: SessionLinkKeyInput = { kind: "gh_issue", repo: "acme/widget", number: 41 }
    const first = await claimAndCreateLink(store, tenantId, keyA, async () => ({ sessionId: "oc-shared" }))
    let createCalls = 0
    await assert.rejects(
      () => claimAndCreateLink(store, tenantId, keyB, async () => {
        createCalls += 1
        return { sessionId: "oc-shared" }
      }),
      (error: unknown) => {
        assert.ok(error instanceof SessionLinkPromoteError)
        const cause = (error as { cause?: { code?: string } }).cause
        assert.equal(cause?.code, "SQLITE_CONSTRAINT_UNIQUE")
        return true
      }
    )
    assert.equal(createCalls, 1)
    let retryCalls = 0
    await assert.rejects(
      () => claimAndCreateLink(store, tenantId, keyB, async () => {
        retryCalls += 1
        return { sessionId: "oc-shared" }
      }),
      (error: unknown) => error instanceof SessionLinkPendingError
    )
    assert.equal(retryCalls, 0, "retry must not call createSession and attach the same session id again")
    const resolvedA = await resolveLink(store, tenantId, [keyA])
    assert.equal(resolvedA?.id, first.id)
    assert.equal(resolvedA?.opencodeSessionId, "oc-shared")
    await assert.rejects(
      () => resolveLink(store, tenantId, [keyB]),
      (error: unknown) => error instanceof SessionLinkPendingError
    )
    const owners = await readSessionIds(store, tenantId)
    assert.deepEqual(owners, ["oc-shared"])
  })
}

async function attachDoesNotTouchSessionId() {
  await withStore(async store => {
    const tenantId = "tenant-attach-ac5"
    const key: SessionLinkKeyInput = { kind: "jira", issueKey: "AC5-2" }
    const link = await claimAndCreateLink(store, tenantId, key, async () => ({ sessionId: "oc-attach" }))
    await attachIdentifier(store, link.id, tenantId, { kind: "gh_pr", repo: "acme/widget", number: 7 })
    const resolved = await resolveLink(store, tenantId, [{ kind: "gh_pr", repo: "acme/widget", number: 7 }])
    assert.equal(resolved?.id, link.id)
    assert.equal(resolved?.opencodeSessionId, "oc-attach")
    const owners = await readSessionIds(store, tenantId)
    assert.deepEqual(owners, ["oc-attach"])
  })
}

async function attachConflict() {
  await withStore(async store => {
    const tenantId = "tenant-attach-conflict"
    const keyA: SessionLinkKeyInput = { kind: "jira", issueKey: "CONF-A" }
    const keyB: SessionLinkKeyInput = { kind: "gh_issue", repo: "acme/widget", number: 8 }
    const linkA = await claimAndCreateLink(store, tenantId, keyA, async () => ({ sessionId: "oc-a" }))
    const linkB = await claimAndCreateLink(store, tenantId, keyB, async () => ({ sessionId: "oc-b" }))
    const before = await snapshot(store, tenantId, keyA, keyB)
    await assert.rejects(
      () => attachIdentifier(store, linkA.id, tenantId, keyB),
      (error: unknown) => {
        assert.ok(error instanceof SessionLinkConflictError)
        assert.equal(error.linkId, linkA.id)
        assert.equal(error.existingLinkId, linkB.id)
        assert.ok(error.cause instanceof Error)
        return true
      }
    )
    const after = await snapshot(store, tenantId, keyA, keyB)
    assert.deepEqual(after, before)
    assert.equal(after.a?.opencodeSessionId, "oc-a")
    assert.equal(after.b?.opencodeSessionId, "oc-b")
    assert.notEqual(after.a?.id, after.b?.id)
  })
}

async function resolveConflict() {
  await withStore(async store => {
    const tenantId = "tenant-resolve-conflict"
    const keyA: SessionLinkKeyInput = { kind: "jira", issueKey: "CONF-1" }
    const keyB: SessionLinkKeyInput = { kind: "gh_pr", repo: "acme/widget", number: 12 }
    const linkA = await claimAndCreateLink(store, tenantId, keyA, async () => ({ sessionId: "oc-ra" }))
    const linkB = await claimAndCreateLink(store, tenantId, keyB, async () => ({ sessionId: "oc-rb" }))
    const before = await snapshot(store, tenantId, keyA, keyB)
    await assert.rejects(
      () => resolveLink(store, tenantId, [keyA, keyB]),
      (error: unknown) => {
        assert.ok(error instanceof SessionLinkResolveConflictError)
        assert.deepEqual(error.linkIds, [linkA.id, linkB.id].sort())
        return true
      }
    )
    const after = await snapshot(store, tenantId, keyA, keyB)
    assert.deepEqual(after, before)
  })
}

async function idempotentAttach() {
  await withStore(async store => {
    const tenantId = "tenant-idem"
    const key: SessionLinkKeyInput = { kind: "jira", issueKey: "IDEM-1" }
    const link = await claimAndCreateLink(store, tenantId, key, async () => ({ sessionId: "oc-idem" }))
    await attachIdentifier(store, link.id, tenantId, key)
    await attachIdentifier(store, link.id, tenantId, { kind: "gh_pr", repo: "acme/widget", number: 15 })
    await attachIdentifier(store, link.id, tenantId, { kind: "gh_pr", repo: "Acme/Widget", number: 15 })
    const resolved = await resolveLink(store, tenantId, [key])
    assert.equal(resolved?.id, link.id)
    assert.equal(resolved?.opencodeSessionId, "oc-idem")
  })
}

async function snapshot(store: RunStore, tenantId: string, keyA: SessionLinkKeyInput, keyB: SessionLinkKeyInput) {
  return {
    a: await resolveLink(store, tenantId, [keyA]),
    b: await resolveLink(store, tenantId, [keyB])
  }
}

async function readSessionIds(store: RunStore, tenantId: string): Promise<string[]> {
  const dbPath = (store as unknown as { __dbPath?: string }).__dbPath
  if (!dbPath) throw new Error("test store is missing __dbPath")
  const { default: Database } = await import("better-sqlite3")
  const raw = new Database(dbPath)
  try {
    const rows = raw.prepare(
      "SELECT opencode_session_id FROM session_link WHERE tenant_id = ? ORDER BY opencode_session_id"
    ).all(tenantId) as Array<{ opencode_session_id: string }>
    return rows.map(row => row.opencode_session_id)
  } finally {
    raw.close()
  }
}

async function withStore(fn: (store: RunStore & { __dbPath: string }) => Promise<void>) {
  const fixture = await openStore()
  try {
    await fn(fixture.store)
  } finally {
    await fixture.close()
  }
}

async function openStore(): Promise<{ store: RunStore & { __dbPath: string }; close(): Promise<void> }> {
  const dir = mkdtempSync(path.join(tmpdir(), "codebridge-session-links-"))
  const dbPath = path.join(dir, "store.db")
  const store = createSqliteStore(dbPath) as RunStore & { __dbPath: string }
  store.__dbPath = dbPath
  await store.ensureSchema()
  return {
    store,
    async close() {
      await store.close?.()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
