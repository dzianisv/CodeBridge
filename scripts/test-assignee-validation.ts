import assert from "node:assert/strict"
import type { RepoConfig, TenantConfig } from "../src/types.js"
import {
  getAssigneeValidationHealth,
  pollValidatedAssignmentForTests,
  resetAssigneeValidityCacheForTests,
  setAssigneeValidationNowForTests
} from "../src/github-poll.js"

const VALID = "valid-user"
const INVALID = "invalid-user"
const UNKNOWN = "unknown-user"
const IMPLICIT_BOT = "implicit-bot[bot]"
const TTL_MS = 5 * 60 * 1000
const REPO = "acme/widgets"

type CheckCall = { installationId: number; assignee: string }
type ListCall = { installationId: number; assignee: string }

const repo: RepoConfig = { fullName: REPO, path: "/tmp/acme-widgets" }

function tenant(installationId: number): TenantConfig {
  return {
    id: `tenant-${installationId}`,
    name: `Tenant ${installationId}`,
    github: {
      installationId,
      assignmentAssignees: [VALID, INVALID, UNKNOWN]
    },
    repos: [repo]
  }
}

function createFakeClient(
  installationId: number,
  checks: CheckCall[],
  lists: ListCall[],
  mode: { invalidIsValid: boolean; notAssignable?: ReadonlySet<string>; list422?: ReadonlySet<string> }
) {
  return {
    octokit: {
      issues: {
        checkUserCanBeAssigned: async (params: { owner: string; repo: string; assignee: string }) => {
          checks.push({ installationId, assignee: params.assignee })
          const login = params.assignee.toLowerCase()
          if (login === VALID) return { status: 204 }
          if (mode.notAssignable?.has(login)) throw { status: 404 }
          if (login === INVALID) {
            if (mode.invalidIsValid) return { status: 204 }
            throw { status: 404 }
          }
          if (login === UNKNOWN) throw { status: 503 }
          throw { status: 500 }
        },
        listForRepo: async (params: { assignee: string }) => {
          lists.push({ installationId, assignee: params.assignee })
          if (mode.list422?.has(params.assignee.toLowerCase())) throw { status: 422 }
          return { data: [] }
        }
      }
    }
  }
}

async function pollBothSurfacesTwice(
  installationId: number,
  client: ReturnType<typeof createFakeClient>
): Promise<void> {
  const input = {
    tenant: tenant(installationId),
    repo,
    client: client as never
  }
  await pollValidatedAssignmentForTests({ ...input, surface: "issues" })
  await pollValidatedAssignmentForTests({ ...input, surface: "issues" })
  await pollValidatedAssignmentForTests({ ...input, surface: "pull_requests" })
  await pollValidatedAssignmentForTests({ ...input, surface: "pull_requests" })
}

