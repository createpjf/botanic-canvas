import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AgentModelContextSurfaceError,
  agentModelContextProviderMessages,
  agentModelContextTools,
  compactAgentModelContextSurface,
  createAgentModelContextSurface,
  pruneAgentModelContextSurface,
} from './agentModelContextSurface.mjs'

function toolExchange(content = '搜索结果') {
  return [
    {
      id: 'assistant-message', revision: 2, role: 'assistant', content: null,
      reasoning_content: '不得回送的完整推理',
      tool_calls: [{ id: 'call-search', type: 'function', function: { name: 'search', arguments: '{"q":"植物"}' } }],
    },
    { id: 'tool-message', revision: 3, role: 'tool', tool_call_id: 'call-search', content },
  ]
}

test('Model Context Surface 原子化 tool exchange，并仅对 provider 暴露必要字段', () => {
  const surface = createAgentModelContextSurface({
    model: 'planner-a', policyHash: 'policy-1', outputReserveTokens: 1_000,
    messages: [
      { id: 'system-id', revision: 1, role: 'system', content: '系统规则' },
      { id: 'user-id', revision: 1, role: 'user', content: '找植物' },
      ...toolExchange(),
    ],
    tools: [{ type: 'function', function: { name: 'search', parameters: { type: 'object' } } }],
  })
  assert.equal(surface.units.at(-1).kind, 'tool_exchange')
  assert.equal(surface.units.at(-1).messageCount, 2)
  assert.equal(Object.isFrozen(surface), true)
  assert.equal(Object.isFrozen(surface.units[0]), true)
  const messages = agentModelContextProviderMessages(surface)
  assert.equal(messages[0].id, undefined)
  assert.equal(messages[0].revision, undefined)
  assert.equal(messages[2].reasoning_content, undefined)
  assert.equal(messages[3].tool_call_id, 'call-search')
  assert.equal(agentModelContextTools(surface).length, 1)
})

test('Model Context Surface 拒绝孤立、缺失、重复与错配 tool result', () => {
  const cases = [
    [{ role: 'tool', tool_call_id: 'call-a', content: 'x' }],
    [{ role: 'assistant', content: null, tool_calls: [{ id: 'call-a' }] }],
    [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-a' }] },
      { role: 'tool', tool_call_id: 'call-a', content: 'x' },
      { role: 'tool', tool_call_id: 'call-a', content: 'y' },
    ],
    [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-a' }] },
      { role: 'tool', tool_call_id: 'call-b', content: 'x' },
    ],
  ]
  for (const messages of cases) {
    assert.throws(
      () => createAgentModelContextSurface({ model: 'planner', messages }),
      AgentModelContextSurfaceError,
    )
  }
})

test('Model Context Surface 公开形状不含 prompt 或媒体，哈希不受对象键序影响', () => {
  const secret = '绝密品牌策略'
  const dataUrl = 'data:image/png;base64,U0VDUkVU'
  const messagesA = [{ role: 'user', content: [{ type: 'text', text: secret }, { type: 'image_url', image_url: { url: dataUrl } }] }]
  const messagesB = [{ content: [{ text: secret, type: 'text' }, { image_url: { url: dataUrl }, type: 'image_url' }], role: 'user' }]
  const first = createAgentModelContextSurface({
    model: 'vision', messages: messagesA,
    tools: [{ function: { parameters: { type: 'object' }, name: 'inspect' }, type: 'function' }],
  })
  const second = createAgentModelContextSurface({
    model: 'vision', messages: messagesB,
    tools: [{ type: 'function', function: { name: 'inspect', parameters: { type: 'object' } } }],
  })
  assert.equal(first.surfaceHash, second.surfaceHash)
  assert.equal(first.mediaCount, 1)
  const serialized = JSON.stringify(first)
  assert.doesNotMatch(serialized, /绝密品牌策略|U0VDUkVU/)
  assert.equal(agentModelContextProviderMessages(first)[0].content[1].image_url.url, dataUrl)
})

