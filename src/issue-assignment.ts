// Opt-in GitHub issue assignment -> one OpenCode session.
//
// Default off. Poll and webhook both call handleOptInIssueAssignment. A miss
// returns path "legacy" and the caller keeps the existing Codex createRun path.
//
// A literal runs row is required for the assignment proof. That row uses status
// "harness" and is not queued. Queuing it would start an independent Codex
// worker for the same issue, which the PRD non-goal and this card both forbid.
// The row is bound to session_link.run_id + the stable assignment source key.
//
// Turn state is pending | in_progress | failed | completed | indeterminate.
// in_progress is the crash window. A fresh in_progress claim is busy (no
// second turn). A stale one is NOT replayed. OpenCode v1.18.32 accepts a
// client messageID and stores it, but a second POST with that id appends
// another part. That is not exactly-once. A lease timeout also cannot prove
// the remote POST is absent. Stale recovery GETs the recorded message id:
// one matching prompt text is completed without a new POST; anything else
// (missing id, 404, lookup error, content mismatch) is indeterminate and
// requires operator recovery. failed is retried only when the dispatch row
// was cleared after a finished response proved the message was absent.
// The managed label is not the lock. Dedupe is the source key, the gh_issue
// claim, and turn_state.

import { nanoid } from "nanoid"
import { logger } from "./logger.js"
import {
  handleAssignmentEvent,
  handleCommentEvent,
  opencodeSessionConfigFor,
  planLinkKeys,
  type HarnessCtx
} from "./harness.js"
import {
  OpencodeUnreachableError,
  appendTurn as defaultAppendTurn,
  getSessionMessage,
  type OpencodeSessionConfig
} from "./opencode-session.js"
import { SessionLinkPendingError, resolveLink, type LinkKey } from "./session-links.js"
import {
  SessionLinkBindConflictError,
  SessionLinkResolveConflictError,
  HARNESS_RUN_STATUS,
  type IssueTurnState,
  type RunStore
} from "./storage.js"
import type { RepoConfig, TenantConfig } from "./types.js"

export const ISSUE_TURN_STALE_MS = 120_000
const PENDING_RETRIES = 5
const PENDING_WAIT_MS = 50

export type IssueAssignmentResult =
  | { path: "legacy" }
  | {
    path: "harness"
    sessionId: string
    runId: string
    linkId: string
    turnState: IssueTurnState
    duplicate: boolean
  }
  | { path: "conflict"; reason: string; linkIds?: string[] }
  | { path: "pending"; reason: string }
  | { path: "failed"; reason: string; runId?: string; linkId?: string; sessionId?: string }
  | {
    path: "indeterminate"
    reason: string
    runId?: string
    linkId?: string
    sessionId?: string
    messageId?: string
  }

export function issueAssignmentEnabled(tenant: TenantConfig, repoFullName: string): boolean {
  const repos = tenant.harness?.issueAssignmentRepos ?? []
  const needle = repoFullName.toLowerCase()
  return repos.some(repo => repo.toLowerCase() === needle)
}

export function assignmentSourceKey(input: {
  installationId?: number
  repoFullName: string
  issueNumber: number
}): string {
  return [
    "github-assigned",
    input.installationId ?? "none",
    input.repoFullName.toLowerCase(),
    input.issueNumber
  ].join(":")
}

export function issueWorkPrompt(issueNumber: number, title: string, body?: string): string {
  const bodyText = body?.trim() ? body.trim() : "(No description provided)"
  return [
    `Work on GitHub issue #${issueNumber}: ${title}`,
    "",
    "Issue description:",
    bodyText
  ].join("\n")
}

