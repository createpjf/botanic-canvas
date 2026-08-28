import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentThreadContext } from './agentThreadContext.mjs'
import { encodeAgentMessageCursor } from './agentMessagePersistence.mjs'
import { agentContextStateCompareAndSetDecision } from './agentContextPersistence.mjs'

const message = (id, role, content, createdAt) => ({
  id,
  role,
  kind: 'text',
  content,
  createdAt,
  updatedAt: createdAt,
})

function storeWithSession(session, overrides = {}) {
  const writes = []
  return {
    writes,
    async listAgentSessions() {
      const { messages: _messages, ...settings } = session
      return [structuredClone(settings)]
    },
    async listAgentSessionMessages() {
      return { messages: structuredClone(session.messages ?? []) }
    },
    async compareAndSetAgentThreadSummary(userId, command) {
      writes.push({ userId, command: structuredClone(command) })
      return {
        kind: 'updated', changed: true,
        session: { ...structuredClone(session), threadSummary: structuredClone(command.summary) },
      }
    },
    ...overrides,
  }
}

function contextV2StoreWithSession(session) {
  const store = storeWithSession(session)
  let contextState = {
    version: 2, sessionId: session.id, projectId: 'project-1', revision: 0, updatedAt: 0,
  }
  const ledger = []
  return {
    ...store,
    async readAgentContextState() { return structuredClone(contextState) },
    async listAgentContextCompactions(_userId, _projectId, _sessionId, options) {
      return {
        compactions: ledger
          .filter((entry) => entry.compaction && entry.sequence > options.afterSequence)
          .slice(0, options.limit)
          .map((entry) => ({ ...structuredClone(entry.compaction), sequence: entry.sequence, createdAt: entry.createdAt })),
      }
    },
    async compareAndSetAgentContextState(_userId, command) {
      const replayEntry = ledger.find((entry) => entry.idempotencyKey === command.idempotencyKey)
      const decision = agentContextStateCompareAndSetDecision({
        state: contextState, replayEntry, command, ownerId: 'user-1', observedAt: 100 + contextState.revision,
      })
      if (decision.changed) {
        contextState = structuredClone(decision.state)
        ledger.push(structuredClone(decision.ledgerEntry))
      }
      const { ledgerEntry: _ledgerEntry, ...publicDecision } = decision
      return structuredClone(publicDecision)
    },
  }
}

test('Context V2 生成带策略、ledger head、Message revision 与 meter 的不可变快照', async () => {
  const observations = []
  const history = Array.from({ length: 12 }, (_, index) => message(
    `m-${index + 1}`, index % 2 ? 'assistant' : 'user', `消息 ${index + 1} ${'中'.repeat(300)}`, index + 1,
  ))
  const session = {
    id: 'session-context-v2', title: 'Context V2', executionMode: 'manual', contextNodeIds: [],
    createdAt: 1, updatedAt: 12, messages: history,
  }
  const context = createAgentThreadContext({
    productStore: contextV2StoreWithSession(session),
    contextV2: {
      enabled: true,
      policies: {
        models: {
          'test-model': {
            contextWindowTokens: 4_096, outputReserveTokens: 512, safetyMarginTokens: 128,
            autoCompactRatio: 0.5, retainRecentRatio: 0.1,
          },
        },
      },
      observe: (event) => observations.push(event),
    },
  })
  const resolved = await context.resolve({
    userId: 'user-1', projectId: 'project-1', sessionId: session.id, model: 'test-model',
    inputMessage: message('m-current', 'user', '继续处理', 13),
  })
  assert.equal(resolved.threadContextSnapshot.version, 2)
  assert.equal(resolved.threadContextSnapshot.modelPolicy.model, 'test-model')
  assert.ok(resolved.threadContextSnapshot.compactionHead.id)
  assert.ok(resolved.threadContextSnapshot.checkpoint.content)
  assert.equal(resolved.threadContextSnapshot.messages.at(-1).id, 'm-current')
  assert.equal(typeof resolved.threadContextSnapshot.messages.at(-1).revision, 'string')
  assert.ok(resolved.threadContextSnapshot.contextMeter.inputTokens > 0)
  assert.equal(resolved.messages[0].content, resolved.threadContextSnapshot.checkpoint.content)
  assert.equal(resolved.messages.at(-1).content, '继续处理')
  assert.ok(observations.some((event) => (
    event.name === 'agent.context.compaction' && event.outcome === 'compacted'
  )))
})

test('Context V2 rollout 未开启时不要求新增 Store 接口且继续产出 v1', async () => {
  const session = {
    id: 'session-context-off', title: 'Legacy', executionMode: 'manual', contextNodeIds: [],
    createdAt: 1, updatedAt: 1, messages: [message('m-1', 'assistant', '旧回答', 1)],
  }
  const context = createAgentThreadContext({
    productStore: storeWithSession(session),
    contextV2: { isEnabled: () => false, policies: {} },
  })
  const resolved = await context.resolve({
    userId: 'user-1', projectId: 'project-1', sessionId: session.id, model: 'test-model',
    inputMessage: message('m-2', 'user', '继续', 2),
  })
  assert.equal(resolved.threadContextSnapshot.version, 1)
})

