import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BOB_LARGE_REPLY_MIN_CHARS,
  bobAssistantMessageMood,
  bobMessageAllowsSays,
  bobMessageIsLargeReply,
  bobMessageReplyText,
  bobReplyPresentation,
  bobWelcomePresentation,
  emptyBobSaysPlayCounts,
  markBobSaysPlayed,
} from './bobPresentation.ts'

test('消息行：流式或 Agent 忙碌时思考，最新空闲时聆听，旧消息静止', () => {
  assert.equal(bobAssistantMessageMood({ streaming: true, isLatestAssistant: true, agentBusy: false }), 'thinking')
  assert.equal(bobAssistantMessageMood({ streaming: false, isLatestAssistant: true, agentBusy: true }), 'thinking')
  assert.equal(bobAssistantMessageMood({ streaming: false, isLatestAssistant: true, agentBusy: false }), 'listening')
  assert.equal(bobAssistantMessageMood({ streaming: false, isLatestAssistant: false, agentBusy: false }), 'idle')
})

test('28px 消息行默认不出字：不是最新大回复就不允许 says', () => {
  assert.equal(bobMessageAllowsSays({ isLatestAssistant: true, isLargeReply: false }), false)
  assert.equal(bobMessageAllowsSays({ isLatestAssistant: false, isLargeReply: true }), false)
  assert.equal(bobMessageAllowsSays({ isLatestAssistant: true, isLargeReply: true }), true)
})

test('大回复只看助手正文，通知和任务卡不算', () => {
  const long = '字'.repeat(BOB_LARGE_REPLY_MIN_CHARS)
  assert.equal(bobMessageIsLargeReply({ role: 'assistant', kind: 'text', content: long }), true)
  assert.equal(bobMessageIsLargeReply({ role: 'assistant', kind: 'text', content: '短句' }), false)
  assert.equal(bobMessageIsLargeReply({ role: 'assistant', kind: 'notice', content: long }), false)
  assert.equal(bobMessageIsLargeReply({ role: 'user', kind: 'text', content: long }), false)
  assert.equal(bobMessageReplyText({ kind: 'run', content: long }), '')
})

test('欢迎页先限次 hmm，播完回到问号，不自动 wow', () => {
  const first = bobWelcomePresentation(emptyBobSaysPlayCounts())
  assert.deepEqual(first, { mood: 'thinking', says: 'hmm', cycles: 1 })

  const afterHmm = bobWelcomePresentation(markBobSaysPlayed(emptyBobSaysPlayCounts(), 'hmm'))
  assert.equal(afterHmm.says, 'question')
  assert.equal(afterHmm.mood, 'confused')
  assert.equal(afterHmm.cycles, Number.POSITIVE_INFINITY)
})

test('最新大回复：流式限次 hmm，完成后限次 wow，再回到 mood 且不出字', () => {
  const streaming = bobReplyPresentation({
    allowsSays: true,
    streaming: true,
    isLatestAssistant: true,
    agentBusy: true,
    plays: emptyBobSaysPlayCounts(),
  })
  assert.deepEqual(streaming, { mood: 'thinking', says: 'hmm', cycles: 1 })

  const afterHmmStillStreaming = bobReplyPresentation({
    allowsSays: true,
    streaming: true,
    isLatestAssistant: true,
    agentBusy: true,
    plays: markBobSaysPlayed(emptyBobSaysPlayCounts(), 'hmm'),
  })
  assert.equal(afterHmmStillStreaming.says, 'none')
  assert.equal(afterHmmStillStreaming.mood, 'thinking')

  const done = bobReplyPresentation({
    allowsSays: true,
    streaming: false,
    isLatestAssistant: true,
    agentBusy: false,
    plays: markBobSaysPlayed(emptyBobSaysPlayCounts(), 'hmm'),
  })
  assert.deepEqual(done, { mood: 'excited', says: 'wow', cycles: 1 })

  const afterWow = bobReplyPresentation({
    allowsSays: true,
    streaming: false,
    isLatestAssistant: true,
    agentBusy: false,
    plays: markBobSaysPlayed(markBobSaysPlayed(emptyBobSaysPlayCounts(), 'hmm'), 'wow'),
  })
  assert.equal(afterWow.says, 'none')
  assert.equal(afterWow.mood, 'listening')
})

test('非大回复或非最新消息即使流式也不出字', () => {
  const presentation = bobReplyPresentation({
    allowsSays: false,
    streaming: true,
    isLatestAssistant: false,
    agentBusy: true,
    plays: emptyBobSaysPlayCounts(),
  })
  assert.equal(presentation.says, 'none')
  assert.equal(presentation.mood, 'thinking')
})
