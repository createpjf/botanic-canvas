import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentTurnStreamFailureMustReject,
  agentTurnEventAsStreamEvent,
  botanicAgentTurnProjectionMessageId,
  botanicAgentTurnRecoveryKey,
  botanicAgentTurnRequestKey,
  continueBotanicAgentTurnSubmission,
  botanicAgentTurnGenerationContinuation,
  hasBotanicAgentTurnCancellationIntent,
  isRetryableBotanicAgentTurnRecoveryError,
  monotonicAgentTurnEventDecision,
  pendingBotanicAgentTurnProjection,
  resolveBotanicAgentContinuationTarget,
  revalidateMissingBotanicAgentTurn,
  retryBotanicAgentTurnRecovery,
  retryBotanicAgentTurnCancellation,
  shouldRevalidateMissingBotanicAgentTurn,
  settleAgentTurnObservation,
  stopBotanicAgentPlanning,
  type BotanicAgentTurnObservationPage,
} from './agentTurnObservation.ts'

test('accepted 后的意图冲突直接失败，不续读旧 Turn 伪装成本请求结果', () => {
  assert.equal(agentTurnStreamFailureMustReject('AGENT_TURN_INTENT_CONFLICT'), true)
  assert.equal(agentTurnStreamFailureMustReject('STREAM_DISCONNECTED'), false)
  assert.equal(agentTurnStreamFailureMustReject('PROVIDER_UNAVAILABLE'), false)
})

test('Turn SSE 与 observer 边界单调去重，重复最后事件丢弃且无 sequence 实时事件保留', () => {
  let lastSequence = 0
  const delivered: Array<number | undefined> = []
  // SSE：2 到达两次；无 sequence 的实时摘要仍须交付。
  for (const event of [{ sequence: 2 }, { sequence: 2 }, {}]) {
    const decision = monotonicAgentTurnEventDecision(lastSequence, event)
    lastSequence = decision.lastSequence
    if (decision.deliver) delivered.push(event.sequence)
  }
  // observer 从 after=2 续读时，代理又重复最后事件 2，再给新事件 3。
  for (const event of [{ sequence: 2 }, { sequence: 3 }]) {
    const decision = monotonicAgentTurnEventDecision(lastSequence, event)
    lastSequence = decision.lastSequence
    if (decision.deliver) delivered.push(event.sequence)
  }
  assert.deepEqual(delivered, [2, undefined, 3])
  assert.equal(lastSequence, 3)
})

test('同一用户消息跨断线复用稳定 Turn 幂等键', async () => {
  const input = { projectId: 'project-1', sessionId: 'session-1', inputMessage: { id: 'message-1' } }
  const first = await botanicAgentTurnRequestKey(input)
  assert.equal(first, await botanicAgentTurnRequestKey({ ...input, inputMessage: { id: 'message-1' } }))
  assert.match(first ?? '', /^agent-turn-[a-f0-9]{64}$/u)
  assert.notEqual(first, await botanicAgentTurnRequestKey({ ...input, inputMessage: { id: 'message-2' } }))
  assert.equal(await botanicAgentTurnRequestKey({ projectId: 'project-1' }), undefined)
})

test('recovery ownership 始终绑 Message ID，accepted 回写 turnId 不会换 key 并 abort 自己', () => {
  const beforeAccepted = { id: 'message-stable', turnId: undefined }
  const afterAccepted = { ...beforeAccepted, turnId: 'turn-durable' }
  assert.equal(botanicAgentTurnRecoveryKey(beforeAccepted), 'message:message-stable')
  assert.equal(botanicAgentTurnRecoveryKey(afterAccepted), 'message:message-stable')
})

test('普通 202 提交先交接 accepted 身份，再从 after=0 观察后台 Turn', async () => {
  const calls: string[] = []
  const result = await continueBotanicAgentTurnSubmission({
    runtimeTurn: { id: 'turn-202' },
    onAccepted: (turnId) => { calls.push(`accepted:${turnId}`) },
    observe: async ({ turnId, after }) => {
      calls.push(`observe:${turnId}:${after}`)
      return { kind: 'chat' as const, answer: '后台完成' }
    },
  })

  assert.deepEqual(result, { kind: 'chat', answer: '后台完成' })
  assert.deepEqual(calls, ['accepted:turn-202', 'observe:turn-202:0'])
})