async function main(): Promise<void> {
  resetAssigneeValidityCacheForTests()
  let now = 1_700_000_000_000
  setAssigneeValidationNowForTests(() => now)

  const checks: CheckCall[] = []
  const lists: ListCall[] = []
  const mode = { invalidIsValid: false }
  const client = createFakeClient(101, checks, lists, mode)

  await pollBothSurfacesTwice(101, client)

  for (const login of [VALID, INVALID, UNKNOWN]) {
    assert.equal(
      checks.filter(call => call.installationId === 101 && call.assignee === login).length,
      1,
      `${login} validated once`
    )
  }
  assert.equal(lists.length, 4)
  assert.ok(lists.every(call => call.installationId === 101 && call.assignee === VALID))

  const health = getAssigneeValidationHealth()
  assert.equal(health.ttlMs, TTL_MS)
  assert.equal(health.unknownRetryMs, TTL_MS)
  assert.deepEqual(health.counts, { valid: 1, invalid: 1, unknown: 1 })
  const byLogin = Object.fromEntries(health.entries.map(entry => [entry.login, entry]))
  assert.equal(byLogin[VALID]?.status, "valid")
  assert.equal(byLogin[VALID]?.httpStatus, 204)
  assert.equal(byLogin[INVALID]?.status, "invalid")
  assert.equal(byLogin[INVALID]?.httpStatus, 404)
  assert.equal(byLogin[UNKNOWN]?.status, "unknown")
  assert.equal(byLogin[UNKNOWN]?.httpStatus, 503)
  assert.ok(health.entries.every(entry => entry.installationId === 101 && entry.repo === REPO))

  const isolatedChecks: CheckCall[] = []
  const isolatedLists: ListCall[] = []
  const isolatedClient = createFakeClient(202, isolatedChecks, isolatedLists, { invalidIsValid: false })
  await pollValidatedAssignmentForTests({
    surface: "issues",
    tenant: tenant(202),
    repo,
    client: isolatedClient as never
  })
  assert.equal(isolatedChecks.length, 3, "other installation does not reuse validation cache")
  assert.deepEqual(isolatedChecks.map(call => call.installationId), [202, 202, 202])
  assert.deepEqual(isolatedLists.map(call => call.assignee), [VALID])
  const isolatedHealth = getAssigneeValidationHealth()
  assert.equal(isolatedHealth.entries.filter(entry => entry.installationId === 101).length, 3)
  assert.equal(isolatedHealth.entries.filter(entry => entry.installationId === 202).length, 3)
  assert.equal(
    isolatedHealth.entries.find(entry => entry.installationId === 101 && entry.login === VALID)?.status,
    "valid"
  )
  assert.equal(
    isolatedHealth.entries.find(entry => entry.installationId === 202 && entry.login === INVALID)?.status,
    "invalid"
  )

  now += TTL_MS + 1
  mode.invalidIsValid = true
  const invalidChecksBefore = checks.filter(call => call.assignee === INVALID).length
  const listsBefore = lists.length
  await pollValidatedAssignmentForTests({
    surface: "issues",
    tenant: tenant(101),
    repo,
    client: client as never
  })
  assert.ok(checks.filter(call => call.installationId === 101 && call.assignee === INVALID).length > invalidChecksBefore)
  const listedAfter = lists.slice(listsBefore).map(call => call.assignee)
  assert.deepEqual(listedAfter, [VALID, INVALID])
  const after = getAssigneeValidationHealth()
  const rechecked = after.entries.find(entry => entry.installationId === 101 && entry.login === INVALID)
  assert.equal(rechecked?.status, "valid")
  assert.equal(rechecked?.httpStatus, 204)
  assert.ok((rechecked?.ageMs ?? TTL_MS) < TTL_MS)

  for (const surface of ["issues", "pull_requests"] as const) {
    resetAssigneeValidityCacheForTests()
    const botChecks: CheckCall[] = []
    const botLists: ListCall[] = []
    const botClient = createFakeClient(303, botChecks, botLists, {
      invalidIsValid: false,
      notAssignable: new Set([IMPLICIT_BOT])
    })
    const botTenant = tenant(303)
    assert.ok(!botTenant.github.assignmentAssignees?.includes(IMPLICIT_BOT))
    await pollValidatedAssignmentForTests({
      surface,
      tenant: botTenant,
      repo,
      client: botClient as never,
      botLogin: IMPLICIT_BOT
    })
    assert.equal(
      botChecks.filter(call => call.assignee === IMPLICIT_BOT).length,
      1,
      `${surface} checks implicit botLogin`
    )
    assert.ok(
      botLists.every(call => call.assignee !== IMPLICIT_BOT),
      `${surface} excludes 404 botLogin`
    )
    assert.deepEqual(botLists.map(call => call.assignee), [VALID])
    const botEntry = getAssigneeValidationHealth().entries.find(entry => entry.login === IMPLICIT_BOT)
    assert.equal(botEntry?.status, "invalid")
    assert.equal(botEntry?.httpStatus, 404)

    resetAssigneeValidityCacheForTests()
    const list422Checks: CheckCall[] = []
    const list422Lists: ListCall[] = []
    const list422Client = createFakeClient(404, list422Checks, list422Lists, {
      invalidIsValid: false,
      list422: new Set([VALID])
    })
    const list422Input = {
      surface,
      tenant: tenant(404),
      repo,
      client: list422Client as never
    }
    await pollValidatedAssignmentForTests(list422Input)
    assert.deepEqual(list422Lists.map(call => call.assignee), [VALID])
    const demoted = getAssigneeValidationHealth().entries.find(entry => entry.login === VALID)
    assert.equal(demoted?.status, "unknown")
    assert.equal(demoted?.httpStatus, 422)
    await pollValidatedAssignmentForTests(list422Input)
    assert.deepEqual(list422Lists.map(call => call.assignee), [VALID], `${surface} does not list login after 422`)
    const stillDemoted = getAssigneeValidationHealth().entries.find(entry =>
      entry.installationId === 404 && entry.login === VALID
    )
    assert.equal(stillDemoted?.status, "unknown")
    assert.equal(stillDemoted?.httpStatus, 422)
    assert.equal(list422Checks.filter(call => call.assignee === VALID).length, 1)
  }

  resetAssigneeValidityCacheForTests()
  setAssigneeValidationNowForTests(null)
  console.log("ASSIGNEE VALIDATION PASS")
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
