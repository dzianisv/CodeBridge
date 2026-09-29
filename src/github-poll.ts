import type { AppConfig, RepoConfig, TenantConfig } from "./types.js"
import { SessionLinkResolveConflictError, type RunStore } from "./storage.js"
import type { RunService } from "./run-service.js"
import { handleAssignmentEvent, type HarnessCtx } from "./harness.js"
import { handleOptInIssueAssignment, issueAssignmentEnabled, routeLinkedGitHubComment } from "./issue-assignment.js"
import { nanoid } from "nanoid"
import { createInstallationClient, formatPrivateKey } from "./github-auth.js"
import { extractCommand, extractCommandFromManagedIssue, type CommandType } from "./commands.js"
import {
  buildAssigneeMentionPrefixes,
  mergeGithubCommandPrefixes,
  resolveDefaultGithubCommandPrefixes,
  resolveGithubAppIdentity
} from "./command-prefixes.js"
import { postDiscussionCommentByNumber } from "./github-discussions.js"
import { ensureRepoPath } from "./repo.js"
import { logger } from "./logger.js"

export type GitHubPollEnv = {
  githubAppId?: number
  githubPrivateKey?: string
  githubPollIntervalSec: number
  githubPollBackfill: boolean
}

type GitHubClient = Awaited<ReturnType<typeof createInstallationClient>>

