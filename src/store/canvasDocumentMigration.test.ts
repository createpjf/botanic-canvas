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
