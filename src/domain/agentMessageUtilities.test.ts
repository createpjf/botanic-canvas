import assert from 'node:assert/strict'
import test from 'node:test'
import type { BotanicAgentMessage } from './agent.ts'
import {
  botanicAgentLatestEvaluableMessageId,
  botanicAgentMessageHasUtilities,
  botanicAgentMessageIsRunLinked,
  botanicAgentMessageIsReview,
  botanicAgentMessageIsSettled,
  botanicAgentMessageUtilityActions,
  botanicAgentClarificationProgress,
  botanicAgentRunResultReadState,
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

test('评审消息只按结构身份识别，保留 Run 结果资格且不误伤普通文字', () => {
  const review = message({ id: 'agent-review-run-1', runId: 'run-1' })
  assert.equal(botanicAgentMessageIsReview(review), true)
  assert.equal(botanicAgentMessageIsRunLinked(review, { id: 'run-1' }), true)
  assert.equal(botanicAgentMessageIsReview(message({ id: 'text', content: '请解释质量评审已完成的含义' })), false)
  assert.equal(botanicAgentMessageIsReview(message({ id: review.id, runId: review.runId, role: 'user' })), false)
})

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

test('notice 绑定同一 Run 时仍具备结果展示能力', () => {
  const notice = message({ id: 'notice-result', kind: 'notice', runId: 'run-1', content: '已完成' })
  assert.equal(botanicAgentMessageIsRunLinked(notice, { id: 'run-1' }), true)
  assert.equal(botanicAgentMessageIsRunLinked(notice, { id: 'run-2' }), false)
})

test('结果首页已读取但仍有历史页时，不能把成功任务判成无结果', () => {
  const run = { status: 'completed' as const, plan: { output: { count: 1 } } }
  assert.equal(botanicAgentRunResultReadState(run, false, { pageReady: true, hasMore: true, failed: false }), 'more')
  assert.equal(botanicAgentRunResultReadState(run, false, { pageReady: true, hasMore: false, failed: false }), 'missing')
  assert.equal(botanicAgentRunResultReadState(run, true, { pageReady: true, hasMore: true, failed: false }), 'none')
  assert.equal(botanicAgentRunResultReadState({ ...run, plan: { output: { count: 0 } } }, false, { pageReady: true, hasMore: false, failed: false }), 'none')
})

test('索引失败和等待载入分别展示，不能盖住已有部分结果或改变运行中状态', () => {
  const run = { status: 'partial' as const, plan: { output: { count: 2 } } }
  const index = { pageReady: false, hasMore: true, failed: true }
  assert.equal(botanicAgentRunResultReadState(run, false, index), 'error')
  assert.equal(botanicAgentRunResultReadState(run, true, index), 'none')
  assert.equal(botanicAgentRunResultReadState(run, false, { ...index, failed: false }), 'loading')
  assert.equal(botanicAgentRunResultReadState({ ...run, status: 'running' }, false, index), 'none')
})

test('历史确认只按真实 Run 的 plan.turnId 收口，不受后续无关任务影响', () => {
  const question = message({ id: 'question', kind: 'question', status: 'pending', turnId: 'turn-1' })
  assert.deepEqual(botanicAgentClarificationProgress(question, [{ id: 'other-run', plan: { turnId: 'turn-2' } }]), { state: 'pending' })
  assert.deepEqual(botanicAgentClarificationProgress(question, [{ id: 'run-1', plan: { turnId: 'turn-1' } }]), { state: 'continued', runId: 'run-1' })
  assert.deepEqual(botanicAgentClarificationProgress({ ...question, status: 'answered' }, []), { state: 'answered' })
  assert.deepEqual(botanicAgentClarificationProgress({ ...question, runId: 'run-not-loaded' }, []), { state: 'continued', runId: 'run-not-loaded' })
  assert.deepEqual(botanicAgentClarificationProgress({ ...question, status: 'failed' }, []), { state: 'unavailable' })
  assert.deepEqual(botanicAgentClarificationProgress({ ...question, turnId: undefined }, []), { state: 'unavailable' })
  assert.deepEqual(botanicAgentClarificationProgress({ ...question, turnId: undefined, sourceMessageId: 'input-1' }, []), { state: 'pending' })
})

test('确认可操作性核对原 Turn 当前问题，已取消只读，已有任务即使未载入也能定位', () => {
  const question = message({ id: 'question', kind: 'question', status: 'pending', turnId: 'turn-1', question: { id: 'q1', originalInstruction: '原指令' } as BotanicAgentMessage['question'] })
  assert.deepEqual(botanicAgentClarificationProgress(question, [], { id: 'turn-1', status: 'cancelled' }), { state: 'unavailable' })
  const turn = { id: 'turn-1', status: 'waiting_user', result: { kind: 'clarification', clarification: { id: 'q1', originalInstruction: '原指令' } } }
  assert.equal(botanicAgentClarificationProgress(question, [], turn).state, 'pending')
  assert.equal(botanicAgentClarificationProgress(question, [], { ...turn, id: 'other' }).state, 'unavailable')
  assert.equal(botanicAgentClarificationProgress(question, [], { ...turn, result: { ...turn.result, clarification: { id: 'old', originalInstruction: '原指令' } } }).state, 'unavailable')
  assert.deepEqual(botanicAgentClarificationProgress(question, [], { ...turn, linkedRunIds: ['run-not-loaded'] }), { state: 'continued', runId: 'run-not-loaded' })
})

test('分隔线仅用于终态助手回复，等待确认、流式和未停止的任务都不显示', () => {
  const reply = message({ id: 'reply', status: 'answered' })
  assert.equal(botanicAgentMessageIsSettled(reply, undefined), true)
  assert.equal(botanicAgentMessageIsSettled(reply, undefined, true), false)
  assert.equal(botanicAgentMessageIsSettled({ ...reply, role: 'user' }, undefined), false)
  assert.equal(botanicAgentMessageIsSettled({ ...reply, question: {} as NonNullable<BotanicAgentMessage['question']> }, undefined), false)
  assert.equal(botanicAgentMessageIsSettled({ ...reply, plan: {} as NonNullable<BotanicAgentMessage['plan']> }, undefined), false)
  const linked = { ...reply, runId: 'run-1' }
  assert.equal(botanicAgentMessageIsSettled(linked, undefined), false)
  assert.equal(botanicAgentMessageIsSettled(linked, { id: 'run-1', status: 'running' }), false)
  assert.equal(botanicAgentMessageIsSettled(linked, { id: 'run-1', status: 'cancelling' }), false)
  assert.equal(botanicAgentMessageIsSettled(linked, { id: 'run-1', status: 'completed' }), true)
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
