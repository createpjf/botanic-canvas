import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import * as Y from 'yjs'

// 执行真实模块，仅替换 I/O 与 Hook 宿主；不访问账号、数据库或 Provider。
async function load(entry, mocks) {
  const result = await build({
    entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node',
    plugins: [{ name: 'test-boundaries', setup(builder) {
      builder.onResolve({ filter: /^yjs$/ }, () => ({ path: import.meta.resolve('yjs'), external: true }))
      builder.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, namespace: 'mock' } : undefined)
      builder.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: mocks[args.path], loader: 'js' }))
    } }],
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

test('消息失败可恢复；重复刷新合并，真实失效补读，旧会话不能覆盖新会话', async () => {
  const slots = []
  let cursor = 0
  const pending = []
  globalThis.__messageRecoveryTest = {
    state(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    },
    ref(initial) { const index = cursor++; return slots[index] ??= { current: initial } },
    read: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
  }
  try {
    const { useAgentSessionMessages } = await load('src/features/agent/useAgentSessionMessages.ts', {
      react: `const h=globalThis.__messageRecoveryTest; export const useState=h.state, useRef=h.ref, useCallback=f=>f, useMemo=f=>f(), useEffect=()=>{};`,
      '../../lib/agentApi': 'export const listPersistentBotanicAgentSessionMessages=globalThis.__messageRecoveryTest.read;',
      '../../lib/productSession': 'export const serverPersistenceEnabled=true;',
    })
    let session = 'session'
    const render = () => { cursor = 0; return useAgentSessionMessages('project', session, { messages: [], runs: [] }) }
    let view = render()
    const failed = view.refresh()
    pending.shift().reject(new Error('unavailable'))
    await assert.rejects(failed, /unavailable/)
    view = render()
    assert.equal(view.loading, false)
    assert.equal(view.error, 'unavailable')
    const retry = view.refresh()
    pending.shift().resolve({ messages: [{ id: 'restored', role: 'assistant', kind: 'text', createdAt: 1 }] })
    await retry
    view = render()
    assert.equal(view.error, undefined)
    assert.equal(view.messages[0].id, 'restored')
    const reading = view.refresh()
    const request = pending.shift()
    const duplicate = view.refresh()
    assert.equal(pending.length, 0, '重复 focus 不发出第二份请求')
    const invalidated = view.invalidate()
    request.resolve({ messages: [{ id: 'restored', role: 'assistant', kind: 'text', createdAt: 1 }] })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(pending.length, 1, '在途真实变更在本轮后补读一次')
    pending.shift().resolve({ messages: [{ id: 'new', role: 'assistant', kind: 'text', createdAt: 2 }] })
    await Promise.all([reading, duplicate, invalidated])
    assert.deepEqual(render().messages.map(message => message.id), ['restored', 'new'])
    const older = view.refresh()
    const oldRequest = pending.shift()
    session = 'other-session'
    const newer = render().refresh()
    pending.shift().resolve({ messages: [{ id: 'other', role: 'assistant', kind: 'text', createdAt: 3 }] })
    await newer
    oldRequest.resolve({ messages: [] })
    await older
    assert.deepEqual(render().messages.map(message => message.id), ['other'])
  } finally { delete globalThis.__messageRecoveryTest }
})

test('消息首次读取等保存，最新页接回历史缺口且不丢已加载历史游标', async () => {
  const slots = [], pending = []
  let cursor = 0, saved
  const persistence = new Promise(resolve => { saved = resolve })
  const prepare = () => persistence
  const tick = () => new Promise(resolve => setImmediate(resolve))
  const message = id => ({ id: String(id), role: 'assistant', kind: 'text', createdAt: id })
  globalThis.__pagedMessagesTest = {
    state(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value }] },
    ref(initial) { const i = cursor++; return slots[i] ??= { current: initial } },
    read: (_project, _session, options) => new Promise((resolve, reject) => pending.push({ options, resolve, reject })),
  }
  try {
    const { useAgentSessionMessages } = await load('src/features/agent/useAgentSessionMessages.ts', {
      react: 'const h=globalThis.__pagedMessagesTest; export const useState=h.state, useRef=h.ref, useCallback=f=>f, useMemo=f=>f(), useEffect=()=>{};',
      '../../lib/agentApi': 'export const listPersistentBotanicAgentSessionMessages=globalThis.__pagedMessagesTest.read;',
      '../../lib/productSession': 'export const serverPersistenceEnabled=true;',
    })
    const render = () => { cursor = 0; return useAgentSessionMessages('project', 'session', { messages: [], runs: [], prepare }) }
    const first = render().refresh()
    await tick()
    assert.equal(pending.length, 0, '会话尚未保存时不抢跑 GET')
    saved()
    await tick()
    pending.shift().resolve({ messages: [message(3)], nextBefore: 'older' })
    await first
    const older = render().loadOlderMessages()
    assert.equal(pending[0].options.before, 'older')
    pending.shift().resolve({ messages: [message(2)], nextBefore: 'oldest' })
    await older
    const latest = render().refresh()
    await tick()
    pending.shift().resolve({ messages: [message(5)], nextBefore: 'gap' })
    await tick()
    assert.equal(pending[0].options.before, 'gap')
    pending.shift().resolve({ messages: [message(4)], nextBefore: 'overlap' })
    await tick()
    pending.shift().resolve({ messages: [message(3)], nextBefore: 'older' })
    await latest
    assert.deepEqual(render().messages.map(item => item.id), ['2', '3', '4', '5'])
    const last = render().loadOlderMessages()
    assert.equal(pending[0].options.before, 'oldest', '最新页游标不能覆盖已加载历史的边界')
    pending.shift().resolve({ messages: [message(1)] })
    await last
    assert.deepEqual(render().messages.map(item => item.id), ['1', '2', '3', '4', '5'])
    assert.equal(render().hasOlderMessages, false)
  } finally { delete globalThis.__pagedMessagesTest }
})