test('线程投影只读当前 Session 与其消息页，不拉整个项目的 Memory/Run/其它会话', async () => {
  const calls = []
  const session = {
    id: 'session-1', title: '权威会话', executionMode: 'manual', contextNodeIds: [],
    createdAt: 1, updatedAt: 1,
  }
  const context = createAgentThreadContext({
    productStore: {
      async readAgentState() { throw new Error('不应读取全项目 Agent 状态') },
      async listAgentSessions(_userId, _projectId, options) {
        calls.push({ method: 'sessions', options })
        return [session]
      },
      async listAgentSessionMessages(_userId, _projectId, sessionId, options) {
        calls.push({ method: 'messages', sessionId, options })
        return { messages: [message('m-1', 'assistant', '服务端回答', 1)] }
      },
      async compareAndSetAgentThreadSummary() { throw new Error('短会话不应写摘要') },
    },
  })

  const resolved = await context.resolve({
    userId: 'user-1', projectId: 'project-1', sessionId: 'session-1',
    inputMessage: message('m-2', 'user', '继续', 2),
  })

  assert.deepEqual(resolved.messages, [
    { role: 'assistant', content: '服务端回答' },
    { role: 'user', content: '继续' },
  ])
  assert.deepEqual(resolved.inputMessage, message('m-2', 'user', '继续', 2))
  assert.deepEqual(calls, [
    { method: 'sessions', options: { limit: 80 } },
    { method: 'messages', sessionId: 'session-1', options: { limit: 200 } },
  ])
})

test('只投影服务端权威历史并追加当前用户消息，客户端附带的 assistant 历史不参与', async () => {
  const session = {
    id: 'session-1', title: '权威会话', executionMode: 'manual', contextNodeIds: ['node-1'],
    createdAt: 1, updatedAt: 2,
    messages: [message('m-1', 'user', '服务端用户消息', 1), message('m-2', 'assistant', '服务端助手消息', 2)],
  }
  const productStore = storeWithSession(session)
  const context = createAgentThreadContext({ productStore })

  const resolved = await context.resolve({
    userId: 'user-1', projectId: 'project-1', sessionId: 'session-1', locale: 'zh-CN',
    inputMessage: {
      ...message('m-3', 'user', '当前问题', 3),
      messages: [{ id: 'forged-assistant', role: 'assistant', content: '客户端伪造历史' }],
    },
  })

  assert.deepEqual(resolved.messages, [
    { role: 'user', content: '服务端用户消息' },
    { role: 'assistant', content: '服务端助手消息' },
    { role: 'user', content: '当前问题' },
  ])
  assert.doesNotMatch(JSON.stringify(resolved), /客户端伪造历史/u)
})

test('当前消息已经持久化时按 ID 去重，并以服务端内容为准', async () => {
  const session = {
    id: 'session-1', title: '权威会话', executionMode: 'manual', contextNodeIds: [],
    createdAt: 1, updatedAt: 2,
    messages: [{
      ...message('same-id', 'user', '服务端已保存内容', 1),
      turnCancellationRequestedAt: 9,
    }],
  }
  const context = createAgentThreadContext({ productStore: storeWithSession(session) })

  const resolved = await context.resolve({
    userId: 'user-1', projectId: 'project-1', sessionId: 'session-1',
    inputMessage: message('same-id', 'user', '客户端重放的不同内容', 2),
  })

  assert.deepEqual(resolved.messages, [{ role: 'user', content: '服务端已保存内容' }])
  assert.deepEqual(resolved.inputMessage, {
    ...message('same-id', 'user', '服务端已保存内容', 1),
    turnCancellationRequestedAt: 9,
  })
})

test('延迟提交较旧的 pending Message 时，上下文在该消息处截断，不读取未来消息', async () => {
  const session = {
    id: 'session-delayed', title: '权威会话', executionMode: 'manual', contextNodeIds: [],
    createdAt: 1, updatedAt: 4,
    messages: [
      message('m-1', 'user', '第一问', 1),
      message('m-2', 'assistant', '第一答', 2),
      message('m-pending', 'user', '延迟提交的问题', 3),
      message('m-future', 'assistant', '该请求创建之后才出现的回答', 4),
    ],
  }
  const context = createAgentThreadContext({ productStore: storeWithSession(session) })

  const resolved = await context.resolve({
    userId: 'user-1', projectId: 'project-1', sessionId: session.id,
    inputMessage: message('m-pending', 'user', '客户端重放内容不能胜出', 30),
  })

  assert.deepEqual(resolved.messages, [
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '第一答' },
    { role: 'user', content: '延迟提交的问题' },
  ])
  assert.doesNotMatch(JSON.stringify(resolved), /该请求创建之后/u)
})

