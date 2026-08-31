import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { applyGenerationJobToAgentRun, createPersistentAgentRun } from './botanicAgentRun.mjs'
import { createGenerationProcessor as createRuntimeGenerationProcessor, shouldReportGenerationWorkerFailure } from './generationProcessor.mjs'
import { GenerationError } from './generationProvider.mjs'
import { createLocalCancelRegistry } from './localCancelRegistry.mjs'
import { createProductStore } from './productStore.mjs'
import { createAgentReferenceBindings } from './agentTargetBinding.mjs'

/** 旧测试夹具只实现 read/put；在测试边界补齐与真实 Adapter 同形的原子 seam。 */
function createGenerationProcessor(input) {
  const source = input.productStore
  if (typeof source.claimGenerationJobExecution === 'function') return createRuntimeGenerationProcessor(input)
  let lock = Promise.resolve()
  const serialized = (operation) => {
    const result = lock.then(operation)
    lock = result.catch(() => undefined)
    return result
  }
  const productStore = {
    ...source,
    claimGenerationJobExecution(jobId, claim) {
      return serialized(async () => {
        const current = await source.readGenerationJobForWorker(jobId)
        if (!current) return { kind: 'missing', changed: false }
        if (current.status !== 'queued') return { kind: 'in_progress', changed: false, job: structuredClone(current) }
        const job = {
          ...current, status: 'running',
          executionVersion: (Number(current.executionVersion) || 0) + 1,
          execution: {
            generation: (Number(current.executionVersion) || 0) + 1,
            leaseToken: claim.leaseToken,
            leaseDurationMs: claim.leaseDurationMs,
            leaseExpiresAt: Date.now() + claim.leaseDurationMs,
          },
        }
        await source.putGenerationJob(job.ownerId, job)
        return { kind: 'claimed', changed: true, job: structuredClone(job) }
      })
    },
    commitGenerationJobExecution(ownerId, command) {
      return serialized(async () => {
        const current = await source.readGenerationJobForWorker(command.id)
        const sameLease = current?.execution?.leaseToken === command.leaseToken
          && Number(current?.execution?.generation) === Number(command.executionGeneration)
        if (!sameLease || current.status === 'cancelled') return { kind: 'stale', changed: false, job: structuredClone(current) }
        if (['succeeded', 'failed'].includes(current.status) && current.status !== command.status) {
          return { kind: 'stale', changed: false, job: structuredClone(current) }
        }
        const job = {
          ...(command.job ? structuredClone(command.job) : current),
          status: command.status,
          executionVersion: Number(current.execution.generation),
          execution: {
            ...current.execution,
            ...(command.status === 'running'
              ? { leaseExpiresAt: Date.now() + current.execution.leaseDurationMs, lastHeartbeatAt: Date.now() }
              : { settledAt: Date.now() }),
          },
        }
        await source.putGenerationJob(ownerId, job, {
          updateAgentRun: command.updateAgentRun,
          recordAudit: command.recordAudit,
        })
        const stored = await source.readGenerationJobForWorker(command.id) ?? job
        return { kind: 'committed', changed: true, job: structuredClone(stored) }
      })
    },
    compareAndSetGenerationJob(ownerId, command) {
      return serialized(async () => {
        const current = await source.readGenerationJobForWorker(command.id)
        const currentGeneration = current?.execution ? Number(current.execution.generation) : null
        if (!current || current.status !== command.expectedStatus
          || currentGeneration !== command.expectedExecutionGeneration) {
          return { kind: 'stale', changed: false, job: structuredClone(current) }
        }
        const job = {
          ...structuredClone(command.job),
          ...(current.execution ? { execution: structuredClone(current.execution) } : {}),
        }
        await source.putGenerationJob(ownerId, job, {
          updateAgentRun: command.updateAgentRun,
          recordAudit: command.recordAudit,
        })
        return { kind: 'updated', changed: true, job: structuredClone(job) }
      })
    },
    cancelGenerationJobExecution(ownerId, command) {
      return serialized(async () => {
        const current = await source.readGenerationJobForWorker(command.id)
        if (!current || !['queued', 'running'].includes(current.status)) {
          return { kind: 'replay', changed: false, job: structuredClone(current) }
        }
        const outcome = command.outcomes[current.status]
        const job = {
          ...current, status: 'cancelled', error: undefined,
          cancel: {
            requestedAt: command.requestedAt, reason: command.reason,
            ...(command.requestedBy ? { requestedBy: command.requestedBy } : {}), ...outcome,
          },
        }
        await source.putGenerationJob(ownerId, job)
        return { kind: 'cancelled', changed: true, job: structuredClone(job) }
      })
    },
  }
  return createRuntimeGenerationProcessor({ ...input, productStore })
}

test('Flock 高内存许可在输入媒体物化前取得，并在任务结束后释放', async () => {
  const events = []
  let storedJob = {
    id: 'job-flock-admission', ownerId: 'user-a', projectId: 'project-a', status: 'queued', kind: 'generation',
    createdAt: Date.now(), updatedAt: Date.now(), batchCount: 1,
    settings: { model: 'nano', aspectRatio: '1:1', resolution: '1K' }, outputs: [],
    rawInput: {
      projectId: 'project-a', kind: 'generation', prompt: '生成品牌首图', batchCount: 1,
      settings: { model: 'nano', aspectRatio: '1:1', resolution: '1K' },
      recipe: { references: [{ name: '商品', role: '商品', primary: true, mediaId: 'media_ref' }] },
    },
  }
  const processJob = createGenerationProcessor({
    productStore: {
      async readGenerationJobForWorker() { return structuredClone(storedJob) },
      async putGenerationJob(_ownerId, job) { storedJob = structuredClone(job) },
      async readProject() { return undefined },
      async refreshGenerationArtifacts() { return true },
    },
    mediaService: {
      async readGenerationInput() {
        events.push('read-media')
        return { mimeType: 'image/png', buffer: Buffer.from('not-a-real-png') }
      },
    },
    config: {
      modelOptions: [{
        id: 'nano', provider: 'flock', mediaKind: 'image',
        aspectRatios: ['1:1'], resolutions: ['1K'], maximumReferences: 14,
      }],
      maximumBatchCount: 4,
      maximumReferenceBytes: 1024,
    },
    acquireProviderAdmission: async ({ providers }) => {
      assert.deepEqual(providers, ['flock'])
      events.push('admission')
      return () => events.push('release')
    },
    generate: async () => {
      events.push('generate')
      return { outputs: [{ id: 'output-a', image: '/api/media/output-a' }], missingOutputCount: 0 }
    },
  })

  await processJob(storedJob.id)

  assert.equal(storedJob.status, 'succeeded')
  assert.deepEqual(events, ['admission', 'read-media', 'generate', 'release'])
})

