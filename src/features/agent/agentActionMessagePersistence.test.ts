import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  BotanicAgentActionProposal,
  BotanicAgentMessage,
  BotanicAgentSession,
} from '../../domain/agent.ts'
import {
  persistBotanicAgentActionMessageUpdate,
  persistBotanicAgentMessageUpdate,
} from './agentActionMessagePersistence.ts'

const action: BotanicAgentActionProposal = {
  id: 'call-mcp-1',
  kind: 'mcp',
  toolName: 'mcp_call',
  label: '发布到外部系统',
  summary: '发布已确认内容。',
  risk: 'external',
  arguments: { target: 'campaign-1' },
  status: 'awaiting_confirmation',
}

const message: BotanicAgentMessage = {
  id: 'message-plan-1',
  role: 'assistant',
  kind: 'plan',
  content: '确认后发布。',
  createdAt: 110,
  plan: {
    intent: 'continue_generation',
    instruction: '发布内容',
    summary: '确认后发布。',
    references: [],
    constraints: [],
    prompt: '发布内容',
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
    output: { mode: 'single', count: 1, candidatesPerItem: 1 },
    actions: [action],
  },
}

const session: BotanicAgentSession = {
  id: 'session-1',
  title: '发布会话',
  executionMode: 'manual',
  contextNodeIds: [],
  messages: [message],
  createdAt: 100,
  updatedAt: 110,
}

test('行动状态同时更新本地视图和完整权威 Message，刷新后恢复最后状态', () => {
  const localStatuses: string[] = []
  const localReceiptKeys: string[] = []
  const persistedMessages = new Map<string, string>()
  const callbacks = {
    onUpsertMessage: () => undefined,
    onUpdateAction: (
      _sessionId: string,
      _messageId: string,
      _actionId: string,
      patch: Partial<Pick<BotanicAgentActionProposal, 'status' | 'receiptIdempotencyKey' | 'preparedRetryIdempotencyKey' | 'manualRetryResumeAvailable' | 'error' | 'result'>>,
    ) => {
      if (patch.status) localStatuses.push(patch.status)
      if (patch.receiptIdempotencyKey) localReceiptKeys.push(patch.receiptIdempotencyKey)
    },
    persistMessage: (updatedMessage: BotanicAgentMessage) => {
      persistedMessages.set(updatedMessage.id, JSON.stringify(updatedMessage))
    },
  }

  const runningMessage = persistBotanicAgentActionMessageUpdate({
    session,
    message,
    actionId: action.id,
    patch: { status: 'running', receiptIdempotencyKey: 'agent-action-manual-retry-call-mcp-1-attempt-1' },
    now: 110,
    ...callbacks,
  })
  const uncertainMessage = persistBotanicAgentActionMessageUpdate({
    session,
    message: runningMessage,
    actionId: action.id,
    patch: { status: 'uncertain', error: '行动结果未知，请人工核对。' },
    now: 110,
    ...callbacks,
  })

  const recovered = JSON.parse(persistedMessages.get(message.id) ?? '{}') as BotanicAgentMessage
  assert.deepEqual(localStatuses, ['running', 'uncertain'])
  assert.deepEqual(localReceiptKeys, ['agent-action-manual-retry-call-mcp-1-attempt-1'])
  assert.equal(uncertainMessage.updatedAt, 112)
  assert.equal(recovered.id, message.id)
  assert.equal(recovered.updatedAt, 112)
  assert.equal(recovered.plan?.actions?.[0].status, 'uncertain')
  assert.equal(recovered.plan?.actions?.[0].receiptIdempotencyKey, 'agent-action-manual-retry-call-mcp-1-attempt-1')
  assert.equal(recovered.plan?.actions?.[0].error, '行动结果未知，请人工核对。')
  assert.doesNotMatch(JSON.stringify(recovered), /one-shot-token/u)
})

