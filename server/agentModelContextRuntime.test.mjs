import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveAgentModelContextPolicy } from './agentModelContextPolicy.mjs'
import { createAgentModelContextRuntime } from './agentModelContextRuntime.mjs'
import { sanitizeAgentModelContextCheckpoint } from './agentModelContextSurface.mjs'

const policy = resolveAgentModelContextPolicy('test-model', {
  models: {
    'test-model': {
      contextWindowTokens: 4_096,
      outputReserveTokens: 512,
      safetyMarginTokens: 128,
      autoCompactRatio: 0.5,
      retainRecentRatio: 0.1,
      toolResultPrune: { thresholdCodePoints: 256, headCodePoints: 100, tailCodePoints: 40 },
    },
  },
})

test('Model Context Runtime 按 measure→prune→compact 顺序返回安全 prepared', async () => {
  const runtime = createAgentModelContextRuntime({ policy, provider: 'test-provider' })
  const prepared = await runtime.prepare({
    trigger: 'pre_step', maxOutputTokens: 500,
    messages: [
      { role: 'system', content: '系统边界' },
      { role: 'user', content: `早期目标 ${'中'.repeat(900)}` },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: `结果 ${'数'.repeat(500)}` },
      { role: 'user', content: `当前问题 ${'问'.repeat(900)}` },
    ],
    tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
  })
  assert.equal(prepared.changed, true)
  assert.ok(prepared.prepared.operations.some((operation) => operation.type === 'tool_result_prune'))
  assert.ok(prepared.prepared.operations.some((operation) => operation.type === 'checkpoint_replace'))
  assert.equal(JSON.stringify(prepared.prepared).includes('当前问题'), false)
  assert.equal(prepared.messages.at(-1).content.includes('当前问题'), true)
})

test('overflow force 只有 surface 真变化时才允许 ToolLoop 重试', async () => {
  const runtime = createAgentModelContextRuntime({ policy })
  const short = await runtime.prepare({
    trigger: 'overflow', force: true, maxOutputTokens: 500,
    messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'current' }],
    tools: [],
  })
  assert.equal(short.changed, false)

  const long = await runtime.prepare({
    trigger: 'overflow', force: true, maxOutputTokens: 500,
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: `old ${'a'.repeat(2_000)}` },
      { role: 'assistant', content: `answer ${'b'.repeat(2_000)}` },
      { role: 'user', content: 'current' },
    ],
    tools: [],
  })
  assert.equal(long.changed, true)
})

test('overflow 比日常 pre_step 替换更多前缀，只保住当前用户 unit', async () => {
  const runtime = createAgentModelContextRuntime({ policy })
  const messages = [
    { role: 'system', content: '系统边界' },
    { role: 'user', content: `早期 ${'早'.repeat(800)}` },
    { role: 'assistant', content: `中间 ${'中'.repeat(120)}` },
    { role: 'user', content: '当前问题' },
  ]
  const tools = []
  const daily = await runtime.prepare({
    trigger: 'pre_step', force: true, maxOutputTokens: 500, messages, tools,
  })
  const overflow = await runtime.prepare({
    trigger: 'overflow', force: true, maxOutputTokens: 500, messages, tools,
  })
  assert.equal(daily.changed, true)
  assert.equal(overflow.changed, true)
  const dailyReplace = daily.prepared.operations.find((operation) => operation.type === 'checkpoint_replace')
  const overflowReplace = overflow.prepared.operations.find((operation) => operation.type === 'checkpoint_replace')
  assert.ok(dailyReplace && overflowReplace)
  assert.ok(
    overflowReplace.replacedMessageRevisions.length > dailyReplace.replacedMessageRevisions.length,
    'overflow 应比 pre_step 多砍可替换历史',
  )
  assert.equal(overflow.messages.at(-1).content, '当前问题')
  assert.equal(
    overflow.messages.filter((message) => message.role === 'assistant').length,
    0,
    'overflow 不得保留中间 assistant',
  )
})

test('Provider usage 仅形成数值锚点并最佳努力持久化', async () => {
  const writes = []
  const runtime = createAgentModelContextRuntime({
    policy,
    provider: 'flock-api',
    runtimeIdentity: { turnId: 'turn-1' },
    persistUsageAnchor: async (anchor) => { writes.push(anchor) },
  })
  const preparation = await runtime.prepare({
    trigger: 'pre_step', maxOutputTokens: 500,
    messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }],
    tools: [],
  })
  const anchor = await runtime.observe({
    step: 2,
    prepared: preparation.prepared,
    responseUsage: { inputTokens: 123, outputTokens: 7, totalTokens: 130 },
  })
  assert.equal(anchor.inputTokens, 123)
  assert.equal(anchor.outputTokens, 7)
  assert.equal(anchor.provider, 'flock-api')
  assert.equal(anchor.turnId, 'turn-1')
  assert.equal(anchor.step, 2)
  assert.equal(Number.isSafeInteger(anchor.observedAt), true)
  assert.equal(writes.length, 1)
  assert.doesNotMatch(JSON.stringify(anchor), /hello|system/u)
})

test('Usage anchor 持久化失败不回滚已完成的模型响应', async () => {
  const runtime = createAgentModelContextRuntime({
    policy,
    persistUsageAnchor: async () => { throw new Error('database unavailable') },
  })
  const preparation = await runtime.prepare({
    messages: [{ role: 'user', content: 'hello' }], tools: [], maxOutputTokens: 500,
  })
  await assert.doesNotReject(() => runtime.observe({
    prepared: preparation.prepared,
    responseUsage: { inputTokens: 10, outputTokens: 2 },
  }))
})

test('传入 threadSummary 时压缩以它为 checkpoint 基底，surface 抽取只作回退', async () => {
  const threadSummary = [
    '本线程早前已经定下的事实（不是用户这一轮的新输入）：',
    '- 已确认决策：锁定人物与服装，替换场景。（run-coord-1）',
    '- 已锁定约束：person:preserve',
  ].join('\n')
  const runtime = createAgentModelContextRuntime({ policy, threadSummary })
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
    typeof message.content === 'string' && message.content.includes('run-coord-1')
  ))
  assert.ok(checkpointMessage, 'checkpoint 应含 Coordinator 已确认决策')
  assert.match(checkpointMessage.content, /已锁定约束：person:preserve/u)
  assert.equal(
    sanitizeAgentModelContextCheckpoint(checkpointMessage.content),
    checkpointMessage.content,
  )
})
