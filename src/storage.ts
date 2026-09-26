import { readFile } from "node:fs/promises"
import { mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { Pool } from "pg"
import Database from "better-sqlite3"
import type { RunEvent, RunRecord, RunStatus, SlackContext, GitHubContext } from "./types.js"

export type RunStore = {
  ensureSchema: () => Promise<void>
  createRun: (input: {
    id: string
    tenantId: string
    repoFullName: string
    repoPath: string
    sourceKey?: string
    prompt: string
    model?: string
    branchPrefix?: string
    slack?: SlackContext
    github?: GitHubContext
  }) => Promise<RunRecord>
  getRun: (id: string) => Promise<RunRecord | null>
  getRunBySourceKey: (sourceKey: string) => Promise<RunRecord | null>
  getLatestRunForIssue: (input: {
    tenantId: string
    repoFullName: string
    issueNumber: number
  }) => Promise<RunRecord | null>
  getGithubPollState: (
    tenantId: string,
    repoFullName: string
  ) => Promise<{ lastCommentId: number | null; lastCommentCreatedAt: string | null } | null>
  updateGithubPollState: (input: {
    tenantId: string
    repoFullName: string
    lastCommentId: number | null
    lastCommentCreatedAt: string | null
  }) => Promise<void>
  updateRunStatus: (id: string, status: RunStatus) => Promise<void>
  updateSlackMessage: (id: string, messageTs: string) => Promise<void>
  updateGithubComment: (id: string, commentId: number) => Promise<void>
  updateRunBranch: (id: string, branchName: string) => Promise<void>
  updateRunPr: (id: string, prNumber: number, prUrl: string) => Promise<void>
  appendEvent: (event: RunEvent) => Promise<void>
  claimSessionLinkKey: (input: ClaimSessionLinkInput) => Promise<SessionLinkClaim>
  promoteSessionLinkClaim: (input: PromoteSessionLinkInput) => Promise<SessionLink>
  resolveSessionLink: (input: ResolveSessionLinkInput) => Promise<SessionLinkResolution>
  abandonSessionLinkClaim: (input: AbandonSessionLinkClaimInput) => Promise<void>
  updateSessionLinkStatus: (input: UpdateSessionLinkStatusInput) => Promise<SessionLink>
  getJiraPollState: (tenantId: string) => Promise<{ lastCursor: string; updatedAt: string } | null>
  updateJiraPollState: (input: { tenantId: string; lastCursor: string }) => Promise<void>
  close?: () => Promise<void>
}

export function createPostgresStore(databaseUrl: string): RunStore {
  const pool = new Pool({ connectionString: databaseUrl })

  const ensureSchema = async () => {
    const schemaPath = path.join(process.cwd(), "sql", "schema.sql")
    const sql = await readFile(schemaPath, "utf8")
    await pool.query(sql)
  }

  const createRun = async (input: {
    id: string
    tenantId: string
    repoFullName: string
    repoPath: string
    sourceKey?: string
    prompt: string
    model?: string
    branchPrefix?: string
    slack?: SlackContext
    github?: GitHubContext
  }) => {
    const result = await pool.query(
      `INSERT INTO runs (
        id, tenant_id, repo_full_name, repo_path, source_key, status, prompt, model, branch_prefix,
        slack_channel, slack_thread_ts, slack_message_ts, slack_user_id,
        github_owner, github_repo, github_issue_number, github_comment_id, github_trigger_comment_id,
        github_installation_id, github_issue_title, github_issue_body
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      ON CONFLICT (source_key) DO UPDATE SET updated_at = now()
      RETURNING *`,
      [
        input.id,
        input.tenantId,
        input.repoFullName,
        input.repoPath,
        input.sourceKey ?? null,
        "queued",
        input.prompt,
        input.model ?? null,
        input.branchPrefix ?? null,
        input.slack?.channel ?? null,
        input.slack?.threadTs ?? null,
        input.slack?.messageTs ?? null,
        input.slack?.userId ?? null,
        input.github?.owner ?? null,
        input.github?.repo ?? null,
        input.github?.issueNumber ?? null,
        input.github?.commentId ?? null,
        input.github?.triggerCommentId ?? null,
        input.github?.installationId ?? null,
        input.github?.issueTitle ?? null,
        input.github?.issueBody ?? null
      ]
    )
    return toRunRecord(result.rows[0])
  }

  const getRun = async (id: string) => {
    const result = await pool.query("SELECT * FROM runs WHERE id = $1", [id])
    if (result.rowCount === 0) return null
    return toRunRecord(result.rows[0])
  }

  const getRunBySourceKey = async (sourceKey: string) => {
    const result = await pool.query("SELECT * FROM runs WHERE source_key = $1", [sourceKey])
    if (result.rowCount === 0) return null
    return toRunRecord(result.rows[0])
  }

  const getLatestRunForIssue = async (input: {
    tenantId: string
    repoFullName: string
    issueNumber: number
  }) => {
    const result = await pool.query(
      `SELECT *
       FROM runs
       WHERE tenant_id = $1 AND repo_full_name = $2 AND github_issue_number = $3
       ORDER BY created_at DESC
       LIMIT 1`,
      [input.tenantId, input.repoFullName, input.issueNumber]
    )
    if (result.rowCount === 0) return null
    return toRunRecord(result.rows[0])
  }

  const getGithubPollState = async (tenantId: string, repoFullName: string) => {
    const result = await pool.query(
      "SELECT last_comment_id, last_comment_created_at FROM github_poll_state WHERE tenant_id = $1 AND repo_full_name = $2",
      [tenantId, repoFullName]
    )
    if (result.rowCount === 0) return null
    return {
      lastCommentId: result.rows[0].last_comment_id ?? null,
      lastCommentCreatedAt: result.rows[0].last_comment_created_at
        ? new Date(result.rows[0].last_comment_created_at).toISOString()
        : null
    }
  }

  const updateGithubPollState = async (input: {
    tenantId: string
    repoFullName: string
    lastCommentId: number | null
    lastCommentCreatedAt: string | null
  }) => {
    await pool.query(
      `INSERT INTO github_poll_state (tenant_id, repo_full_name, last_comment_id, last_comment_created_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, repo_full_name)
       DO UPDATE SET last_comment_id = EXCLUDED.last_comment_id,
                     last_comment_created_at = EXCLUDED.last_comment_created_at,
                     updated_at = now()`,
      [input.tenantId, input.repoFullName, input.lastCommentId, input.lastCommentCreatedAt]
    )
  }

  const updateRunStatus = async (id: string, status: RunStatus) => {
    await pool.query("UPDATE runs SET status = $1, updated_at = now() WHERE id = $2", [status, id])
  }

  const updateSlackMessage = async (id: string, messageTs: string) => {
    await pool.query("UPDATE runs SET slack_message_ts = $1, updated_at = now() WHERE id = $2", [messageTs, id])
  }

  const updateGithubComment = async (id: string, commentId: number) => {
    await pool.query("UPDATE runs SET github_comment_id = $1, updated_at = now() WHERE id = $2", [commentId, id])
  }

  const updateRunBranch = async (id: string, branchName: string) => {
    await pool.query("UPDATE runs SET branch_name = $1, updated_at = now() WHERE id = $2", [branchName, id])
  }

  const updateRunPr = async (id: string, prNumber: number, prUrl: string) => {
    await pool.query("UPDATE runs SET pr_number = $1, pr_url = $2, updated_at = now() WHERE id = $3", [prNumber, prUrl, id])
  }

  const appendEvent = async (event: RunEvent) => {
    await pool.query(
      "INSERT INTO run_events (run_id, seq, event_type, payload) VALUES ($1,$2,$3,$4)",
      [event.runId, event.seq, event.type, event.payload]
    )
  }

  const harness = createHarnessStorage(createPostgresSql(pool), "pg")
  const close = async () => {
    await pool.end()
  }

  return {
    ensureSchema,
    createRun,
    getRun,
    getRunBySourceKey,
    getLatestRunForIssue,
    getGithubPollState,
    updateGithubPollState,
    updateRunStatus,
    updateSlackMessage,
    updateGithubComment,
    updateRunBranch,
    updateRunPr,
    appendEvent,
    close,
    ...harness
  }
}

function toRunRecord(row: any): RunRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    repoFullName: row.repo_full_name,
    repoPath: row.repo_path,
    sourceKey: row.source_key ?? undefined,
    status: row.status,
    prompt: row.prompt,
    model: row.model ?? undefined,
    branchPrefix: row.branch_prefix ?? undefined,
    slack: row.slack_channel && row.slack_thread_ts ? {
      channel: row.slack_channel,
      threadTs: row.slack_thread_ts,
      messageTs: row.slack_message_ts ?? undefined,
      userId: row.slack_user_id ?? undefined
    } : undefined,
    github: row.github_owner && row.github_repo ? {
      owner: row.github_owner,
      repo: row.github_repo,
      issueNumber: row.github_issue_number ?? undefined,
      commentId: row.github_comment_id ?? undefined,
      triggerCommentId: row.github_trigger_comment_id ?? undefined,
      installationId: row.github_installation_id ?? undefined,
      issueTitle: row.github_issue_title ?? undefined,
      issueBody: row.github_issue_body ?? undefined
    } : undefined,
    branchName: row.branch_name ?? undefined,
    prNumber: row.pr_number ?? undefined,
    prUrl: row.pr_url ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  }
}

