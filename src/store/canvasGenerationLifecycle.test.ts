import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanvasDocument, GenerationJob } from '../domain/canvas.ts'
import { restoreGenerationLifecycleState } from './canvasGenerationLifecycle.ts'

const settings = { model: 'gpt-image-2', aspectRatio: '3:4' as const, resolution: '2K' as const }

function persistedDocument(job: GenerationJob): CanvasDocument {
  return {
    id: 'project-lifecycle', name: '生命周期测试',
    nodes: [
      { id: 'generate-task', type: 'generate', position: { x: 0, y: 0 }, data: { kind: 'generate', label: '生成', prompt: '海边商品图', batchCount: 2, settings, status: job.status } },
      { id: 'result-task', type: 'result', position: { x: 300, y: 0 }, data: { kind: 'result', outputOf: 'generate-task', taskGroupId: 'result-task', jobId: job.id, generationKind: 'generation', generationRecipe: { prompt: '海边商品图', batchCount: 2, settings, references: [{ nodeId: 'asset-a', assetId: 'a', name: '商品', image: '/a', role: '商品', source: 'upload', primary: true, priority: 1 }] } } },
    ],
    edges: [], viewport: { x: 0, y: 0, zoom: 1 }, assets: [], assetGroups: [], templates: [], history: [], deliveries: [],
    generationJobs: [job], batchVariationRuns: [], agentSessions: [], agentMemory: [], agentRuns: [], updatedAt: job.updatedAt,
  }
}

test('恢复运行中的持久化任务并返回继续轮询锚点', () => {
  const job: GenerationJob = {
    id: 'job-running', projectId: 'project-lifecycle', ownerId: 'user-a', kind: 'generation', status: 'running',
    batchCount: 2, settings, provider: 'openai-images', outputs: [], createdAt: 10, updatedAt: 20,
    generateNodeId: 'generate-task', resultNodeId: 'result-task',
  }

  const restored = restoreGenerationLifecycleState(persistedDocument(job), '已打开项目。')

  assert.equal(restored.state.generationStatus, 'running')
  assert.equal(restored.state.expectedCandidateCount, 2)
  assert.equal(restored.state.lastGenerationRequest?.jobId, 'job-running')
  assert.equal(restored.pollJobId, 'job-running')
})

test('失败任务恢复为可重试错误而非本地 loading', () => {
  const job: GenerationJob = {
    id: 'job-failed', projectId: 'project-lifecycle', ownerId: 'user-a', kind: 'generation', status: 'failed',
    batchCount: 2, settings, provider: 'openai-images', outputs: [], error: '供应商失败', createdAt: 10, updatedAt: 30,
    generateNodeId: 'generate-task', resultNodeId: 'result-task',
  }

  const restored = restoreGenerationLifecycleState(persistedDocument(job), '已打开项目。')

  assert.equal(restored.state.generationStatus, 'error')
  assert.equal(restored.state.generationError, '供应商失败')
  assert.equal(restored.state.lastGenerationRequest?.jobId, 'job-failed')
  assert.equal(restored.pollJobId, undefined)
})
