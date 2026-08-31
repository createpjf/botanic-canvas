// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentContextLlmSummaryEnabled,
  composeEnrichedCheckpoint,
  createAgentContextCheckpointEnricher,
  enrichAgentContextCheckpoint,
} from './agentContextSummarizer.mjs'
import { resolveAgentModelContextPolicy } from './agentModelContextPolicy.mjs'
import { createAgentModelContextRuntime } from './agentModelContextRuntime.mjs'
import { sanitizeAgentModelContextCheckpoint } from './agentModelContextSurface.mjs'
import { evaluateAgentContextShadow } from './agentContextShadowEvaluator.mjs'

const deterministic = [
  '本线程早前已经定下的事实（不是用户这一轮的新输入）：',
  '- 已确认决策：出两张首图。 [gpt-image-2 · 3:4 · 2K]（run-1）',
  '- 待确认行动：生成首图（generate_image）',
].join('\n')

test('AGENT_CONTEXT_LLM_SUMMARY 默认关闭', () => {
  assert.equal(agentContextLlmSummaryEnabled({}), false)
  assert.equal(agentContextLlmSummaryEnabled({ AGENT_CONTEXT_LLM_SUMMARY: 'true' }), true)
  assert.equal(agentContextLlmSummaryEnabled({ AGENT_CONTEXT_LLM_SUMMARY: 'TRUE' }), true)
  assert.equal(agentContextLlmSummaryEnabled({ AGENT_CONTEXT_LLM_SUMMARY: '1' }), false)
})

test('增强 checkpoint 保留确定性前缀，叙述只追加', () => {
  const content = composeEnrichedCheckpoint({
    deterministicContent: deterministic,
    narrative: '用户更倾向冷色，不要再提节日促销。',
    locale: 'zh-CN',
  })
  assert.ok(content.startsWith(deterministic))
  assert.match(content, /补充叙述（非权威/u)
  assert.match(content, /冷色/u)
  assert.equal(sanitizeAgentModelContextCheckpoint(content), content)
})

test('关 Flag 或缺少 invoker 时 enrich 恒等', async () => {
  const calls = []
  const off = await enrichAgentContextCheckpoint({
    deterministicContent: deterministic,
    enabled: false,
    invokeChat: async () => { calls.push('x'); return '不应出现' },
  })
  assert.equal(off.source, 'deterministic')
  assert.equal(off.content, sanitizeAgentModelContextCheckpoint(deterministic))
  assert.equal(calls.length, 0)

  const missing = await enrichAgentContextCheckpoint({
    deterministicContent: deterministic,
    enabled: true,
  })
  assert.equal(missing.source, 'deterministic')
})

test('开 Flag 时追加叙述；Provider 失败回退确定性', async () => {
  const ok = await enrichAgentContextCheckpoint({
    deterministicContent: deterministic,
    enabled: true,
    locale: 'zh-CN',
    invokeChat: async () => '更想要干净背景，不要花体字。',
  })
  assert.equal(ok.source, 'llm_augmented')
  assert.ok(ok.content.startsWith(sanitizeAgentModelContextCheckpoint(deterministic)))
  assert.match(ok.content, /干净背景/u)
  assert.match(ok.content, /gpt-image-2 · 3:4 · 2K/u)
  assert.match(ok.content, /待确认行动/u)

  const failed = await enrichAgentContextCheckpoint({
    deterministicContent: deterministic,
    enabled: true,
    invokeChat: async () => { throw new Error('gateway down') },
  })
  assert.equal(failed.source, 'deterministic_fallback')
  assert.equal(failed.content, sanitizeAgentModelContextCheckpoint(deterministic))
})

test('空叙述或非法响应回退确定性，不追加伪段落', async () => {
  const empty = await enrichAgentContextCheckpoint({
    deterministicContent: deterministic,
    enabled: true,
    invokeChat: async () => '   ',
  })
  assert.equal(empty.source, 'deterministic_fallback')
  assert.equal(empty.content, sanitizeAgentModelContextCheckpoint(deterministic))
  assert.equal(empty.content.includes('补充叙述'), false)
})