test('Turn 续读只把安全的工具投影恢复成时间线事件', () => {
  assert.deepEqual(agentTurnEventAsStreamEvent({
    id: 'event-2',
    turnId: 'turn-1',
    projectId: 'project-1',
    sequence: 2,
    type: 'turn.tool',
    createdAt: 2,
    payload: {
      step: 1,
      toolCallId: 'call-1',
      toolName: 'web_search',
      label: '检索公开资料',
      summary: '核对品牌事实',
      risk: 'external',
      status: 'succeeded',
      presentation: { kind: 'search', title: '已搜索 3 个网站', count: 3 },
      arguments: { query: '不应下发' },
      output: { secret: true },
    },
  }), {
    type: 'tool',
    step: 1,
    sequence: 2,
    toolCall: {
      id: 'call-1',
      name: 'web_search',
      label: '检索公开资料',
      summary: '核对品牌事实',
      risk: 'external',
      status: 'succeeded',
      requiresConfirmation: false,
    },
    presentation: { kind: 'search', title: '已搜索 3 个网站', count: 3 },
  })
  assert.equal(agentTurnEventAsStreamEvent({ type: 'turn.started', sequence: 1 }), undefined)
})

test('Turn 续读以权威终态结算，非终态继续观察', () => {
  const result = { kind: 'chat' as const, answer: '完成' }
  const completed = {
    turn: { id: 'turn-1', projectId: 'project-1', status: 'completed' as const, result },
    events: [], cursor: { after: 3, hasMore: false },
  } satisfies BotanicAgentTurnObservationPage
  assert.deepEqual(settleAgentTurnObservation(completed), { kind: 'resolved', result })

  assert.deepEqual(settleAgentTurnObservation({
    ...completed,
    turn: { ...completed.turn, status: 'waiting_user', result: { kind: 'clarification', question: '选哪个？' } },
  }), { kind: 'resolved', result: { kind: 'clarification', question: '选哪个？' } })

  assert.deepEqual(settleAgentTurnObservation({
    ...completed,
    turn: { ...completed.turn, status: 'failed', result: undefined, error: { code: 'PROVIDER_FAILED', message: '模型失败' } },
  }), { kind: 'failed', code: 'PROVIDER_FAILED', message: '模型失败' })

  assert.deepEqual(settleAgentTurnObservation({
    ...completed,
    turn: { ...completed.turn, status: 'cancelled', result: undefined },
  }), { kind: 'failed', code: 'AGENT_TURN_CANCELLED', message: 'Agent 回合已取消。' })

  assert.deepEqual(settleAgentTurnObservation({
    ...completed,
    turn: { ...completed.turn, status: 'running', result: undefined },
  }), { kind: 'pending' })
})

test('尚有分页事件时先续读，不能提前用终态跳过工具轨迹', () => {
  const page = {
    turn: { id: 'turn-1', projectId: 'project-1', status: 'completed' as const, result: { kind: 'chat' as const, answer: '完成' } },
    events: [], cursor: { after: 200, hasMore: true },
  } satisfies BotanicAgentTurnObservationPage
  assert.deepEqual(settleAgentTurnObservation(page), { kind: 'pending' })
})

test('刷新恢复只挑出尚无同 Turn 助手投影的用户消息，并使用稳定结果消息 ID', () => {
  const messages = [
    { id: 'user-a', role: 'user' as const, turnId: 'turn-a', createdAt: 1 },
    { id: botanicAgentTurnProjectionMessageId('turn-a'), role: 'assistant' as const, turnId: 'turn-a', status: 'answered' as const, createdAt: 2 },
    { id: 'user-b', role: 'user' as const, turnId: 'turn-b', createdAt: 3 },
    // 其它 Turn 的结果不能误收口 turn-b。
    { id: botanicAgentTurnProjectionMessageId('turn-c'), role: 'assistant' as const, turnId: 'turn-c', status: 'answered' as const, createdAt: 4 },
  ]

  assert.deepEqual(pendingBotanicAgentTurnProjection(messages), messages[2])
  assert.equal(botanicAgentTurnProjectionMessageId('turn-b'), 'agent-turn-result-turn-b')
  assert.equal(pendingBotanicAgentTurnProjection([
    ...messages,
    { id: botanicAgentTurnProjectionMessageId('turn-b'), role: 'assistant', turnId: 'turn-b', status: 'answered', createdAt: 5 },
  ]), undefined)
})