test('Agent 二级参考图同 ID 换字节后在 Provider 前 fail closed', async () => {
  let providerCalls = 0
  const reference = { name: '商品', role: '商品', primary: true, mediaId: 'media_ref' }
  const referenceBindings = await createAgentReferenceBindings([
    { ...reference, buffer: Buffer.from('confirmed-v1') },
  ])
  let storedJob = {
    id: 'job-reference-drift', ownerId: 'user-a', projectId: 'project-a', status: 'queued', kind: 'generation',
    createdAt: Date.now(), updatedAt: Date.now(), batchCount: 1,
    settings: { model: 'openai', aspectRatio: '1:1', resolution: '1K' }, outputs: [],
    agentRun: { runId: 'run-a', branchId: 'branch-a', attempt: 0 },
    referenceBindings,
    rawInput: {
      projectId: 'project-a', kind: 'generation', prompt: '生成商品图', batchCount: 1,
      settings: { model: 'openai', aspectRatio: '1:1', resolution: '1K' },
      recipe: { references: [reference], referenceBindings },
    },
  }
  const processJob = createGenerationProcessor({
    productStore: {
      async readGenerationJobForWorker() { return structuredClone(storedJob) },
      async readAgentRunForWorker() {
        return {
          id: 'run-a', ownerId: 'user-a', projectId: 'project-a', status: 'queued',
          branches: [{ id: 'branch-a', activeJobId: storedJob.id, attempt: 0 }],
        }
      },
      async putGenerationJob(_ownerId, job) { storedJob = structuredClone(job) },
      async readProject() { return undefined },
      async refreshGenerationArtifacts() { return true },
    },
    mediaService: {
      async readGenerationInput() {
        return { mimeType: 'image/png', buffer: Buffer.from('changed-v2') }
      },
    },
    config: {
      modelOptions: [{
        id: 'openai', provider: 'openai', mediaKind: 'image',
        aspectRatios: ['1:1'], resolutions: ['1K'], maximumReferences: 8,
      }],
      maximumBatchCount: 4,
      maximumReferenceBytes: 1024,
    },
    generate: async () => { providerCalls += 1; return { outputs: [] } },
  })

  await processJob(storedJob.id)

  assert.equal(providerCalls, 0)
  assert.equal(storedJob.status, 'failed')
  assert.equal(storedJob.errorCode, 'AGENT_PLAN_REFERENCE_DRIFT')
})

test('跨 Provider fallback 只在真正进入 Flock 前重新物化，并持有许可到任务结束', async () => {
  const runScenario = async ({ primary, fallback, failureCode = 'PROVIDER_UNAVAILABLE' }) => {
    const events = []
    let storedJob = {
      id: `job-${primary}-to-${fallback}`, ownerId: 'user-a', projectId: 'project-a', status: 'queued', kind: 'generation',
      createdAt: Date.now(), updatedAt: Date.now(), batchCount: 1,
      settings: { model: primary, aspectRatio: '1:1', resolution: '1K' }, outputs: [],
      rawInput: {
        projectId: 'project-a', kind: 'generation', prompt: '生成品牌首图', batchCount: 1,
        settings: { model: primary, aspectRatio: '1:1', resolution: '1K' },
        recipe: { references: [{ name: '商品', role: '商品', primary: true, mediaId: 'media_ref' }] },
      },
    }
    const processJob = createGenerationProcessor({
      productStore: {
        async readGenerationJobForWorker() { return structuredClone(storedJob) },
        async putGenerationJob(_ownerId, job) { storedJob = structuredClone(job) },
        async readProject() { return undefined },
        async refreshGenerationArtifacts() { return true },
      },
      mediaService: {
        async readGenerationInput() {
          events.push(`read:${events.filter((event) => event.startsWith('read:')).length + 1}`)
          return { mimeType: 'image/png', buffer: Buffer.from('image') }
        },
      },
      config: {
        modelOptions: [
          { id: 'openai', provider: 'openai', mediaKind: 'image', aspectRatios: ['1:1'], resolutions: ['1K'], maximumReferences: 8 },
          { id: 'flock', provider: 'flock', mediaKind: 'image', aspectRatios: ['1:1'], resolutions: ['1K'], maximumReferences: 14 },
        ],
        providerFallbackModelIds: [fallback],
        maximumBatchCount: 4,
        maximumReferenceBytes: 1024,
      },
      acquireProviderAdmission: async ({ providers }) => {
        events.push(`admission:${providers[0]}`)
        return () => events.push('release')
      },
      generate: async (input) => {
        events.push(`generate:${input.settings.model}`)
        if (input.settings.model === primary) {
          throw new GenerationError(502, failureCode, '主 Provider 暂不可用。')
        }
        return { outputs: [{ id: 'output-a', image: '/api/media/output-a' }], missingOutputCount: 0 }
      },
    })
    await processJob(storedJob.id)
    assert.equal(storedJob.status, 'succeeded')
    return events
  }

  assert.deepEqual(await runScenario({ primary: 'openai', fallback: 'flock' }), [
    'read:1', 'generate:openai', 'admission:flock', 'read:2', 'generate:flock', 'release',
  ])
  assert.deepEqual(await runScenario({ primary: 'flock', fallback: 'openai', failureCode: 'EMPTY_PROVIDER_RESPONSE' }), [
    'admission:flock', 'read:1', 'generate:flock', 'generate:openai', 'release',
  ])
})

test('语义兼容备用 Provider 成功后按实际模型与 Provider 归因且不复制任务', async () => {
  let storedJob = {
    id: 'job-provider-fallback', ownerId: 'user-a', projectId: 'project-a', status: 'queued', kind: 'generation',
    createdAt: Date.now(), updatedAt: Date.now(), batchCount: 1,
    settings: { model: 'primary-image', aspectRatio: '1:1', resolution: '1K' },
    usage: { workspaceId: 'workspace-a', projectId: 'project-a', memberId: 'user-a', model: 'primary-image', provider: 'primary', units: 1 },
    outputs: [],
    rawInput: {
      projectId: 'project-a', kind: 'generation', prompt: '生成品牌首图', batchCount: 1,
      settings: { model: 'primary-image', aspectRatio: '1:1', resolution: '1K' },
      recipe: { references: [{ name: '商品', role: '商品', primary: true, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }] },
    },
  }
  const writtenJobIds = []
  const productStore = {
    async readGenerationJobForWorker() { return structuredClone(storedJob) },
    async putGenerationJob(_ownerId, job) { storedJob = structuredClone(job); writtenJobIds.push(job.id) },
    async readProject() { return undefined },
    async refreshGenerationArtifacts() {},
  }
  const providerCircuitBreaker = {
    async canRequest() { return { allowed: false, state: 'open' } },
    async recordSuccess() {},
    async recordFailure() {},
  }
  const processJob = createGenerationProcessor({
    productStore,
    mediaService: { async readGenerationInput() { throw new Error('不应读取媒体标识') } },
    providerCircuitBreaker,
    config: {
      modelOptions: [
        { id: 'primary-image', provider: 'primary', mediaKind: 'image', aspectRatios: ['1:1'], resolutions: ['1K'], inputRoles: [] },
        { id: 'fallback-image', provider: 'backup', mediaKind: 'image', aspectRatios: ['1:1'], resolutions: ['1K'], inputRoles: [] },
      ],
      providerFallbackModelIds: ['fallback-image'],
      maximumBatchCount: 4,
      maximumReferenceBytes: 1024,
    },
    generate: async (input) => {
      assert.equal(input.settings.model, 'fallback-image')
      return { outputs: [{ id: 'output-a', image: '/api/media/output-a' }], missingOutputCount: 0 }
    },
  })

  await processJob(storedJob.id)

  assert.equal(storedJob.status, 'succeeded')
  assert.equal(storedJob.effectiveModel, 'fallback-image')
  assert.equal(storedJob.usage.model, 'fallback-image')
  assert.equal(storedJob.usage.provider, 'backup')
  assert.deepEqual([...new Set(writtenJobIds)], ['job-provider-fallback'])
  assert.deepEqual(storedJob.providerAttempts.map(({ provider, model }) => ({ provider, model })), [
    { provider: 'backup', model: 'fallback-image' },
  ])
})

