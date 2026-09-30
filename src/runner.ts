import { Codex } from "@openai/codex-sdk"
import type { ThreadEvent, ThreadItem } from "@openai/codex-sdk"
import type { WebClient } from "@slack/web-api"
import { execa } from "execa"
import type { RunStore } from "./storage.js"
import type { RunRecord } from "./types.js"
import { ProgressTracker } from "./progress.js"
import { Throttler } from "./throttle.js"
import { formatGitHubStatus, formatSlackStatus, formatFinalSummary } from "./status.js"
import { updateSlackStatus, postSlackStatus } from "./slack.js"
import { createInstallationClient, formatPrivateKey } from "./github-auth.js"
import { syncIssueLifecycleState } from "./github-issue-state.js"
import { isDiscussionSourceKey, postDiscussionCommentFromContext } from "./github-discussions.js"
import { isDirty, fetchOrigin, commitAll, pushBranch, getDefaultBranchFromOrigin, addWorktree, removeWorktree, worktreePathForRun } from "./git.js"
import { logger } from "./logger.js"
import type { VibeAgentsSink } from "./vibe-agents.js"

const disabledMcpServersCache = new Map<string, Promise<Record<string, { enabled: boolean }>>>()

export type RunnerEnv = {
  codexPath?: string
  codexApiKey?: string
  codexTurnTimeoutMs: number
  githubAppId?: number
  githubPrivateKey?: string
}

