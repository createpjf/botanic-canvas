import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { createProductStore } from './store/productStore.mjs'
import { createProjectRealtimeHub } from './realtimeHub.mjs'
import { issueRealtimeTicket } from './auth/realtimeTicket.mjs'

const testOrigin = 'http://localhost'

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => resolve(JSON.parse(data.toString())))
    socket.once('error', reject)
  })
}

function closed(socket) {
  return new Promise((resolve) => socket.once('close', resolve))
}

function nextMessageWithin(socket, timeoutMs = 300) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      socket.off('message', onMessage)
      socket.off('error', onError)
    }
    const onMessage = (data) => {
      cleanup()
      resolve(JSON.parse(data.toString()))
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('等待实时消息超时'))
    }, timeoutMs)
    socket.on('message', onMessage)
    socket.on('error', onError)
  })
}

function nextMessages(socket, count) {
  return new Promise((resolve, reject) => {
    const messages = []
    const onMessage = (data) => {
      messages.push(JSON.parse(data.toString()))
      if (messages.length === count) {
        socket.off('message', onMessage)
        resolve(messages)
      }
    }
    socket.on('message', onMessage)
    socket.once('error', reject)
  })
}

function validCrdtUpdate(id = 'node-a') {
  const document = new Y.Doc()
  document.getMap('nodes').set(id, {
    order: 0,
    value: { id, type: 'text', position: { x: 120, y: 20 }, data: { kind: 'text', label: id, content: id } },
  })
  return Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64')
}

test('已授权客户端只接收当前项目的实时更新', async (context) => {
  const server = createServer((_request, response) => response.end())
  const hub = createProjectRealtimeHub({
    server,
    ticketSecret: 'test-secret',
    productStore: {
      async readProject(userId, projectId) {
        return userId === 'user-1' && projectId === 'project-1' ? { document: {}, revision: 1 } : undefined
      },
      async canEditProject(userId, projectId) {
        return userId === 'user-1' && projectId === 'project-1'
      },
    },
  })
  await listen(server)
  const address = server.address()
  const ticket = issueRealtimeTicket({ userId: 'user-1', projectId: 'project-1', origin: testOrigin, secret: 'test-secret' })
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/realtime?projectId=project-1&ticket=${encodeURIComponent(ticket)}`, { origin: testOrigin })
  context.after(async () => {
    socket.close()
    await hub.close()
    await new Promise((resolve) => server.close(resolve))
  })

  assert.deepEqual(await nextMessage(socket), { type: 'realtime.ready', projectId: 'project-1' })
  hub.publishProjectUpdated({ projectId: 'project-2', revision: 2, updatedAt: 200 })
  hub.publishProjectUpdated({ projectId: 'project-1', revision: 3, updatedAt: 300 })
  assert.deepEqual(await nextMessage(socket), {
    type: 'project.updated',
    projectId: 'project-1',
    revision: 3,
    updatedAt: 300,
  })
})

test('客户端主动订阅后收到按成员去重的在线状态', async (context) => {
  const server = createServer((_request, response) => response.end())
  const hub = createProjectRealtimeHub({
    server,
    ticketSecret: 'test-secret',
    productStore: {
      async readProject(_userId, projectId) {
        return projectId === 'project-1' ? { document: {}, revision: 1 } : undefined
      },
      async canEditProject(userId) { return userId !== 'member-2' },
    },
  })
  await listen(server)
  const address = server.address()
  const connect = (userId) => new WebSocket(
    `ws://127.0.0.1:${address.port}/api/realtime?projectId=project-1&ticket=${encodeURIComponent(issueRealtimeTicket({ userId, projectId: 'project-1', origin: testOrigin, secret: 'test-secret' }))}`,
    { origin: testOrigin },
  )
  const first = connect('member-1')
  const duplicate = connect('member-1')
  const second = connect('member-2')
  context.after(async () => {
    first.close()
    duplicate.close()
    second.close()
    await hub.close()
    await new Promise((resolve) => server.close(resolve))
  })
  await Promise.all([nextMessage(first), nextMessage(duplicate), nextMessage(second)])

  first.send(JSON.stringify({ type: 'collaboration.presence.subscribe', projectId: 'project-1' }))
  const firstPresence = await nextMessage(first)
  assert.deepEqual(firstPresence, {
    type: 'collaboration.presence',
    projectId: 'project-1',
    members: [{ userId: 'member-1', connectionCount: 1 }],
  })

  duplicate.send(JSON.stringify({ type: 'collaboration.presence.subscribe', projectId: 'project-1' }))
  await nextMessage(first)
  await nextMessage(duplicate)
  second.send(JSON.stringify({ type: 'collaboration.presence.subscribe', projectId: 'project-1' }))
  const presence = await nextMessage(second)
  assert.deepEqual(presence, {
    type: 'collaboration.presence',
    projectId: 'project-1',
    members: [
      { userId: 'member-1', connectionCount: 2 },
      { userId: 'member-2', connectionCount: 1 },
    ],
  })
})

