import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveAgentModelContextPolicy } from '../model/agentModelContextPolicy.mjs'
import { createAgentModelContextSurface } from '../model/agentModelContextSurface.mjs'
import {
  AgentTokenMeterError,
  createAgentTokenUsageAnchor,
  measureAgentModelContextSurface,
  normalizeAgentProviderUsage,
} from './agentTokenMeter.mjs'

function fixture(messages, options = {}) {
  const policy = resolveAgentModelContextPolicy('planner', options.policies)
  const surface = createAgentModelContextSurface({
    model: 'planner', policyHash: policy.hash, outputReserveTokens: policy.outputReserveTokens,
    messages,
    tools: options.tools ?? [],
  })
  return { policy, surface }
}

test('Token Meter 给出 system/message/tool/media/structure 可核对分解', () => {
  const { policy, surface } = fixture([
    { role: 'system', content: '你是植物助手' },
    { role: 'user', content: [{ type: 'text', text: '识别它' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,U0VDUkVU' } }] },
  ], {
    tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
  })
  const meter = measureAgentModelContextSurface(surface, { policy })
  assert.equal(meter.source, 'heuristic')
  assert.equal(meter.breakdown.mediaTokens, policy.mediaTokensPerItem)
  assert.ok(meter.breakdown.systemTokens > 0)
  assert.ok(meter.breakdown.messageTokens > 0)
  assert.ok(meter.breakdown.toolDefinitionTokens > 0)
  assert.equal(
    Object.values(meter.breakdown).reduce((total, value) => total + value, 0),
    meter.heuristicInputTokens,
  )
  assert.equal(meter.inputTokens, meter.heuristicInputTokens)
})

test('Token Meter 以总上下文阈值触发 auto compaction，并单独标识硬超限', () => {
  const near = fixture([{ role: 'user', content: 'a'.repeat(20_000) }])
  const nearMeter = measureAgentModelContextSurface(near.surface, { policy: near.policy })
  assert.equal(nearMeter.shouldCompact, true)
  assert.equal(nearMeter.overLimit, false)

  const over = fixture([{ role: 'user', content: 'a'.repeat(30_000) }])
  const overMeter = measureAgentModelContextSurface(over.surface, { policy: over.policy })
  assert.equal(overMeter.shouldCompact, true)
  assert.equal(overMeter.overLimit, true)
  assert.equal(overMeter.remainingInputTokens, 0)
})

test('Token Meter 用 provider usage 建立精确锚点并保存安全字段', () => {
  const { policy, surface } = fixture([{ role: 'user', content: '绝密 prompt' }])
  const heuristic = measureAgentModelContextSurface(surface, { policy })
  const anchor = createAgentTokenUsageAnchor({
    surface,
    meter: heuristic,
    usage: { prompt_tokens: 1_234, completion_tokens: 56, total_tokens: 1_290 },
    provider: 'deepseek', turnId: 'turn-1', step: 0, observedAt: 1_787_875_200_000,
  })
  const anchored = measureAgentModelContextSurface(surface, { policy, usageAnchor: anchor })
  assert.equal(anchored.source, 'provider_anchor')
  assert.equal(anchored.anchoredInputTokens, 1_234)
  assert.equal(anchored.inputTokens, 1_234)
  assert.doesNotMatch(JSON.stringify(anchor), /绝密 prompt/)
  assert.equal(anchor.outputTokens, 56)
  assert.equal(anchor.observedAt, 1_787_875_200_000)
})

test('Token Meter 同 static surface 对新增历史使用 provider anchor + heuristic delta', () => {
  const base = fixture([
    { role: 'system', content: '规则' },
    { role: 'user', content: '第一问' },
  ])
  const baseMeter = measureAgentModelContextSurface(base.surface, { policy: base.policy })
  const anchor = createAgentTokenUsageAnchor({
    surface: base.surface, meter: baseMeter, usage: { input_tokens: 500 },
  })
  const appended = createAgentModelContextSurface({
    model: 'planner', policyHash: base.policy.hash, outputReserveTokens: base.policy.outputReserveTokens,
    messages: [
      { role: 'system', content: '规则' },
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '新增回答'.repeat(30) },
    ],
  })
  assert.equal(appended.staticHash, base.surface.staticHash)
  const delta = measureAgentModelContextSurface(appended, { policy: base.policy, usageAnchor: anchor })
  assert.equal(delta.source, 'provider_anchor_delta')
  assert.equal(delta.anchoredInputTokens, 500 + delta.heuristicInputTokens - baseMeter.heuristicInputTokens)
  assert.ok(delta.inputTokens > 500)
})

test('Token Meter 忽略 model/static 不匹配锚点，拒绝 policy/surface 漂移', () => {
  const { policy, surface } = fixture([{ role: 'user', content: '问题' }])
  const meter = measureAgentModelContextSurface(surface, {
    policy,
    usageAnchor: { version: 1, model: 'other', staticHash: 'other', inputTokens: 9_999, heuristicInputTokens: 1 },
  })
  assert.equal(meter.source, 'heuristic')
  assert.throws(
    () => measureAgentModelContextSurface(surface, { policy: { ...policy, model: 'other' } }),
    AgentTokenMeterError,
  )
})

test('Provider usage 兼容 snake/camel 并严格校验数值', () => {
  assert.deepEqual(normalizeAgentProviderUsage({ inputTokens: 10, outputTokens: 2, totalTokens: 12 }), {
    inputTokens: 10, outputTokens: 2, totalTokens: 12,
  })
  assert.deepEqual(normalizeAgentProviderUsage({ total_tokens: 20, completion_tokens: 5 }), {
    inputTokens: 15, outputTokens: 5, totalTokens: 20,
  })
  assert.equal(normalizeAgentProviderUsage({ completion_tokens: 5 }), undefined)
  assert.throws(() => normalizeAgentProviderUsage({ prompt_tokens: -1 }), AgentTokenMeterError)
  assert.throws(
    () => normalizeAgentProviderUsage({ total_tokens: 2, completion_tokens: 3 }),
    AgentTokenMeterError,
  )
})
