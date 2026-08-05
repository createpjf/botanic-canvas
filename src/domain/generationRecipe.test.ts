import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanvasDocument } from './canvas.ts'
import { buildGraphGenerationRecipe, cloneGenerationRecipe } from './generationRecipe.ts'

const settings = { model: 'gpt-image-2', aspectRatio: '3:4' as const, resolution: '2K' as const }

function documentWithOrderedInputs(): CanvasDocument {
  return {
    id: 'project-recipe',
    name: '配方测试',
    nodes: [
      { id: 'asset-a', type: 'asset', position: { x: 0, y: 0 }, data: { kind: 'asset', assetId: 'a', name: '商品', image: '/a', role: '商品', source: 'upload' } },
      { id: 'asset-b', type: 'asset', position: { x: 0, y: 100 }, data: { kind: 'asset', assetId: 'b', name: '场景', image: '/b', role: '场景', source: 'upload' } },
      { id: 'text-a', type: 'text', position: { x: 0, y: 200 }, data: { kind: 'text', label: '描述', content: '海边自然光' } },
      { id: 'generate-a', type: 'generate', position: { x: 300, y: 0 }, data: { kind: 'generate', label: '生成', prompt: '保持商品主体', batchCount: 2, settings, inputOrder: ['asset-b', 'asset-a', 'text-a'], primaryInputId: 'asset-a' } },
    ],
    edges: [
      { id: 'e-a', source: 'asset-a', target: 'generate-a' },
      { id: 'e-b', source: 'asset-b', target: 'generate-a' },
      { id: 'e-text', source: 'text-a', target: 'generate-a' },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
    assets: [], assetGroups: [], templates: [], history: [], deliveries: [], generationJobs: [], batchVariationRuns: [], agentSessions: [], agentMemory: [], agentRuns: [],
    updatedAt: 1,
  }
}

test('生成配方以连线和生成节点输入顺序为权威', () => {
  const result = buildGraphGenerationRecipe(documentWithOrderedInputs(), 'generate-a')

  assert.ok(result)
  assert.equal(result.prompt, '海边自然光\n保持商品主体')
  assert.deepEqual(result.recipe.references.map((reference) => reference.assetId), ['b', 'a'])
  assert.equal(result.recipe.primaryReferenceNodeId, 'asset-a')
  assert.equal(result.recipe.batchCount, 2)
})

test('复制配方不会共享设置或参考项引用', () => {
  const source = buildGraphGenerationRecipe(documentWithOrderedInputs(), 'generate-a')!.recipe
  const copy = cloneGenerationRecipe(source)

  copy.settings.model = 'other-model'
  copy.references[0].name = '已修改'
  assert.equal(source.settings.model, 'gpt-image-2')
  assert.equal(source.references[0].name, '场景')
})
