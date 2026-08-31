import type { Edge } from '@xyflow/react'
import type { CanvasNode } from '../domain/canvas'
import { createCollaborativeGraph, type CollaborativeGraph } from '../domain/collaborativeGraph'
import { deriveCanvasSyncStatus, type AgentRunUpdatedRealtimeEvent, type CanvasCrdtRealtimeEvent, type CanvasSyncStatus, type CollaborationActivityRealtimeEvent, type CollaborationPresenceRealtimeEvent, type ProjectRealtimeConnectionState, type ProjectUpdatedRealtimeEvent } from '../domain/realtimeSync'
import { createCanvasSyncOutbox } from './canvasSyncOutbox'
import { canvasSyncOutboxStorage, rememberAppliedCanvasGraphRevision, rememberRemoteSyncProtocolEpoch } from './db'
import { commitCanvasRealtimeUpdate, openProjectRealtimeChannel } from './projectRealtime'
import { ProductApiError } from './productSession'

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
  let blocked = false
  let pendingCount = 0
  let lastSyncStatus: CanvasSyncStatus | undefined
  let nackRetryCount = 0
  let nackRetryTimer: number | undefined
  const clientInstanceId = globalThis.crypto.randomUUID()
  const notifySyncStatus = () => {
    if (closed) return
    const status = deriveCanvasSyncStatus({ connectionState, handshakeReady, pendingCount, replaying, blocked })
    if (!status || status === lastSyncStatus) return
    lastSyncStatus = status
    onSyncStatusChanged?.(status)
  }
  const blockOnPermanentHttpFailure = (error: unknown) => {
    if (!(error instanceof ProductApiError)) return
    if (error.status === 404 || ['INVALID_CANVAS_SYNC_UPDATE', 'PROJECT_ACCESS_FORBIDDEN', 'PROJECT_WRITE_FORBIDDEN'].includes(error.code ?? '')) {
      blocked = true
      notifySyncStatus()
    }
  }
  const outbox = createCanvasSyncOutbox({
    projectId,
    storage: canvasSyncOutboxStorage,
    publish: (event) => syncProtocolEpoch === undefined
      ? false
      : channel?.publish({ ...event, syncProtocolEpoch }) ?? false,
    fallback: async (event) => {
      try {
        const committed = await commitCanvasRealtimeUpdate({ ...event, syncProtocolEpoch })
        rememberAppliedCanvasGraphRevision(projectId, committed.graphRevision)
        return committed
      } catch (error) {
        blockOnPermanentHttpFailure(error)
        throw error
      }
    },
    onPendingChanged: (count) => {
      pendingCount = count
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
          handshakeReady = true
          replayOutbox()
        }
        return
      }
      if (event.type === 'canvas.sync.ready.v2') {
        rememberAppliedCanvasGraphRevision(projectId, event.graphRevision)
        try {
          graph.applyRemoteUpdate(base64ToUpdate(event.updateBase64))
        } catch {
          // 损坏握手增量不得触发 Outbox 重放。
          return
        }
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
          publishHello()
          return
        }
        if (event.retryable) {
          replaying = false
          notifySyncStatus()
          scheduleNackRetry()
        } else {
          if (nackRetryTimer !== undefined) window.clearTimeout(nackRetryTimer)
          nackRetryTimer = undefined
          blocked = true
          replaying = false
          notifySyncStatus()
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
        blocked = false
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
      handshakeReady = false
      publishHello()
      notifySyncStatus()
    }, (state) => {
      connectionState = state
      if (state !== 'connected') {
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
    close() {
      closed = true
      if (nackRetryTimer !== undefined) window.clearTimeout(nackRetryTimer)
      channel?.close()
      graph.destroy()
    },
  }
}