test('项目更新携带成员来源与可读显示名', async (context) => {
  const server = createServer((_request, response) => response.end())
  const hub = createProjectRealtimeHub({
    server,
    ticketSecret: 'test-secret',
    productStore: {
      async readProject() { return { document: {}, revision: 1 } },
      async canEditProject() { return true },
    },
  })
  await listen(server)
  const address = server.address()
  const socket = new WebSocket(
    `ws://127.0.0.1:${address.port}/api/realtime?projectId=project-1&ticket=${encodeURIComponent(issueRealtimeTicket({ userId: 'member-1', actorName: 'Mia', projectId: 'project-1', origin: testOrigin, secret: 'test-secret' }))}`,
    { origin: testOrigin },
  )
  context.after(async () => {
    socket.close()
    await hub.close()
    await new Promise((resolve) => server.close(resolve))
  })
  await nextMessage(socket)

  hub.publishProjectUpdated({ projectId: 'project-1', revision: 4, updatedAt: 400, actorId: 'member-1' })
  assert.deepEqual(await nextMessage(socket), {
    type: 'project.updated', projectId: 'project-1', revision: 4, updatedAt: 400, actorId: 'member-1', actorName: 'Mia',
  })
})

test('Agent Run 进度只推送给当前项目连接', async (context) => {
  const server = createServer((_request, response) => response.end())
  const hub = createProjectRealtimeHub({
    server,
    ticketSecret: 'test-secret',
    productStore: {
      async readProject(userId, projectId) {
        return userId === 'user-1' && projectId === 'project-1' ? { document: {}, revision: 1 } : undefined
      },
      async canEditProject() { return true },
    },
  })
  await listen(server)
  const address = server.address()
  const ticket = issueRealtimeTicket({ userId: 'user-1', projectId: 'project-1', origin: testOrigin, secret: 'test-secret' })
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/realtime?projectId=project-1&ticket=${encodeURIComponent(ticket)}`, { origin: testOrigin })
  context.after(async () => {
    socket.close()
    await hub.close()
    await new Promise((resolve) => server.close(resolve))
  })
  await nextMessage(socket)

  const received = nextMessage(socket)
  hub.publishAgentRunUpdated({ projectId: 'project-1', run: { id: 'run-1', status: 'running', completedBranchCount: 1, failedBranchCount: 0, branches: [] } })
  assert.deepEqual(await received, {
    type: 'agent.run.updated',
    projectId: 'project-1',
    run: { id: 'run-1', status: 'running', completedBranchCount: 1, failedBranchCount: 0, branches: [] },
  })
})

test('独立 Agent 实体活动实时推送给当前项目连接', async (context) => {
  const server = createServer((_request, response) => response.end())
  const hub = createProjectRealtimeHub({
    server,
    ticketSecret: 'test-secret',
    productStore: {
      async readProject() { return { document: {}, revision: 1 } },
      async canEditProject() { return true },
    },
  })
  await listen(server)
  const address = server.address()
  const ticket = issueRealtimeTicket({ userId: 'user-1', projectId: 'project-1', origin: testOrigin, secret: 'test-secret' })
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/realtime?projectId=project-1&ticket=${encodeURIComponent(ticket)}`, { origin: testOrigin })
  context.after(async () => {
    socket.close()
    await hub.close()
    await new Promise((resolve) => server.close(resolve))
  })
  await nextMessage(socket)

  const activity = {
    id: 'agent-message-1', actorId: 'member-2', actorName: 'Mia', kind: 'conversation', summary: '更新了对话「海边方向」',
    target: { kind: 'message', sessionId: 'session-1', messageId: 'message-1' }, occurredAt: 200, count: 1,
  }
  hub.publishCollaborationActivity({ projectId: 'project-1', activity })
  assert.deepEqual(await nextMessage(socket), {
    type: 'collaboration.activity', projectId: 'project-1', activity: { ...activity, unread: true },
  })
})

test('只有 HTTP 物化图谱的项目在连接时也会下发 Yjs 初始状态', async (context) => {
  const server = createServer((_request, response) => response.end())
  const graph = {
    nodes: [{ id: 'node-http', type: 'text', position: { x: 40, y: 20 }, data: { kind: 'text', label: 'HTTP', content: 'HTTP' } }],
    edges: [],
  }
  const productStore = {
    async readProject() { return { document: graph, revision: 1 } },
    async canEditProject() { return true },
    async loadCanvasCollaboration() { return { graph, graphRevision: 1, updates: [] } },
  }
  const hub = createProjectRealtimeHub({ server, ticketSecret: 'test-secret', productStore })
  await listen(server)
  const address = server.address()
  const ticket = issueRealtimeTicket({ userId: 'user-1', projectId: 'project-1', origin: testOrigin, secret: 'test-secret' })
  const socket = new WebSocket(
    `ws://127.0.0.1:${address.port}/api/realtime?projectId=project-1&ticket=${encodeURIComponent(ticket)}`,
    { origin: testOrigin },
  )
  context.after(async () => {
    socket.close()
    await hub.close()
    await new Promise((resolve) => server.close(resolve))
  })

  const [ready, initialState] = await nextMessages(socket, 2)
  assert.deepEqual(ready, { type: 'realtime.ready', projectId: 'project-1' })
  const document = new Y.Doc()
  Y.applyUpdate(document, Buffer.from(initialState.update, 'base64'))
  assert.equal(document.getMap('nodes').get('node-http').value.position.x, 40)
})