export function startGitHubPolling(params: {
  config: AppConfig
  store: RunStore
  runService: RunService
  harness: HarnessCtx
  env: GitHubPollEnv
}) {
  const { config, store, runService, harness, env } = params
  if (!env.githubAppId || !env.githubPrivateKey) {
    logger.warn("GitHub polling disabled: missing GITHUB_APP_ID or GITHUB_PRIVATE_KEY")
    return
  }
  if (!Number.isFinite(env.githubPollIntervalSec) || env.githubPollIntervalSec <= 0) {
    return
  }

  const intervalMs = Math.max(10000, env.githubPollIntervalSec * 1000)
  logger.info({ intervalSec: env.githubPollIntervalSec }, "GitHub polling enabled")
  let running = false
  const tokenTtlMs = 50 * 60 * 1000
  const clientCache = new Map<number, { client: GitHubClient; expiresAt: number }>()
  const defaultPrefixesPromise = resolveDefaultGithubCommandPrefixes(env)
  const appIdentityPromise = resolveGithubAppIdentity(env)

  const tick = async () => {
    if (running) return
    running = true
    try {
      for (const tenant of config.tenants) {
        if (!tenant.github?.installationId) continue
        const installationId = tenant.github.installationId
        const client = await getClient(installationId)
        if (!client) continue

        for (const repo of tenant.repos) {
          await pollRepo(tenant, repo, client)
        }
      }
    } catch (error) {
      logger.error(error, "GitHub polling failed")
    } finally {
      running = false
    }
  }

  const getClient = async (installationId: number): Promise<GitHubClient | null> => {
    const cached = clientCache.get(installationId)
    if (cached && cached.expiresAt > Date.now()) return cached.client
    const client = await createInstallationClient({
      appId: env.githubAppId!,
      privateKey: formatPrivateKey(env.githubPrivateKey!),
      installationId
    })
    clientCache.set(installationId, { client, expiresAt: Date.now() + tokenTtlMs })
    return client
  }

  const pollRepo = async (tenant: TenantConfig, repo: RepoConfig, client: GitHubClient) => {
    const repoFullName = repo.fullName
    const allowlist = tenant.github?.repoAllowlist
    if (allowlist && !allowlist.some(r => r.toLowerCase() === repoFullName.toLowerCase())) return

    const [owner, repoName] = repoFullName.split("/")
    if (!owner || !repoName) return

    await pollAssignedIssues({
      tenant,
      repo,
      owner,
      repoName,
      client,
      store,
      runService,
      harness,
      appIdentityPromise
    })

    await pollAssignedPullRequests({
      tenant,
      repo,
      owner,
      repoName,
      client,
      harness,
      appIdentityPromise
    })

    await pollDiscussionComments({
      tenant,
      repo,
      owner,
      repoName,
      client,
      store,
      runService,
      defaultPrefixesPromise,
      appIdentityPromise,
      githubPollBackfill: env.githubPollBackfill
    })

    const state = await store.getGithubPollState(tenant.id, repoFullName)
    const response = await client.octokit.issues.listCommentsForRepo({
      owner,
      repo: repoName,
      per_page: 100,
      sort: "created",
      direction: "desc"
    })

    const comments = response.data
    const newest = comments[0]
    const newestId = newest?.id ?? null
    const newestCreatedAt = newest?.created_at ?? null

    if (!state && !env.githubPollBackfill) {
      await store.updateGithubPollState({
        tenantId: tenant.id,
        repoFullName,
        lastCommentId: newestId,
        lastCommentCreatedAt: newestCreatedAt
      })
      return
    }

    const lastId = state?.lastCommentId ?? 0
    const pending = comments
      .filter(comment => typeof comment.id === "number" && comment.id > lastId)
      .sort((a, b) => a.id - b.id)
    const defaultPrefixes = pending.length > 0
      ? await resolveDefaultPrefixesWithTimeout(defaultPrefixesPromise)
      : []
    const issueMetaByNumber = new Map<number, { title: string; body?: string; managed: boolean; isPullRequest: boolean }>()

    const getIssueMeta = async (issueNumber: number) => {
      const cached = issueMetaByNumber.get(issueNumber)
      if (cached) return cached

      const issue = await client.octokit.issues.get({
        owner,
        repo: repoName,
        issue_number: issueNumber
      })
      const meta = {
        title: issue.data.title,
        body: issue.data.body ?? undefined,
        managed: hasManagedLabel(issue.data.labels),
        isPullRequest: Boolean(issue.data.pull_request)
      }
      issueMetaByNumber.set(issueNumber, meta)
      return meta
    }

    for (const comment of pending) {
      try {
        if (!comment.body) continue
        if (comment.user?.type === "Bot" || comment.user?.login?.endsWith("[bot]")) continue

        const issueNumber = parseIssueNumber(comment.issue_url)
        if (!issueNumber) continue

        // A comment on a PR/issue with an active session_link is a turn in
        // that session (LLD §6), same routing #18 gave the assignment path.
        // resolveLink is checked before the legacy command-prefix gate; a
        // miss (or an ambiguous/pending link) falls through unchanged.
        const issueMetaForLink = await getIssueMeta(issueNumber)
        const linked = await deliverPolledIssueComment({
          store,
          harness,
          tenantId: tenant.id,
          repoFullName,
          issueNumber,
          isPullRequest: issueMetaForLink.isPullRequest,
          title: issueMetaForLink.title,
          commentBody: comment.body,
          authorIsBot: false,
          repoPath: await ensureRepoPath(repo),
          commentId: comment.id
        })
        if (linked === "routed" || linked === "conflict" || linked === "indeterminate") continue

        const assigneePrefixes = buildAssigneeMentionPrefixes(tenant.github?.assignmentAssignees)
        const prefixes = mergeGithubCommandPrefixes(
          assigneePrefixes,
          defaultPrefixes
        )
        const explicitCommand = extractCommand(comment.body, prefixes)
        const managedCommand = explicitCommand
          ? explicitCommand
          : (() => {
              const loose = extractCommandFromManagedIssue(comment.body)
              if (!loose) return null
              const withReplyDefault = loose.type === "run" ? { ...loose, type: "reply" as const } : loose
              return withReplyDefault
            })()
        let command = managedCommand
        if (!explicitCommand && command) {
          const issueMeta = await getIssueMeta(issueNumber)
          if (!issueMeta.managed) command = null
        }
        if (!command) continue
        if (command.tenantHint && command.tenantHint.toLowerCase() !== tenant.id.toLowerCase()) continue

        if (command.type === "status") {
          await postIssueStatus({
            tenantId: tenant.id,
            repoFullName,
            issueNumber,
            owner,
            repo: repoName,
            client,
            store
          })
          continue
        }

        if (command.type === "pause" || command.type === "resume") {
          await postControlAck({
            commandType: command.type,
            issueNumber,
            owner,
            repo: repoName,
            client
          })
          continue
        }

        const sourceKey = buildSourceKey({
          installationId: tenant.github?.installationId,
          repoFullName,
          issueNumber,
          commentId: comment.id,
          commandType: command.type
        })
        const existing = await store.getRunBySourceKey(sourceKey)
        if (existing) continue

        const issue = await getIssueMeta(issueNumber)

        const repoPath = await ensureRepoPath(repo)
        const prompt = command.type === "reply"
          ? buildReplyPrompt(issueNumber, command.prompt)
          : command.prompt

        await runService.createRun({
          tenantId: tenant.id,
          repoFullName: repo.fullName,
          repoPath,
          sourceKey,
          prompt,
          model: repo.model,
          branchPrefix: repo.branchPrefix,
          github: {
            owner,
            repo: repoName,
            issueNumber,
            installationId: tenant.github?.installationId,
            issueTitle: issue.title,
            issueBody: issue.body,
            triggerCommentId: comment.id
          }
        })
      } catch (error) {
        logger.error({ err: error, tenantId: tenant.id, repo: repoFullName, commentId: comment.id }, "GitHub polling comment failed")
      }
    }

    await store.updateGithubPollState({
      tenantId: tenant.id,
      repoFullName,
      lastCommentId: newestId ?? (state?.lastCommentId ?? null),
      lastCommentCreatedAt: newestCreatedAt ?? null
    })
  }

  const timer = setInterval(() => {
    tick().catch(error => logger.error(error, "GitHub polling tick failed"))
  }, intervalMs)

  tick().catch(error => logger.error(error, "GitHub polling tick failed"))

  return () => clearInterval(timer)
}