test('延迟提交较旧 Message 时不沿用已覆盖未来消息的 Session 摘要', async () => {
  const earlier = Array.from({ length: 9 }, (_, index) => message(
    `m-${index + 1}`, 'user', `历史目标 ${index + 1}`, index + 1,
  ))
  const session = {
    id: 'session-delayed-summary', title: '权威会话', executionMode: 'manual', contextNodeIds: [],
    createdAt: 1, updatedAt: 12,
    threadSummary: {
      version: 1,
      goals: ['未来才出现的机密目标'],
      decisions: [], constraints: ['future:locked'], openQuestions: [],
      entityIds: ['m-future'],
      coveredMessageIds: ['m-future'],
      coveredMessageRevisions: [{ messageId: 'm-future', revision: '12:' }],
      coveredThrough: 12,
      updatedAt: 12,
    },
    messages: [
      ...earlier,
      message('m-pending', 'user', '延迟提交的问题', 10),
      message('m-future', 'assistant', '未来回答', 12),
    ],
  }
  const productStore = storeWithSession(session)
  const context = createAgentThreadContext({ productStore, now: () => 20 })

  const resolved = await context.resolve({
    userId: 'user-1', projectId: 'project-1', sessionId: session.id,
    inputMessage: message('m-pending', 'user', '客户端重放内容不能胜出', 30),
  })

  assert.ok(resolved.threadSummary, '完整的截止历史可以无 previous 重建当轮摘要')
  assert.doesNotMatch(JSON.stringify(resolved.threadContextSnapshot), /未来才出现|future|m-future/u)
  assert.equal(resolved.threadSummary.coveredMessageIds.includes('m-pending'), true)
  assert.equal(productStore.writes.length, 0, '历史截止快照不能回写覆盖当前 Session 摘要')
})

test('较旧输入不在最新消息页时有界回溯定位，不把整页未来消息当成历史', async () => {
  const allMessages = Array.from({ length: 250 }, (_, index) => message(
    `m-${index + 1}`,
    index % 2 ? 'assistant' : 'user',
    `消息 ${index + 1}`,
    index + 1,
  ))
  const reads = []
  const context = createAgentThreadContext({
    productStore: {
      async listAgentSessions() {
        return [{
          id: 'session-old-page', title: '长会话', executionMode: 'manual', createdAt: 1, updatedAt: 250,
          threadSummary: {
            version: 1, goals: ['未来页目标'], decisions: [], constraints: [], openQuestions: [],
            entityIds: ['m-250'], coveredMessageIds: ['m-250'],
            coveredMessageRevisions: [{ messageId: 'm-250', revision: '250:' }],
            coveredThrough: 250, updatedAt: 250,
          },
        }]
      },
      async listAgentSessionMessages(_userId, _projectId, _sessionId, options) {
        reads.push(structuredClone(options))
        const candidates = allMessages
          .filter((entry) => !options.before
            || entry.updatedAt < options.before.updatedAt
            || (entry.updatedAt === options.before.updatedAt && entry.id.localeCompare(options.before.id) < 0))
          .sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id))
          .slice(0, options.limit)
        const oldest = candidates.at(-1)
        return {
          messages: structuredClone(candidates).reverse(),
          nextBefore: candidates.length === options.limit && oldest
            ? encodeAgentMessageCursor(oldest)
            : undefined,
        }
      },
      async compareAndSetAgentThreadSummary() {
        throw new Error('历史截止快照不应回写')
      },
    },
  })

  const resolved = await context.resolve({
    userId: 'user-1', projectId: 'project-1', sessionId: 'session-old-page',
    inputMessage: message('m-19', 'user', '客户端伪造内容', 999),
  })

  assert.deepEqual(reads.map((entry) => entry.limit), [200, 200])
  assert.equal(resolved.messages.at(-1).content, '消息 19')
  assert.doesNotMatch(JSON.stringify(resolved.threadContextSnapshot), /未来页目标|m-250|消息 20/u)
})

test('当前 Message ID 若已属于 assistant，明确报身份冲突而不是吞掉本轮输入', async () => {
  const session = {
    id: 'session-1', title: '权威会话', executionMode: 'manual', contextNodeIds: [],
    createdAt: 1, updatedAt: 2,
    messages: [message('same-id', 'assistant', '服务端助手消息', 1)],
  }
  const context = createAgentThreadContext({ productStore: storeWithSession(session) })

  await assert.rejects(
    () => context.resolve({
      userId: 'user-1', projectId: 'project-1', sessionId: 'session-1',
      inputMessage: message('same-id', 'user', '客户端当前输入', 2),
    }),
    (caught) => caught?.code === 'AGENT_THREAD_INPUT_CONFLICT' && caught?.statusCode === 409,
  )
})