test('重连时草稿、画布和消息故障不阻止 Agent 状态更新，在途状态读取合并补齐', async () => {
  const effects = [], cleanups = [], pending = [], slots = [], logs = []
  let cursor = 0, connection, messageReads = 0, stateReads = 0
  let state = {
    document: { id: 'project', updatedAt: 1, agentSessions: [], agentRuns: [], agentMemory: [], nodes: [], edges: [] },
    hydrated: true, persistenceStatus: 'saved',
    hydrate: async () => {}, openDocument: async () => true,
    refreshDocumentFromRemote: async () => { throw new Error('canvas unavailable') },
    recoverGenerationResultsFromRemote: async () => false,
    recoverUnknownGenerationSubmission: async () => false,
    resumeBatchVariations: async () => {}, applyCollaborativeGraph() {}, applyAgentWorkflowPatch: async () => {},
    applyAgentRunSnapshot(run) { state.document.agentRuns = [run] },
  }
  const events = new EventTarget(), visibility = new EventTarget()
  visibility.visibilityState = 'visible'
  globalThis.document = visibility
  globalThis.window = { document: visibility, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), setTimeout, clearTimeout, setInterval, clearInterval }
  globalThis.__workspaceRecoveryTest = {
    state(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value }] },
    ref(initial) { const i = cursor++; return slots[i] ??= { current: initial } },
    effect: fn => effects.push(fn), get: () => state,
    set: update => { state = { ...state, ...(typeof update === 'function' ? update(state) : update) } },
    readState: () => { stateReads++; return new Promise((resolve, reject) => pending.push({ resolve, reject })) },
    connect: options => { connection = options; return { close() {}, refresh() {}, replaceLocalGraph() {} } },
    log: (_category, message) => logs.push(message),
  }
  const tick = () => new Promise(resolve => setImmediate(resolve))
  try {
    const { useCanvasWorkspaceSynchronization } = await load('src/features/canvas/useCanvasWorkspaceSynchronization.ts', {
      react: 'const h=globalThis.__workspaceRecoveryTest; export const useState=h.state, useRef=h.ref, useCallback=f=>f, useEffect=h.effect;',
      '../../store/canvasStore': 'const h=globalThis.__workspaceRecoveryTest; export const useCanvasStore=Object.assign(f=>f(h.get()),{getState:h.get,setState:h.set,subscribe:()=>()=>{}}); export const canReadRemoteCanvasProject=()=>true;',
      '../../i18n/react': 'export const useProductI18n=()=>({locale:"zh-CN"});',
      '../../lib/agentApi': 'export const readPersistentBotanicAgentState=globalThis.__workspaceRecoveryTest.readState; export const listPersistentBotanicAgentRuns=async()=>[]; export const executePersistentBotanicAgentRun=async()=>{throw Error("No Provider in test")};',
      '../../lib/collaborationApi': 'export const listProjectCollaborationActivities=async()=>{throw Error("activity unavailable")}; export const updateProjectCollaborationActivityReceipt=async()=>{};',
      '../../lib/db': 'export const syncPendingCanvasDrafts=async()=>{throw Error("draft unavailable")}; export const flushPendingCanvasDocumentWrites=async()=>{}, appliedRemoteRevision=()=>1, lastKnownCanvasSyncProtocolEpoch=()=>2, previewRemoteCanvasDocument=async()=>undefined, refreshCanvasDocumentFromRemote=async()=>undefined;',
      '../../lib/projectCollaboration': 'export const connectCanvasCollaboration=globalThis.__workspaceRecoveryTest.connect;',
      '../../lib/productSession': 'export const serverPersistenceEnabled=true; export class ProductApiError extends Error {}',
      '../../lib/sentry': 'export const recordSentryBreadcrumb=globalThis.__workspaceRecoveryTest.log;',
    })
    const messages = { current: async () => { messageReads++; throw new Error('messages unavailable') } }
    useCanvasWorkspaceSynchronization({ workspaceActive: true, currentUserId: 'user', refreshAgentSessionMessagesRef: messages })
    for (const effect of effects) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup) }
    await tick()
    assert.ok(messageReads > 0)
    assert.equal(stateReads, 1)
    connection.onReconnected()
    await tick()
    assert.equal(stateReads, 1, '重连复用在途状态读取，不受草稿失败阻断')
    pending.shift().resolve({ sessions: [{ id: 'session', title: '另一页的新名称', updatedAt: 2, messages: [] }], memory: [], runs: [] })
    await tick()
    assert.equal(state.document.agentSessions[0].title, '另一页的新名称')
    assert.equal(stateReads, 2, '失效事件触发尾随补读')
    pending.shift().reject(new Error('state unavailable'))
    await tick()
    const previousMessages = messageReads
    messages.current = async () => { messageReads++ }
    connection.onCollaborationActivity({ activity: { actorId: 'user' } })
    await tick()
    assert.ok(messageReads > previousMessages, '状态读取未完成也独立读取同账号另一页的消息')
    pending.shift().reject(new Error('state unavailable'))
    await tick()
    assert.equal(state.document.agentSessions[0].title, '另一页的新名称', '刷新失败保留现有数据')
    assert.ok(logs.some(message => message.includes('其他读取继续')))
  } finally {
    for (const cleanup of cleanups.reverse()) cleanup()
    delete globalThis.__workspaceRecoveryTest
    delete globalThis.window
    delete globalThis.document
  }
})

