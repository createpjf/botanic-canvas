import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createPersistentAgentRun } from './botanicAgentRun.mjs'
import { createProductStore } from './productStore.mjs'
import { productStoreCoreMethods } from './productStoreContract.mjs'

const generationExecutionMethods = [
  'claimGenerationJobExecution',
  'commitGenerationJobExecution',
  'cancelGenerationJobExecution',
  'acknowledgeGenerationJobCancellation',
  'compareAndSetGenerationJob',
]

function localHarness() {
  const directory = mkdtempSync(join(tmpdir(), 'botanic-generation-fence-'))
  const store = createProductStore({
    dataPath: join(directory, 'product.json'),
    bootstrapAccessToken: 'generation-fence-owner',
  })
  const owner = store.authenticate('generation-fence-owner')
  store.writeProject(owner.id, {
    schemaVersion: 25,
    id: 'project-generation-fence',
    name: 'Generation Fence',
    nodes: [], edges: [], assets: [], assetGroups: [], generationJobs: [], agentRuns: [],
    updatedAt: 1,
  })
  const job = {
    id: 'job-generation-fence', ownerId: owner.id, projectId: 'project-generation-fence',
    status: 'queued', kind: 'generation', createdAt: 1, updatedAt: 1, batchCount: 1,
    settings: { model: 'gpt-image-2' }, rawInput: { projectId: 'project-generation-fence' }, outputs: [],
  }
  store.putGenerationJob(owner.id, job)
  return { directory, store, owner, job }
}

test('ProductStore 核心契约显式要求五个 Generation Job 原子方法', () => {
  for (const method of generationExecutionMethods) {
    assert.equal(productStoreCoreMethods.includes(method), true, method)
  }
})

test('PostgreSQL 与 Supabase Adapter 均实现五方法，迁移提供对应原子 RPC', () => {
  const postgresAdapter = readFileSync(new URL('./postgresProductStore.mjs', import.meta.url), 'utf8')
  const supabaseAdapter = readFileSync(new URL('./supabaseProductStore.mjs', import.meta.url), 'utf8')
  const migration = readFileSync(new URL('../supabase/migrations/20260827170000_generation_job_execution_fence.sql', import.meta.url), 'utf8')
  for (const method of generationExecutionMethods) {
    assert.match(postgresAdapter, new RegExp(`async ${method}\\(`), method)
    assert.match(supabaseAdapter, new RegExp(`async ${method}\\(`), method)
  }
  for (const rpc of [
    'botanic_put_generation_job_guarded',
    'botanic_claim_generation_job_execution',
    'botanic_commit_generation_job_execution',
    'botanic_cancel_generation_job_execution',
    'botanic_acknowledge_generation_job_cancellation',
    'botanic_compare_and_set_generation_job',
    'botanic_project_generation_job_to_agent_run',
  ]) {
    assert.match(migration, new RegExp(`create or replace function public\\.${rpc}\\(`), rpc)
    assert.match(supabaseAdapter, new RegExp(`'${rpc}'`), rpc)
  }
  assert.match(migration, /clock_timestamp\(\)/u)
  assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\(p_job_id, 4\)\)/u)
})