export async function deliverPolledIssueComment(input: {
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
  return routeLinkedGitHubComment(input)
}

export async function pollAssignedIssues(input: {
  tenant: TenantConfig
  repo: RepoConfig
  owner: string
  repoName: string
  client: GitHubClient
  store: RunStore
  runService: RunService
  harness: HarnessCtx
  appIdentityPromise: Promise<{ slug?: string; botLogin?: string } | null>
}): Promise<void> {
  const assignees = await resolveValidatedAssignmentAssignees(input)
  if (assignees.length === 0) return

  const issuesByNumber = new Map<number, {
    number: number
    title: string
    body: string | null
    pull_request?: unknown
    labels: Array<{ name?: string } | string>
  }>()

  for (const assignee of assignees) {
    let response: Awaited<ReturnType<typeof input.client.octokit.issues.listForRepo>>
    try {
      response = await input.client.octokit.issues.listForRepo({
        owner: input.owner,
        repo: input.repoName,
        state: "open",
        assignee,
        per_page: 100,
        sort: "updated",
        direction: "desc"
      })
    } catch (error) {
      if (markAssigneeUnknownOnList422(error, {
        tenantId: input.tenant.id,
        installationId: input.tenant.github?.installationId,
        repoFullName: input.repo.fullName,
        login: assignee
      })) {
        continue
      }
      logger.warn({
        err: error,
        tenantId: input.tenant.id,
        repoFullName: input.repo.fullName,
        assignee
      }, "Skipping invalid assignment assignee in polling")
      continue
    }
    for (const issue of response.data) {
      if (!issue.number || issuesByNumber.has(issue.number)) continue
      issuesByNumber.set(issue.number, {
        number: issue.number,
        title: issue.title,
        body: issue.body ?? null,
        pull_request: issue.pull_request,
        labels: issue.labels as Array<{ name?: string } | string>
      })
    }
  }

  for (const issue of issuesByNumber.values()) {
    if (issue.pull_request) continue
    if (!issue.number) continue

    // Opt-in is checked before the managed-label skip. The label is the Codex
    // dedupe, not the harness one; skipping here would drop a pending turn
    // after restart. Legacy issues still hit that skip below, unchanged.
    if (issueAssignmentEnabled(input.tenant, input.repo.fullName)) {
      const repoPath = await ensureRepoPath(input.repo)
      const routed = await handleOptInIssueAssignment({
        store: input.store,
        harness: input.harness,
        tenant: input.tenant,
        repo: input.repo,
        owner: input.owner,
        repoName: input.repoName,
        installationId: input.tenant.github?.installationId,
        issueNumber: issue.number,
        title: issue.title,
        body: issue.body ?? undefined,
        repoPath,
        runId: nanoid(8)
      })
      if (routed.path === "conflict" || routed.path === "failed" || routed.path === "pending" || routed.path === "indeterminate") {
        logger.warn({
          tenantId: input.tenant.id,
          repo: input.repo.fullName,
          issueNumber: issue.number,
          result: routed
        }, "opt-in issue assignment did not complete")
      }
      continue
    }

    if (hasManagedLabel(issue.labels)) continue

    const sourceKey = [
      "github-assigned",
      input.tenant.github?.installationId ?? "none",
      input.repo.fullName.toLowerCase(),
      issue.number
    ].join(":")

    const existing = await input.store.getRunBySourceKey(sourceKey)
    if (existing) continue

    const repoPath = await ensureRepoPath(input.repo)
    await input.runService.createRun({
      tenantId: input.tenant.id,
      repoFullName: input.repo.fullName,
      repoPath,
      sourceKey,
      prompt: buildIssueBootstrapPrompt(issue.number, issue.title, issue.body ?? undefined),
      model: input.repo.model,
      branchPrefix: input.repo.branchPrefix,
      github: {
        owner: input.owner,
        repo: input.repoName,
        issueNumber: issue.number,
        installationId: input.tenant.github?.installationId,
        issueTitle: issue.title,
        issueBody: issue.body ?? undefined
      }
    })
  }
}

// PR assignment is a harness trigger, not a Codex run. pollAssignedIssues
// still skips pull_request items so this does not double-bootstrap run-service.
// Do not resolve Closes/branch/hints here: candidateKeys() in harness.ts is
// the only precedence. This only fills AssignmentEvent and hands it off.
export async function pollAssignedPullRequests(input: {
  tenant: TenantConfig
  repo: RepoConfig
  owner: string
  repoName: string
  client: GitHubClient
  harness: HarnessCtx
  appIdentityPromise: Promise<{ slug?: string; botLogin?: string } | null>
}): Promise<void> {
  const assignees = await resolveValidatedAssignmentAssignees(input)
  if (assignees.length === 0) return

  const numbers = new Set<number>()
  for (const assignee of assignees) {
    let response: Awaited<ReturnType<typeof input.client.octokit.issues.listForRepo>>
    try {
      response = await input.client.octokit.issues.listForRepo({
        owner: input.owner,
        repo: input.repoName,
        state: "open",
        assignee,
        per_page: 100,
        sort: "updated",
        direction: "desc"
      })
    } catch (error) {
      if (markAssigneeUnknownOnList422(error, {
        tenantId: input.tenant.id,
        installationId: input.tenant.github?.installationId,
        repoFullName: input.repo.fullName,
        login: assignee
      })) {
        continue
      }
      logger.warn({
        err: error,
        tenantId: input.tenant.id,
        repoFullName: input.repo.fullName,
        assignee
      }, "Skipping invalid assignment assignee in PR polling")
      continue
    }
    for (const issue of response.data) {
      if (!issue.pull_request || !issue.number) continue
      numbers.add(issue.number)
    }
  }
  if (numbers.size === 0) return

  const repoPath = await ensureRepoPath(input.repo)
  for (const number of numbers) {
    try {
      const pr = await input.client.octokit.pulls.get({
        owner: input.owner,
        repo: input.repoName,
        pull_number: number
      })
      await handleAssignmentEvent(input.harness, {
        source: "github_pr",
        tenantId: input.tenant.id,
        keys: [{ kind: "gh_pr", repo: input.repo.fullName, number }],
        repoPath,
        title: pr.data.title,
        body: pr.data.body ?? undefined,
        branch: pr.data.head.ref
      })
    } catch (error) {
      if (error instanceof SessionLinkResolveConflictError) {
        logger.warn({
          err: error,
          tenantId: input.tenant.id,
          repoFullName: input.repo.fullName,
          number
        }, "github pr assignment conflict; not routing")
        continue
      }
      logger.error({
        err: error,
        tenantId: input.tenant.id,
        repoFullName: input.repo.fullName,
        number
      }, "GitHub PR assignment polling failed")
    }
  }
}

async function pollDiscussionComments(input: {
  tenant: TenantConfig
  repo: RepoConfig
  owner: string
  repoName: string
  client: GitHubClient
  store: RunStore
  runService: RunService
  defaultPrefixesPromise: Promise<string[]>
  appIdentityPromise: Promise<{ slug?: string; botLogin?: string } | null>
  githubPollBackfill: boolean
}): Promise<void> {
  const discussionPollKey = `${input.repo.fullName}#discussion`
  const state = await input.store.getGithubPollState(input.tenant.id, discussionPollKey)
  const appIdentity = await resolveAppIdentityWithTimeout(input.appIdentityPromise)

  let graphData: {
    repository?: {
      discussions?: {
        nodes?: Array<{
          number: number
          title: string
          body: string | null
          comments?: {
            nodes?: Array<{
              id: string
              body: string
              createdAt: string
              author?: { login?: string | null } | null
            }>
          }
        }>
      }
    }
  } | null = null

  try {
    graphData = await input.client.octokit.graphql(
      `
        query PollDiscussions($owner: String!, $repo: String!) {
          repository(owner: $owner, name: $repo) {
            discussions(first: 20, orderBy: { field: UPDATED_AT, direction: DESC }) {
              nodes {
                number
                title
                body
                comments(first: 50) {
                  nodes {
                    id
                    body
                    createdAt
                    author {
                      login
                    }
                  }
                }
              }
            }
          }
        }
      `,
      {
        owner: input.owner,
        repo: input.repoName
      }
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("Resource not accessible by integration")) {
      return
    }
    logger.warn({
      err: error,
      tenantId: input.tenant.id,
      repoFullName: input.repo.fullName
    }, "GitHub discussion polling failed")
    return
  }

  const discussions = graphData?.repository?.discussions?.nodes ?? []
  const flattened = discussions.flatMap(discussion =>
    (discussion.comments?.nodes ?? []).map(comment => ({
      discussionNumber: discussion.number,
      discussionTitle: discussion.title,
      discussionBody: discussion.body ?? undefined,
      commentId: comment.id,
      body: comment.body,
      createdAt: comment.createdAt,
      authorLogin: comment.author?.login ?? undefined
    }))
  )

  const newestCreatedAt = flattened
    .map(item => item.createdAt)
    .sort((a, b) => b.localeCompare(a))[0] ?? null

  if (!state && !input.githubPollBackfill) {
    await input.store.updateGithubPollState({
      tenantId: input.tenant.id,
      repoFullName: discussionPollKey,
      lastCommentId: null,
      lastCommentCreatedAt: newestCreatedAt
    })
    return
  }

  const lastCreatedAt = state?.lastCommentCreatedAt ?? null
  const pending = flattened
    .filter(item => !lastCreatedAt || item.createdAt > lastCreatedAt)
    .sort((a, b) => {
      if (a.createdAt === b.createdAt) return a.commentId.localeCompare(b.commentId)
      return a.createdAt.localeCompare(b.createdAt)
    })

  const defaultPrefixes = pending.length > 0
    ? await resolveDefaultPrefixesWithTimeout(input.defaultPrefixesPromise)
    : []

  for (const comment of pending) {
    try {
      if (!comment.body?.trim()) continue
      if (!comment.authorLogin) continue
      const authorLower = comment.authorLogin.toLowerCase()
      if (
        authorLower.endsWith("[bot]") ||
        (appIdentity?.slug && authorLower === appIdentity.slug.toLowerCase()) ||
        (appIdentity?.botLogin && authorLower === appIdentity.botLogin.toLowerCase())
      ) {
        continue
      }

      const assigneePrefixes = buildAssigneeMentionPrefixes(input.tenant.github?.assignmentAssignees)
      const prefixes = mergeGithubCommandPrefixes(
        assigneePrefixes,
        defaultPrefixes
      )
      const command = extractCommand(comment.body, prefixes)
      if (!command) continue
      if (command.tenantHint && command.tenantHint.toLowerCase() !== input.tenant.id.toLowerCase()) continue

      if (command.type === "pause" || command.type === "resume" || command.type === "status") {
        await postDiscussionCommentByNumber(input.client, {
          owner: input.owner,
          repo: input.repoName,
          discussionNumber: comment.discussionNumber,
          body: "This command is currently supported on issues/PR threads only. Use `run` or `reply` in discussions."
        })
        continue
      }

      const sourceKey = [
        "github-discussion",
        input.tenant.github?.installationId ?? "none",
        input.repo.fullName.toLowerCase(),
        comment.discussionNumber,
        comment.commentId,
        command.type
      ].join(":")

      const existing = await input.store.getRunBySourceKey(sourceKey)
      if (existing) continue

      const repoPath = await ensureRepoPath(input.repo)
      const prompt = command.type === "reply"
        ? buildDiscussionReplyPrompt(comment.discussionNumber, command.prompt)
        : command.prompt

      await input.runService.createRun({
        tenantId: input.tenant.id,
        repoFullName: input.repo.fullName,
        repoPath,
        sourceKey,
        prompt,
        model: input.repo.model,
        branchPrefix: input.repo.branchPrefix,
        github: {
          owner: input.owner,
          repo: input.repoName,
          issueNumber: comment.discussionNumber,
          installationId: input.tenant.github?.installationId,
          issueTitle: comment.discussionTitle,
          issueBody: comment.discussionBody
        }
      })
    } catch (error) {
      logger.error({
        err: error,
        tenantId: input.tenant.id,
        repoFullName: input.repo.fullName,
        discussionNumber: comment.discussionNumber,
        commentId: comment.commentId
      }, "GitHub discussion comment polling failed")
    }
  }

  await input.store.updateGithubPollState({
    tenantId: input.tenant.id,
    repoFullName: discussionPollKey,
    lastCommentId: null,
    lastCommentCreatedAt: newestCreatedAt ?? (state?.lastCommentCreatedAt ?? null)
  })
}

function resolveAssignmentAssignees(configured: string[] | undefined, botLogin?: string): string[] {
  const values = new Set<string>()
  if (botLogin) values.add(botLogin.trim().toLowerCase())
  for (const value of configured ?? []) {
    const normalized = value.trim().toLowerCase()
    if (!normalized) continue
    values.add(normalized)
  }
  return [...values]
}

const ASSIGNEE_VALIDATION_TTL_MS = 5 * 60 * 1000
const ASSIGNEE_UNKNOWN_RETRY_MS = ASSIGNEE_VALIDATION_TTL_MS

type AssigneeValidityStatus = "valid" | "invalid" | "unknown"
type AssigneeInstallationId = number | "none"

type AssigneeValidityEntry = {
  installationId: AssigneeInstallationId
  repo: string
  login: string
  status: AssigneeValidityStatus
  httpStatus: number | null
  checkedAt: number
}

const assigneeValidityCache = new Map<string, AssigneeValidityEntry>()
let assigneeValidationNow = (): number => Date.now()

export type AssigneeValidationHealth = {
  ttlMs: number
  unknownRetryMs: number
  counts: { valid: number; invalid: number; unknown: number }
  entries: Array<{
    installationId: AssigneeInstallationId
    repo: string
    login: string
    status: AssigneeValidityStatus
    httpStatus: number | null
    checkedAt: string
    ageMs: number
  }>
}

export function resetAssigneeValidityCacheForTests(): void {
  assigneeValidityCache.clear()
}

export function setAssigneeValidationNowForTests(now: (() => number) | null): void {
  assigneeValidationNow = now ?? (() => Date.now())
}

export function getAssigneeValidationHealth(): AssigneeValidationHealth {
  const now = assigneeValidationNow()
  const entries = [...assigneeValidityCache.values()]
    .sort((a, b) => {
      const installation = compareInstallationId(a.installationId, b.installationId)
      if (installation !== 0) return installation
      return a.repo.localeCompare(b.repo) || a.login.localeCompare(b.login)
    })
    .map(entry => ({
      installationId: entry.installationId,
      repo: entry.repo,
      login: entry.login,
      status: entry.status,
      httpStatus: entry.httpStatus,
      checkedAt: new Date(entry.checkedAt).toISOString(),
      ageMs: Math.max(0, now - entry.checkedAt)
    }))
  return {
    ttlMs: ASSIGNEE_VALIDATION_TTL_MS,
    unknownRetryMs: ASSIGNEE_UNKNOWN_RETRY_MS,
    counts: {
      valid: entries.filter(entry => entry.status === "valid").length,
      invalid: entries.filter(entry => entry.status === "invalid").length,
      unknown: entries.filter(entry => entry.status === "unknown").length
    },
    entries
  }
}

function compareInstallationId(a: AssigneeInstallationId, b: AssigneeInstallationId): number {
  if (a === b) return 0
  if (a === "none") return 1
  if (b === "none") return -1
  return a - b
}

function installationCacheId(installationId: number | undefined): AssigneeInstallationId {
  return installationId ?? "none"
}

function assigneeCacheKey(installationId: AssigneeInstallationId, repoFullName: string, login: string): string {
  return `${installationId}::${repoFullName.toLowerCase()}::${login.toLowerCase()}`
}

function readHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) return undefined
  const status = (error as { status?: unknown }).status
  return typeof status === "number" ? status : undefined
}

