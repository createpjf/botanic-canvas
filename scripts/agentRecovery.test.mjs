import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import * as Y from 'yjs'

// 执行真实模块，仅替换 I/O 与 Hook 宿主；不访问账号、数据库或 Provider。
async function load(entry, mocks) {
  const result = await build({
    entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic',
    plugins: [{ name: 'test-boundaries', setup(builder) {
      builder.onResolve({ filter: /^yjs$/ }, () => ({ path: import.meta.resolve('yjs'), external: true }))
      builder.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, namespace: 'mock' } : undefined)
      builder.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: mocks[args.path], loader: 'js' }))
    } }],
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

test('使用云端必须保留读取期间的新草稿；失败不清理，成功原子备份并替换', async () => {
  const rows = Object.fromEntries(['documents', 'documentBackups', 'media', 'pendingSync', 'canvasGraphOutbox'].map(name => [name, new Map()]))
  const tables = Object.fromEntries(Object.entries(rows).map(([name, data]) => [name, {
    get: async id => structuredClone(data.get(id)),
    put: async row => data.set(row.id, structuredClone(row)),
    delete: async id => data.delete(id),
    where: () => ({ equals: id => ({
      sortBy: async () => structuredClone([...data.values()].filter(row => row.projectId === id)),
      delete: async () => { for (const [key, row] of data) if (row.projectId === id) data.delete(key) },
    }) }),
  }]))
  const local = { id: 'project', name: 'local', updatedAt: 1, nodes: [], edges: [], agentSessions: [] }
  const remote = { ...local, name: 'cloud' }
  let read = async () => ({ document: remote, revision: 2, graphRevision: 1 })
  globalThis.__replacement = { tables: { ...tables, transaction: async (...args) => {
    const snapshot = structuredClone(rows)
    try { return await args.at(-1)() } catch (error) {
      for (const [name, data] of Object.entries(rows)) { data.clear(); for (const [key, value] of snapshot[name]) data.set(key, value) }
      throw error
    }
  } }, request: (...args) => read(...args) }
  try {
    const db = await load('src/lib/db.ts', {
      './canvasDb': 'export const canvasDb=globalThis.__replacement.tables; export const enqueuePersistence=f=>f(); export const canvasSyncOutboxStorage={};',
      './productSession': 'export const serverPersistenceEnabled=true, productRequest=(...args)=>globalThis.__replacement.request(...args); export class ProductApiError extends Error {}',
    })
    await tables.documents.put(local)
    await tables.pendingSync.put({ id: local.id, document: local, updatedAt: 1 })
    await tables.canvasGraphOutbox.put({ id: 'mutation', projectId: local.id })
    read = async () => { throw Error('offline') }
    await assert.rejects(db.refreshCanvasDocumentFromRemote(local.id), /offline/)
    assert.equal((await tables.pendingSync.get(local.id)).document.name, 'local')
    assert.ok(await tables.canvasGraphOutbox.get('mutation'))
    read = async () => {
      const edited = { ...local, name: 'new edit' }
      await tables.pendingSync.put({ id: local.id, document: edited, updatedAt: 1 })
      return { document: remote, revision: 2, graphRevision: 1 }
    }
    await assert.rejects(db.refreshCanvasDocumentFromRemote(local.id), { code: 'CANVAS_DRAFT_CHANGED' })
    assert.equal((await tables.pendingSync.get(local.id)).document.name, 'new edit')
    assert.ok(await tables.canvasGraphOutbox.get('mutation'))
    read = async () => ({ document: remote, revision: 2, graphRevision: 1 })
    const remove = tables.pendingSync.delete
    tables.pendingSync.delete = async () => { throw Error('disk full') }
    await assert.rejects(db.refreshCanvasDocumentFromRemote(local.id), /disk full/)
    assert.equal((await tables.documents.get(local.id)).name, 'local', '清理失败必须回滚文档替换')
    assert.equal((await tables.pendingSync.get(local.id)).document.name, 'new edit')
    assert.ok(await tables.canvasGraphOutbox.get('mutation'))
    tables.pendingSync.delete = remove
    assert.equal((await db.refreshCanvasDocumentFromRemote(local.id)).name, 'cloud')
    assert.equal((await tables.documents.get(local.id)).name, 'cloud')
    assert.equal((await tables.documentBackups.get(local.id)).document.name, 'new edit')
    assert.equal(await tables.pendingSync.get(local.id), undefined)
    assert.equal(await tables.canvasGraphOutbox.get('mutation'), undefined)
  } finally { delete globalThis.__replacement }
})

