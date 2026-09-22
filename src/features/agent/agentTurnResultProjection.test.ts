import assert from 'node:assert/strict'
import test from 'node:test'
import { projectAgentTurnResult } from './agentTurnResultProjection.ts'

test('正常返回与恢复共享稳定 Message 投影，追问与非法 composition 不变成生成', () => {
  const identity = { turnId: 'turn-1', messageId: 'transient', locale: 'zh-CN' as const }
  assert.deepEqual(projectAgentTurnResult({ kind: 'chat', answer: '已找到', sources: ['项目本体'] }, identity), {
    kind: 'message', phase: 'completed', message: {
      id: 'agent-turn-result-turn-1', turnId: 'turn-1', role: 'assistant', kind: 'text', status: 'answered', content: '已找到\n\n来源: 项目本体',
    },
  })
  const question = projectAgentTurnResult({ kind: 'clarification', question: '选哪项？', options: ['甲', '乙'] }, identity)
  assert.equal(question.kind, 'message')
  if (question.kind === 'message') {
    assert.equal(question.phase, 'waiting_clarification')
    assert.equal(question.message.content, '选哪项？\n\n1. 甲\n2. 乙')
    assert.equal(question.message.kind, 'text')
  }
  const invalid = projectAgentTurnResult({ kind: 'composition', theme: '', items: [] }, { ...identity, locale: 'en' })
  assert.equal(invalid.kind, 'message')
  if (invalid.kind === 'message') {
    assert.equal(invalid.phase, 'completed')
    assert.equal(invalid.message.status, 'failed')
    assert.equal(invalid.message.kind, 'notice')
    assert.match(invalid.message.content, /did not produce a usable composition/)
  }
})

test('生成投影保留原目标、设置提示与 Turn，不把原始 reasoning 写入消息', () => {
  const result = projectAgentTurnResult({ kind: 'generation', mediaKind: 'image', count: 2, prompt: '春日',
    selectedResultNodeId: 'original-target', settingsHint: { model: 'm' },
  }, { turnId: 'turn-2', messageId: 'transient', locale: 'zh-CN' })
  assert.deepEqual(result, { kind: 'generation', continuation: {
    targetNodeId: 'original-target', resolvedGeneration: { mediaKind: 'image', prompt: '春日', count: 2, turnId: 'turn-2' }, generationOverrides: { model: 'm' },
  } })
})