test('同一摘要基底连续压缩只调一次 LLM，命中缓存内容一致', async () => {
  let calls = 0
  const enricher = createAgentContextCheckpointEnricher({
    enabled: true,
    invokeChat: async () => { calls += 1; return '用户偏好冷色。' },
  })
  const first = await enricher({ deterministicContent: deterministic, trigger: 'pre_step', locale: 'zh-CN' })
  const second = await enricher({ deterministicContent: deterministic, trigger: 'pre_step', locale: 'zh-CN' })
  assert.equal(calls, 1)
  assert.equal(first.source, 'llm_augmented')
  assert.equal(second.content, first.content)
  // 基底变化则重新调用。
  await enricher({ deterministicContent: `${deterministic}\n- 新事实`, trigger: 'pre_step', locale: 'zh-CN' })
  assert.equal(calls, 2)
})

test('Provider 失败的回退不落缓存，恢复后重新增强', async () => {
  let healthy = false
  let calls = 0
  const enricher = createAgentContextCheckpointEnricher({
    enabled: true,
    invokeChat: async () => {
      calls += 1
      if (!healthy) throw new Error('gateway down')
      return '恢复后的叙述。'
    },
  })
  const failed = await enricher({ deterministicContent: deterministic, trigger: 'overflow' })
  assert.equal(failed.source, 'deterministic_fallback')
  healthy = true
  const recovered = await enricher({ deterministicContent: deterministic, trigger: 'overflow' })
  assert.equal(recovered.source, 'llm_augmented')
  assert.match(recovered.content, /恢复后的叙述/u)
  assert.equal(calls, 2)
})

test('Runtime 注入 enricher 后 checkpoint 含叙述且权威字段仍在', async () => {
  const policy = resolveAgentModelContextPolicy('test-model', {
    models: {
      'test-model': {
        contextWindowTokens: 4_096,
        outputReserveTokens: 512,
        safetyMarginTokens: 128,
        autoCompactRatio: 0.5,
        retainRecentRatio: 0.1,
      },
    },
  })
  const threadSummary = deterministic
  const enrichCheckpoint = createAgentContextCheckpointEnricher({
    enabled: true,
    invokeChat: async () => '用户否掉了暖色方案。',
  })
  const runtime = createAgentModelContextRuntime({
    policy,
    threadSummary,
    enrichCheckpoint,
  })
  const result = await runtime.prepare({
    trigger: 'overflow', force: true, maxOutputTokens: 500,
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: `old ${'a'.repeat(2_000)}` },
      { role: 'assistant', content: `answer ${'b'.repeat(2_000)}` },
      { role: 'user', content: 'current' },
    ],
    tools: [],
  })
  assert.equal(result.changed, true)
  const checkpointMessage = result.messages.find((message) => (
    typeof message.content === 'string' && message.content.includes('run-1')
  ))
  assert.ok(checkpointMessage)
  assert.match(checkpointMessage.content, /gpt-image-2 · 3:4 · 2K/u)
  assert.match(checkpointMessage.content, /待确认行动/u)
  assert.match(checkpointMessage.content, /暖色方案/u)
})

test('Shadow 评估不调用 LLM summarizer', () => {
  let calls = 0
  const policyModels = {
    models: {
      'shadow-model': {
        contextWindowTokens: 4_096,
        outputReserveTokens: 512,
        safetyMarginTokens: 128,
        autoCompactRatio: 0.9,
        retainRecentRatio: 0.1,
      },
    },
  }
  const evaluation = evaluateAgentContextShadow({
    sessionId: 'session-1',
    model: 'shadow-model',
    policies: policyModels,
    locale: 'zh-CN',
    currentMessageId: 'm-current',
    controlInputTokenCount: 100,
    messages: [
      { id: 'm-1', role: 'user', content: `early ${'x'.repeat(200)}`, createdAt: 1, updatedAt: 1 },
      { id: 'm-current', role: 'user', content: 'current', createdAt: 2, updatedAt: 2 },
    ],
    // 即使误传入也不得被 shadow 使用；shadow API 无此字段，这里只证明无副作用。
    invokeChat: async () => { calls += 1; return 'leak' },
  })
  assert.equal(calls, 0)
  assert.equal(typeof evaluation.policyHash, 'string')
  assert.equal(evaluation.kind === 'candidate' || evaluation.kind === 'no_change' || evaluation.kind === 'reused', true)
})
