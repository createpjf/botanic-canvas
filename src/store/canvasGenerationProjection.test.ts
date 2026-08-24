import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanvasDocument, GenerationJob } from '../domain/canvas.ts'
import type { GenerationRequest } from './canvasStore.types.ts'
import { createTaskFlow, materializeGenerationOutputs, recordGenerationJob } from './canvasGenerationProjection.ts'

function baseDocument(): CanvasDocument {
  return {
    id: 'project-generation', name: '生成投影', schemaVersion: 25,
    nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, assets: [], assetGroups: [], templates: [], history: [], deliveries: [], generationJobs: [], batchVariationRuns: [], agentSessions: [], agentMemory: [], agentRuns: [], updatedAt: 1,
  }
}

function request(): GenerationRequest {
  return {
    kind: 'generation', prompt: '海边自然光', batchCount: 2,
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
    recipe: { prompt: '海边自然光', batchCount: 2, settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' }, references: [] },
    idempotencyKey: 'submission-a',
  }
}

test('生成投影先创建独立占位节点，再用稳定输出身份原位落图', () => {
  const planned = createTaskFlow(baseDocument(), request())
  const pendingResults = planned.document.nodes.filter((node) => node.type === 'result')
  assert.equal(pendingResults.length, 2)
  assert.equal(new Set(pendingResults.map((node) => node.id)).size, 2)

  const generationRequest = { ...request(), taskNodeIds: planned.taskNodeIds }
  const job: GenerationJob = {
    id: 'job-a', projectId: 'project-generation', kind: 'generation', status: 'succeeded', prompt: '海边自然光', batchCount: 2,
    settings: generationRequest.settings, recipe: generationRequest.recipe!, createdAt: 1, updatedAt: 2,
    outputs: [
      { id: 'output-a', image: '/a.webp', mediaKind: 'image' },
      { id: 'output-b', image: '/b.webp', mediaKind: 'image' },
    ],
  }
  const recorded = recordGenerationJob(planned.document, job, planned.taskNodeIds)
  const materialized = materializeGenerationOutputs(recorded, job, generationRequest)
  const results = materialized.nodes.filter((node) => node.type === 'result')

  assert.equal(results.length, 2)
  assert.deepEqual(results.map((node) => (node.data as { candidateId?: string }).candidateId).sort(), ['output-a', 'output-b'])
  assert.equal(materialized.generationJobs[0].id, 'job-a')
})

test('落图后结果名用短标题，不用 Prompt 原文', () => {
  const longPrompt = '把原图里的女孩换成短发女孩，手持花瓶站在窗边，柔和自然光。'
  const planned = createTaskFlow(baseDocument(), {
    ...request(),
    prompt: longPrompt,
    title: '换景调光',
    recipe: { prompt: longPrompt, batchCount: 2, settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' }, references: [] },
  })
  const pending = planned.document.nodes.filter((node) => node.type === 'result')
  assert.deepEqual(pending.map((node) => (node.data as { label?: string }).label), ['换景调光1', '换景调光2'])

  const generationRequest = { ...request(), prompt: longPrompt, title: '换景调光', taskNodeIds: planned.taskNodeIds }
  const job: GenerationJob = {
    id: 'job-title', projectId: 'project-generation', kind: 'generation', status: 'succeeded', prompt: longPrompt, batchCount: 2,
    settings: generationRequest.settings, recipe: generationRequest.recipe!, createdAt: 1, updatedAt: 2,
    outputs: [
      { id: 'output-a', image: '/a.webp', mediaKind: 'image' },
      { id: 'output-b', image: '/b.webp', mediaKind: 'image' },
    ],
  }
  const materialized = materializeGenerationOutputs(recordGenerationJob(planned.document, job, planned.taskNodeIds), job, generationRequest)
  const labels = materialized.nodes.filter((node) => node.type === 'result').map((node) => (node.data as { label?: string }).label)
  assert.deepEqual(labels, ['换景调光1', '换景调光2'])
  assert.equal(labels.every((label) => Array.from(label ?? '').length <= 8), true)
})

test('取消接口的一次性计费判定不落进持久化任务', () => {
  // cancelOutcome 只描述「这一次取消调用」；写进文档会让轮询与恢复路径
  // 反复看到一份无法复算的计费结论。
  const planned = createTaskFlow(baseDocument(), request())
  const job = {
    id: 'job-cancel', projectId: 'project-generation', kind: 'generation', status: 'cancelled',
    prompt: '海边自然光', batchCount: 2, settings: request().settings, recipe: request().recipe!,
    createdAt: 1, updatedAt: 2,
    cancelOutcome: { billing: 'possible', capability: 'local-abort-only', workerReleased: true, code: 'CANCELLED_RESULT_DISCARDED' },
  } as unknown as GenerationJob
  const recorded = recordGenerationJob(planned.document, job, planned.taskNodeIds)
  const persisted = recorded.generationJobs.find((item) => item.id === 'job-cancel')
  assert.ok(persisted)
  assert.equal(persisted.status, 'cancelled')
  assert.ok(!('cancelOutcome' in persisted))
})
