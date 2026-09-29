// Opt-in live KPI3 check. Not a unit test and not the fake-Jira harness E2E.
//
// Proves, only after --confirm-live-write and the pinned fixture:
// - sharing stays off (omitted or false) and this process does not call
//   POST /session/{id}/share or any message/prompt turn
// - real Jira poll assignment (createJiraPollLoop + createHarnessBackedJiraPoller)
//   and write-back read-back of the resume command
// - GitHub REST read-back (gh on PATH) of a PR body that already contains a
//   parseable jira:KEY hint. This script never PATCHes the PR.
// - direct handleAssignmentEvent({ source: "github_pr" }) reuses that one session
// - a temp SQLite file, not DATABASE_URL, JOINs to one session_link
//
// GitHub poll pickup is NOT exercised. pollAssignedPullRequests is not called.
// The github_pr path is a direct handler call, not bot issue pickup.
//
// Writes this script may make, and only on the pinned fixture issue:
// - one bot comment if the issue is outside the poll overlap window
// - the poller's own write-back comment (the behavior under test)
// The disposable trigger comment is deleted only after a read-back of the
// comment id this run created. Other comments are never deleted.
// Non-fixture Jira events in the same search window are ignored so this
// process cannot comment on other tickets.
//
// A failed temp SQLite file is kept and its path is printed. A successful
// run deletes it unless --keep-db.

import { execFile } from "node:child_process"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import type { AppConfig, TenantConfig } from "../src/types.js"
import type { JiraAssignmentEvent, JiraCommentEvent, JiraPollHarness } from "../src/jira-poll.js"
import { redact, startOpencodeServe, type OpencodeServeHandle } from "./lib/opencode-serve.js"
import {
  FIXTURE_ISSUE_KEY,
  FIXTURE_PR,
  FIXTURE_REPO,
  GuardError,
  assertContained,
  assertScratchIsolated,
  assertSummaryBeforeJiraWrite,
  fixturePinProblems,
  resolveScratchRoot,
  sqliteFileFromUrl,
  type PinArgs
} from "./lib/kpi3-guards.js"

const ISSUE_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/
const REPO_RE = /^[^/\s]+\/[^/\s]+$/

type Args = PinArgs & { keepDb: boolean; tenantId?: string }

type GhPull = {
  number: number
  state: string
  title: string
  body: string | null
  head?: { ref?: string }
  html_url?: string
}

type OwnedComment = { id?: string; marker: string }

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
  return fixturePinProblems(args).length === 0
}