test('V2 客户端只接收缺失增量，失去编辑权时收到永久 NACK', async (context) => {
  const server = createServer((_request, response) => response.end())
  const serverDocument = new Y.Doc()
  const nodes = serverDocument.getMap('nodes')
  nodes.set('node-known', {
    order: 0,
    value: { id: 'node-known', type: 'text', position: { x: 20, y: 20 }, data: { kind: 'text', label: 'known', content: 'known' } },
  })
  const clientDocument = new Y.Doc()
  Y.applyUpdate(clientDocument, Y.encodeStateAsUpdate(serverDocument))
  nodes.set('node-missing', {
    order: 1,
    value: { id: 'node-missing', type: 'text', position: { x: 80, y: 20 }, data: { kind: 'text', label: 'missing', content: 'missing' } },
  })
  const fullUpdate = Y.encodeStateAsUpdate(serverDocument)
  const graph = {
    nodes: [...nodes.values()].map((record) => record.value),
    edges: [],
  }
  let persisted = {
    graph,
    graphRevision: 7,
    snapshot: Buffer.from(fullUpdate).toString('base64'),
    updates: [],
  }
  const hub = createProjectRealtimeHub({
    server,
    ticketSecret: 'test-secret',
    productStore: {
      async readProject() { return { document: graph, revision: 1 } },
      async canEditProject() { return false },
      async loadCanvasCollaboration() {
        return structuredClone(persisted)
      },
    },
  })
  await listen(server)
  const ticket = issueRealtimeTicket({ userId: 'viewer-1', projectId: 'project-1', origin: testOrigin, secret: 'test-secret' })
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.address().port}/api/realtime?projectId=project-1&protocol=2&ticket=${encodeURIComponent(ticket)}`,
    { origin: testOrigin },
  )
  const messages = []
  socket.on('message', (data) => messages.push(JSON.parse(data.toString())))
  context.after(async () => {
    socket.close()
    await hub.close()
    await new Promise((resolve) => server.close(resolve))
  })

  while (!messages.length) await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.deepEqual(messages, [{ type: 'realtime.ready', projectId: 'project-1', protocol: 2 }], 'V2 握手前不应推送整份图谱')
  const latestDocument = new Y.Doc()
  Y.applyUpdate(latestDocument, fullUpdate)
  latestDocument.getMap('nodes').set('node-durable', {
    order: 2,
    value: { id: 'node-durable', type: 'text', position: { x: 140, y: 20 }, data: { kind: 'text', label: 'durable', content: 'durable' } },
  })
  persisted = {
    graph: {
      nodes: [...latestDocument.getMap('nodes').values()].map((record) => record.value),
      edges: [],
    },
    graphRevision: 8,
    snapshot: Buffer.from(Y.encodeStateAsUpdate(latestDocument)).toString('base64'),
    updates: [],
  }
  const response = nextMessageWithin(socket)
  socket.send(JSON.stringify({
    type: 'canvas.sync.hello.v2',
    protocol: 2,
    projectId: 'project-1',
    schemaVersion: 2,
    clientInstanceId: 'client-1',
    stateVectorBase64: Buffer.from(Y.encodeStateVector(clientDocument)).toString('base64'),
  }))
  const ready = await response

  assert.equal(ready.type, 'canvas.sync.ready.v2')
  assert.equal(ready.protocol, 2)
  assert.equal(ready.schemaVersion, 2)
  assert.equal(ready.graphRevision, 8)
  const delta = Buffer.from(ready.updateBase64, 'base64')
  assert.ok(delta.byteLength < Buffer.from(persisted.snapshot, 'base64').byteLength)
  Y.applyUpdate(clientDocument, delta)
  assert.deepEqual([...clientDocument.getMap('nodes').keys()].sort(), ['node-durable', 'node-known', 'node-missing'])

  const rejected = nextMessageWithin(socket)
  socket.send(JSON.stringify({
    type: 'canvas.crdt.update',
    projectId: 'project-1',
    mutationId: 'mutation-viewer',
    update: validCrdtUpdate('node-denied'),
  }))
  assert.deepEqual(await rejected, {
    type: 'canvas.graph.nack.v2',
    protocol: 2,
    projectId: 'project-1',
    mutationId: 'mutation-viewer',
    code: 'PERMISSION_REVOKED',
    retryable: false,
  })
})

test('V2 项目 epoch 前进后拒绝旧会话，重新握手后提交同一 Outbox', async (context) => {
  const server = createServer((_request, response) => response.end())
  let syncProtocolEpoch = 2
  let graphRevision = 1
  const productStore = {
    async readProject() { return { document: { nodes: [], edges: [] }, revision: 1 } },
    async canEditProject() { return true },
    async readCanvasSyncProtocolEpoch() { return syncProtocolEpoch },
    async appendCanvasGraphUpdate() {
      graphRevision += 1
      return { graphRevision, mutationRevision: graphRevision, updatedAt: 200, updateCount: 1, duplicate: false }
    },
  }
  const hub = createProjectRealtimeHub({ server, ticketSecret: 'test-secret', productStore })
  await listen(server)
  const ticket = issueRealtimeTicket({ userId: 'editor-1', projectId: 'project-1', origin: testOrigin, secret: 'test-secret' })
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.address().port}/api/realtime?projectId=project-1&protocol=2&ticket=${encodeURIComponent(ticket)}`,
    { origin: testOrigin },
  )
  context.after(async () => {
    socket.close()
    await hub.close()
    await new Promise((resolve) => server.close(resolve))
  })
  assert.deepEqual(await nextMessage(socket), { type: 'realtime.ready', projectId: 'project-1', protocol: 2 })
  const hello = () => socket.send(JSON.stringify({
    type: 'canvas.sync.hello.v2', protocol: 2, projectId: 'project-1', schemaVersion: 2,
    clientInstanceId: 'client-epoch', stateVectorBase64: Buffer.from(Y.encodeStateVector(new Y.Doc())).toString('base64'),
  }))
  let response = nextMessageWithin(socket)
  hello()
  assert.equal((await response).syncProtocolEpoch, 2)

  syncProtocolEpoch = 3
  response = nextMessageWithin(socket)
  socket.send(JSON.stringify({
    type: 'canvas.crdt.update', projectId: 'project-1', mutationId: 'mutation-epoch',
    syncProtocolEpoch: 2, update: validCrdtUpdate('node-epoch'),
  }))
  assert.deepEqual(await response, {
    type: 'canvas.graph.nack.v2', protocol: 2, projectId: 'project-1', mutationId: 'mutation-epoch',
    code: 'EPOCH_STALE', retryable: true, syncProtocolEpoch: 3,
  })

  response = nextMessageWithin(socket)
  hello()
  assert.equal((await response).syncProtocolEpoch, 3)
  response = nextMessageWithin(socket)
  socket.send(JSON.stringify({
    type: 'canvas.crdt.update', projectId: 'project-1', mutationId: 'mutation-epoch',
    syncProtocolEpoch: 3, update: validCrdtUpdate('node-epoch'),
  }))
  assert.equal((await response).type, 'canvas.crdt.committed')
})