test('没有兼容备用模型时保留 Provider 原始错误码对应的用户消息', async () => {
  let storedJob = {
    id: 'job-provider-timeout', ownerId: 'user-a', projectId: 'project-a', status: 'queued', kind: 'generation',
    createdAt: Date.now(), updatedAt: Date.now(), batchCount: 1,
    settings: { model: 'primary-image', aspectRatio: '1:1', resolution: '1K' },
    outputs: [],
    rawInput: {
      projectId: 'project-a', kind: 'generation', prompt: '生成一张品牌首图', batchCount: 1,
      settings: { model: 'primary-image', aspectRatio: '1:1', resolution: '1K' },
      recipe: { references: [{ name: '商品', role: '商品', primary: true, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }] },
    },
  }
  const productStore = {
    async readGenerationJobForWorker() { return structuredClone(storedJob) },
    async putGenerationJob(_ownerId, job) { storedJob = structuredClone(job) },
    async readProject() { return undefined },
  }
  const providerCircuitBreaker = {
    async canRequest() { return { allowed: true, state: 'closed' } },
    async recordSuccess() {},
    async recordFailure() {},
  }
  const reportedFailures = []
  const processJob = createGenerationProcessor({
    productStore,
    mediaService: {},
    providerCircuitBreaker,
    config: {
      modelOptions: [{ id: 'primary-image', provider: 'primary', mediaKind: 'image', aspectRatios: ['1:1'], resolutions: ['1K'], inputRoles: [] }],
      providerFallbackModelIds: [], maximumBatchCount: 4, maximumReferenceBytes: 1024,
    },
    generate: async () => {
      const error = new GenerationError(504, 'REQUEST_TIMEOUT', '上游请求超时，请稍后重试。')
      error.providerResponseSummary = { type: 'object', candidateCount: 0 }
      throw error
    },
    reportWorkerFailure: (failure, context) => reportedFailures.push({ failure, context }),
  })

  await processJob(storedJob.id)

  assert.equal(storedJob.status, 'failed')
  assert.equal(storedJob.error, '上游请求超时，请稍后重试。')
  assert.deepEqual(storedJob.providerResponseSummary, { type: 'object', candidateCount: 0 })
  assert.doesNotMatch(storedJob.error, /备用模型|规格不兼容/)
  // 业务终态失败不会抛出 BullMQ failed 事件，必须经 reportWorkerFailure 显式上报且可稳定聚合。
  assert.equal(reportedFailures.length, 1)
  assert.equal(reportedFailures[0].failure.code, 'REQUEST_TIMEOUT')
  assert.equal(reportedFailures[0].context.tags.error_code, 'REQUEST_TIMEOUT')
  assert.deepEqual(reportedFailures[0].context.fingerprint, ['generation-worker-terminal-failure', 'REQUEST_TIMEOUT', 'primary-image'])
  assert.doesNotMatch(JSON.stringify(reportedFailures), /生成一张品牌首图/)
})

test('用户侧拒单与模型下线不上报 Worker Sentry', () => {
  assert.equal(shouldReportGenerationWorkerFailure({ code: 'PROVIDER_REJECTED' }), false)
  assert.equal(shouldReportGenerationWorkerFailure({ code: 'PROVIDER_MODEL_UNAVAILABLE' }), false)
  assert.equal(shouldReportGenerationWorkerFailure({ code: 'PROVIDER_RATE_LIMITED' }), false)
  assert.equal(shouldReportGenerationWorkerFailure({ code: 'REQUEST_TIMEOUT' }), true)
  assert.equal(shouldReportGenerationWorkerFailure({ code: 'PROVIDER_AUTH_FAILED' }), true)
})

test('普通生成任务也由服务端把生命周期状态权威回写到项目画布', async () => {
  const observed = []
  const publishedProjectUpdates = []
  let storedJob = {
    id: 'job-direct',
    ownerId: 'user-a',
    projectId: 'project-a',
    status: 'queued',
    kind: 'generation',
    createdAt: 100,
    updatedAt: 100,
    settings: { model: 'gpt-image-2' },
    outputs: [],
    rawInput: { prompt: '不应进入运行日志的私密提示词' },
    agentRun: { runId: 'agent-run-direct', branchId: 'branch-direct', attempt: 0 },
  }
  let document = {
    id: 'project-a',
    nodes: [
      { id: 'generate-a', type: 'generate', data: { jobId: 'job-direct', status: 'queued' } },
      { id: 'result-a', type: 'result', data: { jobId: 'job-direct', taskStatus: 'queued', status: 'generating' } },
    ],
    generationJobs: [{ id: 'job-direct', status: 'queued' }],
  }
  let revision = 1
  const productStore = {
    async readGenerationJobForWorker() { return storedJob },
    async putGenerationJob(_ownerId, job) { storedJob = job },
    async readAgentRunForWorker() {
      return {
        id: 'agent-run-direct', ownerId: 'user-a', projectId: 'project-a', status: 'queued',
        branches: [{ id: 'branch-direct', status: 'queued', attempt: 0, activeJobId: 'job-direct' }],
      }
    },
    async readProject() { return { document, revision, graphRevision: revision } },
    async writeProject(_ownerId, nextDocument) {
      document = nextDocument
      revision += 1
      return { document, revision, graphRevision: revision }
    },
  }
  const processJob = createGenerationProcessor({
    productStore,
    mediaService: {},
    config: { modelOptions: [{ id: 'gpt-image-2', provider: 'openai', mediaKind: 'image' }] },
    observeAgentRun: (event) => observed.push(event),
    publishProjectUpdated: async (event) => publishedProjectUpdates.push(event),
  })

  await processJob('job-direct')

  assert.equal(storedJob.status, 'failed')
  assert.equal(document.nodes[0].data.status, 'failed')
  assert.equal(document.nodes[1].data.taskStatus, 'failed')
  assert.deepEqual(observed.map((event) => event.type), ['worker_started', 'worker_failed'])
  assert.equal(observed[0].runId, 'agent-run-direct')
  assert.equal(observed[1].status, 'failed')
  assert.doesNotMatch(JSON.stringify(observed), /私密提示词/)
  assert.ok(publishedProjectUpdates.length > 0)
  assert.equal(publishedProjectUpdates.every((event) => event.actorId === 'user-a'), true)
})

