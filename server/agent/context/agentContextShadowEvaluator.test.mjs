import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateAgentContextShadow } from './agentContextShadowEvaluator.mjs'

const policies = {
  models: {
    'test-model': {
      contextWindowTokens: 4_096,
      outputReserveTokens: 512,
      safetyMarginTokens: 128,
      autoCompactRatio: 0.5,
      retainRecentRatio: 0.1,
    },
  },
}

test('Context shadow 只返回计数与 hash，不泄漏消息内容', () => {
  const secret = 'PROMPT_SECRET_SENTINEL'
  const messages = Array.from({ length: 12 }, (_, index) => ({
    id: `m-${index}`,
    role: index % 2 ? 'assistant' : 'user',
    kind: 'text',
    content: `${secret}-${index}-${'中'.repeat(300)}`,
    createdAt: index,
    updatedAt: index,
  }))
  const result = evaluateAgentContextShadow({
    sessionId: 'session-1', messages, currentMessageId: 'm-11', model: 'test-model',
    policies, controlInputTokenCount: 1_234,
  })
  assert.equal(result.wouldCompact, true)
  assert.ok(result.replacedMessageCount > 0)
  assert.ok(result.candidateInputTokenCount < result.beforeInputTokenCount)
  assert.equal(result.controlInputTokenCount, 1_234)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret, 'u'))
})

test('短会话 shadow 明确不会压缩', () => {
  const result = evaluateAgentContextShadow({
    sessionId: 'session-2',
    messages: [{ id: 'm-1', role: 'user', kind: 'text', content: '继续', createdAt: 1, updatedAt: 1 }],
    currentMessageId: 'm-1', model: 'test-model', policies,
  })
  assert.equal(result.wouldCompact, false)
  assert.equal(result.operationCount, 0)
})
