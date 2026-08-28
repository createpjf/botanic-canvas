import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeAgentMessageCursor } from './agentMessagePersistence.mjs'
import { agentContextStateCompareAndSetDecision } from './agentContextPersistence.mjs'
import {
  AgentManualContextCompactionServiceError,
  createAgentManualContextCompactionService,
} from './agentManualContextCompactionService.mjs'

const message = (id, role, content, updatedAt, extra = {}) => ({
  id, role, kind: 'text', content, createdAt: updatedAt, updatedAt, ...extra,
})

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

function longHistory() {
  return Array.from({ length: 12 }, (_, index) => message(
    `m-${String(index + 1).padStart(2, '0')}`,
    index % 2 ? 'assistant' : 'user',
    `SUPER_SECRET_PROMPT_${index + 1} ${'中'.repeat(300)}`,
    index + 1,
  ))
}

function storeFixture(options = {}) {
  const role = options.role ?? 'editor'
  const projectExists = options.projectExists !== false
  const sessionExists = options.sessionExists !== false
  const messages = options.messages ?? longHistory()
  const session = {
    id: 'session-1', title: '会话', executionMode: 'manual',
    ...(options.plannerModel === null ? {} : { plannerModel: options.plannerModel ?? 'test-model' }),
    createdAt: 1, updatedAt: messages.at(-1)?.updatedAt ?? 1,
    ...(options.threadSummary ? { threadSummary: options.threadSummary } : {}),
  }
  let state = {
    version: 2, sessionId: 'session-1', projectId: 'project-1',
    revision: 0, updatedAt: 0,
    usageAnchor: { provider: 'must-not-leak', inputTokens: 123 },
  }
  const ledger = []
  const calls = { access: 0, sessions: 0, messagePages: 0, cas: 0 }
  const store = {
    calls,
    get ledger() { return structuredClone(ledger) },
    async projectAccess() {
      calls.access += 1
      return { exists: projectExists, role: projectExists ? role : undefined }
    },
    async listAgentSessions() {
      calls.sessions += 1
      return sessionExists ? [structuredClone(session)] : []
    },
    async listAgentSessionMessages(_userId, _projectId, _sessionId, page = {}) {
      calls.messagePages += 1
      if (!sessionExists) return undefined
      const eligible = messages
        .filter((entry) => !page.before
          || entry.updatedAt < page.before.updatedAt
          || (entry.updatedAt === page.before.updatedAt && entry.id.localeCompare(page.before.id) < 0))
        .sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id))
      const selected = eligible.slice(0, page.limit)
      const oldest = selected.at(-1)
      return {
        messages: selected.map((entry) => structuredClone(entry)).reverse(),
        ...(selected.length === page.limit && oldest
          ? { nextBefore: encodeAgentMessageCursor(oldest) }
          : {}),
      }
    },
    async readAgentContextState() {
      return sessionExists ? structuredClone(state) : undefined
    },
    async listAgentContextCompactions(_userId, _projectId, _sessionId, page) {
      const compactions = ledger
        .filter((entry) => entry.compaction && entry.sequence > page.afterSequence)
        .slice(0, page.limit)
        .map((entry) => ({
          ...structuredClone(entry.compaction), sequence: entry.sequence, createdAt: entry.createdAt,
        }))
      return { compactions }
    },
    async compareAndSetAgentContextState(_userId, command) {
      calls.cas += 1
      const replayEntry = ledger.find((entry) => entry.idempotencyKey === command.idempotencyKey)
      const decision = agentContextStateCompareAndSetDecision({
        state,
        replayEntry,
        command,
        ownerId: 'owner-1',
        observedAt: 100 + state.revision,
      })
      if (decision.changed) {
        state = structuredClone(decision.state)
        ledger.push(structuredClone(decision.ledgerEntry))
      }
      const { ledgerEntry: _ledgerEntry, ...publicDecision } = decision
      return structuredClone(publicDecision)
    },
  }
  return store
}

function noChangeCoordinator(calls = []) {
  return {
    async resolve(input) {
      calls.push(input)
      return {
        kind: 'no_change',
        state: {
          version: 2, projectId: input.projectId, sessionId: input.sessionId,
          revision: 0, updatedAt: 0, usageAnchor: { provider: 'hidden-provider' },
        },
      }
    },
  }
}

const command = {
  userId: 'user-1', projectId: 'project-1', sessionId: 'session-1',
  idempotencyKey: 'manual-context-key-0001',
}

