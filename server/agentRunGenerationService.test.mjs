import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentRunGenerationService } from './agentRunGenerationService.mjs'

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

function harness() {
  const run = persistentRun()
  let project = { document: projectDocument(), revision: 1, graphRevision: 1 }
  const jobs = new Map()
  const queued = []
  const quotaCosts = []
  const productStore = {
    async readAgentRun() { return run },
    async readProject() { return project },
    async writeProject(_userId, document) { project = { document, revision: project.revision + 1, graphRevision: 1 }; return project },
    async readGenerationJob(_userId, id) { return jobs.get(id) },
    async putGenerationJob(_userId, job) { jobs.set(job.id, job) },
  }
  const service = createAgentRunGenerationService({
    config: { modelOptions: models, models: ['gpt-image-2'], maximumBatchCount: 8, maximumReferenceBytes: 8 * 1024 * 1024, security: { generationOutputsPerDay: 10 } },
    productStore,
    securityControls: { async consume(input) { quotaCosts.push(input.cost); return { allowed: true } } },
    async enqueue(jobId) { queued.push(jobId) },
    async publishProjectUpdated() {},
    async publishAgentRunUpdated() {},
  })
  return { service, jobs, queued, quotaCosts }
}

test('Agent Run 提交按新输出计费并让同一任务重试复用既有 Job', async () => {
  const { service, jobs, queued, quotaCosts } = harness()

  const first = await service.submitGeneration('user-1', 'project-1', 'agent-run-1')
  const second = await service.submitGeneration('user-1', 'project-1', 'agent-run-1')

  assert.equal(first.jobs.length, 1)
  assert.equal(second.jobs[0].id, first.jobs[0].id)
  assert.equal(jobs.size, 1)
  assert.deepEqual(queued, [first.jobs[0].id])
  assert.deepEqual(quotaCosts, [1])
})
