import assert from 'node:assert/strict'
import test from 'node:test'
import type { BotanicAgentMessage } from './agent.ts'
import {
  botanicAgentLatestEvaluableMessageId,
  botanicAgentMessageHasUtilities,
  botanicAgentMessageUtilityActions,
} from './agentMessageUtilities.ts'

function message(partial: Partial<BotanicAgentMessage> & Pick<BotanicAgentMessage, 'id'>): BotanicAgentMessage {
  return {
    role: 'assistant',
    kind: 'text',
    content: '先用这张主视觉做底，只换背景。',
    createdAt: 1,
    ...partial,
  }
}

test('用户消息可编辑和复制，但不评价', () => {
  assert.deepEqual(botanicAgentMessageUtilityActions(message({
    id: 'user-1', role: 'user', content: '换成海边',
  })), { edit: true, feedback: false, copy: true })
  assert.deepEqual(botanicAgentMessageUtilityActions(message({
    id: 'user-empty', role: 'user', content: '  ',
  })), { edit: false, feedback: false, copy: false })
})

test('创作回复和方案卡可以评价、复制', () => {
  assert.deepEqual(botanicAgentMessageUtilityActions(message({ id: 'reply' })), {
    edit: false, feedback: true, copy: true,
  })
  assert.deepEqual(botanicAgentMessageUtilityActions(message({
    id: 'prompt', prompt: 'soft daylight, empty beach',
  })), { edit: false, feedback: true, copy: true })
  assert.deepEqual(botanicAgentMessageUtilityActions(message({
    id: 'composition',
    kind: 'composition',
    composition: { theme: '春季套图', items: [] },
  })), { edit: false, feedback: true, copy: true })
})

test('通知、任务、追问和计划可复制，但不评价', () => {
  for (const kind of ['notice', 'run', 'question', 'plan'] as const) {
    assert.deepEqual(
      botanicAgentMessageUtilityActions(message({ id: kind, kind, content: '任务没有启动' })),
      { edit: false, feedback: false, copy: true },
      kind,
    )
  }
})

test('带 runId 的 text 是任务回执，方案卡除外', () => {
  assert.deepEqual(botanicAgentMessageUtilityActions(message({
    id: 'receipt', runId: 'run-1', content: '任务未完成，可调整后重试。',
  })), { edit: false, feedback: false, copy: true })
  assert.equal(botanicAgentMessageUtilityActions(message({
    id: 'composition-run',
    kind: 'composition',
    runId: 'run-1',
    composition: { theme: '套图', items: [] },
  })).feedback, true)
})

test('空助手正文在产出到达前没有工具条', () => {
  assert.equal(botanicAgentMessageHasUtilities(botanicAgentMessageUtilityActions(message({
    id: 'empty', content: '',
  }))), false)
})

test('最后一条可评价回复跳过末尾的通知和回执', () => {
  assert.equal(botanicAgentLatestEvaluableMessageId([
    message({ id: 'user-1', role: 'user', content: '出一张' }),
    message({ id: 'reply-1' }),
    message({ id: 'notice-1', kind: 'notice', content: '任务没有启动' }),
    message({ id: 'receipt-1', runId: 'run-1', content: '任务未完成' }),
  ]), 'reply-1')
  assert.equal(botanicAgentLatestEvaluableMessageId([
    message({ id: 'notice-only', kind: 'notice', content: '任务没有启动' }),
  ]), null)
})
