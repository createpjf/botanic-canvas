import assert from 'node:assert/strict'
import test from 'node:test'
import { createGenerationProcessor } from './generationProcessor.mjs'

test('普通生成任务也由服务端把生命周期状态权威回写到项目画布', async () => {
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
    rawInput: {},
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
  })

  await processJob('job-direct')

  assert.equal(storedJob.status, 'failed')
  assert.equal(document.nodes[0].data.status, 'failed')
  assert.equal(document.nodes[1].data.taskStatus, 'failed')
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
