// Opt-in live KPI3 check. Not a unit test and not the fake-Jira harness E2E.
//
// Proves, only after --confirm-live-write:
// - sharing stays off (omitted or false) and this process does not call
//   POST /session/{id}/share or any message/prompt turn
// - real Jira poll assignment (createJiraPollLoop + createHarnessBackedJiraPoller)
//   and write-back read-back of the resume command
// - GitHub REST read-back (gh) of a PR body that already contains a parseable
//   jira:KEY hint. This script never PATCHes the PR.
// - direct handleAssignmentEvent({ source: "github_pr" }) reuses that one session
// - a temp SQLite file, not DATABASE_URL, JOINs to one session_link
//
// GitHub poll pickup is NOT exercised. pollAssignedPullRequests is not called.
//
// Writes this script may make, and only on the fixture issue:
// - one bot comment if the issue is outside the poll overlap window
// - the poller's own write-back comment (the behavior under test)
// Non-fixture Jira events in the same search window are ignored so this
// process cannot comment on other tickets.

import { execFile } from "node:child_process"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import os from "node:os"
import path from "node:path"
import type { AppConfig, TenantConfig } from "../src/types.js"
import type { JiraAssignmentEvent, JiraCommentEvent, JiraPollHarness } from "../src/jira-poll.js"

const SANDBOX_SUMMARY = /test|e2e|sandbox|verification/i
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/
const REPO_RE = /^[^/\s]+\/[^/\s]+$/
const GH_BIN = "/opt/homebrew/bin/gh"

type Args = {
  confirm: boolean
  issueKey?: string
  pr?: number
  tenantId?: string
  repo?: string
  keepDb: boolean
  help: boolean
  unknown: string[]
}

type GhPull = {
  number: number
  state: string
  title: string
  body: string | null
  head?: { ref?: string }
  html_url?: string
}

class GuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GuardError"
  }
}

const parsed = parseArgs(process.argv.slice(2))
if (!ready(parsed)) {
  console.error(usage(parsed))
  console.error("MARKER: refused-before-network")
  console.error("No config loaded, no credentials read, no API called.")
  process.exit(2)
}

try {
  await run(parsed)
} catch (error) {
  const message = redact(error instanceof Error ? error.message : String(error))
  console.error(message)
  console.error(error instanceof GuardError ? "MARKER: refused" : "MARKER: fail")
  process.exit(error instanceof GuardError ? 2 : 1)
}

function ready(args: Args): boolean {
  return args.confirm && args.unknown.length === 0 && Boolean(args.issueKey) && args.pr != null && !args.help
}

function usage(args: Args): string {
  const problems: string[] = []
  if (args.help) problems.push("help requested")
  if (!args.confirm) problems.push("missing --confirm-live-write")
  if (!args.issueKey) problems.push("missing --issue-key")
  if (args.pr == null) problems.push("missing --pr")
  if (args.unknown.length > 0) problems.push(`unknown args: ${args.unknown.join(" ")}`)
  return [
    "Refusing to run the live KPI3 integration test.",
    problems.join("; ") || "guards not satisfied",
    "",
    "npm run test:kpi3-live -- --confirm-live-write --issue-key KAN-5 --pr 729",
    "",
    "Required env at runtime (never written by this script): JIRA_EMAIL, JIRA_API_TOKEN.",
    "Optional: CONFIG_PATH, OPENCODE_BIN.",
    "GitHub reads use `gh api` (no token printed). The PR is not modified.",
    "A temp SQLite file is used. DATABASE_URL is ignored."
  ].join("\n")
}

function parseArgs(argv: string[]): Args {
  const args: Args = { confirm: false, keepDb: false, help: false, unknown: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1]
    if (arg === "--help" || arg === "-h") args.help = true
    else if (arg === "--confirm-live-write") args.confirm = true
    else if (arg === "--keep-db") args.keepDb = true
    else if (arg === "--issue-key" && next) {
      args.issueKey = next
      i += 1
    } else if (arg === "--pr" && next) {
      args.pr = Number(next)
      i += 1
    } else if (arg === "--tenant" && next) {
      args.tenantId = next
      i += 1
    } else if (arg === "--repo" && next) {
      args.repo = next
      i += 1
    } else args.unknown.push(arg)
  }
  return args
}

