import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanvasDocument } from '../domain/canvas.ts'
import { normalizeCanvasDocumentBase } from './canvasDocumentMigration.ts'

test('画布文档规范化统一版本、清理旧演示文案并保护系统输出连线', () => {
  const stored: CanvasDocument = {
    id: 'legacy-project',
    name: '旧项目 · Mock 生成',
    schemaVersion: 24,
    nodes: [
      { id: 'generate-a', type: 'generate', position: { x: 0, y: 0 }, data: { kind: 'generate', label: '首图生成', prompt: '', batchCount: 1, settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' } } },
      { id: 'result-a', type: 'result', position: { x: 400, y: 0 }, data: { kind: 'result', label: '结果', status: 'ready', image: '/result.webp' } },
    ],
    edges: [{ id: 'output-a', source: 'generate-a', target: 'result-a' }],
    viewport: { x: 0, y: 0, zoom: 1 },
    assets: [{ id: 'brand-a', name: '品牌', image: '/brand.webp', role: '商品', source: 'brand', tags: [] }],
    assetGroups: [], templates: [], history: [], deliveries: [], generationJobs: [], batchVariationRuns: [], agentSessions: [], agentMemory: [], agentRuns: [], updatedAt: 1,
  }

  const normalized = normalizeCanvasDocumentBase(stored, stored)
  const outputEdge = normalized.edges.find((edge) => edge.id === 'output-a')

  assert.equal(normalized.schemaVersion, 25)
  assert.equal(normalized.name, '旧项目')
  assert.equal(normalized.assets.length, 0)
  assert.equal((normalized.nodes[0].data as { label?: string }).label, '图像生成')
  assert.equal(outputEdge?.reconnectable, false)
  assert.deepEqual(outputEdge?.data, { system: true, role: 'output' })
})

test('画布文档规范化保留无父结果和根配方的首次生成 Run', () => {
  const stored: CanvasDocument = {
    id: 'initial-generation-project',
    name: '首次生成',
    schemaVersion: 25,
    nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, assets: [], assetGroups: [],
    templates: [], history: [], deliveries: [], generationJobs: [], batchVariationRuns: [],
    agentSessions: [], agentMemory: [], updatedAt: 1,
    agentRuns: [{
      id: 'agent-run-initial', status: 'queued', createdAt: 1, updatedAt: 1,
      completedBranchCount: 0, failedBranchCount: 0, branches: [],
      plan: {
        intent: 'initial_generation', instruction: '生成广告图', summary: '首次生成',
        contextSnapshot: [{ nodeId: 'asset-product', label: '商品图', kind: '素材', mediaKind: 'image' }],
        references: [{ source: 'context_node', id: 'asset-product', label: '商品图' }], constraints: [],
        prompt: '生成广告图', settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
        output: { mode: 'single', count: 1, candidatesPerItem: 1 },
      },
    }],
  }

  const normalized = normalizeCanvasDocumentBase(stored, stored)

  assert.equal(normalized.agentRuns[0].plan.intent, 'initial_generation')
  assert.equal(normalized.agentRuns[0].plan.rootRecipe, undefined)
  assert.equal(normalized.agentRuns[0].plan.selectedResultNodeId, undefined)
})

test('画布文档规范化保留生产工作流版本与历史运行血缘', () => {
  const stored = {
    id: 'workflow-project', name: '工作流项目', schemaVersion: 25,
    nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, assets: [], assetGroups: [],
    templates: [], history: [], deliveries: [], generationJobs: [], batchVariationRuns: [],
    agentSessions: [], agentMemory: [], agentRuns: [], updatedAt: 1,
    productionWorkflows: [{
      id: 'workflow-a', projectId: 'workflow-project', name: '品牌首图', currentVersion: 1,
      versions: [{ version: 1, definition: {
        prompt: '品牌首图', model: 'gpt-image-2', settings: {}, output: {}, brandRules: [], assetGroupIds: [], confirmationPolicy: 'before-submit',
      }, createdAt: 1, createdBy: 'owner-a' }],
      createdAt: 1, createdBy: 'owner-a', updatedAt: 1, updatedBy: 'owner-a',
    }],
    productionWorkflowRuns: [{
      id: 'run-a', workflowId: 'workflow-a', workflowVersion: 1, projectId: 'workflow-project',
      definition: { prompt: '品牌首图', model: 'gpt-image-2', settings: {}, output: {}, brandRules: [], assetGroupIds: [], confirmationPolicy: 'before-submit' },
      status: 'succeeded', items: [{ id: 'item-a', index: 0, input: {}, status: 'succeeded', attempt: 1, idempotencyKey: 'workflow:run-a:item-a', artifactIds: ['artifact-a'], canvasNodeIds: ['node-a'], updatedAt: 2 }],
      createdAt: 1, createdBy: 'owner-a', updatedAt: 2,
    }],
  } as CanvasDocument

  const normalized = normalizeCanvasDocumentBase(stored, stored)
  assert.equal(normalized.productionWorkflows?.[0].versions[0].definition.prompt, '品牌首图')
  assert.deepEqual(normalized.productionWorkflowRuns?.[0].items[0].artifactIds, ['artifact-a'])
  assert.deepEqual(normalized.productionWorkflowRuns?.[0].items[0].canvasNodeIds, ['node-a'])
})
