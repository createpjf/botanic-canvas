import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentRunGenerationService } from './agentRunGenerationService.mjs'
import { createAgentTargetBinding } from './agentTargetBinding.mjs'

const settings = { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' }
const models = [{ id: 'gpt-image-2', provider: 'openai', mediaKind: 'image', aspectRatios: ['3:4'], resolutions: ['2K'] }]

function projectDocument() {
  return {
    schemaVersion: 25, id: 'project-1', name: '测试项目',
    nodes: [{ id: 'result-parent', type: 'result', position: { x: 100, y: 100 }, data: { kind: 'result', status: 'ready', image: '/api/media/media_parent', label: '首图', generationRecipe: { references: [], prompt: '原始首图', batchCount: 1, settings } } }],
    edges: [],
    assets: [{ id: 'asset-scene', name: '海边', role: '场景', image: '/api/media/media_scene', source: 'upload', tags: [] }],
    assetGroups: [{ id: 'group-scenes', name: '场景组', role: '场景', assetIds: ['asset-scene'] }],
    generationJobs: [], agentRuns: [], updatedAt: 1,
  }
}

function persistentRun() {
  return {
    id: 'agent-run-1', ownerId: 'user-1', projectId: 'project-1', status: 'queued',
    plan: {
      intent: 'replace_scene', instruction: '替换场景', summary: '生成海边分支', selectedResultNodeId: 'result-parent', prompt: '只替换场景。', settings,
      constraints: [{ dimension: 'scene', mode: 'vary', sourceAssetGroupId: 'group-scenes' }],
      output: { mode: 'batch_by_asset', count: 1, candidatesPerItem: 1 }, assetGroupId: 'group-scenes',
    },
    branches: [{ id: 'branch-a', label: '海边', assetId: 'asset-scene', status: 'queued', attempt: 0, jobIds: [], outputCount: 0, updatedAt: 1 }],
    createdAt: 1, updatedAt: 1,
  }
}

function harness({
  run = persistentRun(),
  document = projectDocument(),
  consumeError,
  turn,
  afterWriteProject,
  afterPutGenerationJob,
  putGenerationJobImpl,
  enqueueImpl,
  reserveManyImpl,
  concurrentWorkflowWrites = false,
  unrelatedWorkflowConflict = false,
  generationBudgets,
} = {}) {
  let activeRun = run
  let project = { document, revision: 1, graphRevision: 1 }
  const jobs = new Map()
  const queued = []
  const quotaCosts = []
  const quotaReservations = []
  const releasedReservations = []
  const chargedReservations = new Set()
  let chargedOutputCount = 0
  let waitingWrite
  let releaseWaitingWrite
  let injectedUnrelatedConflict = false
  const productStore = {
    async readAgentRun() { return activeRun },
    async readAgentTurn() { return turn },
    async putAgentRun(_userId, nextRun) { activeRun = nextRun; return nextRun },
    async readProject() { return project },
    async writeProject(_userId, document, expectedRevision) {
      if (concurrentWorkflowWrites && expectedRevision === 1) {
        if (!waitingWrite) {
          waitingWrite = new Promise((resolve) => { releaseWaitingWrite = resolve })
          await waitingWrite
        } else {
          releaseWaitingWrite?.()
        }
      }
      if (unrelatedWorkflowConflict && !injectedUnrelatedConflict) {
        injectedUnrelatedConflict = true
        project = {
          ...project,
          document: { ...project.document, name: '另一项并发修改' },
          revision: project.revision + 1,
        }
        throw Object.assign(new Error('project changed'), { code: 'PROJECT_CONFLICT' })
      }
      if (expectedRevision !== project.revision) {
        throw Object.assign(new Error('project changed'), { code: 'PROJECT_CONFLICT' })
      }
      project = { document, revision: project.revision + 1, graphRevision: 1 }
      await afterWriteProject?.()
      return project
    },
    async readGenerationJob(_userId, id) { return jobs.get(id) },
    async putGenerationJob(userId, job) {
      if (putGenerationJobImpl) return putGenerationJobImpl(userId, job, jobs)
      jobs.set(job.id, job)
      await afterPutGenerationJob?.({ job, run: activeRun, turn })
      return job
    },
    async compareAndSetGenerationJob(_userId, command) {
      const current = jobs.get(command.id)
      const generation = current?.execution ? Number(current.execution.generation) : null
      if (!current || current.status !== command.expectedStatus || generation !== command.expectedExecutionGeneration) {
        return { kind: 'stale', changed: false, job: structuredClone(current) }
      }
      jobs.set(command.id, structuredClone(command.job))
      return { kind: 'updated', changed: true, job: structuredClone(command.job) }
    },
    async cancelGenerationJobExecution(_userId, command) {
      const current = jobs.get(command.id)
      if (!current || !['queued', 'running'].includes(current.status)) {
        return { kind: 'replay', changed: false, job: structuredClone(current) }
      }
      const outcome = command.outcomes[current.status]
      const cancelled = {
        ...current, status: 'cancelled', error: undefined,
        cancel: { requestedAt: command.requestedAt, reason: command.reason, ...outcome },
      }
      jobs.set(command.id, cancelled)
      return { kind: 'cancelled', changed: true, job: structuredClone(cancelled) }
    },
  }
  const service = createAgentRunGenerationService({
    config: { modelOptions: models, models: ['gpt-image-2'], maximumBatchCount: 8, maximumReferenceBytes: 8 * 1024 * 1024, security: { generationOutputsPerDay: 10 }, generationBudgets },
    productStore,
    securityControls: {
      async consume(input) {
        quotaCosts.push(input.cost)
        if (consumeError) throw consumeError
        return { allowed: true }
      },
      async reserveMany(input) {
        quotaReservations.push(structuredClone(input))
        const overridden = await reserveManyImpl?.(input, quotaReservations.length)
        if (overridden) return overridden
        const cost = input.entries?.find((entry) => entry.scope === 'generation-output')?.cost ?? 0
        const reused = chargedReservations.has(input.reservationId)
        if (!reused) {
          chargedReservations.add(input.reservationId)
          chargedOutputCount += cost
        }
        if (consumeError) throw consumeError
        return { allowed: true, reused, remaining: 10 - chargedOutputCount, reservedAt: Date.now() }
      },
      async releaseMany(input) {
        releasedReservations.push(structuredClone(input))
        const cost = input.entries?.find((entry) => entry.scope === 'generation-output')?.cost ?? 0
        if (chargedReservations.delete(input.reservationId)) chargedOutputCount -= cost
        return { released: true }
      },
    },
    async enqueue(jobId) { queued.push(jobId); await enqueueImpl?.(jobId, jobs) },
    async publishProjectUpdated() {},
    async publishAgentRunUpdated() {},
    mediaService: {
      enabled: true,
      async readGenerationInput(_userId, mediaId) {
        return { mimeType: 'image/png', buffer: Buffer.from(mediaId) }
      },
    },
  })
  return {
    service,
    jobs,
    queued,
    quotaCosts,
    quotaReservations,
    releasedReservations,
    chargedOutputCount: () => chargedOutputCount,
    readRun: () => activeRun,
  }
}

function twoBranchFixture() {
  const document = projectDocument()
  document.assets.push({ id: 'asset-studio', name: '影棚', role: '场景', image: '/api/media/media_studio', source: 'upload', tags: [] })
  document.assetGroups[0].assetIds.push('asset-studio')
  const run = persistentRun()
  run.plan.output.count = 2
  run.branches.push({ id: 'branch-b', label: '影棚', assetId: 'asset-studio', status: 'queued', attempt: 0, jobIds: [], outputCount: 0, updatedAt: 1 })
  return { document, run }
}

test('Agent Run 提交按新输出计费并让同一任务重试复用既有 Job', async () => {
  const { service, jobs, queued, quotaCosts, quotaReservations } = harness()

  const first = await service.submitGeneration('user-1', 'project-1', 'agent-run-1')
  const second = await service.submitGeneration('user-1', 'project-1', 'agent-run-1')

  assert.equal(first.jobs.length, 1)
  assert.equal(first.jobs[0].referenceBindings[0].assetId, 'asset-scene')
  assert.equal(first.jobs[0].referenceBindings[0].mediaSha256.length, 64)
  assert.deepEqual(first.jobs[0].rawInput.recipe.referenceBindings, first.jobs[0].referenceBindings)
  assert.equal(second.jobs[0].id, first.jobs[0].id)
  assert.equal(jobs.size, 1)
  assert.deepEqual(queued, [first.jobs[0].id])
  assert.deepEqual(quotaCosts, [])
  assert.deepEqual(quotaReservations.map((reservation) => reservation.entries[0].cost), [1])
})

test('Run 提交前重新校验 TargetBinding，目标变化时不写 Job 或入队', async () => {
  const document = projectDocument()
  document.nodes[0].data.image = 'data:image/png;base64,AQ=='
  const run = persistentRun()
  run.plan.targetBinding = await createAgentTargetBinding(document, {
    hasTarget: true, selectedResultNodeId: 'result-parent',
  }, { projectRevision: 1 })
  document.nodes[0].data.image = 'data:image/png;base64,Ag=='
  const { service, jobs, queued } = harness({ run, document })

  await assert.rejects(
    () => service.submitGeneration('user-1', 'project-1', run.id),
    (caught) => caught?.code === 'AGENT_TARGET_STALE',
  )
  assert.equal(jobs.size, 0)
  assert.deepEqual(queued, [])
})

test('首次生成通过原有提交服务幂等入队并按 N 输出计费', async () => {
  const document = projectDocument()
  document.nodes.push({
    id: 'asset-product-node', type: 'asset', position: { x: 20, y: 40 },
    data: { kind: 'asset', assetId: 'asset-product', name: '球衣', image: '/api/media/media_product', role: '商品', source: 'upload', mediaKind: 'image' },
  })
  const run = persistentRun()
  run.id = 'agent-run-initial'
  run.plan = {
    intent: 'initial_generation', instruction: '生成首图', summary: '生成两张首图', prompt: '生成棚拍球衣首图。', settings,
    contextSnapshot: [{ nodeId: 'asset-product-node', label: '球衣', kind: '素材', mediaKind: 'image', role: '商品' }],
    constraints: [{ dimension: 'style', mode: 'vary' }],
    output: { mode: 'single', count: 2, candidatesPerItem: 1 },
  }
  run.branches = [{ id: 'branch-initial', label: '商品首图', status: 'queued', attempt: 0, jobIds: [], outputCount: 0, updatedAt: 1 }]
  const { service, jobs, queued, quotaCosts, quotaReservations } = harness({ run, document })

  const first = await service.submitGeneration('user-1', 'project-1', 'agent-run-initial')
  const second = await service.submitGeneration('user-1', 'project-1', 'agent-run-initial')

  assert.equal(first.jobs[0].batchCount, 2)
  assert.equal(jobs.size, 1)
  assert.deepEqual(queued, [first.jobs[0].id])
  assert.deepEqual(quotaCosts, [])
  assert.deepEqual(quotaReservations.map((reservation) => reservation.entries[0].cost), [2])
  assert.equal(second.jobs[0].id, first.jobs[0].id)
})

test('Run 配额预留后进程崩溃，恢复提交复用稳定 Run reservation 且只扣一次', async () => {
  let crashed = false
  const { service, jobs, quotaReservations, releasedReservations, chargedOutputCount } = harness({
    afterWriteProject: async () => {
      if (crashed) return
      crashed = true
      throw new Error('simulated crash after quota reservation')
    },
  })

  await assert.rejects(
    service.submitGeneration('user-1', 'project-1', 'agent-run-1'),
    /simulated crash/u,
  )
  const recovered = await service.submitGeneration('user-1', 'project-1', 'agent-run-1')

  assert.equal(recovered.jobs.length, 1)
  assert.equal(jobs.size, 1)
  assert.equal(quotaReservations.length, 2)
  assert.equal(quotaReservations[0].reservationId, quotaReservations[1].reservationId)
  assert.match(quotaReservations[0].reservationId, /agent-run-1/u)
  assert.equal(chargedOutputCount(), 1)
  assert.deepEqual(releasedReservations, [])
})

test('第二分支预算明确拒绝时释放本次新取得的输出与预算预留', async () => {
  const { document, run } = twoBranchFixture()
  let budgetAttempts = 0
  const { service, releasedReservations, jobs, queued } = harness({
    document,
    run,
    generationBudgets: { workspace: 100 },
    reserveManyImpl: async (input) => {
      if (!input.entries.some((entry) => entry.scope === 'workspace-budget')) return undefined
      budgetAttempts += 1
      return budgetAttempts === 2
        ? { allowed: false, reused: false, remaining: 0, reservedAt: Date.now() }
        : undefined
    },
  })

  await assert.rejects(
    service.submitGeneration('user-1', 'project-1', run.id),
    (caught) => caught?.code === 'GENERATION_BUDGET_EXCEEDED' && caught?.statusCode === 402,
  )
  assert.equal(jobs.size, 0)
  assert.deepEqual(queued, [])
  const releasedIds = releasedReservations.map((item) => item.reservationId)
  assert.equal(releasedIds.length, 2)
  assert.ok(releasedIds.includes('agent-run-generation-output:user-1:project-1:agent-run-1'))
  assert.ok(releasedIds.some((id) => id.startsWith('job_')))
})

test('Job 写入响应未知属于模糊失败，保留稳定预留供同 key 恢复', async () => {
  const { service, releasedReservations } = harness({
    generationBudgets: { workspace: 100 },
    putGenerationJobImpl: async (_userId, job, jobs) => {
      jobs.set(job.id, job)
      throw new Error('job put response lost')
    },
  })

  await assert.rejects(
    service.submitGeneration('user-1', 'project-1', 'agent-run-1'),
    /job put response lost/u,
  )
  assert.deepEqual(releasedReservations, [])
})

test('HTTP 与 sweep 并发提交同一 Run 时，工作流冲突按确定性身份幂等收敛', async () => {
  const { service, jobs, readRun } = harness({ concurrentWorkflowWrites: true })

  const outcomes = await Promise.allSettled([
    service.submitGeneration('user-1', 'project-1', 'agent-run-1'),
    service.submitGeneration('user-1', 'project-1', 'agent-run-1'),
  ])

  assert.deepEqual(outcomes.map((outcome) => outcome.status), ['fulfilled', 'fulfilled'])
  assert.equal(jobs.size, 1)
  assert.equal([...jobs.values()][0].status, 'queued')
  assert.notEqual(readRun().status, 'failed')
})

test('非同源画布冲突仍拒绝提交并收口空 Run', async () => {
  const { service, jobs, releasedReservations, readRun } = harness({ unrelatedWorkflowConflict: true })

  await assert.rejects(
    service.submitGeneration('user-1', 'project-1', 'agent-run-1'),
    (caught) => caught?.code === 'PROJECT_CONFLICT' && caught?.statusCode === 409,
  )

  assert.equal(jobs.size, 0)
  assert.equal(readRun().status, 'failed')
  assert.deepEqual(releasedReservations.map((item) => item.reservationId), [
    'agent-run-generation-output:user-1:project-1:agent-run-1',
  ])
})

test('确定性校验失败会收口空 queued Run，避免恢复器无限重打', async () => {
  const document = projectDocument()
  document.nodes = []
  const { service, readRun, jobs, queued } = harness({ document })

  await assert.rejects(
    service.submitGeneration('user-1', 'project-1', 'agent-run-1'),
    (error) => error?.code === 'AGENT_PARENT_NOT_FOUND',
  )

  assert.equal(readRun().status, 'failed')
  assert.equal(readRun().branches[0].status, 'failed')
  assert.match(readRun().branches[0].error, /父结果节点已不存在/)
  assert.equal(jobs.size, 0)
  assert.deepEqual(queued, [])
})

test('未知服务错误保留空 queued Run，供后续幂等确认', async () => {
  const transientError = new Error('临时网络中断')
  const { service, readRun } = harness({ consumeError: transientError })

  await assert.rejects(
    service.submitGeneration('user-1', 'project-1', 'agent-run-1'),
    transientError,
  )
  assert.equal(readRun().status, 'queued')
  assert.equal(readRun().branches[0].status, 'queued')
})

test('linked Turn 在首个 Job 持久化前进入 cancelling 时，delegation fence 禁止创建 Job', async () => {
  const run = { ...persistentRun(), turnId: 'turn-cancelled-before-job' }
  const turn = {
    id: run.turnId, ownerId: 'user-1', projectId: 'project-1', status: 'completed',
  }
  const { service, jobs, queued } = harness({
    run,
    turn,
    // 模拟工作流落画布后、首个 durable Job 前，另一个实例写入取消 fence。
    afterWriteProject: async () => { turn.status = 'cancelling' },
  })

  await assert.rejects(
    service.submitGeneration('user-1', 'project-1', run.id),
    (caught) => caught?.code === 'AGENT_TURN_DELEGATION_CANCELLED' && caught?.statusCode === 409,
  )
  assert.equal(jobs.size, 0)
  assert.deepEqual(queued, [])
})

test('Job 落库后 Turn 才取消时，提交层 durable 收口 Job 且绝不 enqueue', async () => {
  const run = { ...persistentRun(), turnId: 'turn-cancelled-after-job-put' }
  const turn = {
    id: run.turnId, ownerId: 'user-1', projectId: 'project-1', status: 'completed',
  }
  const { service, jobs, queued } = harness({
    run,
    turn,
    afterPutGenerationJob: async ({ job }) => {
      if (job.status === 'queued') turn.status = 'cancelling'
    },
  })

  await assert.rejects(
    service.submitGeneration('user-1', 'project-1', run.id),
    (caught) => caught?.code === 'AGENT_TURN_DELEGATION_CANCELLED' && caught?.statusCode === 409,
  )
  assert.equal(jobs.size, 1)
  assert.equal([...jobs.values()][0].status, 'cancelled')
  assert.equal([...jobs.values()][0].cancel.reason, 'agent-run')
  assert.deepEqual(queued, [])
})

test('Job 落库后 Run 才取消时，提交层 durable 收口 Job 且绝不 enqueue', async () => {
  const run = { ...persistentRun(), turnId: 'turn-run-cancelled-after-job-put' }
  const turn = {
    id: run.turnId, ownerId: 'user-1', projectId: 'project-1', status: 'completed',
  }
  const { service, jobs, queued } = harness({
    run,
    turn,
    afterPutGenerationJob: async ({ job, run: storedRun }) => {
      if (job.status === 'queued') storedRun.status = 'cancelled'
    },
  })

  await assert.rejects(
    service.submitGeneration('user-1', 'project-1', run.id),
    (caught) => caught?.code === 'AGENT_RUN_DELEGATION_CANCELLED' && caught?.statusCode === 409,
  )
  assert.equal(jobs.size, 1)
  assert.equal([...jobs.values()][0].status, 'cancelled')
  assert.deepEqual(queued, [])
})

test('Agent Run enqueue 响应丢失但 Job 已 claim 时不以 stale failed 覆盖执行者', async () => {
  const { service, jobs } = harness({
    enqueueImpl: async (jobId, storedJobs) => {
      const queued = storedJobs.get(jobId)
      storedJobs.set(jobId, {
        ...queued, status: 'running',
        execution: { generation: 1, leaseToken: 'lease-worker' },
      })
      throw new Error('Redis response lost')
    },
  })

  const result = await service.submitGeneration('user-1', 'project-1', 'agent-run-1')

  assert.equal(result.jobs.length, 1)
  assert.equal(jobs.get(result.jobs[0].id).status, 'running')
  assert.equal(jobs.get(result.jobs[0].id).execution.leaseToken, 'lease-worker')
})

test('Agent Run guarded put 返回并发 running 时不再重复 enqueue 或终结 Worker', async () => {
  const { service, jobs, queued } = harness({
    putGenerationJobImpl: async (_userId, job, storedJobs) => {
      const running = {
        ...structuredClone(job), status: 'running', executionVersion: 1,
        execution: { generation: 1, leaseToken: 'lease-concurrent-agent-run' },
      }
      storedJobs.set(job.id, running)
      return structuredClone(running)
    },
    enqueueImpl: async () => { throw new Error('重复 enqueue 不应发生') },
  })

  const result = await service.submitGeneration('user-1', 'project-1', 'agent-run-1')

  assert.equal(result.jobs.length, 1)
  assert.equal(result.jobs[0].status, 'running')
  assert.equal(jobs.get(result.jobs[0].id).execution.leaseToken, 'lease-concurrent-agent-run')
  assert.deepEqual(queued, [])
})
