import type { AppConfig, TenantConfig } from "./types.js"
import { SessionLinkResolveConflictError, type RunStore } from "./storage.js"
import { buildJiraBasicAuthHeader } from "./jira-auth.js"
import { adfToText, textToAdf, type JiraComment, type JiraIssue, type JiraSearchAndReconcileResults } from "./jira-types.js"
import { logger } from "./logger.js"
import { handleAssignmentEvent, handleCommentEvent, type HarnessCtx } from "./harness.js"

export type JiraPollEnv = {
  jiraEmail?: string
  jiraApiToken?: string
}

// Kept as a callback interface so jira-poll unit tests can inject a collector
// without booting opencode. Production (and a missing harness argument) uses
// createHarnessBackedJiraPoller, which calls handleAssignmentEvent /
// handleCommentEvent and posts the assignment reply back to the ticket via
// postJiraComment (LLD §6.2). Comment events do not write back yet -- only
// the assignment path is wired here. github-poll.ts is not wired here (LLD
// step 6, tracked separately).
export type JiraAssignmentEvent = {
  source: "jira"
  tenantId: string
  issueKey: string
  issueId: string
  repo: string
  repoPath: string
  title: string
  assigneeAccountId: string
  // Carried so onAssignmentEvent can post the session reply back onto the
  // ticket (LLD §6.2 post_jira_comment) without re-deriving tenant config.
  // Same baseUrl/authHeader pollTenant already has for this tick.
  jiraBaseUrl: string
  authHeader: string
}

export type JiraCommentEvent = {
  source: "jira"
  tenantId: string
  issueKey: string
  issueId: string
  repo: string
  repoPath: string
  commentId: string
  commentBody: string
  authorAccountId: string
  created: string
}

export type JiraPollHarness = {
  onAssignmentEvent: (ev: JiraAssignmentEvent) => void | Promise<void>
  onCommentEvent: (ev: JiraCommentEvent) => void | Promise<void>
}

const OVERLAP_MS = 60_000
const SEARCH_FIELDS = ["assignee", "comment", "status", "summary", "updated"]
const MAX_SEARCH_PAGES = 20

export function jiraPollIntervalMs(intervalSec: number): number {
  return Math.max(10000, intervalSec * 1000)
}

// JQL `updated` literals are minute precision. Accepted formats are
// "yyyy-MM-dd HH:mm", "yyyy/MM/dd HH:mm", "yyyy-MM-dd", "yyyy/MM/dd".
// Source: https://support.atlassian.com/jira-software-cloud/docs/jql-fields/
// (Updated field, fetched 2026-09-25): results are "relative to your configured
// time zone (which is by default the Jira server's time zone)". An unqualified
// literal is NOT UTC -- it is interpreted in the site's configured timezone.
// Verified live 2026-09-26 against https://vibeteaichnologies.atlassian.net
// (site tz America/Los_Angeles): a UTC-formatted "now" literal returned 0
// issues; the same instant formatted in site-local time returned the real,
// freshly-assigned KAN-4. `timeZone` must be an IANA zone name (e.g. the
// value returned by GET /rest/api/3/myself's `timeZone` field for the poller's
// account) -- see getJiraTimeZone below. Formatting in the wrong zone silently
// drops assignments/comments; there is no fallback that is safe to guess.
export function formatJqlUpdated(date: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  })
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}