export function createSqliteStore(databaseUrl: string): RunStore {
  const filename = resolveSqlitePath(databaseUrl)
  if (filename !== ":memory:") {
    const dir = path.dirname(filename)
    if (dir && dir !== ".") {
      mkdirSync(dir, { recursive: true })
    }
  }
  const db = new Database(filename)
  // Concurrent claims must wait out the writer lock and then fail on the
  // unique key, not surface SQLITE_BUSY as an unrelated error.
  db.pragma("busy_timeout = 5000")

  const schemaPath = path.join(process.cwd(), "sql", "schema.sqlite.sql")
  const schemaSql = readFileSync(schemaPath, "utf8")
  db.exec(schemaSql)
  ensureSqliteRunSchemaMigrations(db)

  const ensureSchema = async () => {
    db.exec(schemaSql)
    ensureSqliteRunSchemaMigrations(db)
  }

  const insertRun = db.prepare(
    `INSERT INTO runs (
      id, tenant_id, repo_full_name, repo_path, source_key, status, prompt, model, branch_prefix,
      slack_channel, slack_thread_ts, slack_message_ts, slack_user_id,
      github_owner, github_repo, github_issue_number, github_comment_id, github_trigger_comment_id,
      github_installation_id, github_issue_title, github_issue_body
    ) VALUES (
      @id, @tenantId, @repoFullName, @repoPath, @sourceKey, @status, @prompt, @model, @branchPrefix,
      @slackChannel, @slackThreadTs, @slackMessageTs, @slackUserId,
      @githubOwner, @githubRepo, @githubIssueNumber, @githubCommentId, @githubTriggerCommentId,
      @githubInstallationId, @githubIssueTitle, @githubIssueBody
    )
    ON CONFLICT(source_key) DO UPDATE SET updated_at = CURRENT_TIMESTAMP`
  )

  const getRunRow = db.prepare("SELECT * FROM runs WHERE id = ?")
  const getRunBySourceKeyRow = db.prepare("SELECT * FROM runs WHERE source_key = ?")
  const getLatestRunForIssueRow = db.prepare(
    `SELECT *
     FROM runs
     WHERE tenant_id = ? AND repo_full_name = ? AND github_issue_number = ?
     ORDER BY datetime(created_at) DESC
     LIMIT 1`
  )
  const updateRunStatusStmt = db.prepare("UPDATE runs SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
  const updateSlackMessageStmt = db.prepare("UPDATE runs SET slack_message_ts = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
  const updateGithubCommentStmt = db.prepare("UPDATE runs SET github_comment_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
  const updateRunBranchStmt = db.prepare("UPDATE runs SET branch_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
  const updateRunPrStmt = db.prepare("UPDATE runs SET pr_number = ?, pr_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
  const insertEventStmt = db.prepare("INSERT INTO run_events (run_id, seq, event_type, payload) VALUES (?,?,?,?)")

  const getPollStateStmt = db.prepare(
    "SELECT last_comment_id, last_comment_created_at FROM github_poll_state WHERE tenant_id = ? AND repo_full_name = ?"
  )
  const upsertPollStateStmt = db.prepare(
    `INSERT INTO github_poll_state (tenant_id, repo_full_name, last_comment_id, last_comment_created_at)
     VALUES (?,?,?,?)
     ON CONFLICT (tenant_id, repo_full_name)
     DO UPDATE SET last_comment_id = excluded.last_comment_id,
                   last_comment_created_at = excluded.last_comment_created_at,
                   updated_at = CURRENT_TIMESTAMP`
  )

  const createRun = async (input: {
    id: string
    tenantId: string
    repoFullName: string
    repoPath: string
    sourceKey?: string
    prompt: string
    model?: string
    branchPrefix?: string
    slack?: SlackContext
    github?: GitHubContext
  }) => {
    insertRun.run({
      id: input.id,
      tenantId: input.tenantId,
      repoFullName: input.repoFullName,
      repoPath: input.repoPath,
      sourceKey: input.sourceKey ?? null,
      status: "queued",
      prompt: input.prompt,
      model: input.model ?? null,
      branchPrefix: input.branchPrefix ?? null,
      slackChannel: input.slack?.channel ?? null,
      slackThreadTs: input.slack?.threadTs ?? null,
      slackMessageTs: input.slack?.messageTs ?? null,
      slackUserId: input.slack?.userId ?? null,
      githubOwner: input.github?.owner ?? null,
      githubRepo: input.github?.repo ?? null,
      githubIssueNumber: input.github?.issueNumber ?? null,
      githubCommentId: input.github?.commentId ?? null,
      githubTriggerCommentId: input.github?.triggerCommentId ?? null,
      githubInstallationId: input.github?.installationId ?? null,
      githubIssueTitle: input.github?.issueTitle ?? null,
      githubIssueBody: input.github?.issueBody ?? null
    })
    const row = input.sourceKey ? getRunBySourceKeyRow.get(input.sourceKey) : getRunRow.get(input.id)
    return toRunRecordSqlite(row)
  }

  const getRun = async (id: string) => {
    const row = getRunRow.get(id)
    if (!row) return null
    return toRunRecordSqlite(row)
  }

  const getRunBySourceKey = async (sourceKey: string) => {
    const row = getRunBySourceKeyRow.get(sourceKey)
    if (!row) return null
    return toRunRecordSqlite(row)
  }

  const getLatestRunForIssue = async (input: {
    tenantId: string
    repoFullName: string
    issueNumber: number
  }) => {
    const row = getLatestRunForIssueRow.get(input.tenantId, input.repoFullName, input.issueNumber)
    if (!row) return null
    return toRunRecordSqlite(row)
  }

  const getGithubPollState = async (tenantId: string, repoFullName: string) => {
    const row = getPollStateStmt.get(tenantId, repoFullName) as
      | { last_comment_id: number | null; last_comment_created_at: string | null }
      | undefined
    if (!row) return null
    return {
      lastCommentId: row.last_comment_id ?? null,
      lastCommentCreatedAt: row.last_comment_created_at ?? null
    }
  }

  const updateGithubPollState = async (input: {
    tenantId: string
    repoFullName: string
    lastCommentId: number | null
    lastCommentCreatedAt: string | null
  }) => {
    upsertPollStateStmt.run(
      input.tenantId,
      input.repoFullName,
      input.lastCommentId ?? null,
      input.lastCommentCreatedAt ?? null
    )
  }

  const updateRunStatus = async (id: string, status: RunStatus) => {
    updateRunStatusStmt.run(status, id)
  }

  const updateSlackMessage = async (id: string, messageTs: string) => {
    updateSlackMessageStmt.run(messageTs, id)
  }

  const updateGithubComment = async (id: string, commentId: number) => {
    updateGithubCommentStmt.run(commentId, id)
  }

  const updateRunBranch = async (id: string, branchName: string) => {
    updateRunBranchStmt.run(branchName, id)
  }

  const updateRunPr = async (id: string, prNumber: number, prUrl: string) => {
    updateRunPrStmt.run(prNumber, prUrl, id)
  }

  const appendEvent = async (event: RunEvent) => {
    insertEventStmt.run(event.runId, event.seq, event.type, JSON.stringify(event.payload))
  }

  const harness = createHarnessStorage(createSqliteSql(db), "sqlite", true)
  const close = async () => {
    db.close()
  }

  return {
    ensureSchema,
    createRun,
    getRun,
    getRunBySourceKey,
    getLatestRunForIssue,
    getGithubPollState,
    updateGithubPollState,
    updateRunStatus,
    updateSlackMessage,
    updateGithubComment,
    updateRunBranch,
    updateRunPr,
    appendEvent,
    close,
    ...harness
  }
}

export function createStore(databaseUrl: string): RunStore {
  if (isSqliteUrl(databaseUrl)) {
    return createSqliteStore(databaseUrl)
  }
  return createPostgresStore(databaseUrl)
}

function isSqliteUrl(databaseUrl: string): boolean {
  if (!databaseUrl) return true
  const normalized = databaseUrl.toLowerCase()
  return normalized.startsWith("sqlite:") || normalized.endsWith(".db") || normalized === ":memory:"
}

function resolveSqlitePath(databaseUrl: string): string {
  if (!databaseUrl) return ":memory:"
  if (databaseUrl === ":memory:") return databaseUrl
  if (databaseUrl.startsWith("sqlite://")) {
    return databaseUrl.slice("sqlite://".length)
  }
  if (databaseUrl.startsWith("sqlite:")) {
    const pathPart = databaseUrl.slice("sqlite:".length)
    return pathPart || ":memory:"
  }
  return databaseUrl
}

function toRunRecordSqlite(row: any): RunRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    repoFullName: row.repo_full_name,
    repoPath: row.repo_path,
    sourceKey: row.source_key ?? undefined,
    status: row.status,
    prompt: row.prompt,
    model: row.model ?? undefined,
    branchPrefix: row.branch_prefix ?? undefined,
    slack: row.slack_channel && row.slack_thread_ts ? {
      channel: row.slack_channel,
      threadTs: row.slack_thread_ts,
      messageTs: row.slack_message_ts ?? undefined,
      userId: row.slack_user_id ?? undefined
    } : undefined,
    github: row.github_owner && row.github_repo ? {
      owner: row.github_owner,
      repo: row.github_repo,
      issueNumber: row.github_issue_number ?? undefined,
      commentId: row.github_comment_id ?? undefined,
      triggerCommentId: row.github_trigger_comment_id ?? undefined,
      installationId: row.github_installation_id ?? undefined,
      issueTitle: row.github_issue_title ?? undefined,
      issueBody: row.github_issue_body ?? undefined
    } : undefined,
    branchName: row.branch_name ?? undefined,
    prNumber: row.pr_number ?? undefined,
    prUrl: row.pr_url ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function ensureSqliteRunSchemaMigrations(db: Database.Database) {
  // session_link, session_link_key, and jira_poll_state are new tables created
  // by sql/schema.sqlite.sql (CREATE TABLE IF NOT EXISTS), which runs before
  // this function. No ALTER is required until those tables gain columns.
  const columns = db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>
  if (!columns.some(column => column.name === "source_key")) {
    db.exec("ALTER TABLE runs ADD COLUMN source_key TEXT")
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS runs_source_key_idx ON runs(source_key)")
}

export type SessionLinkStatus = "active" | "idle" | "completed"

export type SessionLinkKeyInput =
  | { kind: "jira"; issueKey: string }
  | { kind: "gh_issue"; repo: string; number: number }
  | { kind: "gh_pr"; repo: string; number: number }

export type NormalizedSessionLinkKey = {
  kind: "jira" | "gh_issue" | "gh_pr"
  repo: string | null
  repoKey: string
  value: string
}

export type SessionLink = {
  id: string
  tenantId: string
  opencodeSessionId: string
  status: SessionLinkStatus
  createdAt: string
  updatedAt: string
}

export type SessionLinkClaim = {
  linkId: string
  tenantId: string
  kind: NormalizedSessionLinkKey["kind"]
  repo: string | null
  repoKey: string
  value: string
  createdAt: string
}

export type ClaimSessionLinkInput = {
  linkId: string
  tenantId: string
  key: SessionLinkKeyInput
}

export type PromoteSessionLinkInput = {
  linkId: string
  tenantId: string
  opencodeSessionId: string
  status?: SessionLinkStatus
}

export type ResolveSessionLinkInput = {
  tenantId: string
  keys: SessionLinkKeyInput[]
}

export type AbandonSessionLinkClaimInput = {
  tenantId: string
  linkId: string
}

export type UpdateSessionLinkStatusInput = {
  tenantId: string
  linkId: string
  status: SessionLinkStatus
  updatedAt: string
}

export type SessionLinkResolution =
  | { state: "linked"; link: SessionLink }
  | { state: "pending"; linkId: string; createdAt: string }
  | { state: "none" }

export class SessionLinkClaimConflictError extends Error {
  readonly linkId: string
  readonly pending: boolean

  constructor(linkId: string, pending: boolean, options?: { cause?: unknown }) {
    super(
      pending
        ? `session link key is already claimed by in-flight link ${linkId}`
        : `session link key is already claimed by link ${linkId}`,
      options
    )
    this.name = "SessionLinkClaimConflictError"
    this.linkId = linkId
    this.pending = pending
  }
}

export class SessionLinkResolveConflictError extends Error {
  readonly linkIds: string[]

  constructor(linkIds: string[]) {
    super(`session link keys resolve to more than one link: ${linkIds.join(", ")}`)
    this.name = "SessionLinkResolveConflictError"
    this.linkIds = linkIds
  }
}

export class SessionLinkPromoteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "SessionLinkPromoteError"
  }
}

/**
 * Crash-orphan policy (LLD §10, option 2 — reclaim on resolve/claim, not a sweep).
 *
 * A session_link_key row with no session_link is the claim window. If the process
 * dies there, the unique key would block that ticket forever because resolve's
 * join to session_link cannot see it. A periodic sweep is the other option, but
 * this card has no poll loop to hang an interval on, and a sweep still leaves a
 * gap where claim() hits the unique constraint and looks like a live owner.
 * Reclaiming on the storage calls that observe the orphan unblocks the identifier
 * at the moment someone needs it. The unique constraint still fail-fasts a second
 * live claim inside the window.
 *
 * 5 minutes matches the workspace grace period in LLD §4a: long enough that a
 * slow createSession is not stolen, short enough that a crashed claim does not
 * stick.
 */
export const SESSION_LINK_ORPHAN_TIMEOUT_MS = 5 * 60 * 1000

const SESSION_LINK_STATUSES = new Set<SessionLinkStatus>(["active", "idle", "completed"])

type SqlValue = string | number | null
type SqlRow = Record<string, unknown>

type Sql = {
  all(sql: string, params: readonly SqlValue[]): Promise<SqlRow[]>
  run(sql: string, params: readonly SqlValue[]): Promise<number>
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>
}

type SqlStyle = "pg" | "sqlite"

type KeyMatch = {
  linkId: string
  kind: string
  repoKey: string
  value: string
  keyCreatedAt: string
  link: SessionLink | null
}

export function normalizeSessionLinkKey(key: SessionLinkKeyInput): NormalizedSessionLinkKey {
  if (key.kind === "jira") {
    const value = key.issueKey.trim().toLowerCase()
    if (!value) throw new Error("jira issue key is required")
    return { kind: "jira", repo: null, repoKey: "", value }
  }
  if (key.kind !== "gh_issue" && key.kind !== "gh_pr") {
    const kind = (key as { kind?: unknown }).kind
    throw new Error(`unsupported session link kind: ${String(kind)}`)
  }
  const repo = key.repo.trim().toLowerCase()
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new Error("repo must be owner/repo")
  }
  if (!Number.isInteger(key.number) || key.number <= 0) {
    throw new Error("issue/pr number must be a positive integer")
  }
  return { kind: key.kind, repo, repoKey: repo, value: String(key.number) }
}

function createHarnessStorage(sql: Sql, style: SqlStyle, serialize = false) {
  const exclusive = serialize ? createExclusive() : async <T>(fn: () => Promise<T>) => fn()
  return {
    claimSessionLinkKey: (input: ClaimSessionLinkInput) => exclusive(() => claimSessionLinkKey(sql, style, input)),
    promoteSessionLinkClaim: (input: PromoteSessionLinkInput) => exclusive(() => promoteSessionLinkClaim(sql, style, input)),
    resolveSessionLink: (input: ResolveSessionLinkInput) => exclusive(() => resolveSessionLink(sql, style, input)),
    abandonSessionLinkClaim: (input: AbandonSessionLinkClaimInput) => exclusive(() => abandonSessionLinkClaim(sql, style, input)),
    updateSessionLinkStatus: (input: UpdateSessionLinkStatusInput) => exclusive(() => updateSessionLinkStatus(sql, style, input)),
    getJiraPollState: (tenantId: string) => exclusive(() => getJiraPollState(sql, style, tenantId)),
    updateJiraPollState: (input: { tenantId: string; lastCursor: string }) => exclusive(() => updateJiraPollState(sql, style, input))
  }
}

function createPostgresSql(pool: Pool): Sql {
  return {
    all: async (sql, params) => {
      const result = await pool.query(sql, [...params])
      return result.rows as SqlRow[]
    },
    run: async (sql, params) => {
      const result = await pool.query(sql, [...params])
      return result.rowCount ?? 0
    },
    transaction: async (fn) => {
      const client = await pool.connect()
      const tx: Sql = {
        all: async (sql, params) => (await client.query(sql, [...params])).rows as SqlRow[],
        run: async (sql, params) => (await client.query(sql, [...params])).rowCount ?? 0,
        transaction: async (inner) => inner(tx)
      }
      try {
        await client.query("BEGIN")
        const value = await fn(tx)
        await client.query("COMMIT")
        return value
      } catch (error) {
        try {
          await client.query("ROLLBACK")
        } catch {
          // the connection may already be aborted
        }
        throw error
      } finally {
        client.release()
      }
    }
  }
}

function createSqliteSql(db: Database.Database): Sql {
  const all = (sql: string, params: readonly SqlValue[]) => db.prepare(sql).all(...params) as SqlRow[]
  const run = (sql: string, params: readonly SqlValue[]) => db.prepare(sql).run(...params).changes
  const sql: Sql = {
    all: async (statement, params) => all(statement, params),
    run: async (statement, params) => run(statement, params),
    transaction: async (fn) => {
      db.exec("BEGIN IMMEDIATE")
      try {
        const value = await fn(sql)
        db.exec("COMMIT")
        return value
      } catch (error) {
        db.exec("ROLLBACK")
        throw error
      }
    }
  }
  return sql
}

function createExclusive() {
  let tail: Promise<void> = Promise.resolve()
  return async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = tail
    let release: () => void = () => {}
    tail = new Promise(resolve => {
      release = resolve
    })
    await previous
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

async function claimSessionLinkKey(sql: Sql, style: SqlStyle, input: ClaimSessionLinkInput): Promise<SessionLinkClaim> {
  const linkId = requireText("linkId", input.linkId)
  const tenantId = requireText("tenantId", input.tenantId)
  const normalized = normalizeSessionLinkKey(input.key)
  const createdAt = new Date().toISOString()
  try {
    await insertKey(sql, style, { linkId, tenantId, normalized, createdAt })
    return toClaim({ linkId, tenantId, normalized, createdAt })
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const existing = await fetchKey(sql, style, tenantId, normalized)
    if (!existing) throw error
    const now = Date.now()
    if (!isExpiredOrphan(existing.keyCreatedAt, existing.link !== null, now)) {
      throw new SessionLinkClaimConflictError(existing.linkId, existing.link === null, { cause: error })
    }
    try {
      const reclaimed = await sql.transaction(async tx => {
        const deleted = await deleteKeyRow(tx, style, tenantId, existing)
        if (deleted !== 1) return false
        await insertKey(tx, style, { linkId, tenantId, normalized, createdAt })
        return true
      })
      if (!reclaimed) {
        const current = await fetchKey(sql, style, tenantId, normalized)
        throw new SessionLinkClaimConflictError(current?.linkId ?? existing.linkId, current ? current.link === null : false, { cause: error })
      }
      return toClaim({ linkId, tenantId, normalized, createdAt })
    } catch (retryError) {
      if (!isUniqueViolation(retryError)) throw retryError
      const current = await fetchKey(sql, style, tenantId, normalized)
      throw new SessionLinkClaimConflictError(current?.linkId ?? existing.linkId, current ? current.link === null : false, { cause: retryError })
    }
  }
}

async function promoteSessionLinkClaim(sql: Sql, style: SqlStyle, input: PromoteSessionLinkInput): Promise<SessionLink> {
  const linkId = requireText("linkId", input.linkId)
  const tenantId = requireText("tenantId", input.tenantId)
  const opencodeSessionId = requireText("opencodeSessionId", input.opencodeSessionId)
  const status = input.status ?? "active"
  if (!SESSION_LINK_STATUSES.has(status)) {
    throw new Error(`invalid session link status: ${status}`)
  }
  const claim = await sql.all(
    `SELECT tenant_id FROM session_link_key WHERE link_id = ${placeholder(style, 1)} AND tenant_id = ${placeholder(style, 2)} LIMIT 1`,
    [linkId, tenantId]
  )
  if (claim.length === 0) {
    throw new SessionLinkPromoteError(`cannot promote ${linkId}: no session_link_key claim for this tenant`)
  }
  const now = new Date().toISOString()
  try {
    const rows = await sql.all(
      `INSERT INTO session_link (id, tenant_id, opencode_session_id, status, created_at, updated_at)
       VALUES (${placeholders(style, 6)})
       RETURNING id, tenant_id, opencode_session_id, status, created_at, updated_at`,
      [linkId, tenantId, opencodeSessionId, status, now, now]
    )
    return toSessionLink(rows[0])
  } catch (error) {
    if (!isUniqueViolation(error) && !isPrimaryKeyViolation(error)) throw error
    throw new SessionLinkPromoteError(`cannot promote ${linkId}: session link already exists`, { cause: error })
  }
}

async function resolveSessionLink(sql: Sql, style: SqlStyle, input: ResolveSessionLinkInput): Promise<SessionLinkResolution> {
  const tenantId = requireText("tenantId", input.tenantId)
  const keys = dedupeKeys(input.keys.map(normalizeSessionLinkKey))
  if (keys.length === 0) return { state: "none" }
  const now = Date.now()
  const loaded = await loadMatches(sql, style, tenantId, keys)
  const classified = classifyMatches(loaded, now)
  if (classified.expired.length > 0) {
    await sql.transaction(async tx => {
      for (const row of classified.expired) {
        await deleteKeyRow(tx, style, tenantId, row)
      }
    })
  }
  const fresh = classifyMatches(await loadMatches(sql, style, tenantId, keys), now)
  return resolutionFromActive(fresh.activeByLink)
}

async function getJiraPollState(sql: Sql, style: SqlStyle, tenantId: string) {
  const id = requireText("tenantId", tenantId)
  const rows = await sql.all(
    `SELECT last_cursor, updated_at FROM jira_poll_state WHERE tenant_id = ${placeholder(style, 1)}`,
    [id]
  )
  if (rows.length === 0) return null
  return {
    lastCursor: asString(rows[0].last_cursor),
    updatedAt: asTimestamp(rows[0].updated_at)
  }
}

async function updateJiraPollState(sql: Sql, style: SqlStyle, input: { tenantId: string; lastCursor: string }) {
  const tenantId = requireText("tenantId", input.tenantId)
  const lastCursor = requireText("lastCursor", input.lastCursor)
  const updatedAt = new Date().toISOString()
  if (style === "pg") {
    await sql.run(
      `INSERT INTO jira_poll_state (tenant_id, last_cursor, updated_at)
       VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id)
       DO UPDATE SET last_cursor = EXCLUDED.last_cursor, updated_at = EXCLUDED.updated_at`,
      [tenantId, lastCursor, updatedAt]
    )
    return
  }
  await sql.run(
    `INSERT INTO jira_poll_state (tenant_id, last_cursor, updated_at)
     VALUES (?,?,?)
     ON CONFLICT (tenant_id)
     DO UPDATE SET last_cursor = excluded.last_cursor, updated_at = excluded.updated_at`,
    [tenantId, lastCursor, updatedAt]
  )
}

function toClaim(input: {
  linkId: string
  tenantId: string
  normalized: NormalizedSessionLinkKey
  createdAt: string
}): SessionLinkClaim {
  return {
    linkId: input.linkId,
    tenantId: input.tenantId,
    kind: input.normalized.kind,
    repo: input.normalized.repo,
    repoKey: input.normalized.repoKey,
    value: input.normalized.value,
    createdAt: input.createdAt
  }
}

async function insertKey(sql: Sql, style: SqlStyle, input: {
  linkId: string
  tenantId: string
  normalized: NormalizedSessionLinkKey
  createdAt: string
}) {
  await sql.run(
    `INSERT INTO session_link_key (link_id, kind, repo, repo_key, value, tenant_id, created_at)
     VALUES (${placeholders(style, 7)})`,
    [
      input.linkId,
      input.normalized.kind,
      input.normalized.repo,
      input.normalized.repoKey,
      input.normalized.value,
      input.tenantId,
      input.createdAt
    ]
  )
}

async function fetchKey(sql: Sql, style: SqlStyle, tenantId: string, key: NormalizedSessionLinkKey): Promise<KeyMatch | null> {
  const rows = await loadMatches(sql, style, tenantId, [key])
  return rows[0] ?? null
}

async function loadMatches(sql: Sql, style: SqlStyle, tenantId: string, keys: NormalizedSessionLinkKey[]): Promise<KeyMatch[]> {
  const params: SqlValue[] = [tenantId]
  const clauses: string[] = []
  for (const key of keys) {
    const kind = placeholder(style, params.length + 1)
    const repoKey = placeholder(style, params.length + 2)
    const value = placeholder(style, params.length + 3)
    clauses.push(`(k.kind = ${kind} AND k.repo_key = ${repoKey} AND k.value = ${value})`)
    params.push(key.kind, key.repoKey, key.value)
  }
  const rows = await sql.all(
    `SELECT k.link_id, k.kind, k.repo_key, k.value, k.created_at AS key_created_at,
            s.id AS session_id, s.tenant_id AS session_tenant_id, s.opencode_session_id,
            s.status AS session_status, s.created_at AS session_created_at, s.updated_at AS session_updated_at
     FROM session_link_key k
     LEFT JOIN session_link s ON s.id = k.link_id AND s.tenant_id = k.tenant_id
     WHERE k.tenant_id = ${placeholder(style, 1)} AND (${clauses.join(" OR ")})`,
    params
  )
  return rows.map(row => ({
    linkId: asString(row.link_id),
    kind: asString(row.kind),
    repoKey: asString(row.repo_key),
    value: asString(row.value),
    keyCreatedAt: asTimestamp(row.key_created_at),
    link: row.session_id == null ? null : toSessionLink(row)
  }))
}

async function abandonSessionLinkClaim(sql: Sql, style: SqlStyle, input: AbandonSessionLinkClaimInput): Promise<void> {
  const tenantId = requireText("tenantId", input.tenantId)
  const linkId = requireText("linkId", input.linkId)
  // Immediate abandon of an unpromoted claim (LLD §2 step 4). Same NOT EXISTS
  // guard as deleteKeyRow: a promoted session_link keeps its key rows. Age is
  // irrelevant — a failed createSession must not wait out the orphan timeout.
  await sql.run(
    `DELETE FROM session_link_key
     WHERE tenant_id = ${placeholder(style, 1)}
       AND link_id = ${placeholder(style, 2)}
       AND NOT EXISTS (SELECT 1 FROM session_link s WHERE s.id = session_link_key.link_id)`,
    [tenantId, linkId]
  )
}

// harness.ts reactivation (§6 step 4) and comment routing (§6 step 6) need to
// flip status and updated_at. Neither existed on RunStore; this is that writer.
async function updateSessionLinkStatus(sql: Sql, style: SqlStyle, input: UpdateSessionLinkStatusInput): Promise<SessionLink> {
  const tenantId = requireText("tenantId", input.tenantId)
  const linkId = requireText("linkId", input.linkId)
  const updatedAt = requireText("updatedAt", input.updatedAt)
  if (!SESSION_LINK_STATUSES.has(input.status)) {
    throw new Error(`invalid session link status: ${input.status}`)
  }
  const rows = await sql.all(
    `UPDATE session_link
     SET status = ${placeholder(style, 1)}, updated_at = ${placeholder(style, 2)}
     WHERE id = ${placeholder(style, 3)} AND tenant_id = ${placeholder(style, 4)}
     RETURNING id, tenant_id, opencode_session_id, status, created_at, updated_at`,
    [input.status, updatedAt, linkId, tenantId]
  )
  if (rows.length === 0) {
    throw new Error(`cannot update session link ${linkId}: no row for this tenant`)
  }
  return toSessionLink(rows[0])
}

async function deleteKeyRow(sql: Sql, style: SqlStyle, tenantId: string, row: KeyMatch): Promise<number> {
  return sql.run(
    `DELETE FROM session_link_key
     WHERE tenant_id = ${placeholder(style, 1)}
       AND link_id = ${placeholder(style, 2)}
       AND kind = ${placeholder(style, 3)}
       AND repo_key = ${placeholder(style, 4)}
       AND value = ${placeholder(style, 5)}
       AND created_at = ${placeholder(style, 6)}
       AND NOT EXISTS (SELECT 1 FROM session_link s WHERE s.id = session_link_key.link_id)`,
    [tenantId, row.linkId, row.kind, row.repoKey, row.value, row.keyCreatedAt]
  )
}

function classifyMatches(rows: KeyMatch[], now: number) {
  const expired: KeyMatch[] = []
  const activeByLink = new Map<string, { linkId: string; createdAt: string; link: SessionLink | null }>()
  for (const row of rows) {
    if (isExpiredOrphan(row.keyCreatedAt, row.link !== null, now)) {
      expired.push(row)
      continue
    }
    const prev = activeByLink.get(row.linkId)
    if (!prev) {
      activeByLink.set(row.linkId, { linkId: row.linkId, createdAt: row.keyCreatedAt, link: row.link })
      continue
    }
    if (row.link) prev.link = row.link
    if (Date.parse(row.keyCreatedAt) < Date.parse(prev.createdAt)) prev.createdAt = row.keyCreatedAt
  }
  return { expired, activeByLink }
}

function resolutionFromActive(
  activeByLink: Map<string, { linkId: string; createdAt: string; link: SessionLink | null }>
): SessionLinkResolution {
  if (activeByLink.size === 0) return { state: "none" }
  if (activeByLink.size > 1) {
    throw new SessionLinkResolveConflictError([...activeByLink.keys()].sort())
  }
  const only = [...activeByLink.values()][0]
  if (only.link) return { state: "linked", link: only.link }
  return { state: "pending", linkId: only.linkId, createdAt: only.createdAt }
}

function isExpiredOrphan(createdAt: string, hasSession: boolean, now: number): boolean {
  if (hasSession) return false
  const created = Date.parse(createdAt)
  if (Number.isNaN(created)) return false
  return now - created >= SESSION_LINK_ORPHAN_TIMEOUT_MS
}

function dedupeKeys(keys: NormalizedSessionLinkKey[]): NormalizedSessionLinkKey[] {
  const seen = new Set<string>()
  const out: NormalizedSessionLinkKey[] = []
  for (const key of keys) {
    const id = `${key.kind}\0${key.repoKey}\0${key.value}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push(key)
  }
  return out
}

function toSessionLink(row: SqlRow): SessionLink {
  const status = asString(row.session_status ?? row.status)
  if (!SESSION_LINK_STATUSES.has(status as SessionLinkStatus)) {
    throw new Error(`invalid session link status: ${status}`)
  }
  return {
    id: asString(row.session_id ?? row.id),
    tenantId: asString(row.session_tenant_id ?? row.tenant_id),
    opencodeSessionId: asString(row.opencode_session_id),
    status: status as SessionLinkStatus,
    createdAt: asTimestamp(row.session_created_at ?? row.created_at),
    updatedAt: asTimestamp(row.session_updated_at ?? row.updated_at)
  }
}

function placeholder(style: SqlStyle, index: number): string {
  return style === "pg" ? `$${index}` : "?"
}

function placeholders(style: SqlStyle, count: number): string {
  return Array.from({ length: count }, (_, index) => placeholder(style, index + 1)).join(",")
}

function requireText(name: string, value: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`)
  return value
}

function asString(value: unknown): string {
  if (typeof value !== "string") throw new Error(`expected string, got ${typeof value}`)
  return value
}

function asTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  return asString(value)
}

function isUniqueViolation(error: unknown): boolean {
  const code = errorCode(error)
  return code === "23505" || code === "SQLITE_CONSTRAINT_UNIQUE"
}

function isPrimaryKeyViolation(error: unknown): boolean {
  return errorCode(error) === "SQLITE_CONSTRAINT_PRIMARYKEY"
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) return ""
  return String((error as { code: unknown }).code)
}
