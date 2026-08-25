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