type AssigneeQuery = {
  status: AssigneeValidityStatus
  httpStatus: number | null
}

async function queryAssigneeValidity(
  client: GitHubClient,
  owner: string,
  repo: string,
  login: string
): Promise<AssigneeQuery> {
  try {
    const response = await client.octokit.issues.checkUserCanBeAssigned({
      owner,
      repo,
      assignee: login
    })
    const httpStatus = typeof response.status === "number" ? response.status : null
    if (httpStatus === 204) return { status: "valid", httpStatus }
    if (httpStatus === 404) return { status: "invalid", httpStatus }
    return { status: "unknown", httpStatus }
  } catch (error) {
    const httpStatus = readHttpStatus(error) ?? null
    if (httpStatus === 404) return { status: "invalid", httpStatus }
    return { status: "unknown", httpStatus }
  }
}

function logAssigneeValidityTransition(input: {
  status: "invalid" | "unknown"
  tenantId: string
  installationId: AssigneeInstallationId
  repo: string
  login: string
  httpStatus: number | null
}): void {
  logger.warn({
    tenantId: input.tenantId,
    installationId: input.installationId,
    repo: input.repo,
    login: input.login,
    httpStatus: input.httpStatus
  }, input.status === "invalid"
    ? "Assignment assignee is not assignable in this repo"
    : "Assignment assignee validity is unknown")
}

