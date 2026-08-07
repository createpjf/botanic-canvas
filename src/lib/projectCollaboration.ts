import type { Edge } from '@xyflow/react'
import type { CanvasNode } from '../domain/canvas'
import { createCollaborativeGraph, type CollaborativeGraph } from '../domain/collaborativeGraph'
import type { AgentRunUpdatedRealtimeEvent, CanvasCrdtRealtimeEvent, CollaborationPresenceRealtimeEvent, ProjectUpdatedRealtimeEvent } from '../domain/realtimeSync'
import { openProjectRealtimeChannel } from './projectRealtime'

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
  onReconnected,
}: {
  projectId: string
  initialGraph: CollaborativeGraph
  onRemoteGraph: (graph: CollaborativeGraph) => void
  onRemoteCanvasChanged?: (event: Pick<CanvasCrdtRealtimeEvent, 'actorId' | 'actorName' | 'activity'>) => void
  onProjectUpdated: (event: ProjectUpdatedRealtimeEvent) => void
  onAgentRunUpdated: (event: AgentRunUpdatedRealtimeEvent) => void
  onPresenceChanged?: (event: CollaborationPresenceRealtimeEvent) => void
  onReconnected?: () => void
}): CanvasCollaboration {
  let channel: ReturnType<typeof openProjectRealtimeChannel> | undefined
  const graph = createCollaborativeGraph({
    initialGraph,
    onUpdate(update) {
      channel?.publish({
        type: 'canvas.crdt.update',
        projectId,
        update: updateToBase64(update),
      })
    },
    onRemoteGraph,
  })
  channel = openProjectRealtimeChannel(projectId, (event) => {
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
    try {
      graph.applyRemoteUpdate(base64ToUpdate(event.update))
      onRemoteCanvasChanged?.({ actorId: event.actorId, actorName: event.actorName, activity: event.activity })
    } catch {
      // 损坏增量不影响 HTTP 权威文档与后续实时消息。
    }
  }, ({ reconnected }) => {
    if (reconnected) onReconnected?.()
  })

  return {
    replaceLocalGraph: graph.replaceLocalGraph,
    close() {
      channel?.close()
      graph.destroy()
    },
  }
}