test('画布版本冲突使用指数退避并重新读取最新版本后回写', async () => {
  let storedJob = {
    id: 'job-conflict-retry', ownerId: 'user-a', projectId: 'project-a', status: 'queued', kind: 'generation',
    createdAt: 100, updatedAt: 100, settings: { model: 'gpt-image-2' }, outputs: [], rawInput: {},
  }
  let document = {
    id: 'project-a',
    nodes: [
      { id: 'generate-a', type: 'generate', data: { jobId: 'job-conflict-retry', status: 'queued' } },
      { id: 'result-a', type: 'result', data: { jobId: 'job-conflict-retry', taskStatus: 'queued', status: 'generating' } },
    ],
    generationJobs: [{ id: 'job-conflict-retry', status: 'queued' }],
  }
  let revision = 1
  let conflictsLeft = 2
  let writeCount = 0
  const delays = []
  const productStore = {
    async readGenerationJobForWorker() { return structuredClone(storedJob) },
    async putGenerationJob(_ownerId, job) { storedJob = structuredClone(job) },
    async readProject() { return { document, revision, graphRevision: revision } },
    async writeProject(_ownerId, nextDocument) {
      if (conflictsLeft > 0) {
        conflictsLeft -= 1
        const error = new Error('版本已更新')
        error.code = 'PROJECT_CONFLICT'
        throw error
      }
      writeCount += 1
      document = nextDocument
      revision += 1
      return { document, revision, graphRevision: revision }
    },
  }
  const processJob = createGenerationProcessor({
    productStore,
    mediaService: {},
    config: { modelOptions: [{ id: 'gpt-image-2', provider: 'openai', mediaKind: 'image' }] },
    sleep: async (ms) => delays.push(ms),
  })

  await processJob(storedJob.id)

  assert.deepEqual(delays, [100, 200])
  assert.equal(writeCount, 2)
  assert.equal(storedJob.status, 'failed')
  assert.equal(storedJob.projectWritebackPending, undefined)
  assert.equal(document.nodes[1].data.taskStatus, 'failed')
})

test('终态任务画布回写失败会持久化标记，并在恢复时只回写不重复调用 Provider', async () => {
  let storedJob = {
    id: 'job-writeback-pending', ownerId: 'user-a', projectId: 'project-a', status: 'queued', kind: 'generation',
    createdAt: 100, updatedAt: 100, settings: { model: 'gpt-image-2' }, outputs: [], rawInput: {},
  }
  let document = {
    id: 'project-a',
    nodes: [
      { id: 'generate-a', type: 'generate', data: { jobId: 'job-writeback-pending', status: 'queued' } },
      { id: 'result-a', type: 'result', data: { jobId: 'job-writeback-pending', taskStatus: 'queued', status: 'generating' } },
    ],
    generationJobs: [{ id: 'job-writeback-pending', status: 'queued' }],
  }
  let writebackAvailable = false
  let writeCount = 0
  const productStore = {
    async readGenerationJobForWorker() { return structuredClone(storedJob) },
    async putGenerationJob(_ownerId, job) { storedJob = structuredClone(job) },
    async readProject() { return { document, revision: 1, graphRevision: 1 } },
    async writeProject(_ownerId, nextDocument) {
      if (!writebackAvailable) {
        const error = new Error('版本已更新')
        error.code = 'CANVAS_GRAPH_CONFLICT'
        throw error
      }
      writeCount += 1
      document = nextDocument
      return { document, revision: 2, graphRevision: 2 }
    },
  }
  const processJob = createGenerationProcessor({
    productStore,
    mediaService: {},
    config: { modelOptions: [{ id: 'gpt-image-2', provider: 'openai', mediaKind: 'image' }] },
    sleep: async () => undefined,
  })

  await processJob(storedJob.id)
  assert.equal(storedJob.status, 'failed')
  assert.equal(storedJob.projectWritebackPending, true)
  assert.ok(storedJob.projectWritebackAttempts >= 1)
  assert.equal(writeCount, 0)

  writebackAvailable = true
  await processJob(storedJob.id)
  assert.equal(storedJob.status, 'failed')
  assert.equal(storedJob.projectWritebackPending, undefined)
  assert.equal(writeCount, 1)
  assert.equal(document.nodes[1].data.taskStatus, 'failed')
})

test('已成功任务延迟回写恢复后重建 Artifact 血缘', async () => {
  const job = {
    id: 'job-recover-artifact', ownerId: 'user-a', projectId: 'project-a', status: 'succeeded',
    createdAt: 100, updatedAt: 200, settings: { model: 'gpt-image-2' },
    outputs: [{ id: 'output-a', image: '/api/media/output-a' }],
    agentRun: { runId: 'run-recover-artifact', branchId: 'branch-a', attempt: 0 },
    projectWritebackPending: true,
  }
  let storedJob = structuredClone(job)
  let refreshedJobId = ''
  let artifactReady = false
  const document = {
    id: 'project-a',
    nodes: [{ id: 'result-a', type: 'result', data: { jobId: job.id, taskStatus: 'queued', status: 'generating' } }],
    generationJobs: [{ id: job.id, status: 'queued' }],
  }
  const productStore = {
    async readGenerationJobForWorker() { return structuredClone(storedJob) },
    async putGenerationJob(_ownerId, nextJob) { storedJob = structuredClone(nextJob) },
    async readProject() { return { document, revision: 1, graphRevision: 1 } },
    async writeProject(_ownerId, nextDocument) { return { document: nextDocument, revision: 2, graphRevision: 2 } },
    async refreshGenerationArtifacts(_ownerId, jobId) {
      refreshedJobId = jobId
      return { status: artifactReady ? 'passed' : 'failed', rejectedCount: artifactReady ? 0 : 1 }
    },
  }
  const processJob = createGenerationProcessor({
    productStore,
    mediaService: {},
    config: { modelOptions: [{ id: 'gpt-image-2', provider: 'openai', mediaKind: 'image' }] },
  })

  await processJob(job.id)

  assert.equal(storedJob.projectWritebackPending, true)
  assert.equal(refreshedJobId, job.id)

  artifactReady = true
  await processJob(job.id)
  assert.equal(storedJob.projectWritebackPending, undefined)
})

