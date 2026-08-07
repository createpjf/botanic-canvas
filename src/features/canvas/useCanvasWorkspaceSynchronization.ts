import { useCallback, useEffect, useRef, useState } from 'react'
import { shouldRecoverAgentRunResults, shouldResumeQueuedAgentRunExecution } from '../../domain/agent'
import { shouldRefreshFromRealtimeEvent } from '../../domain/realtimeSync'
import { executePersistentBotanicAgentRun, listPersistentBotanicAgentRuns } from '../../lib/agentApi'
import { flushPendingCanvasDocumentWrites, refreshCanvasDocumentFromRemote, syncPendingCanvasDrafts } from '../../lib/db'
import { connectCanvasCollaboration, type CanvasCollaboration } from '../../lib/projectCollaboration'
import { serverPersistenceEnabled } from '../../lib/productSession'
import { useCanvasStore } from '../../store/canvasStore'

type CanvasWorkspaceSynchronizationOptions = {
  workspaceActive: boolean
  currentUserId?: string
}

export type CollaborationAwareness = {
  onlineCollaboratorCount: number
  lastRemoteChangeAt?: number
}

/**
 * 画布工作区的远端同步、协作连接与 Agent Run 恢复协调器。
 * UI 只消费重试入口，不直接组合网络恢复时序。
 */