test('Supabase Agent Run 分支投影由行锁 RPC 合并，不做 read→whole payload update', () => {
  const supabaseAdapter = readFileSync(new URL('./supabaseProductStore.mjs', import.meta.url), 'utf8')
  const migration = readFileSync(new URL('../supabase/migrations/20260827170000_generation_job_execution_fence.sql', import.meta.url), 'utf8')
  const adapterStart = supabaseAdapter.indexOf('async function projectGenerationJob')
  const adapterEnd = supabaseAdapter.indexOf('\n  return {', adapterStart)
  const adapterProjection = supabaseAdapter.slice(adapterStart, adapterEnd)
  assert.match(adapterProjection, /botanic_project_generation_job_to_agent_run/u)
  assert.doesNotMatch(adapterProjection, /from\('agent_runs'\)/u)

  const rpcStart = migration.indexOf('create or replace function public.botanic_project_generation_job_to_agent_run')
  const rpcEnd = migration.indexOf('\nrevoke all on function public.botanic_project_generation_job_to_agent_run', rpcStart)
  assert.ok(rpcStart >= 0 && rpcEnd > rpcStart)
  const rpc = migration.slice(rpcStart, rpcEnd)
  assert.match(rpc, /from public\.agent_runs where id = run_id for update/u)
  assert.match(rpc, /jsonb_array_elements\(existing\.payload->'branches'\)/u)
  assert.match(rpc, /prior_updated > job_updated_ms/u)
  assert.match(rpc, /branch_payload->>'activeJobId'.*is distinct from job_id/su)
})

test('三个 Adapter 的普通 putAgentRun 都在锁内按分支合并，Supabase RPC 不再 whole-row LWW', () => {
  const localAdapter = readFileSync(new URL('./productStore.mjs', import.meta.url), 'utf8')
  const postgresAdapter = readFileSync(new URL('./postgresProductStore.mjs', import.meta.url), 'utf8')
  const migration = readFileSync(new URL('../supabase/migrations/20260827170000_generation_job_execution_fence.sql', import.meta.url), 'utf8')
  assert.match(localAdapter, /mergeAgentRunForWrite\(existing, payload\)/u)
  assert.match(postgresAdapter, /mergeAgentRunForWrite\(asPayload\(existing\), payload\)/u)

  const rpcStart = migration.indexOf('create or replace function public.botanic_put_agent_run')
  const rpcEnd = migration.indexOf('\nrevoke all on function public.botanic_put_agent_run', rpcStart)
  assert.ok(rpcStart >= 0 && rpcEnd > rpcStart)
  const rpc = migration.slice(rpcStart, rpcEnd)
  assert.match(rpc, /from public\.agent_runs where id = incoming\.id for update/u)
  assert.match(rpc, /stored_attempt > candidate_attempt/u)
  assert.match(rpc, /stored_active_job_id is not null/u)
  assert.match(rpc, /stored_updated_ms > candidate_updated_ms/u)
  assert.match(rpc, /jsonb_array_elements\(branches\)/u)
})