export async function handleOptInIssueAssignment(input: {
  store: RunStore
  harness: HarnessCtx
  tenant: TenantConfig
  repo: RepoConfig
  owner: string
  repoName: string
  installationId?: number
  issueNumber: number
  title: string
  body?: string
  repoPath: string
  runId: string
  turnStaleMs?: number
  now?: () => Date
}): Promise<IssueAssignmentResult> {
  if (!issueAssignmentEnabled(input.tenant, input.repo.fullName)) {
    return { path: "legacy" }
  }

  const sourceKey = assignmentSourceKey({
    installationId: input.installationId,
    repoFullName: input.repo.fullName,
    issueNumber: input.issueNumber
  })
  const ownKey: LinkKey = { kind: "gh_issue", repo: input.repo.fullName, number: input.issueNumber }
  const plan = planLinkKeys({
    source: "github_issue",
    tenantId: input.tenant.id,
    keys: [ownKey],
    repoPath: input.repoPath,
    title: input.title,
    body: input.body
  })

  let existing
  try {
    existing = await resolveWithRetry(input.store, input.tenant.id, plan.resolveKeys)
  } catch (error) {
    if (error instanceof SessionLinkResolveConflictError) {
      return conflictResult(error.linkIds)
    }
    if (error instanceof SessionLinkPendingError) {
      return { path: "pending", reason: error.message }
    }
    throw error
  }

  const prior = await input.store.getLatestRunForIssue({
    tenantId: input.tenant.id,
    repoFullName: input.repo.fullName,
    issueNumber: input.issueNumber
  })
  if (prior && String(prior.status) !== HARNESS_RUN_STATUS && prior.sourceKey !== sourceKey) {
    return {
      path: "conflict",
      reason: `issue already has Codex run ${prior.id} status ${prior.status}; not starting a second worker`
    }
  }

  const inserted = await input.store.insertHarnessRun({
    id: input.runId,
    tenantId: input.tenant.id,
    repoFullName: input.repo.fullName,
    repoPath: input.repoPath,
    sourceKey,
    prompt: issueWorkPrompt(input.issueNumber, input.title, input.body),
    model: input.repo.model,
    branchPrefix: input.repo.branchPrefix,
    github: {
      owner: input.owner,
      repo: input.repoName,
      issueNumber: input.issueNumber,
      installationId: input.installationId,
      issueTitle: input.title,
      issueBody: input.body
    }
  })
  if (inserted.outcome === "conflict") {
    return {
      path: "conflict",
      reason: `assignment source key ${sourceKey} is owned by run ${inserted.run.id} status ${inserted.run.status}; not overwriting`
    }
  }

  let sessionId: string
  try {
    const assigned = await handleAssignmentEvent(input.harness, {
      source: "github_issue",
      tenantId: input.tenant.id,
      keys: [ownKey],
      repoPath: input.repoPath,
      title: input.title,
      body: input.body
    })
    sessionId = assigned.sessionId
  } catch (error) {
    if (error instanceof SessionLinkResolveConflictError) return conflictResult(error.linkIds)
    if (error instanceof SessionLinkPendingError) return { path: "pending", reason: error.message }
    logger.warn({ err: error, tenantId: input.tenant.id, sourceKey }, "opt-in issue assignment failed before a session existed")
    return { path: "failed", reason: error instanceof Error ? error.message : String(error), runId: inserted.run.id }
  }

  const link = await resolveWithRetry(input.store, input.tenant.id, plan.resolveKeys).catch(error => {
    if (error instanceof SessionLinkResolveConflictError) return error
    throw error
  })
  if (link instanceof SessionLinkResolveConflictError) return conflictResult(link.linkIds)
  if (!link) {
    return { path: "pending", reason: `session ${sessionId} is not linked yet` }
  }

  let bound
  try {
    bound = await input.store.bindHarnessRun({
      tenantId: input.tenant.id,
      linkId: link.id,
      runId: inserted.run.id,
      sourceKey,
      updatedAt: nowIso(input.now)
    })
  } catch (error) {
    if (error instanceof SessionLinkBindConflictError) {
      return {
        path: "conflict",
        reason: `link ${error.linkId} is already bound to run ${error.runId ?? "unknown"}; not overwriting`,
        linkIds: [error.linkId]
      }
    }
    throw error
  }

  if (bound.turnState === "completed") {
    return {
      path: "harness",
      sessionId: bound.opencodeSessionId,
      runId: inserted.run.id,
      linkId: bound.id,
      turnState: "completed",
      duplicate: true
    }
  }

  const staleMs = input.turnStaleMs ?? ISSUE_TURN_STALE_MS
  const updatedAt = nowIso(input.now)
  const prompt = issueWorkPrompt(input.issueNumber, input.title, input.body)
  const claim = await input.store.claimIssueTurn({
    tenantId: input.tenant.id,
    linkId: bound.id,
    updatedAt,
    staleBefore: new Date(Date.parse(updatedAt) - staleMs).toISOString(),
    messageId: `msg_${nanoid(20)}`,
    prompt
  })
  if (claim.outcome === "completed") {
    return harnessDuplicate(claim.link, inserted.run.id, "completed")
  }
  if (claim.outcome === "busy") {
    return harnessDuplicate(claim.link, inserted.run.id, "in_progress")
  }
  if (claim.outcome === "stale" || claim.outcome === "held") {
    return reconcileStaleTurn({
      store: input.store,
      harness: input.harness,
      tenantId: input.tenant.id,
      runId: inserted.run.id,
      link: claim.link,
      now: input.now
    })
  }

  const messageId = claim.link.turnMessageId
  if (!messageId) {
    return indeterminateResult({
      reason: "issue turn claim did not record a message id; not sending",
      runId: inserted.run.id,
      linkId: bound.id,
      sessionId: bound.opencodeSessionId
    })
  }
  try {
    await dispatchTurn(input.harness, input.tenant.id, bound.opencodeSessionId, prompt, messageId)
    const confirmed = await confirmDeliveredPrompt(input.harness, input.tenant.id, bound.opencodeSessionId, messageId, prompt)
    if (confirmed !== "delivered") {
      return recordIndeterminate({
        store: input.store,
        tenantId: input.tenant.id,
        linkId: bound.id,
        runId: inserted.run.id,
        sessionId: bound.opencodeSessionId,
        messageId,
        reason: confirmed,
        now: input.now
      })
    }
    const finished = await input.store.finishIssueTurn({
      tenantId: input.tenant.id,
      linkId: bound.id,
      state: "completed",
      updatedAt: nowIso(input.now)
    })
    return {
      path: "harness",
      sessionId: finished.opencodeSessionId,
      runId: inserted.run.id,
      linkId: finished.id,
      turnState: "completed",
      duplicate: false
    }
  } catch (error) {
    return recoverFailedDispatch({
      store: input.store,
      harness: input.harness,
      tenantId: input.tenant.id,
      linkId: bound.id,
      runId: inserted.run.id,
      sessionId: bound.opencodeSessionId,
      messageId,
      prompt,
      error,
      now: input.now
    })
  }
}

