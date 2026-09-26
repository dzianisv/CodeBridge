// Adapter for a running `opencode serve` HTTP API.
// Verified against opencode v1.18.32 (POST /session, POST /session/{id}/message,
// GET /session/status, POST /session/{id}/share). LLD section 4's REST sketch is
// not the wire format — see comments on each call.

export interface OpencodeSession {
  sessionId: string
  shareUrl: string | null
}

export type OpencodeSessionStatus = "running" | "idle" | "completed" | "not_found"

export type OpencodeSessionConfig = {
  // Client default is http://127.0.0.1:4096 because LLD section 4 documents that
  // as opencode's serve port. Observed on v1.18.32: `opencode serve --port`
  // defaults to 0 (random), not 4096. Callers must pass the real baseUrl when
  // the server was not started with --port 4096.
  baseUrl?: string
  // Gate only. If unset/empty, createSession skips POST /session/{id}/share and
  // returns shareUrl: null (LLD fallback). If set, the URL is whatever the
  // server puts on Session.share.url — we do not build it from this value.
  // v1.18.32 returns a full URL (e.g. https://opncd.ai/share/...) and does not
  // return share on create.
  shareBaseUrl?: string | null
  timeoutMs?: number
}

export type OpencodeFailureKind = "network" | "http" | "parse"

// Callers must catch this. Network failure, timeout, non-2xx, and malformed
// JSON are converted into this typed error so fetch/JSON rejections never
// surface untyped. A 404 from getSessionStatus is not this error — that is
// "not_found".
export class OpencodeUnreachableError extends Error {
  readonly kind: OpencodeFailureKind
  readonly status?: number

  constructor(message: string, options: { kind: OpencodeFailureKind; status?: number; cause?: unknown }) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = "OpencodeUnreachableError"
    this.kind = options.kind
    this.status = options.status
  }
}

// HTTP 200 but the assistant turn itself failed (info.error). Not an
// unreachable server — callers must catch this separately from
// OpencodeUnreachableError.
export class OpencodeTurnError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = "OpencodeTurnError"
  }
}

const DEFAULT_BASE_URL = "http://127.0.0.1:4096"
const DEFAULT_TIMEOUT_MS = 120_000

type ResolvedConfig = {
  baseUrl: string
  shareBaseUrl: string | null
  timeoutMs: number
}

export async function createSession(
  params: { repoPath: string; title: string },
  config?: OpencodeSessionConfig
): Promise<OpencodeSession> {
  if (!params.repoPath) throw new Error("repoPath is required")
  if (!params.title) throw new Error("title is required")

  const resolved = resolveConfig(config)
  // `directory` is a query param, not a body field (v1.18.32 session.create).
  const response = await opencodeFetch(resolved, "/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: params.title }),
    query: { directory: params.repoPath }
  })
  const body = await readJson(response)
  const sessionId = readSessionId(body)

  if (!resolved.shareBaseUrl) {
    return { sessionId, shareUrl: null }
  }

  const shareUrl = await shareSession(resolved, sessionId)
  return { sessionId, shareUrl }
}