test('生产 Adapter 用 DB clock 扫过期 lease，且 authenticated 不能直读私有 token', () => {
  const postgresAdapter = readFileSync(new URL('./postgresProductStore.mjs', import.meta.url), 'utf8')
  const supabaseAdapter = readFileSync(new URL('./supabaseProductStore.mjs', import.meta.url), 'utf8')
  const migration = readFileSync(new URL('../supabase/migrations/20260827170000_generation_job_execution_fence.sql', import.meta.url), 'utf8')

  const postgresStart = postgresAdapter.indexOf('async recoverStaleGenerationJobs')
  const postgresEnd = postgresAdapter.indexOf('\n    async createMediaObject', postgresStart)
  const postgresRecovery = postgresAdapter.slice(postgresStart, postgresEnd)
  assert.match(postgresRecovery, /clock_timestamp\(\)/u)
  assert.doesNotMatch(postgresRecovery, /const observedAt = now\(\)/u)

  const supabaseStart = supabaseAdapter.indexOf('async recoverStaleGenerationJobs')
  const supabaseEnd = supabaseAdapter.indexOf('\n    async createMediaObject', supabaseStart)
  const supabaseRecovery = supabaseAdapter.slice(supabaseStart, supabaseEnd)
  assert.match(supabaseRecovery, /botanic_recover_stale_generation_jobs/u)
  assert.doesNotMatch(supabaseRecovery, /new Date\(now\(\)/u)

  assert.match(migration, /create or replace function public\.botanic_recover_stale_generation_jobs\(/u)
  assert.match(migration, /lease_expires_at <= observed_at/u)
  assert.match(migration, /revoke select on table public\.generation_jobs from public, anon, authenticated/u)
  assert.match(migration, /drop policy if exists "owner can read generation jobs"/u)
})

test('PostgreSQL Job 原子事务不耦合可重建的 Artifact Index', () => {
  const postgresAdapter = readFileSync(new URL('./postgresProductStore.mjs', import.meta.url), 'utf8')
  const helperStart = postgresAdapter.indexOf('async function persistGenerationDecision')
  const helperEnd = postgresAdapter.indexOf('\n  async function refreshGenerationArtifactRecords', helperStart)
  assert.ok(helperStart >= 0 && helperEnd > helperStart)
  const durableTransaction = postgresAdapter.slice(helperStart, helperEnd)
  assert.doesNotMatch(durableTransaction, /upsertArtifactRecords/u)
})

test('Local Adapter contract：claim 单胜者、cancel 压住 stale commit、普通 put 受 fence', async () => {
  const { directory, store, owner, job } = localHarness()
  try {
    const [first, second] = await Promise.all([
      store.claimGenerationJobExecution(job.id, { leaseToken: 'lease-a', leaseDurationMs: 60_000 }),
      store.claimGenerationJobExecution(job.id, { leaseToken: 'lease-b', leaseDurationMs: 60_000 }),
    ])
    const winner = [first, second].find((decision) => decision.changed)
    const loser = winner === first ? second : first
    assert.equal(winner.kind, 'claimed')
    assert.equal(loser.kind, 'in_progress')

    const cancelled = await store.cancelGenerationJobExecution(owner.id, {
      id: job.id,
      projectId: job.projectId,
      requestedAt: Date.now(),
      reason: 'user',
      outcomes: {
        queued: { billing: 'none', capability: 'local-abort-only', workerReleased: false, code: 'CANCELLED_BEFORE_DISPATCH' },
        running: { billing: 'possible', capability: 'local-abort-only', workerReleased: true, code: 'CANCELLED_RESULT_DISCARDED' },
      },
    })
    assert.equal(cancelled.kind, 'cancelled')
    assert.equal(cancelled.job.cancel.code, 'CANCELLED_RESULT_DISCARDED')
    assert.equal(cancelled.job.cancel.workerReleased, false)

    const cancellationHeartbeat = await store.commitGenerationJobExecution(owner.id, {
      id: job.id,
      projectId: job.projectId,
      leaseToken: winner.job.execution.leaseToken,
      executionGeneration: winner.job.execution.generation,
      status: 'cancelled',
      signalId: cancelled.job.cancel.signalId,
      updateAgentRun: false,
      recordAudit: false,
    })
    assert.equal(cancellationHeartbeat.kind, 'cancellation_heartbeat')
    assert.ok(cancellationHeartbeat.job.execution.leaseExpiresAt >= cancelled.job.execution.leaseExpiresAt)
    assert.equal(cancellationHeartbeat.job.cancel.lastHeartbeatAt, cancellationHeartbeat.job.updatedAt)

    const wrongGeneration = await store.acknowledgeGenerationJobCancellation(owner.id, {
      id: job.id,
      projectId: job.projectId,
      signalId: cancelled.job.cancel.signalId,
      executionGeneration: winner.job.execution.generation + 1,
      leaseToken: winner.job.execution.leaseToken,
      releaseBasis: 'worker_exit',
    })
    assert.equal(wrongGeneration.kind, 'stale')
    const acknowledged = await store.acknowledgeGenerationJobCancellation(owner.id, {
      id: job.id,
      projectId: job.projectId,
      signalId: cancelled.job.cancel.signalId,
      executionGeneration: winner.job.execution.generation,
      leaseToken: winner.job.execution.leaseToken,
      releaseBasis: 'worker_exit',
    })
    assert.equal(acknowledged.kind, 'acknowledged')
    assert.equal(acknowledged.job.cancel.workerReleased, true)
    assert.equal(acknowledged.job.cancel.releaseBasis, 'worker_exit')

    const stale = await store.commitGenerationJobExecution(owner.id, {
      id: job.id,
      projectId: job.projectId,
      leaseToken: winner.job.execution.leaseToken,
      executionGeneration: winner.job.execution.generation,
      status: 'succeeded',
      job: { ...winner.job, status: 'succeeded', outputs: [{ id: 'late-output' }] },
    })
    assert.equal(stale.kind, 'stale')

    const putResult = await store.putGenerationJob(owner.id, { ...job, status: 'failed', error: 'stale writer' })
    assert.equal(putResult.status, 'cancelled')
    assert.equal(store.readGenerationJob(owner.id, job.id).status, 'cancelled')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Local Adapter contract：terminal retry CAS 清旧 lease 且 generation 水位单调', async () => {
  const { directory, store, owner, job } = localHarness()
  try {
    const claimed = await store.claimGenerationJobExecution(job.id, {
      leaseToken: 'lease-first', leaseDurationMs: 60_000,
    })
    const failed = await store.commitGenerationJobExecution(owner.id, {
      id: job.id,
      projectId: job.projectId,
      leaseToken: claimed.job.execution.leaseToken,
      executionGeneration: claimed.job.execution.generation,
      status: 'failed',
      job: { ...claimed.job, status: 'failed', error: 'provider failed' },
    })
    const retried = await store.compareAndSetGenerationJob(owner.id, {
      id: job.id,
      projectId: job.projectId,
      expectedStatus: 'failed',
      expectedExecutionGeneration: 1,
      clearExecution: true,
      job: { ...failed.job, status: 'queued', error: undefined, execution: undefined },
    })
    assert.equal(retried.kind, 'updated')
    assert.equal(retried.job.execution, undefined)
    assert.equal(retried.job.executionVersion, 1)

    const reclaimed = await store.claimGenerationJobExecution(job.id, {
      leaseToken: 'lease-second', leaseDurationMs: 60_000,
    })
    assert.equal(reclaimed.job.execution.generation, 2)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Agent Run 两分支并发 Generation 投影不丢任一分支', async () => {
  const { directory, store, owner, job } = localHarness()
  try {
    const run = createPersistentAgentRun({
      projectId: job.projectId,
      plan: {
        intent: 'initial_generation', instruction: '并发生成', summary: '并发生成', prompt: '并发生成',
        settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' }, constraints: [],
        output: { mode: 'batch_by_count', count: 2, candidatesPerItem: 1 },
      },
      branches: [{ id: 'branch-a', label: 'A' }, { id: 'branch-b', label: 'B' }],
    }, { id: 'run-two-branches', ownerId: owner.id, now: 1 })
    store.putAgentRun(owner.id, run)
    const jobs = ['branch-a', 'branch-b'].map((branchId) => ({
      ...job, id: `job-${branchId}`, agentRun: { runId: run.id, branchId },
    }))
    for (const queued of jobs) store.putGenerationJob(owner.id, queued, { updateAgentRun: false })
    const claims = await Promise.all(jobs.map((queued, index) => store.claimGenerationJobExecution(queued.id, {
      leaseToken: `lease-${index}`, leaseDurationMs: 60_000,
    })))

    await Promise.all(claims.map((claim) => store.commitGenerationJobExecution(owner.id, {
      id: claim.job.id,
      projectId: claim.job.projectId,
      leaseToken: claim.job.execution.leaseToken,
      executionGeneration: claim.job.execution.generation,
      status: 'running',
      job: claim.job,
      updateAgentRun: true,
      recordAudit: false,
    })))

    const storedRun = store.readAgentRun(owner.id, run.id)
    assert.deepEqual(storedRun.branches.map((branch) => [branch.id, branch.status]), [
      ['branch-a', 'running'],
      ['branch-b', 'running'],
    ])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