test('授权已消费但回执未建立时，只持久化公开恢复标记和原 retry key', () => {
  let persisted: BotanicAgentMessage | undefined
  const recovered = persistBotanicAgentActionMessageUpdate({
    session,
    message,
    actionId: action.id,
    patch: {
      status: 'failed',
      receiptIdempotencyKey: 'agent-action-manual-retry-call-mcp-1-attempt-1',
      manualRetryResumeAvailable: true,
      error: '一次性重试已授权但尚未开始。',
    },
    onUpsertMessage: () => undefined,
    onUpdateAction: () => undefined,
    persistMessage: (updated) => { persisted = updated },
    now: 120,
  })

  assert.equal(recovered.plan?.actions?.[0].manualRetryResumeAvailable, true)
  assert.equal(recovered.plan?.actions?.[0].receiptIdempotencyKey, 'agent-action-manual-retry-call-mcp-1-attempt-1')
  assert.equal(persisted?.plan?.actions?.[0].manualRetryResumeAvailable, true)
  assert.doesNotMatch(JSON.stringify(persisted), /token|authorization/iu)
})

test('人工决议请求前持久化 v2 retry key，且不写入 raw token 或授权对象', () => {
  let persisted: BotanicAgentMessage | undefined
  const prepared = persistBotanicAgentActionMessageUpdate({
    session,
    message,
    actionId: action.id,
    patch: {
      preparedRetryIdempotencyKey: 'agent-action-manual-retry-call-mcp-1-reservation-1',
    },
    onUpsertMessage: () => undefined,
    onUpdateAction: () => undefined,
    persistMessage: (updated) => { persisted = updated },
    now: 130,
  })

  assert.equal(
    prepared.plan?.actions?.[0].preparedRetryIdempotencyKey,
    'agent-action-manual-retry-call-mcp-1-reservation-1',
  )
  assert.equal(
    persisted?.plan?.actions?.[0].preparedRetryIdempotencyKey,
    'agent-action-manual-retry-call-mcp-1-reservation-1',
  )
  assert.doesNotMatch(JSON.stringify(persisted), /"token"|authorization/iu)
})

test('计划 pending→submitted/runId 每次都更新本地并持久化完整 Message', () => {
  const localPatches: Array<Record<string, unknown>> = []
  const persisted: BotanicAgentMessage[] = []
  const locallyUpserted: BotanicAgentMessage[] = []
  const pending = persistBotanicAgentMessageUpdate({
    session,
    message,
    patch: { status: 'pending' },
    onUpsertMessage: (_sessionId, updated) => { locallyUpserted.push(updated) },
    onUpdateMessage: (_sessionId, _messageId, patch) => { localPatches.push(patch) },
    persistMessage: (updated) => { persisted.push(updated) },
    now: 110,
  })
  const submitted = persistBotanicAgentMessageUpdate({
    session,
    message: pending,
    patch: { status: 'submitted', runId: 'run-stable' },
    onUpsertMessage: (_sessionId, updated) => { locallyUpserted.push(updated) },
    onUpdateMessage: (_sessionId, _messageId, patch) => { localPatches.push(patch) },
    persistMessage: (updated) => { persisted.push(updated) },
    now: 110,
  })

  assert.deepEqual(localPatches, [
    { status: 'pending' },
    { status: 'submitted', runId: 'run-stable' },
  ])
  assert.equal(pending.updatedAt, 111)
  assert.equal(submitted.updatedAt, 112)
  assert.equal(persisted.at(-1)?.status, 'submitted')
  assert.equal(persisted.at(-1)?.runId, 'run-stable')
  assert.equal(persisted.at(-1)?.plan?.prompt, message.plan?.prompt)
  assert.equal(locallyUpserted.at(-1)?.status, 'submitted')
  assert.equal(locallyUpserted.at(-1)?.runId, 'run-stable')
})

test('API-only stable Message 先用完整投影本地 upsert，不等 realtime/refetch', () => {
  const localStore = new Map<string, BotanicAgentMessage>()
  const updated = persistBotanicAgentMessageUpdate({
    session,
    message,
    patch: { status: 'submitted', runId: 'run-cross-device' },
    onUpsertMessage: (_sessionId, fullMessage) => { localStore.set(fullMessage.id, fullMessage) },
    // 模拟 Canvas Store 旧 update-only 语义：ID 不存在时 no-op。
    onUpdateMessage: (_sessionId, messageId, patch) => {
      const existing = localStore.get(messageId)
      if (existing) localStore.set(messageId, { ...existing, ...patch })
    },
    persistMessage: () => undefined,
    now: 200,
  })

  assert.deepEqual(localStore.get(message.id), updated)
  assert.equal(localStore.get(message.id)?.runId, 'run-cross-device')
})