test('Worker 先持久化 N 输出再回写画布后，Artifact Index 补齐每个结果节点血缘', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'botanic-generation-artifacts-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const productStore = createProductStore({
    dataPath: join(directory, 'product.json'),
    bootstrapAccessToken: 'owner-token',
  })
  const owner = productStore.authenticate('owner-token')
  assert.ok(owner)
  const projectId = 'project-artifact-writeback'
  const jobId = 'job-artifact-writeback'
  const generateNodeId = 'generate-artifact-writeback'
  const rootResultNodeId = 'result-artifact-writeback-1'
  productStore.writeProject(owner.id, {
    schemaVersion: 25,
    id: projectId,
    name: 'Artifact 回填顺序',
    nodes: [
      { id: generateNodeId, type: 'generate', position: { x: 0, y: 0 }, data: { jobId, status: 'queued' } },
      {
        id: rootResultNodeId,
        type: 'result',
        position: { x: 400, y: 0 },
        data: { jobId, outputOf: generateNodeId, taskGroupId: rootResultNodeId, taskStatus: 'queued', status: 'generating' },
      },
      {
        id: 'result-artifact-writeback-2',
        type: 'result',
        position: { x: 400, y: 370 },
        data: { jobId, outputOf: generateNodeId, taskGroupId: rootResultNodeId, taskStatus: 'queued', status: 'generating' },
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    assets: [],
    templates: [],
    history: [],
    deliveries: [],
    generationJobs: [{ id: jobId, status: 'queued' }],
    updatedAt: Date.now(),
  })

  const createdAt = Date.now()
  productStore.putGenerationJob(owner.id, {
    id: jobId,
    ownerId: owner.id,
    projectId,
    status: 'queued',
    kind: 'generation',
    createdAt,
    updatedAt: createdAt,
    batchCount: 2,
    outputs: [],
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
    rawInput: {
      projectId,
      kind: 'generation',
      prompt: '生成两张候选图。',
      batchCount: 2,
      settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
      recipe: {
        references: [{
          name: '主商品', role: '商品', primary: true,
          dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
        }],
      },
    },
  })

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    async json() { return { data: [{ b64_json: 'iVBORw0KGgo=' }] } },
  })
  t.after(() => { globalThis.fetch = originalFetch })
  let mediaIndex = 0
  const processJob = createGenerationProcessor({
    productStore,
    mediaService: {
      async persistProviderImage() {
        mediaIndex += 1
        return `/api/media/generated-${mediaIndex}`
      },
    },
    config: {
      apiBaseUrl: 'https://provider.test',
      apiKey: 'test-key',
      modelOptions: [{
        id: 'gpt-image-2', provider: 'openai', mediaKind: 'image',
        aspectRatios: ['1:1'], resolutions: ['1K'],
      }],
      maximumBatchCount: 8,
      maximumReferenceBytes: 1024,
    },
  })

  await processJob(jobId)

  const artifacts = productStore.listAgentArtifacts(owner.id, projectId, { limit: 10 })
  const sourcesByOutput = Object.fromEntries(artifacts.map((artifact) => [
    artifact.metadata.outputId,
    artifact.provenance.sourceNodeIds,
  ]))
  assert.deepEqual(sourcesByOutput, {
    [`${jobId}-output-1`]: [rootResultNodeId],
    [`${jobId}-output-2`]: ['result-artifact-writeback-2'],
  })
  assert.equal(
    productStore.listAuditEvents(owner.id, projectId).filter((event) => event.action === 'generation.succeeded').length,
    1,
  )
})

test('成功任务只在画布回写与 Artifact 刷新后推进 Agent Run 终态', async () => {
  const events = []
  const createdAt = Date.now()
  let storedJob = {
    id: 'job-terminal-order', ownerId: 'user-a', projectId: 'project-a', status: 'queued', kind: 'generation',
    createdAt, updatedAt: createdAt, batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
    outputs: [],
    rawInput: {
      projectId: 'project-a', kind: 'generation', prompt: '生成一张结果图', batchCount: 1,
      settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
      recipe: { references: [{ name: '主素材', role: '商品', primary: true, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }] },
    },
    agentRun: { runId: 'run-terminal-order', branchId: 'branch-terminal-order', attempt: 0 },
  }
  let storedRun = createPersistentAgentRun({
    projectId: 'project-a',
    plan: {
      intent: 'initial_generation', instruction: '生成一张结果图', summary: '生成结果', prompt: '生成一张结果图',
      settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' }, constraints: [],
      output: { mode: 'single', count: 1, candidatesPerItem: 1 },
    },
    branches: [{ id: 'branch-terminal-order', label: '主分支' }],
  }, { id: 'run-terminal-order', ownerId: 'user-a', now: createdAt })
  storedRun = applyGenerationJobToAgentRun(storedRun, storedJob)
  const document = {
    id: 'project-a',
    nodes: [
      { id: 'generate-a', type: 'generate', data: { jobId: storedJob.id, status: 'queued' } },
      { id: 'result-a', type: 'result', data: { jobId: storedJob.id, taskStatus: 'queued', status: 'generating' } },
    ],
    generationJobs: [{ id: storedJob.id, status: 'queued' }],
  }
  const productStore = {
    async readGenerationJobForWorker() { return structuredClone(storedJob) },
    async putGenerationJob(_ownerId, job, options = {}) {
      storedJob = structuredClone(job)
      if (options.updateAgentRun !== false && job.agentRun) {
        storedRun = applyGenerationJobToAgentRun(storedRun, job)
        events.push(`run-status:${storedRun.status}`)
        events.push(`run-projection-pending:${Boolean(job.projectWritebackPending)}`)
      }
    },
    async readProject() { return { document, revision: 1, graphRevision: 1 } },
    async writeProject() { events.push('canvas-writeback') },
    async refreshGenerationArtifacts() { events.push('artifact-refresh') },
    async readAgentRunForWorker() { return structuredClone(storedRun) },
  }
  const processJob = createGenerationProcessor({
    productStore,
    mediaService: {},
    config: { modelOptions: [{ id: 'gpt-image-2', provider: 'openai', mediaKind: 'image', aspectRatios: ['1:1'], resolutions: ['1K'] }] },
    publishAgentRunUpdated: ({ run }) => events.push(`published:${run.status}`),
    generate: async () => ({ outputs: [{ id: 'output-a', image: '/api/media/output-a' }], missingOutputCount: 0 }),
  })

  await processJob(storedJob.id)

  const terminalIndex = events.indexOf('run-status:completed')
  assert.ok(terminalIndex > events.lastIndexOf('canvas-writeback'))
  assert.ok(terminalIndex > events.lastIndexOf('artifact-refresh'))
  assert.equal(events[terminalIndex + 1], 'run-projection-pending:true')
  assert.equal(storedJob.projectWritebackPending, undefined)
})

test('终态 Job 已 durable 但 Run 投影失败时保留 succeeded pending，恢复不重跑 Provider', async () => {
  const createdAt = Date.now()
  let generated = 0
  let failTerminalRunProjection = true
  let storedJob = {
    id: 'job-run-projection-recovery', ownerId: 'user-a', projectId: 'project-a', status: 'queued', kind: 'generation',
    createdAt, updatedAt: createdAt, batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' }, outputs: [],
    rawInput: {
      projectId: 'project-a', kind: 'generation', prompt: '生成一张结果图', batchCount: 1,
      settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' }, recipe: { references: [] },
    },
    agentRun: { runId: 'run-projection-recovery', branchId: 'branch-a', attempt: 0 },
  }
  let storedRun = createPersistentAgentRun({
    projectId: 'project-a',
    plan: {
      intent: 'initial_generation', instruction: '生成一张结果图', summary: '生成结果', prompt: '生成一张结果图',
      settings: storedJob.settings, constraints: [], output: { mode: 'single', count: 1, candidatesPerItem: 1 },
    },
    branches: [{ id: 'branch-a', label: '主分支' }],
  }, { id: 'run-projection-recovery', ownerId: 'user-a', now: createdAt })
  storedRun = applyGenerationJobToAgentRun(storedRun, storedJob)
  const productStore = {
    async readGenerationJobForWorker() { return structuredClone(storedJob) },
    async putGenerationJob(_ownerId, job, options = {}) {
      storedJob = structuredClone(job)
      if (options.updateAgentRun !== false && job.agentRun) {
        if (job.status === 'succeeded' && failTerminalRunProjection) {
          failTerminalRunProjection = false
          throw new Error('Agent Run 数据库暂不可用')
        }
        storedRun = applyGenerationJobToAgentRun(storedRun, job)
      }
    },
    async readProject() { return undefined },
    async refreshGenerationArtifacts() { return true },
    async readAgentRunForWorker() { return structuredClone(storedRun) },
  }
  const processJob = createGenerationProcessor({
    productStore,
    mediaService: {},
    config: { modelOptions: [{ id: 'gpt-image-2', provider: 'openai', mediaKind: 'image', aspectRatios: ['1:1'], resolutions: ['1K'] }] },
    generate: async () => {
      generated += 1
      return { outputs: [{ id: 'output-a', image: '/api/media/output-a' }], missingOutputCount: 0 }
    },
  })

  await processJob(storedJob.id)

  assert.equal(storedJob.status, 'succeeded')
  assert.equal(storedJob.projectWritebackPending, true)
  assert.notEqual(storedRun.status, 'completed')

  await processJob(storedJob.id)

  assert.equal(generated, 1)
  assert.equal(storedJob.status, 'succeeded')
  assert.equal(storedJob.projectWritebackPending, undefined)
  assert.equal(storedRun.status, 'completed')
})

