import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanvasDocument, CanvasNode, GenerationJob, ResultNodeData } from '../domain/canvas.ts'
import type { GenerationRequest } from './canvasStore.types.ts'
import { requestFromGenerationTaskNode } from './canvasGenerationLifecycle.ts'
import {
  candidatesFromJob,
  materializeGenerationOutputs,
  recordGenerationJob,
} from './canvasGenerationProjection.ts'

const settings = { model: 'gpt-image-2', aspectRatio: '1:1' as const, resolution: '1K' as const }

function taskDocument(): CanvasDocument {
  const recipe = { prompt: '测试', batchCount: 1, settings, references: [] }
  return {
    id: 'project-poll', name: '轮询测试', schemaVersion: 25,
    nodes: [
      { id: 'generate-a', type: 'generate', position: { x: 0, y: 0 }, data: { kind: 'generate', label: 'A', prompt: 'A', batchCount: 1, settings, status: 'running', jobId: 'job-a' } },
      { id: 'result-a', type: 'result', position: { x: 200, y: 0 }, data: { kind: 'result', outputOf: 'generate-a', taskGroupId: 'result-a', jobId: 'job-a', taskStatus: 'running', generationKind: 'generation', generationRecipe: recipe } },
      { id: 'generate-b', type: 'generate', position: { x: 0, y: 200 }, data: { kind: 'generate', label: 'B', prompt: 'B', batchCount: 1, settings, status: 'running', jobId: 'job-b' } },
      { id: 'result-b', type: 'result', position: { x: 200, y: 200 }, data: { kind: 'result', outputOf: 'generate-b', taskGroupId: 'result-b', jobId: 'job-b', taskStatus: 'running', generationKind: 'generation', generationRecipe: recipe } },
    ],
    edges: [], viewport: { x: 0, y: 0, zoom: 1 }, assets: [], assetGroups: [], templates: [], history: [], deliveries: [],
    generationJobs: [
      { id: 'job-a', projectId: 'project-poll', kind: 'generation', status: 'running', batchCount: 1, settings, outputs: [], createdAt: 1, updatedAt: 2, generateNodeId: 'generate-a', resultNodeId: 'result-a' },
      { id: 'job-b', projectId: 'project-poll', kind: 'generation', status: 'running', batchCount: 1, settings, outputs: [], createdAt: 1, updatedAt: 2, generateNodeId: 'generate-b', resultNodeId: 'result-b' },
    ],
    batchVariationRuns: [], agentSessions: [], agentMemory: [], agentRuns: [], updatedAt: 1,
  }
}

function succeededJob(id: string): GenerationJob {
  return {
    id, projectId: 'project-poll', kind: 'generation', status: 'succeeded', batchCount: 1, settings,
    outputs: [{ id: `output-${id}`, image: `/api/media/${id}`, mediaKind: 'image' }],
    createdAt: 1, updatedAt: 3,
    generateNodeId: id === 'job-a' ? 'generate-a' : 'generate-b',
    resultNodeId: id === 'job-a' ? 'result-a' : 'result-b',
  }
}

function resultNode(document: CanvasDocument, id: string) {
  return document.nodes.find((node) => node.id === id) as CanvasNode | undefined
}

function syncSucceededJob(
  document: CanvasDocument,
  job: GenerationJob,
  request: GenerationRequest | null | undefined,
) {
  if (!request?.taskNodeIds || request.jobId !== job.id) return document
  const recordedDocument = recordGenerationJob(document, job, request.taskNodeIds)
  const candidates = candidatesFromJob(job, request)
  return candidates.length
    ? materializeGenerationOutputs(recordedDocument, job, request)
    : recordedDocument
}

test('两个并存 running 任务交错轮询后都能各自投影到画布', async () => {
  const polled: string[] = []
  const baseDocument = taskDocument()
  const resultA = resultNode(baseDocument, 'result-a')!
  const resultB = resultNode(baseDocument, 'result-b')!
  const requestA = requestFromGenerationTaskNode(baseDocument, resultA)!
  const requestB = requestFromGenerationTaskNode(baseDocument, resultB)!
  let document = baseDocument
  const lastGenerationRequest = requestA

  const pollJob = async (jobId: string, boundRequest?: GenerationRequest) => {
    polled.push(jobId)
    await new Promise((resolve) => setTimeout(resolve, jobId === 'job-b' ? 0 : 1))
    const request = boundRequest?.jobId === jobId
      ? boundRequest
      : lastGenerationRequest?.jobId === jobId
        ? lastGenerationRequest
        : boundRequest
    document = syncSucceededJob(document, succeededJob(jobId), request)
  }

  await Promise.all([
    pollJob('job-a', requestA),
    pollJob('job-b', requestB),
  ])

  assert.deepEqual([...polled].sort(), ['job-a', 'job-b'])
  assert.equal((resultNode(document, 'result-a')?.data as ResultNodeData).taskStatus, 'succeeded')
  assert.equal((resultNode(document, 'result-b')?.data as ResultNodeData).taskStatus, 'succeeded')
})