test('模型窗口最多保留最后 16 条且包含最新用户消息', async () => {
  const history = Array.from({ length: 20 }, (_, index) => message(
    `m-${index + 1}`,
    index % 2 ? 'assistant' : 'user',
    `消息 ${index + 1}`,
    index + 1,
  ))
  const session = {
    id: 'session-1', title: '长会话', executionMode: 'manual', contextNodeIds: [],
    createdAt: 1, updatedAt: 20, messages: history,
  }
  const context = createAgentThreadContext({ productStore: storeWithSession(session) })

  const resolved = await context.resolve({
    userId: 'user-1', projectId: 'project-1', sessionId: 'session-1',
    inputMessage: message('m-21', 'user', '消息 21', 21),
  })

  assert.equal(resolved.messages.length, 16)
  assert.equal(resolved.messages[0].content, '消息 6')
  assert.equal(resolved.messages.at(-1).content, '消息 21')
})

test('中文长历史按总 token 预算从旧到新裁剪，当前输入完整保留', async () => {
  const history = Array.from({ length: 6 }, (_, index) => message(
    `m-${index + 1}`,
    index % 2 ? 'assistant' : 'user',
    `第 ${index + 1} 条：${'中'.repeat(2_000)}`,
    index + 1,
  ))
  const session = {
    id: 'session-zh-budget', title: '中文预算', executionMode: 'manual', contextNodeIds: [],
    createdAt: 1, updatedAt: 6, messages: history,
  }
  const current = `当前输入：${'问'.repeat(3_500)}`
  const context = createAgentThreadContext({ productStore: storeWithSession(session) })

  const resolved = await context.resolve({
    userId: 'user-1', projectId: 'project-1', sessionId: session.id,
    inputMessage: message('m-current', 'user', current, 7),
  })

  assert.equal(resolved.messages.at(-1).content, current)
  assert.equal(resolved.messages.length, 3)
  assert.match(resolved.messages[0].content, /^第 5 条：/u)
  assert.equal(resolved.threadContextSnapshot.contextBudget.limit, 8_000)
  assert.equal(resolved.threadContextSnapshot.contextBudget.omittedMessages, 4)
  assert.ok(resolved.threadContextSnapshot.contextBudget.estimatedTokens <= 8_000)
})

test('英文长历史使用保守估算并确定性保留最新连续窗口', async () => {
  const history = Array.from({ length: 6 }, (_, index) => message(
    `m-${index + 1}`,
    index % 2 ? 'assistant' : 'user',
    `message-${index + 1}:${'a'.repeat(3_980)}`,
    index + 1,
  ))
  const session = {
    id: 'session-en-budget', title: 'English budget', executionMode: 'manual', contextNodeIds: [],
    createdAt: 1, updatedAt: 6, messages: history,
  }
  const current = `current:${'b'.repeat(3_980)}`
  const context = createAgentThreadContext({ productStore: storeWithSession(session) })

  const first = await context.resolve({
    userId: 'user-1', projectId: 'project-1', sessionId: session.id, locale: 'en',
    inputMessage: message('m-current', 'user', current, 7),
  })
  const second = await context.resolve({
    userId: 'user-1', projectId: 'project-1', sessionId: session.id, locale: 'en',
    inputMessage: message('m-current', 'user', current, 7),
  })

  assert.deepEqual(second.threadContextSnapshot, first.threadContextSnapshot)
  assert.equal(first.messages.at(-1).content, current)
  assert.equal(first.messages.length, 5)
  assert.match(first.messages[0].content, /^message-3:/u)
  assert.equal(first.threadContextSnapshot.contextBudget.omittedMessages, 2)
  assert.ok(first.threadContextSnapshot.contextBudget.estimatedTokens <= 8_000)
})

test('权威历史单条消息仍受模型窗口字数上限约束', async () => {
  const session = {
    id: 'session-1', title: '长消息会话', executionMode: 'manual', contextNodeIds: [],
    createdAt: 1, updatedAt: 2,
    messages: [message('m-1', 'assistant', '长'.repeat(12_000), 1)],
  }
  const context = createAgentThreadContext({ productStore: storeWithSession(session) })

  const resolved = await context.resolve({
    userId: 'user-1', projectId: 'project-1', sessionId: 'session-1',
    inputMessage: message('m-2', 'user', '继续', 2),
  })

  assert.equal(resolved.messages[0].content.length, 4000)
  assert.equal(resolved.messages.at(-1).content, '继续')
})

