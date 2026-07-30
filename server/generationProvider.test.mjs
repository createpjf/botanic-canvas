import assert from 'node:assert/strict'
import test from 'node:test'
import { GenerationError, validateGenerationInput } from './generationProvider.mjs'

const image = 'data:image/png;base64,iVBORw0KGgo='

test('生成配方在进入 Redis 队列前完成模型、尺寸和图片约束校验', () => {
  const input = validateGenerationInput({
    projectId: 'project-a', kind: 'generation', prompt: '香氛商品主图', batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
    recipe: { references: [{ name: '主商品', role: '商品', primary: true, dataUrl: image }] },
  }, { models: ['gpt-image-2'], maximumBatchCount: 8, maximumReferenceBytes: 1024 })
  assert.equal(input.references[0].mimeType, 'image/png')
  assert.equal(input.settings.aspectRatio, '3:4')
  assert.throws(() => validateGenerationInput({
    projectId: 'project-a', kind: 'generation', prompt: 'x', batchCount: 1,
    settings: { model: 'other-model', aspectRatio: '1:1', resolution: '1K' },
    recipe: { references: [{ dataUrl: image }] },
  }, { models: ['gpt-image-2'], maximumBatchCount: 8, maximumReferenceBytes: 1024 }), (error) => error instanceof GenerationError && error.code === 'INVALID_REQUEST')
})
