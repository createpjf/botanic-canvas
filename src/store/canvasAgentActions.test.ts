import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanvasDocument } from '../domain/canvas.ts'
import type { BotanicAgentSession } from '../domain/agent.ts'
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

function createDelayedPersistenceHarness({ revision = 1, graphRevision = 1, retryBranch = async () => { throw new Error('测试未调用远程分支重试') }, persistSession = async (_projectId: string, _session: BotanicAgentSession): Promise<BotanicAgentSession | undefined> => undefined } = {}) {
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
      retryBranch,
      cancelRun: async () => { throw new Error('测试未调用远程任务取消') },
    },
    persistAcknowledgedRemotePatch: async () => {},
    readAppliedRemoteRevision: () => revision,
    readAppliedGraphRevision: () => graphRevision,
    invalidateDocumentPersistence: () => { invalidatedPersistence += 1 },
    persistAgentSession: async (projectId, session) => {
      persistedSessions.push({ projectId, title: session.title })
      return persistSession(projectId, session)
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

test('首次消息读取等待同一次 Session 持久化，失败重试沿用会话身份，已保存会话不重复写入', async () => {
  const writes: Array<{ session: BotanicAgentSession; resolve: (session: BotanicAgentSession) => void; reject: (error: Error) => void }> = []
  const h = createDelayedPersistenceHarness({ persistSession: (_projectId, session) => new Promise((resolve, reject) => writes.push({ session, resolve, reject })) })
  const id = h.actions.ensureAgentSession()
  const projectId = h.getState().document.id
  let ready = false
  const first = h.actions.ensureAgentSessionPersisted(projectId, id).then(() => { ready = true })
  await Promise.resolve()
  assert.equal(writes.length, 1)
  assert.equal(ready, false)
  writes[0].reject(new Error('保存失败'))
  await assert.rejects(first, /保存失败/)
  const retry = h.actions.ensureAgentSessionPersisted(projectId, id)
  await Promise.resolve()
  assert.equal(writes.length, 2)
  assert.equal(writes[1].session.id, id)
  writes[1].resolve({ ...writes[1].session, revision: 1 })
  await retry
  await h.actions.ensureAgentSessionPersisted(projectId, id)
  assert.equal(writes.length, 2)
  assert.equal(h.getState().document.agentSessions[0].revision, 1)
})

test('补图命令拒绝已完成分支和重复点击，不绕过当前任务身份', async () => {
  let calls = 0
  const h = createDelayedPersistenceHarness({ retryBranch: async () => { calls += 1; await new Promise(resolve => setTimeout(resolve, 5)); throw new Error('测试保留失败') } })
  const run = { id: 'run-1', status: 'completed', branches: [{ id: 'branch-1', status: 'succeeded', attempt: 0, jobIds: ['job-1'], activeJobId: 'job-1' }] } as CanvasDocument['agentRuns'][number]
  h.getState().document.agentRuns = [run]
  assert.equal(await h.actions.retryAgentBranch(run.id, 'branch-1'), false)
  assert.equal(calls, 0)
  run.status = 'failed'; run.branches[0].status = 'failed'
  const first = h.actions.retryAgentBranch(run.id, 'branch-1')
  assert.equal(await h.actions.retryAgentBranch(run.id, 'branch-1'), false)
  assert.equal(calls, 1)
  assert.equal(await first, false)
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

test('Agent 会话的模型、挂载 Skill 和自定义标题会持久化', async () => {
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
  await actions.ensureAgentSessionPersisted('project-agent-session-race', sessionId)
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

test('取消依赖服务端ACK；同版本画布刷新不误报失败，缺少回执仍保留恢复入口', async () => {
  let state = { document: emptyDocument() } as CanvasStore
  const failures = [{ code: 'GENERATION_JOB_CANCEL_ACK_PENDING' }]
  let refreshed = true
  let cancellation: { failures: { code: string }[] } | undefined
  const actions = createCanvasAgentActions({
    get: () => state, set: (patch) => { state = { ...state, ...patch } },
    commitDocument: async () => {}, persistAcknowledgedRemotePatch: async () => {},
    persistentAgentRunApi: {
      retryBranch: async () => { throw new Error('不能重新生成') },
      cancelRun: async () => ({ run: { id: 'run-1', status: 'cancelled' } as never, cancellation }),
    },
  })
  state = { ...state, ...actions, applyAgentRunSnapshot: () => {}, refreshDocumentFromRemote: async () => refreshed }
  cancellation = { failures }
  assert.equal(await actions.cancelAgentRun('run-1'), false)
  refreshed = false
  assert.equal(await actions.cancelAgentRun('run-1'), false)
  cancellation = { failures: [] }
  assert.equal(await actions.cancelAgentRun('run-1'), true, '权威取消已确认；未应用同版本画布不是取消失败')
  cancellation = undefined
  assert.equal(await actions.cancelAgentRun('run-1'), false, '兼容旧服务缺少ACK时不能只凭HTTP成功')
  refreshed = true
  assert.equal(await actions.cancelAgentRun('run-1'), false, '画布刷新成功本身不能证明停止已确认')
})

test('取消回包丢失后只读核对同一Run，迟到ACK更新状态但不再次提交取消', async () => {
  const branch = { id: 'branch', status: 'cancelled', activeJobId: 'job', jobIds: ['job'], updatedAt: 2 }
  const run = { id: 'run', plan: {}, status: 'cancelled', branches: [branch], updatedAt: 2 } as CanvasDocument['agentRuns'][number]
  let job = { id: 'job', status: 'cancelled', updatedAt: 2, cancel: { requestedAt: 1, signalRequired: true, workerReleased: false } } as CanvasDocument['generationJobs'][number]
  let state = { document: { ...emptyDocument(), agentRuns: [{ ...run, status: 'running' }], generationJobs: [job] } } as CanvasStore
  let cancellations = 0
  const actions = createCanvasAgentActions({
    get: () => state, set: patch => { state = { ...state, ...patch } },
    commitDocument: async () => {}, persistAcknowledgedRemotePatch: async () => {},
    persistentAgentRunApi: {
      retryBranch: async () => { throw new Error('不能生成') },
      cancelRun: async () => { cancellations++; await new Promise(resolve => setTimeout(resolve, 5)); throw new Error('cancel response lost') },
      readCancellation: async () => ({ run: run as never, jobs: [job] }),
    },
  })
  state = { ...state, ...actions, refreshDocumentFromRemote: async () => false }
  assert.deepEqual(await Promise.all([actions.cancelAgentRun('run'), actions.cancelAgentRun('run')]), [false, false])
  assert.match(state.assistantMessage, /待确认/)
  assert.equal(await actions.cancelAgentRun('run'), false, 'Worker确认迟到只读核对，不重发已经发出的停止请求')
  assert.equal(cancellations, 1)
  job = { ...job, updatedAt: 3, cancel: { ...job.cancel!, workerReleased: true, signalAcknowledgedAt: 3 } }
  assert.equal(await actions.checkAgentRunStop('run'), true)
  assert.equal(state.document.generationJobs[0].cancel?.workerReleased, true)
  assert.equal(await actions.cancelAgentRun('run'), true, '迟到的计划回包不能再次提交已确认停止的任务')
  assert.equal(cancellations, 1)
})

test('Message deliveryStatus 只更新本地展示，不推高领域时间或写回云端文档', () => {
  const { actions, pendingDocuments, getState } = createDelayedPersistenceHarness()
  const sessionId = actions.ensureAgentSession()
  actions.appendAgentMessage(sessionId, {
    id: 'message-delivery', role: 'user', kind: 'text', content: '离线消息',
    createdAt: 10, updatedAt: 10, deliveryStatus: 'queued',
  })
  const otherSessionId = actions.startNewAgentSession()
  const writesBefore = pendingDocuments.length
  const sessionBefore = getState().document.agentSessions.find((item) => item.id === sessionId)!

  actions.updateAgentMessage(sessionId, 'message-delivery', { deliveryStatus: 'syncing' })

  const sessionAfter = getState().document.agentSessions.find((item) => item.id === sessionId)!
  assert.equal(pendingDocuments.length, writesBefore)
  assert.equal(sessionAfter.updatedAt, sessionBefore.updatedAt)
  assert.equal(sessionAfter.messages[0].updatedAt, 10)
  assert.equal(sessionAfter.messages[0].deliveryStatus, 'syncing')
  assert.equal(getState().document.activeAgentSessionId, otherSessionId, '后台送达状态不能抢切当前会话')
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
