import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  applyBotanicAgentCanvasNodeDeletion,
  applyBotanicAgentCanvasTextUpdate,
  createCanvasAgentEditExecutors,
} from './canvasAgentEditing.mjs'
import { generationJobProjectionComplete, reconcileGenerationResults } from '../generation/generationResultReconciliation.mjs'
import { createProductStore } from '../store/productStore.mjs'
import { canvasAgentArtifactHash } from './canvasAgentArtifactProjection.mjs'

function projectDocument() {
  return {
    id: 'project-1',
    name: '测试项目',
    updatedAt: 100,
    nodes: [
      { id: 'text-1', type: 'text', position: { x: 0, y: 0 }, data: { kind: 'text', label: '生成描述', content: '旧提示词' } },
      { id: 'text-busy', type: 'text', position: { x: 0, y: 80 }, data: { kind: 'text', label: '进行中提示', content: '活跃提示词' } },
      { id: 'generate-1', type: 'generate', position: { x: 200, y: 0 }, data: { kind: 'generate', label: '首图', status: 'idle', batchCount: 1, settings: { model: 'gpt-image-2', aspectRatio: '1:1' } } },
      { id: 'result-parent', type: 'result', position: { x: 400, y: 80 }, data: { kind: 'result', label: '父图', status: 'completed' } },
      { id: 'result-busy', type: 'result', position: { x: 400, y: 0 }, data: { kind: 'result', label: '生成中', status: 'generating', jobId: 'job-busy' } },
    ],
    edges: [
      { id: 'edge-1', source: 'generate-1', target: 'result-busy', data: { system: true, role: 'output' } },
    ],
    generationJobs: [{
      id: 'job-busy',
      status: 'running',
      promptNodeId: 'text-busy',
      resultNodeId: 'result-busy',
      parentNodeId: 'result-parent',
    }],
  }
}

function fakeStore(document) {
  const historicalArtifact = { id: 'generation:job-old:output-old', kind: 'image', label: '历史结果', url: '/api/media/old', origin: { type: 'generation_output', jobId: 'job-old', outputId: 'output-old' }, metadata: { status: 'succeeded' }, createdAt: 1, updatedAt: 1 }
  const state = { document, revision: 5, published: [], historicalArtifact }
  return {
    state,
    listAgentArtifacts() { return [structuredClone(historicalArtifact)] },
    updateProjectDocument(_userId, _projectId, mutate) {
      const next = mutate(structuredClone(state.document))
      if (!next) return undefined
      state.document = next
      state.revision += 1
      return { document: next, revision: state.revision, graphRevision: 2 }
    },
  }
}