function markAssigneeUnknownOnList422(
  error: unknown,
  input: {
    tenantId: string
    installationId: number | undefined
    repoFullName: string
    login: string
  }
): boolean {
  if (readHttpStatus(error) !== 422) return false
  const installationId = installationCacheId(input.installationId)
  const key = assigneeCacheKey(installationId, input.repoFullName, input.login)
  const previous = assigneeValidityCache.get(key)?.status
  assigneeValidityCache.set(key, {
    installationId,
    repo: input.repoFullName,
    login: input.login,
    status: "unknown",
    httpStatus: 422,
    checkedAt: assigneeValidationNow()
  })
  if (previous !== "unknown") {
    logAssigneeValidityTransition({
      status: "unknown",
      tenantId: input.tenantId,
      installationId,
      repo: input.repoFullName,
      login: input.login,
      httpStatus: 422
    })
  }
  return true
}

async function cachedAssigneeValidity(input: {
  client: GitHubClient
  owner: string
  repo: string
  repoFullName: string
  tenantId: string
  installationId: number | undefined
  login: string
}): Promise<AssigneeValidityStatus> {
  const installationId = installationCacheId(input.installationId)
  const key = assigneeCacheKey(installationId, input.repoFullName, input.login)
  const now = assigneeValidationNow()
  const cached = assigneeValidityCache.get(key)
  const retryMs = cached?.status === "unknown" ? ASSIGNEE_UNKNOWN_RETRY_MS : ASSIGNEE_VALIDATION_TTL_MS
  if (cached && now - cached.checkedAt < retryMs) return cached.status

  const result = await queryAssigneeValidity(input.client, input.owner, input.repo, input.login)
  const previous = cached?.status
  assigneeValidityCache.set(key, {
    installationId,
    repo: input.repoFullName,
    login: input.login,
    status: result.status,
    httpStatus: result.httpStatus,
    checkedAt: now
  })
  if (result.status === "invalid" && previous !== "invalid") {
    logAssigneeValidityTransition({
      status: "invalid",
      tenantId: input.tenantId,
      installationId,
      repo: input.repoFullName,
      login: input.login,
      httpStatus: result.httpStatus
    })
  }
  if (result.status === "unknown" && previous !== "unknown") {
    logAssigneeValidityTransition({
      status: "unknown",
      tenantId: input.tenantId,
      installationId,
      repo: input.repoFullName,
      login: input.login,
      httpStatus: result.httpStatus
    })
  }
  return result.status
}