async function run(args: Args): Promise<void> {
  const issueKey = args.issueKey ?? ""
  const prNumber = args.pr ?? 0
  if (!ISSUE_KEY_RE.test(issueKey)) throw new GuardError(`invalid --issue-key ${issueKey}`)
  if (!Number.isInteger(prNumber) || prNumber <= 0) throw new GuardError(`invalid --pr ${String(args.pr)}`)

  const email = process.env.JIRA_EMAIL
  const token = process.env.JIRA_API_TOKEN
  if (!email || !token) {
    throw new GuardError("JIRA_EMAIL and JIRA_API_TOKEN must be set in the environment. Config-file jira secrets are not used.")
  }

  const configMod = await import("../src/config.js")
  const jiraPoll = await import("../src/jira-poll.js")
  const harnessMod = await import("../src/harness.js")
  const links = await import("../src/session-links.js")
  const storage = await import("../src/storage.js")
  const sessionApi = await import("../src/opencode-session.js")
  const jiraTypes = await import("../src/jira-types.js")
  const jiraAuth = await import("../src/jira-auth.js")
  const { default: Database } = await import("better-sqlite3")

  const env = configMod.loadEnv()
  const loaded = await configMod.loadConfig(env.configPath)
  const tenant = selectTenant(loaded, issueKey, args.tenantId, args.repo)
  const jira = tenant.jira
  if (!jira) throw new GuardError("selected tenant has no jira block")
  const repo = jira.repo
  if (tenant.opencode?.sharingEnabled === true) {
    throw new GuardError("tenant.opencode.sharingEnabled is true. Refusing so this run cannot call the public share endpoint.")
  }
  const sharingState = tenant.opencode?.sharingEnabled === false ? "explicit false" : "omitted (default off)"
  console.log(`MARKER: sharing-default-off ${sharingState}`)

  const configuredRepoPath = tenant.repos.find(item => item.fullName === repo)?.path ?? ""
  console.log(`MARKER: sandbox-allowlist tenant=${tenant.id} repo=${repo} allowlist=${(tenant.github?.repoAllowlist ?? []).join(",")} configuredRepoPathExists=${existsSync(configuredRepoPath)}`)
  console.log("MARKER: credentials-from-env-only config jiraEmail/jiraApiToken are not read")
  if (loaded.secrets?.jiraApiToken || loaded.secrets?.jiraEmail) {
    console.log("MARKER: config file has jira secret fields; ignored")
  }

  const mainDb = sqliteFileFromUrl(env.databaseUrl)
  const dbDir = mkdtempSync(path.join(scratchRoot(), "codebridge-kpi3-live-"))
  const dbPath = path.join(dbDir, "kpi3-live.sqlite")
  if (mainDb && path.resolve(dbPath) === path.resolve(mainDb)) {
    throw new GuardError("temp db resolved to DATABASE_URL; refusing")
  }
  console.log(`MARKER: temp-sqlite-db ${dbPath}`)
  console.log(`MARKER: ignored-database-url ${env.databaseUrl}`)

  console.log("LIVE WRITE PLAN: no writes yet.")
  console.log(`- GitHub GET only: ${repo}#${prNumber}. PR will not be modified.`)
  console.log(`- Jira GET, then maybe one bot comment on ${issueKey} if it is outside the poll window.`)
  console.log("- Jira poller may POST one write-back comment (resume command, not a share URL).")
  console.log("- One local opencode session. No /message, no /prompt, no /share.")
  console.log("- Direct handleAssignmentEvent for the PR afterwards. GitHub polling is not run.")

  const pullBefore = await ghPull(repo, prNumber)
  assertPullFixture(pullBefore, repo, prNumber, issueKey)
  console.log(`MARKER: github-pr-body-readback status=GET state=${pullBefore.state} hint=jira:${issueKey}`)

  const authHeader = jiraAuth.buildJiraBasicAuthHeader(email, token)
  const jiraHeaders = { authorization: authHeader, accept: "application/json" }
  const myself = await jiraFetch(jira.baseUrl, "/rest/api/3/myself", jiraHeaders)
  const myselfBody = await readJson(myself, "jira myself")
  const myselfId = recordField(myselfBody, "accountId")
  if (myself.status !== 200 || myselfId !== jira.agentAccountId) {
    throw new GuardError(`Jira caller accountId does not match tenant jira.agentAccountId (status ${myself.status})`)
  }
  const issue = await jiraFetch(jira.baseUrl, `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,assignee,updated`, jiraHeaders)
  const issueBody = await readJson(issue, "jira issue")
  const fields = recordField(issueBody, "fields")
  const summary = fields && typeof fields === "object" ? recordField(fields, "summary") : undefined
  const assignee = fields && typeof fields === "object" ? recordField(fields, "assignee") : undefined
  const assigneeId = assignee && typeof assignee === "object" ? recordField(assignee, "accountId") : undefined
  if (issue.status !== 200 || typeof summary !== "string" || !SANDBOX_SUMMARY.test(summary)) {
    throw new GuardError(`fixture ${issueKey} summary is missing or not a sandbox/test ticket (status ${issue.status})`)
  }
  if (assigneeId !== jira.agentAccountId) {
    throw new GuardError(`fixture ${issueKey} is not assigned to the configured agent account. This script will not assign it.`)
  }
  console.log(`MARKER: jira-fixture-readback key=${issueKey} assigned=agent summaryOk=true`)

  const opencodeBin = process.env.OPENCODE_BIN ?? path.join(os.homedir(), ".opencode", "bin", "opencode")
  if (!existsSync(opencodeBin)) throw new GuardError(`opencode binary not found at ${opencodeBin}`)
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const workDir = await mkdtemp(path.join(scratchRoot(), "codebridge-kpi3-live-repo-"))
  const opencode = spawn(opencodeBin, ["serve", "--port", String(port), "--hostname", "127.0.0.1", "--print-logs"], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  })
  const guard = installOpencodeGuard(baseUrl)
  const store = storage.createSqliteStore(dbPath)
  let failed = false
  try {
    await waitForServer(baseUrl, opencode)
    await store.ensureSchema()
    const scoped: AppConfig = {
      tenants: [{
        ...tenant,
        repos: tenant.repos.map(item => item.fullName === repo ? { ...item, path: workDir } : item),
        opencode: tenant.opencode?.sharingEnabled === false ? { sharingEnabled: false } : undefined
      }]
    }
    const ctx = {
      store,
      config: scoped,
      opencodeConfig: { baseUrl, timeoutMs: 20_000 }
    }
    const sessionConfig = harnessMod.opencodeSessionConfigFor(ctx, tenant.id)
    if (sessionConfig.shareBaseUrl) {
      throw new GuardError("opencodeSessionConfigFor set shareBaseUrl while sharing is off")
    }
    console.log("MARKER: share-gate-unset")

    const skipped: string[] = []
    let commentEvents = 0
    const real = jiraPoll.createHarnessBackedJiraPoller(ctx)
    const harness: JiraPollHarness = {
      async onAssignmentEvent(ev: JiraAssignmentEvent) {
        if (ev.issueKey !== issueKey) {
          skipped.push(ev.issueKey)
          return
        }
        await real.onAssignmentEvent(ev)
      },
      async onCommentEvent(ev: JiraCommentEvent) {
        commentEvents += 1
        skipped.push(`comment:${ev.issueKey}`)
      }
    }
    const loop = jiraPoll.createJiraPollLoop({
      config: scoped,
      store,
      harness,
      env: { jiraEmail: email, jiraApiToken: token }
    })
    if (!loop) throw new Error("createJiraPollLoop returned null")

    const pre = await links.resolveLink(store, tenant.id, [{ kind: "jira", issueKey }])
    if (pre) throw new Error("temp db already had a jira link before the poll")
    await loop.tick()
    const cursor = await store.getJiraPollState(tenant.id)
    if (!cursor) throw new Error("Jira poll tick did not persist jira_poll_state; not writing a trigger comment")

    let link = await links.resolveLink(store, tenant.id, [{ kind: "jira", issueKey }])
    if (!link) {
      const trigger = `KPI3 disposable bot comment ${new Date().toISOString()}. Enters the Jira poll window only. No public share.`
      const posted = await fetch(new URL(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, stripSlash(jira.baseUrl)), {
        method: "POST",
        headers: { ...jiraHeaders, "content-type": "application/json" },
        body: JSON.stringify({ body: jiraTypes.textToAdf(trigger) })
      })
      if (posted.status !== 201) {
        const detail = redact(await posted.text())
        throw new Error(`trigger comment failed (${posted.status}): ${detail.slice(0, 300)}`)
      }
      const postedBody = await posted.json() as { id?: string }
      console.log(`MARKER: disposable-jira-bot-comment id=${postedBody.id ?? "unknown"} purpose=poll-window`)
      for (let attempt = 1; attempt <= 3 && !link; attempt += 1) {
        await delay(2000)
        await loop.tick()
        link = await links.resolveLink(store, tenant.id, [{ kind: "jira", issueKey }])
      }
    } else {
      console.log("MARKER: disposable-jira-bot-comment skipped issue already inside poll window")
    }
    if (!link?.opencodeSessionId) throw new Error(`real Jira poll did not bootstrap ${issueKey}`)
    if (commentEvents > 0) {
      throw new Error(`refusing success: poll offered ${commentEvents} comment event(s); they were not forwarded (that path is an LLM turn)`)
    }
    const sessionId = link.opencodeSessionId
    console.log(`MARKER: jira-poll-assignment session=${sessionId} skippedNonFixture=${skipped.length}`)
    const status = await sessionApi.getSessionStatus(sessionId, { baseUrl, timeoutMs: 20_000 })
    if (status === "not_found") throw new Error(`opencode does not have session ${sessionId}`)

    const comments = await listComments(jira.baseUrl, issueKey, jiraHeaders)
    const resume = harnessMod.unsharedSessionReply(sessionId)
    const writeBack = comments.find(comment => jiraTypes.adfToText(comment.body).includes(`opencode --resume ${sessionId}`))
    const writeBackText = writeBack ? jiraTypes.adfToText(writeBack.body) : ""
    if (!writeBack || !writeBackText.includes("not sharing") || /https?:\/\//i.test(writeBackText) || writeBackText.includes("/share")) {
      throw new Error(`Jira write-back read-back missing resume command for ${sessionId}`)
    }
    console.log(`MARKER: jira-writeback-readback commentId=${writeBack.id ?? "unknown"}`)
    console.log(writeBackText)

    const shareCalls = guard.calls.filter(call => call.includes("/share") || call.includes("/message") || call.includes("/prompt"))
    if (shareCalls.length > 0) throw new Error(`opencode client called a forbidden path: ${shareCalls.join(",")}`)
    if (!guard.calls.some(call => call.startsWith("POST /session"))) {
      throw new Error(`expected POST /session, saw ${guard.calls.join(" | ") || "no opencode calls"}`)
    }
    console.log(`MARKER: no-share-endpoint calls=${guard.calls.join(" | ")}`)
    console.log("MARKER: no-llm-turn")

    const pullAfter = await ghPull(repo, prNumber)
    if (pullAfter.body !== pullBefore.body) throw new Error("GitHub PR body changed. This test must not modify the PR.")
    assertPullFixture(pullAfter, repo, prNumber, issueKey)
    console.log("MARKER: github-pr-body-unchanged read-back matches the pre-write GET")

    const callsBeforeDirect = guard.calls.length
    console.log("MARKER: direct-pr-handler-not-github-poll")
    console.log("This calls handleAssignmentEvent({ source: \"github_pr\" }). It does not call startGitHubPolling or pollAssignedPullRequests. GitHub poll pickup was NOT exercised.")
    const direct = await harnessMod.handleAssignmentEvent(ctx, {
      source: "github_pr",
      tenantId: tenant.id,
      keys: [{ kind: "gh_pr", repo, number: prNumber }],
      repoPath: workDir,
      title: pullAfter.title,
      body: pullAfter.body ?? undefined,
      branch: pullAfter.head?.ref
    })
    if (direct.sessionId !== sessionId) {
      throw new Error(`direct PR handler created or selected ${direct.sessionId}, expected ${sessionId}`)
    }
    if (direct.reply !== resume) throw new Error("direct PR handler reply was not the unshared resume command")
    if (guard.calls.length !== callsBeforeDirect) {
      throw new Error(`direct PR handler performed opencode calls: ${guard.calls.slice(callsBeforeDirect).join(" | ")}`)
    }
    const byPr = await links.resolveLink(store, tenant.id, [{ kind: "gh_pr", repo, number: prNumber }])
    const byJira = await links.resolveLink(store, tenant.id, [{ kind: "jira", issueKey }])
    if (!byPr || !byJira || byPr.id !== byJira.id || byPr.opencodeSessionId !== sessionId) {
      throw new Error("PR key and Jira key do not resolve to the same session link")
    }

    const sql = [
      "SELECT s.id, s.tenant_id, s.opencode_session_id, s.status, s.created_at, s.updated_at,",
      "       k.kind, k.repo, k.repo_key, k.value, k.created_at AS key_created_at",
      "FROM session_link s",
      "JOIN session_link_key k ON k.link_id = s.id AND k.tenant_id = s.tenant_id",
      "ORDER BY s.id, k.kind, k.value"
    ].join("\n")
    console.log("MARKER: sqlite-join-sql")
    console.log(sql)
    const db = new Database(dbPath, { readonly: true, fileMustExist: true })
    let rows: unknown[]
    try {
      rows = db.prepare(sql).all()
    } finally {
      db.close()
    }
    console.log("MARKER: sqlite-join-raw-rows")
    console.log(JSON.stringify(rows, null, 2))
    const linkIds = new Set(rows.map(row => recordField(row, "id")))
    const sessionIds = new Set(rows.map(row => recordField(row, "opencode_session_id")))
    const hasJira = rows.some(row => recordField(row, "kind") === "jira" && recordField(row, "value") === issueKey.toLowerCase())
    const hasPr = rows.some(row =>
      recordField(row, "kind") === "gh_pr"
      && recordField(row, "value") === String(prNumber)
      && recordField(row, "repo_key") === repo.toLowerCase()
    )
    if (rows.length < 2 || linkIds.size !== 1 || sessionIds.size !== 1 || !hasJira || !hasPr) {
      throw new Error("JOIN did not show exactly one session linked to both the Jira key and the GitHub PR")
    }
    console.log("MARKER: sqlite-join-one-session")
    console.log("RESULT: PASS for live Jira poll + write-back read-back + GitHub GET read-back + direct PR handler. GitHub poll pickup was NOT exercised.")
  } catch (error) {
    failed = true
    throw error
  } finally {
    guard.restore()
    await stopChild(opencode)
    await rm(workDir, { recursive: true, force: true })
    if (args.keepDb && !failed) {
      console.log(`MARKER: kept-temp-db ${dbPath}`)
    } else {
      rmSync(dbDir, { recursive: true, force: true })
      console.log(`MARKER: deleted-temp-db ${dbPath}`)
    }
  }
}

