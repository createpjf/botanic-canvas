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

function createDelayedPersistenceHarness() {
  let state = { document: emptyDocument() } as CanvasStore
  const pendingDocuments: CanvasDocument[] = []
  const actions = createCanvasAgentActions({
    set: (patch) => { state = { ...state, ...patch } },
    get: () => state,
    commitDocument: async (document) => { pendingDocuments.push(document) },
    persistentAgentRunApi: {
      retryBranch: async () => { throw new Error('测试未调用远程分支重试') },
      cancelRun: async () => { throw new Error('测试未调用远程任务取消') },
    },
  })
  state = { ...state, ...actions }
  return { actions, pendingDocuments, getState: () => state }
}

test('首次打开 Agent 时连续确保会话、添加上下文和消息仍落入同一会话', () => {
  const { actions, pendingDocuments } = createDelayedPersistenceHarness()

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
  assert.deepEqual(latestDocument.agentSessions[0].messages.map((message) => message.id), ['message-first-frame'])
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
