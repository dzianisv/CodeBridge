import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import Database from "better-sqlite3"
import pg from "pg"
import {
  SESSION_LINK_ORPHAN_TIMEOUT_MS,
  SessionLinkClaimConflictError,
  SessionLinkPromoteError,
  SessionLinkResolveConflictError,
  createPostgresStore,
  createSqliteStore,
  type RunStore,
  type SessionLinkKeyInput
} from "../src/storage.js"

const scriptPath = fileURLToPath(import.meta.url)

type KeyRow = {
  repo: string | null
  repo_key: string
  value: string
  link_id: string
}

type Probe = {
  store: RunStore
  backdate(linkId: string, iso: string): Promise<void>
  countKeys(tenantId: string, kind: string, repoKey: string, value: string): Promise<number>
  readKey(tenantId: string, kind: string, repoKey: string, value: string): Promise<KeyRow | null>
  rawInsert(row: {
    linkId: string
    kind: string
    repo: string | null
    repoKey: string
    value: string
    tenantId: string
  }): Promise<void>
  close(): Promise<void>
}

if (process.argv[2] === "--claim-worker") {
  const [, , , dbPath, tenantId, linkId, kind, repo, value] = process.argv
  const store = createSqliteStore(dbPath)
  const key = workerKey(kind, repo, value)
  store.claimSessionLinkKey({ linkId, tenantId, key }).then(
    async () => {
      await store.close?.()
      process.exit(0)
    },
    async (error: unknown) => {
      await store.close?.()
      if (error instanceof SessionLinkClaimConflictError) process.exit(2)
      console.error(error)
      process.exit(1)
    }
  )
} else {
  main().catch(error => {
    console.error(error)
    process.exit(1)
  })
}

function workerKey(kind: string, repo: string, value: string): SessionLinkKeyInput {
  if (kind === "jira") return { kind: "jira", issueKey: value }
  if (kind === "gh_issue" || kind === "gh_pr") {
    return { kind, repo, number: Number(value) }
  }
  throw new Error(`bad worker kind ${kind}`)
}

