import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanvasDocument, GenerationJob } from '../domain/canvas.ts'
import { createTaskFlow } from './canvasGenerationProjection.ts'
import { requestFromPendingGenerationSource, restoreGenerationLifecycleState } from './canvasGenerationLifecycle.ts'

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

test('批量子任务断线后从原生成节点恢复同一幂等键', () => {
  const job: GenerationJob = {
    id: 'job-history', projectId: 'project-lifecycle', ownerId: 'user-a', kind: 'generation', status: 'succeeded',
    batchCount: 2, settings, provider: 'openai-images', outputs: [], createdAt: 10, updatedAt: 20,
    generateNodeId: 'generate-task', resultNodeId: 'result-task',
  }
  const document = persistedDocument(job)
  const recipe = { prompt: '海边商品图', batchCount: 2, settings, references: [{ nodeId: 'asset-a', assetId: 'a', name: '商品', image: '/a', role: '商品' as const, source: 'upload' as const, primary: true, priority: 1 }] }
  const flow = createTaskFlow(document, {
    kind: 'generation', prompt: recipe.prompt, batchCount: 2, settings, recipe,
    sourceGraphNodeId: 'generate-task', idempotencyKey: 'batch-stable-key',
  })

  const recovered = requestFromPendingGenerationSource(flow.document, 'generate-task')

  assert.equal(recovered?.idempotencyKey, 'batch-stable-key')
  assert.equal(recovered?.taskNodeIds?.resultNodeId, flow.taskNodeIds.resultNodeId)
  assert.deepEqual(recovered?.taskNodeIds?.resultNodeIds, flow.taskNodeIds.resultNodeIds)
})

test('无 submissionKey 的 uploading 占位在恢复时立即收口为可重试失败', () => {
  const document: CanvasDocument = {
    id: 'project-zombie', name: '僵尸占位',
    nodes: [
      { id: 'generate-zombie', type: 'generate', position: { x: 0, y: 0 }, data: { kind: 'generate', label: '生成', prompt: '测试', batchCount: 1, settings, status: 'uploading' } },
      { id: 'result-zombie', type: 'result', position: { x: 300, y: 0 }, data: { kind: 'result', outputOf: 'generate-zombie', taskGroupId: 'result-zombie', taskStatus: 'uploading', submittedAt: Date.now() - 600_000, generationKind: 'generation', generationRecipe: { prompt: '测试', batchCount: 1, settings, references: [] } } },
    ],
    edges: [], viewport: { x: 0, y: 0, zoom: 1 }, assets: [], assetGroups: [], templates: [], history: [], deliveries: [],
    generationJobs: [], batchVariationRuns: [], agentSessions: [], agentMemory: [], agentRuns: [], updatedAt: 1,
  }

  const restored = restoreGenerationLifecycleState(document, '已打开项目。')
  const result = restored.document.nodes.find((node) => node.id === 'result-zombie')

  assert.equal((result?.data as { taskStatus?: string }).taskStatus, 'failed')
  assert.match(String((result?.data as { error?: string }).error), /任务提交已中断/)
  assert.equal(restored.state.generationStatus, 'idle')
})

test('响应丢失后刷新仍保留 uploading 占位并进入 recovering 确认', () => {
  const document: CanvasDocument = {
    id: 'project-response-loss', name: '响应丢失',
    nodes: [
      { id: 'generate-loss', type: 'generate', position: { x: 0, y: 0 }, data: { kind: 'generate', label: '生成', prompt: '测试', batchCount: 1, settings, status: 'uploading', submissionKey: 'gen_loss_key' } },
      { id: 'result-loss', type: 'result', position: { x: 300, y: 0 }, data: { kind: 'result', outputOf: 'generate-loss', taskGroupId: 'result-loss', taskStatus: 'uploading', submittedAt: Date.now(), submissionKey: 'gen_loss_key', generationKind: 'generation', generationRecipe: { prompt: '测试', batchCount: 1, settings, references: [] } } },
    ],
    edges: [], viewport: { x: 0, y: 0, zoom: 1 }, assets: [], assetGroups: [], templates: [], history: [], deliveries: [],
    generationJobs: [], batchVariationRuns: [], agentSessions: [], agentMemory: [], agentRuns: [], updatedAt: 1,
  }

  const restored = restoreGenerationLifecycleState(document, '已打开项目。')
  const result = restored.document.nodes.find((node) => node.id === 'result-loss')

  assert.equal((result?.data as { taskStatus?: string }).taskStatus, 'uploading')
  assert.equal(restored.state.generationStatus, 'recovering')
  assert.equal(restored.state.lastGenerationRequest?.idempotencyKey, 'gen_loss_key')
  assert.match(restored.state.assistantMessage ?? '', /原幂等键确认/)
})
