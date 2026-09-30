import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs"
import path from "node:path"

export const FIXTURE_ISSUE_KEY = "KAN-5"
export const FIXTURE_PR = 729
export const FIXTURE_REPO = "dzianisv/codebridge-test"

const LOOSE_SUMMARY = /test|e2e|sandbox|verification/i
const SANDBOX_SUMMARY = /\b(?:test|e2e|sandbox|verification)\b/i

export class GuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GuardError"
  }
}

export type PinArgs = {
  confirm: boolean
  issueKey?: string
  pr?: number
  repo?: string
  help: boolean
  unknown: string[]
}

export function fixturePinProblems(args: PinArgs): string[] {
  const problems: string[] = []
  if (args.help) problems.push("help requested")
  if (!args.confirm) problems.push("missing --confirm-live-write")
  if (!args.issueKey) problems.push("missing --issue-key")
  else if (args.issueKey !== FIXTURE_ISSUE_KEY) {
    problems.push(`--issue-key must be the pinned fixture ${FIXTURE_ISSUE_KEY}`)
  }
  if (args.pr == null) problems.push("missing --pr")
  else if (!Number.isInteger(args.pr) || args.pr !== FIXTURE_PR) {
    problems.push(`--pr must be the pinned fixture ${FIXTURE_PR}`)
  }
  if (!args.repo) problems.push("missing --repo")
  else if (args.repo !== FIXTURE_REPO) problems.push(`--repo must be the pinned fixture ${FIXTURE_REPO}`)
  if (args.unknown.length > 0) problems.push(`unknown args: ${args.unknown.join(" ")}`)
  return problems
}

export function summaryHasSandboxToken(summary: string): boolean {
  return SANDBOX_SUMMARY.test(summary)
}

export function summaryIsAmbiguous(summary: string): boolean {
  return LOOSE_SUMMARY.test(summary) && !summaryHasSandboxToken(summary)
}

export function assertSummaryBeforeJiraWrite(summary: string): void {
  if (typeof summary !== "string" || summaryIsAmbiguous(summary) || !summaryHasSandboxToken(summary)) {
    throw new GuardError("refusing Jira write: summary is missing, non-fixture, or ambiguous (need a word-boundary test, e2e, sandbox, or verification token)")
  }
}

export type ScratchSource = "CODEBRIDGE_SCRATCH_DIR" | "HERMES_HOME" | "os.tmpdir"

export function selectScratchRequest(
  env: { CODEBRIDGE_SCRATCH_DIR?: string; HERMES_HOME?: string },
  tmpdir: string
): { source: ScratchSource; requested: string } {
  const explicit = env.CODEBRIDGE_SCRATCH_DIR?.trim()
  if (explicit) return { source: "CODEBRIDGE_SCRATCH_DIR", requested: explicit }
  const home = env.HERMES_HOME?.trim()
  if (home) return { source: "HERMES_HOME", requested: path.join(home, "cache", "scratch") }
  return { source: "os.tmpdir", requested: tmpdir }
}

export function resolveScratchRoot(input: {
  env: { CODEBRIDGE_SCRATCH_DIR?: string; HERMES_HOME?: string }
  repoRoots: string[]
  databaseFile: string | null
  tmpdir: string
}): { root: string; source: ScratchSource } {
  const selected = selectScratchRequest(input.env, input.tmpdir)
  mkdirSync(selected.requested, { recursive: true })
  const root = realpathSync(selected.requested)
  assertScratchIsolated(root, { repoRoots: input.repoRoots, databaseFile: input.databaseFile })
  return { root, source: selected.source }
}

export function assertScratchIsolated(scratch: string, opts: { repoRoots: string[]; databaseFile: string | null }): void {
  const resolved = resolveExisting(scratch)
  for (const repo of opts.repoRoots) {
    if (!repo) continue
    const repoReal = resolveExisting(repo)
    if (isInside(repoReal, resolved) || isInside(resolved, repoReal)) {
      throw new GuardError(`scratch ${resolved} is not isolated from repo ${repoReal}`)
    }
  }
  if (opts.databaseFile) {
    const dbReal = resolveExisting(opts.databaseFile)
    const dbParent = path.dirname(dbReal)
    if (resolved === dbParent) {
      throw new GuardError(`scratch ${resolved} is the database parent; refusing`)
    }
    if (isInside(resolved, dbReal)) {
      throw new GuardError(`configured database ${dbReal} is inside scratch ${resolved}; refusing`)
    }
  }
}

export function assertContained(root: string, child: string): void {
  const realRoot = resolveExisting(root)
  let realChild = ""
  try {
    realChild = realpathSync(child)
  } catch (error) {
    rmSync(child, { recursive: true, force: true })
    const message = error instanceof Error ? error.message : String(error)
    throw new GuardError(`removed unreadable artifact ${child}: ${message}`)
  }
  if (!isInside(realRoot, realChild) || realChild === realRoot) {
    rmSync(child, { recursive: true, force: true })
    throw new GuardError(`removed escaped artifact ${child} -> ${realChild}`)
  }
}

export function sqliteFileFromUrl(databaseUrl: string): string | null {
  if (!databaseUrl || databaseUrl === ":memory:") return null
  if (databaseUrl.startsWith("sqlite://")) return path.resolve(databaseUrl.slice("sqlite://".length))
  if (databaseUrl.startsWith("sqlite:")) {
    const file = databaseUrl.slice("sqlite:".length)
    return file ? path.resolve(file) : null
  }
  return path.resolve(databaseUrl)
}

function resolveExisting(target: string): string {
  const resolved = path.resolve(target)
  if (!existsSync(resolved)) return resolved
  return realpathSync(resolved)
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}