test('编辑者的 CRDT 增量提交后 ACK，同一 mutation 重放只下发无活动修复状态', async (context) => {
  const server = createServer((_request, response) => response.end())
  let graphRevision = 1
  let activityCount = 0
  const mutations = new Map()
  let persistedGraph = { nodes: [], edges: [] }
  const productStore = {
    async readProject(_userId, projectId) {
      return projectId === 'project-1' ? { document: {}, revision: 1 } : undefined
    },
    async canEditProject(userId, projectId) {
      return projectId === 'project-1' && userId !== 'viewer'
    },
    async loadCanvasCollaboration() {
      return { graph: structuredClone(persistedGraph), graphRevision, updates: [] }
    },
    async appendCanvasGraphUpdate(_userId, _projectId, payload) {
      const committed = mutations.get(payload.mutationId)
      if (committed) {
        if (committed.idempotencyUpdate !== (payload.idempotencyUpdate ?? payload.update)) {
          const error = new Error('画布协作提交身份已绑定到其他更新。')
          error.code = 'CANVAS_MUTATION_CONFLICT'
          throw error
        }
        return { ...committed.saved, graphRevision, duplicate: true, update: committed.update }
      }
      graphRevision += 1
      const saved = {
        graphRevision,
        mutationRevision: graphRevision,
        updatedAt: 200,
        updateCount: 1,
      }
      mutations.set(payload.mutationId, {
        saved,
        update: payload.update,
        idempotencyUpdate: payload.idempotencyUpdate ?? payload.update,
      })
      persistedGraph = structuredClone(payload.graph)
      return { ...saved, duplicate: false }
    },
    async putCollaborationActivity(userId, _projectId, input) {
      activityCount += 1
      return { ...input, actorId: userId, actorName: '协作者', occurredAt: 200, count: 1 }
    },
  }
  const hub = createProjectRealtimeHub({
    server,
    ticketSecret: 'test-secret',
    productStore,
    crossInstancePublisher: {
      async publishCanvasUpdate() { throw new Error('redis unavailable') },
      async publishPresence() {},
    },
  })
  await listen(server)
  const address = server.address()
  const connect = (userId) => new WebSocket(
    `ws://127.0.0.1:${address.port}/api/realtime?projectId=project-1&protocol=2&ticket=${encodeURIComponent(issueRealtimeTicket({ userId, projectId: 'project-1', origin: testOrigin, secret: 'test-secret' }))}`,
    { origin: testOrigin },
  )
  const sender = connect('editor-1')
  const receiver = connect('editor-2')
  context.after(async () => {
    sender.close()
    receiver.close()
    await hub.close()
    await new Promise((resolve) => server.close(resolve))
  })
  await Promise.all([nextMessage(sender), nextMessage(receiver)])

  const committed = nextMessage(sender)
  const received = nextMessage(receiver)
  const update = validCrdtUpdate()
  const mutationId = 'mutation-1'
  sender.send(JSON.stringify({ type: 'canvas.crdt.update', projectId: 'project-1', mutationId, update }))

  assert.deepEqual(await committed, {
    type: 'canvas.crdt.committed',
    projectId: 'project-1',
    mutationId,
    graphRevision: 2,
    mutationRevision: 2,
    updatedAt: 200,
  })

  assert.deepEqual(await received, {
    type: 'canvas.crdt.update',
    projectId: 'project-1',
    update,
    mutationId,
    actorId: 'editor-1',
    activity: {
      id: 'canvas-editor-1-2', actorId: 'editor-1', actorName: '协作者', kind: 'canvas',
      summary: '新增了「node-a」', target: { kind: 'node', nodeId: 'node-a' }, occurredAt: 200, count: 1, unread: true,
    },
  })
  const receiverDocument = new Y.Doc()
  Y.applyUpdate(receiverDocument, Buffer.from(update, 'base64'))

  const replayed = nextMessage(sender)
  const repaired = nextMessageWithin(receiver)
  sender.send(JSON.stringify({ type: 'canvas.crdt.update', projectId: 'project-1', mutationId, update }))
  assert.deepEqual(await replayed, {
    type: 'canvas.crdt.committed',
    projectId: 'project-1',
    mutationId,
    graphRevision: 2,
    mutationRevision: 2,
    updatedAt: 200,
  })
  const repairedEvent = await repaired
  assert.equal(repairedEvent.type, 'canvas.crdt.update')
  assert.equal(repairedEvent.mutationId, mutationId)
  assert.equal(repairedEvent.actorId, undefined)
  assert.equal(repairedEvent.activity, undefined)
  Y.applyUpdate(receiverDocument, Buffer.from(repairedEvent.update, 'base64'))
  assert.deepEqual([...receiverDocument.getMap('nodes').keys()], ['node-a'])
  assert.equal(activityCount, 1)

  const duplicateWithNewYjsContent = nextMessage(sender)
  sender.send(JSON.stringify({ type: 'canvas.crdt.update', projectId: 'project-1', mutationId, update: validCrdtUpdate('node-b') }))
  assert.deepEqual(await duplicateWithNewYjsContent, {
    type: 'canvas.graph.nack.v2',
    protocol: 2,
    projectId: 'project-1',
    mutationId,
    code: 'INVALID_UPDATE',
    retryable: false,
  })
  await assert.rejects(nextMessageWithin(receiver, 40), /等待实时消息超时/)
  assert.equal(activityCount, 1)

  const nextCommitted = nextMessage(sender)
  const nextReceived = nextMessage(receiver)
  sender.send(JSON.stringify({
    type: 'canvas.crdt.update', projectId: 'project-1', mutationId: 'mutation-2', update: validCrdtUpdate('node-c'),
  }))
  assert.equal((await nextCommitted).type, 'canvas.crdt.committed')
  assert.equal((await nextReceived).mutationId, 'mutation-2')
  assert.deepEqual(persistedGraph.nodes.map((node) => node.id).sort(), ['node-a', 'node-c'])
})

