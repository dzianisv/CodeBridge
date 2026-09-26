import type { GitHubContext } from "./types.js"

export type CommandType = "run" | "reply" | "pause" | "resume" | "status"

export type ParsedCommand = {
  type: CommandType
  prompt: string
  repoHint?: string
  tenantHint?: string
  issue?: GitHubContext
}

export function extractCommand(text: string, prefixes: string[], botUserId?: string): ParsedCommand | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  const mentionPrefix = botUserId ? `<@${botUserId}>` : null
  let remaining = trimmed

  if (mentionPrefix && remaining.startsWith(mentionPrefix)) {
    remaining = remaining.slice(mentionPrefix.length).trim()
  } else {
    const prefix = findBestPrefixMatch(remaining, prefixes)
    if (!prefix) return null
    remaining = remaining.slice(prefix.length).trim()
  }

  // Allow human-friendly punctuation after a prefix/mention:
  // "@CodexEngineer, do X" / "codex: - do X"
  remaining = remaining.replace(/^[,:\-]\s*/, "")

  if (!remaining) return null

  const tenantHint = extractTenantHint(remaining)
  if (tenantHint) {
    remaining = stripTenantHint(remaining, tenantHint)
  }

  const parsed = parseCommandType(remaining)
  if (!parsed) return null

  const issue = parseIssueOrPr(remaining)
  const repoHint = extractRepoHint(remaining)

  return {
    type: parsed.type,
    prompt: parsed.prompt,
    repoHint: repoHint ?? undefined,
    tenantHint: tenantHint ?? undefined,
    issue: issue ?? undefined
  }
}

export function extractCommandFromManagedIssue(text: string): ParsedCommand | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  let remaining = trimmed
  const tenantHint = extractTenantHint(remaining)
  if (tenantHint) {
    remaining = stripTenantHint(remaining, tenantHint)
  }

  const parsed = parseCommandType(remaining)
  if (!parsed) return null

  const issue = parseIssueOrPr(remaining)
  const repoHint = extractRepoHint(remaining)

  return {
    type: parsed.type,
    prompt: parsed.prompt,
    repoHint: repoHint ?? undefined,
    tenantHint: tenantHint ?? undefined,
    issue: issue ?? undefined
  }
}

function parseCommandType(text: string): { type: CommandType; prompt: string } | null {
  const actionMatch = text.match(/^(run|reply|pause|resume|status)\b[:\s-]*/i)
  if (!actionMatch) {
    return { type: "run", prompt: text.trim() }
  }

  const type = actionMatch[1].toLowerCase() as CommandType
  const prompt = text.slice(actionMatch[0].length).trim()
  if ((type === "run" || type === "reply") && !prompt) return null
  return { type, prompt }
}

export function parseIssueOrPr(text: string): GitHubContext | null {
  const issue = parseIssueUrl(text)
  if (issue) return issue
  const pr = parsePrUrl(text)
  if (pr) return pr
  return null
}

export function parseIssueReference(
  text: string,
  defaults?: { owner: string; repo: string }
): GitHubContext | null {
  const direct = parseIssueOrPr(text)
  if (direct) return direct

  const scoped = parseScopedIssueRef(text)
  if (scoped) return scoped

  const local = parseLocalIssueRef(text)
  if (local && defaults) {
    return {
      owner: defaults.owner,
      repo: defaults.repo,
      issueNumber: local
    }
  }

  return null
}

