import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ProviderCircuitBreaker,
  buildGenerationUsage,
  compatibleFallbackModel,
  generationBudgetDecision,
  summarizeGenerationUsage,
} from './generationGovernance.mjs'

const imageInput = {
  projectId: 'project-a', batchCount: 2,
  settings: { model: 'image-a', aspectRatio: '1:1', resolution: '2K' },
}

test('生成用量以任务为唯一记账单元，并可按项目、成员和模型聚合', () => {
  const usage = buildGenerationUsage(imageInput, {
    jobId: 'job-a', workspaceId: 'workspace-default', memberId: 'member-a', mediaKind: 'image', provider: 'provider-a',
  })
  assert.deepEqual(usage, {
    version: 1, jobId: 'job-a', workspaceId: 'workspace-default', projectId: 'project-a', memberId: 'member-a',
    model: 'image-a', provider: 'provider-a', mediaKind: 'image', outputCount: 2, costUnits: 4,
  })
  assert.deepEqual(summarizeGenerationUsage([
    { id: 'job-a', usage },
    { id: 'job-a', usage },
    { id: 'job-b', usage: { ...usage, jobId: 'job-b', model: 'image-b', costUnits: 3 } },
  ]), { totalCostUnits: 7, taskCount: 2, byModel: { 'image-a': 4, 'image-b': 3 } })
})

test('预算在临界值提醒、超额阻止，幂等旧任务不参与二次扣费', () => {
  assert.deepEqual(generationBudgetDecision({ used: 80, requested: 10, limit: 100, warningRatio: 0.85 }), {
    allowed: true, warning: true, remaining: 10,
  })
  assert.deepEqual(generationBudgetDecision({ used: 95, requested: 10, limit: 100 }), {
    allowed: false, warning: true, remaining: 5,
  })
})

test('Provider 熔断器覆盖超时、熔断、半开探测和恢复', () => {
  let now = 1_000
  const breaker = new ProviderCircuitBreaker({ failureThreshold: 2, cooldownMs: 1_000, now: () => now })
  assert.equal(breaker.canRequest('provider-a').allowed, true)
  breaker.recordFailure('provider-a', { code: 'PROVIDER_TIMEOUT' })
  assert.equal(breaker.snapshot('provider-a').state, 'closed')
  breaker.recordFailure('provider-a', { code: 'PROVIDER_UNAVAILABLE' })
  assert.equal(breaker.canRequest('provider-a').allowed, false)
  now = 2_001
  assert.deepEqual(breaker.canRequest('provider-a'), { allowed: true, state: 'half-open' })
  breaker.recordSuccess('provider-a')
  assert.equal(breaker.snapshot('provider-a').state, 'closed')
})

test('只有媒体、输入角色、比例和清晰度语义兼容时才允许 Provider 降级', () => {
  const catalog = [
    { id: 'image-a', provider: 'provider-a', mediaKind: 'image', aspectRatios: ['1:1'], resolutions: ['2K'], inputRoles: ['reference_image'] },
    { id: 'image-compatible', provider: 'provider-b', mediaKind: 'image', aspectRatios: ['1:1'], resolutions: ['2K'], inputRoles: ['reference_image'] },
    { id: 'image-incompatible', provider: 'provider-c', mediaKind: 'image', aspectRatios: ['1:1'], resolutions: ['1K'], inputRoles: ['reference_image'] },
    { id: 'video-a', provider: 'provider-d', mediaKind: 'video', aspectRatios: ['1:1'], resolutions: ['2K'] },
  ]
  assert.equal(compatibleFallbackModel({ catalog, input: imageInput, candidateIds: ['image-incompatible', 'image-compatible'] })?.id, 'image-compatible')
  assert.equal(compatibleFallbackModel({ catalog, input: imageInput, candidateIds: ['image-incompatible', 'video-a'] }), undefined)
})

test('Provider 降级不得丢失蒙版、参考上限或模型专属设置', () => {
  const catalog = [
    {
      id: 'gpt-image-2', provider: 'openai', mediaKind: 'image', aspectRatios: ['1:1'], resolutions: ['2K'],
      supportsMask: true, supportsCustomSize: true, maximumReferences: 8,
    },
    {
      id: 'nano', provider: 'flock', mediaKind: 'image', aspectRatios: ['1:1'], resolutions: ['2K'],
      supportsMask: false, supportsCustomSize: false, supportsSearchGrounding: true,
      thinkingLevels: ['minimal', 'high'], maximumReferences: 14,
    },
  ]
  const maskInput = {
    ...imageInput,
    settings: { ...imageInput.settings, model: 'gpt-image-2' },
    maskRegion: { x: 0, y: 0, width: 0.5, height: 0.5 },
  }
  assert.equal(compatibleFallbackModel({ catalog, input: maskInput, candidateIds: ['nano'] }), undefined)
  assert.equal(compatibleFallbackModel({
    catalog,
    input: { ...maskInput, maskRegion: undefined, settings: { ...maskInput.settings, outputWidth: 1024, outputHeight: 1024 } },
    candidateIds: ['nano'],
  }), undefined)
  assert.equal(compatibleFallbackModel({
    catalog,
    input: {
      ...imageInput,
      settings: { ...imageInput.settings, model: 'nano', searchGrounding: true, thinkingLevel: 'high' },
      references: Array.from({ length: 9 }, () => ({})),
    },
    candidateIds: ['gpt-image-2'],
  }), undefined)
})