test('API 重启后向新连接补发已持久化的 Yjs 状态', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'botanic-realtime-restart-'))
  const dataPath = join(directory, 'product.json')
  const store = createProductStore({ dataPath, bootstrapAccessToken: 'owner-token' })
  const owner = store.authenticate('owner-token')
  store.writeProject(owner.id, {
    id: 'project-restart', name: '重启恢复', nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 },
    assets: [], templates: [], history: [], deliveries: [], generationJobs: [], updatedAt: Date.now(),
  })

  const createRunningHub = async (productStore) => {
    const server = createServer((_request, response) => response.end())
    const hub = createProjectRealtimeHub({ server, ticketSecret: 'test-secret', productStore })
    await listen(server)
    return { server, hub, port: server.address().port }
  }
  const connect = (port) => new WebSocket(
    `ws://127.0.0.1:${port}/api/realtime?projectId=project-restart&ticket=${encodeURIComponent(issueRealtimeTicket({ userId: owner.id, projectId: 'project-restart', origin: testOrigin, secret: 'test-secret' }))}`,
    { origin: testOrigin },
  )

  const first = await createRunningHub(store)
  const sender = connect(first.port)
  const receiver = connect(first.port)
  await Promise.all([nextMessage(sender), nextMessage(receiver)])
  const relayed = nextMessage(receiver)
  sender.send(JSON.stringify({ type: 'canvas.crdt.update', projectId: 'project-restart', update: validCrdtUpdate('node-restart') }))
  await relayed
  sender.close()
  receiver.close()
  await first.hub.close()
  await new Promise((resolve) => first.server.close(resolve))

  const reloaded = createProductStore({ dataPath, bootstrapAccessToken: 'owner-token' })
  const second = await createRunningHub(reloaded)
  const recoveredSocket = connect(second.port)
  const [ready, recoveredUpdate] = await nextMessages(recoveredSocket, 2)
  assert.deepEqual(ready, { type: 'realtime.ready', projectId: 'project-restart' })
  const recoveredDocument = new Y.Doc()
  Y.applyUpdate(recoveredDocument, Buffer.from(recoveredUpdate.update, 'base64'))
  assert.equal(recoveredDocument.getMap('nodes').has('node-restart'), true)
  recoveredSocket.close()
  await second.hub.close()
  await new Promise((resolve) => second.server.close(resolve))
})

