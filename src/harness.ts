// Orchestrator for linked Jira/GitHub events (LLD §6).
//
// Deviations from the LLD sketch, same style as opencode-session.ts:
// - createSession is the real adapter: `{ repoPath, title }` plus optional
//   OpencodeSessionConfig. The doc's one-arg sketch is not the wire API.
// - §6.2 MCP write-back (post_jira_comment / post_github_comment /
//   transition_jira_status) is out of scope for this card. These functions
//   return the reply string the caller would post. They do not open a network
//   write to Jira or GitHub. mirrorReplies is returned so the caller can fan
//   out later; this process does not.
// - SessionLink has no shareUrl column. A reused session therefore uses the
//   §4 resume-command fallback, not a stored share URL.
// - A completed link outside the reactivation window cannot be replaced:
//   UNIQUE(tenant_id, kind, repo_key, value) still owns the identifier, and
//   claimAndCreateLink returns that row instead of creating a second session.
//   We do not flip it back to active outside the window.
// - §4a per-link workspace checkout is not done here. LLD §10 calls the
//   checkout-vs-createSession order circular, and this card's tests do not
//   cover workspaces.
// - ctx.sessions is a test seam so AC7 can fail one opencode call without
//   depending on a nondeterministic server outage. Production omits it.

import { logger } from "./logger.js"
import {
  extractClosingRefs,
  extractCommand,
  extractLinkHints,
  jiraKeysFromBranch,
  type LinkHint
} from "./commands.js"
import {
  OpencodeTurnError,
  OpencodeUnreachableError,
  appendTurn as defaultAppendTurn,
  createSession as defaultCreateSession,
  type OpencodeSession,
  type OpencodeSessionConfig
} from "./opencode-session.js"
import {
  SessionLinkConflictError,
  SessionLinkPendingError,
  attachIdentifier,
  claimAndCreateLink,
  resolveLink,
  type LinkKey
} from "./session-links.js"
import { SessionLinkResolveConflictError, type RunStore, type SessionLink } from "./storage.js"
import type { AppConfig, TenantConfig } from "./types.js"

export type HarnessSource = "jira" | "github_pr" | "github_issue"

export type AssignmentEvent = {
  source: HarnessSource
  tenantId: string
  keys: LinkKey[]
  repoPath: string
  title: string
  // Ticket/PR body and branch, scanned with commands.ts (LLD §3). Optional:
  // github-poll does not produce these events yet.
  body?: string
  branch?: string
}

export type CommentEvent = {
  source: HarnessSource
  tenantId: string
  keys: LinkKey[]
  commentBody: string
  authorIsBot: boolean
  repoPath?: string
  title?: string
}

export type HarnessMirror = "origin-only" | "all"

export type HarnessResult = {
  sessionId: string
  reply: string
  mirror: HarnessMirror
}

export type HarnessSessionFns = {
  createSession: (
    params: { repoPath: string; title: string },
    config?: OpencodeSessionConfig
  ) => Promise<OpencodeSession>
  appendTurn: (
    sessionId: string,
    prompt: string,
    config?: OpencodeSessionConfig
  ) => Promise<{ reply: string }>
}

export type HarnessCtx = {
  store: RunStore
  config: AppConfig
  opencodeConfig?: OpencodeSessionConfig
  now?: () => Date
  sessions?: HarnessSessionFns
}

const DEFAULT_REACTIVATION_MINUTES = 60

const sessionTails = new Map<string, Promise<void>>()

export async function handleAssignmentEvent(ctx: HarnessCtx, ev: AssignmentEvent): Promise<HarnessResult> {
  const tenant = tenantOf(ctx, ev.tenantId)
  const mirror = mirrorFor(tenant)
  const { resolveKeys, attachKeys } = candidateKeys(ev)
  if (resolveKeys.length === 0) {
    throw new Error("assignment event has no link keys")
  }

  const existing = await resolveLink(ctx.store, ev.tenantId, resolveKeys)
  if (existing && (existing.status !== "completed" || withinReactivationWindow(existing, nowOf(ctx), tenant))) {
    const link = existing.status === "completed"
      ? await ctx.store.updateSessionLinkStatus({
        tenantId: ev.tenantId,
        linkId: existing.id,
        status: "active",
        updatedAt: nowOf(ctx).toISOString()
      })
      : existing
    await attachKeysToLink(ctx, link.id, ev.tenantId, attachKeys)
    // Re-assignment is a no-op besides attaching new identifiers (LLD §6 step 3).
    // No share URL is stored on the row; §4 fallback is the reply.
    return { sessionId: link.opencodeSessionId, reply: unsharedSessionReply(link.opencodeSessionId), mirror }
  }

  const initialKey = ev.keys[0] ?? attachKeys[0] ?? resolveKeys[0]
  const outsideWindow = existing?.status === "completed"
  let created: OpencodeSession | null = null
  const link = await claimAndCreateLink(ctx.store, ev.tenantId, initialKey, async () => {
    created = await sessionsOf(ctx).createSession(
      { repoPath: ev.repoPath, title: ev.title },
      ctx.opencodeConfig
    )
    return { sessionId: created.sessionId }
  })
  // Outside the window the old row still owns the key. Do not attach new
  // identifiers onto a session we refused to resume.
  if (!outsideWindow) {
    await attachKeysToLink(ctx, link.id, ev.tenantId, attachKeys)
  }
  if (!created && outsideWindow) {
    logger.warn(
      { tenantId: ev.tenantId, linkId: link.id, source: ev.source },
      "completed session link is outside the reactivation window; identifier stays claimed so no second session was created"
    )
  }
  return {
    sessionId: link.opencodeSessionId,
    reply: created ? shareReply(created) : unsharedSessionReply(link.opencodeSessionId),
    mirror
  }
}

