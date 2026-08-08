import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanvasDocument } from './canvas.ts'
import { productionWorkflowDraftFromCanvas } from './productionWorkflows.ts'

const document = {
  schemaVersion: 25,
  id: 'project-a', name: '品牌项目', updatedAt: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  assets: [{ id: 'asset-a', name: '商品', role: '商品', image: '/api/media/media-a', source: 'upload', tags: [] }],
  assetGroups: [{ id: 'group-a', name: '商品组', role: '商品', assetIds: ['asset-a'], createdAt: 1, updatedAt: 1 }],
  templates: [], history: [], deliveries: [], generationJobs: [], batchVariationRuns: [], agentSessions: [],
  agentMemory: [{ id: 'memory-a', kind: 'rule', content: '保持植物学留白', sourceNodeIds: [], createdAt: 1, updatedAt: 1 }],
  agentRuns: [{
    id: 'run-a', status: 'completed', createdAt: 1, updatedAt: 2, completedBranchCount: 1, failedBranchCount: 0,
    branches: [], plan: {} as never,
  }],
  nodes: [
    { id: 'asset-node', type: 'asset', position: { x: 0, y: 0 }, data: { kind: 'asset', assetId: 'asset-a', role: '商品', name: '商品', image: '/api/media/media-a', source: 'upload' } },
    { id: 'generate-node', type: 'generate', position: { x: 300, y: 0 }, data: {
      kind: 'generate', label: '品牌首图', prompt: '生成植物学品牌首图', batchCount: 2,
      settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
      agentRun: { runId: 'run-a', branchId: 'branch-a' },
    } },
  ],
  edges: [{ id: 'edge-a', source: 'asset-node', target: 'generate-node' }],
} satisfies CanvasDocument

test('已验证 Agent 画布操作可提升为不包含媒体字节的版本化生产工作流定义', () => {
  const draft = productionWorkflowDraftFromCanvas(document)
  assert.ok(draft)
  assert.equal(draft.sourceAgentRunId, 'run-a')
  assert.equal(draft.definition.model, 'gpt-image-2')
  assert.deepEqual(draft.definition.assetGroupIds, ['group-a'])
  assert.deepEqual(draft.definition.brandRules, ['保持植物学留白'])
  assert.equal(draft.definition.settings.batchCount, 2)
  assert.doesNotMatch(JSON.stringify(draft.definition), /\/api\/media|base64/)
  assert.equal((draft.definition.recipe?.references as Array<{ assetId: string }>)[0].assetId, 'asset-a')
})

test('尚未完成的 Agent 操作不能静默保存为生产工作流', () => {
  const pending = structuredClone(document)
  pending.agentRuns[0].status = 'running'
  assert.equal(productionWorkflowDraftFromCanvas(pending), null)
})