test('没有在线房间时，HTTP 权威保存仍重写旧 Yjs 历史', async (context) => {
  const server = createServer((_request, response) => response.end())
  const authoritativeNode = {
    id: 'node-a', type: 'text', position: { x: 400, y: 20 }, data: { kind: 'text', label: 'new', content: 'new' },
  }
  const persisted = {
    graph: { nodes: [authoritativeNode], edges: [] },
    graphRevision: 3,
    updates: [validCrdtUpdate('node-a')],
  }
  let compactCount = 0
  const productStore = {
    async loadCanvasCollaboration() { return structuredClone(persisted) },
    async compactCanvasGraphUpdates(_userId, _projectId, payload) {
      compactCount += 1
      persisted.snapshot = payload.snapshot
      persisted.graph = structuredClone(payload.graph)
      persisted.updates = []
    },
    async readProject() {
      return { document: { nodes: [authoritativeNode], edges: [] }, revision: 2, graphRevision: 3 }
    },
    async canEditProject() { return true },
  }
  const hub = createProjectRealtimeHub({ server, ticketSecret: 'test-secret', productStore })
  context.after(async () => {
    await hub.close()
    await new Promise((resolve) => server.close(resolve))
  })
  await listen(server)

  await hub.publishProjectUpdated({
    projectId: 'project-1', revision: 2, graphRevision: 3, updatedAt: 300,
    graph: { nodes: [authoritativeNode], edges: [] }, actorId: 'user-1',
  })

  assert.equal(compactCount, 1)
  assert.deepEqual(persisted.updates, [])
  const recovered = new Y.Doc()
  Y.applyUpdate(recovered, Buffer.from(persisted.snapshot, 'base64'))
  assert.equal(recovered.getMap('nodes').get('node-a').value.position.x, 400)
})

test('Epoch 2 拒绝 project.updated 的整图兼容回写', async (context) => {
  const server = createServer((_request, response) => response.end())
  let loadCount = 0
  const hub = createProjectRealtimeHub({
    server,
    ticketSecret: 'test-secret',
    productStore: {
      async readCanvasSyncProtocolEpoch() { return 2 },
      async loadCanvasCollaboration() {
        loadCount += 1
        return { graph: { nodes: [], edges: [] }, graphRevision: 1, updates: [] }
      },
    },
  })
  context.after(async () => {
    await hub.close()
    await new Promise((resolve) => server.close(resolve))
  })
  await listen(server)

  await assert.rejects(
    hub.publishProjectUpdated({
      projectId: 'project-1', revision: 2, graphRevision: 3, updatedAt: 300,
      graph: { nodes: [], edges: [] }, actorId: 'user-1',
    }),
    (error) => error?.code === 'CANVAS_SYNC_EPOCH_STALE' && error.syncProtocolEpoch === 2,
  )
  assert.equal(loadCount, 0)
})

test('带图谱的项目更新缺少 actorId 时不进入画布存储', async (context) => {
  const server = createServer((_request, response) => response.end())
  let loadCount = 0
  const hub = createProjectRealtimeHub({
    server,
    ticketSecret: 'test-secret',
    productStore: {
      async loadCanvasCollaboration() {
        loadCount += 1
        return { graph: { nodes: [], edges: [] }, graphRevision: 1, updates: [] }
      },
    },
  })
  context.after(async () => {
    await hub.close()
    await new Promise((resolve) => server.close(resolve))
  })
  await listen(server)

  await assert.rejects(
    hub.publishProjectUpdated({
      projectId: 'project-1', revision: 2, graphRevision: 3, updatedAt: 300,
      graph: { nodes: [], edges: [] },
    }),
    /actorId/,
  )
  assert.equal(loadCount, 0)
})

test('房间初始化暂时失败后，下一次连接会重新加载', async (context) => {
  const server = createServer((_request, response) => response.end())
  let loadCount = 0
  const productStore = {
    async readProject() { return { document: { nodes: [], edges: [] }, revision: 1 } },
    async canEditProject() { return true },
    async loadCanvasCollaboration() {
      loadCount += 1
      if (loadCount === 1) throw new Error('temporary database failure')
      return { graph: { nodes: [], edges: [] }, graphRevision: 1, updates: [] }
    },
  }
  const hub = createProjectRealtimeHub({ server, ticketSecret: 'test-secret', productStore })
  await listen(server)
  const address = server.address()
  const connect = () => new WebSocket(
    `ws://127.0.0.1:${address.port}/api/realtime?projectId=project-1&ticket=${encodeURIComponent(issueRealtimeTicket({ userId: 'user-1', projectId: 'project-1', origin: testOrigin, secret: 'test-secret' }))}`,
    { origin: testOrigin },
  )
  context.after(async () => {
    await hub.close()
    await new Promise((resolve) => server.close(resolve))
  })

  const failed = connect()
  failed.on('error', () => undefined)
  await closed(failed)
  const retried = connect()
  assert.deepEqual(await nextMessageWithin(retried), { type: 'realtime.ready', projectId: 'project-1' })
  assert.equal(loadCount, 2)
  retried.close()
})