test('画布编辑执行器：改文字回增量 patch，调参校验模型目录，删除回节点清单', async () => {
  const store = fakeStore(projectDocument())
  const published = []
  const executors = createCanvasAgentEditExecutors({
    productStore: store,
    publishProjectUpdated: async (saved) => published.push(saved.revision),
    models: [
      { id: 'gpt-image-2', aspectRatios: ['1:1', '3:4'], resolutions: ['1K', '2K'] },
      { id: 'minimax-image-01', aspectRatios: ['1:1', '3:4'], resolutions: ['1K', '2K'] },
      { id: 'narrow-model', aspectRatios: ['3:4'], resolutions: ['2K'] },
    ],
    userId: 'user-1',
    projectId: 'project-1',
  })

  const text = await executors.updateCanvasText({ nodeId: 'text-1', content: '新提示词', label: '精修描述' })
  assert.equal(text.canvasPatch.nodes[0].data.content, '新提示词')
  assert.equal(text.canvasPatch.nodes[0].data.label, '精修描述')
  assert.equal(text.canvasPatch.revision, 6)

  const settings = await executors.updateGenerateSettings({ nodeId: 'generate-1', settings: { model: 'minimax-image-01' }, batchCount: 2 })
  assert.equal(settings.canvasPatch.nodes[0].data.settings.model, 'minimax-image-01')
  assert.equal(settings.canvasPatch.nodes[0].data.settings.aspectRatio, '1:1')
  assert.equal(settings.canvasPatch.nodes[0].data.batchCount, 2)
  await assert.rejects(
    executors.updateGenerateSettings({ nodeId: 'generate-1', settings: { model: 'unknown-model' } }),
    /不在可用目录/,
  )
  await assert.rejects(
    executors.updateGenerateSettings({ nodeId: 'generate-1', settings: { model: 'narrow-model' } }),
    /不支持这个画面比例/,
  )
  await assert.rejects(
    executors.updateGenerateSettings({ nodeId: 'generate-1', settings: { resolution: '4K' } }),
    /不支持这个清晰度/,
  )

  const artifactAction = await executors.executeCanvasActionSet({
    actionId: 'artifact-action', preconditions: [], operations: [{ kind: 'project_artifact', temporaryId: 'old-result',
      artifactId: store.state.historicalArtifact.id, artifactHash: canvasAgentArtifactHash(store.state.historicalArtifact), position: { x: 700, y: 0 } },
      { kind: 'organize_nodes', placements: [{ nodeId: 'old-result', position: { x: 750, y: 40 } }] }],
  })
  assert.equal(artifactAction.canvasPatch.nodes[0].data.image, '/api/media/old')
  assert.deepEqual(artifactAction.canvasPatch.positionNodeIds, [artifactAction.canvasPatch.nodes[0].id])

  const removal = await executors.deleteCanvasNodes({ nodeIds: ['text-1'] })
  assert.deepEqual(removal.canvasRemovedNodeIds, ['text-1'])
  assert.equal(store.state.document.nodes.some((node) => node.id === 'text-1'), false)
  assert.equal(published.length, 4)
})

test('活跃任务绑定的节点不可删除，历史与任务恢复语义不受编辑影响', () => {
  const document = projectDocument()
  assert.throws(
    () => applyBotanicAgentCanvasNodeDeletion(document, { nodeIds: ['result-busy'] }),
    (caught) => caught.code === 'CANVAS_NODE_BUSY',
  )
  assert.throws(
    () => applyBotanicAgentCanvasTextUpdate(document, { nodeId: 'text-busy', content: '改掉进行中的提示' }),
    (caught) => caught.code === 'CANVAS_NODE_BUSY',
  )
  assert.throws(
    () => applyBotanicAgentCanvasNodeDeletion(document, { nodeIds: ['text-busy'] }),
    (caught) => caught.code === 'CANVAS_NODE_BUSY',
  )
  assert.throws(
    () => applyBotanicAgentCanvasNodeDeletion(document, { nodeIds: ['result-parent'] }),
    (caught) => caught.code === 'CANVAS_NODE_BUSY',
  )
  // 删除空闲生成节点会连带清理它的系统连线，但不触碰 generationJobs 记录（历史权威）。
  const removed = applyBotanicAgentCanvasNodeDeletion(document, { nodeIds: ['generate-1'] })
  assert.equal(removed.document.edges.length, 0)
  assert.equal(removed.document.generationJobs.length, 1)
})

test('删除 Agent 生成节点后，迟到 Worker 保留任务但不复活画布投影', () => {
  const document = {
    id: 'project-agent-tombstone',
    updatedAt: 10,
    nodes: [
      { id: 'generate-done', type: 'generate', position: { x: 0, y: 0 }, data: { jobId: 'job-done', status: 'succeeded' } },
      { id: 'result-done', type: 'result', position: { x: 400, y: 0 }, data: { outputOf: 'generate-done', jobId: 'job-done', candidateId: 'output-done', image: '/api/media/done', status: 'ready', taskStatus: 'succeeded' } },
    ],
    edges: [{ id: 'edge-done', source: 'generate-done', target: 'result-done', data: { system: true, role: 'output' } }],
    generationJobs: [{
      id: 'job-done', status: 'succeeded', kind: 'generation', createdAt: 1, updatedAt: 2,
      batchCount: 1, outputCount: 1, outputs: [{ id: 'output-done', image: '/api/media/done' }],
      generateNodeId: 'generate-done', resultNodeId: 'result-done', agentRun: { runId: 'run-1', branchId: 'branch-1' },
    }],
  }

  const deleted = applyBotanicAgentCanvasNodeDeletion(document, { nodeIds: ['generate-done'] }, 20).document
  const lateJob = { ...document.generationJobs[0], updatedAt: 30 }
  const reconciled = reconcileGenerationResults(deleted, [lateJob], { ensureAgentPlaceholders: true })

  assert.equal(deleted.generationJobs[0].projectionDismissedAt, 20)
  assert.equal(reconciled.document.nodes.some((node) => node.id === 'generate-done'), false)
  assert.equal(reconciled.document.nodes.length, deleted.nodes.length)
  assert.equal(generationJobProjectionComplete(reconciled.document, lateJob), true)
  assert.equal(deleted.generationJobs[0].outputs.length, 1)
})

