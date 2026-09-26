import express from "express"
import { WebClient } from "@slack/web-api"
import { loadConfig, loadEnv } from "./config.js"
import { createStore } from "./storage.js"
import { createQueue, startWorker } from "./queue.js"
import { createRunService } from "./run-service.js"
import { createRunner } from "./runner.js"
import { startSlack } from "./slack.js"
import { createGitHubApp } from "./github.js"
import { resolveRepo, ensureRepoPath } from "./repo.js"
import { logger } from "./logger.js"
import { startGitHubPolling } from "./github-poll.js"
import { createHarnessBackedJiraPoller, startJiraPolling } from "./jira-poll.js"
import { createCodexNotifyHandler } from "./codex-notify.js"
import type { AppConfig } from "./types.js"
import { createVibeAgentsSink } from "./vibe-agents.js"

const main = async () => {
  const env = loadEnv()
  const config = await loadConfig(env.configPath)
  const secrets = resolveRuntimeSecrets(config, env)
  const integrations = resolveRuntimeIntegrations(config, env, secrets)
  const vibeAgentsSink = createVibeAgentsSink(integrations.vibeAgents)

  const store = createStore(env.databaseUrl)
  await store.ensureSchema()

  const { queue } = createQueue(env.redisUrl, env.queueMode)
  const slackClient = env.slackBotToken ? new WebClient(env.slackBotToken) : undefined

  const runService = createRunService({
    store,
    queue,
    slackClient,
    githubAppId: secrets.githubAppId,
    githubPrivateKey: secrets.githubPrivateKey,
    vibeAgents: vibeAgentsSink
  })

  if (env.role === "all" || env.role === "worker") {
    const runner = createRunner({
      store,
      slackClient,
      env: {
        codexPath: env.codexPath,
        codexApiKey: env.codexApiKey,
        codexTurnTimeoutMs: env.codexTurnTimeoutMs,
        githubAppId: secrets.githubAppId,
        githubPrivateKey: secrets.githubPrivateKey
      },
      vibeAgents: vibeAgentsSink
    })
    startWorker(env.redisUrl, runner, env.queueMode)
    logger.info("Worker started")
  }

  if (env.role === "all" || env.role === "api") {
    const app = express()
    app.use(express.json({ limit: "1mb" }))

    app.get("/health", (_req, res) => {
      res.json({ status: "ok" })
    })
    app.post("/codex/notify", createCodexNotifyHandler({
      config,
      githubAppId: secrets.githubAppId,
      githubPrivateKey: secrets.githubPrivateKey,
      ingestToken: secrets.codexNotifyToken
    }))

    const github = createGitHubApp(config, {
      githubAppId: secrets.githubAppId,
      githubPrivateKey: secrets.githubPrivateKey,
      githubWebhookSecret: secrets.githubWebhookSecret
    }, async input => {
      const tenant = config.tenants.find(t => t.id === input.tenantId)
      if (!tenant) return
      const repo = resolveRepo(tenant, input.repoFullName)
      if (!repo) return
      const repoPath = await ensureRepoPath(repo)
      const prompt = input.commandType === "reply"
        ? [`Follow-up command from GitHub issue #${input.github.issueNumber}:`, input.prompt].join("\n\n")
        : input.prompt

      await runService.createRun({
        tenantId: tenant.id,
        repoFullName: repo.fullName,
        repoPath,
        sourceKey: input.sourceKey,
        prompt,
        model: repo.model,
        branchPrefix: repo.branchPrefix,
        github: input.github
      })
    })
    if (github) github.mount(app)

    await app.listen(env.port)
    logger.info({ port: env.port }, "API server started")

    await startSlack(config, env, async input => {
      const tenant = config.tenants.find(t => t.id === input.tenantId)
      if (!tenant) return
      const repo = resolveRepo(tenant, input.repoHint)
      if (!repo) return
      const repoPath = await ensureRepoPath(repo)
      const [owner, repoName] = repo.fullName.split("/")
      const githubContext = tenant.github?.installationId ? {
        owner: input.issue?.owner ?? owner,
        repo: input.issue?.repo ?? repoName,
        issueNumber: input.issue?.issueNumber,
        installationId: tenant.github.installationId
      } : undefined

      await runService.createRun({
        tenantId: tenant.id,
        repoFullName: repo.fullName,
        repoPath,
        prompt: input.prompt,
        model: repo.model,
        branchPrefix: repo.branchPrefix,
        slack: input.slack,
        github: githubContext
      })
    })

    startGitHubPolling({
      config,
      store,
      runService,
      harness: { store, config },
      env: {
        githubAppId: secrets.githubAppId,
        githubPrivateKey: secrets.githubPrivateKey,
        githubPollIntervalSec: env.githubPollIntervalSec,
        githubPollBackfill: env.githubPollBackfill
      }
    })

    // Issue assignment and mentions still go to run-service. PR assignment
    // uses the HarnessCtx passed into startGitHubPolling. Linked Jira events
    // go to harness.ts as well.
    startJiraPolling({
      config,
      store,
      harness: createHarnessBackedJiraPoller({ store, config }),
      env: {
        jiraEmail: secrets.jiraEmail,
        jiraApiToken: secrets.jiraApiToken
      }
    })
  }
}

function resolveRuntimeSecrets(config: AppConfig, env: ReturnType<typeof loadEnv>) {
  return {
    githubAppId: config.secrets?.githubAppId ?? env.githubAppId,
    githubPrivateKey: config.secrets?.githubPrivateKey ?? env.githubPrivateKey,
    githubWebhookSecret: config.secrets?.githubWebhookSecret ?? env.githubWebhookSecret,
    codexNotifyToken: config.secrets?.codexNotifyToken ?? env.codexNotifyToken,
    vibeAgentsToken: config.secrets?.vibeAgentsToken ?? env.vibeAgentsToken,
    jiraEmail: config.secrets?.jiraEmail ?? env.jiraEmail,
    jiraApiToken: config.secrets?.jiraApiToken ?? env.jiraApiToken
  }
}

function resolveRuntimeIntegrations(
  config: AppConfig,
  env: ReturnType<typeof loadEnv>,
  secrets: ReturnType<typeof resolveRuntimeSecrets>
) {
  const configuredVibe = config.integrations?.vibeAgents
  if (!configuredVibe && !env.vibeAgentsEndpoint) {
    return { vibeAgents: undefined }
  }

  return {
    vibeAgents: {
      endpoint: env.vibeAgentsEndpoint ?? configuredVibe?.endpoint ?? "",
      token: env.vibeAgentsToken ?? configuredVibe?.token ?? secrets.vibeAgentsToken,
      author: env.vibeAgentsAuthor ?? configuredVibe?.author,
      project: env.vibeAgentsProject ?? configuredVibe?.project,
      enabled: env.vibeAgentsEnabled ?? configuredVibe?.enabled ?? true,
      timeoutMs: env.vibeAgentsTimeoutMs ?? configuredVibe?.timeoutMs
    }
  }
}

main().catch(err => {
  logger.error(err)
  process.exit(1)
})