async function resolveValidatedAssignmentAssignees(input: {
  tenant: TenantConfig
  repo: RepoConfig
  owner: string
  repoName: string
  client: GitHubClient
  appIdentityPromise: Promise<{ slug?: string; botLogin?: string } | null>
}): Promise<string[]> {
  const appIdentity = await resolveAppIdentityWithTimeout(input.appIdentityPromise)
  const candidates = resolveAssignmentAssignees(input.tenant.github?.assignmentAssignees, appIdentity?.botLogin)
  const valid: string[] = []
  for (const login of candidates) {
    const status = await cachedAssigneeValidity({
      client: input.client,
      owner: input.owner,
      repo: input.repoName,
      repoFullName: input.repo.fullName,
      tenantId: input.tenant.id,
      installationId: input.tenant.github?.installationId,
      login
    })
    if (status === "valid") valid.push(login)
  }
  return valid
}

export async function pollValidatedAssignmentForTests(input: {
  surface: "issues" | "pull_requests"
  tenant: TenantConfig
  repo: RepoConfig
  client: GitHubClient
  botLogin?: string
}): Promise<void> {
  const [owner, repoName] = input.repo.fullName.split("/")
  if (!owner || !repoName) throw new Error(`invalid repo fullName: ${input.repo.fullName}`)
  const appIdentityPromise = Promise.resolve(input.botLogin ? { botLogin: input.botLogin } : null)
  if (input.surface === "issues") {
    await pollAssignedIssues({
      tenant: input.tenant,
      repo: input.repo,
      owner,
      repoName,
      client: input.client,
      store: {
        getRunBySourceKey: async () => {
          throw new Error("issue assignment poll reached store")
        }
      } as unknown as RunStore,
      runService: {
        createRun: async () => {
          throw new Error("issue assignment poll reached run service")
        }
      } as unknown as RunService,
      appIdentityPromise
    })
    return
  }
  await pollAssignedPullRequests({
    tenant: input.tenant,
    repo: input.repo,
    owner,
    repoName,
    client: input.client,
    harness: {} as HarnessCtx,
    appIdentityPromise
  })
}