async function main() {
  const tests: Array<[string, () => Promise<void>]> = [
    ["sqlite: two concurrent jira claims fail-fast", () => sqliteRace("jira")],
    ["sqlite: two concurrent github issue claims fail-fast", () => sqliteRace("gh_issue")],
    ["sqlite: two concurrent github pr claims fail-fast", () => sqliteRace("gh_pr")],
    ["sqlite: jira and github claims for different keys both succeed", () => withSqlite(differentKeys)],
    ["sqlite: CHECK rejects a mismatched repo_key", () => withSqlite(checkConstraint)],
    ["sqlite: repo_key is derived and case-folded", () => withSqlite(derivedRepoKey)],
    ["sqlite: orphan claim is reclaimed after the timeout", () => withSqlite(orphanReclaim)],
    ["sqlite: a promoted link is not reclaimed", () => withSqlite(liveLinkNotReclaimed)],
    ["sqlite: abandon deletes a fresh unpromoted claim only", () => withSqlite(abandonFreshClaim)],
    ["sqlite: abandon does not delete a promoted link", () => withSqlite(abandonPromoted)],
    ["sqlite: resolve conflict and promote", () => withSqlite(resolveAndPromote)],
    ["sqlite: jira poll cursor upserts", () => withSqlite(jiraCursor)],
    ["postgres: two concurrent jira claims fail-fast", () => postgresRace("jira")],
    ["postgres: two concurrent github issue claims fail-fast", () => postgresRace("gh_issue")],
    ["postgres: two concurrent github pr claims fail-fast", () => postgresRace("gh_pr")],
    ["postgres: jira and github claims for different keys both succeed", () => withPostgres(differentKeys)],
    ["postgres: CHECK rejects a mismatched repo_key", () => withPostgres(checkConstraint)],
    ["postgres: repo_key is derived and case-folded", () => withPostgres(derivedRepoKey)],
    ["postgres: orphan claim is reclaimed after the timeout", () => withPostgres(orphanReclaim)],
    ["postgres: a promoted link is not reclaimed", () => withPostgres(liveLinkNotReclaimed)],
    ["postgres: abandon deletes a fresh unpromoted claim only", () => withPostgres(abandonFreshClaim)],
    ["postgres: abandon does not delete a promoted link", () => withPostgres(abandonPromoted)],
    ["postgres: resolve conflict and promote", () => withPostgres(resolveAndPromote)],
    ["postgres: jira poll cursor upserts", () => withPostgres(jiraCursor)]
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

async function sqliteRace(kind: "jira" | "gh_issue" | "gh_pr") {
  const dir = mkdtempSync(path.join(tmpdir(), "codebridge-sl-"))
  const dbPath = path.join(dir, "race.db")
  const store = createSqliteStore(dbPath)
  await store.ensureSchema()
  await store.close?.()
  const tenantId = `t-${kind}`
  const key = raceKey(kind)
  const first = randomUUID()
  const second = randomUUID()
  const results = await Promise.all([
    claimWorker(dbPath, tenantId, first, key),
    claimWorker(dbPath, tenantId, second, key)
  ])
  const codes = results.map(result => result.code).sort()
  assert.deepEqual(codes, [0, 2], `expected one success and one conflict, got ${JSON.stringify(results)}`)
  const raw = new Database(dbPath)
  const rows = raw.prepare(
    "SELECT link_id FROM session_link_key WHERE tenant_id = ? AND kind = ?"
  ).all(tenantId, kind) as Array<{ link_id: string }>
  raw.close()
  assert.equal(rows.length, 1)
  assert.ok(rows[0].link_id === first || rows[0].link_id === second)
  rmSync(dir, { recursive: true, force: true })
}

function raceKey(kind: "jira" | "gh_issue" | "gh_pr"): SessionLinkKeyInput {
  if (kind === "jira") return { kind: "jira", issueKey: "PROJ-1" }
  if (kind === "gh_issue") return { kind: "gh_issue", repo: "Owner/Repo", number: 41 }
  return { kind: "gh_pr", repo: "Owner/Repo", number: 41 }
}

function claimWorker(dbPath: string, tenantId: string, linkId: string, key: SessionLinkKeyInput) {
  const repo = key.kind === "jira" ? "-" : key.repo
  const value = key.kind === "jira" ? key.issueKey : String(key.number)
  return runWorker([
    "--claim-worker",
    dbPath,
    tenantId,
    linkId,
    key.kind,
    repo,
    value
  ])
}

function runWorker(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(process.cwd(), "node_modules/tsx/dist/cli.mjs"),
      scriptPath,
      ...args
    ], { cwd: process.cwd() })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`claim worker timed out\n${stderr}`))
    }, 15000)
    child.stdout.on("data", chunk => {
      stdout += String(chunk)
    })
    child.stderr.on("data", chunk => {
      stderr += String(chunk)
    })
    child.on("error", error => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("exit", code => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

async function differentKeys(probe: Probe) {
  await probe.store.ensureSchema()
  await probe.store.ensureSchema()
    const tenantId = "tenant-different"
    const jira = await probe.store.claimSessionLinkKey({
      linkId: randomUUID(),
      tenantId,
      key: { kind: "jira", issueKey: "PROJ-7" }
    })
    const issue = await probe.store.claimSessionLinkKey({
      linkId: randomUUID(),
      tenantId,
      key: { kind: "gh_issue", repo: "acme/widget", number: 7 }
    })
    const pr = await probe.store.claimSessionLinkKey({
      linkId: randomUUID(),
      tenantId,
      key: { kind: "gh_pr", repo: "acme/widget", number: 7 }
    })
    assert.notEqual(jira.linkId, issue.linkId)
    assert.notEqual(issue.linkId, pr.linkId)
    assert.equal(await probe.countKeys(tenantId, "jira", "", "proj-7"), 1)
    assert.equal(await probe.countKeys(tenantId, "gh_issue", "acme/widget", "7"), 1)
    assert.equal(await probe.countKeys(tenantId, "gh_pr", "acme/widget", "7"), 1)
}

async function checkConstraint(probe: Probe) {
  await probe.store.ensureSchema()
    await assert.rejects(
      () => probe.rawInsert({
        linkId: randomUUID(),
        kind: "gh_issue",
        repo: "Owner/Repo",
        repoKey: "owner/repo",
        value: "1",
        tenantId: "check"
      }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""
        assert.match(`${code} ${message}`, /CHECK constraint|23514/)
        return true
      }
    )
    await assert.rejects(
      () => probe.rawInsert({
        linkId: randomUUID(),
        kind: "jira",
        repo: null,
        repoKey: "not-empty",
        value: "proj-1",
        tenantId: "check"
      }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""
        assert.match(`${code} ${message}`, /check constraint|23514/i)
        return true
      }
    )
}

async function derivedRepoKey(probe: Probe) {
    const tenantId = "tenant-case"
    const claim = await probe.store.claimSessionLinkKey({
      linkId: randomUUID(),
      tenantId,
      key: { kind: "gh_issue", repo: "Owner/Repo", number: 15 }
    })
    assert.equal(claim.repo, "owner/repo")
    assert.equal(claim.repoKey, "owner/repo")
    assert.equal(claim.value, "15")
    const stored = await probe.readKey(tenantId, "gh_issue", "owner/repo", "15")
    assert.ok(stored)
    assert.equal(stored.repo, "owner/repo")
    assert.equal(stored.repo_key, stored.repo)
    const jira = await probe.store.claimSessionLinkKey({
      linkId: randomUUID(),
      tenantId,
      key: { kind: "jira", issueKey: "PROJ-15" }
    })
    assert.equal(jira.repo, null)
    assert.equal(jira.repoKey, "")
    assert.equal(jira.value, "proj-15")
    const folded = await probe.readKey(tenantId, "jira", "", "proj-15")
    assert.ok(folded)
    assert.equal(folded.repo, null)
    assert.equal(folded.repo_key, "")
    await assert.rejects(
      () => probe.store.claimSessionLinkKey({
        linkId: randomUUID(),
        tenantId,
        key: { kind: "gh_issue", repo: "owner/repo", number: 15 }
      }),
      (error: unknown) => error instanceof SessionLinkClaimConflictError && error.linkId === claim.linkId
    )
    await assert.rejects(
      () => probe.store.claimSessionLinkKey({
        linkId: randomUUID(),
        tenantId,
        key: { kind: "jira", issueKey: "proj-15" }
      }),
      (error: unknown) => error instanceof SessionLinkClaimConflictError && error.linkId === jira.linkId
    )
}

async function orphanReclaim(probe: Probe) {
    const tenantId = "tenant-orphan"
    const key: SessionLinkKeyInput = { kind: "jira", issueKey: "ORPH-1" }
    const firstId = randomUUID()
    const first = await probe.store.claimSessionLinkKey({ linkId: firstId, tenantId, key })
    const pending = await probe.store.resolveSessionLink({ tenantId, keys: [key] })
    assert.equal(pending.state, "pending")
    if (pending.state === "pending") assert.equal(pending.linkId, first.linkId)
    const young = new Date(Date.now() - SESSION_LINK_ORPHAN_TIMEOUT_MS + 30_000).toISOString()
    await probe.backdate(firstId, young)
    await assert.rejects(
      () => probe.store.claimSessionLinkKey({ linkId: randomUUID(), tenantId, key }),
      (error: unknown) => error instanceof SessionLinkClaimConflictError && error.pending && error.linkId === firstId
    )
    const stillPending = await probe.store.resolveSessionLink({ tenantId, keys: [key] })
    assert.equal(stillPending.state, "pending")

    const expired = new Date(Date.now() - SESSION_LINK_ORPHAN_TIMEOUT_MS - 1000).toISOString()
    await probe.backdate(firstId, expired)
    const reclaimed = await probe.store.resolveSessionLink({ tenantId, keys: [key] })
    assert.equal(reclaimed.state, "none")
    assert.equal(await probe.countKeys(tenantId, "jira", "", "orph-1"), 0)

    const secondKey: SessionLinkKeyInput = { kind: "gh_pr", repo: "acme/widget", number: 3 }
    const abandonedId = randomUUID()
    await probe.store.claimSessionLinkKey({ linkId: abandonedId, tenantId, key: secondKey })
    await probe.backdate(abandonedId, expired)
    const replacementId = randomUUID()
    const replacement = await probe.store.claimSessionLinkKey({
      linkId: replacementId,
      tenantId,
      key: secondKey
    })
    assert.equal(replacement.linkId, replacementId)
    assert.equal(await probe.countKeys(tenantId, "gh_pr", "acme/widget", "3"), 1)
    const row = await probe.readKey(tenantId, "gh_pr", "acme/widget", "3")
    assert.equal(row?.link_id, replacementId)
}

async function abandonFreshClaim(probe: Probe) {
  const tenantId = "tenant-abandon"
  const key: SessionLinkKeyInput = { kind: "jira", issueKey: "ABN-1" }
  const sibling: SessionLinkKeyInput = { kind: "gh_issue", repo: "acme/widget", number: 2 }
  const linkId = randomUUID()
  await probe.store.claimSessionLinkKey({ linkId, tenantId, key })
  await probe.store.claimSessionLinkKey({
    linkId,
    tenantId,
    key: { kind: "gh_pr", repo: "acme/widget", number: 2 }
  })
  const otherId = randomUUID()
  await probe.store.claimSessionLinkKey({ linkId: otherId, tenantId, key: sibling })
  await probe.store.abandonSessionLinkClaim({ tenantId, linkId })
  assert.equal(await probe.countKeys(tenantId, "jira", "", "abn-1"), 0)
  assert.equal(await probe.countKeys(tenantId, "gh_pr", "acme/widget", "2"), 0)
  assert.equal((await probe.store.resolveSessionLink({ tenantId, keys: [key] })).state, "none")
  assert.equal(await probe.countKeys(tenantId, "gh_issue", "acme/widget", "2"), 1)
  await probe.store.abandonSessionLinkClaim({ tenantId, linkId: randomUUID() })
  assert.equal(await probe.countKeys(tenantId, "gh_issue", "acme/widget", "2"), 1)
  const replacementId = randomUUID()
  const replacement = await probe.store.claimSessionLinkKey({ linkId: replacementId, tenantId, key })
  assert.equal(replacement.linkId, replacementId)
}

async function abandonPromoted(probe: Probe) {
  const tenantId = "tenant-abandon-live"
  const key: SessionLinkKeyInput = { kind: "gh_pr", repo: "acme/widget", number: 11 }
  const linkId = randomUUID()
  await probe.store.claimSessionLinkKey({ linkId, tenantId, key })
  await probe.store.promoteSessionLinkClaim({
    linkId,
    tenantId,
    opencodeSessionId: `session-${linkId}`
  })
  await probe.store.abandonSessionLinkClaim({ tenantId, linkId })
  assert.equal(await probe.countKeys(tenantId, "gh_pr", "acme/widget", "11"), 1)
  const resolved = await probe.store.resolveSessionLink({ tenantId, keys: [key] })
  assert.equal(resolved.state, "linked")
  if (resolved.state === "linked") assert.equal(resolved.link.opencodeSessionId, `session-${linkId}`)
}

async function liveLinkNotReclaimed(probe: Probe) {
    const tenantId = "tenant-live"
    const key: SessionLinkKeyInput = { kind: "gh_issue", repo: "acme/widget", number: 9 }
    const linkId = randomUUID()
    await probe.store.claimSessionLinkKey({ linkId, tenantId, key })
    const link = await probe.store.promoteSessionLinkClaim({
      linkId,
      tenantId,
      opencodeSessionId: `session-${linkId}`
    })
    assert.equal(link.id, linkId)
    assert.equal(link.status, "active")
    await probe.backdate(linkId, new Date(Date.now() - SESSION_LINK_ORPHAN_TIMEOUT_MS - 1000).toISOString())
    await assert.rejects(
      () => probe.store.claimSessionLinkKey({ linkId: randomUUID(), tenantId, key }),
      (error: unknown) => error instanceof SessionLinkClaimConflictError && !error.pending && error.linkId === linkId
    )
    const resolved = await probe.store.resolveSessionLink({ tenantId, keys: [key] })
    assert.equal(resolved.state, "linked")
    if (resolved.state === "linked") assert.equal(resolved.link.opencodeSessionId, `session-${linkId}`)
    assert.equal(await probe.countKeys(tenantId, "gh_issue", "acme/widget", "9"), 1)
}

async function resolveAndPromote(probe: Probe) {
    const tenantId = "tenant-resolve"
    const linkId = randomUUID()
    const jira: SessionLinkKeyInput = { kind: "jira", issueKey: "LINK-1" }
    const pr: SessionLinkKeyInput = { kind: "gh_pr", repo: "acme/widget", number: 4 }
    await probe.store.claimSessionLinkKey({ linkId, tenantId, key: jira })
    await probe.store.claimSessionLinkKey({ linkId, tenantId, key: pr })
    assert.equal((await probe.store.resolveSessionLink({ tenantId, keys: [] })).state, "none")
    const pending = await probe.store.resolveSessionLink({ tenantId, keys: [jira, pr, jira] })
    assert.equal(pending.state, "pending")
    const promoted = await probe.store.promoteSessionLinkClaim({
      linkId,
      tenantId,
      opencodeSessionId: "oc-1"
    })
    const resolved = await probe.store.resolveSessionLink({ tenantId, keys: [pr] })
    assert.equal(resolved.state, "linked")
    if (resolved.state === "linked") assert.equal(resolved.link.id, promoted.id)
    await assert.rejects(
      () => probe.store.promoteSessionLinkClaim({ linkId, tenantId, opencodeSessionId: "oc-2" }),
      (error: unknown) => error instanceof SessionLinkPromoteError
    )
    const otherId = randomUUID()
    await probe.store.claimSessionLinkKey({
      linkId: otherId,
      tenantId,
      key: { kind: "gh_issue", repo: "acme/widget", number: 8 }
    })
    await probe.store.promoteSessionLinkClaim({
      linkId: otherId,
      tenantId,
      opencodeSessionId: "oc-other"
    })
    await assert.rejects(
      () => probe.store.resolveSessionLink({
        tenantId,
        keys: [jira, { kind: "gh_issue", repo: "acme/widget", number: 8 }]
      }),
      (error: unknown) => {
        assert.ok(error instanceof SessionLinkResolveConflictError)
        assert.deepEqual(error.linkIds, [linkId, otherId].sort())
        return true
      }
    )
}

async function jiraCursor(probe: Probe) {
  assert.equal(await probe.store.getJiraPollState("tenant-jira"), null)
    await probe.store.updateJiraPollState({ tenantId: "tenant-jira", lastCursor: "2026-01-01T00:00:00.000Z" })
    await probe.store.updateJiraPollState({ tenantId: "tenant-jira", lastCursor: "2026-01-02T00:00:00.000Z" })
    const state = await probe.store.getJiraPollState("tenant-jira")
    assert.equal(state?.lastCursor, "2026-01-02T00:00:00.000Z")
    assert.ok(state?.updatedAt)
}

async function withSqlite(fn: (probe: Probe) => Promise<void>) {
  const probe = await openSqlite()
  try {
    await fn(probe)
  } finally {
    await probe.close()
  }
}

async function postgresRace(kind: "jira" | "gh_issue" | "gh_pr") {
  await withPostgres(async probe => {
    const other = createPostgresStore(probe.url)
    try {
      await probe.store.ensureSchema()
      const tenantId = `pg-${kind}`
      const key = raceKey(kind)
      const results = await Promise.allSettled([
        probe.store.claimSessionLinkKey({ linkId: randomUUID(), tenantId, key }),
        other.claimSessionLinkKey({ linkId: randomUUID(), tenantId, key })
      ])
      const fulfilled = results.filter(result => result.status === "fulfilled")
      const rejected = results.filter(result => result.status === "rejected")
      assert.equal(fulfilled.length, 1, JSON.stringify(results, null, 2))
      assert.equal(rejected.length, 1)
      assert.ok(rejected[0].status === "rejected")
      assert.ok(rejected[0].reason instanceof SessionLinkClaimConflictError)
      const normalizedValue = kind === "jira" ? "proj-1" : "41"
      const repoKey = kind === "jira" ? "" : "owner/repo"
      assert.equal(await probe.countKeys(tenantId, kind, repoKey, normalizedValue), 1)
    } finally {
      await other.close?.()
    }
  })
}

async function openSqlite(): Promise<Probe> {
  const dir = mkdtempSync(path.join(tmpdir(), "codebridge-sl-"))
  const dbPath = path.join(dir, "store.db")
  const store = createSqliteStore(dbPath)
  await store.ensureSchema()
  const raw = new Database(dbPath)
  raw.pragma("busy_timeout = 5000")
  return {
    store,
    async backdate(linkId, iso) {
      const info = raw.prepare("UPDATE session_link_key SET created_at = ? WHERE link_id = ?").run(iso, linkId)
      if (info.changes < 1) throw new Error(`backdate updated ${info.changes} rows for ${linkId}`)
    },
    async countKeys(tenantId, kind, repoKey, value) {
      const row = raw.prepare(
        "SELECT COUNT(*) AS n FROM session_link_key WHERE tenant_id = ? AND kind = ? AND repo_key = ? AND value = ?"
      ).get(tenantId, kind, repoKey, value) as { n: number }
      return row.n
    },
    async readKey(tenantId, kind, repoKey, value) {
      return raw.prepare(
        "SELECT repo, repo_key, value, link_id FROM session_link_key WHERE tenant_id = ? AND kind = ? AND repo_key = ? AND value = ?"
      ).get(tenantId, kind, repoKey, value) as KeyRow | null
    },
    async rawInsert(row) {
      raw.prepare(
        `INSERT INTO session_link_key (link_id, kind, repo, repo_key, value, tenant_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(row.linkId, row.kind, row.repo, row.repoKey, row.value, row.tenantId, new Date().toISOString())
    },
    async close() {
      raw.close()
      await store.close?.()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

type PostgresProbe = Probe & { url: string }

async function withPostgres(fn: (probe: PostgresProbe) => Promise<void>) {
  const name = `codebridge_sl_${process.pid}_${randomUUID().replace(/-/g, "").slice(0, 8)}`
  const admin = new pg.Pool({ connectionString: "postgres://localhost/postgres" })
  await admin.query(`CREATE DATABASE "${name}"`)
  const url = `postgres://localhost/${name}`
  const probe = await openPostgres(url)
  try {
    await fn(probe)
  } finally {
    await probe.close()
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [name]
    )
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
    await admin.end()
  }
}

async function openPostgres(url: string): Promise<PostgresProbe> {
  const store = createPostgresStore(url)
  await store.ensureSchema()
  const raw = new pg.Pool({ connectionString: url })
  return {
    url,
    store,
    async backdate(linkId, iso) {
      const result = await raw.query("UPDATE session_link_key SET created_at = $1 WHERE link_id = $2", [iso, linkId])
      if (result.rowCount !== 1 && (result.rowCount ?? 0) < 1) {
        throw new Error(`backdate updated ${result.rowCount} rows for ${linkId}`)
      }
    },
    async countKeys(tenantId, kind, repoKey, value) {
      const result = await raw.query(
        "SELECT COUNT(*)::int AS n FROM session_link_key WHERE tenant_id = $1 AND kind = $2 AND repo_key = $3 AND value = $4",
        [tenantId, kind, repoKey, value]
      )
      return result.rows[0].n as number
    },
    async readKey(tenantId, kind, repoKey, value) {
      const result = await raw.query(
        "SELECT repo, repo_key, value, link_id FROM session_link_key WHERE tenant_id = $1 AND kind = $2 AND repo_key = $3 AND value = $4",
        [tenantId, kind, repoKey, value]
      )
      return (result.rows[0] as KeyRow | undefined) ?? null
    },
    async rawInsert(row) {
      await raw.query(
        `INSERT INTO session_link_key (link_id, kind, repo, repo_key, value, tenant_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [row.linkId, row.kind, row.repo, row.repoKey, row.value, row.tenantId, new Date().toISOString()]
      )
    },
    async close() {
      await raw.end()
      await store.close?.()
    }
  }
}
