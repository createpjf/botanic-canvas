import assert from 'node:assert/strict'
import test from 'node:test'
import { createGenerationSubmissionService } from './generationSubmissionService.mjs'

function harness({ enqueueImpl, putGenerationJobImpl } = {}) {
  const jobs = new Map()
  const enqueued = []
  const reservations = []
  const chargedReservations = []
  const reservationIds = new Set()
  const consumes = []
  const service = createGenerationSubmissionService({
    config: {
      models: ['gpt-image-2'],
      modelOptions: [{
        id: 'gpt-image-2', provider: 'openai', mediaKind: 'image',
        aspectRatios: ['1:1'], resolutions: ['1K'],
      }],
      maximumBatchCount: 4,
      maximumReferenceBytes: 8 * 1024 * 1024,
      security: { generationOutputsPerDay: 100 },
      generationBudgets: { workspace: 100, project: 100, member: 100 },
    },
    productStore: {
      projectAccess: async () => ({ exists: true, role: 'owner' }),
      readGenerationJob: async (_userId, id) => jobs.get(id),
      putGenerationJob: async (userId, job) => {
        if (putGenerationJobImpl) return putGenerationJobImpl(userId, job, jobs)
        jobs.set(job.id, structuredClone(job))
        return job
      },
      compareAndSetGenerationJob: async (_userId, command) => {
        const current = jobs.get(command.id)
        const currentGeneration = current?.execution ? Number(current.execution.generation) : null
        if (!current
          || current.status !== command.expectedStatus
          || currentGeneration !== command.expectedExecutionGeneration) {
          return { kind: 'stale', changed: false, job: structuredClone(current) }
        }
        const next = structuredClone(command.job)
        if (command.clearExecution) delete next.execution
        jobs.set(next.id, next)
        return { kind: 'updated', changed: true, job: structuredClone(next) }
      },
      readAgentRun: async () => undefined,
    },
    securityControls: {
      consume: async (input) => { consumes.push(input); return { allowed: true } },
      reserveMany: async (input) => {
        reservations.push(input)
        if (reservationIds.has(input.reservationId)) return { allowed: true, reused: true, remaining: 99 }
        reservationIds.add(input.reservationId)
        chargedReservations.push(input)
        return { allowed: true, reused: false, remaining: 99 }
      },
    },
    enqueue: async (id) => { enqueued.push(id); await enqueueImpl?.(id, jobs) },
  })
  return { service, jobs, enqueued, reservations, chargedReservations, consumes }
}

const rawInput = {
  projectId: 'project-a', kind: 'generation', prompt: '生成品牌首图', batchCount: 1,
  settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
  recipe: { references: [{ name: '产品', mediaId: 'media_product', inputRole: 'reference_image' }] },
}

test('重复提交复用同一任务、队列和预算预留', async () => {
  const { service, enqueued, reservations, consumes } = harness()
  const first = await service({ user: { id: 'user-a' }, rawInput, idempotencyKey: 'workflow_run-a_item-a' })
  const duplicate = await service({ user: { id: 'user-a' }, rawInput, idempotencyKey: 'workflow_run-a_item-a' })

  assert.equal(duplicate.job.id, first.job.id)
  assert.equal(duplicate.existing, true)
  assert.equal(enqueued.length, 1)
  assert.equal(reservations.length, 2)
  assert.equal(consumes.length, 0)
})

test('同一幂等键已绑定另一份生成请求时返回冲突，不复用旧任务', async () => {
  const { service, enqueued } = harness()
  await service({ user: { id: 'user-a' }, rawInput, idempotencyKey: 'submission-request-binding' })

  await assert.rejects(
    service({
      user: { id: 'user-a' },
      rawInput: { ...rawInput, prompt: '这不是第一次提交的生成意图' },
      idempotencyKey: 'submission-request-binding',
    }),
    (caught) => caught?.code === 'IDEMPOTENCY_KEY_CONFLICT' && caught?.statusCode === 409,
  )
  assert.equal(enqueued.length, 1, '冲突请求不得再次入队')
})

test('失败项原配方重试复用任务与幂等键且不重复扣费', async () => {
  const { service, jobs, enqueued, reservations, consumes } = harness()
  const first = await service({ user: { id: 'user-a' }, rawInput, idempotencyKey: 'workflow_run-a_item-a' })
  jobs.set(first.job.id, {
    ...jobs.get(first.job.id), status: 'failed', error: 'provider timeout',
    variants: [{ index: 0, status: 'failed', error: 'provider timeout' }],
  })

  const retried = await service({
    user: { id: 'user-a' }, rawInput, idempotencyKey: 'workflow_run-a_item-a', retryExisting: true,
  })

  assert.equal(retried.job.id, first.job.id)
  assert.equal(retried.job.idempotencyKey, 'workflow_run-a_item-a')
  assert.equal(retried.job.status, 'queued')
  assert.equal(retried.retried, true)
  assert.equal(enqueued.length, 2)
  assert.equal(reservations.length, 2)
  assert.equal(consumes.length, 0)
})

