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

test('消息读取失败向恢复调用者报错，原面板重试成功，迟到旧请求不覆盖新结果', async () => {
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
    const render = () => { cursor = 0; return useAgentSessionMessages('project', 'session', { messages: [], runs: [] }) }
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
    const older = view.refresh()
    const oldRequest = pending.shift()
    const newer = view.refresh()
    pending.shift().resolve({ messages: [{ id: 'new', role: 'assistant', kind: 'text', createdAt: 2 }] })
    await newer
    oldRequest.resolve({ messages: [] })
    await older
    assert.equal(render().messages[0].id, 'new')
  } finally { delete globalThis.__messageRecoveryTest }
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