export async function handleCommentEvent(ctx: HarnessCtx, ev: CommentEvent): Promise<HarnessResult | null> {
  if (ev.authorIsBot) return null
  if (!ev.commentBody.trim()) return null

  const tenant = tenantOf(ctx, ev.tenantId)
  const mirror = mirrorFor(tenant)
  const { resolveKeys, attachKeys } = candidateKeys(ev)
  if (resolveKeys.length === 0) return null

  let link: SessionLink | null
  try {
    link = await resolveLink(ctx.store, ev.tenantId, resolveKeys)
  } catch (error) {
    if (error instanceof SessionLinkPendingError) {
      // Claim window (LLD §2 step 5): not "no link". Caller retries.
      throw error
    }
    if (error instanceof SessionLinkResolveConflictError) {
      logger.warn(
        { tenantId: ev.tenantId, source: ev.source, linkIds: error.linkIds },
        "comment keys resolve to more than one session link; not routing"
      )
      return null
    }
    throw error
  }

  if (!link) {
    if (!mentionsAgent(tenant, ev.commentBody) || !ev.repoPath) return null
    const boot = await handleAssignmentEvent(ctx, {
      source: ev.source,
      tenantId: ev.tenantId,
      keys: ev.keys.length > 0 ? ev.keys : attachKeys,
      repoPath: ev.repoPath,
      title: ev.title ?? ev.commentBody.slice(0, 120),
      body: ev.commentBody
    })
    link = await resolveLink(ctx.store, ev.tenantId, resolveKeys)
    if (!link) {
      return { sessionId: boot.sessionId, reply: boot.reply, mirror }
    }
  } else {
    await attachKeysToLink(ctx, link.id, ev.tenantId, attachKeys)
  }

  const linked = link
  if (!linked) return null
  const sessionId = linked.opencodeSessionId
  const reply = await withSessionLock(sessionId, async () => {
    try {
      const turn = await sessionsOf(ctx).appendTurn(sessionId, ev.commentBody, ctx.opencodeConfig)
      await ctx.store.updateSessionLinkStatus({
        tenantId: ev.tenantId,
        linkId: linked.id,
        status: "active",
        updatedAt: nowOf(ctx).toISOString()
      })
      return turn.reply
    } catch (error) {
      if (error instanceof OpencodeUnreachableError) {
        await ctx.store.updateSessionLinkStatus({
          tenantId: ev.tenantId,
          linkId: linked.id,
          status: "idle",
          updatedAt: nowOf(ctx).toISOString()
        }).catch(updateError => {
          logger.warn({ err: updateError, linkId: linked.id }, "failed to mark session link idle after opencode outage")
        })
      }
      if (error instanceof OpencodeTurnError) {
        logger.warn({ err: error, linkId: linked.id }, "opencode turn failed")
      }
      throw error
    }
  })

  return { sessionId, reply, mirror }
}

export function unsharedSessionReply(sessionId: string): string {
  return `not sharing: run \`opencode --resume ${sessionId}\``
}

function shareReply(session: OpencodeSession): string {
  if (session.shareUrl) return session.shareUrl
  return unsharedSessionReply(session.sessionId)
}

function sessionsOf(ctx: HarnessCtx): HarnessSessionFns {
  return ctx.sessions ?? { createSession: defaultCreateSession, appendTurn: defaultAppendTurn }
}

function nowOf(ctx: HarnessCtx): Date {
  return ctx.now?.() ?? new Date()
}

function tenantOf(ctx: HarnessCtx, tenantId: string): TenantConfig | undefined {
  return ctx.config.tenants.find(tenant => tenant.id === tenantId)
}

function mirrorFor(tenant: TenantConfig | undefined): HarnessMirror {
  return tenant?.harness?.mirrorReplies === "all" ? "all" : "origin-only"
}