export function useCanvasWorkspaceSynchronization({ workspaceActive, currentUserId }: CanvasWorkspaceSynchronizationOptions) {
  const documentId = useCanvasStore((state) => state.document.id)
  const nodes = useCanvasStore((state) => state.document.nodes)
  const edges = useCanvasStore((state) => state.document.edges)
  const agentRuns = useCanvasStore((state) => state.document.agentRuns)
  const hydrated = useCanvasStore((state) => state.hydrated)
  const hydrate = useCanvasStore((state) => state.hydrate)
  const openDocument = useCanvasStore((state) => state.openDocument)
  const refreshDocumentFromRemote = useCanvasStore((state) => state.refreshDocumentFromRemote)
  const recoverGenerationResultsFromRemote = useCanvasStore((state) => state.recoverGenerationResultsFromRemote)
  const recoverUnknownGenerationSubmission = useCanvasStore((state) => state.recoverUnknownGenerationSubmission)
  const applyCollaborativeGraph = useCanvasStore((state) => state.applyCollaborativeGraph)
  const applyAgentRunSnapshot = useCanvasStore((state) => state.applyAgentRunSnapshot)
  const [canvasHydrationFailed, setCanvasHydrationFailed] = useState(false)
  const [collaborationAwareness, setCollaborationAwareness] = useState<CollaborationAwareness>({ onlineCollaboratorCount: 0 })
  const collaborationRef = useRef<CanvasCollaboration | null>(null)

  const markRemoteChange = useCallback((actorId?: string) => {
    if (!actorId || actorId === currentUserId) return
    setCollaborationAwareness((current) => ({ ...current, lastRemoteChangeAt: Date.now() }))
  }, [currentUserId])

  const dismissRemoteChange = useCallback(() => {
    setCollaborationAwareness((current) => ({ ...current, lastRemoteChangeAt: undefined }))
  }, [])

  const hydrateCanvas = useCallback(() => {
    setCanvasHydrationFailed(false)
    void hydrate().catch(() => setCanvasHydrationFailed(true))
  }, [hydrate])

  const synchronizeLocalDrafts = useCallback(async () => {
    const result = await syncPendingCanvasDrafts()
    const current = useCanvasStore.getState()
    if (result.conflictIds.includes(current.document.id)) {
      const projectId = current.document.id
      const opened = await openDocument(projectId)
      if (opened && useCanvasStore.getState().document.id === projectId) {
        useCanvasStore.setState({ persistenceStatus: 'saved', assistantMessage: '画布已同步。' })
      }
      return result
    }
    if (result.pending === 0 && (current.persistenceStatus === 'offline' || current.persistenceStatus === 'error')) {
      useCanvasStore.setState({ persistenceStatus: 'saved', assistantMessage: '本地草稿已同步。' })
    }
    return result
  }, [openDocument])

  const retryAgentCanvasPersistence = useCallback(async () => {
    const projectId = useCanvasStore.getState().document.id
    try {
      const result = await syncPendingCanvasDrafts()
      const current = useCanvasStore.getState()
      if (current.document.id !== projectId || result.conflictIds.includes(projectId)) return false
      if (result.pending === 0 && (current.persistenceStatus === 'offline' || current.persistenceStatus === 'error')) {
        useCanvasStore.setState({ persistenceStatus: 'saved', assistantMessage: '本地草稿已同步。' })
      }
      return result.pending === 0
    } catch {
      return false
    }
  }, [])

  const refreshAgentCanvasFromRemote = useCallback(async () => {
    const projectId = useCanvasStore.getState().document.id
    if (projectId === 'workspace-placeholder') return false
    const remote = await refreshCanvasDocumentFromRemote(projectId)
    if (!remote || useCanvasStore.getState().document.id !== projectId) return false
    const opened = await openDocument(projectId)
    if (opened && useCanvasStore.getState().document.id === projectId) {
      useCanvasStore.setState({ persistenceStatus: 'saved', assistantMessage: '已切换到云端版本。' })
    }
    return opened
  }, [openDocument])

  const recoverPersistentAgentRuns = useCallback(async () => {
    const projectId = useCanvasStore.getState().document.id
    const runs = await listPersistentBotanicAgentRuns(projectId)
    if (useCanvasStore.getState().document.id !== projectId) return
    let shouldRecoverResults = false
    for (const persistedRun of runs) {
      let run = persistedRun
      if (shouldResumeQueuedAgentRunExecution(run)) {
        // execute 使用 runId 稳定幂等键；多设备同时恢复也不会创建重复任务。
        try {
          run = (await executePersistentBotanicAgentRun(projectId, run.id)).run
        } catch {
          // 保留 queued 快照，下一轮轮询或重连再自动确认。
        }
      }
      const current = useCanvasStore.getState().document.agentRuns.find((candidate) => candidate.id === run.id)
      if (shouldRecoverAgentRunResults(current, run)) shouldRecoverResults = true
      applyAgentRunSnapshot(run)
    }
    if (shouldRecoverResults) await recoverGenerationResultsFromRemote()
  }, [applyAgentRunSnapshot, recoverGenerationResultsFromRemote])

  useEffect(() => {
    hydrateCanvas()
  }, [hydrateCanvas])

  useEffect(() => {
    const flushPendingWrites = () => { void flushPendingCanvasDocumentWrites().catch(() => undefined) }
    window.addEventListener('pagehide', flushPendingWrites)
    return () => window.removeEventListener('pagehide', flushPendingWrites)
  }, [])

  useEffect(() => {
    if (!hydrated || !serverPersistenceEnabled) return
    const syncDrafts = () => {
      void synchronizeLocalDrafts()
        .then(() => refreshDocumentFromRemote())
        .then(() => recoverUnknownGenerationSubmission())
        .then(() => recoverPersistentAgentRuns())
        .catch(() => undefined)
    }
    syncDrafts()
    window.addEventListener('online', syncDrafts)
    return () => window.removeEventListener('online', syncDrafts)
  }, [hydrated, recoverPersistentAgentRuns, recoverUnknownGenerationSubmission, refreshDocumentFromRemote, synchronizeLocalDrafts])

  useEffect(() => {
    if (!hydrated || !workspaceActive || !serverPersistenceEnabled) return
    const refresh = () => {
      void refreshDocumentFromRemote()
        .then(() => recoverUnknownGenerationSubmission())
        .then(() => recoverPersistentAgentRuns())
        .catch(() => undefined)
    }
    const refreshWhenVisible = () => {
      if (window.document.visibilityState === 'visible') refresh()
    }
    window.addEventListener('focus', refresh)
    window.document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      window.removeEventListener('focus', refresh)
      window.document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [hydrated, recoverPersistentAgentRuns, recoverUnknownGenerationSubmission, refreshDocumentFromRemote, workspaceActive])

  useEffect(() => {
    if (!hydrated || !workspaceActive || !serverPersistenceEnabled) return
    const current = useCanvasStore.getState().document
    const collaboration = connectCanvasCollaboration({
      projectId: current.id,
      initialGraph: { nodes: current.nodes, edges: current.edges },
      onRemoteGraph: applyCollaborativeGraph,
      onRemoteCanvasChanged: ({ actorId }) => markRemoteChange(actorId),
      onProjectUpdated: (event) => {
        const latest = useCanvasStore.getState().document
        if (!shouldRefreshFromRealtimeEvent({
          event,
          currentProjectId: latest.id,
          currentUpdatedAt: latest.updatedAt,
        })) return
        markRemoteChange(event.actorId)
        void refreshDocumentFromRemote().catch(() => undefined)
      },
      onAgentRunUpdated: (event) => {
        applyAgentRunSnapshot(event.run)
        const terminal = event.run.branches.every((branch) => ['succeeded', 'failed', 'cancelled'].includes(branch.status))
        if (terminal) {
          void recoverGenerationResultsFromRemote()
            .then(() => refreshDocumentFromRemote())
            .catch(() => undefined)
        }
      },
      onPresenceChanged: (event) => {
        setCollaborationAwareness((current) => ({
          ...current,
          onlineCollaboratorCount: event.members.filter((member) => member.userId !== currentUserId).length,
        }))
      },
      onReconnected: () => {
        void synchronizeLocalDrafts()
          .then(() => recoverUnknownGenerationSubmission())
          .then(() => recoverPersistentAgentRuns())
          .then(() => refreshDocumentFromRemote())
          .catch(() => undefined)
      },
    })
    collaborationRef.current = collaboration
    return () => {
      if (collaborationRef.current === collaboration) collaborationRef.current = null
      collaboration.close()
    }
  }, [applyAgentRunSnapshot, applyCollaborativeGraph, currentUserId, documentId, hydrated, markRemoteChange, recoverGenerationResultsFromRemote, recoverPersistentAgentRuns, recoverUnknownGenerationSubmission, refreshDocumentFromRemote, synchronizeLocalDrafts, workspaceActive])

  useEffect(() => {
    setCollaborationAwareness({ onlineCollaboratorCount: 0 })
  }, [documentId])

  useEffect(() => {
    if (!hydrated || !workspaceActive || !serverPersistenceEnabled) return
    void recoverPersistentAgentRuns().catch(() => undefined)
  }, [documentId, hydrated, recoverPersistentAgentRuns, workspaceActive])

  useEffect(() => {
    if (!hydrated || !workspaceActive || !serverPersistenceEnabled) return
    if (!agentRuns.some((run) => run.status === 'queued' || run.status === 'running' || run.status === 'executing')) return
    let active = true
    let requesting = false
    const recoverProgress = async () => {
      if (!active || requesting || window.document.visibilityState !== 'visible') return
      requesting = true
      try {
        await recoverPersistentAgentRuns()
        if (!active) return
      } catch {
        // Realtime 断线或工作区短暂不可用时保留当前进度，下一轮自动恢复。
      } finally {
        requesting = false
      }
    }
    const timer = window.setInterval(() => { void recoverProgress() }, 4_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [agentRuns, documentId, hydrated, recoverPersistentAgentRuns, workspaceActive])

  useEffect(() => {
    collaborationRef.current?.replaceLocalGraph({ nodes, edges })
  }, [edges, nodes])

  return {
    canvasHydrationFailed,
    hydrateCanvas,
    refreshAgentCanvasFromRemote,
    retryAgentCanvasPersistence,
    collaborationAwareness,
    dismissRemoteChange,
  }
}