function selectTenant(config: AppConfig, issueKey: string, tenantId: string | undefined, repoFlag: string | undefined): TenantConfig {
  const projectKey = issueKey.slice(0, issueKey.indexOf("-"))
  const matches = config.tenants.filter(tenant => tenant.jira?.projectKey === projectKey && (!tenantId || tenant.id === tenantId))
  if (matches.length !== 1) {
    throw new GuardError(`expected one tenant with jira project ${projectKey}, found ${matches.map(tenant => tenant.id).join(",") || "none"}. Pass --tenant if needed.`)
  }
  const tenant = matches[0]
  const jira = tenant.jira
  if (!jira) throw new GuardError("tenant jira block missing")
  const allowlist = tenant.github?.repoAllowlist ?? []
  if (allowlist.length === 0) throw new GuardError(`tenant ${tenant.id} has an empty github.repoAllowlist; refusing`)
  if (repoFlag && repoFlag !== jira.repo) throw new GuardError(`--repo ${repoFlag} does not match tenant jira.repo ${jira.repo}`)
  if (!REPO_RE.test(jira.repo)) throw new GuardError(`tenant jira.repo is not owner/name`)
  if (!allowlist.some(item => item.toLowerCase() === jira.repo.toLowerCase())) {
    throw new GuardError(`${jira.repo} is not in tenant ${tenant.id} github.repoAllowlist`)
  }
  if (!tenant.repos.some(item => item.fullName === jira.repo)) {
    throw new GuardError(`${jira.repo} is not an exact tenant.repos fullName. The poller requires that match.`)
  }
  return tenant
}