test('失败任务有部分输出时，Artifact 未完成不得清恢复标记或推进 Run', async () => {
  const createdAt = Date.now()
  let storedJob = {
    id: 'job-failed-partial-artifact', ownerId: 'user-a', projectId: 'project-a', status: 'queued', kind: 'generation',
    createdAt, updatedAt: createdAt, batchCount: 2,
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
    outputs: [],
    rawInput: {
      projectId: 'project-a', kind: 'generation', prompt: '生成两张结果图', batchCount: 2,
      settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
      recipe: { references: [{ name: '主素材', role: '商品', primary: true, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }] },
    },
    agentRun: { runId: 'run-failed-partial-artifact', branchId: 'branch-a', attempt: 0 },
  }
  let storedRun = createPersistentAgentRun({
    projectId: 'project-a',
    plan: {
      intent: 'initial_generation', instruction: '生成两张结果图', summary: '生成结果', prompt: '生成两张结果图',
      settings: storedJob.settings, constraints: [], output: { mode: 'single', count: 1, candidatesPerItem: 2 },
    },
    branches: [{ id: 'branch-a', label: '主分支' }],
  }, { id: 'run-failed-partial-artifact', ownerId: 'user-a', now: createdAt })
  storedRun = applyGenerationJobToAgentRun(storedRun, storedJob)
  let refreshCount = 0
  let artifactReady = false
  let generated = 0
  const productStore = {
    async readGenerationJobForWorker() { return structuredClone(storedJob) },
    async putGenerationJob(_ownerId, job, options = {}) {
      storedJob = structuredClone(job)
      if (options.updateAgentRun !== false && job.agentRun) {
        storedRun = applyGenerationJobToAgentRun(storedRun, job)
      }
    },
    async readProject() { return undefined },
    async refreshGenerationArtifacts() { refreshCount += 1; return artifactReady },
    async readAgentRunForWorker() { return structuredClone(storedRun) },
  }
  const processJob = createGenerationProcessor({
    productStore,
    mediaService: {},
    config: { modelOptions: [{ id: 'gpt-image-2', provider: 'openai', mediaKind: 'image', aspectRatios: ['1:1'], resolutions: ['1K'] }] },
    generate: async (_input, { onVariant }) => {
      generated += 1
      await onVariant({ index: 0, status: 'succeeded', output: { id: 'partial-a', image: '/api/media/partial-a' } })
      throw new GenerationError(502, 'GENERATION_FAILED', '第二张生成失败。')
    },
  })

  await processJob(storedJob.id)

  assert.equal(refreshCount, 1)
  assert.equal(storedJob.status, 'failed')
  assert.equal(storedJob.outputs.length, 1)
  assert.equal(storedJob.projectWritebackPending, true)
  assert.notEqual(storedRun.status, 'failed')

  artifactReady = true
  await processJob(storedJob.id)

  assert.equal(refreshCount, 2)
  assert.equal(generated, 1)
  assert.equal(storedJob.projectWritebackPending, undefined)
  assert.equal(storedRun.status, 'failed')
})

test('Provider 失败前未 await 的最后一个成功 variant 仍保留在失败任务中', async () => {
  const createdAt = Date.now()
  let storedJob = {
    id: 'job-failed-inflight-partial', ownerId: 'user-a', projectId: 'project-a', status: 'queued', kind: 'generation',
    createdAt, updatedAt: createdAt, batchCount: 2,
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
    outputs: [],
    rawInput: {
      projectId: 'project-a', kind: 'generation', prompt: '生成两张结果图', batchCount: 2,
      settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' }, recipe: { references: [] },
    },
  }
  let delayedVariantWrite = false
  const productStore = {
    async readGenerationJobForWorker() { return structuredClone(storedJob) },
    async putGenerationJob(_ownerId, job) {
      if (!delayedVariantWrite && job.status === 'running' && job.outputs?.length === 1) {
        delayedVariantWrite = true
        // 让 failure catch 有机会在该写入完成前运行，稳定复现旧实现先读旧快照的竞态。
        await new Promise((resolve) => setImmediate(resolve))
      }
      storedJob = structuredClone(job)
    },
    async readProject() { return undefined },
    async refreshGenerationArtifacts() { return true },
  }
  const processJob = createGenerationProcessor({
    productStore,
    mediaService: {},
    config: { modelOptions: [{ id: 'gpt-image-2', provider: 'openai', mediaKind: 'image', aspectRatios: ['1:1'], resolutions: ['1K'] }] },
    generate: async (_input, { onVariant }) => {
      void onVariant({ index: 0, status: 'succeeded', output: { id: 'partial-inflight', image: '/api/media/partial-inflight' } })
      throw new GenerationError(502, 'GENERATION_FAILED', '第二张生成失败。')
    },
  })

  await processJob(storedJob.id)

  assert.equal(delayedVariantWrite, true)
  assert.equal(storedJob.status, 'failed')
  assert.deepEqual(storedJob.outputs, [{ id: 'partial-inflight', image: '/api/media/partial-inflight' }])
})