test('旧稳定投影可用同 ID 修复，完成后继续下一 pending Turn 而不饿死', () => {
  const userA = { id: 'user-a', role: 'user' as const, turnId: 'turn-a', createdAt: 1 }
  const staleA = {
    id: botanicAgentTurnProjectionMessageId('turn-a'), role: 'assistant' as const,
    turnId: 'turn-a', createdAt: 2,
  }
  const userB = { id: 'user-b', role: 'user' as const, turnId: 'turn-b', createdAt: 3 }

  assert.deepEqual(pendingBotanicAgentTurnProjection([userA, staleA, userB]), userA)
  assert.deepEqual(pendingBotanicAgentTurnProjection([
    userA, { ...staleA, status: 'answered' as const }, userB,
  ]), userB)
})

test('带 Stop 意图但尚未拿到 turnId 的用户 Message 仍进入同 key 恢复队列', () => {
  const cancelledBeforeAccepted = {
    id: 'user-stop', role: 'user' as const, createdAt: 1, turnCancellationRequestedAt: 10,
  }
  assert.deepEqual(pendingBotanicAgentTurnProjection([cancelledBeforeAccepted]), cancelledBeforeAccepted)
})

test('语义失败的用户 Message 即使保留 Stop 审计字段也不再阻塞后续恢复', () => {
  const failed = {
    id: 'user-failed', role: 'user' as const, createdAt: 1,
    status: 'failed' as const, turnCancellationRequestedAt: 10,
  }
  const next = { id: 'user-next', role: 'user' as const, createdAt: 2, status: 'pending' as const }
  assert.deepEqual(pendingBotanicAgentTurnProjection([failed, next]), next)
  assert.equal(pendingBotanicAgentTurnProjection([{ ...failed, turnId: 'turn-orphan' }]), undefined)
})

test('observer 已启动后新到达的 Stop 意图仍压过 completed 结果', () => {
  const message = { id: 'user-live', role: 'user' as const, createdAt: 1 }
  assert.equal(hasBotanicAgentTurnCancellationIntent(message), false)
  assert.equal(hasBotanicAgentTurnCancellationIntent(message, 20), true)
  assert.equal(hasBotanicAgentTurnCancellationIntent({
    ...message, turnCancellationRequestedAt: 10,
  }), true)
})

test('Turn 请求 accepted 前断线后，pending 用户 Message 仍进入同 key 恢复队列', () => {
  const submittedBeforeDisconnect = {
    id: 'user-disconnected', role: 'user' as const, createdAt: 1, status: 'pending' as const,
  }
  assert.deepEqual(pendingBotanicAgentTurnProjection([submittedBeforeDisconnect]), submittedBeforeDisconnect)
  assert.equal(pendingBotanicAgentTurnProjection([{ ...submittedBeforeDisconnect, status: 'failed' }]), undefined)
})

test('刷新恢复 generation 时合并 settingsHint，和首轮执行使用同一生成参数', () => {
  assert.deepEqual(botanicAgentTurnGenerationContinuation({
    kind: 'generation', mediaKind: 'image', prompt: '海边广告图', count: 2,
    selectedResultNodeId: 'result-original',
    axisLabel: '光线', variants: [{ label: '晨光', promptDelta: '清晨' }],
    settingsHint: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
  }, 'turn-generation'), {
    targetNodeId: 'result-original',
    resolvedGeneration: {
      mediaKind: 'image', prompt: '海边广告图', count: 2,
      variationAxisLabel: '光线', variants: [{ label: '晨光', promptDelta: '清晨' }],
      turnId: 'turn-generation',
    },
    generationOverrides: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
  })
})