async function resolveDefaultPrefixesWithTimeout(
  promise: Promise<string[]>,
  timeoutMs = 5000
): Promise<string[]> {
  const timeout = new Promise<string[]>((resolve) => {
    setTimeout(() => resolve([]), timeoutMs)
  })

  try {
    return await Promise.race([promise, timeout])
  } catch (error) {
    logger.warn({ err: error }, "Falling back: unable to resolve GitHub App mention prefixes")
    return []
  }
}

async function resolveAppIdentityWithTimeout(
  promise: Promise<{ slug?: string; botLogin?: string } | null>,
  timeoutMs = 5000
): Promise<{ slug?: string; botLogin?: string } | null> {
  const timeout = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), timeoutMs)
  })

  try {
    return await Promise.race([promise, timeout])
  } catch (error) {
    logger.warn({ err: error }, "Falling back: unable to resolve GitHub App identity")
    return null
  }
}

function parseIssueNumber(issueUrl?: string | null): number | null {
  if (!issueUrl) return null
  const match = issueUrl.match(/\/issues\/(\d+)/)
  if (!match) return null
  return parseInt(match[1], 10)
}

function buildReplyPrompt(issueNumber: number, prompt: string): string {
  return [
    `Follow-up command from GitHub issue #${issueNumber}:`,
    prompt
  ].join("\n\n")
}

