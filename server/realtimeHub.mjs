import { createHash, randomUUID } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import { createCanvasCollaborationRoom } from './canvasCollaborationRoom.mjs'
import { verifyRealtimeTicket } from './realtimeTicket.mjs'
import { collaborationChangeFromDocuments } from './collaborationActivityPersistence.mjs'

export function createProjectRealtimeHub({
  server,
  productStore,
  ticketSecret,
  roomIdleMs = 60_000,
  instanceId = randomUUID(),
  crossInstancePublisher = { async publishCanvasUpdate() {}, async publishPresence() {} },
  now = Date.now,
  presenceHeartbeatMs = 20_000,
  presenceTtlMs = 65_000,
}) {
  if (!server || !productStore || !ticketSecret) throw new TypeError('实时服务配置不完整。')
  const webSocketServer = new WebSocketServer({ noServer: true })
  const clientsByProject = new Map()
  const roomsByProject = new Map()
  const roomIdleTimers = new Map()
  const remotePresenceByProject = new Map()
  const seenCrossInstanceEvents = new Map()
  let closing = false

  const rememberEvent = (key) => {
    if (seenCrossInstanceEvents.has(key)) return false
    seenCrossInstanceEvents.set(key, now())
    if (seenCrossInstanceEvents.size > 2_000) {
      for (const oldest of [...seenCrossInstanceEvents.keys()].slice(0, 500)) seenCrossInstanceEvents.delete(oldest)
    }
    return true
  }

  const localPresenceMembers = (projectId) => {
    const members = new Map()
    for (const client of clientsByProject.get(projectId) ?? []) {
      if (!client.presenceSubscribed || client.readyState !== WebSocket.OPEN) continue
      const member = members.get(client.userId) ?? { actorName: client.actorName, connectionCount: 0 }
      member.connectionCount += 1
      members.set(client.userId, member)
    }
    return [...members.entries()].map(([userId, member]) => ({
      userId,
      ...(member.actorName ? { actorName: member.actorName } : {}),
      connectionCount: member.connectionCount,
    }))
  }

  const mergedPresenceMembers = (projectId) => {
    const members = new Map()
    const merge = (member) => {
      const current = members.get(member.userId) ?? { connectionCount: 0 }
      current.connectionCount += member.connectionCount
      if (!current.actorName && member.actorName) current.actorName = member.actorName
      members.set(member.userId, current)
    }
    localPresenceMembers(projectId).forEach(merge)
    for (const snapshot of remotePresenceByProject.get(projectId)?.values() ?? []) snapshot.members.forEach(merge)
    return [...members.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([userId, member]) => ({ userId, ...(member.actorName ? { actorName: member.actorName } : {}), connectionCount: member.connectionCount }))
  }

  const broadcastPresence = (projectId) => {
    const payload = JSON.stringify({
      type: 'collaboration.presence',
      projectId,
      members: mergedPresenceMembers(projectId),
    })
    for (const client of clientsByProject.get(projectId) ?? []) {
      if (client.presenceSubscribed && client.readyState === WebSocket.OPEN) client.send(payload)
    }
  }

  const publishLocalPresence = async (projectId) => {
    await crossInstancePublisher.publishPresence({
      eventId: randomUUID(), sourceInstanceId: instanceId, projectId,
      members: localPresenceMembers(projectId), sentAt: now(),
    })
  }

  const presenceChanged = (projectId) => {
    broadcastPresence(projectId)
    void publishLocalPresence(projectId).catch(() => undefined)
  }

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
    socket.userId = context.userId
    socket.actorName = context.actorName
    socket.presenceSubscribed = false
    socket.isAlive = true
    socket.on('pong', () => { socket.isAlive = true })
    socket.on('close', () => {
      clients.delete(socket)
      if (socket.presenceSubscribed) presenceChanged(context.projectId)
      if (!clients.size) {
        clientsByProject.delete(context.projectId)
        scheduleRoomEviction(context.projectId)
      }
    })
    socket.on('message', async (data, isBinary) => {
      if (isBinary || data.byteLength > 700_000) return
      try {
        const event = JSON.parse(data.toString())
        if (event?.type === 'collaboration.presence.subscribe' && event.projectId === context.projectId) {
          socket.presenceSubscribed = true
          presenceChanged(context.projectId)
          return
        }
        if (!context.canEdit) return
        if (event?.type !== 'canvas.crdt.update'
          || event.projectId !== context.projectId
          || typeof event.update !== 'string'
          || !event.update
          || event.update.length > 700_000
          || !/^[A-Za-z0-9+/]*={0,2}$/.test(event.update)) return
        const result = await context.roomEntry.room.applyUpdate(event.update, context.userId)
        if (!result.applied) return
        const change = collaborationChangeFromDocuments(result.previousGraph, result.graph) ?? { kind: 'canvas', summary: '更新了画布内容' }
        let activity
        try {
          activity = await productStore.putCollaborationActivity(context.userId, context.projectId, {
            id: `canvas-${context.userId}-${result.graphRevision}`,
            ...change,
          })
        } catch {
          // 历史索引暂不可写时仍广播已持久化的 CRDT 更新，客户端可用事件摘要降级展示。
        }
        const payload = JSON.stringify({
          type: 'canvas.crdt.update',
          projectId: context.projectId,
          update: event.update,
          actorId: context.userId,
          ...(context.actorName ? { actorName: context.actorName } : {}),
          ...(activity ? { activity: { ...activity, unread: true } } : {}),
        })
        for (const peer of clients) {
          if (peer !== socket && peer.readyState === WebSocket.OPEN) peer.send(payload)
        }
        await crossInstancePublisher.publishCanvasUpdate({
          eventId: randomUUID(), sourceInstanceId: instanceId, projectId: context.projectId,
          update: event.update, actorId: context.userId,
          ...(context.actorName ? { actorName: context.actorName } : {}),
          graphRevision: result.graphRevision, updatedAt: result.updatedAt,
          ...(activity ? { activity } : {}),
        })
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

  const pruneRemotePresence = () => {
    const changedProjects = new Set()
    for (const [projectId, snapshots] of remotePresenceByProject) {
      for (const [sourceInstanceId, snapshot] of snapshots) {
        if (now() - snapshot.receivedAt > presenceTtlMs) {
          snapshots.delete(sourceInstanceId)
          changedProjects.add(projectId)
        }
      }
      if (!snapshots.size) remotePresenceByProject.delete(projectId)
    }
    changedProjects.forEach(broadcastPresence)
  }
  const presenceHeartbeat = setInterval(() => {
    pruneRemotePresence()
    for (const projectId of clientsByProject.keys()) void publishLocalPresence(projectId).catch(() => undefined)
  }, presenceHeartbeatMs)
  presenceHeartbeat.unref?.()

  return {
    async receiveCanvasUpdate(event) {
      if (!event || typeof event !== 'object' || event.sourceInstanceId === instanceId) return
      if (typeof event.eventId !== 'string' || !event.eventId.trim()
        || typeof event.sourceInstanceId !== 'string' || !event.sourceInstanceId.trim()
        || typeof event.projectId !== 'string' || !event.projectId.trim()
        || typeof event.update !== 'string' || !event.update
        || event.update.length > 700_000
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(event.update)
        || typeof event.actorId !== 'string' || !event.actorId.trim()) return
      // Redis 是跨实例传输层，不是权限边界；只接受仍具备项目编辑权的操作者。
      // 这样即使旧实例/恶意消息伪造 actorId，也不会把增量写入当前房间。
      try {
        if (!await productStore.canEditProject(event.actorId, event.projectId)) return
      } catch {
        return
      }
      const updateHash = createHash('sha256').update(event.update ?? '').digest('base64url')
      if (!rememberEvent(`event:${event.eventId}`) || !rememberEvent(`update:${event.projectId}:${updateHash}`)) return
      const roomPromise = roomsByProject.get(event.projectId)
      if (!roomPromise) return
      try {
        const entry = await roomPromise
        await entry.room.applyPersistedUpdate(event.update)
        entry.hasState = true
        const payload = JSON.stringify({
          type: 'canvas.crdt.update', projectId: event.projectId, update: event.update,
          actorId: event.actorId,
          ...(event.actorName ? { actorName: event.actorName } : {}),
          ...(event.activity ? { activity: { ...event.activity, unread: true } } : {}),
        })
        for (const socket of clientsByProject.get(event.projectId) ?? []) {
          if (socket.readyState === WebSocket.OPEN) socket.send(payload)
        }
      } catch {
        // 乱序/损坏的远端增量只能丢弃，不能让 Redis listener 的 Promise 拒绝进程。
      }
    },
    async receivePresence(event) {
      if (!event || typeof event !== 'object' || event.sourceInstanceId === instanceId) return
      if (typeof event.eventId !== 'string' || !event.eventId.trim()
        || typeof event.sourceInstanceId !== 'string' || !event.sourceInstanceId.trim()
        || typeof event.projectId !== 'string' || !event.projectId.trim()
        || !Array.isArray(event.members) || event.members.length > 1_000
        || !event.members.every((member) => member && typeof member === 'object'
          && typeof member.userId === 'string' && member.userId.trim()
          && Number.isInteger(member.connectionCount) && member.connectionCount > 0 && member.connectionCount <= 100)
        || !Number.isFinite(event.sentAt)
        || !rememberEvent(`presence:${event.eventId}`)) return
      try {
        const snapshots = remotePresenceByProject.get(event.projectId) ?? new Map()
        snapshots.set(event.sourceInstanceId, { members: structuredClone(event.members), receivedAt: now() })
        remotePresenceByProject.set(event.projectId, snapshots)
        broadcastPresence(event.projectId)
      } catch {
        // 损坏的跨实例 Presence 只能丢弃，不能让 Redis listener 的 Promise 拒绝。
      }
    },
    pruneRemotePresence,
    async publishProjectUpdated({ projectId, revision, graphRevision, updatedAt, graph, actorId }) {
      if (graph) {
        if (typeof actorId !== 'string' || !actorId.trim()) {
          throw new TypeError('画布项目更新缺少 actorId。')
        }
        const { room } = await collaborationRoom(actorId, projectId, { document: graph })
        await room.replaceBaseGraph(graph, actorId)
        scheduleRoomEviction(projectId)
      }
      const actorName = [...(clientsByProject.get(projectId) ?? [])]
        .find((client) => client.userId === actorId)?.actorName
      const payload = JSON.stringify({
        type: 'project.updated', projectId, revision, graphRevision, updatedAt,
        ...(actorId ? { actorId } : {}),
        ...(actorName ? { actorName } : {}),
      })
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
    publishCollaborationActivity({ projectId, activity }) {
      const payload = JSON.stringify({ type: 'collaboration.activity', projectId, activity: { ...activity, unread: true } })
      for (const socket of clientsByProject.get(projectId) ?? []) {
        if (socket.readyState === WebSocket.OPEN) socket.send(payload)
      }
    },
    async close() {
      closing = true
      clearInterval(heartbeat)
      clearInterval(presenceHeartbeat)
      for (const timer of roomIdleTimers.values()) clearTimeout(timer)
      roomIdleTimers.clear()
      server.off('upgrade', onUpgrade)
      for (const socket of webSocketServer.clients) socket.close(1001, 'server shutdown')
      await new Promise((resolve) => webSocketServer.close(resolve))
      for (const roomPromise of roomsByProject.values()) {
        try { await (await roomPromise).room.destroy() } catch { /* 已失败房间无需再次关闭。 */ }
      }
      roomsByProject.clear()
      remotePresenceByProject.clear()
      seenCrossInstanceEvents.clear()
    },
  }
}