function assertPullFixture(pull: GhPull, repo: string, prNumber: number, issueKey: string): void {
  if (pull.number !== prNumber) throw new GuardError(`GitHub returned PR ${pull.number}, expected ${prNumber}`)
  const hints = extractJiraHints(pull.body ?? "")
  const wanted = issueKey.toLowerCase()
  if (!hints.some(hint => hint.toLowerCase() === wanted)) {
    throw new GuardError(`PR ${repo}#${prNumber} body has no parseable jira:${issueKey} hint (jira:KEY, jira=KEY, or /browse/KEY). This script will not modify the PR.`)
  }
}

function extractJiraHints(text: string): string[] {
  const key = "[A-Za-z][A-Za-z0-9]+-\\d+"
  const found = [
    ...text.matchAll(new RegExp(`(?:^|\\s)jira\\s*[:=]\\s*(${key})\\b`, "gi")),
    ...text.matchAll(new RegExp(`\\/browse\\/(${key})\\b`, "gi"))
  ]
  return found.map(match => match[1])
}

async function ghPull(repo: string, prNumber: number): Promise<GhPull> {
  const apiPath = `repos/${repo}/pulls/${prNumber}`
  const stdout = await execGh(["api", apiPath])
  const parsed = JSON.parse(stdout) as GhPull
  if (!parsed || typeof parsed.number !== "number" || typeof parsed.title !== "string") {
    throw new Error(`GitHub GET ${apiPath} returned an unexpected pull payload`)
  }
  return parsed
}