export async function routeLinkedGitHubComment(input: {
  store: RunStore
  harness: HarnessCtx
  tenantId: string
  repoFullName: string
  issueNumber: number
  isPullRequest: boolean
  title?: string
  commentBody: string
  authorIsBot: boolean
  repoPath?: string
  commentId?: number | string
}): Promise<"routed" | "unlinked" | "conflict" | "indeterminate"> {
  const key: LinkKey = input.isPullRequest
    ? { kind: "gh_pr", repo: input.repoFullName, number: input.issueNumber }
    : { kind: "gh_issue", repo: input.repoFullName, number: input.issueNumber }
  let existing
  try {
    existing = await resolveLink(input.store, input.tenantId, [key])
  } catch (error) {
    if (error instanceof SessionLinkPendingError) throw error
    if (error instanceof SessionLinkResolveConflictError) {
      logger.warn({
        err: error,
        tenantId: input.tenantId,
        repo: input.repoFullName,
        issueNumber: input.issueNumber,
        linkIds: error.linkIds
      }, "github comment keys resolve to more than one session link; not routing")
      return "conflict"
    }
    throw error
  }
  if (!existing) return "unlinked"
  const commentEvent = {
    source: input.isPullRequest ? "github_pr" as const : "github_issue" as const,
    tenantId: input.tenantId,
    keys: [key],
    commentBody: input.commentBody,
    authorIsBot: input.authorIsBot,
    repoPath: input.repoPath,
    title: input.title
  }
  if (input.authorIsBot || !input.commentBody.trim() || input.commentId == null) {
    await handleCommentEvent(input.harness, commentEvent)
    return "routed"
  }

  const commentId = String(input.commentId)
  const claim = await input.store.claimCommentDelivery({
    tenantId: input.tenantId,
    repoFullName: input.repoFullName,
    commentId,
    messageId: `msg_${nanoid(20)}`,
    updatedAt: new Date().toISOString()
  })
  if (claim.outcome === "delivered") return "routed"
  if (claim.outcome !== "claimed") {
    const seen = await confirmDeliveredPrompt(
      input.harness,
      input.tenantId,
      existing.opencodeSessionId,
      claim.messageId,
      input.commentBody
    )
    if (seen === "delivered") {
      await input.store.finishCommentDelivery({
        tenantId: input.tenantId,
        repoFullName: input.repoFullName,
        commentId,
        messageId: claim.messageId,
        state: "delivered",
        updatedAt: new Date().toISOString()
      })
      return "routed"
    }
    await input.store.finishCommentDelivery({
      tenantId: input.tenantId,
      repoFullName: input.repoFullName,
      commentId,
      messageId: claim.messageId,
      state: "indeterminate",
      updatedAt: new Date().toISOString()
    })
    logger.warn({
      tenantId: input.tenantId,
      repo: input.repoFullName,
      commentId,
      messageId: claim.messageId,
      reason: seen
    }, "github comment delivery is indeterminate; not replaying")
    return "indeterminate"
  }

  try {
    await handleCommentEvent(input.harness, { ...commentEvent, dispatchMessageId: claim.messageId })
    const seen = await confirmDeliveredPrompt(
      input.harness,
      input.tenantId,
      existing.opencodeSessionId,
      claim.messageId,
      input.commentBody
    )
    if (seen !== "delivered") {
      await input.store.finishCommentDelivery({
        tenantId: input.tenantId,
        repoFullName: input.repoFullName,
        commentId,
        messageId: claim.messageId,
        state: "indeterminate",
        updatedAt: new Date().toISOString()
      })
      return "indeterminate"
    }
    await input.store.finishCommentDelivery({
      tenantId: input.tenantId,
      repoFullName: input.repoFullName,
      commentId,
      messageId: claim.messageId,
      state: "delivered",
      updatedAt: new Date().toISOString()
    })
    return "routed"
  } catch (error) {
    const seen = await confirmDeliveredPrompt(
      input.harness,
      input.tenantId,
      existing.opencodeSessionId,
      claim.messageId,
      input.commentBody
    ).catch(() => "lookup failed" as const)
    if (seen === "delivered") {
      await input.store.finishCommentDelivery({
        tenantId: input.tenantId,
        repoFullName: input.repoFullName,
        commentId,
        messageId: claim.messageId,
        state: "delivered",
        updatedAt: new Date().toISOString()
      })
      return "routed"
    }
    if (seen === "absent" && !isAmbiguousDispatchError(error)) {
      await input.store.releaseCommentDelivery({
        tenantId: input.tenantId,
        repoFullName: input.repoFullName,
        commentId,
        messageId: claim.messageId
      })
      throw error
    }
    await input.store.finishCommentDelivery({
      tenantId: input.tenantId,
      repoFullName: input.repoFullName,
      commentId,
      messageId: claim.messageId,
      state: "indeterminate",
      updatedAt: new Date().toISOString()
    })
    logger.warn({ err: error, commentId, messageId: claim.messageId }, "github comment dispatch is indeterminate; not replaying")
    return "indeterminate"
  }
}

