import assert from 'node:assert/strict'
import test from 'node:test'
import { createGenerationModelCatalog, generationJobTimedOut, generationTimeoutForModel, providerForModel, timedOutGenerationJobPatch } from './generationModels.mjs'

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

test('有 Flock key 才出现 Nano Banana，并声明十档比例、4K 与 14 张参考', () => {
  const withoutKey = createGenerationModelCatalog({
    openAIApiKey: 'openai-key',
    openAIModels: ['gpt-image-2'],
    flockApiKey: '',
    flockImageModels: ['gemini-3.1-flash-image-preview'],
    flockNanoBananaEnabled: true,
  })
  assert.equal(withoutKey.some((model) => model.id === 'gemini-3.1-flash-image-preview'), false)

  const catalog = createGenerationModelCatalog({
    openAIApiKey: 'openai-key',
    openAIModels: ['gpt-image-2'],
    flockApiKey: 'flock-key',
    flockImageModels: ['gemini-3.1-flash-image-preview'],
    flockNanoBananaEnabled: true,
  })
  const nanoBanana = catalog.find((model) => model.id === 'gemini-3.1-flash-image-preview')
  assert.equal(nanoBanana?.label, 'Nano Banana 2')
  assert.equal(nanoBanana?.provider, 'flock')
  assert.equal(nanoBanana?.supportsMask, false)
  assert.equal(nanoBanana?.supportsCustomSize, false)
  assert.equal(nanoBanana?.supportsSearchGrounding, true)
  assert.deepEqual(nanoBanana?.thinkingLevels, ['minimal', 'high'])
  assert.equal(nanoBanana?.maximumReferences, 14)
  assert.deepEqual(nanoBanana?.aspectRatios, [
    '1:1', '16:9', '4:3', '3:4', '4:5', '9:16', '3:2', '2:3', '5:4', '21:9',
  ])
  assert.deepEqual(nanoBanana?.resolutions, ['1K', '2K', '4K'])
  assert.equal(catalog[0].id, 'gpt-image-2')
})

test('未知 Flock 型号不会冒充 Nano Banana 能力进入目录', () => {
  const catalog = createGenerationModelCatalog({
    flockApiKey: 'flock-key',
    flockImageModels: ['unknown-image-model', 'gemini-3.1-flash-image-preview'],
    flockNanoBananaEnabled: true,
  })
  assert.deepEqual(catalog.map((model) => model.id), ['gemini-3.1-flash-image-preview'])
})

test('Nano Banana 只接受 Flock 目录中的 image-preview 型号，旧 Pro 型号不进入可执行目录', () => {
  const catalog = createGenerationModelCatalog({
    flockApiKey: 'flock-key',
    flockImageModels: ['gemini-3.1-pro-preview', 'gemini-3.1-flash-image-preview'],
    flockNanoBananaEnabled: true,
  })
  assert.deepEqual(catalog.map((model) => model.id), ['gemini-3.1-flash-image-preview'])
})

test('Vertex 未恢复时 Nano Banana 即使已配置也不进入可执行目录', () => {
  const catalog = createGenerationModelCatalog({
    flockApiKey: 'flock-key',
    flockImageModels: ['gemini-3.1-flash-image-preview'],
  })
  assert.equal(providerForModel(catalog, 'gemini-3.1-flash-image-preview'), undefined)
  const health = createGenerationModelCatalog({
    flockApiKey: 'flock-key',
    flockImageModels: ['gemini-3.1-flash-image-preview'],
    includeUnavailable: true,
  })
  assert.equal(health[0]?.available, false)
  assert.equal(providerForModel(health, 'gemini-3.1-flash-image-preview'), undefined)
})

test('Flock key 不能单独启用图片模型，健康目录会把未显式声明的 Nano Banana 标为不可用', () => {
  const catalog = createGenerationModelCatalog({
    flockApiKey: 'flock-key',
    flockImageModels: [],
    includeUnavailable: true,
  })
  assert.equal(catalog.length, 1)
  assert.equal(catalog[0].id, 'gemini-3.1-flash-image-preview')
  assert.equal(catalog[0].available, false)
  assert.match(catalog[0].unavailableReason, /上游暂不可用|已临时下线/u)
  assert.equal(providerForModel(catalog, catalog[0].id), undefined)
})

test('读时超时收口写 errorCode，重试策略才分类得了', () => {
  // 端到端冒烟实测到的缺陷：任务 300 秒后收口为 failed，errorCode 却是 undefined。
  // agentBranchRetryPolicy 于是返回 error_code_unknown 停在待人工，永远不自动重试 ——
  // 而 PROVIDER_TIMEOUT 恰恰在它的可重试白名单里。
  const patch = timedOutGenerationJobPatch({ now: 500 })
  assert.equal(patch.status, 'failed')
  assert.equal(patch.errorCode, 'PROVIDER_TIMEOUT', '错误码必须与 Worker 侧同一个值')
  assert.equal(patch.updatedAt, 500)
  assert.match(patch.error, /超过模型等待时限/u)
})

test('只有仍在排队/执行且确实超时的任务才被收口', () => {
  const at = (status, createdAt) => generationJobTimedOut({ status, createdAt }, { maximumTaskDurationMs: 1000, now: 1000 })
  assert.equal(at('running', 0), true)
  assert.equal(at('queued', 0), true)
  // 差一毫秒不算超时。
  assert.equal(at('running', 1), false)
  // 已经到终态的任务不该被这条路径改写 —— 那会把一次成功覆盖成失败。
  assert.equal(at('succeeded', 0), false)
  assert.equal(at('failed', 0), false)
  assert.equal(at('cancelled', 0), false)
  // 时限无效时不做任何判定，宁可不收口也不误杀。
  assert.equal(generationJobTimedOut({ status: 'running', createdAt: 0 }, { maximumTaskDurationMs: NaN, now: 9e9 }), false)
})
