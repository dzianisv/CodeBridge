import { Probot, createNodeMiddleware } from "probot"
import type { Express } from "express"
import { nanoid } from "nanoid"
import { extractCommand, extractCommandFromManagedIssue, type CommandType } from "./commands.js"
import { findTenantByGithubInstallation, findTenantByRepoFullName, resolveRepo, ensureRepoPath } from "./repo.js"
import type { AppConfig, GitHubContext, TenantConfig } from "./types.js"
import { logger } from "./logger.js"
import { formatPrivateKey } from "./github-auth.js"
import {
  buildAssigneeMentionPrefixes,
  mergeGithubCommandPrefixes,
  resolveDefaultGithubCommandPrefixes,
  resolveGithubAppIdentity
} from "./command-prefixes.js"
import type { HarnessCtx } from "./harness.js"
import type { RunStore } from "./storage.js"
import {
  handleOptInIssueAssignment,
  issueAssignmentEnabled,
  routeLinkedGitHubComment,
  type IssueAssignmentResult
} from "./issue-assignment.js"

export type GitHubCommandHandler = (input: {
  tenantId: string
  commandType: CommandType
  prompt: string
  repoFullName: string
  sourceKey: string
  github: GitHubContext
}) => Promise<void>

export type GitHubRouting = {
  store: RunStore
  harness: HarnessCtx
}

export function createGitHubApp(
  config: AppConfig,
  env: {
    githubAppId?: number
    githubPrivateKey?: string
    githubWebhookSecret?: string
  },
  onCommand: GitHubCommandHandler,
  routing?: GitHubRouting
) {
  if (!env.githubAppId || !env.githubPrivateKey || !env.githubWebhookSecret) {
    return null
  }

  const probot = new Probot({
    appId: env.githubAppId,
    privateKey: formatPrivateKey(env.githubPrivateKey),
    secret: env.githubWebhookSecret
  })
  const defaultPrefixesPromise = resolveDefaultGithubCommandPrefixes({
    githubAppId: env.githubAppId,
    githubPrivateKey: env.githubPrivateKey
  })
  const appIdentityPromise = resolveGithubAppIdentity({
    githubAppId: env.githubAppId,
    githubPrivateKey: env.githubPrivateKey
  })

  const appFn = (app: Probot) => {
    app.on("issue_comment.created", async context => {
      const defaultPrefixes = await defaultPrefixesPromise
      await deliverIssueCommentWebhook({
        config,
        routing,
        onCommand,
        installationId: context.payload.installation?.id,
        repoFullName: context.payload.repository.full_name,
        owner: context.payload.repository.owner.login,
        repoName: context.payload.repository.name,
        defaultPrefixes,
        issue: {
          number: context.payload.issue.number,
          title: context.payload.issue.title,
          body: context.payload.issue.body,
          labels: context.payload.issue.labels,
          pullRequest: context.payload.issue.pull_request
        },
        comment: {
          id: context.payload.comment.id,
          body: context.payload.comment.body ?? "",
          userType: context.payload.comment.user?.type,
          userLogin: context.payload.comment.user?.login
        }
      })
    })

    app.on("discussion_comment.created", async context => {
      const installationId = context.payload.installation?.id
      const repoFullName = context.payload.repository.full_name
      const defaultTenant = findTenantByGithubInstallation(config, installationId) ?? findTenantByRepoFullName(config, repoFullName)
      if (!defaultTenant?.github) return

      if (defaultTenant.github.repoAllowlist && !defaultTenant.github.repoAllowlist.includes(repoFullName)) return

      const defaultPrefixes = await defaultPrefixesPromise
      const assigneePrefixes = buildAssigneeMentionPrefixes(defaultTenant.github.assignmentAssignees)
      const prefixes = mergeGithubCommandPrefixes(
        assigneePrefixes,
        defaultPrefixes
      )
      const body = context.payload.comment.body ?? ""
      const command = extractCommand(body, prefixes)
      if (!command) return
      if (command.type !== "run" && command.type !== "reply") return

      const tenant = resolveTargetTenant({
        config,
        defaultTenant,
        tenantHint: command.tenantHint,
        installationId,
        repoFullName
      })
      if (!tenant) return

      const repo = resolveRepo(tenant, repoFullName)
      if (!repo) return

      const discussion = context.payload.discussion
      const sourceKey = [
        "github-discussion",
        installationId ?? "none",
        repoFullName.toLowerCase(),
        discussion.number,
        context.payload.comment.node_id ?? context.payload.comment.id,
        command.type
      ].join(":")
      const github: GitHubContext = {
        owner: context.payload.repository.owner.login,
        repo: context.payload.repository.name,
        issueNumber: discussion.number,
        installationId,
        issueTitle: discussion.title,
        issueBody: discussion.body ?? undefined
      }

      await onCommand({
        tenantId: tenant.id,
        commandType: command.type,
        prompt: command.prompt,
        repoFullName: repo.fullName,
        sourceKey,
        github
      })
    })

    app.on("issues.assigned", async context => {
      const appIdentity = await appIdentityPromise
      await deliverIssuesAssignedWebhook({
        config,
        routing,
        onCommand,
        installationId: context.payload.installation?.id,
        repoFullName: context.payload.repository.full_name,
        owner: context.payload.repository.owner.login,
        repoName: context.payload.repository.name,
        assigneeLogin: context.payload.assignee?.login,
        botLogin: appIdentity?.botLogin,
        issue: {
          number: context.payload.issue.number,
          title: context.payload.issue.title,
          body: context.payload.issue.body,
          labels: context.payload.issue.labels
        }
      })
    })
  }

  probot.load(appFn)
  const middleware = createNodeMiddleware(appFn, {
    probot,
    webhooksPath: "/github/webhook"
  })

  const mount = (app: Express) => {
    app.use(middleware)
    logger.info("GitHub webhook mounted at /github/webhook")
  }

  return { probot, mount }
}