function usage(args: Args): string {
  const problems = fixturePinProblems(args)
  return [
    "Refusing to run the live KPI3 integration test.",
    problems.join("; ") || "guards not satisfied",
    "",
    `npm run test:kpi3-live -- --confirm-live-write --issue-key ${FIXTURE_ISSUE_KEY} --pr ${FIXTURE_PR} --repo ${FIXTURE_REPO}`,
    "",
    "The issue key, PR, and repo are pinned. Any other value is refused before credentials or network.",
    "Required env at runtime (never written by this script): JIRA_EMAIL, JIRA_API_TOKEN.",
    "Optional: CONFIG_PATH, OPENCODE_BIN, CODEBRIDGE_SCRATCH_DIR.",
    "GitHub reads use `gh` from PATH (no token printed). The PR is not modified.",
    "A temp SQLite file is used. DATABASE_URL is ignored.",
    "Failed temp databases are kept. Successful ones are deleted unless --keep-db."
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
  const pinProblems = fixturePinProblems(args)
  if (pinProblems.length > 0) throw new GuardError(pinProblems.join("; "))
  const issueKey = args.issueKey ?? ""
  const prNumber = args.pr ?? 0
  if (!ISSUE_KEY_RE.test(issueKey)) throw new GuardError(`invalid --issue-key ${issueKey}`)
  if (!Number.isInteger(prNumber) || prNumber <= 0) throw new GuardError(`invalid --pr ${String(args.pr)}`)

  const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
  const databaseFile = sqliteFileFromUrl(process.env.DATABASE_URL ?? "sqlite://./data/codebridge.db")
  const scratch = resolveScratchRoot({
    env: process.env,
    repoRoots: [repoRoot],
    databaseFile,
    tmpdir: os.tmpdir()
  })
  console.log(`MARKER: scratch-root source=${scratch.source} path=${scratch.root}`)

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
  if (repo !== FIXTURE_REPO) throw new GuardError(`tenant jira.repo ${repo} is not the pinned fixture ${FIXTURE_REPO}`)
  const configuredRepoPath = tenant.repos.find(item => item.fullName === repo)?.path ?? ""
  assertScratchIsolated(scratch.root, {
    repoRoots: configuredRepoPath ? [repoRoot, configuredRepoPath] : [repoRoot],
    databaseFile: sqliteFileFromUrl(env.databaseUrl)
  })
  if (tenant.opencode?.sharingEnabled === true) {
    throw new GuardError("tenant.opencode.sharingEnabled is true. Refusing so this run cannot call the public share endpoint.")
  }
  const sharingState = tenant.opencode?.sharingEnabled === false ? "explicit false" : "omitted (default off)"
  console.log(`MARKER: sharing-default-off ${sharingState}`)

  console.log(`MARKER: sandbox-allowlist tenant=${tenant.id} repo=${repo} allowlist=${(tenant.github?.repoAllowlist ?? []).join(",")} configuredRepoPathExists=${existsSync(configuredRepoPath)}`)
  console.log("MARKER: credentials-from-env-only config jiraEmail/jiraApiToken are not read")
  if (loaded.secrets?.jiraApiToken || loaded.secrets?.jiraEmail) {
    console.log("MARKER: config file has jira secret fields; ignored")
  }

  const mainDb = sqliteFileFromUrl(env.databaseUrl)
  const dbDir = mkdtempSync(path.join(scratch.root, "codebridge-kpi3-live-"))
  assertContained(scratch.root, dbDir)
  const dbPath = path.join(dbDir, "kpi3-live.sqlite")
  if (mainDb && path.resolve(dbPath) === path.resolve(mainDb)) {
    rmSync(dbDir, { recursive: true, force: true })
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

  let workDir = ""
  let serve: OpencodeServeHandle | null = null
  const store = storage.createSqliteStore(dbPath)
  let failed = false
  let owned: OwnedComment | null = null
  let cleaned = false
  let cleanupError: Error | null = null
  let jiraHeaders: Record<string, string> | null = null
  try {
    const pullBefore = await ghPull(repo, prNumber)
    assertPullFixture(pullBefore, repo, prNumber, issueKey)
    console.log(`MARKER: github-pr-body-readback status=GET state=${pullBefore.state} hint=jira:${issueKey}`)

    const authHeader = jiraAuth.buildJiraBasicAuthHeader(email, token)
    jiraHeaders = { authorization: authHeader, accept: "application/json" }
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
    if (issue.status !== 200 || typeof summary !== "string") {
      throw new GuardError(`fixture ${issueKey} summary is missing (status ${issue.status})`)
    }
    assertSummaryBeforeJiraWrite(summary)
    if (assigneeId !== jira.agentAccountId) {
      throw new GuardError(`fixture ${issueKey} is not assigned to the configured agent account. This script will not assign it.`)
    }
    console.log(`MARKER: jira-fixture-readback key=${issueKey} assigned=agent summaryOk=true`)

    const opencodeBin = process.env.OPENCODE_BIN ?? path.join(os.homedir(), ".opencode", "bin", "opencode")
    if (!existsSync(opencodeBin)) throw new GuardError(`opencode binary not found at ${opencodeBin}`)
    workDir = await mkdtemp(path.join(scratch.root, "codebridge-kpi3-live-repo-"))
    assertContained(scratch.root, workDir)
    serve = await startOpencodeServe({ bin: opencodeBin })
    const baseUrl = serve.baseUrl
    const guard = installOpencodeGuard(baseUrl)
    try {
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
          assertSummaryBeforeJiraWrite(summary)
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
      assertSummaryBeforeJiraWrite(summary)
      await loop.tick()
      const cursor = await store.getJiraPollState(tenant.id)
      if (!cursor) throw new Error("Jira poll tick did not persist jira_poll_state; not writing a trigger comment")

      let link = await links.resolveLink(store, tenant.id, [{ kind: "jira", issueKey }])
      if (!link) {
        const runId = randomUUID()
        const marker = `run=${runId}`
        const trigger = `KPI3 disposable bot comment ${new Date().toISOString()} ${marker}. Enters the Jira poll window only. No public share.`
        assertSummaryBeforeJiraWrite(summary)
        const posted = await fetch(new URL(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, stripSlash(jira.baseUrl)), {
          method: "POST",
          headers: { ...jiraHeaders, "content-type": "application/json" },
          body: JSON.stringify({ body: jiraTypes.textToAdf(trigger) })
        })
        if (posted.status !== 201) {
          const detail = redact(await posted.text())
          throw new Error(`trigger comment failed (${posted.status}): ${detail.slice(0, 300)}`)
        }
        // Track before reading the body so a 201 with invalid JSON still cleans up by marker.
        owned = { marker }
        let postedBody: { id?: unknown } = {}
        try {
          postedBody = await posted.json() as { id?: unknown }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(`trigger comment returned 201 with an unparseable body: ${redact(message)}`)
        }
        const parsedId = postedBody && typeof postedBody === "object" && typeof postedBody.id === "string" ? postedBody.id : ""
        const commentId = parsedId || await findSoleOwnedComment(jira.baseUrl, issueKey, jiraHeaders, marker, jiraTypes.adfToText)
        owned = { id: commentId, marker }
        console.log(`MARKER: disposable-jira-bot-comment id=${commentId} purpose=poll-window`)
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
    } finally {
      guard.restore()
    }
  } catch (error) {
    failed = true
    throw error
  } finally {
    if (serve) {
      try {
        await serve.stop()
      } catch (error) {
        failed = true
        const stopError = error instanceof Error ? error : new Error(String(error))
        cleanupError = joinErrors(cleanupError, stopError)
        console.error(`MARKER: opencode-stop-failed ${redact(stopError.message)}`)
      }
    }
    if (workDir) {
      try {
        await rm(workDir, { recursive: true, force: true })
      } catch (error) {
        failed = true
        const rmError = error instanceof Error ? error : new Error(String(error))
        cleanupError = joinErrors(cleanupError, rmError)
        console.error(`MARKER: workdir-cleanup-failed ${redact(rmError.message)}`)
      }
    }
    if (owned && !cleaned) {
      try {
        if (!jiraHeaders) throw new Error("refusing comment cleanup: Jira headers were not initialized")
        const commentId = owned.id ?? await findSoleOwnedComment(jira.baseUrl, issueKey, jiraHeaders, owned.marker, jiraTypes.adfToText)
        if (!commentId) throw new Error("refusing comment cleanup: marker lookup did not return a comment id")
        await deleteOwnedComment(jira.baseUrl, issueKey, jiraHeaders, { id: commentId, marker: owned.marker }, jiraTypes.adfToText)
        cleaned = true
      } catch (error) {
        failed = true
        const commentError = error instanceof Error ? error : new Error(String(error))
        cleanupError = joinErrors(cleanupError, commentError)
        console.error(`MARKER: trigger-comment-cleanup-failed ${redact(commentError.message)}`)
      }
    }
    if (owned && !cleaned) failed = true
    retainOrDeleteDb(dbDir, dbPath, scratch.root, failed, args.keepDb)
  }
  if (cleanupError) throw cleanupError
  if (owned && !cleaned) throw new Error("trigger comment cleanup was not verified")
  console.log("RESULT: PASS for live Jira poll + write-back read-back + GitHub GET read-back + direct PR handler. GitHub poll pickup was NOT exercised.")
}

function joinErrors(current: Error | null, next: Error): Error {
  if (!current) return next
  return new Error(`${current.message}; ${next.message}`)
}

function retainOrDeleteDb(dbDir: string, dbPath: string, scratchRoot: string, failed: boolean, keepDb: boolean): void {
  let escaped = false
  try {
    assertContained(scratchRoot, dbDir)
  } catch {
    escaped = true
  }
  if (escaped) {
    console.error(`MARKER: removed-escaped-db ${dbPath}`)
    return
  }
  if (failed || keepDb) {
    console.log(`MARKER: kept-temp-db ${dbPath}`)
    return
  }
  rmSync(dbDir, { recursive: true, force: true })
  console.log(`MARKER: deleted-temp-db ${dbPath}`)
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
  if (!REPO_RE.test(jira.repo)) throw new GuardError("tenant jira.repo is not owner/name")
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
  if (repo !== FIXTURE_REPO || prNumber !== FIXTURE_PR || issueKey !== FIXTURE_ISSUE_KEY) {
    throw new GuardError("refusing GitHub read for a non-pinned fixture")
  }
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
  const bin = "gh"
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 20_000, maxBuffer: 2_000_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`gh ${args.join(" ")} failed: ${redact(stderr || error.message).slice(0, 300)}`))
        return
      }
      resolve(stdout)
    })
  })
}