function harnessDuplicate(
  link: { opencodeSessionId: string; id: string },
  runId: string,
  turnState: IssueTurnState
): IssueAssignmentResult {
  return {
    path: "harness",
    sessionId: link.opencodeSessionId,
    runId,
    linkId: link.id,
    turnState,
    duplicate: true
  }
}

function indeterminateResult(input: {
  reason: string
  runId?: string
  linkId?: string
  sessionId?: string
  messageId?: string
}): IssueAssignmentResult {
  logger.warn({
    reason: input.reason,
    runId: input.runId,
    linkId: input.linkId,
    sessionId: input.sessionId,
    messageId: input.messageId
  }, "issue turn is indeterminate; not replaying. Operator recovery required")
  return { path: "indeterminate", ...input }
}

async function reconcileStaleTurn(input: {
  store: RunStore
  harness: HarnessCtx
  tenantId: string
  runId: string
  link: { id: string; opencodeSessionId: string; turnMessageId: string | null; turnPrompt: string | null; turnState: IssueTurnState | null }
  now?: () => Date
}): Promise<IssueAssignmentResult> {
  const messageId = input.link.turnMessageId
  const prompt = input.link.turnPrompt
  if (!messageId || prompt == null) {
    return recordIndeterminate({
      store: input.store,
      tenantId: input.tenantId,
      linkId: input.link.id,
      runId: input.runId,
      sessionId: input.link.opencodeSessionId,
      reason: "stale in_progress has no recorded message id; lease timeout cannot prove the remote turn is absent",
      now: input.now
    })
  }
  const seen = await confirmDeliveredPrompt(input.harness, input.tenantId, input.link.opencodeSessionId, messageId, prompt)
  if (seen === "delivered") {
    if (input.link.turnState !== "in_progress") {
      return indeterminateResult({
        reason: "remote prompt is present but local turn is not in_progress; not changing state and not replaying",
        runId: input.runId,
        linkId: input.link.id,
        sessionId: input.link.opencodeSessionId,
        messageId
      })
    }
    const finished = await input.store.finishIssueTurn({
      tenantId: input.tenantId,
      linkId: input.link.id,
      state: "completed",
      updatedAt: nowIso(input.now)
    })
    return {
      path: "harness",
      sessionId: finished.opencodeSessionId,
      runId: input.runId,
      linkId: finished.id,
      turnState: "completed",
      duplicate: true
    }
  }
  const reason = `${seen}. Not replaying. Operator must inspect OpenCode session ${input.link.opencodeSessionId} message ${messageId} before any retry.`
  if (input.link.turnState !== "in_progress") {
    return indeterminateResult({
      reason,
      runId: input.runId,
      linkId: input.link.id,
      sessionId: input.link.opencodeSessionId,
      messageId
    })
  }
  return recordIndeterminate({
    store: input.store,
    tenantId: input.tenantId,
    linkId: input.link.id,
    runId: input.runId,
    sessionId: input.link.opencodeSessionId,
    messageId,
    reason,
    now: input.now
  })
}

