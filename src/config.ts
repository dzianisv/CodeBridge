import { config as loadDotenv } from "dotenv"
import { readFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { existsSync } from "node:fs"
import yaml from "js-yaml"
import { z } from "zod"
import type { AppConfig } from "./types.js"

loadDotenv()

const repoSchema = z.object({
  fullName: z.string(),
  path: z.string(),
  model: z.string().optional(),
  baseBranch: z.string().optional(),
  branchPrefix: z.string().optional()
})

const slackSchema = z.object({
  teamId: z.string(),
  commandPrefixes: z.array(z.string()).min(1)
})

const githubSchema = z.object({
  installationId: z.number().optional(),
  repoAllowlist: z.array(z.string()).optional(),
  commandPrefixes: z.array(z.string()).optional(),
  assignmentAssignees: z.array(z.string()).optional()
})

const jiraSchema = z.object({
  baseUrl: z.string().url(),
  projectKey: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  agentAccountId: z.string().min(1),
  pollIntervalSec: z.number().int().positive()
})

// Same optional-block pattern as `jira`: omit the block and polling/routing
// keeps the LLD §7 defaults (origin-only, 60 minutes).
const harnessSchema = z.object({
  mirrorReplies: z.enum(["origin-only", "all"]).optional(),
  reactivationWindowMinutes: z.number().int().positive().optional()
})

const tenantSchema = z.object({
  id: z.string(),
  name: z.string(),
  slack: slackSchema.optional(),
  github: githubSchema.optional(),
  jira: jiraSchema.optional(),
  harness: harnessSchema.optional(),
  repos: z.array(repoSchema),
  defaultRepo: z.string().optional()
})

const secretsSchema = z.object({
  githubAppId: z.number().optional(),
  githubPrivateKey: z.string().optional(),
  githubWebhookSecret: z.string().optional(),
  codexNotifyToken: z.string().optional(),
  vibeAgentsToken: z.string().optional(),
  jiraEmail: z.string().optional(),
  jiraApiToken: z.string().optional()
})

const vibeAgentsSchema = z.object({
  endpoint: z.string().url(),
  token: z.string().optional(),
  author: z.string().optional(),
  project: z.string().optional(),
  enabled: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional()
})

const integrationsSchema = z.object({
  vibeAgents: vibeAgentsSchema.optional()
})

const appSchema = z.object({
  secrets: secretsSchema.optional(),
  integrations: integrationsSchema.optional(),
  tenants: z.array(tenantSchema)
})

export type EnvConfig = {
  port: number
  role: "all" | "api" | "worker"
  databaseUrl: string
  redisUrl?: string
  queueMode: "redis" | "memory"
  slackBotToken?: string
  slackAppToken?: string
  slackSigningSecret?: string
  githubAppId?: number
  githubPrivateKey?: string
  githubWebhookSecret?: string
  githubPollIntervalSec: number
  githubPollBackfill: boolean
  codexPath?: string
  codexApiKey?: string
  codexTurnTimeoutMs: number
  codexNotifyToken?: string
  vibeAgentsEndpoint?: string
  vibeAgentsToken?: string
  vibeAgentsAuthor?: string
  vibeAgentsProject?: string
  vibeAgentsEnabled?: boolean
  vibeAgentsTimeoutMs?: number
  jiraEmail?: string
  jiraApiToken?: string
  configPath: string
}

export function loadEnv(): EnvConfig {
  const role = (process.env.ROLE ?? "all") as EnvConfig["role"]
  const port = parseInt(process.env.PORT ?? "8788", 10)
  const databaseUrl = process.env.DATABASE_URL ?? "sqlite://./data/codebridge.db"
  const redisUrl = process.env.REDIS_URL
  const queueMode = parseQueueMode(process.env.QUEUE_MODE, redisUrl)
  const configPath = process.env.CONFIG_PATH ?? resolveDefaultConfigPath()
  const githubAppId = process.env.GITHUB_APP_ID ? parseInt(process.env.GITHUB_APP_ID, 10) : undefined
  const githubPollIntervalSec = parseInt(process.env.GITHUB_POLL_INTERVAL ?? "0", 10)
  const githubPollBackfill = parseBoolean(process.env.GITHUB_POLL_BACKFILL ?? "false")
  const codexTurnTimeoutMs = parseInt(process.env.CODEX_TURN_TIMEOUT_MS ?? "300000", 10)
  const vibeAgentsTimeoutMsRaw = process.env.VIBE_AGENTS_TIMEOUT_MS
  const vibeAgentsTimeoutMsParsed = vibeAgentsTimeoutMsRaw ? parseInt(vibeAgentsTimeoutMsRaw, 10) : undefined

  return {
    port,
    role,
    databaseUrl,
    redisUrl,
    queueMode,
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    slackAppToken: process.env.SLACK_APP_TOKEN,
    slackSigningSecret: process.env.SLACK_SIGNING_SECRET,
    githubAppId,
    githubPrivateKey: process.env.GITHUB_PRIVATE_KEY,
    githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
    githubPollIntervalSec,
    githubPollBackfill,
    codexPath: process.env.CODEX_PATH,
    codexApiKey: process.env.CODEX_API_KEY,
    codexTurnTimeoutMs: Number.isFinite(codexTurnTimeoutMs) && codexTurnTimeoutMs > 0 ? codexTurnTimeoutMs : 300000,
    codexNotifyToken: process.env.CODEBRIDGE_NOTIFY_TOKEN ?? process.env.CODEX_BRIDGE_NOTIFY_TOKEN,
    vibeAgentsEndpoint: process.env.VIBE_AGENTS_ENDPOINT,
    vibeAgentsToken: process.env.VIBE_AGENTS_TOKEN,
    vibeAgentsAuthor: process.env.VIBE_AGENTS_AUTHOR,
    vibeAgentsProject: process.env.VIBE_AGENTS_PROJECT,
    vibeAgentsEnabled: process.env.VIBE_AGENTS_ENABLED ? parseBoolean(process.env.VIBE_AGENTS_ENABLED) : undefined,
    vibeAgentsTimeoutMs: Number.isFinite(vibeAgentsTimeoutMsParsed) ? vibeAgentsTimeoutMsParsed : undefined,
    jiraEmail: process.env.JIRA_EMAIL,
    jiraApiToken: process.env.JIRA_API_TOKEN,
    configPath
  }
}

export async function loadConfig(configPath: string): Promise<AppConfig> {
  const raw = await readFile(configPath, "utf8")
  const parsed = yaml.load(raw)
  const result = appSchema.safeParse(parsed)
  if (!result.success) {
    const message = result.error.issues.map(issue => `${issue.path.join(".")} ${issue.message}`).join("; ")
    throw new Error(`Invalid config: ${message}`)
  }
  return result.data
}

function parseBoolean(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on"
}

function parseQueueMode(value: string | undefined, redisUrl?: string): "redis" | "memory" {
  const normalized = value?.trim().toLowerCase()
  if (normalized === "memory") return "memory"
  if (normalized === "redis") return "redis"
  if (!redisUrl || redisUrl === "memory") return "memory"
  return "redis"
}

function resolveDefaultConfigPath(): string {
  const home = os.homedir()
  const candidates = [
    path.join(process.cwd(), "config", "tenants.yaml"),
    path.join(process.cwd(), "config", "tenants.yml"),
    path.join(home, ".config", "codebridge", "config.yaml"),
    path.join(home, ".config", "codebridge", "config.yml"),
    path.join(home, ".config", "codex-bridge", "config.yaml"),
    path.join(home, ".config", "codex-bridge", "config.yml")
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  return path.join(process.cwd(), "config", "tenants.yaml")
}
