import { useCallback, useEffect, useRef, useState } from 'react'
import { shouldRecoverAgentRunResults, shouldResumeQueuedAgentRunExecution } from '../../domain/agent'
import { mergeCollaborativeAgentSessions } from '../../domain/agentCollaboration'
import {
  appendCollaborationActivity,
  collaborationDocumentChange,
  collaborationDocumentChanges,
  markCollaborationActivitiesRead,
  type CollaborationActivity,
  type CollaborationDocumentChange,
} from '../../domain/collaborationActivity'
import { shouldRefreshFromRealtimeEvent } from '../../domain/realtimeSync'
import { executePersistentBotanicAgentRun, listPersistentBotanicAgentRuns, readPersistentBotanicAgentState } from '../../lib/agentApi'
import { listProjectCollaborationActivities, updateProjectCollaborationActivityReceipt } from '../../lib/collaborationApi'
import { flushPendingCanvasDocumentWrites, previewRemoteCanvasDocument, refreshCanvasDocumentFromRemote, syncPendingCanvasDrafts } from '../../lib/db'
import { connectCanvasCollaboration, type CanvasCollaboration } from '../../lib/projectCollaboration'
import { serverPersistenceEnabled } from '../../lib/productSession'
import { useCanvasStore } from '../../store/canvasStore'

type CanvasWorkspaceSynchronizationOptions = {
  workspaceActive: boolean
  currentUserId?: string
}

export type CollaborationAwareness = {
  onlineCollaboratorCount: number
  activities: CollaborationActivity[]
  unreadActivityCount: number
  conflictChanges: CollaborationDocumentChange[]
  historyStatus: 'idle' | 'loading' | 'loading-more' | 'saving' | 'error'
  historyHasMore: boolean
  historyNextBefore?: string
  historyErrorAction?: 'load' | 'load-more' | 'read' | 'clear'
}