export async function appendTurn(
  sessionId: string,
  prompt: string,
  config?: OpencodeSessionConfig
): Promise<{ reply: string }> {
  if (!sessionId) throw new Error("sessionId is required")
  if (!prompt) throw new Error("prompt is required")

  const resolved = resolveConfig(config)
  // There is no `prompt` string field. parts is required.
  const response = await opencodeFetch(resolved, `/session/${encodeURIComponent(sessionId)}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      parts: [{ type: "text", text: prompt }]
    })
  })
  const body = await readJson(response)
  if (!isRecord(body)) {
    throw new OpencodeUnreachableError("opencode message response was not an object", { kind: "parse" })
  }

  if (isRecord(body.info) && body.info.error !== undefined && body.info.error !== null) {
    throw new OpencodeTurnError(`opencode turn failed: ${truncate(JSON.stringify(body.info.error), 500)}`)
  }

  return { reply: extractReplyText(body.parts) }
}

export async function getSessionStatus(
  sessionId: string,
  config?: OpencodeSessionConfig
): Promise<OpencodeSessionStatus> {
  if (!sessionId) throw new Error("sessionId is required")

  const resolved = resolveConfig(config)
  // Status is a bulk map of every session on the server, not GET /session/{id}/status.
  const response = await opencodeFetch(resolved, "/session/status", { method: "GET" })
  const body = await readJson(response)
  if (!isRecord(body)) {
    throw new OpencodeUnreachableError("opencode /session/status returned a non-object", { kind: "parse" })
  }

  if (Object.prototype.hasOwnProperty.call(body, sessionId)) {
    return mapStatusEntry(body[sessionId])
  }

  const sessionResponse = await opencodeFetch(resolved, `/session/${encodeURIComponent(sessionId)}`, {
    method: "GET"
  })
  if (sessionResponse.status === 404) {
    return "not_found"
  }
  await readJson(sessionResponse)

  // Ambiguity (v1.18.32): a session that exists but is absent from
  // GET /session/status was observed as `{}` immediately after create, during
  // a live POST /message and prompt_async turn, and after the turn finished.
  // SessionStatus is only idle | busy | retry — there is no completed value,
  // and Session has no completion flag we can trust here. busy/retry still map
  // to "running" when present, but this server build did not emit them.
  // Treat absence + HTTP 200 as idle. Do not report "completed"; that would be
  // invented certainty. "completed" stays in the return type for callers, but
  // this adapter does not emit it until a real signal exists.
  return "idle"
}

async function shareSession(config: ResolvedConfig, sessionId: string): Promise<string> {
  const response = await opencodeFetch(config, `/session/${encodeURIComponent(sessionId)}/share`, {
    method: "POST"
  })
  const body = await readJson(response)
  if (!isRecord(body) || !isRecord(body.share) || typeof body.share.url !== "string" || body.share.url.length === 0) {
    throw new OpencodeUnreachableError("opencode share response missing share.url", { kind: "parse" })
  }
  return body.share.url
}

function mapStatusEntry(value: unknown): OpencodeSessionStatus {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new OpencodeUnreachableError("opencode session status entry was malformed", { kind: "parse" })
  }
  if (value.type === "idle") return "idle"
  // retry is still in flight (attempt/next), not idle. The public enum has no
  // retry state, so surface it as running.
  if (value.type === "busy" || value.type === "retry") return "running"
  throw new OpencodeUnreachableError(`opencode session status type is unrecognized: ${value.type}`, { kind: "parse" })
}

function extractReplyText(parts: unknown): string {
  if (!Array.isArray(parts)) {
    throw new OpencodeUnreachableError("opencode message response missing parts array", { kind: "parse" })
  }
  const texts: string[] = []
  for (const part of parts) {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") continue
    texts.push(part.text)
  }
  return texts.join("\n")
}

function readSessionId(body: unknown): string {
  if (!isRecord(body) || typeof body.id !== "string" || body.id.length === 0) {
    throw new OpencodeUnreachableError("opencode create session response missing id", { kind: "parse" })
  }
  return body.id
}

function resolveConfig(config: OpencodeSessionConfig | undefined): ResolvedConfig {
  const shareBaseUrl = config?.shareBaseUrl?.trim() ? config.shareBaseUrl.trim() : null
  return {
    baseUrl: (config?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, ""),
    shareBaseUrl,
    timeoutMs: config?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }
}

async function opencodeFetch(
  config: ResolvedConfig,
  path: string,
  init: { method: string; headers?: Record<string, string>; body?: string; query?: Record<string, string> }
): Promise<Response> {
  const url = new URL(path, `${config.baseUrl}/`)
  if (init.query) {
    for (const [key, value] of Object.entries(init.query)) {
      url.searchParams.set(key, value)
    }
  }

  try {
    return await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: AbortSignal.timeout(config.timeoutMs)
    })
  } catch (error) {
    const name = error instanceof Error ? error.name : ""
    const message = error instanceof Error ? error.message : String(error)
    if (name === "AbortError" || name === "TimeoutError") {
      throw new OpencodeUnreachableError(`opencode request timed out after ${config.timeoutMs}ms: ${url}`, {
        kind: "network",
        cause: error
      })
    }
    throw new OpencodeUnreachableError(`opencode server unreachable at ${config.baseUrl}: ${message}`, {
      kind: "network",
      cause: error
    })
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!response.ok) {
    throw new OpencodeUnreachableError(`opencode returned HTTP ${response.status}: ${truncate(text, 300)}`, {
      kind: "http",
      status: response.status
    })
  }
  if (!text) {
    throw new OpencodeUnreachableError("opencode returned an empty body", {
      kind: "parse",
      status: response.status
    })
  }
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new OpencodeUnreachableError("opencode returned malformed JSON", {
      kind: "parse",
      status: response.status,
      cause: error
    })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}...`
}