test('V2 握手重载失败会显式关闭连接并上报', async (context) => {
  const server = createServer((_request, response) => response.end())
  let loadCount = 0
  const reported = []
  const hub = createProjectRealtimeHub({
    server,
    ticketSecret: 'test-secret',
    reportError: (...input) => reported.push(input),
    productStore: {
      async readProject() { return { document: { nodes: [], edges: [] }, revision: 1 } },
      async canEditProject() { return true },
      async loadCanvasCollaboration() {
        loadCount += 1
        if (loadCount === 2) throw new Error('temporary handshake reload failure')
        return { graph: { nodes: [], edges: [] }, graphRevision: 1, updates: [] }
      },
    },
  })
  await listen(server)
  const ticket = issueRealtimeTicket({ userId: 'user-1', projectId: 'project-1', origin: testOrigin, secret: 'test-secret' })
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.address().port}/api/realtime?projectId=project-1&protocol=2&ticket=${encodeURIComponent(ticket)}`,
    { origin: testOrigin },
  )
  context.after(async () => {
    socket.close()
    await hub.close()
    await new Promise((resolve) => server.close(resolve))
  })

  assert.deepEqual(await nextMessage(socket), { type: 'realtime.ready', projectId: 'project-1', protocol: 2 })
  const closeResult = Promise.race([
    new Promise((resolve) => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))),
    new Promise((_, reject) => setTimeout(() => reject(new Error('V2 握手失败后连接仍保持 OPEN')), 300)),
  ])
  socket.send(JSON.stringify({
    type: 'canvas.sync.hello.v2',
    protocol: 2,
    projectId: 'project-1',
    schemaVersion: 2,
    clientInstanceId: 'client-handshake-failure',
    stateVectorBase64: Buffer.from(Y.encodeStateVector(new Y.Doc())).toString('base64'),
  }))

  assert.deepEqual(await closeResult, { code: 1013, reason: 'canvas sync unavailable' })
  assert.equal(reported.length, 1)
  assert.equal(reported[0][1].tags.operation, 'handshake')
})

test('最后一个客户端离开后释放空闲房间', async (context) => {
  const server = createServer((_request, response) => response.end())
  let loadCount = 0
  const productStore = {
    async readProject() { return { document: { nodes: [], edges: [] }, revision: 1 } },
    async canEditProject() { return true },
    async loadCanvasCollaboration() {
      loadCount += 1
      return { graph: { nodes: [], edges: [] }, graphRevision: 1, updates: [] }
    },
  }
  const hub = createProjectRealtimeHub({ server, ticketSecret: 'test-secret', productStore, roomIdleMs: 10 })
  await listen(server)
  const address = server.address()
  const connect = () => new WebSocket(
    `ws://127.0.0.1:${address.port}/api/realtime?projectId=project-1&ticket=${encodeURIComponent(issueRealtimeTicket({ userId: 'user-1', projectId: 'project-1', origin: testOrigin, secret: 'test-secret' }))}`,
    { origin: testOrigin },
  )
  context.after(async () => {
    await hub.close()
    await new Promise((resolve) => server.close(resolve))
  })

  const first = connect()
  await nextMessage(first)
  first.close()
  await closed(first)
  await new Promise((resolve) => setTimeout(resolve, 25))
  const second = connect()
  assert.deepEqual(await nextMessage(second), { type: 'realtime.ready', projectId: 'project-1' })
  assert.equal(loadCount, 2)
  second.close()
})

test('两个 API 实例通过跨实例总线同步 CRDT，重复事件不回环且只落库一次', async (context) => {
  const servers = [createServer((_request, response) => response.end()), createServer((_request, response) => response.end())]
  const graph = { nodes: [], edges: [] }
  let appendCount = 0
  const productStore = {
    async readProject() { return { document: graph, revision: 1 } },
    async canEditProject() { return true },
    async loadCanvasCollaboration() { return { graph, graphRevision: 1, updates: [] } },
    async appendCanvasGraphUpdate(_userId, _projectId, payload) {
      appendCount += 1
      graph.nodes = structuredClone(payload.graph.nodes)
      return { graphRevision: 2, updatedAt: 200, updateCount: 1 }
    },
    async putCollaborationActivity(userId, _projectId, input) {
      return { ...input, actorId: userId, occurredAt: 200, count: 1 }
    },
  }
  let secondHub
  const published = []
  const firstHub = createProjectRealtimeHub({
    server: servers[0], productStore, ticketSecret: 'test-secret', instanceId: 'api-a',
    crossInstancePublisher: {
      async publishCanvasUpdate(event) {
        published.push(event)
        await secondHub.receiveCanvasUpdate(event)
        await secondHub.receiveCanvasUpdate(event)
      },
      async publishPresence() {},
    },
  })
  secondHub = createProjectRealtimeHub({
    server: servers[1], productStore, ticketSecret: 'test-secret', instanceId: 'api-b',
    crossInstancePublisher: { async publishCanvasUpdate() {}, async publishPresence() {} },
  })
  await Promise.all(servers.map(listen))
  const connect = (index, userId) => new WebSocket(
    `ws://127.0.0.1:${servers[index].address().port}/api/realtime?projectId=project-1&ticket=${encodeURIComponent(issueRealtimeTicket({ userId, projectId: 'project-1', origin: testOrigin, secret: 'test-secret' }))}`,
    { origin: testOrigin },
  )
  const sender = connect(0, 'editor-1')
  const receiver = connect(1, 'editor-2')
  context.after(async () => {
    sender.close()
    receiver.close()
    await Promise.all([firstHub.close(), secondHub.close()])
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
  })
  await Promise.all([nextMessage(sender), nextMessage(receiver)])

  const received = nextMessage(receiver)
  sender.send(JSON.stringify({
    type: 'canvas.crdt.update', projectId: 'project-1',
    mutationId: 'mutation-cross-instance', update: validCrdtUpdate('node-cross-instance'),
  }))
  const event = await received

  assert.equal(event.type, 'canvas.crdt.update')
  assert.equal(event.actorId, 'editor-1')
  assert.equal(event.mutationId, 'mutation-cross-instance')
  assert.equal(appendCount, 1)
  assert.equal(published.length, 1)
  await assert.rejects(nextMessageWithin(receiver, 40), /等待实时消息超时/)

  const repaired = nextMessageWithin(receiver)
  await firstHub.publishCanvasGraphCommitted({
    projectId: 'project-1',
    update: event.update,
    mutationId: 'mutation-cross-instance',
    actorId: 'editor-1',
    graphRevision: 2,
    updatedAt: 200,
    duplicate: true,
  })
  const repairedEvent = await repaired
  assert.equal(repairedEvent.type, 'canvas.crdt.update')
  assert.equal(repairedEvent.mutationId, 'mutation-cross-instance')
  assert.equal(repairedEvent.actorId, undefined)
  assert.equal(repairedEvent.activity, undefined)
  assert.equal(published.length, 2)
})

