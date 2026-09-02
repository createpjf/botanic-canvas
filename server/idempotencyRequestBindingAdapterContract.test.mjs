import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createPersistentAgentRun } from './agent/semantic/botanicAgentRun.mjs'
import { createIdempotencyRequestBinding } from './idempotencyRequestBinding.mjs'
import { createProductStore } from './store/productStore.mjs'

function localHarness() {
  const directory = mkdtempSync(join(tmpdir(), 'botanic-idempotency-binding-'))
  const store = createProductStore({
    dataPath: join(directory, 'product.json'),
    bootstrapAccessToken: 'idempotency-owner',
  })
  const owner = store.authenticate('idempotency-owner')
  store.writeProject(owner.id, {
    schemaVersion: 25,
    id: 'project-idempotency-binding',
    name: 'Idempotency Binding',
    nodes: [], edges: [], assets: [], assetGroups: [], generationJobs: [], agentRuns: [],
    updatedAt: 1,
  })
  return { directory, store, owner }
}

test('Local Adapter 不允许后到的 Run 写入偷换已持久化幂等请求绑定', () => {
  const { directory, store, owner } = localHarness()
  try {
    const input = {
      projectId: 'project-idempotency-binding',
      plan: {
        intent: 'initial_generation', instruction: 'A', summary: 'A', prompt: 'A',
        settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
        constraints: [], output: { mode: 'single', count: 1, candidatesPerItem: 1 },
      },
      branches: [{ id: 'branch-a', label: 'A' }],
    }
    const firstBinding = createIdempotencyRequestBinding({
      scope: 'agent-run.create', projectId: input.projectId, request: input,
    })
    const conflictingBinding = createIdempotencyRequestBinding({
      scope: 'agent-run.create', projectId: input.projectId, request: { ...input, plan: { ...input.plan, prompt: 'B' } },
    })
    const run = createPersistentAgentRun(input, {
      id: 'agent-run-bound', ownerId: owner.id, now: 10, idempotencyBinding: firstBinding,
    })
    store.putAgentRun(owner.id, run)

    assert.throws(
      () => store.putAgentRun(owner.id, { ...run, idempotencyBinding: conflictingBinding, updatedAt: 20 }),
      (caught) => caught?.code === 'IDEMPOTENCY_BINDING_CONFLICT',
    )
    assert.deepEqual(store.readAgentRun(owner.id, run.id).idempotencyBinding, firstBinding)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Local Adapter 以首次 Run 绑定保护完整请求快照，不能复用 binding 改写计划', () => {
  const { directory, store, owner } = localHarness()
  try {
    const input = {
      projectId: 'project-idempotency-binding',
      plan: {
        intent: 'initial_generation', instruction: 'A', summary: 'A', prompt: 'A',
        settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
        constraints: [], output: { mode: 'single', count: 1, candidatesPerItem: 1 },
      },
      branches: [{ id: 'branch-a', label: 'A' }],
    }
    const binding = createIdempotencyRequestBinding({
      scope: 'agent-run.create', projectId: input.projectId, request: input,
    })
    const run = createPersistentAgentRun(input, {
      id: 'agent-run-request-sticky', ownerId: owner.id, now: 10, idempotencyBinding: binding,
    })
    store.putAgentRun(owner.id, run)

    store.putAgentRun(owner.id, {
      ...run,
      plan: { ...run.plan, prompt: 'B' },
      branches: [{ ...run.branches[0], label: 'B', updatedAt: 20 }],
      idempotencyBinding: binding,
      updatedAt: 20,
    })

    assert.equal(store.readAgentRun(owner.id, run.id).plan.prompt, 'A')
    assert.equal(store.readAgentRun(owner.id, run.id).branches[0].label, 'A')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Local Adapter 的 guarded Job put 保留首次请求绑定并拒绝冲突覆盖', () => {
  const { directory, store, owner } = localHarness()
  try {
    const projectId = 'project-idempotency-binding'
    const firstBinding = createIdempotencyRequestBinding({
      scope: 'generation.submit', projectId, request: { prompt: 'A' },
    })
    const conflictingBinding = createIdempotencyRequestBinding({
      scope: 'generation.submit', projectId, request: { prompt: 'B' },
    })
    const job = {
      id: 'job-bound', ownerId: owner.id, projectId, status: 'queued', kind: 'generation',
      createdAt: 10, updatedAt: 10, batchCount: 1, settings: { model: 'gpt-image-2' },
      rawInput: { projectId, prompt: 'A' }, outputs: [], idempotencyBinding: firstBinding,
    }
    store.putGenerationJob(owner.id, job)

    const conflict = store.putGenerationJob(owner.id, {
      ...job, rawInput: { projectId, prompt: 'B' }, idempotencyBinding: conflictingBinding, updatedAt: 20,
    })

    assert.deepEqual(conflict.idempotencyBinding, firstBinding)
    assert.equal(conflict.rawInput.prompt, 'A')
    assert.deepEqual(store.readGenerationJob(owner.id, job.id).idempotencyBinding, firstBinding)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Local Adapter 以首次 Job 绑定保护完整请求快照，不能复用 binding 改写输入', () => {
  const { directory, store, owner } = localHarness()
  try {
    const projectId = 'project-idempotency-binding'
    const binding = createIdempotencyRequestBinding({
      scope: 'generation.submit', projectId, request: { prompt: 'A' },
    })
    const job = {
      id: 'job-request-sticky', ownerId: owner.id, projectId, status: 'queued', kind: 'generation',
      createdAt: 10, updatedAt: 10, batchCount: 1, settings: { model: 'gpt-image-2' },
      rawInput: { projectId, prompt: 'A' }, outputs: [], idempotencyBinding: binding,
    }
    store.putGenerationJob(owner.id, job)

    store.putGenerationJob(owner.id, {
      ...job,
      rawInput: { projectId, prompt: 'B' },
      idempotencyBinding: binding,
      updatedAt: 20,
    })

    assert.equal(store.readGenerationJob(owner.id, job.id).rawInput.prompt, 'A')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Supabase migration 在 Run/Job 行锁内保持请求绑定 sticky，并拒绝 mismatch', () => {
  const migration = readFileSync(new URL(
    '../supabase/migrations/20260828120000_idempotency_request_binding.sql',
    import.meta.url,
  ), 'utf8')

  assert.match(migration, /create or replace function public\.botanic_put_agent_run\(/u)
  assert.match(migration, /create or replace function public\.botanic_put_generation_job_guarded\(/u)
  assert.match(migration, /existing\.payload->'idempotencyBinding'/u)
  assert.match(migration, /candidate_binding is distinct from stored_binding/u)
  assert.match(migration, /jsonb_set\(result, array\[field_name\]/u)
  assert.match(migration, /botanic_sticky_json_fields\([\s\S]*'idempotencyBinding'/u)
  assert.match(migration, /botanic_sticky_agent_run_branches\(/u)
  assert.match(migration, /pg_advisory_xact_lock/u)
})
