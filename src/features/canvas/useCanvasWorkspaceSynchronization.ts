import { useCallback, useEffect, useRef, useState } from 'react'
import { shouldRecoverAgentRunResults, shouldResumeQueuedAgentRunExecution } from '../../domain/agent'
import { mergeCollaborativeAgentSessions, overlayLocalAgentSessionMessages } from '../../domain/agentCollaboration'
import {
  appendCollaborationActivity,
  collaborationDocumentChange,
  collaborationDocumentChanges,
  markCollaborationActivitiesRead,
  type CollaborationActivity,
  type CollaborationDocumentChange,
} from '../../domain/collaborationActivity'
import { shouldRefreshFromRealtimeEvent, type ProjectRealtimeConnectionState } from '../../domain/realtimeSync'
import { pendingCanvasSyncOutcome } from '../../domain/remoteDocumentSync'
import { executePersistentBotanicAgentRun, listPersistentBotanicAgentRuns, listPersistentBotanicAgentSessions, readPersistentBotanicAgentState } from '../../lib/agentApi'
import { listProjectCollaborationActivities, updateProjectCollaborationActivityReceipt } from '../../lib/collaborationApi'
import { appliedRemoteRevision, flushPendingCanvasDocumentWrites, previewRemoteCanvasDocument, refreshCanvasDocumentFromRemote, syncPendingCanvasDrafts, type CanvasConflictRevision } from '../../lib/db'
import { recordSentryBreadcrumb } from '../../lib/sentry'
import { connectCanvasCollaboration, type CanvasCollaboration } from '../../lib/projectCollaboration'
import { serverPersistenceEnabled } from '../../lib/productSession'
import { localizeProductError, type ProductLocale } from '../../i18n/core'
import { useProductI18n } from '../../i18n/react'
import { useCanvasStore } from '../../store/canvasStore'
import type { CollaborationStatus } from '../../store/canvasStore.types'
import { canvasSystemLabel } from './canvasI18n'

const canvasSynchronizationCopy = {
  'zh-CN': {
    collaborator: '协作者',
    localDraftSynced: '本地草稿已同步。',
    canvasConflict: '云端仍有新修改，本地草稿尚未同步。',
    cloudVersionSelected: '已切换到云端版本。',
    canvasUpdated: '更新了画布内容',
    historyLoadFailed: '协作记录加载失败，请重试。',
    historyMoreFailed: '更多协作记录加载失败，请重试。',
    markReadFailed: '协作记录标记失败，请重试。',
    clearFailed: '协作记录清空失败，请重试。',
    remoteRefreshFailed: '无法加载云端画布，请重试。',
  },
  en: {
    collaborator: 'Collaborator',
    localDraftSynced: 'Local draft synced.',
    canvasConflict: 'The cloud canvas still has newer changes. Your local draft is not synced yet.',
    cloudVersionSelected: 'Switched to the cloud version.',
    canvasUpdated: 'Updated the canvas',
    historyLoadFailed: 'Unable to load collaboration activity. Try again.',
    historyMoreFailed: 'Unable to load more collaboration activity. Try again.',
    markReadFailed: 'Unable to mark collaboration activity as read. Try again.',
    clearFailed: 'Unable to clear collaboration activity. Try again.',
    remoteRefreshFailed: 'Unable to load the cloud canvas. Try again.',
  },
} as const

function localizeCollaborationChange<T extends CollaborationDocumentChange>(change: T, locale: ProductLocale): T {
  if (locale !== 'en') return change
  const displayName = (value: string) => value === '新建对话' ? 'New conversation' : canvasSystemLabel(value, locale)
  const summary = change.summary
  let match = summary.match(/^新增了「(.+)」$/u)
  if (match) return { ...change, summary: `Added “${displayName(match[1])}”` }
  match = summary.match(/^移除了「(.+)」$/u)
  if (match) return { ...change, summary: `Removed “${displayName(match[1])}”` }
  match = summary.match(/^(移动|更新)了「(.+)」$/u)
  if (match) return { ...change, summary: `${match[1] === '移动' ? 'Moved' : 'Updated'} “${displayName(match[2])}”` }
  match = summary.match(/^更新了对话「(.+)」$/u)
  if (match) return { ...change, summary: `Updated conversation “${displayName(match[1])}”` }
  match = summary.match(/^更新了任务「(.+)」$/u)
  if (match) return { ...change, summary: `Updated task “${match[1]}”` }
  match = summary.match(/^(新增|移除|更新)了 (\d+) 个画布节点$/u)
  if (match) {
    const count = Number(match[2])
    const verb = match[1] === '新增' ? 'Added' : match[1] === '移除' ? 'Removed' : 'Updated'
    return { ...change, summary: `${verb} ${count} canvas ${count === 1 ? 'node' : 'nodes'}` }
  }
  match = summary.match(/^将项目重命名为「(.+)」$/u)
  if (match) return { ...change, summary: `Renamed project to “${match[1]}”` }
  if (summary === '调整了画布连线') return { ...change, summary: 'Updated canvas connections' }
  if (summary === '更新了项目内容') return { ...change, summary: 'Updated project content' }
  if (summary === '更新了画布内容') return { ...change, summary: 'Updated the canvas' }
  return change
}