test('当前输入超过历史 4k 单条上限仍完整保留，并先挤压 summary/history', async () => {
  const decisions = Array.from({ length: 12 }, (_, index) => ({
    messageId: `decision-${index + 1}`,
    summary: `历史决策 ${index + 1}：${'固'.repeat(400)}`,
    decidedAt: index + 1,
  }))
  const history = Array.from({ length: 9 }, (_, index) => message(
    `m-${index + 1}`, 'assistant', `历史回复 ${index + 1}`, index + 1,
  ))
  const session = {
    id: 'session-current-large', title: '大输入', executionMode: 'manual', contextNodeIds: [],
    createdAt: 1, updatedAt: 9, messages: history,
    threadSummary: {
      version: 1, goals: [], decisions, constraints: [], openQuestions: [], entityIds: [],
      coveredMessageIds: history.map((entry) => entry.id),
      coveredMessageRevisions: history.map((entry) => ({
        messageId: entry.id, revision: `${entry.updatedAt}:`,
      })),
      coveredThrough: 9, updatedAt: 9,
    },
  }
  const current = `当前长输入：${'问'.repeat(7_000)}`
  const context = createAgentThreadContext({ productStore: storeWithSession(session) })

  const resolved = await context.resolve({
    userId: 'user-1', projectId: 'project-1', sessionId: session.id,
    inputMessage: message('m-current-large', 'user', current, 10),
  })

  assert.equal(resolved.messages.at(-1).content, current)
  assert.ok(resolved.messages.at(-1).content.length > 4_000)
  assert.ok(resolved.contextBudget.summaryTokens < 1_000)
  assert.ok(resolved.contextBudget.estimatedTokens <= 8_000)
})

test('当前输入自身已超过 thread 总预算时明确 413，不静默丢尾', async () => {
  const session = {
    id: 'session-current-too-large', title: '过大输入', executionMode: 'manual', contextNodeIds: [],
    createdAt: 1, updatedAt: 1, messages: [],
  }
  const context = createAgentThreadContext({ productStore: storeWithSession(session) })

  await assert.rejects(
    () => context.resolve({
      userId: 'user-1', projectId: 'project-1', sessionId: session.id,
      inputMessage: message('m-too-large', 'user', '超'.repeat(8_100), 2),
    }),
    (caught) => caught?.code === 'AGENT_THREAD_INPUT_TOO_LARGE' && caught?.statusCode === 413,
  )
})

test('仅带引用芯片的消息在模型投影时得到安全指令，权威 Message 正文保持为空', async () => {
  const session = {
    id: 'session-1', title: '会话', executionMode: 'manual', contextNodeIds: [],
    createdAt: 1, updatedAt: 1, messages: [],
  }
  const inputMessage = {
    ...message('m-1', 'user', '', 1),
    mentions: [{ kind: 'reference', id: 'asset-1', label: '商品正面图' }],
  }
  const context = createAgentThreadContext({ productStore: storeWithSession(session) })

  const resolved = await context.resolve({
    userId: 'user-1', projectId: 'project-1', sessionId: 'session-1', locale: 'zh-CN', inputMessage,
  })

  assert.deepEqual(resolved.messages, [{ role: 'user', content: '按已引用素材处理。' }])
  assert.equal(inputMessage.content, '')
})

test('有正文的引用消息仍把芯片写进模型可见内容，避免 Agent 以为没选图', async () => {
  const session = {
    id: 'session-1', title: '会话', executionMode: 'manual', contextNodeIds: [],
    createdAt: 1, updatedAt: 1, messages: [],
  }
  const context = createAgentThreadContext({ productStore: storeWithSession(session) })
  const resolved = await context.resolve({
    userId: 'user-1', projectId: 'project-1', sessionId: 'session-1', locale: 'zh-CN',
    inputMessage: {
      ...message('m-ref', 'user', '让这个模特身上的光线更像室外', 1),
      mentions: [{ kind: 'reference', id: 'asset-1', label: 'Mia 肖像' }],
    },
  })
  assert.deepEqual(resolved.messages, [{
    role: 'user',
    content: '让这个模特身上的光线更像室外\n已引用：Mia 肖像。',
  }])
})

test('长会话确定性派生摘要并以专用 CAS 写回', async () => {
  const session = {
    id: 'session-1', title: '保留标题', executionMode: 'auto', plannerModel: 'model-1',
    mountedSkillIds: ['skill-1'], contextNodeIds: ['node-1'], createdAt: 1, updatedAt: 9,
    messages: Array.from({ length: 9 }, (_, index) => message(`m-${index + 1}`, 'user', `目标 ${index + 1}`, index + 1)),
  }
  const productStore = storeWithSession(session)
  const context = createAgentThreadContext({ productStore })

  const resolved = await context.resolve({
    userId: 'user-1', projectId: 'project-1', sessionId: 'session-1',
    inputMessage: message('m-10', 'user', '继续', 10),
  })

  assert.ok(resolved.threadSummary)
  assert.deepEqual(resolved.threadContextSnapshot, {
    version: 1,
    messages: resolved.messages,
    threadSummary: resolved.threadSummary,
    threadSummaryText: resolved.threadSummaryText,
    contextBudget: resolved.contextBudget,
  })
  assert.equal(resolved.threadSummary.coveredMessageIds.includes('m-10'), false)
  assert.equal(productStore.writes.length, 1)
  assert.equal(productStore.writes[0].command.expectedUpdatedAt, null)
  assert.deepEqual(productStore.writes[0], {
    userId: 'user-1',
    command: {
      sessionId: session.id,
      expectedUpdatedAt: null,
      summary: resolved.threadSummary,
    },
  })
})