test('已连接页面重新同步会发起 state-vector 握手，握手完成前不可发送增量', async () => {
  const sent = []
  const statuses = []
  const server = new Y.Doc()
  const original = { id: 'image', type: 'text', position: { x: 0, y: 0 }, data: { label: '旧名称', content: '' } }
  server.getMap('nodes').set(original.id, { order: 0, value: original })
  let displayed
  let receive
  globalThis.window = { btoa: value => Buffer.from(value, 'binary').toString('base64'), atob: value => Buffer.from(value, 'base64').toString('binary') }
  globalThis.__canvasRecoveryTest = {
    open(_id, onEvent, onReady, onState) {
      receive = onEvent
      queueMicrotask(() => { onState('connected'); onReady({ reconnected: false }) })
      return { publish: event => { sent.push(event); return true }, close() {} }
    },
  }
  let connection
  try {
    const { connectCanvasCollaboration } = await load('src/lib/projectCollaboration.ts', {
      './db': 'export const canvasSyncOutboxStorage={}; export const lastKnownCanvasSyncProtocolEpoch=()=>2, rememberAppliedCanvasGraphRevision=()=>{}, rememberRemoteSyncProtocolEpoch=()=>{};',
      './canvasSyncOutbox': 'export const createCanvasSyncOutbox=options=>{globalThis.__canvasRecoveryTest.sendReady=options.sendReady;return {pendingUpdates:async()=>[],flush:async()=>{},ack:async()=>{},enqueue:async()=>{},retryBlocked:async()=>{}}};',
      './projectRealtime': 'export const openProjectRealtimeChannel=globalThis.__canvasRecoveryTest.open; export const commitCanvasRealtimeUpdate=()=>{};',
      './productSession': 'export class ProductApiError extends Error {}',
      './sentry': 'export const captureSentryMessage=()=>{};',
    })
    connection = connectCanvasCollaboration({ projectId: 'project', initialGraph: { nodes: [original], edges: [] }, onRemoteGraph: graph => { displayed = graph }, onProjectUpdated() {}, onAgentRunUpdated() {}, onSyncStatusChanged: status => statuses.push(status) })
    await new Promise(resolve => setImmediate(resolve))
    const ready = { type: 'canvas.sync.ready.v2', updateBase64: Buffer.from(Y.encodeStateAsUpdate(server)).toString('base64'), graphRevision: 1, syncProtocolEpoch: 2 }
    receive(ready)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(statuses.at(-1), 'synced')
    server.getMap('node-configs').set(original.id, { order: 0, value: { data: { label: '另一页的新名称', content: '' } } })
    assert.equal(displayed.nodes[0].data.label, '旧名称', '模拟后台页面漏收广播')
    connection.refresh()
    assert.equal(sent.filter(event => event.type === 'canvas.sync.hello.v2').length, 2)
    assert.equal(statuses.at(-1), 'syncing')
    assert.equal(globalThis.__canvasRecoveryTest.sendReady(), false)
    connection.refresh()
    assert.equal(sent.length, 2, '重复 focus 不并发重启握手')
    const missed = Y.encodeStateAsUpdate(server, Buffer.from(sent.at(-1).stateVectorBase64, 'base64'))
    receive({ ...ready, updateBase64: Buffer.from(missed).toString('base64'), graphRevision: 2 })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(statuses.at(-1), 'synced')
    assert.equal(displayed.nodes[0].data.label, '另一页的新名称')
    assert.equal(globalThis.__canvasRecoveryTest.sendReady(), true)
  } finally { connection?.close(); server.destroy(); delete globalThis.__canvasRecoveryTest; delete globalThis.window }
})