test('同一幂等键并发首次提交只实际预留一次日输出额度与一次预算', async () => {
  const { service, chargedReservations, reservations } = harness()

  const [first, second] = await Promise.all([
    service({ user: { id: 'user-a' }, rawInput, idempotencyKey: 'submission-concurrent-once' }),
    service({ user: { id: 'user-a' }, rawInput, idempotencyKey: 'submission-concurrent-once' }),
  ])

  assert.equal(first.job.id, second.job.id)
  assert.equal(reservations.length, 4, '两个请求都会尝试两种预留')
  assert.equal(chargedReservations.length, 2, '稳定 reservationId 令每种额度只实际扣一次')
  assert.deepEqual(
    chargedReservations.map((item) => item.entries.map((entry) => entry.scope).join(',')).sort(),
    ['generation-output', 'workspace-budget,project-budget,member-budget'].sort(),
  )
})

test('HTTP 提交也经过 Compiler：每个 Job 都带指纹，画布结果不断链', async () => {
  // 指纹只在 Agent 路径上有，「任一 Artifact 可反查 Plan」就只对 Agent 结果成立，
  // 画布上手工生成的图会断链。
  const { service, jobs } = harness()
  const submitted = await service({ user: { id: 'user-a' }, rawInput, idempotencyKey: 'submission-fingerprint' })
  assert.ok(submitted.job.planFingerprint)
  assert.ok(submitted.job.branchFingerprint)
  // 落库同样带上：Artifact 是从持久化任务派生的。
  const stored = jobs.get(submitted.job.id)
  assert.equal(stored.planFingerprint, submitted.job.planFingerprint)
  assert.equal(stored.branchFingerprint, submitted.job.branchFingerprint)
})

test('同一份提交内容得到同一指纹，改了内容就换指纹', async () => {
  const a = await harness().service({ user: { id: 'user-a' }, rawInput, idempotencyKey: 'submission-same-content-a' })
  const b = await harness().service({ user: { id: 'user-a' }, rawInput, idempotencyKey: 'submission-same-content-b' })
  // 指纹描述「提交了什么」，与幂等键无关。
  assert.equal(b.job.planFingerprint, a.job.planFingerprint)

  const c = await harness().service({
    user: { id: 'user-a' },
    rawInput: { ...rawInput, prompt: '换成完全不同的画面描述' },
    idempotencyKey: 'submission-other-content-c',
  })
  assert.notEqual(c.job.planFingerprint, a.job.planFingerprint)
})

test('画布提交不带创作约束时，编译不改写用户的 Prompt', async () => {
  // 编译对这条路径的价值是指纹，不是改写 Prompt；悄悄给 Prompt 加前缀会改变实际生成。
  const { service } = harness()
  const submitted = await service({ user: { id: 'user-a' }, rawInput, idempotencyKey: 'submission-prompt-intact' })
  assert.equal(submitted.job.rawInput.prompt, '生成品牌首图')
  // 也不给手工生成凭空声明质量策略与约束 —— 那等于宣称用户选过它们。
  assert.equal(submitted.job.rawInput.recipe.qualityPolicy, undefined)
  assert.equal(submitted.job.rawInput.recipe.constraints, undefined)
})

test('工作流提交沿用版本发布时固定的计划指纹，各项仍可区分', async () => {
  // 「纯文字 Run 可发布、执行并生成与原 Compiled Plan 指纹一致的结果」靠这条成立：
  // 各项按本次提交内容各算一个指纹的话，结果就归不回那一次发布。
  const workflowInput = (itemId) => ({
    ...rawInput,
    productionWorkflow: {
      workflowId: 'wf-1', workflowVersion: 2, workflowRunId: 'wf-run-1',
      workflowItemId: itemId, planFingerprint: 'published-plan-fp',
    },
  })
  const first = await harness().service({ user: { id: 'user-a' }, rawInput: workflowInput('SKU-1'), idempotencyKey: 'workflow_run-a_sku-1' })
  const second = await harness().service({ user: { id: 'user-a' }, rawInput: workflowInput('SKU-2'), idempotencyKey: 'workflow_run-a_sku-2' })

  assert.equal(first.job.planFingerprint, 'published-plan-fp')
  assert.equal(second.job.planFingerprint, 'published-plan-fp')
  // 分支指纹按批量项身份派生，因此两项互不相同但都归回同一次发布。
  assert.notEqual(first.job.branchFingerprint, second.job.branchFingerprint)
})