function withinReactivationWindow(link: SessionLink, now: Date, tenant: TenantConfig | undefined): boolean {
  const minutes = tenant?.harness?.reactivationWindowMinutes ?? DEFAULT_REACTIVATION_MINUTES
  const updated = Date.parse(link.updatedAt)
  if (!Number.isFinite(updated)) return false
  return now.getTime() - updated <= minutes * 60_000
}

function mentionsAgent(tenant: TenantConfig | undefined, text: string): boolean {
  const prefixes = [
    ...(tenant?.github?.commandPrefixes ?? []),
    ...(tenant?.slack?.commandPrefixes ?? [])
  ]
  if (prefixes.length > 0 && extractCommand(text, prefixes)) return true
  const agentId = tenant?.jira?.agentAccountId
  return Boolean(agentId && text.includes(agentId))
}

type KeyPlan = { resolveKeys: LinkKey[]; attachKeys: LinkKey[] }

function candidateKeys(ev: AssignmentEvent | CommentEvent): KeyPlan {
  const text = "commentBody" in ev
    ? ev.commentBody
    : [ev.title, ev.body].filter(Boolean).join("\n")
  const branch = "branch" in ev ? ev.branch : undefined
  const defaultRepo = repoFromKeys(ev.keys)
  const hints = extractLinkHints(text)
  const closing = extractClosingRefs(text, defaultRepo).map(ref => ({
    kind: "gh_issue" as const,
    repo: ref.repo,
    number: ref.number
  }))
  const branchKeys = (branch ? jiraKeysFromBranch(branch) : []).map(issueKey => ({
    kind: "jira" as const,
    issueKey
  }))

  const resolveKeys = dedupeKeys([
    ...ev.keys,
    ...hints.flatMap(hint => hintToResolveKeys(hint, ev.source)),
    ...closing,
    ...branchKeys
  ])
  // Attach only unambiguous identifiers. A bare `gh:` hint is a lookup, not a
  // claim — issue vs PR is not in the token (commands.ts).
  const attachKeys = dedupeKeys([
    ...ev.keys,
    ...hints.flatMap(hintToAttachKey),
    ...closing,
    ...branchKeys
  ])
  return { resolveKeys, attachKeys }
}

function hintToResolveKeys(hint: LinkHint, source: HarnessSource): LinkKey[] {
  if (hint.kind === "jira") return [{ kind: "jira", issueKey: hint.issueKey }]
  if (hint.kind === "gh_issue" || hint.kind === "gh_pr") return [hint]
  if (source === "github_pr") return [{ kind: "gh_pr", repo: hint.repo, number: hint.number }]
  if (source === "github_issue") return [{ kind: "gh_issue", repo: hint.repo, number: hint.number }]
  return [
    { kind: "gh_pr", repo: hint.repo, number: hint.number },
    { kind: "gh_issue", repo: hint.repo, number: hint.number }
  ]
}

function hintToAttachKey(hint: LinkHint): LinkKey[] {
  if (hint.kind === "gh") return []
  if (hint.kind === "jira") return [{ kind: "jira", issueKey: hint.issueKey }]
  return [hint]
}

function repoFromKeys(keys: LinkKey[]): string | undefined {
  for (const key of keys) {
    if (key.kind === "gh_issue" || key.kind === "gh_pr") return key.repo
  }
  return undefined
}

function dedupeKeys(keys: LinkKey[]): LinkKey[] {
  const seen = new Set<string>()
  const out: LinkKey[] = []
  for (const key of keys) {
    const id = key.kind === "jira"
      ? `jira:${key.issueKey.trim().toLowerCase()}`
      : `${key.kind}:${key.repo.trim().toLowerCase()}#${key.number}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push(key)
  }
  return out
}

async function attachKeysToLink(ctx: HarnessCtx, linkId: string, tenantId: string, keys: LinkKey[]): Promise<void> {
  for (const key of keys) {
    try {
      await attachIdentifier(ctx.store, linkId, tenantId, key)
    } catch (error) {
      if (!(error instanceof SessionLinkConflictError)) throw error
      logger.warn(
        { tenantId, linkId, existingLinkId: error.existingLinkId },
        "not attaching identifier; it belongs to another session link"
      )
    }
  }
}

// LLD §6.1: one in-process queue per opencode session. Not a distributed lock.
async function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const previous = sessionTails.get(sessionId) ?? Promise.resolve()
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const tail = previous.then(() => gate, () => gate)
  sessionTails.set(sessionId, tail)
  try {
    await previous
  } catch {
    // The previous turn failed. This turn still runs.
  }
  try {
    return await fn()
  } finally {
    release()
    if (sessionTails.get(sessionId) === tail) sessionTails.delete(sessionId)
  }
}
