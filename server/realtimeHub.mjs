import { WebSocket, WebSocketServer } from 'ws'
import { createCanvasCollaborationRoom } from './canvasCollaborationRoom.mjs'
import { verifyRealtimeTicket } from './realtimeTicket.mjs'

export function createProjectRealtimeHub({ server, productStore, ticketSecret, roomIdleMs = 60_000 }) {
  if (!server || !productStore || !ticketSecret) throw new TypeError('实时服务配置不完整。')
  const webSocketServer = new WebSocketServer({ noServer: true })
  const clientsByProject = new Map()
  const roomsByProject = new Map()
  const roomIdleTimers = new Map()
  let closing = false

  const cancelRoomEviction = (projectId) => {
    const timer = roomIdleTimers.get(projectId)
    if (timer) clearTimeout(timer)
    roomIdleTimers.delete(projectId)
  }

  const evictRoomIfIdle = async (projectId, roomPromise) => {
    roomIdleTimers.delete(projectId)
    if (clientsByProject.get(projectId)?.size || roomsByProject.get(projectId) !== roomPromise) return
    roomsByProject.delete(projectId)
    try {
      const entry = await roomPromise
      await entry.room.destroy()
    } catch {
      // 初始化失败的房间已经从缓存移除，下一次连接会重新加载。
    }
  }

  const scheduleRoomEviction = (projectId) => {
    if (closing || clientsByProject.get(projectId)?.size) return
    const roomPromise = roomsByProject.get(projectId)
    if (!roomPromise) return
    cancelRoomEviction(projectId)
    const timer = setTimeout(() => { void evictRoomIfIdle(projectId, roomPromise) }, roomIdleMs)
    timer.unref?.()
    roomIdleTimers.set(projectId, timer)
  }

  const collaborationRoom = async (userId, projectId, project) => {
    cancelRoomEviction(projectId)
    let roomPromise = roomsByProject.get(projectId)
    if (!roomPromise) {
      roomPromise = (async () => {
        const state = await productStore.loadCanvasCollaboration?.(userId, projectId) ?? {
          graph: {
            nodes: structuredClone(project.document?.nodes ?? []),
            edges: structuredClone(project.document?.edges ?? []),
          },
          graphRevision: 1,
          updates: [],
        }
        const entry = {
          hasState: Boolean(
            state.snapshot
            || state.updates?.length
            || state.graph.nodes.length
            || state.graph.edges.length
          ),
        }
        entry.room = createCanvasCollaborationRoom({
          state,
          append: async (payload, actorId) => {
            const saved = await productStore.appendCanvasGraphUpdate?.(actorId, projectId, payload)
              ?? { graphRevision: state.graphRevision, updatedAt: Date.now(), updateCount: 0 }
            entry.hasState = true
            return saved
          },
          compact: async (payload, actorId) => {
            await productStore.compactCanvasGraphUpdates?.(actorId, projectId, payload)
          },
        })
        return entry
      })()
      roomsByProject.set(projectId, roomPromise)
      void roomPromise.catch(() => {
        if (roomsByProject.get(projectId) === roomPromise) roomsByProject.delete(projectId)
        cancelRoomEviction(projectId)
      })
    }
    return roomPromise
  }

  webSocketServer.on('connection', (socket, _request, context) => {
    const clients = clientsByProject.get(context.projectId) ?? new Set()
    cancelRoomEviction(context.projectId)
    clients.add(socket)
    clientsByProject.set(context.projectId, clients)
    socket.isAlive = true
    socket.on('pong', () => { socket.isAlive = true })
    socket.on('close', () => {
      clients.delete(socket)
      if (!clients.size) {
        clientsByProject.delete(context.projectId)
        scheduleRoomEviction(context.projectId)
      }
    })
    socket.on('message', async (data, isBinary) => {
      if (isBinary || !context.canEdit || data.byteLength > 700_000) return
      try {
        const event = JSON.parse(data.toString())
        if (event?.type !== 'canvas.crdt.update'
          || event.projectId !== context.projectId
          || typeof event.update !== 'string'
          || !event.update
          || event.update.length > 700_000
          || !/^[A-Za-z0-9+/]*={0,2}$/.test(event.update)) return
        const result = await context.roomEntry.room.applyUpdate(event.update, context.userId)
        if (!result.applied) return
        const payload = JSON.stringify({
          type: 'canvas.crdt.update',
          projectId: context.projectId,
          update: event.update,
        })
        for (const peer of clients) {
          if (peer !== socket && peer.readyState === WebSocket.OPEN) peer.send(payload)
        }
      } catch {
        // 未知消息不影响项目失效通知；权威文档仍由 HTTP 接口负责。
      }
    })
    socket.send(JSON.stringify({ type: 'realtime.ready', projectId: context.projectId }))
    if (context.roomEntry.hasState) {
      socket.send(JSON.stringify({
        type: 'canvas.crdt.update',
        projectId: context.projectId,
        update: context.roomEntry.room.stateUpdate(),
      }))
    }
  })

  const onUpgrade = async (request, socket, head) => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
      if (url.pathname !== '/api/realtime') return socket.destroy()
      const projectId = url.searchParams.get('projectId') ?? ''
      const authorized = verifyRealtimeTicket(url.searchParams.get('ticket') ?? '', {
        projectId,
        origin: request.headers.origin,
        secret: ticketSecret,
      })
      const project = authorized && await productStore.readProject(authorized.userId, projectId)
      if (!authorized || !project) return socket.destroy()
      const canEdit = await productStore.canEditProject(authorized.userId, projectId)
      const roomEntry = await collaborationRoom(authorized.userId, projectId, project)
      webSocketServer.handleUpgrade(request, socket, head, (client) => {
        webSocketServer.emit('connection', client, request, { ...authorized, canEdit, roomEntry })
      })
    } catch {
      socket.destroy()
    }
  }
  server.on('upgrade', onUpgrade)

  const heartbeat = setInterval(() => {
    for (const socket of webSocketServer.clients) {
      if (!socket.isAlive) {
        socket.terminate()
        continue
      }
      socket.isAlive = false
      socket.ping()
    }
  }, 30_000)
  heartbeat.unref?.()

  return {
    async publishProjectUpdated({ projectId, revision, graphRevision, updatedAt, graph, actorId }) {
      if (graph) {
        const { room } = await collaborationRoom(actorId, projectId, { document: graph })
        await room.replaceBaseGraph(graph, actorId)
        scheduleRoomEviction(projectId)
      }
      const payload = JSON.stringify({ type: 'project.updated', projectId, revision, graphRevision, updatedAt })
      for (const socket of clientsByProject.get(projectId) ?? []) {
        if (socket.readyState === WebSocket.OPEN) socket.send(payload)
      }
    },
    publishAgentRunUpdated({ projectId, run }) {
      const payload = JSON.stringify({ type: 'agent.run.updated', projectId, run })
      for (const socket of clientsByProject.get(projectId) ?? []) {
        if (socket.readyState === WebSocket.OPEN) socket.send(payload)
      }
    },
    async close() {
      closing = true
      clearInterval(heartbeat)
      for (const timer of roomIdleTimers.values()) clearTimeout(timer)
      roomIdleTimers.clear()
      server.off('upgrade', onUpgrade)
      for (const socket of webSocketServer.clients) socket.close(1001, 'server shutdown')
      await new Promise((resolve) => webSocketServer.close(resolve))
      for (const roomPromise of roomsByProject.values()) {
        try { await (await roomPromise).room.destroy() } catch { /* 已失败房间无需再次关闭。 */ }
      }
      roomsByProject.clear()
    },
  }
}
