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
