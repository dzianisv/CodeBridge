import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadConfig } from "../src/config.js"
import {
  handleAssignmentEvent,
  handleCommentEvent,
  opencodeSessionConfigFor,
  unsharedSessionReply,
  type HarnessCtx
} from "../src/harness.js"
import type { OpencodeSessionConfig } from "../src/opencode-session.js"
import { createSqliteStore, type RunStore } from "../src/storage.js"
import type { AppConfig, TenantConfig } from "../src/types.js"

// Mocked OpenCode only. No opencode serve, no GitHub/Jira credentials, no listener.
// The mock returns a share URL only when the per-call config carries the adapter
// gate. Assignment write-back must use that URL for an opted-in tenant and the
// exact resume fallback otherwise. Comment turns must receive the same per-tenant
// config and must not replace the turn text with a share URL.

const ENABLED_BASE = "http://127.0.0.1:4101"
const DISABLED_BASE = "http://127.0.0.1:4102"
const PROCESS_BASE = "http://127.0.0.1:4096"
const SHARE_URL = "https://opncd.ai/share/ses_enabled"

type Call = {
  op: "create" | "append"
  title?: string
  sessionId?: string
  prompt?: string
  config?: OpencodeSessionConfig
}

async function main() {
  const tests: Array<[string, () => Promise<void>]> = [
    ["tenant opencode schema accepts sharingEnabled and rejects shareBaseUrl", schemaRejectsShareBaseUrl],
    ["assignment then comment uses per-tenant sharing config, not a global gate", assignmentThenComment]
  ]
  let failed = 0
  for (const [name, fn] of tests) {
    try {
      await fn()
      console.log(`ok - ${name}`)
    } catch (error) {
      failed += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

async function schemaRejectsShareBaseUrl() {
  const dir = mkdtempSync(path.join(tmpdir(), "codebridge-sharing-config-"))
  try {
    const good = path.join(dir, "good.yaml")
    writeFileSync(good, `
tenants:
  - id: on
    name: On
    opencode:
      baseUrl: "http://127.0.0.1:4096"
      sharingEnabled: true
    repos: []
  - id: off
    name: Off
    opencode:
      sharingEnabled: false
    repos: []
  - id: unset
    name: Unset
    repos: []
`)
    const loaded = await loadConfig(good)
    assert.equal(loaded.tenants[0]?.opencode?.sharingEnabled, true)
    assert.equal(loaded.tenants[0]?.opencode?.baseUrl, "http://127.0.0.1:4096")
    assert.equal(loaded.tenants[1]?.opencode?.sharingEnabled, false)
    assert.equal(loaded.tenants[2]?.opencode, undefined)
    assert.equal(loaded.tenants.some(tenant => tenant.opencode && "shareBaseUrl" in tenant.opencode), false)

    const bad = path.join(dir, "bad.yaml")
    writeFileSync(bad, `
tenants:
  - id: leak
    name: Leak
    opencode:
      shareBaseUrl: "https://opncd.ai"
    repos: []
`)
    await assert.rejects(() => loadConfig(bad), /shareBaseUrl/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function assignmentThenComment() {
  await withStore(async store => {
    const calls: Call[] = []
    const ctx: HarnessCtx = {
      store,
      config: configFor(),
      // Process-level server address only. A global shareBaseUrl must not opt tenants in.
      opencodeConfig: { baseUrl: PROCESS_BASE, timeoutMs: 5000, shareBaseUrl: "https://global.invalid" },
      sessions: {
        async createSession(params, config) {
          calls.push({ op: "create", title: params.title, config })
          if (config?.shareBaseUrl?.trim()) {
            return { sessionId: "ses_enabled", shareUrl: SHARE_URL }
          }
          const sessionId = params.title.startsWith("off") ? "ses_off" : "ses_unset"
          return { sessionId, shareUrl: null }
        },
        async appendTurn(sessionId, prompt, config) {
          calls.push({ op: "append", sessionId, prompt, config })
          return { reply: `turn:${prompt}` }
        }
      }
    }

    const enabled = await assignAndComment(ctx, "on", "ON-1", "on ticket")
    const disabled = await assignAndComment(ctx, "off", "OFF-1", "off ticket")
    const unset = await assignAndComment(ctx, "unset", "UNSET-1", "unset ticket")

    assert.equal(enabled.assignment.reply, SHARE_URL)
    assert.equal(enabled.assignment.sessionId, "ses_enabled")
    assert.equal(enabled.comment?.sessionId, "ses_enabled")
    assert.equal(enabled.comment?.reply, "turn:please continue")

    assert.equal(disabled.assignment.reply, unsharedSessionReply("ses_off"))
    assert.equal(disabled.comment?.sessionId, "ses_off")
    assert.equal(disabled.comment?.reply, "turn:please continue")
    assert.equal(disabled.assignment.reply.includes(SHARE_URL), false)

    assert.equal(unset.assignment.reply, unsharedSessionReply("ses_unset"))
    assert.equal(unset.comment?.sessionId, "ses_unset")
    assert.equal(unset.comment?.reply, "turn:please continue")
    assert.equal(unset.assignment.reply.includes(SHARE_URL), false)

    const enabledCreate = findCreate(calls, "on ticket")
    const enabledAppend = findAppend(calls, "ses_enabled")
    const disabledCreate = findCreate(calls, "off ticket")
    const disabledAppend = findAppend(calls, "ses_off")
    const unsetCreate = findCreate(calls, "unset ticket")
    const unsetAppend = findAppend(calls, "ses_unset")

    assert.deepEqual(enabledCreate.config, opencodeSessionConfigFor(ctx, "on"))
    assert.deepEqual(enabledAppend.config, opencodeSessionConfigFor(ctx, "on"))
    assert.equal(enabledCreate.config?.baseUrl, ENABLED_BASE)
    assert.equal(enabledCreate.config?.shareBaseUrl, "enabled")
    assert.equal(enabledAppend.config?.baseUrl, ENABLED_BASE)
    assert.equal(enabledAppend.config?.shareBaseUrl, "enabled")
    assert.equal(enabledCreate.config?.timeoutMs, 5000)
    assert.notEqual(enabledCreate.config?.shareBaseUrl, "https://global.invalid")

    assert.deepEqual(disabledCreate.config, opencodeSessionConfigFor(ctx, "off"))
    assert.deepEqual(disabledAppend.config, disabledCreate.config)
    assert.equal(disabledCreate.config?.baseUrl, DISABLED_BASE)
    assert.equal(disabledCreate.config?.shareBaseUrl, undefined)
    assert.equal("shareBaseUrl" in (disabledCreate.config ?? {}), false)

    assert.deepEqual(unsetCreate.config, opencodeSessionConfigFor(ctx, "unset"))
    assert.deepEqual(unsetAppend.config, unsetCreate.config)
    assert.equal(unsetCreate.config?.baseUrl, PROCESS_BASE)
    assert.equal(unsetCreate.config?.shareBaseUrl, undefined)
    assert.equal("shareBaseUrl" in (unsetCreate.config ?? {}), false)

    assert.notEqual(enabledCreate.config?.baseUrl, disabledCreate.config?.baseUrl)
    assert.notEqual(enabledAppend.config?.baseUrl, unsetAppend.config?.baseUrl)
    assert.equal(calls.filter(call => call.op === "create").length, 3)
    assert.equal(calls.filter(call => call.op === "append").length, 3)
  })
}

async function assignAndComment(ctx: HarnessCtx, tenantId: string, issueKey: string, title: string) {
  const key = { kind: "jira" as const, issueKey }
  const assignment = await handleAssignmentEvent(ctx, {
    source: "jira",
    tenantId,
    keys: [key],
    repoPath: "/tmp/repo",
    title
  })
  const comment = await handleCommentEvent(ctx, {
    source: "jira",
    tenantId,
    keys: [key],
    commentBody: "please continue",
    authorIsBot: false,
    repoPath: "/tmp/repo"
  })
  assert.ok(comment)
  return { assignment, comment }
}

function findCreate(calls: Call[], title: string): Call {
  const call = calls.find(item => item.op === "create" && item.title === title)
  assert.ok(call, `missing create call for ${title}`)
  return call
}

function findAppend(calls: Call[], sessionId: string): Call {
  const call = calls.find(item => item.op === "append" && item.sessionId === sessionId)
  assert.ok(call, `missing append call for ${sessionId}`)
  return call
}

function configFor(): AppConfig {
  return {
    tenants: [
      tenant("on", { baseUrl: ENABLED_BASE, sharingEnabled: true }),
      tenant("off", { baseUrl: DISABLED_BASE, sharingEnabled: false }),
      tenant("unset")
    ]
  }
}

function tenant(id: string, opencode?: TenantConfig["opencode"]): TenantConfig {
  return {
    id,
    name: id,
    opencode,
    repos: [{ fullName: "acme/widget", path: "/tmp/repo" }]
  }
}

async function withStore(fn: (store: RunStore) => Promise<void>) {
  const dir = mkdtempSync(path.join(tmpdir(), "codebridge-sharing-db-"))
  const store = createSqliteStore(path.join(dir, "store.db"))
  await store.ensureSchema()
  try {
    await fn(store)
  } finally {
    await store.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
}

await main()