test('跨实例 Presence 合并成员并在远端快照过期后移除', async (context) => {
  const server = createServer((_request, response) => response.end())
  let now = 100
  let hub
  const productStore = {
    async readProject() { return { document: { nodes: [], edges: [] }, revision: 1 } },
    async canEditProject() { return true },
  }
  hub = createProjectRealtimeHub({
    server, productStore, ticketSecret: 'test-secret', instanceId: 'api-b',
    now: () => now, presenceTtlMs: 50,
    crossInstancePublisher: { async publishCanvasUpdate() {}, async publishPresence() {} },
  })
  await listen(server)
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.address().port}/api/realtime?projectId=project-1&ticket=${encodeURIComponent(issueRealtimeTicket({ userId: 'member-b', projectId: 'project-1', origin: testOrigin, secret: 'test-secret' }))}`,
    { origin: testOrigin },
  )
  context.after(async () => {
    socket.close()
    await hub.close()
    await new Promise((resolve) => server.close(resolve))
  })
  await nextMessage(socket)
  socket.send(JSON.stringify({ type: 'collaboration.presence.subscribe', projectId: 'project-1' }))
  await nextMessage(socket)

  const merged = nextMessage(socket)
  await hub.receivePresence({
    eventId: 'presence-a-1', sourceInstanceId: 'api-a', projectId: 'project-1', sentAt: now,
    members: [{ userId: 'member-a', actorName: 'Mia', connectionCount: 2 }],
  })
  assert.deepEqual((await merged).members, [
    { userId: 'member-a', actorName: 'Mia', connectionCount: 2 },
    { userId: 'member-b', connectionCount: 1 },
  ])

  now = 200
  hub.pruneRemotePresence()
  assert.deepEqual((await nextMessage(socket)).members, [{ userId: 'member-b', connectionCount: 1 }])
})

test('损坏的跨实例增量或 Presence 被丢弃，不让实时 Hub 抛出未处理异常', async (context) => {
  const server = createServer((_request, response) => response.end())
  const productStore = {
    async readProject() { return { document: { nodes: [], edges: [] }, revision: 1 } },
    async canEditProject() { return true },
    async loadCanvasCollaboration() { return { graph: { nodes: [], edges: [] }, graphRevision: 1, updates: [] } },
  }
  const hub = createProjectRealtimeHub({ server, productStore, ticketSecret: 'test-secret', instanceId: 'api-b' })
  await listen(server)
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.address().port}/api/realtime?projectId=project-1&ticket=${encodeURIComponent(issueRealtimeTicket({ userId: 'editor-1', projectId: 'project-1', origin: testOrigin, secret: 'test-secret' }))}`,
    { origin: testOrigin },
  )
  context.after(async () => {
    socket.close()
    await hub.close()
    await new Promise((resolve) => server.close(resolve))
  })
  await nextMessage(socket)

  await assert.doesNotReject(() => hub.receiveCanvasUpdate({
    eventId: 'bad-update-1', sourceInstanceId: 'api-a', projectId: 'project-1',
    update: 'AQ==', actorId: 'editor-1', graphRevision: 2, updatedAt: 200,
  }))
  await assert.doesNotReject(() => hub.receiveCanvasUpdate({
    eventId: 'bad-update-2', sourceInstanceId: 'api-a', projectId: 'project-1',
    update: 'not-base64', actorId: 'editor-1', graphRevision: 3, updatedAt: 201,
  }))
  await assert.doesNotReject(() => hub.receivePresence({
    eventId: 'bad-presence-1', sourceInstanceId: 'api-a', projectId: 'project-1',
    members: [{ userId: 'editor-1', connectionCount: 0 }], sentAt: 200,
  }))
})