test('结构化摘要的实际注入文本一同固化并受摘要 token 上限约束', async () => {
  const decisions = Array.from({ length: 12 }, (_, index) => ({
    messageId: `decision-${index + 1}`,
    summary: `决策 ${index + 1}：${'固'.repeat(400)}`,
    decidedAt: index + 1,
  }))
  const session = {
    id: 'session-summary-budget', title: '摘要预算', executionMode: 'manual', contextNodeIds: [],
    createdAt: 1, updatedAt: 9,
    threadSummary: {
      version: 1, goals: [], decisions, constraints: [], openQuestions: [], entityIds: [],
      factCandidates: decisions.map((decision, index) => ({
        messageId: decision.messageId,
        revision: `${index + 1}:submitted`,
        occurredAt: index + 1,
        decisions: [decision],
      })),
      coveredMessageIds: Array.from({ length: 9 }, (_, index) => `m-${index + 1}`),
      coveredMessageRevisions: Array.from({ length: 9 }, (_, index) => ({
        messageId: `m-${index + 1}`, revision: `${index + 1}:`,
      })),
      coveredThrough: 9, updatedAt: 9,
    },
    messages: Array.from({ length: 9 }, (_, index) => message(
      `m-${index + 1}`, 'assistant', `普通回复 ${index + 1}`, index + 1,
    )),
  }
  const context = createAgentThreadContext({ productStore: storeWithSession(session) })

  const resolved = await context.resolve({
    userId: 'user-1', projectId: 'project-1', sessionId: session.id,
    inputMessage: message('m-current', 'user', '继续', 10),
  })

  assert.equal(resolved.threadContextSnapshot.threadSummaryText, resolved.threadSummaryText)
  assert.match(resolved.threadSummaryText, /本线程早前已经定下/u)
  assert.match(resolved.threadSummaryText, /已按 token 预算截断/u)
  assert.ok(resolved.contextBudget.summaryTokens <= 2_000)
  assert.ok(resolved.contextBudget.estimatedTokens <= resolved.contextBudget.limit)
})

test('增量摘要版本严格晚于当前摘要，不依赖较旧的 Session 主更新时间', async () => {
  const previous = {
    version: 1, goals: ['旧目标'], decisions: [], constraints: [], openQuestions: [], entityIds: [],
    coveredMessageIds: ['m-1'], coveredMessageRevisions: [{ messageId: 'm-1', revision: '1:' }],
    coveredThrough: 1, updatedAt: 200,
  }
  const session = {
    id: 'session-summary-version', title: '长会话', executionMode: 'manual', contextNodeIds: [],
    createdAt: 1, updatedAt: 9, threadSummary: previous,
    messages: Array.from({ length: 9 }, (_, index) => message(`m-${index + 1}`, 'user', `目标 ${index + 1}`, index + 1)),
  }
  const productStore = storeWithSession(session)
  const context = createAgentThreadContext({ productStore, now: () => 100 })

  const resolved = await context.resolve({
    userId: 'user-1', projectId: 'project-1', sessionId: session.id,
    inputMessage: message('m-10', 'user', '继续', 10),
  })

  assert.equal(resolved.threadSummary.updatedAt, 201)
  assert.equal(productStore.writes[0].command.expectedUpdatedAt, 200)
  assert.equal(productStore.writes[0].command.summary.updatedAt, 201)
})

test('摘要 CAS 冲突不覆盖新摘要，当前 turn 仍使用本次派生结果', async () => {
  const session = {
    id: 'session-cas-race', title: '长会话', executionMode: 'manual', contextNodeIds: [],
    createdAt: 1, updatedAt: 9,
    messages: Array.from({ length: 9 }, (_, index) => message(`m-${index + 1}`, 'user', `目标 ${index + 1}`, index + 1)),
  }
  let command
  const context = createAgentThreadContext({
    productStore: storeWithSession(session, {
      async compareAndSetAgentThreadSummary(_userId, input) {
        command = structuredClone(input)
        return {
          kind: 'conflict', changed: false,
          session: { ...session, threadSummary: { version: 1, updatedAt: 200 } },
        }
      },
    }),
    now: () => 100,
  })

  const resolved = await context.resolve({
    userId: 'user-1', projectId: 'project-1', sessionId: session.id,
    inputMessage: message('m-10', 'user', '继续', 10),
  })

  assert.equal(command.expectedUpdatedAt, null)
  assert.equal(resolved.threadSummary.updatedAt, 100)
  assert.deepEqual(resolved.threadSummary.goals, ['目标 7', '目标 8', '目标 9'])
})