export function extractRepoHint(text: string): string | null {
  const match = text.match(/\b([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\b/)
  if (!match) return null
  return `${match[1]}/${match[2]}`
}

const GH_ISSUE_URL = /github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/i
const GH_PR_URL = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i
const SCOPED_ISSUE_REF = /\b([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)#(\d+)\b/
const JIRA_KEY = /[A-Za-z][A-Za-z0-9]+-\d+/

// Explicit link hints (LLD §3 step 1). `gh:` and `owner/repo#N` do not say
// issue vs PR — same limitation as parseScopedIssueRef — so those come back
// as kind "gh". URL forms are specific. harness.ts must not reparse this.
export type LinkHint =
  | { kind: "jira"; issueKey: string }
  | { kind: "gh_issue"; repo: string; number: number }
  | { kind: "gh_pr"; repo: string; number: number }
  | { kind: "gh"; repo: string; number: number }

export function parseIssueUrl(text: string): GitHubContext | null {
  const match = text.match(GH_ISSUE_URL)
  if (!match) return null
  return {
    owner: match[1],
    repo: match[2],
    issueNumber: parseInt(match[3], 10)
  }
}

export function parsePrUrl(text: string): GitHubContext | null {
  const match = text.match(GH_PR_URL)
  if (!match) return null
  return {
    owner: match[1],
    repo: match[2],
    issueNumber: parseInt(match[3], 10)
  }
}

function parseScopedIssueRef(text: string): GitHubContext | null {
  const match = text.match(SCOPED_ISSUE_REF)
  if (!match) return null
  return {
    owner: match[1],
    repo: match[2],
    issueNumber: parseInt(match[3], 10)
  }
}

export function extractLinkHints(text: string): LinkHint[] {
  const hints: LinkHint[] = []
  for (const match of text.matchAll(new RegExp(GH_PR_URL.source, "gi"))) {
    hints.push({ kind: "gh_pr", repo: `${match[1]}/${match[2]}`, number: parseInt(match[3], 10) })
  }
  for (const match of text.matchAll(new RegExp(GH_ISSUE_URL.source, "gi"))) {
    hints.push({ kind: "gh_issue", repo: `${match[1]}/${match[2]}`, number: parseInt(match[3], 10) })
  }
  for (const match of text.matchAll(new RegExp(`(?:^|\\s)jira\\s*[:=]\\s*(${JIRA_KEY.source})\\b`, "gi"))) {
    hints.push({ kind: "jira", issueKey: match[1] })
  }
  for (const match of text.matchAll(new RegExp(`\\/browse\\/(${JIRA_KEY.source})\\b`, "gi"))) {
    hints.push({ kind: "jira", issueKey: match[1] })
  }
  // Reuse parseScopedIssueRef for the token after `gh:` so owner/repo#N is not
  // a second parser. The nested capture groups in SCOPED_ISSUE_REF are not the
  // outer match[1], which is why this walks the suffix instead.
  for (const match of text.matchAll(/(?:^|\s)gh\s*[:=]\s*(\S+)/gi)) {
    const scoped = parseScopedIssueRef(match[1])
    if (!scoped?.issueNumber) continue
    hints.push({ kind: "gh", repo: `${scoped.owner}/${scoped.repo}`, number: scoped.issueNumber })
  }
  for (const match of text.matchAll(new RegExp(SCOPED_ISSUE_REF.source, "gi"))) {
    hints.push({ kind: "gh", repo: `${match[1]}/${match[2]}`, number: parseInt(match[3], 10) })
  }
  return dedupeHints(hints)
}

export function jiraKeysFromBranch(branch: string): string[] {
  const keys: string[] = []
  for (const match of branch.matchAll(new RegExp(JIRA_KEY.source, "gi"))) {
    keys.push(match[0])
  }
  return [...new Set(keys.map(key => key.toUpperCase()))]
}

export function extractClosingRefs(text: string, defaultRepo?: string): Array<{ repo: string; number: number }> {
  const refs: Array<{ repo: string; number: number }> = []
  for (const match of text.matchAll(/(?:^|\s)(?:closes|fixes|resolves)\s+([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)#(\d+)\b/gi)) {
    refs.push({ repo: match[1], number: parseInt(match[2], 10) })
  }
  if (defaultRepo) {
    for (const match of text.matchAll(/(?:^|\s)(?:closes|fixes|resolves)\s+#(\d+)\b/gi)) {
      refs.push({ repo: defaultRepo, number: parseInt(match[1], 10) })
    }
  }
  return refs
}

function dedupeHints(hints: LinkHint[]): LinkHint[] {
  const seen = new Set<string>()
  const out: LinkHint[] = []
  for (const hint of hints) {
    const id = hint.kind === "jira"
      ? `jira:${hint.issueKey.toLowerCase()}`
      : `${hint.kind}:${hint.repo.toLowerCase()}#${hint.number}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push(hint)
  }
  return out
}

function parseLocalIssueRef(text: string): number | null {
  const match = text.match(/(?<![A-Za-z0-9_])#(\d+)\b/)
  if (!match) return null
  return parseInt(match[1], 10)
}

function findBestPrefixMatch(text: string, prefixes: string[]): string | null {
  const lower = text.toLowerCase()
  let best: string | null = null
  for (const prefix of prefixes) {
    if (!lower.startsWith(prefix.toLowerCase())) continue
    if (!best || prefix.length > best.length) {
      best = prefix
    }
  }
  return best
}

function extractTenantHint(text: string): string | null {
  const match = text.match(/(?:^|\s)(?:tenant|t)\s*[:=]\s*([A-Za-z0-9_.-]+)\b/i)
  if (!match) return null
  return match[1]
}

function stripTenantHint(text: string, tenantHint: string): string {
  const pattern = new RegExp(`(?:^|\\s)(?:tenant|t)\\s*[:=]\\s*${escapeRegExp(tenantHint)}\\b`, "i")
  return text.replace(pattern, " ").replace(/\s+/g, " ").trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