function buildDiscussionReplyPrompt(discussionNumber: number, prompt: string): string {
  return [
    `Follow-up command from GitHub discussion #${discussionNumber}:`,
    prompt
  ].join("\n\n")
}

function buildIssueBootstrapPrompt(issueNumber: number, title: string, body?: string): string {
  const bodyText = body?.trim() ? body.trim() : "(No description provided)"
  return [
    `Work on GitHub issue #${issueNumber}: ${title}`,
    "",
    "Issue description:",
    bodyText
  ].join("\n")
}

function buildSourceKey(input: {
  installationId?: number
  repoFullName: string
  issueNumber: number
  commentId: number
  commandType: CommandType
}): string {
  return [
    "github",
    input.installationId ?? "none",
    input.repoFullName.toLowerCase(),
    input.issueNumber,
    input.commentId,
    input.commandType
  ].join(":")
}

async function postIssueStatus(input: {
  tenantId: string
  repoFullName: string
  issueNumber: number
  owner: string
  repo: string
  client: GitHubClient
  store: RunStore
}) {
  const latest = await input.store.getLatestRunForIssue({
    tenantId: input.tenantId,
    repoFullName: input.repoFullName,
    issueNumber: input.issueNumber
  })

  const body = latest
    ? [
      `Agent status for issue #${input.issueNumber}`,
      `- Run: \`${latest.id}\``,
      `- Status: \`${latest.status}\``,
      `- Updated: ${latest.updatedAt}`,
      latest.prUrl ? `- PR: ${latest.prUrl}` : "- PR: none"
    ].join("\n")
    : `No agent run found for issue #${input.issueNumber}.`

  await input.client.octokit.issues.createComment({
    owner: input.owner,
    repo: input.repo,
    issue_number: input.issueNumber,
    body
  })
}

async function postControlAck(input: {
  commandType: "pause" | "resume"
  issueNumber: number
  owner: string
  repo: string
  client: GitHubClient
}) {
  const body = input.commandType === "pause"
    ? "Pause command acknowledged. Runtime pause is not implemented yet in this bridge."
    : "Resume command acknowledged. Runtime resume is not implemented yet in this bridge."

  await input.client.octokit.issues.createComment({
    owner: input.owner,
    repo: input.repo,
    issue_number: input.issueNumber,
    body
  })
}

function hasManagedLabel(labels?: Array<{ name?: string } | string>): boolean {
  if (!labels || labels.length === 0) return false
  return labels.some(label => {
    const name = typeof label === "string" ? label : label.name
    return name?.toLowerCase() === "agent:managed"
  })
}