test('Thread Context 缺少专用 Summary CAS 时构造即失败', () => {
  assert.throws(() => createAgentThreadContext({
    productStore: {
      async listAgentSessions() { return [] },
      async listAgentSessionMessages() { return { messages: [] } },
    },
  }), /Summary CAS/u)
})

test('存量无摘要会话最多分页回溯 500 条，最早关键决策不被首页截断', async () => {
  const messages = [
    {
      id: 'm-1', role: 'assistant', kind: 'plan', status: 'submitted', content: '保留人物',
      createdAt: 1, updatedAt: 1, runId: 'run-oldest',
      plan: {
        intent: 'replace_scene', summary: '保留人物，只替换场景。',
        constraints: [{ dimension: 'person', mode: 'preserve' }],
      },
    },
    ...Array.from({ length: 400 }, (_, index) => message(
      `m-${index + 2}`, 'assistant', `普通回复 ${index + 2}`, index + 2,
    )),
  ]
  const calls = []
  const writes = []
  const productStore = {
    async listAgentSessions() {
      return [{ id: 'session-1', title: '存量会话', executionMode: 'manual', createdAt: 1, updatedAt: 401 }]
    },
    async listAgentSessionMessages(_userId, _projectId, _sessionId, options) {
      calls.push(structuredClone(options))
      const candidates = messages
        .filter((entry) => !options.before
          || entry.updatedAt < options.before.updatedAt
          || (entry.updatedAt === options.before.updatedAt && entry.id.localeCompare(options.before.id) < 0))
        .sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id))
        .slice(0, options.limit)
      const oldest = candidates.at(-1)
      return {
        messages: structuredClone(candidates).reverse(),
        nextBefore: candidates.length === options.limit && oldest
          ? encodeAgentMessageCursor(oldest)
          : undefined,
      }
    },
    async compareAndSetAgentThreadSummary(_userId, command) {
      writes.push(structuredClone(command))
      return { kind: 'updated', changed: true, session: { threadSummary: command.summary } }
    },
  }
  const context = createAgentThreadContext({ productStore })

  const resolved = await context.resolve({
    userId: 'user-1', projectId: 'project-1', sessionId: 'session-1',
    inputMessage: message('m-current', 'user', '继续', 402),
  })

  assert.deepEqual(calls.map((call) => call.limit), [200, 200, 100])
  assert.equal(calls[1].before.updatedAt, 202)
  assert.equal(calls[2].before.updatedAt, 2)
  assert.deepEqual(resolved.threadSummary.decisions.map((decision) => decision.runId), ['run-oldest'])
  assert.deepEqual(resolved.threadSummary.constraints, ['person:preserve'])
  assert.equal(writes.length, 1, '完整回溯后才写回检查点')
  assert.equal(resolved.messages.length, 16, '模型窗口仍仅保留最近 16 条')
  assert.equal(resolved.messages.at(-1).content, '继续')
})

test('首次摘要回溯旧页失败时不阻断当轮，也不持久化不完整检查点', async () => {
  const latest = Array.from({ length: 200 }, (_, index) => message(
    `m-${index + 2}`, 'assistant', `最近消息 ${index + 2}`, index + 2,
  ))
  let reads = 0
  let writes = 0
  const context = createAgentThreadContext({
    productStore: {
      async listAgentSessions() {
        return [{ id: 'session-1', title: '存量会话', executionMode: 'manual', createdAt: 1, updatedAt: 201 }]
      },
      async listAgentSessionMessages() {
        reads += 1
        if (reads > 1) throw new Error('旧页暂时不可用')
        return { messages: latest, nextBefore: encodeAgentMessageCursor(latest[0]) }
      },
      async compareAndSetAgentThreadSummary() { writes += 1 },
    },
  })

  const resolved = await context.resolve({
    userId: 'user-1', projectId: 'project-1', sessionId: 'session-1',
    inputMessage: message('m-current', 'user', '继续', 202),
  })

  assert.equal(reads, 2)
  assert.equal(writes, 0, '不完整摘要不落库，下轮仍可重试回溯')
  assert.equal(resolved.messages.at(-1).content, '继续')
  assert.equal(resolved.threadSummary, undefined, '不完整历史不伪装成完整摘要')
})