test('Artifact Index 刷新失败时保留恢复标记，不提前推进 Agent Run 终态', async () => {
  const events = []
  const createdAt = Date.now()
  let storedJob = {
    id: 'job-artifact-pending', ownerId: 'user-a', projectId: 'project-a', status: 'queued', kind: 'generation',
    createdAt, updatedAt: createdAt, batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
    outputs: [],
    rawInput: {
      projectId: 'project-a', kind: 'generation', prompt: '生成一张结果图', batchCount: 1,
      settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
      recipe: { references: [{ name: '主素材', role: '商品', primary: true, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }] },
    },
    agentRun: { runId: 'run-artifact-pending', branchId: 'branch-artifact-pending', attempt: 0 },
  }
  let storedRun = createPersistentAgentRun({
    projectId: 'project-a',
    plan: {
      intent: 'initial_generation', instruction: '生成一张结果图', summary: '生成结果', prompt: '生成一张结果图',
      settings: storedJob.settings, constraints: [], output: { mode: 'single', count: 1, candidatesPerItem: 1 },
    },
    branches: [{ id: 'branch-artifact-pending', label: '主分支' }],
  }, { id: 'run-artifact-pending', ownerId: 'user-a', now: createdAt })
  storedRun = applyGenerationJobToAgentRun(storedRun, storedJob)
  let document = {
    id: 'project-a',
    nodes: [
      { id: 'generate-a', type: 'generate', position: { x: 0, y: 0 }, data: { jobId: storedJob.id, status: 'queued' } },
      { id: 'result-a', type: 'result', position: { x: 400, y: 0 }, data: { jobId: storedJob.id, outputOf: 'generate-a', taskGroupId: 'result-a', taskStatus: 'queued', status: 'generating' } },
    ],
    edges: [], generationJobs: [{ id: storedJob.id, status: 'queued' }],
  }
  const productStore = {
    async readGenerationJobForWorker() { return structuredClone(storedJob) },
    async putGenerationJob(_ownerId, job, options = {}) {
      storedJob = structuredClone(job)
      if (options.updateAgentRun !== false && job.agentRun) {
        storedRun = applyGenerationJobToAgentRun(storedRun, job)
        events.push(`run-status:${storedRun.status}`)
      }
    },
    async readProject() { return { document, revision: 1, graphRevision: 1 } },
    async writeProject(_ownerId, nextDocument) { document = nextDocument; events.push('canvas-writeback'); return { document, revision: 2, graphRevision: 2 } },
    async refreshGenerationArtifacts() { throw new Error('Artifact 数据库暂不可用') },
    async readAgentRunForWorker() { return structuredClone(storedRun) },
  }
  const processJob = createGenerationProcessor({
    productStore,
    mediaService: {},
    config: { modelOptions: [{ id: 'gpt-image-2', provider: 'openai', mediaKind: 'image', aspectRatios: ['1:1'], resolutions: ['1K'] }] },
    publishAgentRunUpdated: ({ run }) => events.push(`published:${run.status}`),
    generate: async () => ({ outputs: [{ id: 'output-a', image: '/api/media/output-a' }], missingOutputCount: 0 }),
  })

  await processJob(storedJob.id)

  assert.equal(storedJob.status, 'succeeded')
  assert.equal(storedJob.projectWritebackPending, true)
  assert.equal(events.includes('run-status:completed'), false)
  assert.equal(events.includes('published:completed'), false)
  assert.equal(document.nodes.find((node) => node.type === 'result')?.data.image, '/api/media/output-a')
})

test('Worker 恢复到 Turn 已取消的孤儿 Job 时 durable 取消且不调用 Provider', async () => {
  const createdAt = Date.now()
  let generated = 0
  let storedJob = {
    id: 'job-cancelled-turn-fence', ownerId: 'user-a', projectId: 'project-a', status: 'queued', kind: 'generation',
    createdAt, updatedAt: createdAt, batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
    outputs: [], rawInput: {},
    agentRun: { runId: 'run-cancelled-turn-fence', branchId: 'branch-a', attempt: 0 },
  }
  const run = {
    id: 'run-cancelled-turn-fence', ownerId: 'user-a', projectId: 'project-a', turnId: 'turn-cancelled',
    status: 'queued', branches: [{ id: 'branch-a', status: 'queued', attempt: 0, activeJobId: storedJob.id }],
  }
  const productStore = {
    async readGenerationJobForWorker() { return structuredClone(storedJob) },
    async putGenerationJob(_ownerId, job) { storedJob = structuredClone(job) },
    async readAgentRunForWorker() { return structuredClone(run) },
    async readAgentTurn() { return { id: 'turn-cancelled', projectId: 'project-a', status: 'cancelled' } },
    async readProject() { return undefined },
  }
  const processJob = createGenerationProcessor({
    productStore,
    mediaService: {},
    config: { modelOptions: [{ id: 'gpt-image-2', provider: 'openai', mediaKind: 'image' }] },
    generate: async () => { generated += 1; return { outputs: [], missingOutputCount: 1 } },
  })

  await processJob(storedJob.id)

  assert.equal(storedJob.status, 'cancelled')
  assert.equal(storedJob.cancel?.reason, 'agent-run')
  assert.equal(generated, 0)
})

test('Worker 在 Provider 前复读 Turn fence，封住首次检查后到达的取消', async () => {
  const createdAt = Date.now()
  let generated = 0
  let turnReads = 0
  let storedJob = {
    id: 'job-late-turn-fence', ownerId: 'user-a', projectId: 'project-a', status: 'queued', kind: 'generation',
    createdAt, updatedAt: createdAt, batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
    outputs: [],
    rawInput: {
      projectId: 'project-a', kind: 'generation', prompt: '生成一张图', batchCount: 1,
      settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' }, recipe: { references: [] },
    },
    agentRun: { runId: 'run-late-turn-fence', branchId: 'branch-a', attempt: 0 },
  }
  const run = {
    id: 'run-late-turn-fence', ownerId: 'user-a', projectId: 'project-a', turnId: 'turn-late-cancel',
    status: 'queued', branches: [{ id: 'branch-a', status: 'queued', attempt: 0, activeJobId: storedJob.id }],
  }
  const productStore = {
    async readGenerationJobForWorker() { return structuredClone(storedJob) },
    async putGenerationJob(_ownerId, job) { storedJob = structuredClone(job) },
    async readAgentRunForWorker() { return structuredClone(run) },
    async readAgentTurn() {
      turnReads += 1
      return { id: 'turn-late-cancel', projectId: 'project-a', status: turnReads === 1 ? 'completed' : 'cancelling' }
    },
    async readProject() { return undefined },
  }
  const processJob = createGenerationProcessor({
    productStore,
    mediaService: {},
    config: {
      modelOptions: [{ id: 'gpt-image-2', provider: 'openai', mediaKind: 'image', aspectRatios: ['1:1'], resolutions: ['1K'] }],
      maximumBatchCount: 4, maximumReferenceBytes: 1024,
    },
    generate: async () => { generated += 1; return { outputs: [], missingOutputCount: 1 } },
  })

  await processJob(storedJob.id)

  assert.equal(turnReads, 2)
  assert.equal(storedJob.status, 'cancelled')
  assert.equal(generated, 0)
})

test('Provider 执行期间漏掉 cancel signal 时，结果落库前的 durable fence 不让 Run 复活', async () => {
  const createdAt = Date.now()
  let generated = 0
  let turnReads = 0
  let storedJob = {
    id: 'job-post-provider-turn-fence', ownerId: 'user-a', projectId: 'project-a', status: 'queued', kind: 'generation',
    createdAt, updatedAt: createdAt, batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
    outputs: [],
    rawInput: {
      projectId: 'project-a', kind: 'generation', prompt: '生成一张图', batchCount: 1,
      settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' }, recipe: { references: [] },
    },
    agentRun: { runId: 'run-post-provider-turn-fence', branchId: 'branch-a', attempt: 0 },
  }
  const run = {
    id: 'run-post-provider-turn-fence', ownerId: 'user-a', projectId: 'project-a', turnId: 'turn-post-provider-cancel',
    status: 'running', branches: [{ id: 'branch-a', status: 'running', attempt: 0, activeJobId: storedJob.id }],
  }
  const productStore = {
    async readGenerationJobForWorker() { return structuredClone(storedJob) },
    async putGenerationJob(_ownerId, job) { storedJob = structuredClone(job) },
    async readAgentRunForWorker() { return structuredClone(run) },
    async readAgentTurn() {
      turnReads += 1
      return {
        id: 'turn-post-provider-cancel', projectId: 'project-a',
        status: turnReads < 4 ? 'completed' : 'cancelling',
      }
    },
    async readProject() { return undefined },
  }
  const processJob = createGenerationProcessor({
    productStore,
    mediaService: {},
    config: {
      modelOptions: [{ id: 'gpt-image-2', provider: 'openai', mediaKind: 'image', aspectRatios: ['1:1'], resolutions: ['1K'] }],
      maximumBatchCount: 4, maximumReferenceBytes: 1024,
    },
    generate: async () => {
      generated += 1
      return { outputs: [{ id: 'paid-output', image: '/api/media/paid-output' }], missingOutputCount: 0 }
    },
  })

  await processJob(storedJob.id)

  assert.equal(generated, 1)
  assert.equal(turnReads, 4)
  assert.equal(storedJob.status, 'cancelled')
  assert.deepEqual(storedJob.outputs, [])
})

