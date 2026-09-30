import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import {
  FIXTURE_ISSUE_KEY,
  FIXTURE_PR,
  FIXTURE_REPO,
  GuardError,
  assertContained,
  assertSummaryBeforeJiraWrite,
  fixturePinProblems,
  resolveScratchRoot,
  selectScratchRequest,
  summaryHasSandboxToken,
  summaryIsAmbiguous
} from "./lib/kpi3-guards.js"

// Local guards only. No Jira, GitHub, or opencode process. No credentials.

const execFileAsync = promisify(execFile)
const runner = path.resolve("scripts/test-kpi3-live.ts")
const tsx = path.resolve("node_modules/.bin/tsx")

async function main() {
  const tests: Array<[string, () => Promise<void>]> = [
    ["fixture pin rejects a non-fixture issue before credentials or network", nonFixtureIssueRefused],
    ["fixture pin rejects the wrong PR and repo before credentials or network", wrongPrAndRepoRefused],
    ["ambiguous summary is rejected before a Jira write", ambiguousSummaryRejected],
    ["word-boundary sandbox tokens are accepted", sandboxTokensAccepted],
    ["scratch fallback order is explicit then hermes then tmp", scratchFallbackOrder],
    ["scratch rejects the repo, the database parent, and symlink escape", scratchIsolation]
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

async function nonFixtureIssueRefused() {
  const result = await runRunner([
    "--confirm-live-write",
    "--issue-key", "KAN-9",
    "--pr", String(FIXTURE_PR),
    "--repo", FIXTURE_REPO
  ])
  assert.equal(result.code, 2)
  assert.match(result.stderr, /MARKER: refused-before-network/)
  assert.match(result.stderr, /pinned fixture KAN-5/)
  assert.doesNotMatch(result.stderr, /LIVE WRITE PLAN/)
  assert.doesNotMatch(result.stderr, /sentinel-token/)
  assert.equal(fixturePinProblems({
    confirm: true,
    issueKey: "KAN-9",
    pr: FIXTURE_PR,
    repo: FIXTURE_REPO,
    help: false,
    unknown: []
  }).some(item => item.includes(FIXTURE_ISSUE_KEY)), true)
}

async function wrongPrAndRepoRefused() {
  const wrongPr = await runRunner([
    "--confirm-live-write",
    "--issue-key", FIXTURE_ISSUE_KEY,
    "--pr", "1",
    "--repo", FIXTURE_REPO
  ])
  assert.equal(wrongPr.code, 2)
  assert.match(wrongPr.stderr, /MARKER: refused-before-network/)
  assert.match(wrongPr.stderr, /pinned fixture 729/)
  const wrongRepo = await runRunner([
    "--confirm-live-write",
    "--issue-key", FIXTURE_ISSUE_KEY,
    "--pr", String(FIXTURE_PR),
    "--repo", "example/not-the-fixture"
  ])
  assert.equal(wrongRepo.code, 2)
  assert.match(wrongRepo.stderr, /MARKER: refused-before-network/)
  assert.match(wrongRepo.stderr, /dzianisv\/codebridge-test/)
  const source = readFileSync(runner, "utf8")
  assert.equal(source.includes("/opt/homebrew/bin/gh"), false)
  assert.match(source, /execFile\(bin, args/)
}

async function ambiguousSummaryRejected() {
  for (const summary of ["latest contest", "protest", "attestation", "production rollout", ""]) {
    assert.equal(summaryHasSandboxToken(summary), false, summary)
    if (/test|e2e|sandbox|verification/i.test(summary)) assert.equal(summaryIsAmbiguous(summary), true, summary)
    assert.throws(() => assertSummaryBeforeJiraWrite(summary), GuardError)
  }
}

async function sandboxTokensAccepted() {
  for (const summary of ["KAN-5 test fixture", "e2e", "sandbox verification", "codebridge verification ticket"]) {
    assert.equal(summaryHasSandboxToken(summary), true, summary)
    assert.equal(summaryIsAmbiguous(summary), false, summary)
    assert.doesNotThrow(() => assertSummaryBeforeJiraWrite(summary))
  }
}

async function scratchFallbackOrder() {
  assert.equal(selectScratchRequest({
    CODEBRIDGE_SCRATCH_DIR: "/tmp/explicit",
    HERMES_HOME: "/tmp/hermes"
  }, "/tmp/os").source, "CODEBRIDGE_SCRATCH_DIR")
  assert.equal(selectScratchRequest({ HERMES_HOME: "/tmp/hermes" }, "/tmp/os").requested, path.join("/tmp/hermes", "cache", "scratch"))
  assert.equal(selectScratchRequest({ CODEBRIDGE_SCRATCH_DIR: "  ", HERMES_HOME: "" }, "/tmp/os").source, "os.tmpdir")
}

async function scratchIsolation() {
  const root = mkdtempSync(path.join(os.tmpdir(), "codebridge-kpi3-guards-"))
  try {
    const repo = path.join(root, "repo")
    const dbParent = path.join(root, "db")
    const scratch = path.join(root, "scratch")
    const outside = path.join(root, "outside")
    mkdirSync(repo)
    mkdirSync(dbParent)
    mkdirSync(scratch)
    mkdirSync(outside)
    const dbFile = path.join(dbParent, "codebridge.db")
    writeFileSync(dbFile, "")
    const repoLink = path.join(root, "repo-link")
    symlinkSync(repo, repoLink)
    assert.throws(() => resolveScratchRoot({
      env: { CODEBRIDGE_SCRATCH_DIR: repoLink },
      repoRoots: [repo],
      databaseFile: dbFile,
      tmpdir: root
    }), GuardError)
    assert.equal(existsSync(repo), true, "isolation failure must not delete the repo")
    assert.throws(() => resolveScratchRoot({
      env: { CODEBRIDGE_SCRATCH_DIR: dbParent },
      repoRoots: [repo],
      databaseFile: dbFile,
      tmpdir: root
    }), /database parent/)
    const opened = resolveScratchRoot({
      env: { CODEBRIDGE_SCRATCH_DIR: scratch },
      repoRoots: [repo],
      databaseFile: dbFile,
      tmpdir: root
    })
    assert.equal(opened.source, "CODEBRIDGE_SCRATCH_DIR")
    const escaped = path.join(scratch, "escape")
    symlinkSync(outside, escaped)
    assert.throws(() => assertContained(opened.root, escaped), /escaped/)
    assert.equal(existsSync(escaped), false)
    assert.equal(existsSync(outside), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function runRunner(args: string[]): Promise<{ code: number; stderr: string }> {
  const env = { ...process.env }
  delete env.JIRA_EMAIL
  delete env.JIRA_API_TOKEN
  delete env.GITHUB_TOKEN
  delete env.GH_TOKEN
  env.JIRA_API_TOKEN = "sentinel-token"
  try {
    await execFileAsync(tsx, [runner, ...args], { env, timeout: 20_000 })
    return { code: 0, stderr: "" }
  } catch (error) {
    const failed = error as { code?: number; stderr?: string; stdout?: string }
    return { code: typeof failed.code === "number" ? failed.code : 1, stderr: `${failed.stderr ?? ""}\n${failed.stdout ?? ""}` }
  }
}

await main()