function execGh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(GH_BIN, args, { timeout: 20_000, maxBuffer: 2_000_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`gh ${args.join(" ")} failed: ${redact(stderr || error.message).slice(0, 300)}`))
        return
      }
      resolve(stdout)
    })
  })
}

async function jiraFetch(baseUrl: string, pathname: string, headers: Record<string, string>): Promise<Response> {
  return fetch(new URL(pathname, stripSlash(baseUrl)), { headers })
}

async function listComments(baseUrl: string, issueKey: string, headers: Record<string, string>): Promise<Array<{ id?: string; body?: unknown }>> {
  const response = await jiraFetch(
    baseUrl,
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment?startAt=0&maxResults=100&orderBy=-created`,
    headers
  )
  const body = await readJson(response, "jira comments")
  if (response.status !== 200) throw new Error(`Jira comment read-back failed (${response.status})`)
  const comments = recordField(body, "comments")
  if (!Array.isArray(comments)) throw new Error("Jira comment read-back had no comments array")
  return comments as Array<{ id?: string; body?: unknown }>
}

async function readJson(response: Response, label: string): Promise<unknown> {
  const text = await response.text()
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`${label} returned non-JSON (${response.status}): ${redact(text).slice(0, 200)}`)
  }
}

function installOpencodeGuard(baseUrl: string): { calls: string[]; restore: () => void } {
  const origin = new URL(baseUrl).origin
  const calls: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const raw = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url
    let parsed: URL | null = null
    try {
      parsed = new URL(raw)
    } catch {
      parsed = null
    }
    if (parsed && parsed.origin === origin) {
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
      const record = `${method} ${parsed.pathname}`
      calls.push(record)
      if (["/share", "/message", "/prompt"].some(part => parsed.pathname.includes(part))) {
        throw new Error(`refusing ${record}; share endpoint and LLM turns are out of scope`)
      }
    }
    return original(input as Parameters<typeof fetch>[0], init)
  }
  return {
    calls,
    restore() {
      globalThis.fetch = original
    }
  }
}

function sqliteFileFromUrl(databaseUrl: string): string | null {
  if (!databaseUrl || databaseUrl === ":memory:") return null
  if (databaseUrl.startsWith("sqlite://")) return path.resolve(databaseUrl.slice("sqlite://".length))
  if (databaseUrl.startsWith("sqlite:")) {
    const file = databaseUrl.slice("sqlite:".length)
    return file ? path.resolve(file) : null
  }
  return path.resolve(databaseUrl)
}

function recordField(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined
  return (value as Record<string, unknown>)[key]
}

function stripSlash(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "")
}

function redact(text: string): string {
  return text
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?token|password|private[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
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

async function waitForServer(url: string, proc: ChildProcess): Promise<void> {
  const deadline = Date.now() + 40_000
  let last = "not started"
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`opencode serve exited ${proc.exitCode}: ${last}`)
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

async function stopChild(proc: ChildProcess): Promise<void> {
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

function scratchRoot(): string {
  const home = process.env.HERMES_HOME
  if (!home) throw new GuardError("HERMES_HOME is not set; refusing to write under os.tmpdir()")
  const dir = path.join(home, "cache", "scratch")
  mkdirSync(dir, { recursive: true })
  return dir
}