test('legacy 摘要回溯失败时沿用旧摘要但不 CAS，不能用不完整消息升级 provenance', async () => {
  const latest = Array.from({ length: 200 }, (_, index) => message(
    `m-${index + 2}`, 'assistant', `最近消息 ${index + 2}`, index + 2,
  ))
  const current = { ...latest.at(-1), role: 'user', content: '当前已持久化输入' }
  latest[latest.length - 1] = current
  const legacy = {
    version: 1, goals: ['旧摘要目标'], decisions: [], constraints: [], openQuestions: [], entityIds: [],
    coveredMessageIds: ['m-1'], coveredMessageRevisions: [{ messageId: 'm-1', revision: '1:' }],
    coveredThrough: 1, updatedAt: 201,
  }
  let reads = 0
  let writes = 0
  const context = createAgentThreadContext({
    productStore: {
      async listAgentSessions() {
        return [{
          id: 'session-legacy-backfill-failure', title: '存量会话', executionMode: 'manual',
          createdAt: 1, updatedAt: 201, threadSummary: legacy,
        }]
      },
      async listAgentSessionMessages() {
        reads += 1
        if (reads > 1) throw new Error('旧页暂时不可用')
        return { messages: latest, nextBefore: encodeAgentMessageCursor(latest[0]) }
      },
      async compareAndSetAgentThreadSummary() { writes += 1 },
    },
  })

  const resolved = await context.resolve({
    userId: 'user-1', projectId: 'project-1', sessionId: 'session-legacy-backfill-failure',
    inputMessage: { ...current, content: '客户端不能覆盖' },
  })

  assert.equal(reads, 2)
  assert.equal(writes, 0)
  assert.deepEqual(resolved.threadSummary, legacy)
  assert.equal('factCandidates' in resolved.threadSummary, false)
})

test('摘要 CAS 存储/权限/迁移错误 fail closed 并保留原始业务码', async () => {
  const session = {
    id: 'session-1', title: '长会话', executionMode: 'manual', contextNodeIds: [],
    createdAt: 1, updatedAt: 9,
    messages: Array.from({ length: 9 }, (_, index) => message(`m-${index + 1}`, 'user', `目标 ${index + 1}`, index + 1)),
  }
  const context = createAgentThreadContext({
    productStore: storeWithSession(session, {
      async compareAndSetAgentThreadSummary() {
        throw Object.assign(new Error('store unavailable'), {
          code: 'AGENT_THREAD_SUMMARY_CAS_REQUIRED', statusCode: 503,
        })
      },
    }),
  })

  await assert.rejects(
    () => context.resolve({
      userId: 'user-1', projectId: 'project-1', sessionId: 'session-1',
      inputMessage: message('m-10', 'user', '继续', 10),
    }),
    (caught) => caught?.code === 'AGENT_THREAD_SUMMARY_CAS_REQUIRED'
      && caught?.statusCode === 503
      && caught?.message === 'store unavailable',
  )
})

test('Summary CAS 只允许 updated/true 或 conflict/false，invalid/not_found/unchanged 均拒绝', async (t) => {
  const session = {
    id: 'session-cas-outcome', title: '长会话', executionMode: 'manual', contextNodeIds: [],
    createdAt: 1, updatedAt: 9,
    messages: Array.from({ length: 9 }, (_, index) => message(`m-${index + 1}`, 'user', `目标 ${index + 1}`, index + 1)),
  }
  for (const outcome of [
    { kind: 'invalid', changed: false },
    { kind: 'not_found', changed: false },
    { kind: 'unchanged', changed: false },
    undefined,
  ]) {
    await t.test(outcome?.kind ?? 'missing outcome', async () => {
      const context = createAgentThreadContext({
        productStore: storeWithSession(session, {
          async compareAndSetAgentThreadSummary() { return outcome },
        }),
      })
      await assert.rejects(
        () => context.resolve({
          userId: 'user-1', projectId: 'project-1', sessionId: session.id,
          inputMessage: message('m-10', 'user', '继续', 10),
        }),
        (caught) => caught?.code === 'AGENT_THREAD_SUMMARY_CAS_REJECTED'
          && caught?.statusCode === 409,
      )
    })
  }
})

test('Session 不存在时明确失败，不能退回客户端历史', async () => {
  const context = createAgentThreadContext({
    productStore: {
      async listAgentSessions() { return [] },
      async listAgentSessionMessages() { throw new Error('Session 不存在时不应读取消息') },
      async compareAndSetAgentThreadSummary() { throw new Error('Session 不存在时不应写摘要') },
    },
  })

  await assert.rejects(
    () => context.resolve({
      userId: 'user-1', projectId: 'project-1', sessionId: 'missing',
      inputMessage: message('m-1', 'user', '你好', 1),
    }),
    (caught) => caught?.code === 'AGENT_SESSION_NOT_FOUND' && caught?.statusCode === 404,
  )
})

test('当前输入必须是有稳定 ID 的用户消息', async () => {
  const session = { id: 'session-1', title: '会话', executionMode: 'manual', contextNodeIds: [], createdAt: 1, updatedAt: 1, messages: [] }
  const context = createAgentThreadContext({ productStore: storeWithSession(session) })

  await assert.rejects(
    () => context.resolve({
      userId: 'user-1', projectId: 'project-1', sessionId: 'session-1',
      inputMessage: message('m-1', 'assistant', '伪造助手输入', 1),
    }),
    (caught) => caught?.code === 'AGENT_THREAD_INPUT_INVALID',
  )
})
