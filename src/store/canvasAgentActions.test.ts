import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanvasDocument } from '../domain/canvas.ts'
import { createCanvasAgentActions } from './canvasAgentActions.ts'
import type { CanvasStore } from './canvasStore.types.ts'

function emptyDocument(): CanvasDocument {
  return {
    id: 'project-agent-session-race',
    name: 'Agent Session 竞态测试',
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    assets: [],
    assetGroups: [],
    templates: [],
    history: [],
    deliveries: [],
    generationJobs: [],
    batchVariationRuns: [],
    agentSessions: [],
    agentMemory: [],
    agentRuns: [],
    updatedAt: 1,
  }
}

function createDelayedPersistenceHarness({ revision = 1, graphRevision = 1 } = {}) {
  let state = { document: emptyDocument(), persistenceStatus: 'saving' } as CanvasStore
  const pendingDocuments: CanvasDocument[] = []
  const localMirrors: CanvasDocument[] = []
  const persistedSessions: Array<{ projectId: string; title: string }> = []
  let invalidatedPersistence = 0
  let remoteRefreshes = 0
  const actions = createCanvasAgentActions({
    set: (patch) => { state = { ...state, ...patch } },
    get: () => state,
    commitDocument: async (document) => { pendingDocuments.push(document) },
    persistentAgentRunApi: {
      retryBranch: async () => { throw new Error('测试未调用远程分支重试') },
      cancelRun: async () => { throw new Error('测试未调用远程任务取消') },
    },
    persistAcknowledgedRemotePatch: async () => {},
    readAppliedRemoteRevision: () => revision,
    readAppliedGraphRevision: () => graphRevision,
    invalidateDocumentPersistence: () => { invalidatedPersistence += 1 },
    persistAgentSession: async (projectId, session) => {
      persistedSessions.push({ projectId, title: session.title })
    },
    persistLocalDocumentMirror: async (document) => { localMirrors.push(document) },
  })
  state = { ...state, ...actions, refreshDocumentFromRemote: async () => { remoteRefreshes += 1; return true } }
  return { actions, pendingDocuments, localMirrors, persistedSessions, getState: () => state, invalidatedPersistence: () => invalidatedPersistence, remoteRefreshes: () => remoteRefreshes }
}

test('首次打开 Agent 时连续确保会话、添加上下文和消息仍落入同一会话', () => {
  const { actions, pendingDocuments, getState } = createDelayedPersistenceHarness()

  const firstSessionId = actions.ensureAgentSession()
  const repeatedSessionId = actions.ensureAgentSession()
  actions.setAgentSessionContext(firstSessionId, ['asset-hero'])
  actions.appendAgentMessage(firstSessionId, {
    id: 'message-first-frame',
    role: 'user',
    kind: 'text',
    content: '立即开始创作',
    createdAt: 10,
  })

  assert.equal(repeatedSessionId, firstSessionId)
  const latestDocument = pendingDocuments.at(-1)
  assert.ok(latestDocument)
  assert.equal(latestDocument.activeAgentSessionId, firstSessionId)
  assert.equal(latestDocument.agentSessions.length, 1)
  assert.deepEqual(latestDocument.agentSessions[0].contextNodeIds, ['asset-hero'])
  assert.deepEqual(getState().document.agentSessions[0].messages.map((message) => message.id), ['message-first-frame'])
})

test('Agent 阅读位置先更新本地会话，不触发整份画布文档写入', () => {
  const { actions, pendingDocuments, getState } = createDelayedPersistenceHarness()
  const sessionId = actions.ensureAgentSession()
  actions.appendAgentMessage(sessionId, {
    id: 'message-anchor', role: 'assistant', kind: 'text', content: '阅读到这里', createdAt: 20,
  })
  const writesBeforeAnchor = pendingDocuments.length

  actions.setAgentSessionReadingAnchor(sessionId, 'message-anchor', 30)

  assert.equal(pendingDocuments.length, writesBeforeAnchor)
  const latestSession = getState().document.agentSessions.find((session) => session.id === sessionId)
  assert.equal(latestSession?.readingAnchorMessageId, 'message-anchor')
  assert.equal(latestSession?.readingAnchorUpdatedAt, 30)
})

test('Agent 会话的模型、挂载 Skill 和自定义标题会持久化', () => {
  const { actions, pendingDocuments, persistedSessions } = createDelayedPersistenceHarness()
  const sessionId = actions.ensureAgentSession()

  actions.setAgentSessionPlannerModel(sessionId, 'kimi-k3')
  actions.setAgentSessionSkills(sessionId, ['controlled_edit', 'project-night-scene'])
  actions.renameAgentSession(sessionId, '夜景生成方案')
  actions.appendAgentMessage(sessionId, {
    id: 'message-after-rename',
    role: 'user',
    kind: 'text',
    content: '继续执行',
    createdAt: 40,
  })

  const latestDocument = pendingDocuments.at(-1)
  assert.ok(latestDocument)
  const session = latestDocument.agentSessions.find((item) => item.id === sessionId)
  assert.equal(session?.plannerModel, 'kimi-k3')
  assert.deepEqual(session?.mountedSkillIds, ['controlled_edit', 'project-night-scene'])
  assert.equal(session?.title, '夜景生成方案')
  assert.ok(persistedSessions.some((item) => item.title === '夜景生成方案'))
  assert.equal(persistedSessions.length, 4)
})