type CanvasWorkspaceSynchronizationOptions = {
  workspaceActive: boolean
  currentUserId?: string
  refreshAgentSessionMessagesRef?: { current: () => Promise<void> }
}

export type CollaborationAwareness = {
  realtimeStatus: CollaborationStatus
  onlineCollaboratorCount: number
  activities: CollaborationActivity[]
  unreadActivityCount: number
  conflictChanges: CollaborationDocumentChange[]
  conflictRevision?: CanvasConflictRevision
  historyStatus: 'idle' | 'loading' | 'loading-more' | 'saving' | 'error'
  historyHasMore: boolean
  historyNextBefore?: string
  historyErrorAction?: 'load' | 'load-more' | 'read' | 'clear'
}

const emptyCollaborationAwareness: CollaborationAwareness = {
  realtimeStatus: 'disabled',
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
export function useCanvasWorkspaceSynchronization({
  workspaceActive,
  currentUserId,
  refreshAgentSessionMessagesRef,
}: CanvasWorkspaceSynchronizationOptions) {
  const { locale } = useProductI18n()
  const copy = canvasSynchronizationCopy[locale]
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
  const resumeBatchVariations = useCanvasStore((state) => state.resumeBatchVariations)
  const applyCollaborativeGraph = useCanvasStore((state) => state.applyCollaborativeGraph)
  const applyAgentRunSnapshot = useCanvasStore((state) => state.applyAgentRunSnapshot)
  const applyAgentWorkflowPatch = useCanvasStore((state) => state.applyAgentWorkflowPatch)
  const [canvasHydrationFailed, setCanvasHydrationFailed] = useState(false)
  const [collaborationAwareness, setCollaborationAwareness] = useState<CollaborationAwareness>(emptyCollaborationAwareness)
  const collaborationRef = useRef<CanvasCollaboration | null>(null)
  const collaborationActivityLoadRef = useRef<{ projectId: string; promise: Promise<void> } | null>(null)
  const agentRunRecoveryRef = useRef<Promise<boolean> | null>(null)
  const remoteDocumentRefreshRef = useRef<{ projectId: string; promise: Promise<boolean> } | null>(null)
  const pendingRemoteGraphChangeRef = useRef<CollaborationDocumentChange | undefined>(undefined)
  const collaboratorNamesRef = useRef(new Map<string, string>())

  const refreshDocumentFromRemoteOnce = useCallback(() => {
    const projectId = useCanvasStore.getState().document.id
    const inFlight = remoteDocumentRefreshRef.current
    if (inFlight?.projectId === projectId) return inFlight.promise
    let promise: Promise<boolean>
    promise = refreshDocumentFromRemote().finally(() => {
      if (remoteDocumentRefreshRef.current?.promise === promise) remoteDocumentRefreshRef.current = null
    })
    remoteDocumentRefreshRef.current = { projectId, promise }
    return promise
  }, [refreshDocumentFromRemote])

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
    const localizedChange = localizeCollaborationChange(change, locale)
    setCollaborationAwareness((current) => {
      const activities = appendCollaborationActivity(current.activities, {
        id: `collaboration-${actorId}-${occurredAt}`,
        actorId,
        actorName: actorName || collaboratorNamesRef.current.get(actorId) || copy.collaborator,
        ...localizedChange,
        occurredAt,
        unread: true,
        count: 1,
      })
      return { ...current, activities, unreadActivityCount: activities.filter((activity) => activity.unread).length }
    })
  }, [copy.collaborator, currentUserId, locale])

  const loadCollaborationActivities = useCallback(async () => {
    const projectId = useCanvasStore.getState().document.id
    if (!serverPersistenceEnabled || projectId === 'workspace-placeholder') return
    if (collaborationActivityLoadRef.current?.projectId === projectId) return collaborationActivityLoadRef.current.promise
    const promise = (async () => {
      setCollaborationAwareness((current) => ({ ...current, historyStatus: 'loading', historyErrorAction: undefined }))
      try {
        const { activities: rawActivities, nextBefore } = await listProjectCollaborationActivities(projectId, { limit: 30 })
        if (useCanvasStore.getState().document.id !== projectId) return
        const activities = rawActivities.map((activity) => localizeCollaborationChange(activity, locale))
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
        throw new Error(localizeProductError(caught, locale, {
          'zh-CN': canvasSynchronizationCopy['zh-CN'].historyLoadFailed,
          en: canvasSynchronizationCopy.en.historyLoadFailed,
        }))
      }
    })()
    collaborationActivityLoadRef.current = { projectId, promise }
    try {
      await promise
    } finally {
      if (collaborationActivityLoadRef.current?.promise === promise) collaborationActivityLoadRef.current = null
    }
  }, [locale])

  const loadMoreCollaborationActivities = useCallback(async () => {
    const projectId = useCanvasStore.getState().document.id
    const cursor = collaborationAwareness.historyNextBefore
    if (!serverPersistenceEnabled || projectId === 'workspace-placeholder' || !cursor || collaborationAwareness.historyStatus === 'loading-more') return
    setCollaborationAwareness((current) => ({ ...current, historyStatus: 'loading-more', historyErrorAction: undefined }))
    try {
      const { activities: rawPage, nextBefore } = await listProjectCollaborationActivities(projectId, { limit: 30, before: cursor })
      if (useCanvasStore.getState().document.id !== projectId) return
      const page = rawPage.map((activity) => localizeCollaborationChange(activity, locale))
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
      throw new Error(localizeProductError(caught, locale, {
        'zh-CN': canvasSynchronizationCopy['zh-CN'].historyMoreFailed,
        en: canvasSynchronizationCopy.en.historyMoreFailed,
      }))
    }
  }, [collaborationAwareness.historyNextBefore, collaborationAwareness.historyStatus, locale])

  const dismissRemoteChange = useCallback(async () => {
    const projectId = useCanvasStore.getState().document.id
    if (serverPersistenceEnabled) {
      setCollaborationAwareness((current) => ({ ...current, historyStatus: 'saving', historyErrorAction: undefined }))
      try {
        await updateProjectCollaborationActivityReceipt(projectId, 'read')
      } catch (caught) {
        if (useCanvasStore.getState().document.id === projectId) setCollaborationAwareness((current) => ({ ...current, historyStatus: 'error', historyErrorAction: 'read' }))
        throw new Error(localizeProductError(caught, locale, {
          'zh-CN': canvasSynchronizationCopy['zh-CN'].markReadFailed,
          en: canvasSynchronizationCopy.en.markReadFailed,
        }))
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
  }, [locale])

  const clearCollaborationActivities = useCallback(async () => {
    const projectId = useCanvasStore.getState().document.id
    if (serverPersistenceEnabled) {
      setCollaborationAwareness((current) => ({ ...current, historyStatus: 'saving', historyErrorAction: undefined }))
      try {
        await updateProjectCollaborationActivityReceipt(projectId, 'clear')
      } catch (caught) {
        if (useCanvasStore.getState().document.id === projectId) setCollaborationAwareness((current) => ({ ...current, historyStatus: 'error', historyErrorAction: 'clear' }))
        throw new Error(localizeProductError(caught, locale, {
          'zh-CN': canvasSynchronizationCopy['zh-CN'].clearFailed,
          en: canvasSynchronizationCopy.en.clearFailed,
        }))
      }
    }
    if (useCanvasStore.getState().document.id !== projectId) return
    setCollaborationAwareness((current) => ({ ...current, activities: [], unreadActivityCount: 0, historyStatus: 'idle', historyHasMore: false, historyNextBefore: undefined, historyErrorAction: undefined }))
  }, [locale])

  const refreshAgentEntitiesFromRemote = useCallback(async () => {
    const projectId = useCanvasStore.getState().document.id
    if (!serverPersistenceEnabled || projectId === 'workspace-placeholder') return
    const [{ sessions: remoteSessions }, state] = await Promise.all([
      listPersistentBotanicAgentSessions(projectId),
      readPersistentBotanicAgentState(projectId, { includeMessages: false }),
    ])
    if (useCanvasStore.getState().document.id !== projectId) return
    const localSessions = useCanvasStore.getState().document.agentSessions
    const remoteSessionsForMerge = overlayLocalAgentSessionMessages(remoteSessions, localSessions)
    useCanvasStore.setState((current) => {
      const agentSessions = mergeCollaborativeAgentSessions(current.document.agentSessions, remoteSessionsForMerge)
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
    await refreshAgentSessionMessagesRef?.current?.()
  }, [applyAgentRunSnapshot, refreshAgentSessionMessagesRef])

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
    const outcome = pendingCanvasSyncOutcome(result, current.document.id)
    if (outcome === 'conflict') {
      useCanvasStore.setState({ persistenceStatus: 'conflict', assistantMessage: copy.canvasConflict })
      return result
    }
    if (outcome === 'synced' && ['offline', 'error', 'conflict'].includes(current.persistenceStatus)) {
      useCanvasStore.setState({ persistenceStatus: 'saved', assistantMessage: copy.localDraftSynced })
    }
    return result
  }, [copy.canvasConflict, copy.localDraftSynced])

  const retryAgentCanvasPersistence = useCallback(async () => {
    const projectId = useCanvasStore.getState().document.id
    try {
      const result = await syncPendingCanvasDrafts()
      const current = useCanvasStore.getState()
      if (current.document.id !== projectId) return false
      const outcome = pendingCanvasSyncOutcome(result, projectId)
      if (outcome === 'conflict') {
        useCanvasStore.setState({ persistenceStatus: 'conflict', assistantMessage: copy.canvasConflict })
        return false
      }
      if (outcome === 'synced' && ['offline', 'error', 'conflict'].includes(current.persistenceStatus)) {
        useCanvasStore.setState({ persistenceStatus: 'saved', assistantMessage: copy.localDraftSynced })
      }
      return outcome === 'synced'
    } catch {
      return false
    }
  }, [copy.canvasConflict, copy.localDraftSynced])

  const refreshAgentCanvasFromRemote = useCallback(async () => {
    const projectId = useCanvasStore.getState().document.id
    if (projectId === 'workspace-placeholder') return false
    try {
      const remote = await refreshCanvasDocumentFromRemote(projectId)
      if (!remote || useCanvasStore.getState().document.id !== projectId) return false
      const opened = await openDocument(projectId)
      if (opened && useCanvasStore.getState().document.id === projectId) {
        useCanvasStore.setState({ persistenceStatus: 'saved', assistantMessage: copy.cloudVersionSelected })
      }
      return opened
    } catch (caught) {
      throw new Error(localizeProductError(caught, locale, {
        'zh-CN': canvasSynchronizationCopy['zh-CN'].remoteRefreshFailed,
        en: canvasSynchronizationCopy.en.remoteRefreshFailed,
      }))
    }
  }, [copy.cloudVersionSelected, locale, openDocument])

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
        if (index < retryDelays.length - 1) await refreshDocumentFromRemoteOnce().catch(() => false)
      }
      return false
    })()
    agentRunRecoveryRef.current = recovery
    try {
      return await recovery
    } finally {
      if (agentRunRecoveryRef.current === recovery) agentRunRecoveryRef.current = null
    }
  }, [recoverGenerationResultsFromRemote, refreshDocumentFromRemoteOnce])

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
            onWorkflowReady: async (workflow) => {
              if (workflow.canvasPatch) await applyAgentWorkflowPatch(workflow.canvasPatch)
              else await refreshDocumentFromRemoteOnce()
            },
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
  }, [applyAgentRunSnapshot, applyAgentWorkflowPatch, recoverAgentRunResults, refreshDocumentFromRemoteOnce])

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
        .then(() => refreshDocumentFromRemoteOnce())
        .then(() => recoverUnknownGenerationSubmission())
        .then(() => recoverPersistentAgentRuns())
        .then(() => loadCollaborationActivities())
        .catch(() => recordSentryBreadcrumb('canvas-sync', '草稿同步链中断，等待下一次 focus/online 重试。'))
    }
    syncDrafts()
    window.addEventListener('online', syncDrafts)
    return () => window.removeEventListener('online', syncDrafts)
  }, [hydrated, loadCollaborationActivities, recoverPersistentAgentRuns, recoverUnknownGenerationSubmission, refreshDocumentFromRemoteOnce, synchronizeLocalDrafts])

  useEffect(() => {
    if (!hydrated || !workspaceActive || !serverPersistenceEnabled) return
    const refresh = () => {
      void refreshDocumentFromRemoteOnce()
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
  }, [hydrated, loadCollaborationActivities, recoverPersistentAgentRuns, recoverUnknownGenerationSubmission, refreshDocumentFromRemoteOnce, workspaceActive])

  useEffect(() => {
    if (!hydrated || !workspaceActive || !serverPersistenceEnabled) return
    const current = useCanvasStore.getState().document
    const updateRealtimeStatus = (state: ProjectRealtimeConnectionState) => {
      if (useCanvasStore.getState().document.id !== current.id) return
      const realtimeStatus: CollaborationStatus = state === 'closed' ? 'disabled' : state
      useCanvasStore.setState({ collaborationStatus: realtimeStatus })
      setCollaborationAwareness((awareness) => ({ ...awareness, realtimeStatus }))
    }
    updateRealtimeStatus('connecting')
    const collaboration = connectCanvasCollaboration({
      projectId: current.id,
      initialGraph: { nodes: current.nodes, edges: current.edges },
      onRemoteGraph: (graph) => {
        const before = useCanvasStore.getState().document
        pendingRemoteGraphChangeRef.current = collaborationDocumentChange(before, { ...before, nodes: graph.nodes, edges: graph.edges })
        applyCollaborativeGraph(graph)
      },
      onRemoteCanvasChanged: ({ actorId, actorName, activity }) => {
        const change = pendingRemoteGraphChangeRef.current ?? { kind: 'canvas', summary: copy.canvasUpdated }
        pendingRemoteGraphChangeRef.current = undefined
        if (activity && activity.actorId !== currentUserId) {
          setCollaborationAwareness((current) => {
            const activities = appendCollaborationActivity(current.activities, localizeCollaborationChange(activity, locale))
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
          appliedRevision: appliedRemoteRevision(latest.id),
        })) return
        const before = latest
        void refreshDocumentFromRemoteOnce()
          .then(() => {
            const after = useCanvasStore.getState().document
            if (after.id !== before.id) return
            const appliedNow = appliedRemoteRevision(after.id)
            const stillBehind = typeof appliedNow === 'number'
              ? appliedNow < event.revision
              : after.updatedAt < event.updatedAt
            if (stillBehind) return refreshDocumentFromRemoteOnce().then(() => undefined)
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
            const activities = appendCollaborationActivity(current.activities, localizeCollaborationChange(event.activity, locale), { maximum: Math.max(30, current.activities.length + 1) })
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
          .then(() => refreshDocumentFromRemoteOnce())
          .then(() => resumeBatchVariations())
          .then(() => loadCollaborationActivities())
          .catch(() => undefined)
      },
      onConnectionStateChanged: updateRealtimeStatus,
    })
    collaborationRef.current = collaboration
    return () => {
      if (collaborationRef.current === collaboration) collaborationRef.current = null
      collaboration.close()
      if (useCanvasStore.getState().document.id === current.id) useCanvasStore.setState({ collaborationStatus: 'disabled' })
    }
  }, [applyAgentRunSnapshot, applyCollaborativeGraph, copy.canvasUpdated, currentUserId, documentId, hydrated, loadCollaborationActivities, locale, recordRemoteChange, recoverAgentRunResults, recoverPersistentAgentRuns, recoverUnknownGenerationSubmission, refreshAgentEntitiesFromRemote, refreshDocumentFromRemoteOnce, resumeBatchVariations, synchronizeLocalDrafts, workspaceActive])

  useEffect(() => {
    collaboratorNamesRef.current.clear()
    setCollaborationAwareness((current) => ({ ...emptyCollaborationAwareness, realtimeStatus: current.realtimeStatus }))
  }, [documentId])

  useEffect(() => {
    if (!hydrated || !workspaceActive || !serverPersistenceEnabled) return
    void loadCollaborationActivities().catch(() => undefined)
  }, [documentId, hydrated, loadCollaborationActivities, workspaceActive])

  useEffect(() => {
    if (persistenceStatus !== 'conflict' || !serverPersistenceEnabled) {
      setCollaborationAwareness((current) => current.conflictChanges.length || current.conflictRevision
        ? { ...current, conflictChanges: [], conflictRevision: undefined }
        : current)
      return
    }
    const local = useCanvasStore.getState().document
    void previewRemoteCanvasDocument(local.id)
      .then((preview) => {
        if (!preview || useCanvasStore.getState().document.id !== local.id) return
        setCollaborationAwareness((current) => ({
          ...current,
          conflictRevision: preview.conflictRevision,
          conflictChanges: collaborationDocumentChanges(local, preview.document).map((change) => localizeCollaborationChange(change, locale)),
        }))
      })
      .catch(() => undefined)
  }, [documentId, locale, persistenceStatus])

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
