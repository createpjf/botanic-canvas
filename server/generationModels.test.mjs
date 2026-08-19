import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createGenerationModelCatalog,
  generationTimeoutForModel,
  providerForModel,
} from './generationModels.mjs'

test('模型目录只公开已配置供应商，并声明每个模型的媒体能力', () => {
  const catalog = createGenerationModelCatalog({
    openAIApiKey: '',
    openAIModels: ['gpt-image-2'],
    miniMaxApiKey: 'minimax-key',
    miniMaxImageModels: ['image-01'],
    miniMaxVideoModels: ['MiniMax-H3'],
  })

  assert.deepEqual(catalog.map((model) => [model.id, model.provider, model.mediaKind]), [
    ['image-01', 'minimax', 'image'],
    ['MiniMax-H3', 'minimax', 'video'],
  ])
  assert.deepEqual(catalog[1].resolutions, ['2K'])
  assert.deepEqual(catalog[1].durations, [5, 10, 15])
  assert.equal(catalog[1].label, 'MiniMax H3')
  assert.equal(providerForModel(catalog, 'MiniMax-H3').provider, 'minimax')
  assert.equal(generationTimeoutForModel(catalog, 'MiniMax-H3', {
    imageTimeoutMs: 300_000,
    videoTimeoutMs: 1_200_000,
  }), 1_200_000)
})

test('gpt-image-2 打开 16:9 / 4:3 与自定义像素，其它 GPT 模型保持竖图四档', () => {
  const catalog = createGenerationModelCatalog({
    openAIApiKey: 'openai-key',
    openAIModels: ['gpt-image-2', 'gpt-image-1'],
    miniMaxApiKey: '',
  })

  assert.deepEqual(catalog.find((model) => model.id === 'gpt-image-2')?.aspectRatios, [
    '1:1', '16:9', '4:3', '3:4', '4:5', '9:16',
  ])
  assert.equal(catalog.find((model) => model.id === 'gpt-image-2')?.supportsCustomSize, true)
  assert.deepEqual(catalog.find((model) => model.id === 'gpt-image-1')?.aspectRatios, [
    '1:1', '3:4', '4:5', '9:16',
  ])
  assert.equal(catalog.find((model) => model.id === 'gpt-image-1')?.supportsCustomSize, undefined)
})
