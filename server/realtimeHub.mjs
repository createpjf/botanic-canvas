import { createHash, randomUUID } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import { createCanvasCollaborationRoom } from './canvas/canvasCollaborationRoom.mjs'
import { verifyRealtimeTicket } from './realtimeTicket.mjs'
import { collaborationChangeFromDocuments } from './collaborationActivityPersistence.mjs'
import { canvasMutationConflictCode, canvasSyncEpochStaleError } from './store/productStoreContract.mjs'

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
  reportError = () => {},
}) {
  if (!server || !productStore || !ticketSecret) throw new TypeError('实时服务配置不完整。')
  const webSocketServer = new WebSocketServer({ noServer: true })
  const clientsByProject = new Map()
  const roomsByProject = new Map()
  const roomIdleTimers = new Map()
  const remotePresenceByProject = new Map()
  const seenCrossInstanceEvents = new Map()
  let closing = false

  const sendCanvasNack = (socket, context, mutationId, code, retryable, detail = {}) => {
    if (context.canvasSyncProtocol !== 2
      || socket.readyState !== WebSocket.OPEN
      || typeof mutationId !== 'string'
      || !/^[A-Za-z0-9._:-]{1,200}$/.test(mutationId)) return
    socket.send(JSON.stringify({
      type: 'canvas.graph.nack.v2',
      protocol: 2,
      projectId: context.projectId,
      mutationId,
      code,
      retryable,
      ...detail,
    }))
  }

  const canvasSyncProtocolEpoch = async (userId, projectId) => {
    const epoch = await productStore.readCanvasSyncProtocolEpoch?.(userId, projectId)
    return Number.isInteger(epoch) && epoch > 0 ? epoch : 1
  }

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
          reload: async (actorId) => productStore.loadCanvasCollaboration?.(actorId, projectId) ?? state,
          append: async (payload, actorId) => {
            const saved = await productStore.appendCanvasGraphUpdate?.(actorId, projectId, payload)
              ?? {
                graphRevision: state.graphRevision,
                mutationRevision: state.graphRevision,
                updatedAt: Date.now(),
                updateCount: 0,
                duplicate: false,
              }
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

  const publishCanvasRepair = async ({ projectId, update, mutationId, actorId, graphRevision, updatedAt, sourceSocket }) => {
    const payload = JSON.stringify({ type: 'canvas.crdt.update', projectId, update, mutationId })
    for (const socket of clientsByProject.get(projectId) ?? []) {
      // mutationId 与该增量哈希绑定；发起端已经持有同一增量，只修复其他副本。
      if (socket !== sourceSocket && socket.readyState === WebSocket.OPEN) socket.send(payload)
    }
    try {
      await crossInstancePublisher.publishCanvasUpdate({
        eventId: randomUUID(), sourceInstanceId: instanceId, projectId,
        update, mutationId, actorId, graphRevision, updatedAt, duplicate: true,
      })
    } catch {
      // 本实例已从权威存储恢复；其他实例仍可在下一次重试/握手时收敛。
    }
  }

  const commitCanvasUpdate = async ({ projectId, userId, actorName, mutationId, update, syncProtocolEpoch, roomEntry, sourceSocket }) => {
    const currentSyncProtocolEpoch = await canvasSyncProtocolEpoch(userId, projectId)
    if (currentSyncProtocolEpoch >= 2 && syncProtocolEpoch !== currentSyncProtocolEpoch) {
      const failure = new Error('画布同步协议版本已前进，请重新握手。')
      failure.code = 'CANVAS_SYNC_EPOCH_STALE'
      failure.syncProtocolEpoch = currentSyncProtocolEpoch
      throw failure
    }
    let entry = roomEntry
    if (!entry) {
      const project = await productStore.readProject(userId, projectId)
      if (!project) {
        const failure = new Error('未找到项目或你没有访问权限。')
        failure.code = 'PROJECT_NOT_FOUND'
        throw failure
      }
      entry = await collaborationRoom(userId, projectId, project)
    }
    const result = await entry.room.applyUpdate(update, userId, { mutationId, syncProtocolEpoch })
    const committed = {
      type: 'canvas.crdt.committed',
      projectId,
      mutationId,
      graphRevision: result.graphRevision,
      mutationRevision: result.mutationRevision ?? result.graphRevision,
      updatedAt: result.updatedAt,
    }
    scheduleRoomEviction(projectId)
    if (result.duplicate) {
      if (result.update) {
        await publishCanvasRepair({
          projectId, update: result.update, mutationId, actorId: userId,
          graphRevision: result.graphRevision, updatedAt: result.updatedAt, sourceSocket,
        })
      }
      return committed
    }
    if (!result.applied) return committed

    const change = collaborationChangeFromDocuments(result.previousGraph, result.graph) ?? { kind: 'canvas', summary: '更新了画布内容' }
    let activity
    try {
      activity = await productStore.putCollaborationActivity(userId, projectId, {
        id: `canvas-${userId}-${result.graphRevision}`,
        ...change,
      })
    } catch {
      // 历史索引是派生读模型；失败不影响已提交的图谱增量。
    }
    const committedUpdate = result.update ?? update
    const payload = JSON.stringify({
      type: 'canvas.crdt.update', projectId, update: committedUpdate, mutationId, actorId: userId,
      ...(actorName ? { actorName } : {}),
      ...(activity ? { activity: { ...activity, unread: true } } : {}),
    })
    for (const peer of clientsByProject.get(projectId) ?? []) {
      if (peer !== sourceSocket && peer.readyState === WebSocket.OPEN) peer.send(payload)
    }
    try {
      await crossInstancePublisher.publishCanvasUpdate({
        eventId: randomUUID(), sourceInstanceId: instanceId, projectId,
        update: committedUpdate, mutationId, actorId: userId,
        ...(actorName ? { actorName } : {}),
        graphRevision: result.graphRevision, updatedAt: result.updatedAt,
        ...(activity ? { activity } : {}),
      })
    } catch {
      // 跨实例广播是加速器；数据库提交已完成，不能因此扣留 durable ACK。
    }
    return committed
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
        if (context.canvasSyncProtocol === 2
          && event?.type === 'canvas.sync.hello.v2'
          && event.protocol === 2
          && event.schemaVersion === 2
          && event.projectId === context.projectId
          && typeof event.clientInstanceId === 'string'
          && /^[A-Za-z0-9._:-]{1,200}$/.test(event.clientInstanceId)
          && typeof event.stateVectorBase64 === 'string'
          && event.stateVectorBase64.length > 0
          && event.stateVectorBase64.length <= 700_000
          && /^[A-Za-z0-9+/]*={0,2}$/.test(event.stateVectorBase64)
          && (event.lastAckedGraphRevision === undefined
            || (Number.isInteger(event.lastAckedGraphRevision) && event.lastAckedGraphRevision > 0))) {
          try {
            await context.roomEntry.room.reloadPersistedState(context.userId)
            context.roomEntry.hasState = true
            const syncProtocolEpoch = await canvasSyncProtocolEpoch(context.userId, context.projectId)
            const synchronized = await context.roomEntry.room.syncState(event.stateVectorBase64)
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({
                type: 'canvas.sync.ready.v2',
                protocol: 2,
                projectId: context.projectId,
                schemaVersion: 2,
                syncProtocolEpoch,
                graphRevision: synchronized.graphRevision,
                updateBase64: synchronized.update,
              }))
            }
          } catch (caught) {
            if (socket.readyState === WebSocket.OPEN) socket.close(1013, 'canvas sync unavailable')
            try {
              reportError(caught, {
                level: 'warning',
                tags: { component: 'realtime', operation: 'handshake' },
                contexts: { canvas_sync: { projectId: context.projectId, clientInstanceId: event.clientInstanceId } },
              })
            } catch { /* 错误上报不得阻断连接恢复。 */ }
            console.error(JSON.stringify({
              event: 'canvas_sync.handshake_failed',
              projectId: context.projectId,
              clientInstanceId: event.clientInstanceId,
            }))
          }
          return
        }
        if (context.canvasSyncProtocol === 2 && event?.type === 'canvas.sync.hello.v2') {
          socket.close(1008, 'invalid canvas sync hello')
          return
        }
        if (event?.type === 'canvas.crdt.update' && event.projectId === context.projectId) {
          let canEdit = context.canEdit
          try {
            if (canEdit) canEdit = await productStore.canEditProject(context.userId, context.projectId)
          } catch {
            sendCanvasNack(socket, context, event.mutationId, 'TEMPORARY_UNAVAILABLE', true)
            return
          }
          if (!canEdit) {
            sendCanvasNack(socket, context, event.mutationId, 'PERMISSION_REVOKED', false)
            return
          }
        }
        if (!context.canEdit) return
        if (event?.type !== 'canvas.crdt.update'
          || event.projectId !== context.projectId
          || typeof event.update !== 'string'
          || !event.update
          || event.update.length > 700_000
          || !/^[A-Za-z0-9+/]*={0,2}$/.test(event.update)
          || (event.mutationId !== undefined
            && (typeof event.mutationId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(event.mutationId)))
          || (event.syncProtocolEpoch !== undefined
            && (!Number.isInteger(event.syncProtocolEpoch) || event.syncProtocolEpoch < 1))) {
          sendCanvasNack(socket, context, event?.mutationId, 'INVALID_UPDATE', false)
          return
        }
        const mutationId = event.mutationId
          ?? `legacy:${createHash('sha256').update(event.update).digest('base64url')}`
        let committed
        try {
          committed = await commitCanvasUpdate({
            projectId: context.projectId,
            userId: context.userId,
            actorName: context.actorName,
            mutationId,
            update: event.update,
            syncProtocolEpoch: event.syncProtocolEpoch,
            roomEntry: context.roomEntry,
            sourceSocket: socket,
          })
        } catch (error) {
          const code = error?.code === 'CANVAS_SYNC_EPOCH_STALE'
            ? 'EPOCH_STALE'
            : error?.code === canvasMutationConflictCode
              ? 'INVALID_UPDATE'
              : error?.code === 'PROJECT_NOT_FOUND'
                ? 'PROJECT_DELETED'
                : error?.code === 'PROJECT_ACCESS_FORBIDDEN' || error?.code === 'PROJECT_WRITE_FORBIDDEN'
                  ? 'PERMISSION_REVOKED'
                  : error instanceof TypeError
                    ? 'INVALID_UPDATE'
                    : 'TEMPORARY_UNAVAILABLE'
          sendCanvasNack(socket, context, mutationId, code, code === 'TEMPORARY_UNAVAILABLE' || code === 'EPOCH_STALE',
            code === 'EPOCH_STALE' ? { syncProtocolEpoch: error.syncProtocolEpoch } : undefined)
          return
        }
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(committed))
        }
      } catch {
        // 未知消息不影响项目失效通知；权威文档仍由 HTTP 接口负责。
      }
    })
    socket.send(JSON.stringify({
      type: 'realtime.ready',
      projectId: context.projectId,
      ...(context.canvasSyncProtocol === 2 ? { protocol: 2 } : {}),
    }))
    if (context.canvasSyncProtocol !== 2 && context.roomEntry.hasState) {
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
      const canvasSyncProtocol = url.searchParams.get('protocol') === '2' ? 2 : 1
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
        webSocketServer.emit('connection', client, request, { ...authorized, canEdit, roomEntry, canvasSyncProtocol })
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
    commitCanvasUpdate: (input) => commitCanvasUpdate(input),
    async receiveCanvasUpdate(event) {
      if (!event || typeof event !== 'object' || event.sourceInstanceId === instanceId) return
      if (typeof event.eventId !== 'string' || !event.eventId.trim()
        || typeof event.sourceInstanceId !== 'string' || !event.sourceInstanceId.trim()
        || typeof event.projectId !== 'string' || !event.projectId.trim()
        || typeof event.update !== 'string' || !event.update
        || event.update.length > 700_000
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(event.update)
        || (event.mutationId !== undefined
          && (typeof event.mutationId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(event.mutationId)))
        || (event.duplicate !== undefined && typeof event.duplicate !== 'boolean')
        || typeof event.actorId !== 'string' || !event.actorId.trim()) return
      // Redis 是跨实例传输层，不是权限边界；只接受仍具备项目编辑权的操作者。
      // 这样即使旧实例/恶意消息伪造 actorId，也不会把增量写入当前房间。
      try {
        if (!await productStore.canEditProject(event.actorId, event.projectId)) return
      } catch {
        return
      }
      const updateHash = createHash('sha256').update(event.update ?? '').digest('base64url')
      const updateIdentity = event.mutationId ? `mutation:${event.mutationId}` : `hash:${updateHash}`
      const freshEvent = rememberEvent(`event:${event.eventId}`)
      const freshUpdate = rememberEvent(`update:${event.projectId}:${updateIdentity}`)
      if (!freshEvent || (!event.duplicate && !freshUpdate)) return
      const roomPromise = roomsByProject.get(event.projectId)
      if (!roomPromise) return
      try {
        const entry = await roomPromise
        await entry.room.reloadPersistedState(event.actorId)
        entry.hasState = true
        const payload = JSON.stringify({
          type: 'canvas.crdt.update', projectId: event.projectId,
          update: event.update,
          ...(event.mutationId ? { mutationId: event.mutationId } : {}),
          ...(!event.duplicate ? { actorId: event.actorId } : {}),
          ...(!event.duplicate && event.actorName ? { actorName: event.actorName } : {}),
          ...(!event.duplicate && event.activity ? { activity: { ...event.activity, unread: true } } : {}),
        })
        for (const socket of clientsByProject.get(event.projectId) ?? []) {
          if (socket.readyState === WebSocket.OPEN) socket.send(payload)
        }
      } catch {
        // 乱序/损坏的远端增量只能丢弃，不能让 Redis listener 的 Promise 拒绝进程。
      }
    },
    async publishCanvasGraphCommitted({ projectId, update, mutationId, actorId, graphRevision, updatedAt, duplicate }) {
      const roomPromise = roomsByProject.get(projectId)
      let roomEntry
      if (roomPromise) {
        roomEntry = await roomPromise
        await roomEntry.room.reloadPersistedState(actorId)
        roomEntry.hasState = true
        scheduleRoomEviction(projectId)
      }
      if (duplicate) {
        await publishCanvasRepair({ projectId, update, mutationId, actorId, graphRevision, updatedAt })
        return
      }
      const actorName = [...(clientsByProject.get(projectId) ?? [])]
        .find((client) => client.userId === actorId)?.actorName
      const payload = JSON.stringify({
        type: 'canvas.crdt.update', projectId, update, mutationId, actorId,
        ...(actorName ? { actorName } : {}),
      })
      for (const socket of clientsByProject.get(projectId) ?? []) {
        if (socket.readyState === WebSocket.OPEN) socket.send(payload)
      }
      try {
        await crossInstancePublisher.publishCanvasUpdate({
          eventId: randomUUID(), sourceInstanceId: instanceId, projectId,
          update, mutationId, actorId,
          ...(actorName ? { actorName } : {}),
          graphRevision, updatedAt,
        })
      } catch {
        // 本实例已从权威存储重载；跨实例将在下次握手/聚焦时恢复。
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
        // Epoch 2 的 graph 只能来自 durable mutation；整图替换仅保留给尚未迁移的
        // Epoch 1 浏览器，避免旧 project.updated 把新 Yjs 日志覆盖回去。
        const syncProtocolEpoch = await canvasSyncProtocolEpoch(actorId, projectId)
        if (syncProtocolEpoch >= 2) throw canvasSyncEpochStaleError(syncProtocolEpoch)
        if (syncProtocolEpoch < 2) {
          const { room } = await collaborationRoom(actorId, projectId, { document: graph })
          await room.replaceBaseGraph(graph, actorId, graphRevision)
          scheduleRoomEviction(projectId)
        }
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
      const forceClose = setTimeout(() => {
        for (const socket of webSocketServer.clients) socket.terminate()
      }, 5_000)
      forceClose.unref?.()
      await new Promise((resolve) => webSocketServer.close(resolve))
      clearTimeout(forceClose)
      for (const roomPromise of roomsByProject.values()) {
        try { await (await roomPromise).room.destroy() } catch { /* 已失败房间无需再次关闭。 */ }
      }
      roomsByProject.clear()
      remotePresenceByProject.clear()
      seenCrossInstanceEvents.clear()
    },
  }
}