test('冲突按钮等待时禁止重复请求；失败可见，重试成功清理错误', async () => {
  const slots = []
  let cursor = 0, resolve, count = 0
  globalThis.__conflictActions = {
    state(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = value }] },
    ref(initial) { const i = cursor++; return slots[i] ??= { current: initial } },
  }
  try {
    const { useCanvasPersistenceActions } = await load('src/features/agent/useCanvasPersistenceActions.ts', {
      react: 'const h=globalThis.__conflictActions; export const useState=h.state, useRef=h.ref, useEffect=()=>{};',
    })
    const retry = () => { count++; return new Promise(done => { resolve = done }) }
    const render = () => { cursor = 0; return useCanvasPersistenceActions('project', 'zh-CN', retry, async () => { throw Error('private detail') }) }
    const first = render().run('retry')
    assert.equal(render().action, 'retry')
    await render().run('retry')
    assert.equal(count, 1)
    resolve(false); await first
    assert.equal(render().action, '')
    assert.match(render().error, /尚未同步/)
    const second = render().run('retry')
    assert.equal(render().error, '')
    resolve(true); await second
    assert.equal(render().error, '')
    await render().run('refresh')
    assert.match(render().error, /恢复失败/)
    assert.doesNotMatch(render().error, /private detail/)
  } finally { delete globalThis.__conflictActions }
})

test('使用云端需要面板内二次确认，取消不调用替换，执行中两按钮禁用', async () => {
  let confirming = false, accepted = 0
  globalThis.__conflictConfirmation = { state: () => [confirming, value => { confirming = value }] }
  try {
    const { AgentConflictActions } = await load('src/features/agent/AgentConflictActions.tsx', {
      react: 'export const useState=globalThis.__conflictConfirmation.state;',
      'react/jsx-runtime': 'export const jsx=(type,props)=>({type,props}), jsxs=jsx;',
      './AgentConflictActions.css': '',
    })
    const render = (action = '') => AgentConflictActions({ locale: 'zh-CN', action, error: '', onKeepLocal: () => {}, onUseRemote: () => { accepted++ } })
    const buttons = view => view.props.children.at(-1).props.children
    buttons(render())[1].props.onClick()
    assert.equal(accepted, 0)
    assert.equal(buttons(render())[1].props.children, '确认使用云端')
    buttons(render())[0].props.onClick()
    assert.equal(confirming, false)
    assert.equal(accepted, 0)
    buttons(render())[1].props.onClick()
    buttons(render())[1].props.onClick()
    assert.equal(accepted, 1)
    assert.ok(buttons(render('refresh')).every(button => button.props.disabled))
  } finally { delete globalThis.__conflictConfirmation }
})