export function createRunner(params: {
  store: RunStore
  slackClient?: WebClient
  env: RunnerEnv
  vibeAgents?: VibeAgentsSink
}) {
  const { store, slackClient, env, vibeAgents } = params

  return async (job: { runId: string }) => {
    const run = await store.getRun(job.runId)
    if (!run) throw new Error(`Run not found: ${job.runId}`)
    const discussionTarget = isDiscussionSourceKey(run.sourceKey)

    await store.updateRunStatus(run.id, "running")
    void vibeAgents?.sendRunStatus(run, "running")

    const tracker = new ProgressTracker()
    const throttler = new Throttler(2000)
    const codexTurnTimeoutMs = Math.max(30_000, env.codexTurnTimeoutMs)

    const githubClient = await getGitHubClient(run, env)
    if (run.github && githubClient && !discussionTarget) {
      await syncIssueLifecycleState(githubClient, run.github, "in-progress")
    }

    const updateStatus = async (state: string) => {
      const snapshot = tracker.snapshot()
      if (run.slack && slackClient && run.slack.messageTs) {
        try {
          const text = formatSlackStatus(run, snapshot, state)
          await updateSlackStatus(slackClient, run.slack, text, run.slack.messageTs)
        } catch (error) {
          logger.warn({ err: error, runId: run.id }, "Slack status update failed")
        }
      }
      if (run.github && githubClient && run.github.commentId && !discussionTarget) {
        try {
          const body = formatGitHubStatus(run, snapshot, state)
          await githubClient.octokit.issues.updateComment({
            owner: run.github.owner,
            repo: run.github.repo,
            comment_id: run.github.commentId,
            body
          })
        } catch (error) {
          logger.warn({ err: error, runId: run.id }, "GitHub status update failed")
        }
      }
    }

    const handleEvent = async (event: ThreadEvent, seq: number) => {
      await store.appendEvent({
        runId: run.id,
        seq,
        type: event.type,
        payload: event as unknown as Record<string, unknown>,
        createdAt: new Date().toISOString()
      })

      if (event.type === "item.completed") {
        handleCompletedItem(tracker, event.item)
      } else if (event.type === "item.updated") {
        handleUpdatedItem(tracker, event.item)
      } else if (event.type === "turn.failed") {
        tracker.pushLine(`Turn failed: ${event.error.message}`)
      } else if (event.type === "turn.completed") {
        tracker.pushLine(`Turn completed. Output tokens ${event.usage.output_tokens}`)
      }

      if (throttler.shouldRun()) {
        await updateStatus("running")
      }
    }

    const worktreePath = worktreePathForRun(run.repoPath, run.id)
    try {
      const baseBranch = await resolveBaseBranch(run)
      const branchName = buildBranchName(run, baseBranch)
      await store.updateRunBranch(run.id, branchName)

      const workspace = await prepareRepo(run, baseBranch, branchName)
      await updateStatus("running")

      const prompt = buildPrompt(run)
      const mcpOverrides = await resolveDisabledMcpServersConfig(env.codexPath)
      const codex = new Codex({
        codexPathOverride: env.codexPath,
        apiKey: env.codexApiKey,
        // Bridge owns GitHub writes via installation tokens.
        // Disable MCP sources so issue updates are app-authored only.
        config: {
          features: {
            apps: false,
            apps_mcp_gateway: false,
            connectors: false
          },
          mcp_servers: mcpOverrides
        }
      })
      const thread = codex.startThread({
        workingDirectory: workspace,
        model: run.model,
        // The bridge must be able to create/edit files and push branches.
        sandboxMode: "workspace-write",
        // Auto-approve all commands; the bridge is fully autonomous.
        approvalPolicy: "never",
      })
      const turnAbortController = new AbortController()
      const turnTimeout = setTimeout(() => {
        turnAbortController.abort(`Codex turn timed out after ${Math.round(codexTurnTimeoutMs / 1000)}s`)
      }, codexTurnTimeoutMs)

      let seq = 0
      let finalResponse = ""
      try {
        // Codex SDK TurnOptions supports AbortSignal via `signal`.
        const { events } = await thread.runStreamed(prompt, {
          signal: turnAbortController.signal
        })
        for await (const event of events) {
          seq += 1
          if (event.type === "item.completed" && event.item.type === "agent_message") {
            finalResponse = event.item.text
            tracker.setAgentMessage(event.item.text)
          }
          await handleEvent(event, seq)
        }
      } finally {
        clearTimeout(turnTimeout)
      }

      const hasChanges = await isDirty(workspace)
      if (!hasChanges) {
        await store.updateRunStatus(run.id, "no_changes")
        void vibeAgents?.sendRunStatus(run, "no_changes", {
          summary: finalResponse.trim() || "No changes detected"
        })
        if (run.github && githubClient && !discussionTarget) {
          await syncIssueLifecycleState(githubClient, run.github, "completed")
        }
        // finalize() updates the existing status comment (or posts to discussion)
        // with the final summary — no separate comment needed.
        const message = formatFinalSummary(run, finalResponse || "No changes detected", undefined)
        await finalize(run, "no_changes", message, updateStatus, githubClient, slackClient)
        return
      }

      await commitAll(workspace, buildCommitMessage(run))

      if (!run.github || !githubClient) {
        await store.updateRunStatus(run.id, "failed")
        void vibeAgents?.sendRunStatus(run, "failed", {
          summary: "Missing GitHub context for PR creation"
        })
        if (run.github && githubClient && !discussionTarget) {
          await syncIssueLifecycleState(githubClient, run.github, "idle")
        }
        const message = formatFinalSummary(run, "Missing GitHub context for PR creation", undefined)
        await finalize(run, "failed", message, updateStatus, githubClient, slackClient)
        return
      }

      const remoteUrl = buildRemoteUrl(run, githubClient.token)
      await pushBranch(workspace, remoteUrl, branchName)

      const pr = await githubClient.octokit.pulls.create({
        owner: run.github.owner,
        repo: run.github.repo,
        title: buildPrTitle(run),
        head: branchName,
        base: baseBranch,
        body: buildPrBody(run, finalResponse, discussionTarget)
      })

      await store.updateRunPr(run.id, pr.data.number, pr.data.html_url)
      await store.updateRunStatus(run.id, "succeeded")
      void vibeAgents?.sendRunStatus(run, "succeeded", {
        summary: finalResponse || "Completed",
        prUrl: pr.data.html_url
      })
      if (!discussionTarget) {
        await syncIssueLifecycleState(githubClient, run.github, "completed")
      }
      const message = formatFinalSummary(run, finalResponse || "Completed", pr.data.html_url)
      await finalize(run, "succeeded", message, updateStatus, githubClient, slackClient)
    } catch (error) {
      const runError = error instanceof Error && error.name === "AbortError"
        ? new Error(`Codex turn timed out after ${Math.round(codexTurnTimeoutMs / 1000)}s`)
        : error instanceof Error
          ? error
          : new Error(String(error))
      await store.updateRunStatus(run.id, "failed")
      void vibeAgents?.sendRunStatus(run, "failed", {
        summary: runError.message
      })
      if (run.github && githubClient && !discussionTarget) {
        await syncIssueLifecycleState(githubClient, run.github, "idle")
      }
      tracker.pushLine(runError.message)
      await updateStatus("failed")
      throw runError
    } finally {
      try {
        await removeWorktree(run.repoPath, worktreePath)
      } catch (error) {
        logger.warn({ err: error, runId: run.id, worktreePath }, "Failed to remove run worktree")
      }
    }
  }
}

function handleCompletedItem(tracker: ProgressTracker, item: ThreadItem) {
  if (item.type === "command_execution") {
    const exitText = item.exit_code !== undefined ? `exit ${item.exit_code}` : ""
    tracker.pushLine(`Command ${item.command} ${item.status} ${exitText}`.trim())
  } else if (item.type === "file_change") {
    for (const change of item.changes) {
      tracker.pushLine(`File ${change.kind} ${change.path}`)
    }
  } else if (item.type === "agent_message") {
    tracker.setAgentMessage(item.text)
  } else if (item.type === "reasoning") {
    tracker.pushLine("Reasoning updated")
  } else if (item.type === "mcp_tool_call") {
    tracker.pushLine(`MCP ${item.tool} ${item.status}`)
  } else if (item.type === "web_search") {
    tracker.pushLine(`Web search ${item.query}`)
  } else if (item.type === "error") {
    tracker.pushLine(`Error ${item.message}`)
  }
}

