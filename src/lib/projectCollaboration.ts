import type { Edge } from '@xyflow/react'
import type { CanvasNode } from '../domain/canvas'
import { createCollaborativeGraph, type CollaborativeGraph } from '../domain/collaborativeGraph'
import { deriveCanvasSyncStatus, type AgentRunUpdatedRealtimeEvent, type CanvasCrdtRealtimeEvent, type CanvasSyncStatus, type CollaborationActivityRealtimeEvent, type CollaborationPresenceRealtimeEvent, type ProjectRealtimeConnectionState, type ProjectUpdatedRealtimeEvent } from '../domain/realtimeSync'
import { createCanvasSyncOutbox, type CanvasSyncFailure } from './canvasSyncOutbox'
import { canvasSyncOutboxStorage, lastKnownCanvasSyncProtocolEpoch, rememberAppliedCanvasGraphRevision, rememberRemoteSyncProtocolEpoch } from './db'
import { createCanvasHandshakeDeadline } from './canvasHandshakeDeadline'
import { commitCanvasRealtimeUpdate, openProjectRealtimeChannel } from './projectRealtime'
import { ProductApiError } from './productSession'
import { captureSentryMessage } from './sentry'

function updateToBase64(update: Uint8Array) {
  let binary = ''
  for (const byte of update) binary += String.fromCharCode(byte)
  return window.btoa(binary)
}