async function recordIndeterminate(input: {
  store: RunStore
  tenantId: string
  linkId: string
  runId: string
  sessionId: string
  messageId?: string
  reason: string
  now?: () => Date
}): Promise<IssueAssignmentResult> {
  await input.store.finishIssueTurn({
    tenantId: input.tenantId,
    linkId: input.linkId,
    state: "indeterminate",
    error: input.reason.slice(0, 500),
    updatedAt: nowIso(input.now)
  }).catch(error => {
    logger.warn({ err: error, linkId: input.linkId }, "failed to record indeterminate issue turn")
  })
  return indeterminateResult({
    reason: input.reason,
    runId: input.runId,
    linkId: input.linkId,
    sessionId: input.sessionId,
    messageId: input.messageId
  })
}

async function recoverFailedDispatch(input: {
  store: RunStore
  harness: HarnessCtx
  tenantId: string
  linkId: string
  runId: string
  sessionId: string
  messageId: string
  prompt: string
  error: unknown
  now?: () => Date
}): Promise<IssueAssignmentResult> {
  const message = input.error instanceof Error ? input.error.message : String(input.error)
  const seen = await confirmDeliveredPrompt(input.harness, input.tenantId, input.sessionId, input.messageId, input.prompt)
    .catch(() => "lookup failed")
  if (seen === "delivered" || seen !== "absent" || isAmbiguousDispatchError(input.error)) {
    const reason = seen === "delivered"
      ? "dispatch returned an error after the remote message was stored; not replaying"
      : `${seen}; ${message}. Not replaying.`
    logger.warn({ err: input.error, linkId: input.linkId, messageId: input.messageId }, reason)
    return recordIndeterminate({
      store: input.store,
      tenantId: input.tenantId,
      linkId: input.linkId,
      runId: input.runId,
      sessionId: input.sessionId,
      messageId: input.messageId,
      reason,
      now: input.now
    })
  }
  await input.store.finishIssueTurn({
    tenantId: input.tenantId,
    linkId: input.linkId,
    state: "failed",
    error: message.slice(0, 500),
    updatedAt: nowIso(input.now),
    clearDispatch: true
  }).catch(finishError => {
    logger.warn({ err: finishError, linkId: input.linkId }, "failed to record issue turn failure")
  })
  logger.warn({ err: input.error, linkId: input.linkId, runId: input.runId }, "opt-in issue work turn failed before the remote message existed")
  return {
    path: "failed",
    reason: message,
    runId: input.runId,
    linkId: input.linkId,
    sessionId: input.sessionId
  }
}

