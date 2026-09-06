import assert from 'node:assert/strict'
import test from 'node:test'

import { failedAgentTurnRecoveryDecision, recoverPendingAgentTurn, resolveAgentStopTarget } from './agentTurnRecovery.ts'
import type { AgentTurnTimelineReadResult } from '../../lib/agentTurnTimelineEventReader.ts'
import type { BotanicAgentMessage } from '../../domain/agent.ts'

test('Run 正在创建时停止原计划 Turn，不能取消另一条最新任务', () => {
  const source = { id: 'source', role: 'user', turnId: 'turn-original', turnRequestSnapshot: {} } as BotanicAgentMessage
  const plan = { id: 'plan', role: 'assistant', plan: { turnId: 'turn-original' } } as BotanicAgentMessage
  const other = { id: 'other', role: 'user', turnId: 'turn-other', turnRequestSnapshot: {} } as BotanicAgentMessage
  assert.deepEqual(resolveAgentStopTarget([source, plan, other], { submittingMessageId: 'plan' }), {
    turnId: 'turn-original', inputMessage: source,
  })
  assert.deepEqual(resolveAgentStopTarget([source, plan, other], { submittingMessageId: 'plan', activeTurnId: 'turn-other', activeInputMessage: source }), {
    turnId: 'turn-other', inputMessage: other,
  })
})

test('失败恢复先按原 Turn 事实分流；运行中继续观察、关联 Run 进入任务', () => {
  const read: AgentTurnTimelineReadResult = { events: [], truncated: false, hasNonReadTool: false,
    turn: { id: 'turn-1', projectId: 'project-1', status: 'running' } }
  assert.equal(failedAgentTurnRecoveryDecision(read), 'observe')
  assert.equal(failedAgentTurnRecoveryDecision(read, 'run-1'), 'task')
  read.turn = { ...read.turn!, status: 'failed', error: { code: 'PROVIDER_UNAVAILABLE' } }
  assert.equal(failedAgentTurnRecoveryDecision(read), 'retry')
  read.turn.status = 'cancelling'
  assert.equal(failedAgentTurnRecoveryDecision(read), 'observe')
})

test('未知结果、已执行写工具及不完整事件不得重放整轮', () => {
  const read: AgentTurnTimelineReadResult = { events: [], truncated: false, hasNonReadTool: false,
    turn: { id: 'turn-1', projectId: 'project-1', status: 'failed', error: { code: 'AGENT_TOOL_OUTCOME_UNKNOWN' } } }
  assert.equal(failedAgentTurnRecoveryDecision(read), 'inspect')
  read.turn!.error = { code: 'PROVIDER_UNAVAILABLE' }
  read.events = [{ type: 'tool', step: 1, toolCall: {
    id: 'write-1', name: 'canvas_action_set', label: '写入画布', risk: 'write', status: 'succeeded', requiresConfirmation: true,
  } }]
  assert.equal(failedAgentTurnRecoveryDecision(read), 'blocked')
  assert.equal(failedAgentTurnRecoveryDecision({ ...read, events: [], truncated: true }), 'blocked')
  assert.equal(failedAgentTurnRecoveryDecision({ ...read, events: [], hasNonReadTool: undefined }), 'blocked')
})

test('缺少 durable Turn 与请求快照时 fail closed', async () => {
  await assert.rejects(() => recoverPendingAgentTurn({
    projectId: 'project-1',
    message: {
      id: 'message-1', role: 'user', kind: 'text', content: '继续', createdAt: 1,
    },
    request: {
      projectId: 'project-1',
      sessionId: 'session-1',
      inputMessage: { id: 'message-1', content: '继续' },
      locale: 'zh-CN',
      contextNodeIds: [],
      hasTarget: false,
    },
    initialTurnId: '',
    signal: new AbortController().signal,
    onEvent: () => {},
    onAccepted: () => {},
    ensureMessageDurable: async () => {},
    cancellationRequested: () => false,
    ensureCancellation: async () => {},
    submitTurn: async () => { throw new Error('不得提交') },
    observeTurn: async () => { throw new Error('不得观察') },
    createError: (message, status, code) => Object.assign(new Error(message), { status, code }),
  }), { code: 'AGENT_TURN_REQUEST_SNAPSHOT_MISSING' })
})