test('Model Context Surface 长工具结果按 Unicode code point 确定性裁剪且不改原消息', () => {
  const original = `${'🌿'.repeat(20)}尾部秘密`
  const surface = createAgentModelContextSurface({ model: 'planner', messages: toolExchange(original) })
  const result = pruneAgentModelContextSurface(surface, {
    toolResultPrune: { thresholdCodePoints: 12, headCodePoints: 4, tailCodePoints: 2 },
  })
  assert.equal(result.kind, 'pruned')
  assert.equal(agentModelContextProviderMessages(surface)[1].content, original)
  const pruned = JSON.parse(agentModelContextProviderMessages(result.surface)[1].content)
  assert.equal(pruned._botanicPruning.originalCodePoints, Array.from(original).length)
  assert.equal(Array.from(pruned.head).length, 4)
  assert.equal(Array.from(pruned.tail).length, 2)
  assert.doesNotMatch(JSON.stringify(result.operation), /尾部秘密|🌿/)
  const repeated = pruneAgentModelContextSurface(surface, {
    toolResultPrune: { thresholdCodePoints: 12, headCodePoints: 4, tailCodePoints: 2 },
  })
  assert.deepEqual(result.operation, repeated.operation)
})

test('Model Context Surface checkpoint 替换旧历史，保留当前用户与原子后缀', () => {
  const surface = createAgentModelContextSurface({
    model: 'planner', policyHash: 'p1', outputReserveTokens: 500,
    messages: [
      { id: 'sys', revision: 1, role: 'system', content: '规则' },
      { id: 'old-user', revision: 4, role: 'user', content: '很久以前的问题'.repeat(30) },
      { id: 'old-answer', revision: 2, role: 'assistant', content: '很久以前的回答'.repeat(30) },
      ...toolExchange('工具历史'.repeat(100)),
      { id: 'current-user', revision: 7, role: 'user', content: '当前问题' },
      { id: 'current-answer', revision: 1, role: 'assistant', content: '正在处理' },
    ],
  })
  const checkpoint = '摘要 https://private.example/a sk-secret123 /api/media/private.png'
  const result = compactAgentModelContextSurface(surface, {
    checkpoint: { content: checkpoint, threadSummaryHash: 'summary-hash' },
    retainRecentTokens: 1,
    mediaTokensPerItem: 2_048,
    trigger: 'manual',
  })
  assert.equal(result.kind, 'compacted')
  const messages = agentModelContextProviderMessages(result.surface)
  assert.deepEqual(messages.map((message) => message.role), ['system', 'user', 'user', 'assistant'])
  assert.match(messages[1].content, /已省略外部链接/)
  assert.match(messages[1].content, /REDACTED_SECRET/)
  assert.match(messages[1].content, /已省略媒体引用/)
  assert.equal(messages[2].content, '当前问题')
  assert.equal(result.operation.trigger, 'manual')
  assert.equal(result.operation.checkpoint.threadSummaryHash, 'summary-hash')
  assert.equal(result.operation.checkpoint.content, undefined)
  assert.equal(result.operation.replacedMessageRevisions[0].id, 'old-user')
  assert.doesNotMatch(JSON.stringify(result.operation), /很久以前|private\.example|secret123/)
})

test('Model Context Surface 无可替换历史或 checkpoint 不更小时保持原 surface', () => {
  const currentOnly = createAgentModelContextSurface({
    model: 'planner', messages: [{ role: 'user', content: '当前问题' }],
  })
  assert.deepEqual(
    compactAgentModelContextSurface(currentOnly, { checkpoint: '摘要', retainRecentTokens: 0 }),
    { kind: 'no_change', reason: 'no_replaceable_history', surface: currentOnly },
  )
  const withOld = createAgentModelContextSurface({
    model: 'planner', messages: [
      { role: 'user', content: '旧' },
      { role: 'user', content: '新' },
    ],
  })
  const result = compactAgentModelContextSurface(withOld, {
    checkpoint: '比原内容大很多很多的 checkpoint', retainRecentTokens: 0,
  })
  assert.equal(result.kind, 'no_change')
  assert.equal(result.reason, 'not_smaller')
  assert.equal(result.surface, withOld)
})
