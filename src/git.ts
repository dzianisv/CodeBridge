import path from "node:path"
import { access, mkdir, rm } from "node:fs/promises"
import { execa } from "execa"

export async function git(args: string[], cwd: string): Promise<string> {
  const result = await execa("git", args, { cwd })
  return result.stdout.trim()
}

export async function isDirty(cwd: string): Promise<boolean> {
  const status = await git(["status", "--porcelain"], cwd)
  return status.length > 0
}

export async function currentBranch(cwd: string): Promise<string> {
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)
  return branch
}

export async function fetchOrigin(cwd: string): Promise<void> {
  await git(["fetch", "origin"], cwd)
}

export async function checkoutBranch(cwd: string, branch: string): Promise<void> {
  await git(["checkout", branch], cwd)
}

export async function createBranch(cwd: string, branch: string, base: string): Promise<void> {
  await git(["checkout", "-B", branch, base], cwd)
}

export function worktreePathForRun(repoPath: string, runId: string): string {
  return path.resolve(repoPath, "..", ".codebridge-worktrees", path.basename(repoPath), runId)
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function isRegisteredWorktree(repoPath: string, worktreePath: string): Promise<boolean> {
  try {
    const list = await git(["worktree", "list", "--porcelain"], repoPath)
    const resolved = path.resolve(worktreePath)
    return list.split(/\r?\n/).some(line => {
      if (!line.startsWith("worktree ")) return false
      return path.resolve(line.slice("worktree ".length)) === resolved
    })
  } catch {
    return false
  }
}

export async function addWorktree(repoPath: string, worktreePath: string, branch: string, base: string): Promise<void> {
  if (await pathExists(worktreePath) || await isRegisteredWorktree(repoPath, worktreePath)) {
    await removeWorktree(repoPath, worktreePath)
  }
  await mkdir(path.dirname(worktreePath), { recursive: true })
  await git(["worktree", "add", "-B", branch, worktreePath, base], repoPath)
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  let removeError: unknown = null
  try {
    await git(["worktree", "remove", "--force", worktreePath], repoPath)
  } catch (error) {
    removeError = error
    if (await pathExists(worktreePath)) {
      await rm(worktreePath, { recursive: true, force: true })
    }
  }
  await git(["worktree", "prune"], repoPath)
  if (removeError && (await pathExists(worktreePath) || await isRegisteredWorktree(repoPath, worktreePath))) {
    throw removeError
  }
}

export async function commitAll(cwd: string, message: string): Promise<void> {
  await git(["add", "-A"], cwd)
  await git(["commit", "-m", message], cwd)
}

export async function pushBranch(cwd: string, remoteUrl: string, branch: string): Promise<void> {
  await git(["push", remoteUrl, `HEAD:${branch}`], cwd)
}

export async function getDefaultBranchFromOrigin(cwd: string): Promise<string | null> {
  try {
    const ref = await git(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd)
    const parts = ref.split("/")
    return parts[parts.length - 1] ?? null
  } catch {
    return null
  }
}
