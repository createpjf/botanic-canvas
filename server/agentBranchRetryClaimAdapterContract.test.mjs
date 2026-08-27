import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createPersistentAgentRun } from './botanicAgentRun.mjs'
import { createIdempotencyRequestBinding } from './idempotencyRequestBinding.mjs'
import { createProductStore } from './productStore.mjs'

function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'botanic-branch-retry-claim-'))
  const store = createProductStore({
    dataPath: join(directory, 'product.json'),
    bootstrapAccessToken: 'branch-retry-owner',
  })
  const owner = store.authenticate('branch-retry-owner')
  const projectId = 'project-branch-retry-claim'
  store.writeProject(owner.id, {
    schemaVersion: 25, id: projectId, name: 'Branch retry claim',
    nodes: [], edges: [], assets: [], assetGroups: [], generationJobs: [], agentRuns: [], updatedAt: 1,
  })
  const input = {
    projectId,
    plan: {
      intent: 'initial_generation', instruction: 'A', summary: 'A', prompt: 'A',
      settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
      constraints: [], output: { mode: 'single', count: 1, candidatesPerItem: 1 },
    },
    branches: [{ id: 'branch-a', label: 'A' }],
  }
  const run = createPersistentAgentRun(input, { id: 'run-branch-retry-claim', ownerId: owner.id, now: 10 })
  run.status = 'failed'
  run.branches[0] = {
    ...run.branches[0], status: 'failed', activeJobId: 'job-source', jobIds: ['job-source'], updatedAt: 20,
  }
  store.putAgentRun(owner.id, run)
  return { directory, store, owner, projectId, run }
}

function claim(projectId, jobId) {
  const idempotencyBinding = createIdempotencyRequestBinding({
    scope: 'agent-branch.retry', projectId,
    request: { runId: 'run-branch-retry-claim', branchId: 'branch-a', sourceAttempt: 0, sourceJobId: 'job-source' },
  })
  const job = {
    id: jobId, projectId, status: 'queued', kind: 'generation', createdAt: 30, updatedAt: 30,
    batchCount: 1, settings: { model: 'gpt-image-2' }, rawInput: { projectId, prompt: 'A' },
    outputs: [], idempotencyKey: jobId, idempotencyBinding,
    agentRun: { runId: 'run-branch-retry-claim', branchId: 'branch-a', attempt: 1 },
  }
  return {
    runId: 'run-branch-retry-claim', projectId, branchId: 'branch-a',
    expectedAttempt: 0, expectedActiveJobId: 'job-source', jobId, idempotencyBinding, job,
  }
}

test('Local Adapter 原子 claim：同 source attempt 不同 Job identity 只能一个胜出，同 identity 可重放', () => {
  const { directory, store, owner, projectId } = harness()
  try {
    const winner = store.claimAgentBranchRetry(owner.id, claim(projectId, 'job-retry-a'))
    const replay = store.claimAgentBranchRetry(owner.id, claim(projectId, 'job-retry-a'))
    const loser = store.claimAgentBranchRetry(owner.id, claim(projectId, 'job-retry-b'))

    assert.equal(winner.kind, 'claimed')
    assert.equal(winner.changed, true)
    assert.equal(replay.kind, 'replay')
    assert.equal(replay.changed, false)
    assert.equal(loser.kind, 'conflict')
    assert.equal(loser.changed, false)
    assert.equal(loser.run.branches[0].activeJobId, 'job-retry-a')
    assert.equal(loser.run.branches[0].attempt, 1)
    assert.equal(store.readGenerationJob(owner.id, 'job-retry-a').agentRun.attempt, 1)
    assert.equal(store.readGenerationJob(owner.id, 'job-retry-b'), undefined)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Local Adapter 的 Branch claim 与 Job identity 同事务：跨入口同 ID 冲突不移动 Run', () => {
  const { directory, store, owner, projectId } = harness()
  try {
    const command = claim(projectId, 'job-cross-endpoint')
    const foreignBinding = createIdempotencyRequestBinding({
      scope: 'generation.submit', projectId, request: { prompt: 'foreign' },
    })
    store.putGenerationJob(owner.id, {
      ...command.job,
      ownerId: owner.id,
      agentRun: undefined,
      rawInput: { projectId, prompt: 'foreign' },
      idempotencyBinding: foreignBinding,
    })

    const decision = store.claimAgentBranchRetry(owner.id, command)
    const storedRun = store.readAgentRun(owner.id, command.runId)

    assert.equal(decision.kind, 'job_conflict')
    assert.equal(decision.changed, false)
    assert.equal(storedRun.status, 'failed')
    assert.equal(storedRun.branches[0].attempt, 0)
    assert.equal(storedRun.branches[0].activeJobId, 'job-source')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('PostgreSQL/Supabase Adapter 与新增 migration 暴露同一原子 Branch retry claim', () => {
  const postgres = readFileSync(new URL('./postgresProductStore.mjs', import.meta.url), 'utf8')
  const supabase = readFileSync(new URL('./supabaseProductStore.mjs', import.meta.url), 'utf8')
  const migration = readFileSync(new URL(
    '../supabase/migrations/20260828130000_agent_branch_retry_claim.sql',
    import.meta.url,
  ), 'utf8')

  assert.match(postgres, /async claimAgentBranchRetry\(/u)
  assert.match(postgres, /for update/u)
  assert.match(supabase, /botanic_claim_agent_branch_retry/u)
  assert.match(migration, /create or replace function public\.botanic_claim_agent_branch_retry\(/u)
  assert.match(migration, /for update/u)
  assert.match(migration, /expectedAttempt/u)
  assert.match(migration, /activeJobId/u)
  assert.match(migration, /retryClaim/u)
  assert.match(migration, /insert into public\.generation_jobs/u)
  assert.match(migration, /hashtextextended\(job_id, 4\)/u)
})