test('无 settingsHint 的 generation continuation 仍保留 immutable target 供失败重试', () => {
  const continuation = botanicAgentTurnGenerationContinuation({
    kind: 'generation', mediaKind: 'image', prompt: '换背景', count: 1,
    selectedResultNodeId: 'result-original',
  }, 'turn-no-settings')
  assert.equal(continuation.targetNodeId, 'result-original')
  assert.equal(continuation.generationOverrides, undefined)
  assert.equal(
    resolveBotanicAgentContinuationTarget(continuation.targetNodeId, (nodeId) => ({ id: nodeId })).id,
    'result-original',
  )
})

test('恢复 generation 只解析 Turn 固定的目标，已删除时 fail closed 而不猜当前选中', () => {
  const targets = new Map([
    ['result-original', { id: 'result-original', label: '原结果' }],
    ['result-current', { id: 'result-current', label: '刷新后当前结果' }],
  ])
  assert.deepEqual(
    resolveBotanicAgentContinuationTarget('result-original', (nodeId) => targets.get(nodeId)),
    { id: 'result-original', label: '原结果' },
  )
  assert.equal(resolveBotanicAgentContinuationTarget(null, () => targets.get('result-current')), undefined)
  assert.throws(
    () => resolveBotanicAgentContinuationTarget('result-deleted', (nodeId) => targets.get(nodeId)),
    (error: unknown) => (error as { code?: string }).code === 'AGENT_TURN_TARGET_NOT_FOUND',
  )
  assert.throws(
    () => resolveBotanicAgentContinuationTarget(undefined, (nodeId) => targets.get(nodeId)),
    (error: unknown) => (error as { code?: string }).code === 'AGENT_TURN_TARGET_IDENTITY_MISSING',
  )
})

test('同一稳定 key 的 Turn 恢复持续重试 404 与传输错误，不清除恢复意图', async () => {
  const attempts: string[] = []
  const waits: string[] = []
  const recovered = await retryBotanicAgentTurnRecovery({
    attempt: async () => {
      attempts.push(`attempt-${attempts.length + 1}`)
      if (attempts.length === 1) throw Object.assign(new Error('not visible'), { status: 404 })
      if (attempts.length === 2) throw Object.assign(new Error('offline'), { status: 0 })
      return { runtimeTurnId: 'turn-recovered' }
    },
    wait: async () => { waits.push('wait') },
  })

  assert.deepEqual(recovered, { runtimeTurnId: 'turn-recovered' })
  assert.deepEqual(attempts, ['attempt-1', 'attempt-2', 'attempt-3'])
  assert.deepEqual(waits, ['wait', 'wait'])
})

test('历史 turnId 持续 404 达到边界后改走同 key POST 校验，非 404 仍原样失败', async () => {
  assert.equal(shouldRevalidateMissingBotanicAgentTurn({ status: 404 }, 2_000, 2_000), true)
  assert.equal(shouldRevalidateMissingBotanicAgentTurn({ status: 404 }, 1_999, 2_000), false)
  assert.equal(shouldRevalidateMissingBotanicAgentTurn({ status: 0 }, 2_000, 2_000), false)

  const calls: string[] = []
  const recovered = await revalidateMissingBotanicAgentTurn({
    observe: async () => {
      calls.push('observe')
      throw Object.assign(new Error('missing'), { status: 404 })
    },
    markRevalidation: () => { calls.push('mark') },
    submit: async () => {
      calls.push('submit')
      return { runtimeTurnId: 'turn-revalidated' }
    },
  })
  assert.deepEqual(recovered, { runtimeTurnId: 'turn-revalidated' })
  assert.deepEqual(calls, ['observe', 'mark', 'submit'])

  await assert.rejects(revalidateMissingBotanicAgentTurn({
    observe: async () => { throw Object.assign(new Error('offline'), { status: 0 }) },
    submit: async () => { throw new Error('unexpected submit') },
  }), /offline/u)
})