function handleUpdatedItem(tracker: ProgressTracker, item: ThreadItem) {
  if (item.type === "todo_list") {
    const done = item.items.filter(i => i.completed).length
    const total = item.items.length
    tracker.pushLine(`Todo ${done}/${total}`)
  }
}

async function resolveBaseBranch(run: RunRecord): Promise<string> {
  const fromOrigin = await getDefaultBranchFromOrigin(run.repoPath)
  return fromOrigin ?? "main"
}

function buildBranchName(run: RunRecord, base: string): string {
  const prefix = run.branchPrefix ?? (run.github?.issueNumber ? `codex/${run.github.issueNumber}` : "codex/task")
  const suffix = run.id.toLowerCase()
  return `${prefix}-${suffix}`
}

export async function prepareRepo(run: RunRecord, baseBranch: string, branchName: string): Promise<string> {
  await fetchOrigin(run.repoPath)
  const worktreePath = worktreePathForRun(run.repoPath, run.id)
  await addWorktree(run.repoPath, worktreePath, branchName, `origin/${baseBranch}`)
  return worktreePath
}

function buildPrompt(run: RunRecord): string {
  const issueTitle = run.github?.issueTitle ? `Issue: ${run.github.issueTitle}` : ""
  const issueBody = run.github?.issueBody ? `\n${run.github.issueBody}` : ""
  return [issueTitle + issueBody, run.prompt].filter(Boolean).join("\n\n")
}

function buildCommitMessage(run: RunRecord): string {
  const base = run.github?.issueNumber ? `codex: issue ${run.github.issueNumber}` : "codex: update"
  return base
}

function buildRemoteUrl(run: RunRecord, token: string): string {
  return `https://x-access-token:${token}@github.com/${run.github?.owner}/${run.github?.repo}.git`
}

function buildPrTitle(run: RunRecord): string {
  if (run.github?.issueNumber && run.github.issueTitle) {
    return `Codex: ${run.github.issueTitle}`
  }
  return "Codex: changes"
}

function buildPrBody(run: RunRecord, summary: string, discussionTarget: boolean): string {
  const issue = run.github?.issueNumber && !discussionTarget ? `Closes #${run.github.issueNumber}` : ""
  return [issue, summary].filter(Boolean).join("\n\n")
}

async function finalize(
  run: RunRecord,
  state: string,
  message: string,
  updateStatus: (state: string) => Promise<void>,
  githubClient: any,
  slackClient?: WebClient
) {
  if (run.slack && run.slack.messageTs) {
    await updateStatus(state)
    if (slackClient) {
      try {
        await postSlackStatus(slackClient, run.slack, message)
      } catch (error) {
        logger.warn({ err: error, runId: run.id }, "Slack final post failed")
      }
    }
  }
  if (run.github && githubClient && isDiscussionSourceKey(run.sourceKey)) {
    try {
      await postDiscussionCommentFromContext(githubClient, run.github, message)
    } catch (error) {
      logger.warn({ err: error, runId: run.id }, "GitHub discussion final post failed")
    }
  } else if (run.github && githubClient && run.github.commentId) {
    try {
      await githubClient.octokit.issues.updateComment({
        owner: run.github.owner,
        repo: run.github.repo,
        comment_id: run.github.commentId,
        body: message
      })
    } catch (error) {
      logger.warn({ err: error, runId: run.id }, "GitHub final update failed")
    }
  }
}

async function getGitHubClient(run: RunRecord, env: RunnerEnv) {
  if (!run.github?.installationId || !env.githubAppId || !env.githubPrivateKey) return null
  return createInstallationClient({
    appId: env.githubAppId,
    privateKey: formatPrivateKey(env.githubPrivateKey),
    installationId: run.github.installationId
  })
}

async function resolveDisabledMcpServersConfig(codexPath?: string): Promise<Record<string, { enabled: boolean }>> {
  const key = codexPath ?? "codex"
  let cached = disabledMcpServersCache.get(key)
  if (!cached) {
    cached = discoverMcpServerOverrides(codexPath)
    disabledMcpServersCache.set(key, cached)
  }
  return cached
}

async function discoverMcpServerOverrides(codexPath?: string): Promise<Record<string, { enabled: boolean }>> {
  const executable = codexPath ?? "codex"
  try {
    const { stdout } = await execa(executable, ["mcp", "list"], {
      timeout: 5000
    })
    const names = parseMcpServerNames(stdout)
    return Object.fromEntries(names.map(name => [name, { enabled: false }]))
  } catch (error) {
    logger.warn({ err: error, executable }, "Failed to discover MCP servers; skipping MCP overrides")
    return {}
  }
}

function parseMcpServerNames(output: string): string[] {
  const names = new Set<string>()
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.toLowerCase().startsWith("name")) continue

    const columns = line.split(/\s{2,}|\t+/).filter(Boolean)
    if (columns.length < 2) continue

    const name = columns[0]?.trim()
    if (!name) continue
    names.add(name)
  }
  return [...names]
}
