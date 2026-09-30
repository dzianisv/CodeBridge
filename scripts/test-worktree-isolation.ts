import assert from "node:assert/strict"
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execa } from "execa"
import { currentBranch, git, isDirty, removeWorktree } from "../src/git.js"
import { prepareRepo } from "../src/runner.js"
import type { RunRecord } from "../src/types.js"

function fail(message: string): never {
  console.error(`WORKTREE ISOLATION: FAIL — ${message}`)
  process.exit(1)
}

function makeRun(repoPath: string, id: string): RunRecord {
  const now = new Date().toISOString()
  return {
    id,
    tenantId: "local",
    repoFullName: "acme/widget",
    repoPath,
    status: "running",
    prompt: "isolate this run",
    createdAt: now,
    updatedAt: now
  }
}

async function missing(target: string): Promise<boolean> {
  try {
    await access(target)
    return false
  } catch {
    return true
  }
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codebridge-worktree-"))
  const origin = path.join(root, "origin.git")
  const clone = path.join(root, "clone")
  let failed: string | null = null
  try {
    await execa("git", ["init", "--bare", "-b", "main", origin])
    await execa("git", ["init", "-b", "main", clone])
    await execa("git", ["config", "user.email", "codebridge@example.com"], { cwd: clone })
    await execa("git", ["config", "user.name", "CodeBridge"], { cwd: clone })
    await execa("git", ["config", "commit.gpgsign", "false"], { cwd: clone })
    await writeFile(path.join(clone, "README.md"), "hello\n")
    await execa("git", ["add", "README.md"], { cwd: clone })
    await execa("git", ["commit", "-m", "init"], { cwd: clone })
    await execa("git", ["remote", "add", "origin", origin], { cwd: clone })
    await execa("git", ["push", "-u", "origin", "main"], { cwd: clone })

    await mkdir(path.join(clone, ".supervisor"), { recursive: true })
    await writeFile(path.join(clone, ".supervisor", "x"), "leftover\n")
    await writeFile(path.join(clone, "status.md"), "status\n")
    await writeFile(path.join(clone, "README.md"), "dirty\n")

    const beforeStatus = await git(["status", "--porcelain"], clone)
    const beforeBranch = await currentBranch(clone)
    const beforeReadme = await readFile(path.join(clone, "README.md"), "utf8")
    assert.ok(beforeStatus.includes("README.md"), "fixture must modify a tracked file")
    assert.ok(beforeStatus.includes(".supervisor"), "fixture must leave .supervisor untracked")
    assert.ok(beforeStatus.includes("status.md"), "fixture must leave status.md untracked")

    const runA = makeRun(clone, "run-a")
    const runB = makeRun(clone, "run-b")
    const pathA = await prepareRepo(runA, "main", "codex/run-a")
    const pathB = await prepareRepo(runB, "main", "codex/run-b")

    const expectedA = path.resolve(clone, "..", ".codebridge-worktrees", path.basename(clone), "run-a")
    const expectedB = path.resolve(clone, "..", ".codebridge-worktrees", path.basename(clone), "run-b")
    assert.equal(pathA, expectedA, "worktree A is not outside the shared clone")
    assert.equal(pathB, expectedB, "worktree B is not outside the shared clone")
    assert.ok(!pathA.startsWith(clone + path.sep), "worktree A is inside the shared clone")
    assert.ok(!pathB.startsWith(clone + path.sep), "worktree B is inside the shared clone")

    assert.equal(await isDirty(pathA), false, "worktree A must be clean")
    assert.equal(await isDirty(pathB), false, "worktree B must be clean")
    assert.equal(await currentBranch(pathA), "codex/run-a")
    assert.equal(await currentBranch(pathB), "codex/run-b")
    assert.notEqual(await currentBranch(pathA), await currentBranch(pathB), "runs must use distinct branches")

    const originMain = await git(["rev-parse", "origin/main"], clone)
    assert.equal(await git(["rev-parse", "HEAD"], pathA), originMain, "worktree A must start from origin/main")
    assert.equal(await git(["rev-parse", "HEAD"], pathB), originMain, "worktree B must start from origin/main")

    // Stale path from an earlier run must be removed and recreated, not fail the next prepare.
    const againA = await prepareRepo(runA, "main", "codex/run-a")
    assert.equal(againA, pathA)
    assert.equal(await isDirty(againA), false, "recreated worktree A must be clean")
    assert.equal(await currentBranch(againA), "codex/run-a")

    assert.equal(await git(["status", "--porcelain"], clone), beforeStatus, "shared clone leftovers changed")
    assert.equal(await currentBranch(clone), beforeBranch, "shared clone branch changed")
    assert.equal(await readFile(path.join(clone, "README.md"), "utf8"), beforeReadme)
    assert.equal(await readFile(path.join(clone, ".supervisor", "x"), "utf8"), "leftover\n")
    assert.equal(await readFile(path.join(clone, "status.md"), "utf8"), "status\n")

    await removeWorktree(clone, pathA)
    await removeWorktree(clone, pathB)
    assert.equal(await missing(pathA), true, "cleanup left worktree A")
    assert.equal(await missing(pathB), true, "cleanup left worktree B")
    const listed = await git(["worktree", "list", "--porcelain"], clone)
    assert.equal(listed.includes(pathA), false, "worktree A still registered")
    assert.equal(listed.includes(pathB), false, "worktree B still registered")
    assert.equal(await git(["status", "--porcelain"], clone), beforeStatus, "cleanup mutated the shared clone")

    console.log("WORKTREE ISOLATION: PASS")
  } catch (error) {
    failed = error instanceof Error ? error.stack ?? error.message : String(error)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
  if (failed) fail(failed)
}

await main()