test('Turn 恢复对身份冲突 fail closed，不把语义错误当网络抖动无限重试', async () => {
  let attempts = 0
  await assert.rejects(retryBotanicAgentTurnRecovery({
    attempt: async () => {
      attempts += 1
      throw Object.assign(new Error('identity mismatch'), {
        status: 409,
        code: 'AGENT_TURN_IDENTITY_MISMATCH',
      })
    },
    wait: async () => { throw new Error('unexpected wait') },
  }), /identity mismatch/u)
  assert.equal(attempts, 1)
})

test('恢复只重试缺失 Turn 的 404，项目/会话/消息资源 404 明确收口', async () => {
  assert.equal(isRetryableBotanicAgentTurnRecoveryError({ status: 0, code: 'AGENT_MESSAGE_NOT_DURABLE' }), true)
  assert.equal(isRetryableBotanicAgentTurnRecoveryError({ status: 404 }), true)
  assert.equal(isRetryableBotanicAgentTurnRecoveryError({ status: 404, code: 'AGENT_TURN_NOT_FOUND' }), true)
  assert.equal(isRetryableBotanicAgentTurnRecoveryError({ status: 404, code: 'PROJECT_NOT_FOUND' }), false)
  assert.equal(isRetryableBotanicAgentTurnRecoveryError({ status: 404, code: 'AGENT_SESSION_NOT_FOUND' }), false)
  assert.equal(isRetryableBotanicAgentTurnRecoveryError({ status: 404, code: 'AGENT_MESSAGE_NOT_FOUND' }), false)

  let attempts = 0
  await assert.rejects(retryBotanicAgentTurnRecovery({
    attempt: async () => {
      attempts += 1
      throw Object.assign(new Error('project missing'), { status: 404, code: 'PROJECT_NOT_FOUND' })
    },
    wait: async () => { throw new Error('unexpected wait') },
  }), /project missing/u)
  assert.equal(attempts, 1)
})

test('Stop 对 durable Turn 只请求深取消并继续观察；非 Turn 工作才中断本地请求', async () => {
  const calls: string[] = []
  const durable = await stopBotanicAgentPlanning({
    turnId: 'turn-active',
    cancelTurn: async (turnId) => { calls.push(`cancel:${turnId}`) },
    abortLocalRequest: () => { calls.push('abort') },
  })
  assert.deepEqual(durable, { kind: 'cancelling', turnId: 'turn-active' })
  assert.deepEqual(calls, ['cancel:turn-active'])

  const awaitingIdentity = await stopBotanicAgentPlanning({
    turnIdentityPending: true,
    cancelTurn: async () => { calls.push('unexpected-cancel') },
    cancelWhenAccepted: () => { calls.push('cancel-when-accepted') },
    abortLocalRequest: () => { calls.push('abort') },
  })
  assert.deepEqual(awaitingIdentity, { kind: 'awaiting_turn_identity' })
  assert.deepEqual(calls, ['cancel:turn-active', 'cancel-when-accepted'])

  const local = await stopBotanicAgentPlanning({
    cancelTurn: async () => { calls.push('unexpected-cancel') },
    abortLocalRequest: () => { calls.push('abort') },
  })
  assert.deepEqual(local, { kind: 'aborted_local' })
  assert.deepEqual(calls, ['cancel:turn-active', 'cancel-when-accepted', 'abort'])
})

test('Stop 的 404/断网只保留取消意图并重试，不伪造 cancelled 或 abort observer', async () => {
  const attempts: number[] = []
  const result = await retryBotanicAgentTurnCancellation({
    turnId: 'turn-eventual',
    cancelTurn: async () => {
      attempts.push(attempts.length + 1)
      if (attempts.length === 1) throw Object.assign(new Error('not visible yet'), { status: 404 })
      if (attempts.length === 2) throw Object.assign(new Error('offline'), { status: 0 })
    },
    wait: async () => undefined,
  })
  assert.deepEqual(result, { kind: 'cancelling', turnId: 'turn-eventual' })
  assert.deepEqual(attempts, [1, 2, 3])

  const calls: string[] = []
  await assert.rejects(stopBotanicAgentPlanning({
    turnId: 'turn-404',
    cancelTurn: async () => { throw Object.assign(new Error('missing'), { status: 404 }) },
    abortLocalRequest: () => { calls.push('abort') },
  }), /missing/u)
  assert.deepEqual(calls, [])
})
