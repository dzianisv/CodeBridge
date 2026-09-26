import { randomUUID } from "node:crypto"
import { logger } from "./logger.js"
import {
  SessionLinkClaimConflictError,
  SessionLinkResolveConflictError,
  type RunStore,
  type SessionLink,
  type SessionLinkKeyInput
} from "./storage.js"

/**
 * LLD §3 sketches `attachIdentifier(store, linkId, key)` without `tenantId`.
 * The same section inserts `(tenantId, kind, repo, value)`, and
 * `claimSessionLinkKey` requires `tenantId`. The parameter stays; this is the
 * storage signature, not a second design.
 */
export type LinkKey = SessionLinkKeyInput

export type SessionLinkStore = Pick<
  RunStore,
  "claimSessionLinkKey" | "promoteSessionLinkClaim" | "resolveSessionLink" | "abandonSessionLinkClaim"
>

/**
 * Claim window (LLD §2 step 5): a key row exists but `session_link` does not.
 * That is not "no link". `resolveLink` throws this instead of returning null
 * so a caller cannot start a second claim.
 */
export class SessionLinkPendingError extends Error {
  readonly linkId: string
  readonly createdAt: string

  constructor(linkId: string, createdAt: string) {
    super(`session link ${linkId} exists but the session is not ready`)
    this.name = "SessionLinkPendingError"
    this.linkId = linkId
    this.createdAt = createdAt
  }
}

/**
 * Identifier already claimed by a different link (LLD §3 / §3.1 / §3.2).
 * Both ids are here so the bot comment can name them. Never delete or
 * reassign the other link's key row.
 */
export class SessionLinkConflictError extends Error {
  readonly linkId: string
  readonly existingLinkId: string

  constructor(linkId: string, existingLinkId: string, options?: { cause?: unknown }) {
    super(`session link ${linkId} conflicts with existing link ${existingLinkId}`, options)
    this.name = "SessionLinkConflictError"
    this.linkId = linkId
    this.existingLinkId = existingLinkId
  }
}

export async function resolveLink(
  store: SessionLinkStore,
  tenantId: string,
  keys: LinkKey[]
): Promise<SessionLink | null> {
  try {
    const resolution = await store.resolveSessionLink({ tenantId, keys })
    if (resolution.state === "linked") return resolution.link
    if (resolution.state === "none") return null
    throw new SessionLinkPendingError(resolution.linkId, resolution.createdAt)
  } catch (error) {
    if (error instanceof SessionLinkResolveConflictError) {
      logger.warn({ tenantId, linkIds: error.linkIds }, "session link keys resolve to more than one link")
      throw error
    }
    throw error
  }
}

export async function attachIdentifier(
  store: SessionLinkStore,
  linkId: string,
  tenantId: string,
  key: LinkKey
): Promise<void> {
  try {
    await store.claimSessionLinkKey({ linkId, tenantId, key })
  } catch (error) {
    if (!(error instanceof SessionLinkClaimConflictError)) throw error
    // Re-attaching the same key to the same link is idempotent, including
    // while that link's claim is still in the window.
    if (error.linkId === linkId) return
    logger.warn(
      { tenantId, linkId, existingLinkId: error.linkId },
      "session link identifier is already claimed by a different link"
    )
    throw new SessionLinkConflictError(linkId, error.linkId, { cause: error })
  }
}

export async function claimAndCreateLink(
  store: SessionLinkStore,
  tenantId: string,
  initialKey: LinkKey,
  createSession: () => Promise<{ sessionId: string }>
): Promise<SessionLink> {
  const linkId = randomUUID()
  try {
    await store.claimSessionLinkKey({ linkId, tenantId, key: initialKey })
  } catch (error) {
    if (!(error instanceof SessionLinkClaimConflictError)) throw error
    // LLD §2 step 2: someone else claimed this identifier. Do not create a session.
    return existingLinkFromClaimConflict(store, tenantId, initialKey, error)
  }

  let session: { sessionId: string }
  try {
    session = await createSession()
  } catch (error) {
    // LLD §2 step 4: a failed createSession must not leave an orphan claim.
    await store.abandonSessionLinkClaim({ tenantId, linkId })
    throw error
  }

  // UNIQUE(tenant_id, opencode_session_id) failures propagate as
  // SessionLinkPromoteError. Do not retry, do not attach this session id onto
  // another link, and do not abandon after the session was created — a retry
  // must observe the pending claim instead of calling createSession again.
  return store.promoteSessionLinkClaim({
    linkId,
    tenantId,
    opencodeSessionId: session.sessionId
  })
}

async function existingLinkFromClaimConflict(
  store: SessionLinkStore,
  tenantId: string,
  initialKey: LinkKey,
  error: SessionLinkClaimConflictError
): Promise<SessionLink> {
  const resolution = await store.resolveSessionLink({ tenantId, keys: [initialKey] })
  if (resolution.state === "linked") return resolution.link
  if (resolution.state === "pending") {
    throw new SessionLinkPendingError(resolution.linkId, resolution.createdAt)
  }
  throw error
}