test('项目草稿重试隔离其他项目；无变化和 JSON 键序变化不产生远端写入', async () => {
  const tables = Object.fromEntries(['documents', 'documentBackups', 'media', 'pendingSync'].map(name => {
    const rows = new Map()
    return [name, {
      get: async id => structuredClone(rows.get(id)),
      put: async row => rows.set(row.id, structuredClone(row)),
      delete: async id => rows.delete(id),
      orderBy: () => ({ toArray: async () => structuredClone([...rows.values()]) }),
    }]
  }))
  const doc = id => ({ id, name: id, updatedAt: 1, nodes: [{ id: 'node', type: 'text', position: { x: 1, y: 2 }, data: { label: '原图', text: '保留' } }], edges: [], agentSessions: [] })
  const requests = []
  let writeGate, failWrite = false, onWrite = () => {}
  const remote = new Map(['current', 'other'].map(id => [id, doc(id)]))
  const previousWindow = globalThis.window
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } })
  globalThis.window = globalThis
  globalThis.__draftRecovery = {
    db: { ...tables, transaction: async (...args) => args.at(-1)() },
    request: async (url, options = {}) => {
      const id = url.split('/')[3]
      requests.push({ id, method: options.method ?? 'GET', body: options.body && JSON.parse(options.body) })
      if (id === 'other') throw Object.assign(new Error('其他项目冲突'), { status: 409 })
      if (options.method) {
        const gate = writeGate
        writeGate = undefined
        onWrite()
        if (gate) await gate
        else if (failWrite) throw Object.assign(new Error('暂时不可用'), { status: 503 })
        const patch = JSON.parse(options.body)
        remote.set(id, { ...remote.get(id), ...patch.fields, ...(patch.nodes?.upsert ? { nodes: patch.nodes.upsert } : {}) })
      }
      return { document: structuredClone(remote.get(id)), revision: requests.length, graphRevision: 1, syncProtocolEpoch: 1 }
    },
  }
  try {
    const db = await load('src/lib/db.ts', {
      './canvasDb': 'export const canvasDb=globalThis.__draftRecovery.db; export const enqueuePersistence=f=>f(); export const canvasSyncOutboxStorage={};',
      './productSession': 'export const serverPersistenceEnabled=true, productRequest=(...args)=>globalThis.__draftRecovery.request(...args); export class ProductApiError extends Error {}',
    })
    await tables.pendingSync.put({ id: 'other', document: doc('other'), updatedAt: 1 })
    const local = { ...doc('current'), name: '我的编辑', updatedAt: 2 }
    await tables.pendingSync.put({ id: 'current', document: local, updatedAt: 2 })
    const syncing = db.syncPendingCanvasDrafts('current')
    assert.equal(db.syncPendingCanvasDrafts('current'), syncing, '重复重试共享同一次同步')
    const result = await syncing
    assert.equal(result.pending, 0, '当前项目同步不能受其他草稿的 pending 影响')
    assert.equal(requests.some(request => request.id === 'other'), false, '不读取、不写入其他项目')
    assert.ok(await tables.pendingSync.get('other'), '不能删除其他项目草稿')
    assert.equal(remote.get('current').name, '我的编辑')
    requests.length = 0
    await db.writeCanvasDocument(structuredClone(local), { immediate: true })
    assert.deepEqual(requests, [], '相同文档不发送空 PATCH')
    const reordered = { ...local, updatedAt: 3, nodes: [{ data: { text: '保留', label: '原图' }, position: { y: 2, x: 1 }, type: 'text', id: 'node' }] }
    await db.writeCanvasDocument(reordered, { immediate: true })
    assert.deepEqual(requests, [], '只有 JSON 对象键序和保存时间变化不应重写所有节点')
    await db.writeCanvasDocument(doc('workspace-placeholder'), { immediate: true })
    assert.deepEqual(requests, [], '路由占位不能自动创建云端项目')

    // 同一毫秒的两次编辑：旧 ACK 不能清掉新草稿；第二次失败也必须可恢复。
    let release
    writeGate = new Promise(resolve => { release = resolve })
    const sent = new Promise(resolve => { onWrite = resolve })
    const first = db.writeCanvasDocument({ ...local, name: '旧编辑', updatedAt: 4 }, { immediate: true })
    await sent
    const latest = { ...local, name: '最新编辑', updatedAt: 4 }
    const second = db.writeCanvasDocument(latest, { immediate: true })
    const failed = assert.rejects(second, /暂时不可用/)
    await new Promise(resolve => setImmediate(resolve))
    failWrite = true
    release()
    await first
    await failed
    assert.equal((await tables.pendingSync.get('current'))?.document.name, '最新编辑', '旧 ACK 不能删除未被确认的新版本')
    failWrite = false
    await db.syncPendingCanvasDrafts('current')
    assert.equal(remote.get('current').name, '最新编辑')
    assert.equal(await tables.pendingSync.get('current'), undefined)
  } finally {
    globalThis.window = previousWindow
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator)
    else delete globalThis.navigator
    delete globalThis.__draftRecovery
  }
})

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