test('Manual Compaction 强制 manual + force，并只采用服务端 Session/Message/model', async () => {
  const coordinatorCalls = []
  const store = storeFixture({
    messages: [
      message('m-1', 'user', '旧问题', 1),
      message('m-2', 'assistant', '旧回答', 2),
      message('m-3', 'user', '当前问题', 3),
    ],
  })
  const service = createAgentManualContextCompactionService({
    productStore: store,
    contextCoordinator: noChangeCoordinator(coordinatorCalls),
  })
  const result = await service({
    ...command,
    locale: 'en',
    model: 'client-controlled-model',
    messages: [message('forged', 'user', '伪造历史', 99)],
    checkpoint: '伪造 checkpoint',
  })
  assert.equal(result.kind, 'no_change')
  assert.equal(result.changed, false)
  assert.equal(Object.isFrozen(result), true)
  assert.equal(coordinatorCalls.length, 1)
  assert.deepEqual({
    userId: coordinatorCalls[0].userId,
    projectId: coordinatorCalls[0].projectId,
    sessionId: coordinatorCalls[0].sessionId,
    model: coordinatorCalls[0].model,
    currentMessageId: coordinatorCalls[0].currentMessageId,
    locale: coordinatorCalls[0].locale,
    force: coordinatorCalls[0].force,
    trigger: coordinatorCalls[0].trigger,
    idempotencyKey: coordinatorCalls[0].idempotencyKey,
  }, {
    userId: 'user-1', projectId: 'project-1', sessionId: 'session-1',
    model: 'test-model', currentMessageId: 'm-3', locale: 'en',
    force: true, trigger: 'manual', idempotencyKey: 'manual-context-key-0001',
  })
  assert.deepEqual(coordinatorCalls[0].messages.map((entry) => entry.id), ['m-1', 'm-2', 'm-3'])
})

test('Manual Compaction 用真实 Coordinator/Persistence 完成本地 CAS，重试不追加 ledger', async () => {
  const store = storeFixture()
  const service = createAgentManualContextCompactionService({ productStore: store, policies })
  const first = await service(command)
  const second = await service(command)

  assert.equal(first.kind, 'compacted')
  assert.equal(first.changed, true)
  assert.equal(first.compaction.trigger, 'manual')
  assert.ok(first.compaction.replacedMessageCount > 0)
  assert.equal(first.state.revision, 1)
  assert.equal(second.kind, 'reused')
  assert.equal(second.changed, false)
  assert.equal(store.ledger.length, 1)
  assert.equal(store.calls.cas, 1)

  const serialized = JSON.stringify(first)
  assert.doesNotMatch(serialized, /SUPER_SECRET_PROMPT|must-not-leak|hidden-provider/)
  assert.equal(first.compaction.checkpoint.content, undefined)
  assert.equal(first.compaction.replacedMessageRevisions, undefined)
  assert.equal(first.state.usageAnchor, undefined)
})

test('Manual Compaction 分页完整回溯，不把最新页误排在旧历史之前', async () => {
  const messages = Array.from({ length: 205 }, (_, index) => message(
    `m-${String(index + 1).padStart(3, '0')}`,
    index % 2 ? 'assistant' : 'user',
    `消息 ${index + 1}`,
    index + 1,
  ))
  const coordinatorCalls = []
  const store = storeFixture({ messages })
  const service = createAgentManualContextCompactionService({
    productStore: store,
    contextCoordinator: noChangeCoordinator(coordinatorCalls),
  })
  await service(command)
  assert.equal(store.calls.messagePages, 2)
  assert.equal(coordinatorCalls[0].messages.length, 205)
  assert.equal(coordinatorCalls[0].messages[0].id, 'm-001')
  assert.equal(coordinatorCalls[0].messages.at(-1).id, 'm-205')
  assert.equal(coordinatorCalls[0].currentMessageId, 'm-205')
})

test('Manual Compaction 对恰好 500 条历史用空页 probe 证明边界完整', async () => {
  const messages = Array.from({ length: 500 }, (_, index) => message(
    `m-${String(index + 1).padStart(3, '0')}`,
    index % 2 ? 'assistant' : 'user',
    `消息 ${index + 1}`,
    index + 1,
  ))
  const coordinatorCalls = []
  const store = storeFixture({ messages })
  const service = createAgentManualContextCompactionService({
    productStore: store,
    contextCoordinator: noChangeCoordinator(coordinatorCalls),
  })
  await service(command)
  assert.equal(store.calls.messagePages, 4)
  assert.equal(coordinatorCalls[0].messages.length, 500)
  assert.equal(coordinatorCalls[0].messages[0].id, 'm-001')
  assert.equal(coordinatorCalls[0].messages.at(-1).id, 'm-500')
})