export async function deliverIssueCommentWebhook(input: {
  config: AppConfig
  routing?: GitHubRouting
  onCommand: GitHubCommandHandler
  installationId?: number
  repoFullName: string
  owner: string
  repoName: string
  defaultPrefixes: string[]
  issue: {
    number: number
    title: string
    body?: string | null
    labels?: Array<{ name?: string } | string>
    pullRequest?: unknown
  }
  comment: {
    id: number
    body: string
    userType?: string | null
    userLogin?: string | null
  }
}): Promise<"routed" | "conflict" | "indeterminate" | "ignored" | "legacy"> {
  const defaultTenant = findTenantByGithubInstallation(input.config, input.installationId) ?? findTenantByRepoFullName(input.config, input.repoFullName)
  if (!defaultTenant?.github) return "ignored"
  if (defaultTenant.github.repoAllowlist && !defaultTenant.github.repoAllowlist.includes(input.repoFullName)) return "ignored"

  if (input.routing) {
    const repo = resolveRepo(defaultTenant, input.repoFullName)
    const linked = await routeLinkedGitHubComment({
      store: input.routing.store,
      harness: input.routing.harness,
      tenantId: defaultTenant.id,
      repoFullName: input.repoFullName,
      issueNumber: input.issue.number,
      isPullRequest: Boolean(input.issue.pullRequest),
      title: input.issue.title,
      commentBody: input.comment.body,
      authorIsBot: input.comment.userType === "Bot" || Boolean(input.comment.userLogin?.endsWith("[bot]")),
      repoPath: repo ? await ensureRepoPath(repo) : undefined,
      commentId: input.comment.id
    })
    if (linked === "routed" || linked === "conflict" || linked === "indeterminate") return linked
  }

  const assigneePrefixes = buildAssigneeMentionPrefixes(defaultTenant.github.assignmentAssignees)
  const prefixes = mergeGithubCommandPrefixes(assigneePrefixes, input.defaultPrefixes)
  const issueManaged = hasManagedLabel(input.issue.labels)
  const command = extractCommand(input.comment.body, prefixes) ?? (issueManaged ? extractCommandFromManagedIssue(input.comment.body) : null)
  if (!command) return "ignored"
  if (command.type !== "run" && command.type !== "reply") return "ignored"

  const tenant = resolveTargetTenant({
    config: input.config,
    defaultTenant,
    tenantHint: command.tenantHint,
    installationId: input.installationId,
    repoFullName: input.repoFullName
  })
  if (!tenant) return "ignored"
  const repo = resolveRepo(tenant, input.repoFullName)
  if (!repo) return "ignored"

  const sourceKey = [
    "github",
    input.installationId ?? "none",
    input.repoFullName.toLowerCase(),
    input.issue.number,
    input.comment.id,
    command.type
  ].join(":")
  await input.onCommand({
    tenantId: tenant.id,
    commandType: command.type,
    prompt: command.prompt,
    repoFullName: repo.fullName,
    sourceKey,
    github: {
      owner: input.owner,
      repo: input.repoName,
      issueNumber: input.issue.number,
      triggerCommentId: input.comment.id,
      installationId: input.installationId,
      issueTitle: input.issue.title,
      issueBody: input.issue.body ?? undefined
    }
  })
  return "legacy"
}