const emptyCollaborationAwareness: CollaborationAwareness = {
  onlineCollaboratorCount: 0,
  activities: [],
  unreadActivityCount: 0,
  conflictChanges: [],
  historyStatus: 'idle',
  historyHasMore: false,
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
  const persistenceStatus = useCanvasStore((state) => state.persistenceStatus)
  const hydrated = useCanvasStore((state) => state.hydrated)
  const hydrate = useCanvasStore((state) => state.hydrate)
  const openDocument = useCanvasStore((state) => state.openDocument)
  const refreshDocumentFromRemote = useCanvasStore((state) => state.refreshDocumentFromRemote)
  const recoverGenerationResultsFromRemote = useCanvasStore((state) => state.recoverGenerationResultsFromRemote)
  const recoverUnknownGenerationSubmission = useCanvasStore((state) => state.recoverUnknownGenerationSubmission)
  const applyCollaborativeGraph = useCanvasStore((state) => state.applyCollaborativeGraph)
  const applyAgentRunSnapshot = useCanvasStore((state) => state.applyAgentRunSnapshot)
  const [canvasHydrationFailed, setCanvasHydrationFailed] = useState(false)
  const [collaborationAwareness, setCollaborationAwareness] = useState<CollaborationAwareness>(emptyCollaborationAwareness)
  const collaborationRef = useRef<CanvasCollaboration | null>(null)
  const agentRunRecoveryRef = useRef<Promise<boolean> | null>(null)
  const pendingRemoteGraphChangeRef = useRef<CollaborationDocumentChange | undefined>(undefined)
  const collaboratorNamesRef = useRef(new Map<string, string>())

  const recordRemoteChange = useCallback(({
    actorId,
    actorName,
    change,
    occurredAt = Date.now(),
  }: {
    actorId?: string
    actorName?: string
    change: CollaborationDocumentChange
    occurredAt?: number
  }) => {
    if (!actorId || actorId === currentUserId) return
    setCollaborationAwareness((current) => {
      const activities = appendCollaborationActivity(current.activities, {
        id: `collaboration-${actorId}-${occurredAt}`,
        actorId,
        actorName: actorName || collaboratorNamesRef.current.get(actorId) || '协作者',
        ...change,
        occurredAt,
        unread: true,
        count: 1,
      })
      return { ...current, activities, unreadActivityCount: activities.filter((activity) => activity.unread).length }
    })
  }, [currentUserId])

  const loadCollaborationActivities = useCallback(async () => {
    const projectId = useCanvasStore.getState().document.id
    if (!serverPersistenceEnabled || projectId === 'workspace-placeholder') return
    setCollaborationAwareness((current) => ({ ...current, historyStatus: 'loading', historyErrorAction: undefined }))
    try {
      const { activities, nextBefore } = await listProjectCollaborationActivities(projectId, { limit: 30 })
      if (useCanvasStore.getState().document.id !== projectId) return
      setCollaborationAwareness((current) => ({
        ...current,
        activities,
        unreadActivityCount: activities.filter((activity) => activity.unread).length,
        historyStatus: 'idle',
        historyHasMore: Boolean(nextBefore),
        historyNextBefore: nextBefore,
        historyErrorAction: undefined,
      }))
    } catch (caught) {
      if (useCanvasStore.getState().document.id === projectId) {
        setCollaborationAwareness((current) => ({ ...current, historyStatus: 'error', historyErrorAction: 'load' }))
      }
      throw caught
    }
  }, [])

  const loadMoreCollaborationActivities = useCallback(async () => {
    const projectId = useCanvasStore.getState().document.id
    const cursor = collaborationAwareness.historyNextBefore
    if (!serverPersistenceEnabled || projectId === 'workspace-placeholder' || !cursor || collaborationAwareness.historyStatus === 'loading-more') return
    setCollaborationAwareness((current) => ({ ...current, historyStatus: 'loading-more', historyErrorAction: undefined }))
    try {
      const { activities: page, nextBefore } = await listProjectCollaborationActivities(projectId, { limit: 30, before: cursor })
      if (useCanvasStore.getState().document.id !== projectId) return
      setCollaborationAwareness((current) => {
        const byId = new Map([...current.activities, ...page].map((activity) => [activity.id, activity]))
        const activities = [...byId.values()].sort((left, right) => right.occurredAt - left.occurredAt || right.id.localeCompare(left.id))
        return {
          ...current,
          activities,
          unreadActivityCount: activities.filter((activity) => activity.unread).length,
          historyStatus: 'idle',
          historyHasMore: Boolean(nextBefore),
          historyNextBefore: nextBefore,
          historyErrorAction: undefined,
        }
      })
    } catch (caught) {
      if (useCanvasStore.getState().document.id === projectId) {
        setCollaborationAwareness((current) => ({ ...current, historyStatus: 'error', historyErrorAction: 'load-more' }))
      }
      throw caught
    }
  }, [collaborationAwareness.historyNextBefore, collaborationAwareness.historyStatus])

  const dismissRemoteChange = useCallback(async () => {
    const projectId = useCanvasStore.getState().document.id
    if (serverPersistenceEnabled) {
      setCollaborationAwareness((current) => ({ ...current, historyStatus: 'saving', historyErrorAction: undefined }))
      try {
        await updateProjectCollaborationActivityReceipt(projectId, 'read')
      } catch (caught) {
        if (useCanvasStore.getState().document.id === projectId) setCollaborationAwareness((current) => ({ ...current, historyStatus: 'error', historyErrorAction: 'read' }))
        throw caught
      }
    }
    if (useCanvasStore.getState().document.id !== projectId) return
    setCollaborationAwareness((current) => ({
      ...current,
      activities: markCollaborationActivitiesRead(current.activities),
      unreadActivityCount: 0,
      historyStatus: 'idle',
      historyErrorAction: undefined,
    }))
  }, [])

  const clearCollaborationActivities = useCallback(async () => {
    const projectId = useCanvasStore.getState().document.id
    if (serverPersistenceEnabled) {
      setCollaborationAwareness((current) => ({ ...current, historyStatus: 'saving', historyErrorAction: undefined }))
      try {
        await updateProjectCollaborationActivityReceipt(projectId, 'clear')
      } catch (caught) {
        if (useCanvasStore.getState().document.id === projectId) setCollaborationAwareness((current) => ({ ...current, historyStatus: 'error', historyErrorAction: 'clear' }))
        throw caught
      }
    }
    if (useCanvasStore.getState().document.id !== projectId) return
    setCollaborationAwareness((current) => ({ ...current, activities: [], unreadActivityCount: 0, historyStatus: 'idle', historyHasMore: false, historyNextBefore: undefined, historyErrorAction: undefined }))
  }, [])

  const refreshAgentEntitiesFromRemote = useCallback(async () => {
    const projectId = useCanvasStore.getState().document.id
    if (!serverPersistenceEnabled || projectId === 'workspace-placeholder') return
    const state = await readPersistentBotanicAgentState(projectId)
    if (useCanvasStore.getState().document.id !== projectId) return
    useCanvasStore.setState((current) => {
      const agentSessions = mergeCollaborativeAgentSessions(current.document.agentSessions, state.sessions)
      const activeAgentSessionId = agentSessions.some((session) => session.id === current.document.activeAgentSessionId)
        ? current.document.activeAgentSessionId
        : agentSessions[0]?.id
      return {
        document: {
          ...current.document,
          agentSessions,
          agentMemory: state.memory,
          activeAgentSessionId,
        },
      }
    })
    state.runs.forEach((run) => applyAgentRunSnapshot(run))
  }, [applyAgentRunSnapshot])

  const retryCollaborationHistory = useCallback(async () => {
    if (collaborationAwareness.historyErrorAction === 'read') return dismissRemoteChange()
    if (collaborationAwareness.historyErrorAction === 'clear') return clearCollaborationActivities()
    if (collaborationAwareness.historyErrorAction === 'load-more') return loadMoreCollaborationActivities()
    return loadCollaborationActivities()
  }, [clearCollaborationActivities, collaborationAwareness.historyErrorAction, dismissRemoteChange, loadCollaborationActivities, loadMoreCollaborationActivities])

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

  const recoverAgentRunResults = useCallback(async () => {
    if (agentRunRecoveryRef.current) return agentRunRecoveryRef.current
    const recovery = (async () => {
      // Worker 的画布写回与 realtime 事件在不同基础设施上到达；短暂重试
      // 只处理这个竞态，不会重新调用 Provider。
      const retryDelays = [0, 300, 1_000, 2_500]
      for (const [index, delay] of retryDelays.entries()) {
        if (delay) await new Promise<void>((resolve) => window.setTimeout(resolve, delay))
        const recovered = await recoverGenerationResultsFromRemote()
        if (recovered) return true
        if (index < retryDelays.length - 1) await refreshDocumentFromRemote().catch(() => false)
      }
      return false
    })()
    agentRunRecoveryRef.current = recovery
    try {
      return await recovery
    } finally {
      if (agentRunRecoveryRef.current === recovery) agentRunRecoveryRef.current = null
    }
  }, [recoverGenerationResultsFromRemote, refreshDocumentFromRemote])

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
          run = (await executePersistentBotanicAgentRun(projectId, run.id, {
            onWorkflowReady: async () => { await refreshDocumentFromRemote() },
          })).run
        } catch {
          // 保留 queued 快照，下一轮轮询或重连再自动确认。
        }
      }
      const current = useCanvasStore.getState().document.agentRuns.find((candidate) => candidate.id === run.id)
      if (shouldRecoverAgentRunResults(current, run)) shouldRecoverResults = true
      applyAgentRunSnapshot(run)
    }
    if (shouldRecoverResults) await recoverAgentRunResults()
  }, [applyAgentRunSnapshot, recoverAgentRunResults, refreshDocumentFromRemote])

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
        .then(() => loadCollaborationActivities())
        .catch(() => undefined)
    }
    syncDrafts()
    window.addEventListener('online', syncDrafts)
    return () => window.removeEventListener('online', syncDrafts)
  }, [hydrated, loadCollaborationActivities, recoverPersistentAgentRuns, recoverUnknownGenerationSubmission, refreshDocumentFromRemote, synchronizeLocalDrafts])

  useEffect(() => {
    if (!hydrated || !workspaceActive || !serverPersistenceEnabled) return
    const refresh = () => {
      void refreshDocumentFromRemote()
        .then(() => recoverUnknownGenerationSubmission())
        .then(() => recoverPersistentAgentRuns())
        .then(() => loadCollaborationActivities())
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
  }, [hydrated, loadCollaborationActivities, recoverPersistentAgentRuns, recoverUnknownGenerationSubmission, refreshDocumentFromRemote, workspaceActive])

  useEffect(() => {
    if (!hydrated || !workspaceActive || !serverPersistenceEnabled) return
    const current = useCanvasStore.getState().document
    const collaboration = connectCanvasCollaboration({
      projectId: current.id,
      initialGraph: { nodes: current.nodes, edges: current.edges },
      onRemoteGraph: (graph) => {
        const before = useCanvasStore.getState().document
        pendingRemoteGraphChangeRef.current = collaborationDocumentChange(before, { ...before, nodes: graph.nodes, edges: graph.edges })
        applyCollaborativeGraph(graph)
      },
      onRemoteCanvasChanged: ({ actorId, actorName, activity }) => {
        const change = pendingRemoteGraphChangeRef.current ?? { kind: 'canvas', summary: '更新了画布内容' }
        pendingRemoteGraphChangeRef.current = undefined
        if (activity && activity.actorId !== currentUserId) {
          setCollaborationAwareness((current) => {
            const activities = appendCollaborationActivity(current.activities, activity)
            return { ...current, activities, unreadActivityCount: activities.filter((entry) => entry.unread).length }
          })
        } else recordRemoteChange({ actorId, actorName, change })
      },
      onProjectUpdated: (event) => {
        const latest = useCanvasStore.getState().document
        if (!shouldRefreshFromRealtimeEvent({
          event,
          currentProjectId: latest.id,
          currentUpdatedAt: latest.updatedAt,
        })) return
        const before = latest
        void refreshDocumentFromRemote()
          .then(() => {
            const after = useCanvasStore.getState().document
            if (after.id !== before.id) return
            return loadCollaborationActivities().catch(() => recordRemoteChange({
                actorId: event.actorId,
                actorName: event.actorName,
                change: collaborationDocumentChange(before, after),
                occurredAt: event.updatedAt,
              }))
          })
          .catch(() => undefined)
      },
      onAgentRunUpdated: (event) => {
        applyAgentRunSnapshot(event.run)
        const terminal = event.run.branches.every((branch) => ['succeeded', 'failed', 'cancelled'].includes(branch.status))
        if (terminal) {
          void recoverAgentRunResults().catch(() => undefined)
        }
      },
      onCollaborationActivity: (event) => {
        if (event.activity.actorId !== currentUserId) {
          setCollaborationAwareness((current) => {
            const activities = appendCollaborationActivity(current.activities, event.activity, { maximum: Math.max(30, current.activities.length + 1) })
            return { ...current, activities, unreadActivityCount: activities.filter((entry) => entry.unread).length }
          })
        }
        // 同一账号的另一台设备 actorId 相同，也必须刷新独立 Agent 实体。
        void refreshAgentEntitiesFromRemote().catch(() => undefined)
      },
      onPresenceChanged: (event) => {
        collaboratorNamesRef.current = new Map(event.members.flatMap((member) => member.actorName ? [[member.userId, member.actorName] as const] : []))
        setCollaborationAwareness((current) => ({
          ...current,
          onlineCollaboratorCount: event.members.filter((member) => member.userId !== currentUserId).length,
        }))
      },
      onReconnected: () => {
        void synchronizeLocalDrafts()
          .then(() => recoverUnknownGenerationSubmission())
          .then(() => recoverPersistentAgentRuns())
          .then(() => refreshAgentEntitiesFromRemote())
          .then(() => refreshDocumentFromRemote())
          .then(() => loadCollaborationActivities())
          .catch(() => undefined)
      },
    })
    collaborationRef.current = collaboration
    return () => {
      if (collaborationRef.current === collaboration) collaborationRef.current = null
      collaboration.close()
    }
  }, [applyAgentRunSnapshot, applyCollaborativeGraph, currentUserId, documentId, hydrated, loadCollaborationActivities, recordRemoteChange, recoverAgentRunResults, recoverPersistentAgentRuns, recoverUnknownGenerationSubmission, refreshAgentEntitiesFromRemote, refreshDocumentFromRemote, synchronizeLocalDrafts, workspaceActive])

  useEffect(() => {
    collaboratorNamesRef.current.clear()
    setCollaborationAwareness(emptyCollaborationAwareness)
  }, [documentId])

  useEffect(() => {
    if (!hydrated || !workspaceActive || !serverPersistenceEnabled) return
    void loadCollaborationActivities().catch(() => undefined)
  }, [documentId, hydrated, loadCollaborationActivities, workspaceActive])

  useEffect(() => {
    if (persistenceStatus !== 'conflict' || !serverPersistenceEnabled) {
      setCollaborationAwareness((current) => current.conflictChanges.length ? { ...current, conflictChanges: [] } : current)
      return
    }
    const local = useCanvasStore.getState().document
    void previewRemoteCanvasDocument(local.id)
      .then((remote) => {
        if (!remote || useCanvasStore.getState().document.id !== local.id) return
        setCollaborationAwareness((current) => ({ ...current, conflictChanges: collaborationDocumentChanges(local, remote) }))
      })
      .catch(() => undefined)
  }, [documentId, persistenceStatus])

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
    clearCollaborationActivities,
    loadMoreCollaborationActivities,
    reloadCollaborationActivities: retryCollaborationHistory,
  }
}