function base64ToUpdate(encoded: string) {
  const binary = window.atob(encoded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

export type CanvasCollaboration = {
  replaceLocalGraph: (graph: { nodes: CanvasNode[]; edges: Edge[] }) => void
  retryBlocked: () => Promise<void>
  close: () => void
}

/**
 * 组合 WebSocket 与 Yjs，但只暴露“替换本地图谱”这一条编辑接口。
 * 项目文档失效通知、CRDT 增量编码和断线重连均封装在模块内部。
 */
export function connectCanvasCollaboration({
  projectId,
  initialGraph,
  onRemoteGraph,
  onRemoteCanvasChanged,
  onProjectUpdated,
  onAgentRunUpdated,
  onPresenceChanged,
  onCollaborationActivity,
  onReconnected,
  onConnectionStateChanged,
  onSyncStatusChanged,
  onSyncProtocolEpochChanged,
}: {
  projectId: string
  initialGraph: CollaborativeGraph
  onRemoteGraph: (graph: CollaborativeGraph) => void
  onRemoteCanvasChanged?: (event: Pick<CanvasCrdtRealtimeEvent, 'actorId' | 'actorName' | 'activity'>) => void
  onProjectUpdated: (event: ProjectUpdatedRealtimeEvent) => void
  onAgentRunUpdated: (event: AgentRunUpdatedRealtimeEvent) => void
  onPresenceChanged?: (event: CollaborationPresenceRealtimeEvent) => void
  onCollaborationActivity?: (event: CollaborationActivityRealtimeEvent) => void
  onReconnected?: () => void
  onConnectionStateChanged?: (state: ProjectRealtimeConnectionState) => void
  onSyncStatusChanged?: (state: CanvasSyncStatus) => void
  onSyncProtocolEpochChanged?: (epoch: number) => void
}): CanvasCollaboration {
  let channel: ReturnType<typeof openProjectRealtimeChannel> | undefined
  let closed = false
  let reconnectPending = false
  let connectionState: ProjectRealtimeConnectionState = 'connecting'
  let handshakeReady = false
  let syncProtocolEpoch: number | undefined
  let replaying = false
  let pendingCount = 0
  let lastSyncStatus: CanvasSyncStatus | undefined
  let nackRetryCount = 0
  let nackRetryTimer: number | undefined
  let handshakeFailureReported = false
  let handshakeAttempts = 0
  let handshakeBlocked = false
  let outboxBlocked = false
  const maxHandshakeAttempts = 3
  const clientInstanceId = globalThis.crypto.randomUUID()
  const notifySyncStatus = () => {
    if (closed) return
    const status = deriveCanvasSyncStatus({ connectionState, handshakeReady, pendingCount, replaying, blocked: handshakeBlocked || outboxBlocked })
    if (!status || status === lastSyncStatus) return
    lastSyncStatus = status
    onSyncStatusChanged?.(status)
  }
  const recoverHandshake = () => {
    if (closed || handshakeReady) return
    if (!handshakeFailureReported) {
      handshakeFailureReported = true
      captureSentryMessage('canvas_sync.handshake_timeout', {
        component: 'canvas-sync',
        tags: { operation: 'handshake', client_instance_id: clientInstanceId },
      })
    }
    if (handshakeAttempts >= maxHandshakeAttempts) {
      handshakeBlocked = true
      channel?.suspend()
      notifySyncStatus()
      return
    }
    channel?.restart()
  }
  const handshakeDeadline = createCanvasHandshakeDeadline(recoverHandshake)
  const permanentHttpFailure = (error: unknown): CanvasSyncFailure | undefined => {
    if (!(error instanceof ProductApiError)) return
    const code = error.code ?? (error.status === 404 ? 'PROJECT_NOT_FOUND' : '')
    if (!['PROJECT_NOT_FOUND', 'INVALID_CANVAS_SYNC_UPDATE', 'CANVAS_MUTATION_CONFLICT', 'PROJECT_ACCESS_FORBIDDEN', 'PROJECT_WRITE_FORBIDDEN'].includes(code)) return
    return { code, status: error.status }
  }
  const outbox = createCanvasSyncOutbox({
    projectId,
    storage: canvasSyncOutboxStorage,
    // 权威快照握手（ready.v2 / 旧协议 ready）完成前一律不发包：此时重放本地
    // Y.Doc/Outbox 旧几何会覆盖服务端权威布局。HTTP fallback 同受此门禁。
    sendReady: () => handshakeReady,
    expectedEpoch: () => syncProtocolEpoch ?? lastKnownCanvasSyncProtocolEpoch(projectId),
    publish: (event) => syncProtocolEpoch === undefined
      ? false
      : channel?.publish({ ...event, syncProtocolEpoch }) ?? false,
    fallback: async (event) => {
      const committed = await commitCanvasRealtimeUpdate({ ...event, syncProtocolEpoch })
      rememberAppliedCanvasGraphRevision(projectId, committed.graphRevision)
      return committed
    },
    classifyPermanentFailure: permanentHttpFailure,
    onPendingChanged: (count, blockedFailure) => {
      pendingCount = count
      outboxBlocked = Boolean(blockedFailure)
      if (count === 0) {
        if (nackRetryTimer !== undefined) window.clearTimeout(nackRetryTimer)
        nackRetryTimer = undefined
        nackRetryCount = 0
      }
      notifySyncStatus()
    },
  })
  const graph = createCollaborativeGraph({
    initialGraph,
    onUpdate(update) {
      void outbox.enqueue(updateToBase64(update)).catch(() => undefined)
    },
    onRemoteGraph,
  })
  const publishHello = () => channel?.publish({
    type: 'canvas.sync.hello.v2',
    protocol: 2,
    projectId,
    schemaVersion: 2,
    clientInstanceId,
    stateVectorBase64: updateToBase64(graph.stateVector()),
  }) ?? false
  const beginHandshake = () => {
    handshakeReady = false
    handshakeAttempts += 1
    if (publishHello()) handshakeDeadline.arm()
    else recoverHandshake()
    notifySyncStatus()
  }
  const replayOutbox = () => {
    const recoverAfterReplay = reconnectPending
    reconnectPending = false
    replaying = true
    notifySyncStatus()
    void outbox.flush().then(() => {
      if (recoverAfterReplay && !closed) onReconnected?.()
    }).catch(() => undefined).finally(() => {
      replaying = false
      notifySyncStatus()
    })
  }
  const scheduleNackRetry = () => {
    if (closed || nackRetryTimer !== undefined) return
    const delay = Math.min(15_000, 1_000 * (2 ** Math.min(nackRetryCount, 4)))
    nackRetryCount += 1
    nackRetryTimer = window.setTimeout(() => {
      nackRetryTimer = undefined
      if (!closed) replayOutbox()
    }, delay)
  }
  const openChannel = () => {
    channel = openProjectRealtimeChannel(projectId, (event) => {
      if (event.type === 'realtime.ready') {
        if (event.protocol !== 2) {
          handshakeDeadline.clear()
          handshakeAttempts = 0
          handshakeBlocked = false
          handshakeReady = true
          replayOutbox()
        }
        return
      }
      if (event.type === 'canvas.sync.ready.v2') {
        try {
          graph.applyRemoteUpdate(base64ToUpdate(event.updateBase64))
        } catch {
          // 损坏握手增量不得触发 Outbox 重放。
          if (!handshakeFailureReported) {
            handshakeFailureReported = true
            captureSentryMessage('canvas_sync.invalid_ready', {
              component: 'canvas-sync',
              tags: { operation: 'handshake', client_instance_id: clientInstanceId },
            })
          }
          recoverHandshake()
          return
        }
        handshakeDeadline.clear()
        handshakeFailureReported = false
        handshakeAttempts = 0
        handshakeBlocked = false
        rememberAppliedCanvasGraphRevision(projectId, event.graphRevision)
        syncProtocolEpoch = event.syncProtocolEpoch ?? 1
        rememberRemoteSyncProtocolEpoch(projectId, syncProtocolEpoch)
        onSyncProtocolEpochChanged?.(syncProtocolEpoch)
        handshakeReady = true
        replayOutbox()
        return
      }
      if (event.type === 'canvas.graph.nack.v2') {
        if (event.code === 'EPOCH_STALE') {
          syncProtocolEpoch = event.syncProtocolEpoch
          if (syncProtocolEpoch !== undefined) {
            rememberRemoteSyncProtocolEpoch(projectId, syncProtocolEpoch)
            onSyncProtocolEpochChanged?.(syncProtocolEpoch)
          }
          handshakeReady = false
          replaying = true
          notifySyncStatus()
          beginHandshake()
          return
        }
        if (event.retryable) {
          replaying = false
          notifySyncStatus()
          scheduleNackRetry()
        } else {
          if (nackRetryTimer !== undefined) window.clearTimeout(nackRetryTimer)
          nackRetryTimer = undefined
          replaying = false
          notifySyncStatus()
          void outbox.block(event.mutationId, { code: event.code }).catch(() => undefined)
        }
        return
      }
      if (event.type === 'project.updated') {
        onProjectUpdated(event)
        return
      }
      if (event.type === 'agent.run.updated') {
        onAgentRunUpdated(event)
        return
      }
      if (event.type === 'collaboration.presence') {
        onPresenceChanged?.(event)
        return
      }
      if (event.type === 'collaboration.activity') {
        onCollaborationActivity?.(event)
        return
      }
      if (event.type === 'canvas.crdt.committed') {
        rememberAppliedCanvasGraphRevision(projectId, event.graphRevision)
        void outbox.ack(event.mutationId).catch(() => undefined)
        return
      }
      try {
        graph.applyRemoteUpdate(base64ToUpdate(event.update))
        onRemoteCanvasChanged?.({ actorId: event.actorId, actorName: event.actorName, activity: event.activity })
      } catch {
        // 损坏增量不影响 HTTP 权威文档与后续实时消息。
      }
    }, ({ reconnected }) => {
      reconnectPending = reconnected
      beginHandshake()
    }, (state) => {
      connectionState = state
      if (state !== 'connected') {
        handshakeDeadline.clear()
        handshakeReady = false
        syncProtocolEpoch = undefined
        replaying = false
      }
      onConnectionStateChanged?.(state)
      notifySyncStatus()
    })
  }

  void outbox.pendingUpdates().then((updates) => {
    if (closed) return
    for (const update of updates) graph.applyRemoteUpdate(base64ToUpdate(update))
    if (!closed) openChannel()
  }).catch(() => {
    if (!closed) onConnectionStateChanged?.('closed')
  })

  return {
    replaceLocalGraph: graph.replaceLocalGraph,
    retryBlocked: async () => {
      const shouldResumeHandshake = handshakeBlocked
      if (shouldResumeHandshake) {
        handshakeBlocked = false
        handshakeAttempts = 0
        handshakeFailureReported = false
        channel?.resume()
        notifySyncStatus()
      }
      await outbox.retryBlocked()
    },
    close() {
      closed = true
      handshakeDeadline.clear()
      if (nackRetryTimer !== undefined) window.clearTimeout(nackRetryTimer)
      channel?.close()
      graph.destroy()
    },
  }
}
