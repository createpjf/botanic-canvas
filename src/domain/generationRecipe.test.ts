import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanvasDocument } from './canvas.ts'
import { buildGraphGenerationRecipe, cloneGenerationRecipe, settingsForGenerationModel } from './generationRecipe.ts'

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

test('文字节点与生成节点描述相同时只提交一次 Prompt', () => {
  const document = documentWithOrderedInputs()
  const text = document.nodes.find((node) => node.id === 'text-a')
  if (text?.type === 'text') text.data.content = '保持商品主体'

  const result = buildGraphGenerationRecipe(document, 'generate-a')

  assert.equal(result?.prompt, '保持商品主体')
})

test('生成节点没有自带 Prompt 时只用已连接文本节点', () => {
  const document = documentWithOrderedInputs()
  const generate = document.nodes.find((node) => node.id === 'generate-a')
  if (generate?.type === 'generate') generate.data.prompt = ''

  const result = buildGraphGenerationRecipe(document, 'generate-a')
  assert.equal(result?.prompt, '海边自然光')
})

test('复制配方不会共享设置或参考项引用', () => {
  const source = buildGraphGenerationRecipe(documentWithOrderedInputs(), 'generate-a')!.recipe
  const copy = cloneGenerationRecipe(source)

  copy.settings.model = 'other-model'
  copy.references[0].name = '已修改'
  assert.equal(source.settings.model, 'gpt-image-2')
  assert.equal(source.references[0].name, '场景')
})

test('切换模型保留被新模型支持的设置并补齐视频时长', () => {
  const result = settingsForGenerationModel(
    { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '2K' },
    { id: 'video-model', label: '视频', mediaKind: 'video', aspectRatios: ['1:1', '16:9'], resolutions: ['2K'], durations: [5, 10], defaultDuration: 10 },
  )

  assert.deepEqual(result, { model: 'video-model', aspectRatio: '1:1', resolution: '2K', duration: 10 })
})

test('复制配方保留 gpt-image-2 自定义像素，换到不支持的模型时丢弃', () => {
  const source = buildGraphGenerationRecipe(documentWithOrderedInputs(), 'generate-a')!.recipe
  source.settings.outputWidth = 1920
  source.settings.outputHeight = 1080
  const copy = cloneGenerationRecipe(source)
  assert.equal(copy.settings.outputWidth, 1920)
  assert.equal(copy.settings.outputHeight, 1088)
  copy.settings.outputWidth = 1
  assert.equal(source.settings.outputWidth, 1920)

  const minimax = settingsForGenerationModel(copy.settings, {
    id: 'image-01', label: 'MiniMax Image 01', provider: 'minimax', mediaKind: 'image',
    aspectRatios: ['1:1', '16:9', '4:3', '3:4', '9:16'], resolutions: ['1K'],
  })
  assert.equal('outputWidth' in minimax, false)
  assert.equal('outputHeight' in minimax, false)

  const gpt = settingsForGenerationModel({
    model: 'image-01', aspectRatio: '16:9', resolution: '1K', outputWidth: 1920, outputHeight: 1088,
  }, { id: 'gpt-image-2', label: 'GPT Image 2', provider: 'openai', mediaKind: 'image', supportsCustomSize: true, aspectRatios: ['1:1', '16:9'], resolutions: ['1K', '2K'] })
  assert.equal(gpt.outputWidth, 1920)
  assert.equal(gpt.outputHeight, 1088)
})