export async function deliverIssuesAssignedWebhook(input: {
  config: AppConfig
  routing?: GitHubRouting
  onCommand: GitHubCommandHandler
  installationId?: number
  repoFullName: string
  owner: string
  repoName: string
  assigneeLogin?: string | null
  botLogin?: string
  issue: {
    number: number
    title: string
    body?: string | null
    labels?: Array<{ name?: string } | string>
  }
}): Promise<IssueAssignmentResult | "ignored"> {
  const tenant = findTenantByGithubInstallation(input.config, input.installationId) ?? findTenantByRepoFullName(input.config, input.repoFullName)
  if (!tenant?.github) return "ignored"
  if (tenant.github.repoAllowlist && !tenant.github.repoAllowlist.includes(input.repoFullName)) return "ignored"

  const assignee = input.assigneeLogin?.toLowerCase()
  const allowedAssignees = resolveAssignmentAssignees(tenant.github.assignmentAssignees, input.botLogin)
  if (!assignee || allowedAssignees.size === 0 || !allowedAssignees.has(assignee)) return "ignored"

  const repo = resolveRepo(tenant, input.repoFullName)
  if (!repo) return "ignored"

  if (input.routing && issueAssignmentEnabled(tenant, repo.fullName)) {
    const result = await handleOptInIssueAssignment({
      store: input.routing.store,
      harness: input.routing.harness,
      tenant,
      repo,
      owner: input.owner,
      repoName: input.repoName,
      installationId: input.installationId,
      issueNumber: input.issue.number,
      title: input.issue.title,
      body: input.issue.body ?? undefined,
      repoPath: await ensureRepoPath(repo),
      runId: nanoid(8)
    })
    if (result.path === "conflict" || result.path === "failed" || result.path === "pending" || result.path === "indeterminate") {
      logger.warn({
        tenantId: tenant.id,
        repo: repo.fullName,
        issueNumber: input.issue.number,
        result
      }, "opt-in issue assignment did not complete")
    }
    return result
  }

  if (hasManagedLabel(input.issue.labels)) return "ignored"

  const sourceKey = [
    "github-assigned",
    input.installationId ?? "none",
    input.repoFullName.toLowerCase(),
    input.issue.number
  ].join(":")
  await input.onCommand({
    tenantId: tenant.id,
    commandType: "run",
    prompt: buildIssueBootstrapPrompt(input.issue.number, input.issue.title, input.issue.body ?? undefined),
    repoFullName: repo.fullName,
    sourceKey,
    github: {
      owner: input.owner,
      repo: input.repoName,
      issueNumber: input.issue.number,
      installationId: input.installationId,
      issueTitle: input.issue.title,
      issueBody: input.issue.body ?? undefined
    }
  })
  return { path: "legacy" }
}

function resolveTargetTenant(input: {
  config: AppConfig
  defaultTenant: TenantConfig
  tenantHint?: string
  installationId?: number
  repoFullName: string
}): TenantConfig | null {
  if (!input.tenantHint) return input.defaultTenant

  const target = input.config.tenants.find(t => t.id.toLowerCase() === input.tenantHint?.toLowerCase())
  if (!target?.github) {
    logger.warn({ tenantHint: input.tenantHint }, "Ignoring command: tenant hint did not match any GitHub-enabled tenant")
    return null
  }

  if (input.installationId && target.github.installationId && target.github.installationId !== input.installationId) {
    logger.warn({
      tenantHint: input.tenantHint,
      installationId: input.installationId,
      tenantInstallationId: target.github.installationId
    }, "Ignoring command: tenant hint installation mismatch")
    return null
  }

  const repoMatch = target.repos.some(repo => repo.fullName.toLowerCase() === input.repoFullName.toLowerCase())
  if (!repoMatch) {
    logger.warn({
      tenantHint: input.tenantHint,
      repoFullName: input.repoFullName
    }, "Ignoring command: tenant hint repo mismatch")
    return null
  }

  if (target.github.repoAllowlist && !target.github.repoAllowlist.some(repo => repo.toLowerCase() === input.repoFullName.toLowerCase())) {
    logger.warn({
      tenantHint: input.tenantHint,
      repoFullName: input.repoFullName
    }, "Ignoring command: tenant hint blocked by repo allowlist")
    return null
  }

  return target
}

function hasManagedLabel(labels?: Array<{ name?: string } | string>): boolean {
  if (!labels || labels.length === 0) return false
  return labels.some(label => {
    const name = typeof label === "string" ? label : label.name
    return name?.toLowerCase() === "agent:managed"
  })
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

function resolveAssignmentAssignees(configured: string[] | undefined, botLogin?: string): Set<string> {
  const values = new Set<string>()
  if (botLogin) values.add(botLogin.trim().toLowerCase())
  for (const value of configured ?? []) {
    const normalized = value.trim().toLowerCase()
    if (!normalized) continue
    values.add(normalized)
  }
  return values
}
