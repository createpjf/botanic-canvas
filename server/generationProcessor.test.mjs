import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createGenerationProcessor } from './generationProcessor.mjs'
import { createProductStore } from './productStore.mjs'

test('普通生成任务也由服务端把生命周期状态权威回写到项目画布', async () => {
  const observed = []
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
    agentRun: { runId: 'agent-run-direct', branchId: 'branch-direct' },
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
  })

  await processJob('job-direct')

  assert.equal(storedJob.status, 'failed')
  assert.equal(document.nodes[0].data.status, 'failed')
  assert.equal(document.nodes[1].data.taskStatus, 'failed')
  assert.deepEqual(observed.map((event) => event.type), ['worker_started', 'worker_failed'])
  assert.equal(observed[0].runId, 'agent-run-direct')
  assert.equal(observed[1].status, 'failed')
  assert.doesNotMatch(JSON.stringify(observed), /私密提示词/)
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
    projectWritebackPending: true,
  }
  let storedJob = structuredClone(job)
  let refreshedJobId = ''
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
    async refreshGenerationArtifacts(_ownerId, jobId) { refreshedJobId = jobId; return true },
  }
  const processJob = createGenerationProcessor({
    productStore,
    mediaService: {},
    config: { modelOptions: [{ id: 'gpt-image-2', provider: 'openai', mediaKind: 'image' }] },
  })

  await processJob(job.id)

  assert.equal(storedJob.projectWritebackPending, undefined)
  assert.equal(refreshedJobId, job.id)
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