async function dispatchTurn(
  harness: HarnessCtx,
  tenantId: string,
  sessionId: string,
  prompt: string,
  messageId: string
): Promise<void> {
  const config = withMessageId(opencodeSessionConfigFor(harness, tenantId), messageId)
  if (harness.sessions) await harness.sessions.appendTurn(sessionId, prompt, config)
  else await defaultAppendTurn(sessionId, prompt, config)
}

function withMessageId(config: OpencodeSessionConfig | undefined, messageId: string): OpencodeSessionConfig {
  return { ...config, messageId }
}

async function confirmDeliveredPrompt(
  harness: HarnessCtx,
  tenantId: string,
  sessionId: string,
  messageId: string,
  prompt: string
): Promise<"delivered" | "absent" | "mismatch" | "lookup failed"> {
  try {
    const lookup = await getSessionMessage(sessionId, messageId, opencodeSessionConfigFor(harness, tenantId))
    if (!lookup.found) return "absent"
    const matches = lookup.texts.filter(text => text === prompt)
    if (matches.length === 1 && lookup.texts.length === 1) return "delivered"
    return "mismatch"
  } catch (error) {
    logger.warn({ err: error, sessionId, messageId }, "opencode message lookup failed")
    return "lookup failed"
  }
}

function isAmbiguousDispatchError(error: unknown): boolean {
  if (!(error instanceof OpencodeUnreachableError)) return false
  return error.kind === "network" || error.status === undefined || error.status >= 500
}

function conflictResult(linkIds: string[]): IssueAssignmentResult {
  logger.warn({ linkIds }, "opt-in issue assignment conflict; not overwriting")
  return {
    path: "conflict",
    reason: `link keys resolve to more than one session: ${linkIds.join(", ")}`,
    linkIds
  }
}

async function resolveWithRetry(store: RunStore, tenantId: string, keys: LinkKey[]) {
  let pending: SessionLinkPendingError | null = null
  for (let attempt = 0; attempt < PENDING_RETRIES; attempt += 1) {
    try {
      return await resolveLink(store, tenantId, keys)
    } catch (error) {
      if (!(error instanceof SessionLinkPendingError)) throw error
      pending = error
      await delay(PENDING_WAIT_MS)
    }
  }
  throw pending ?? new Error("session link claim still pending")
}

function nowIso(now?: () => Date): string {
  return (now?.() ?? new Date()).toISOString()
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