/** 取消相关用例共用的最小 Worker 夹具：只保留状态读写与 Provider 桩。 */
function cancelHarness(status, generate) {
  let storedJob = {
    id: 'job-cancel', ownerId: 'user-a', projectId: 'project-a', status, kind: 'generation',
    createdAt: Date.now(), updatedAt: Date.now(), batchCount: 1,
    settings: { model: 'primary-image', aspectRatio: '1:1', resolution: '1K' },
    outputs: [],
    rawInput: {
      projectId: 'project-a', kind: 'generation', prompt: '生成品牌首图', batchCount: 1,
      settings: { model: 'primary-image', aspectRatio: '1:1', resolution: '1K' },
      recipe: { references: [] },
    },
  }
  const writes = []
  const cancelRegistry = createLocalCancelRegistry()
  const processJob = createGenerationProcessor({
    productStore: {
      async readGenerationJobForWorker() { return structuredClone(storedJob) },
      async putGenerationJob(_ownerId, job) { storedJob = structuredClone(job); writes.push(job.status) },
      async readProject() { return undefined },
      async refreshGenerationArtifacts() { return true },
    },
    mediaService: { async readGenerationInput() { throw new Error('不应读取媒体标识') } },
    providerCircuitBreaker: {
      async canRequest() { return { allowed: true, state: 'closed' } },
      async recordSuccess() {}, async recordFailure() {},
    },
    config: {
      modelOptions: [{ id: 'primary-image', provider: 'primary', mediaKind: 'image', aspectRatios: ['1:1'], resolutions: ['1K'], inputRoles: [] }],
      maximumBatchCount: 4, maximumReferenceBytes: 1024,
    },
    cancelRegistry,
    generate,
  })
  return { processJob, writes, cancelRegistry, job: () => storedJob }
}

test('Worker 重启后取到已取消的任务：不调用 Provider，也不改写状态', async () => {
  // 唯一真能省下费用的路径就是「派发前取消」；Worker 必须在调用 Provider 之前认出它。
  const { processJob, writes } = cancelHarness('cancelled', async () => {
    throw new Error('已取消的任务不得调用 Provider')
  })
  await processJob('job-cancel')
  assert.deepEqual(writes, [])
})

test('Provider 返回后才发现已取消：结果丢弃，不覆盖成成功', async () => {
  // 迟到结果永不写回是 Epic 1 的正确性收益，优先于省钱。
  let flip = () => {}
  const { processJob, writes, job } = cancelHarness('queued', async () => {
    flip()
    return { outputs: [{ id: 'output-late', image: '/api/media/output-late' }], missingOutputCount: 0 }
  })
  flip = () => { Object.assign(job(), { status: 'cancelled' }) }
  await processJob('job-cancel')

  assert.equal(job().status, 'cancelled')
  assert.deepEqual(job().outputs, [])
  assert.deepEqual(job().lateOutputs?.map((output) => output.id), ['output-late'])
  assert.ok(!writes.includes('succeeded'))
})

test('取消广播先于取消入口落库时：就地中止，不报超时也不覆盖成失败', async () => {
  // 广播比数据库写入先到是真实竞态（两者由不同进程发起）。此时任务在库里还是
  // running，只有靠 signal.aborted 才能分清「取消」和「超时」—— 取消与超时
  // abort 的是同一个控制器，混淆会让用户看到错误的失败原因。
  const { processJob, writes, cancelRegistry, job } = cancelHarness('queued', async (_input, { signal }) => {
    assert.ok(signal, 'Provider Adapter 必须收到统一的 AbortSignal')
    assert.equal(cancelRegistry.abort('job-cancel'), true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const aborted = new Error('The operation was aborted')
    aborted.name = 'AbortError'
    throw aborted
  })
  await processJob('job-cancel')

  assert.equal(job().status, 'running')
  assert.ok(!writes.includes('failed'))
  assert.ok(!job().error)
})

test('超时判失败后 Provider 才成功：不改写终态，但留下可观察记录', async () => {
  // 此前是静默 return —— 丢掉的是一张**已经付过费**的图，事后没有任何地方能看出它
  // 存在过，运维也无从判断超时阈值是不是设短了。端到端冒烟就撞上了这一条：
  // 日志显示 provider completed (1 output)，任务却是「超过模型等待时限」。
  const warnings = []
  const originalWarn = console.warn
  console.warn = (message) => warnings.push(String(message))
  try {
    let flip = () => {}
    const { processJob, writes, job } = cancelHarness('queued', async () => {
      flip()
      return { outputs: [{ id: 'output-late', image: '/api/media/output-late' }], missingOutputCount: 0 }
    })
    flip = () => { Object.assign(job(), { status: 'failed', error: '生成任务超过模型等待时限，已停止，请稍后重试。' }) }
    await processJob('job-cancel')

    // 终态不翻案：超时是对用户做过的承诺，事后改写会让「它到底成没成」变得不确定。
    assert.equal(job().status, 'failed')
    assert.deepEqual(job().outputs, [])
    assert.deepEqual(job().lateOutputs?.map((output) => output.id), ['output-late'])
    assert.ok(!writes.includes('succeeded'))
    // 但必须留下记录。
    assert.ok(
      warnings.some((line) => /结果迟到被丢弃/u.test(line) && /已产生费用/u.test(line)),
      `应记录迟到丢弃，实际：${JSON.stringify(warnings)}`,
    )
  } finally {
    console.warn = originalWarn
  }
})

test('外部超时已落 failed 后，迟到 variant 回调不得再改写终态 outputs', async () => {
  let flip = () => {}
  const { processJob, job } = cancelHarness('queued', async (_input, { onVariant }) => {
    flip()
    await onVariant({ index: 0, status: 'succeeded', output: { id: 'late-variant', image: '/api/media/late-variant' } })
    return { outputs: [{ id: 'late-variant', image: '/api/media/late-variant' }], missingOutputCount: 0 }
  })
  flip = () => {
    Object.assign(job(), {
      status: 'failed',
      error: '生成任务超过模型等待时限，已停止，请稍后重试。',
    })
  }

  await processJob('job-cancel')

  assert.equal(job().status, 'failed')
  assert.deepEqual(job().outputs, [])
})