test('Agent 删除节点经 durable graph commit 落库且不删除任务历史', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'botanic-agent-canvas-edit-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const productStore = createProductStore({
    dataPath: join(directory, 'product.json'),
    bootstrapAccessToken: 'owner-token',
  })
  const owner = productStore.authenticate('owner-token')
  assert.ok(owner)
  const base = projectDocument()
  const document = {
    ...base,
    id: 'project-durable-edit',
    schemaVersion: 25,
    nodes: [
      ...base.nodes,
      { id: 'result-durable', type: 'result', position: { x: 800, y: 0 }, data: { jobId: 'job-durable', candidateId: 'output-durable', image: '/api/media/durable', status: 'ready', taskStatus: 'succeeded' } },
    ],
    generationJobs: [
      ...base.generationJobs,
      { id: 'job-durable', status: 'succeeded', updatedAt: 2, outputs: [{ id: 'output-durable', image: '/api/media/durable' }], resultNodeId: 'result-durable' },
    ],
  }
  productStore.writeProject(owner.id, document)
  const commitOrder = []
  const updateProjectDocument = productStore.updateProjectDocument.bind(productStore)
  productStore.updateProjectDocument = (...args) => {
    commitOrder.push('metadata')
    return updateProjectDocument(...args)
  }
  const appendCanvasGraphUpdate = productStore.appendCanvasGraphUpdate.bind(productStore)
  let failGraphCommit = true
  productStore.appendCanvasGraphUpdate = (...args) => {
    commitOrder.push('graph')
    if (failGraphCommit) throw new Error('模拟图谱提交失败。')
    return appendCanvasGraphUpdate(...args)
  }
  const executors = createCanvasAgentEditExecutors({
    productStore,
    publishProjectUpdated: async () => {},
    models: [],
    userId: owner.id,
    projectId: document.id,
    mutationId: 'agent-action-receipt-delete-1',
  })

  await assert.rejects(
    executors.deleteCanvasNodes({ nodeIds: ['result-durable'] }),
    /模拟图谱提交失败/,
  )

  const afterGraphFailure = productStore.readProject(owner.id, document.id)
  assert.equal(afterGraphFailure.document.nodes.some((node) => node.id === 'result-durable'), true)
  assert.deepEqual(afterGraphFailure.document.generationJobs.find((job) => job.id === 'job-durable').dismissedOutputIds, ['output-durable'])
  assert.deepEqual(commitOrder.slice(0, 2), ['metadata', 'graph'])

  failGraphCommit = false
  await executors.deleteCanvasNodes({ nodeIds: ['result-durable'] })

  const saved = productStore.readProject(owner.id, document.id)
  assert.equal(saved.document.nodes.some((node) => node.id === 'result-durable'), false)
  assert.equal(saved.document.generationJobs.length, 2)
  assert.deepEqual(saved.document.generationJobs.find((job) => job.id === 'job-durable').dismissedOutputIds, ['output-durable'])
  assert.deepEqual(commitOrder.slice(0, 4), ['metadata', 'graph', 'metadata', 'graph'])
  const collaboration = productStore.loadCanvasCollaboration(owner.id, document.id)
  assert.ok(collaboration.updates.length > 0)
  assert.equal(saved.graphRevision, collaboration.graphRevision)
})