test('Manual Compaction 要求认证身份、项目、会话与 Idempotency-Key', async () => {
  const store = storeFixture()
  const service = createAgentManualContextCompactionService({
    productStore: store,
    contextCoordinator: noChangeCoordinator(),
  })
  const cases = [
    [{ ...command, userId: '' }, 'AGENT_CONTEXT_USER_REQUIRED', 401],
    [{ ...command, projectId: '' }, 'AGENT_CONTEXT_PROJECT_REQUIRED', 400],
    [{ ...command, sessionId: '' }, 'AGENT_CONTEXT_SESSION_REQUIRED', 400],
    [{ ...command, idempotencyKey: '' }, 'INVALID_IDEMPOTENCY_KEY', 400],
    [{ ...command, idempotencyKey: 'bad\nkey' }, 'INVALID_IDEMPOTENCY_KEY', 400],
    [{ ...command, locale: 'fr' }, 'AGENT_CONTEXT_LOCALE_INVALID', 400],
  ]
  for (const [input, code, statusCode] of cases) {
    await assert.rejects(
      service(input),
      (caught) => caught instanceof AgentManualContextCompactionServiceError
        && caught.code === code && caught.statusCode === statusCode,
    )
  }
})

test('Manual Compaction 仅 Editor/Owner 可执行，权限失败前不读取 Session 或消息', async () => {
  const viewerStore = storeFixture({ role: 'viewer' })
  const viewerService = createAgentManualContextCompactionService({
    productStore: viewerStore,
    contextCoordinator: noChangeCoordinator(),
  })
  await assert.rejects(
    viewerService(command),
    (caught) => caught.code === 'PROJECT_ACCESS_FORBIDDEN' && caught.statusCode === 403,
  )
  assert.equal(viewerStore.calls.sessions, 0)
  assert.equal(viewerStore.calls.messagePages, 0)

  const ownerStore = storeFixture({ role: 'owner', messages: [message('m-1', 'user', '问题', 1)] })
  const ownerService = createAgentManualContextCompactionService({
    productStore: ownerStore,
    contextCoordinator: noChangeCoordinator(),
  })
  assert.equal((await ownerService(command)).kind, 'no_change')

  const missingStore = storeFixture({ projectExists: false })
  const missingService = createAgentManualContextCompactionService({
    productStore: missingStore,
    contextCoordinator: noChangeCoordinator(),
  })
  await assert.rejects(
    missingService(command),
    (caught) => caught.code === 'PROJECT_NOT_FOUND' && caught.statusCode === 404,
  )
})

test('Manual Compaction 对会话、模型与历史不完整分别给出稳定错误码', async () => {
  const missingSession = storeFixture({ sessionExists: false })
  const missingService = createAgentManualContextCompactionService({
    productStore: missingSession,
    contextCoordinator: noChangeCoordinator(),
  })
  await assert.rejects(
    missingService(command),
    (caught) => caught.code === 'AGENT_SESSION_NOT_FOUND' && caught.statusCode === 404,
  )

  const noModel = storeFixture({ plannerModel: null, messages: [message('m-1', 'user', '问题', 1)] })
  const noModelService = createAgentManualContextCompactionService({
    productStore: noModel,
    contextCoordinator: noChangeCoordinator(),
  })
  await assert.rejects(
    noModelService(command),
    (caught) => caught.code === 'AGENT_CONTEXT_MODEL_REQUIRED' && caught.statusCode === 409,
  )

  const invalidCursor = storeFixture()
  invalidCursor.listAgentSessionMessages = async () => ({ messages: [], nextBefore: 'not-a-cursor' })
  const invalidCursorService = createAgentManualContextCompactionService({
    productStore: invalidCursor,
    contextCoordinator: noChangeCoordinator(),
  })
  await assert.rejects(
    invalidCursorService(command),
    (caught) => caught.code === 'AGENT_CONTEXT_HISTORY_INCOMPLETE' && caught.statusCode === 409,
  )
})

test('Manual Compaction 映射持久化与并发错误，不回传底层异常文本', async () => {
  const store = storeFixture()
  const persistenceService = createAgentManualContextCompactionService({
    productStore: store,
    contextCoordinator: {
      async resolve() {
        throw Object.assign(new Error('database secret details'), { code: 'AGENT_CONTEXT_PERSISTENCE_REQUIRED' })
      },
    },
  })
  await assert.rejects(
    persistenceService(command),
    (caught) => caught.code === 'AGENT_CONTEXT_PERSISTENCE_REQUIRED'
      && caught.statusCode === 503 && !caught.message.includes('database secret'),
  )

  const unknownService = createAgentManualContextCompactionService({
    productStore: store,
    contextCoordinator: { async resolve() { throw new Error('provider-key-sk-secret') } },
  })
  await assert.rejects(
    unknownService(command),
    (caught) => caught.code === 'AGENT_CONTEXT_MANUAL_UNAVAILABLE'
      && caught.statusCode === 503 && !caught.message.includes('sk-secret'),
  )
})
