import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyBotanicAgentCanvasNodeDeletion,
  applyBotanicAgentCanvasTextUpdate,
  createCanvasAgentEditExecutors,
} from './canvasAgentEditing.mjs'

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
  const state = { document, revision: 5, published: [] }
  return {
    state,
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

  const removal = await executors.deleteCanvasNodes({ nodeIds: ['text-1'] })
  assert.deepEqual(removal.canvasRemovedNodeIds, ['text-1'])
  assert.equal(store.state.document.nodes.some((node) => node.id === 'text-1'), false)
  assert.equal(published.length, 3)
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
