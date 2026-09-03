import assert from 'node:assert/strict'
import test from 'node:test'
import { applyCanvasActionSet, prepareCanvasActionSetProposal } from './canvasAgentActionSet.mjs'
import { canvasAgentEntityHash } from './canvasAgentEntityHash.mjs'

const models = [{ id: 'image-model', aspectRatios: ['1:1'], resolutions: ['1K'] }]
const artifact = { id: 'generation:job-history:output-1', kind: 'image', label: '已批准主图', url: '/api/media/history-1', origin: { type: 'generation_output', jobId: 'job-history', outputId: 'output-1' }, metadata: { status: 'succeeded', settings: { model: 'image-model', aspectRatio: '1:1', resolution: '1K' } }, createdAt: 10, updatedAt: 10 }
function document() {
  return {
    id: 'project-action-set', updatedAt: 1,
    nodes: [
      { id: 'asset-1', type: 'asset', position: { x: 0, y: 0 }, data: { kind: 'asset', name: '商品', role: '商品', image: '/api/media/private' } },
      { id: 'text-1', type: 'text', position: { x: 0, y: 200 }, data: { kind: 'text', label: '旧文案', content: '旧内容' } },
      { id: 'result-busy', type: 'result', position: { x: 600, y: 0 }, data: { kind: 'result', label: '生成中', status: 'generating', jobId: 'job-1' } },
    ],
    edges: [], generationJobs: [{ id: 'job-1', status: 'running', resultNodeId: 'result-busy' }],
  }
}

function precondition(base, nodeId) {
  return { nodeId, hash: canvasAgentEntityHash(base, nodeId) }
}

test('Action Set 以确定性 ID 创建领域节点、连接参考并与文字更新一起预演', () => {
  const base = document()
  const input = {
    actionId: 'action-1',
    preconditions: [precondition(base, 'asset-1'), precondition(base, 'text-1')],
    operations: [
      { kind: 'create_text', temporaryId: 'prompt', position: { x: 200, y: 0 }, label: '新文案', content: '夏日新品' },
      { kind: 'project_artifact', temporaryId: 'approved', artifactId: artifact.id, position: { x: 200, y: 300 } },
      { kind: 'create_generate', temporaryId: 'generator', position: { x: 400, y: 0 }, label: '主图生成', prompt: '改成海边', batchCount: 2, settings: { model: 'image-model', aspectRatio: '1:1', resolution: '1K' }, constraints: [{ dimension: 'person', mode: 'preserve' }, { dimension: 'scene', mode: 'change' }] },
      { kind: 'connect_reference', sourceNodeId: 'asset-1', targetNodeId: 'generator' },
      { kind: 'connect_reference', sourceNodeId: 'approved', targetNodeId: 'generator' },
      { kind: 'update_text', nodeId: 'text-1', content: '已更新' },
    ],
  }
  const artifacts = new Map([[artifact.id, artifact]])
  const prepared = prepareCanvasActionSetProposal(base, { operations: input.operations }, models, input.actionId, artifacts)
  assert.deepEqual(prepared.preview.summary, { created: 3, updated: 1, removed: 0, connected: 2 })
  assert.equal(typeof prepared.previewHash, 'string')
  assert.deepEqual(prepared.arguments.preconditions.map((item) => item.nodeId), ['asset-1', 'text-1'])
  const frozen = { actionId: input.actionId, ...prepared.arguments }
  const first = applyCanvasActionSet(base, frozen, models, 20, artifacts)
  const replay = applyCanvasActionSet(base, frozen, models, 20, artifacts)
  assert.deepEqual(first.createdNodeIds, replay.createdNodeIds)
  assert.equal(first.document.nodes.find((node) => node.id === 'text-1').data.content, '已更新')
  const projected = first.document.nodes.find((node) => node.id === first.createdNodeIds[1])
  const generate = first.document.nodes.find((node) => node.id === first.createdNodeIds[2])
  assert.equal(projected.data.image, artifact.url)
  assert.match(generate.data.prompt, /PRESERVE person; CHANGE scene/u)
  assert.deepEqual(generate.data.constraints, [{ dimension: 'person', mode: 'preserve' }, { dimension: 'scene', mode: 'change' }])
  assert.deepEqual(first.document.edges.map((edge) => [edge.source, edge.target, edge.data]), [
    ['asset-1', generate.id, { role: 'reference' }], [projected.id, generate.id, { role: 'reference' }],
  ])
  assert.equal(JSON.stringify(first.document).includes('system'), false)
})

test('Action Set 缺触达 hash 或末项触碰活跃节点时整组失败且不改变输入', () => {
  const base = document()
  const before = structuredClone(base)
  assert.throws(() => applyCanvasActionSet(base, {
    actionId: 'action-no-hash', operations: [{ kind: 'update_text', nodeId: 'text-1', content: '不应写入' }],
  }, models), (error) => error.code === 'CANVAS_ACTION_SET_PRECONDITION_REQUIRED')
  assert.throws(() => applyCanvasActionSet(base, {
    actionId: 'action-busy',
    preconditions: [precondition(base, 'text-1'), precondition(base, 'result-busy')],
    operations: [
      { kind: 'update_text', nodeId: 'text-1', content: '仍不应写入' },
      { kind: 'delete_nodes', nodeIds: ['result-busy'] },
    ],
  }, models), (error) => error.code === 'CANVAS_NODE_BUSY')
  const prepared = prepareCanvasActionSetProposal(base, { operations: [{ kind: 'update_text', nodeId: 'text-1', content: '已冻结' }] }, models, 'action-frozen')
  const changed = structuredClone(base)
  changed.nodes.find((node) => node.id === 'text-1').data.content = '协作者已修改'
  assert.throws(() => applyCanvasActionSet(changed, { actionId: 'action-frozen', ...prepared.arguments }, models),
    (error) => error.code === 'CANVAS_ACTION_SET_CONFLICT')
  const artifacts = new Map([[artifact.id, artifact]])
  const reuse = prepareCanvasActionSetProposal(base, { operations: [{ kind: 'project_artifact', temporaryId: 'old', artifactId: artifact.id, position: { x: 1, y: 1 } }] }, models, 'action-artifact', artifacts)
  const driftedArtifacts = new Map([[artifact.id, { ...artifact, updatedAt: 11 }]])
  assert.throws(() => applyCanvasActionSet(base, { actionId: 'action-artifact', ...reuse.arguments }, models, 20, driftedArtifacts),
    (error) => error.code === 'CANVAS_ARTIFACT_CONFLICT')
  assert.deepEqual(base, before)
})