test('full Message upsert 替换同 ID 旧副本，API 更新时间不再压住本地终态', () => {
  const { actions, getState } = createDelayedPersistenceHarness()
  const sessionId = actions.ensureAgentSession()
  actions.appendAgentMessage(sessionId, {
    id: 'message-stable', role: 'assistant', kind: 'notice', content: '旧投影',
    createdAt: 10, updatedAt: 100, status: 'pending',
  })

  actions.upsertAgentMessage(sessionId, {
    id: 'message-stable', role: 'assistant', kind: 'notice', content: '权威终态',
    createdAt: 10, updatedAt: 501, status: 'failed', turnId: 'turn-stable',
  })

  const stored = getState().document.agentSessions[0].messages[0]
  assert.equal(stored.content, '权威终态')
  assert.equal(stored.status, 'failed')
  assert.equal(stored.updatedAt, 501)
  assert.equal(stored.turnId, 'turn-stable')
})

test('Agent Message 独立实体更新不回写整份画布文档', () => {
  const { actions, pendingDocuments, localMirrors, getState } = createDelayedPersistenceHarness()
  const sessionId = actions.ensureAgentSession()
  pendingDocuments.length = 0
  localMirrors.length = 0

  actions.appendAgentMessage(sessionId, {
    id: 'message-independent', role: 'assistant', kind: 'notice', content: '任务执行中', createdAt: 20,
  })

  assert.equal(pendingDocuments.length, 0)
  assert.equal(localMirrors.length, 1)
  assert.equal(getState().document.agentSessions[0].messages[0].id, 'message-independent')
})

test('Message deliveryStatus 只更新本地展示，不推高领域时间或写回云端文档', () => {
  const { actions, pendingDocuments, getState } = createDelayedPersistenceHarness()
  const sessionId = actions.ensureAgentSession()
  actions.appendAgentMessage(sessionId, {
    id: 'message-delivery', role: 'user', kind: 'text', content: '离线消息',
    createdAt: 10, updatedAt: 10, deliveryStatus: 'queued',
  })
  const writesBefore = pendingDocuments.length
  const sessionBefore = getState().document.agentSessions[0]

  actions.updateAgentMessage(sessionId, 'message-delivery', { deliveryStatus: 'syncing' })

  const sessionAfter = getState().document.agentSessions[0]
  assert.equal(pendingDocuments.length, writesBefore)
  assert.equal(sessionAfter.updatedAt, sessionBefore.updatedAt)
  assert.equal(sessionAfter.messages[0].updatedAt, 10)
  assert.equal(sessionAfter.messages[0].deliveryStatus, 'syncing')
})

test('Agent 工作流回执立即补入 prompt、生成节点与连线，且不重复写回服务端', async () => {
  const { actions, pendingDocuments, getState, invalidatedPersistence } = createDelayedPersistenceHarness()

  const applied = await actions.applyAgentWorkflowPatch({
    nodes: [
      {
        id: 'prompt-agent-1',
        type: 'text',
        position: { x: 300, y: 120 },
        data: { kind: 'text', label: '生成提示词', content: '人物不变，仅替换背景。' },
      },
      {
        id: 'generate-agent-1',
        type: 'generate',
        position: { x: 620, y: 120 },
        data: {
          kind: 'generate',
          label: '图像生成',
          prompt: '人物不变，仅替换背景。',
          batchCount: 1,
          settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
        },
      },
      {
        id: 'result-agent-1',
        type: 'result',
        position: { x: 940, y: 120 },
        data: { kind: 'result', status: 'generating', taskStatus: 'queued', outputOf: 'generate-agent-1' },
      },
    ],
    edges: [
      { id: 'edge-prompt-generate', source: 'prompt-agent-1', target: 'generate-agent-1' },
      { id: 'edge-generate-result', source: 'generate-agent-1', target: 'result-agent-1' },
    ],
    updatedAt: 50,
    baseRevision: 1,
    revision: 2,
    baseGraphRevision: 1,
    graphRevision: 2,
  })

  assert.equal(applied, true)
  assert.deepEqual(getState().document.nodes.map((node) => node.id), ['prompt-agent-1', 'generate-agent-1', 'result-agent-1'])
  assert.deepEqual(getState().document.edges.map((edge) => edge.id), ['edge-prompt-generate', 'edge-generate-result'])
  assert.equal(getState().persistenceStatus, 'saving')
  assert.equal(pendingDocuments.length, 0)
  assert.equal(invalidatedPersistence(), 1)
})

test('Agent 工作流回执 revision 不连续时刷新权威文档，不登记跳号版本', async () => {
  const { actions, getState, invalidatedPersistence, remoteRefreshes } = createDelayedPersistenceHarness({
    revision: 1,
    graphRevision: 1,
  })
  const applied = await actions.applyAgentWorkflowPatch({
    nodes: [{
      id: 'prompt-gap', type: 'text', position: { x: 0, y: 0 },
      data: { kind: 'text', label: '不应直接合并', content: '缺少中间版本' },
    }],
    edges: [],
    updatedAt: 60,
    baseRevision: 1,
    revision: 3,
    baseGraphRevision: 1,
    graphRevision: 3,
  })

  assert.equal(applied, true)
  assert.equal(remoteRefreshes(), 1)
  assert.equal(invalidatedPersistence(), 0)
  assert.deepEqual(getState().document.nodes, [])
})
