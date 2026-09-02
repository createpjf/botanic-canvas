import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentTurnOutputPreviewCommitDecision,
  createAgentTurnOutputPreview,
  sanitizeAgentTurnOutputPreviewText,
} from './agentTurnOutputPreview.mjs'

test('preview按attempt reset、字符阈值/tool边界flush并清理控制字符', async () => {
  const persisted = []
  const timers = []
  const preview = createAgentTurnOutputPreview({
    persist: async (value) => { persisted.push(value) },
    now: () => 42,
    flushChars: 4,
    schedule: (fn) => { timers.push(fn); return timers.length },
    unschedule: () => {},
  })
  await preview.observe({ type: 'attempt', action: 'start', attemptId: 'vision' })
  await preview.observe({ type: 'answer', attemptId: 'vision', step: 0, delta: 'ab\u0000' })
  await preview.observe({ type: 'answer', attemptId: 'old', step: 0, delta: 'late' })
  await preview.observe({ type: 'answer', attemptId: 'vision', step: 0, delta: 'cd' })
  await preview.observe({ type: 'tool' })
  await preview.observe({ type: 'attempt', action: 'start', attemptId: 'text' })
  assert.deepEqual(persisted.map((item) => [item.revision, item.attemptId, item.text]), [
    [1, 'vision', ''], [2, 'vision', 'abcd'], [3, 'text', ''],
  ])
  assert.equal(sanitizeAgentTurnOutputPreviewText('a\r\nb\u0000c'), 'a\nbc')
})

test('Store preview revision只允许顺序提交与同值幂等重放', () => {
  const one = { version: 1, attemptId: 'text', revision: 1, step: 0, text: 'a', updatedAt: 10 }
  assert.equal(agentTurnOutputPreviewCommitDecision(undefined, one, 10).kind, 'committed')
  assert.equal(agentTurnOutputPreviewCommitDecision(one, one, 11).kind, 'replay')
  assert.equal(agentTurnOutputPreviewCommitDecision(one, { ...one, text: 'changed' }, 11).kind, 'conflict')
  assert.equal(agentTurnOutputPreviewCommitDecision(one, { ...one, revision: 3 }, 11).kind, 'conflict')
})
