import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { createProductStore } from './productStore.mjs'
import { createProjectRealtimeHub } from './realtimeHub.mjs'
import { issueRealtimeTicket } from './realtimeTicket.mjs'

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => resolve(JSON.parse(data.toString())))
    socket.once('error', reject)
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
  const ticket = issueRealtimeTicket({ userId: 'user-1', projectId: 'project-1', secret: 'test-secret' })
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/realtime?projectId=project-1&ticket=${encodeURIComponent(ticket)}`)
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

test('编辑者的 CRDT 增量只转发给同项目的其他连接', async (context) => {
  const server = createServer((_request, response) => response.end())
  const productStore = {
    async readProject(_userId, projectId) {
      return projectId === 'project-1' ? { document: {}, revision: 1 } : undefined
    },
    async canEditProject(userId, projectId) {
      return projectId === 'project-1' && userId !== 'viewer'
    },
  }
  const hub = createProjectRealtimeHub({ server, ticketSecret: 'test-secret', productStore })
  await listen(server)
  const address = server.address()
  const connect = (userId) => new WebSocket(
    `ws://127.0.0.1:${address.port}/api/realtime?projectId=project-1&ticket=${encodeURIComponent(issueRealtimeTicket({ userId, projectId: 'project-1', secret: 'test-secret' }))}`,
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

  const received = nextMessage(receiver)
  const update = validCrdtUpdate()
  sender.send(JSON.stringify({ type: 'canvas.crdt.update', projectId: 'project-1', update }))

  assert.deepEqual(await received, {
    type: 'canvas.crdt.update',
    projectId: 'project-1',
    update,
  })
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
    `ws://127.0.0.1:${port}/api/realtime?projectId=project-restart&ticket=${encodeURIComponent(issueRealtimeTicket({ userId: owner.id, projectId: 'project-restart', secret: 'test-secret' }))}`,
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