async function jiraFetch(baseUrl: string, pathname: string, headers: Record<string, string>, method = "GET"): Promise<Response> {
  return fetch(new URL(pathname, stripSlash(baseUrl)), { method, headers })
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

async function findSoleOwnedComment(
  baseUrl: string,
  issueKey: string,
  headers: Record<string, string>,
  marker: string,
  toText: (body: unknown) => string
): Promise<string> {
  const comments = await listComments(baseUrl, issueKey, headers)
  const matches = comments.filter(comment => comment.id && toText(comment.body).includes(marker))
  if (matches.length !== 1 || !matches[0].id) {
    throw new Error(`refusing comment cleanup: expected exactly one comment containing this run marker, found ${matches.length}`)
  }
  return matches[0].id
}

async function deleteOwnedComment(
  baseUrl: string,
  issueKey: string,
  headers: Record<string, string>,
  owned: { id: string; marker: string },
  toText: (body: unknown) => string
): Promise<void> {
  const pathname = `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(owned.id)}`
  const got = await jiraFetch(baseUrl, pathname, headers)
  if (got.status === 404) {
    console.log(`MARKER: disposable-comment-already-absent id=${owned.id}`)
    return
  }
  const body = await readJson(got, "owned jira comment")
  const text = toText(recordField(body, "body"))
  if (got.status !== 200 || !text.includes(owned.marker)) {
    throw new Error(`refusing to delete Jira comment ${owned.id}: readback did not match this run`)
  }
  const deleted = await jiraFetch(baseUrl, pathname, headers, "DELETE")
  if (deleted.status !== 204 && deleted.status !== 200) {
    const detail = redact(await deleted.text())
    throw new Error(`delete of owned comment ${owned.id} failed (${deleted.status}): ${detail.slice(0, 200)}`)
  }
  const again = await jiraFetch(baseUrl, pathname, headers)
  if (again.status !== 404) {
    throw new Error(`owned comment ${owned.id} still readable after delete (status ${again.status})`)
  }
  console.log(`MARKER: deleted-owned-trigger-comment id=${owned.id}`)
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

function recordField(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined
  return (value as Record<string, unknown>)[key]
}

function stripSlash(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "")
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