// GET /rest/api/3/myself returns the *caller's* (agent account's) configured
// timeZone, not necessarily the site/project's timezone -- Jira does not expose
// a documented "site configured timezone" endpoint for JQL date-literal
// evaluation, and Atlassian support confirms JQL date literals are evaluated
// relative to the *searching user's* timezone preference, which for a bot
// account polling via basic auth is this same account. So the agent account's
// own timeZone is the correct (and only available) value to use here -- it is
// not a proxy for something else. Falls back to "UTC" only if the field is
// missing entirely (never silently misinterpreted as e.g. server default).
export async function getJiraTimeZone(input: { baseUrl: string; authHeader: string }): Promise<string> {
  const url = new URL("/rest/api/3/myself", stripSlash(input.baseUrl))
  const response = await fetch(url, {
    headers: {
      authorization: input.authHeader,
      accept: "application/json"
    }
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Jira myself lookup failed (${response.status}): ${detail.slice(0, 300)}`)
  }
  const payload = await response.json() as { timeZone?: string }
  return payload.timeZone ?? "UTC"
}

export function startJiraPolling(params: {
  config: AppConfig
  store: RunStore
  harness?: JiraPollHarness
  env: JiraPollEnv
  now?: () => Date
}) {
  const loop = createJiraPollLoop(params)
  if (!loop) return

  const timer = setInterval(() => {
    loop.tick().catch(error => logger.error(error, "Jira polling tick failed"))
  }, loop.intervalMs)

  loop.tick().catch(error => logger.error(error, "Jira polling tick failed"))

  return () => clearInterval(timer)
}

export function createJiraPollLoop(params: {
  config: AppConfig
  store: RunStore
  harness?: JiraPollHarness
  env: JiraPollEnv
  now?: () => Date
}) {
  const jiraTenants = params.config.tenants.filter(tenant => tenant.jira)
  if (jiraTenants.length === 0) return null
  if (!params.env.jiraEmail || !params.env.jiraApiToken) {
    logger.warn("Jira polling disabled: missing JIRA_EMAIL or JIRA_API_TOKEN")
    return null
  }

  const intervalMs = Math.min(...jiraTenants.map(tenant => jiraPollIntervalMs(tenant.jira!.pollIntervalSec)))
  const now = params.now ?? (() => new Date())
  const harness = params.harness ?? createHarnessBackedJiraPoller({
    store: params.store,
    config: params.config,
    now: params.now
  })
  const authHeader = buildJiraBasicAuthHeader(params.env.jiraEmail, params.env.jiraApiToken)
  // jira_seen_comment is deferred (LLD §5). This map dies on process restart, so the
  // 60s overlap can re-emit a comment or bootstrap after a restart. Acceptable until
  // that table exists; do not invent session_link here.
  const seenBootstrap = new Set<string>()
  const seenComments = new Set<string>()
  const timeZoneCache = new Map<string, string>()
  let running = false

  const tick = async () => {
    if (running) return
    running = true
    try {
      for (const tenant of params.config.tenants) {
        if (!tenant.jira) continue
        try {
          await pollTenant({
            tenant,
            store: params.store,
            harness,
            authHeader,
            now,
            seenBootstrap,
            seenComments,
            timeZoneCache
          })
        } catch (error) {
          logger.error({ err: error, tenantId: tenant.id }, "Jira polling failed")
        }
      }
    } finally {
      running = false
    }
  }

  return { tick, intervalMs }
}

// Adapter, not a second event model. JiraAssignmentEvent stays what the poller
// already emits; harness.ts wants LinkKey[]. Conflict is permanent (do not
// retry the tick). Pending claims and opencode failures still throw so the
// poller does not mark the event seen.
export function createHarnessBackedJiraPoller(ctx: HarnessCtx): JiraPollHarness {
  return {
    async onAssignmentEvent(ev) {
      let result
      try {
        result = await handleAssignmentEvent(ctx, {
          source: "jira",
          tenantId: ev.tenantId,
          keys: [{ kind: "jira", issueKey: ev.issueKey }],
          repoPath: ev.repoPath,
          title: ev.title
        })
      } catch (error) {
        if (error instanceof SessionLinkResolveConflictError) {
          logger.warn({ err: error, tenantId: ev.tenantId, issueKey: ev.issueKey }, "jira assignment conflict; not routing")
          return
        }
        throw error
      }
      // LLD §6.2 write-back. handleAssignmentEvent already computed the reply
      // (share link or resume-command fallback); post it here so the ticket
      // shows where the session lives. A failed post does not undo the link/
      // session creation above -- log and move on, do not throw and re-run
      // the tick (that would re-create nothing since seenBootstrap is set,
      // but would spam retries against Jira for a transient 5xx).
      try {
        await postJiraComment({
          baseUrl: ev.jiraBaseUrl,
          authHeader: ev.authHeader,
          issueKey: ev.issueKey,
          body: result.reply
        })
      } catch (error) {
        logger.error({ err: error, tenantId: ev.tenantId, issueKey: ev.issueKey }, "failed to post session link back to Jira ticket")
      }
    },
    async onCommentEvent(ev) {
      const tenant = ctx.config.tenants.find(item => item.id === ev.tenantId)
      const authorIsBot = Boolean(tenant?.jira?.agentAccountId && ev.authorAccountId === tenant.jira.agentAccountId)
      try {
        await handleCommentEvent(ctx, {
          source: "jira",
          tenantId: ev.tenantId,
          keys: [{ kind: "jira", issueKey: ev.issueKey }],
          repoPath: ev.repoPath,
          commentBody: ev.commentBody,
          authorIsBot,
          title: ev.issueKey
        })
      } catch (error) {
        if (error instanceof SessionLinkResolveConflictError) {
          logger.warn({ err: error, tenantId: ev.tenantId, issueKey: ev.issueKey }, "jira comment conflict; not routing")
          return
        }
        throw error
      }
    }
  }
}

async function pollTenant(input: {
  tenant: TenantConfig
  store: RunStore
  harness: JiraPollHarness
  authHeader: string
  now: () => Date
  seenBootstrap: Set<string>
  seenComments: Set<string>
  timeZoneCache: Map<string, string>
}) {
  const jira = input.tenant.jira
  if (!jira) return
  if (!/^[A-Z][A-Z0-9_]+$/.test(jira.projectKey)) {
    throw new Error(`Invalid Jira project key: ${jira.projectKey}`)
  }
  const repo = input.tenant.repos.find(item => item.fullName === jira.repo)
  if (!repo) {
    throw new Error(`Jira repo ${jira.repo} is not in tenant ${input.tenant.id} repos`)
  }

  // Cached per tenant for the lifetime of the poller. A configured timezone
  // does not change tick-to-tick; refetching every 10-60s buys nothing and
  // costs an extra Jira call per tenant per tick.
  let timeZone = input.timeZoneCache.get(input.tenant.id)
  if (!timeZone) {
    timeZone = await getJiraTimeZone({ baseUrl: jira.baseUrl, authHeader: input.authHeader })
    input.timeZoneCache.set(input.tenant.id, timeZone)
  }

  const state = await input.store.getJiraPollState(input.tenant.id)
  const nowIso = input.now().toISOString()
  const cursor = state?.lastCursor ?? nowIso
  const cursorMs = Date.parse(cursor)
  const lowerBound = new Date((Number.isFinite(cursorMs) ? cursorMs : Date.parse(nowIso)) - OVERLAP_MS)
  const jql = `project = ${jira.projectKey} AND updated >= "${formatJqlUpdated(lowerBound, timeZone)}" ORDER BY updated ASC`

  const issues = await searchJiraIssues({
    baseUrl: jira.baseUrl,
    authHeader: input.authHeader,
    jql
  })

  let newestMs = Number.isFinite(cursorMs) ? cursorMs : Date.parse(nowIso)
  let newestRaw = cursor

  for (const issue of issues) {
    const updatedMs = issue.fields?.updated ? Date.parse(issue.fields.updated) : NaN
    if (Number.isFinite(updatedMs) && updatedMs >= newestMs) {
      newestMs = updatedMs
      newestRaw = issue.fields!.updated!
    }

    const assigneeId = issue.fields?.assignee?.accountId
    const bootstrapKey = `${input.tenant.id}:${issue.key}`
    if (assigneeId && assigneeId === jira.agentAccountId && !input.seenBootstrap.has(bootstrapKey)) {
      await input.harness.onAssignmentEvent({
        source: "jira",
        tenantId: input.tenant.id,
        issueKey: issue.key,
        issueId: issue.id,
        repo: jira.repo,
        repoPath: repo.path,
        title: issue.fields?.summary ?? issue.key,
        assigneeAccountId: assigneeId,
        jiraBaseUrl: jira.baseUrl,
        authHeader: input.authHeader
      })
      input.seenBootstrap.add(bootstrapKey)
    }

    const comments = await loadComments({
      baseUrl: jira.baseUrl,
      authHeader: input.authHeader,
      issue
    })
    const ordered = comments
      .filter(comment => comment.id && comment.created)
      .sort((a, b) => {
        const delta = Date.parse(a.created!) - Date.parse(b.created!)
        if (delta !== 0) return delta
        return String(a.id).localeCompare(String(b.id))
      })

    for (const comment of ordered) {
      const authorId = comment.author?.accountId ?? ""
      if (authorId === jira.agentAccountId) continue
      const createdMs = Date.parse(comment.created!)
      if (!Number.isFinite(createdMs) || createdMs < lowerBound.getTime()) continue
      const seenKey = `${input.tenant.id}:${issue.key}:${comment.id}`
      if (input.seenComments.has(seenKey)) continue
      await input.harness.onCommentEvent({
        source: "jira",
        tenantId: input.tenant.id,
        issueKey: issue.key,
        issueId: issue.id,
        repo: jira.repo,
        repoPath: repo.path,
        commentId: comment.id!,
        commentBody: adfToText(comment.body),
        authorAccountId: authorId,
        created: comment.created!
      })
      input.seenComments.add(seenKey)
    }
  }

  // High-water mark. Overlap re-returns older `updated` values; persisting those
  // would walk the cursor backward. nextPageToken is never stored here.
  if (!state || newestRaw !== state.lastCursor) {
    await input.store.updateJiraPollState({
      tenantId: input.tenant.id,
      lastCursor: newestRaw
    })
  }
}

// Verified 2026-09-25 from
// https://dac-static.atlassian.com/cloud/jira/platform/swagger-v3.v3.json
// path /rest/api/3/search/jql
// (info.version 1001.0.0-SNAPSHOT-44cdd07c042959317ed5591bf79dbcd9369f3610):
// - GET and POST are both current (deprecated: false). GET query params: jql,
//   nextPageToken, maxResults, fields, expand, properties, fieldsByKeys,
//   failFast, reconcileIssues, includeArchivedProjects.
// - POST body is SearchAndReconcileRequestBean (jql, fields[], nextPageToken,
//   maxResults, ...). `fields` defaults to id only, so updated must be requested.
//   `jql` must be a bounded query; `project = KEY` is the restriction.
//   We POST so `fields` stays a JSON array and the page token stays in the body.
//   GET's description says to use POST when JQL is too large to encode as a
//   query parameter. That sentence links to the deprecated /rest/api/3/search
//   POST; the non-deprecated POST is this same /search/jql path.
// - 200 body is SearchAndReconcileResults: issues[], nextPageToken (null on the
//   last page; "continuation token to fetch the next page", expires in 7 days),
//   isLast, plus names/schema/warnings. warnings is marked experimental.
// - Old /rest/api/3/search GET and POST are deprecated in the same spec
//   ("Currently being removed").
// Not confirmed against a live Jira site (no credentials in this repo).
export async function searchJiraIssues(input: {
  baseUrl: string
  authHeader: string
  jql: string
}): Promise<JiraIssue[]> {
  const issues: JiraIssue[] = []
  let nextPageToken: string | undefined
  const seenTokens = new Set<string>()

  for (let page = 0; page < MAX_SEARCH_PAGES; page += 1) {
    const body: Record<string, unknown> = {
      jql: input.jql,
      fields: SEARCH_FIELDS,
      maxResults: 50
    }
    if (nextPageToken) body.nextPageToken = nextPageToken

    const response = await fetch(searchUrl(input.baseUrl), {
      method: "POST",
      headers: {
        authorization: input.authHeader,
        accept: "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    })
    if (!response.ok) {
      const detail = await response.text()
      throw new Error(`Jira search failed (${response.status}): ${detail.slice(0, 300)}`)
    }
    const payload = await response.json() as JiraSearchAndReconcileResults
    if (Array.isArray(payload.issues)) issues.push(...payload.issues)

    const token = payload.nextPageToken
    if (!token || payload.isLast === true) break
    if (seenTokens.has(token)) {
      throw new Error("Jira search repeated nextPageToken; refusing to loop")
    }
    seenTokens.add(token)
    nextPageToken = token
  }

  return issues
}

async function loadComments(input: {
  baseUrl: string
  authHeader: string
  issue: JiraIssue
}): Promise<JiraComment[]> {
  const page = input.issue.fields?.comment
  const embedded = page?.comments ?? []
  // Unconfirmed: how many comments `fields: ["comment"]` embeds on search.
  // swagger PageOfComments.total is described as "The number of items returned",
  // which does not say whether more exist. The GET comment example
  // (same spec, /rest/api/3/issue/{issueIdOrKey}/comment) uses total as the
  // collection size when the page holds every comment. We page that resource
  // when total is missing or greater than the embedded list. A full page whose
  // total equals the page length can still be truncated; that case is unconfirmed.
  const embeddedStart = page?.startAt ?? 0
  if (page?.total != null && embeddedStart === 0 && embedded.length >= page.total) return embedded

  const comments: JiraComment[] = []
  let startAt = 0
  const maxResults = 100
  for (let pageNo = 0; pageNo < MAX_SEARCH_PAGES; pageNo += 1) {
    const url = new URL(`/rest/api/3/issue/${encodeURIComponent(input.issue.key)}/comment`, stripSlash(input.baseUrl))
    url.searchParams.set("startAt", String(startAt))
    url.searchParams.set("maxResults", String(maxResults))
    url.searchParams.set("orderBy", "created")
    const response = await fetch(url, {
      headers: {
        authorization: input.authHeader,
        accept: "application/json"
      }
    })
    if (!response.ok) {
      const detail = await response.text()
      throw new Error(`Jira comments failed (${response.status}): ${detail.slice(0, 300)}`)
    }
    const payload = await response.json() as { comments?: JiraComment[]; total?: number }
    const batch = payload.comments ?? []
    comments.push(...batch)
    startAt += batch.length
    if (batch.length === 0 || (payload.total != null && startAt >= payload.total)) break
  }
  return comments
}

function searchUrl(baseUrl: string): string {
  return `${stripSlash(baseUrl)}/rest/api/3/search/jql`
}

// LLD §6.2 post_jira_comment. Called from onAssignmentEvent so a fresh
// session's share/resume reply lands on the ticket. Callers decide whether a
// failed post should be fatal; this function only does the network call.
export async function postJiraComment(input: {
  baseUrl: string
  authHeader: string
  issueKey: string
  body: string
}): Promise<void> {
  const url = new URL(`/rest/api/3/issue/${encodeURIComponent(input.issueKey)}/comment`, stripSlash(input.baseUrl))
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: input.authHeader,
      accept: "application/json",
      "content-type": "application/json"
    },
    body: JSON.stringify({ body: textToAdf(input.body) })
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Jira comment post failed (${response.status}): ${detail.slice(0, 300)}`)
  }
}

function stripSlash(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "")
}
