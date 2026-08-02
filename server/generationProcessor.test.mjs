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