test('没有工作流来源的提交仍按提交内容算指纹', async () => {
  const plain = await harness().service({ user: { id: 'user-a' }, rawInput, idempotencyKey: 'submission-plain-fingerprint' })
  assert.ok(plain.job.planFingerprint)
  assert.notEqual(plain.job.planFingerprint, 'published-plan-fp')
})

test('enqueue 响应失败但 Worker 已 claim 时，queued→failed CAS 输掉且不覆盖 running', async () => {
  const { service, jobs } = harness({
    enqueueImpl: async (id, storedJobs) => {
      const queued = storedJobs.get(id)
      storedJobs.set(id, {
        ...queued,
        status: 'running',
        execution: { generation: 1, leaseToken: 'lease-worker' },
      })
      throw new Error('Redis response lost')
    },
  })

  const result = await service({ user: { id: 'user-a' }, rawInput, idempotencyKey: 'submission-ambiguous-enqueue' })

  assert.equal(result.job.status, 'running')
  assert.equal(jobs.get(result.job.id).status, 'running')
  assert.equal(jobs.get(result.job.id).execution.leaseToken, 'lease-worker')
})

test('并发提交已先 claim 时复用 Store 权威 running，不再因重复 enqueue 失败终结 Worker', async () => {
  const { service, jobs, enqueued } = harness({
    putGenerationJobImpl: async (_userId, job, storedJobs) => {
      const running = {
        ...structuredClone(job), status: 'running',
        executionVersion: 1,
        execution: { generation: 1, leaseToken: 'lease-concurrent-worker' },
      }
      storedJobs.set(job.id, running)
      return structuredClone(running)
    },
    enqueueImpl: async () => { throw new Error('重复 enqueue 不应发生') },
  })

  const result = await service({ user: { id: 'user-a' }, rawInput, idempotencyKey: 'submission-put-race-running' })

  assert.equal(result.existing, true)
  assert.equal(result.job.status, 'running')
  assert.equal(jobs.get(result.job.id).execution.leaseToken, 'lease-concurrent-worker')
  assert.deepEqual(enqueued, [])
})

test('failed→queued 重试 CAS 输给并发完成时，不重新入队或清掉成功产出', async () => {
  const { service, jobs, enqueued } = harness()
  const first = await service({ user: { id: 'user-a' }, rawInput, idempotencyKey: 'submission-retry-race' })
  const failed = { ...jobs.get(first.job.id), status: 'failed', execution: { generation: 1, leaseToken: 'lease-old' } }
  jobs.set(first.job.id, failed)
  const originalStatus = failed.status
  // 模拟 read failed 之后、CAS 行锁之前另一个恢复器已完成。
  const originalGet = jobs.get.bind(jobs)
  let reads = 0
  jobs.get = (id) => {
    reads += 1
    if (reads === 2) {
      const succeeded = { ...originalGet(id), status: 'succeeded', outputs: [{ id: 'output-authoritative' }] }
      jobs.set(id, succeeded)
    }
    return originalGet(id)
  }

  const result = await service({
    user: { id: 'user-a' }, rawInput, idempotencyKey: 'submission-retry-race', retryExisting: true,
  })

  assert.equal(originalStatus, 'failed')
  assert.equal(result.job.status, 'succeeded')
  assert.deepEqual(result.job.outputs, [{ id: 'output-authoritative' }])
  assert.equal(enqueued.length, 1, '只有首次提交入队')
})

test('cancelled Job 显式重试会清理旧 cancel/lease/writeback 终态元数据', async () => {
  const { service, jobs } = harness()
  const first = await service({ user: { id: 'user-a' }, rawInput, idempotencyKey: 'submission-cancelled-retry' })
  jobs.set(first.job.id, {
    ...jobs.get(first.job.id),
    status: 'cancelled',
    cancel: { reason: 'user', code: 'CANCELLED_RESULT_DISCARDED' },
    executionVersion: 3,
    execution: { generation: 3, leaseToken: 'lease-old', settledAt: 2_000 },
    projectWritebackPending: true,
    projectWritebackError: 'old error',
    errorCode: 'OLD_ERROR',
  })

  const result = await service({
    user: { id: 'user-a' }, rawInput, idempotencyKey: 'submission-cancelled-retry', retryExisting: true,
  })

  assert.equal(result.job.status, 'queued')
  assert.equal(result.job.cancel, undefined)
  assert.equal(result.job.execution, undefined)
  assert.equal(result.job.executionVersion, 3, '历史 generation 单调水位保留给下一次 claim')
  assert.equal(result.job.projectWritebackPending, undefined)
  assert.equal(result.job.projectWritebackError, undefined)
  assert.equal(result.job.errorCode, undefined)
})
