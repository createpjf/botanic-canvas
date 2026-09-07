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
import { canvasSyncFailureMessage, shouldRefreshFromRealtimeEvent, type CanvasSyncStatus, type ProjectRealtimeConnectionState } from '../../domain/realtimeSync'
import { pendingCanvasSyncOutcome } from '../../domain/remoteDocumentSync'
import { executePersistentBotanicAgentRun, listPersistentBotanicAgentRuns, readPersistentBotanicAgentState } from '../../lib/agentApi'
import { listProjectCollaborationActivities, updateProjectCollaborationActivityReceipt } from '../../lib/collaborationApi'
import { appliedRemoteRevision, flushPendingCanvasDocumentWrites, lastKnownCanvasSyncProtocolEpoch, previewRemoteCanvasDocument, refreshCanvasDocumentFromRemote, syncPendingCanvasDrafts, type CanvasConflictRevision } from '../../lib/db'
import { recordSentryBreadcrumb } from '../../lib/sentry'
import { connectCanvasCollaboration, type CanvasCollaboration } from '../../lib/projectCollaboration'
import { serverPersistenceEnabled } from '../../lib/productSession'
import { localizeProductError, type ProductLocale } from '../../i18n/core'
import { useProductI18n } from '../../i18n/react'
import { canReadRemoteCanvasProject, useCanvasStore } from '../../store/canvasStore'
import type { CollaborationStatus } from '../../store/canvasStore.types'
import { canvasSystemLabel } from './canvasI18n'
import { retryCanvasRealtimeSync, type CanvasRealtimeRetryAttempt } from './canvasRealtimeRetry'

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
  refreshAgentSessionMessagesRef?: { current: (invalidated?: boolean) => Promise<void> }
}

export type CollaborationAwareness = {
  realtimeStatus: CollaborationStatus
  realtimeRetrying?: boolean
  realtimeRetryError?: string
  onlineCollaboratorCount: number
  activities: CollaborationActivity[]
  unreadActivityCount: number
  conflictChanges: CollaborationDocumentChange[]
  conflictRevision?: CanvasConflictRevision
  syncProtocolEpoch?: number
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
  // 只在「是否存在活动 Run」翻转时变化：轮询 interval 不随每次 Run 快照重建。
  const hasActiveAgentRuns = useCanvasStore((state) => state.document.agentRuns.some((run) => (
    run.status === 'queued' || run.status === 'running' || run.status === 'executing'
  )))
  const persistenceStatus = useCanvasStore((state) => state.persistenceStatus)
  const hydrated = useCanvasStore((state) => state.hydrated)
  const remoteProjectReady = useCanvasStore(canReadRemoteCanvasProject)
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
  const realtimeRetryRef = useRef<CanvasRealtimeRetryAttempt | null>(null)
  const collaborationActivityLoadRef = useRef<{ projectId: string; promise: Promise<void> } | null>(null)
  const agentRunRecoveryRef = useRef<Promise<boolean> | null>(null)
  const remoteDocumentRefreshRef = useRef<{ projectId: string; promise: Promise<boolean> } | null>(null)
  const agentRefreshRef = useRef<{ projectId: string; controller: AbortController; dirty: boolean; promise: Promise<void> } | null>(null)
  const runRefreshRef = useRef<{ projectId: string; promise: Promise<void> } | null>(null)
  const pendingRemoteGraphChangeRef = useRef<CollaborationDocumentChange | undefined>(undefined)
  const collaboratorNamesRef = useRef(new Map<string, string>())

  const refreshDocumentFromRemoteOnce = useCallback((options: { preserveCanvasGraph?: boolean } = {}) => {
    if (!canReadRemoteCanvasProject(useCanvasStore.getState())) return Promise.resolve(false)
    const projectId = useCanvasStore.getState().document.id
    const inFlight = remoteDocumentRefreshRef.current
    if (inFlight?.projectId === projectId) return inFlight.promise
    let promise: Promise<boolean>
    promise = refreshDocumentFromRemote(options).finally(() => {
      if (remoteDocumentRefreshRef.current?.promise === promise) remoteDocumentRefreshRef.current = null
    })
    remoteDocumentRefreshRef.current = { projectId, promise }
    return promise
  }, [refreshDocumentFromRemote])

  const retryBlockedCanvasSync = useCallback(() => {
    const collaboration = collaborationRef.current
    return retryCanvasRealtimeSync({
      projectId: documentId, collaboration, inFlight: realtimeRetryRef, locale,
      isCurrent: () => useCanvasStore.getState().document.id === documentId && collaborationRef.current === collaboration,
      onState: (state) => setCollaborationAwareness((current) => ({ ...current, ...state })),
    })
  }, [documentId, locale])

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
    if (!canReadRemoteCanvasProject(useCanvasStore.getState())) return
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

  const refreshAgentEntitiesFromRemote = useCallback((invalidated = false): Promise<void> => {
    if (!canReadRemoteCanvasProject(useCanvasStore.getState())) return Promise.resolve()
    const projectId = useCanvasStore.getState().document.id
    if (!serverPersistenceEnabled) return Promise.resolve()
    const pending = agentRefreshRef.current
    if (pending?.projectId === projectId && !pending.controller.signal.aborted) {
      if (invalidated) pending.dirty = true
      return pending.promise
    }
    pending?.controller.abort()
    const request = { projectId, controller: new AbortController(), dirty: false, promise: Promise.resolve() }
    agentRefreshRef.current = request
    const active = () => useCanvasStore.getState().document.id === projectId && !request.controller.signal.aborted
    request.promise = (async () => {
      do {
        request.dirty = false
        // 三个 Adapter 的 state 都包含同权限、同上限的 Session 投影，不再重复列举。
        const state = await readPersistentBotanicAgentState(projectId, { includeMessages: false, signal: request.controller.signal })
        if (!active()) return
        const remoteSessions = overlayLocalAgentSessionMessages(state.sessions, useCanvasStore.getState().document.agentSessions)
        useCanvasStore.setState((current) => {
          const agentSessions = mergeCollaborativeAgentSessions(current.document.agentSessions, remoteSessions)
          const activeAgentSessionId = agentSessions.some(session => session.id === current.document.activeAgentSessionId)
            ? current.document.activeAgentSessionId : agentSessions[0]?.id
          return { document: { ...current.document, agentSessions, agentMemory: state.memory, activeAgentSessionId } }
        })
        state.runs.forEach(run => applyAgentRunSnapshot(run))
      } while (active() && request.dirty)
    })().finally(() => { if (agentRefreshRef.current === request) agentRefreshRef.current = null })
    return request.promise
  }, [applyAgentRunSnapshot])

  const refreshIndependentReads = useCallback(async (invalidated = false) => {
    const results = await Promise.allSettled([
      refreshDocumentFromRemoteOnce(), refreshAgentEntitiesFromRemote(invalidated),
      refreshAgentSessionMessagesRef?.current?.(invalidated), loadCollaborationActivities(),
    ])
    results.forEach((result, index) => {
      if (result.status === 'rejected' && result.reason?.name !== 'AbortError') {
        recordSentryBreadcrumb('canvas-sync', `${['画布', 'Agent 状态', '消息', '协作记录'][index]}刷新失败，其他读取继续。`)
      }
    })
  }, [loadCollaborationActivities, refreshAgentEntitiesFromRemote, refreshAgentSessionMessagesRef, refreshDocumentFromRemoteOnce])

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
    const projectId = useCanvasStore.getState().document.id
    if (projectId === 'workspace-placeholder') return
    const result = await syncPendingCanvasDrafts(projectId)
    const current = useCanvasStore.getState()
    if (current.document.id !== projectId) return result
    const outcome = pendingCanvasSyncOutcome(result, current.document.id)
    if (outcome === 'conflict') {
      useCanvasStore.setState({ persistenceStatus: 'conflict', assistantMessage: copy.canvasConflict })
      return result
    }
    if (outcome === 'synced' && ['offline', 'error', 'conflict'].includes(current.persistenceStatus)) {
      useCanvasStore.setState({ persistenceStatus: 'saved', assistantMessage: copy.localDraftSynced })
    }
    if (outcome === 'pending' && current.persistenceStatus === 'saved') useCanvasStore.setState({ persistenceStatus: 'error' })
    return result
  }, [copy.canvasConflict, copy.localDraftSynced])

  const retryAgentCanvasPersistence = useCallback(async () => {
    const projectId = useCanvasStore.getState().document.id
    if (projectId === 'workspace-placeholder') return false
    const result = await syncPendingCanvasDrafts(projectId)
    const current = useCanvasStore.getState()
    if (current.document.id !== projectId) return false
    const outcome = pendingCanvasSyncOutcome(result, projectId)
    if (outcome === 'conflict') {
      useCanvasStore.setState({ persistenceStatus: 'conflict', assistantMessage: copy.canvasConflict })
      const preview = await previewRemoteCanvasDocument(projectId)
      if (preview && useCanvasStore.getState().document.id === projectId) setCollaborationAwareness(state => ({
        ...state, conflictRevision: preview.conflictRevision,
        conflictChanges: collaborationDocumentChanges(useCanvasStore.getState().document, preview.document).map(change => localizeCollaborationChange(change, locale)),
      }))
      return false
    }
    if (outcome === 'synced' && ['offline', 'error', 'conflict'].includes(current.persistenceStatus)) {
      useCanvasStore.setState({ persistenceStatus: 'saved', assistantMessage: copy.localDraftSynced })
    }
    return outcome === 'synced'
  }, [copy.canvasConflict, copy.localDraftSynced, locale])

  const refreshAgentCanvasFromRemote = useCallback(async () => {
    const baseline = useCanvasStore.getState().document
    const projectId = baseline.id
    if (projectId === 'workspace-placeholder') return false
    try {
      const remote = await refreshCanvasDocumentFromRemote(projectId, () => useCanvasStore.getState().document === baseline)
      if (!remote || useCanvasStore.getState().document !== baseline) return false
      const controller = new AbortController()
      const unsubscribe = useCanvasStore.subscribe(state => {
        if (state.document.id !== projectId || (state.document !== baseline && state.persistenceStatus === 'saving')) controller.abort()
      })
      const opened = await openDocument(projectId, controller.signal).finally(unsubscribe)
      if (opened && useCanvasStore.getState().document.id === projectId) {
        void refreshIndependentReads(true)
        if (useCanvasStore.getState().document.id !== projectId) return false
        if (useCanvasStore.getState().persistenceStatus !== 'saved') return false
        useCanvasStore.setState({ assistantMessage: copy.cloudVersionSelected })
      }
      return opened
    } catch (caught) {
      throw new Error(localizeProductError(caught, locale, {
        'zh-CN': canvasSynchronizationCopy['zh-CN'].remoteRefreshFailed,
        en: canvasSynchronizationCopy.en.remoteRefreshFailed,
      }))
    }
  }, [copy.cloudVersionSelected, locale, openDocument, refreshIndependentReads])

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
    if (!canReadRemoteCanvasProject(useCanvasStore.getState())) return
    const projectId = useCanvasStore.getState().document.id
    if (runRefreshRef.current?.projectId === projectId) return runRefreshRef.current.promise
    const recovery = (async () => {
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
                if (useCanvasStore.getState().document.id !== projectId) return
                if (workflow.canvasPatch) await applyAgentWorkflowPatch(workflow.canvasPatch)
                else await refreshDocumentFromRemoteOnce()
              },
            })).run
          } catch {
            // 保留 queued 快照，下一轮轮询或重连再自动确认。
          }
        }
        if (useCanvasStore.getState().document.id !== projectId) return
        const current = useCanvasStore.getState().document.agentRuns.find((candidate) => candidate.id === run.id)
        if (shouldRecoverAgentRunResults(current, run)) shouldRecoverResults = true
        applyAgentRunSnapshot(run)
      }
      if (shouldRecoverResults) await recoverAgentRunResults()
    })()
    runRefreshRef.current = { projectId, promise: recovery }
    try { await recovery } finally {
      if (runRefreshRef.current?.promise === recovery) runRefreshRef.current = null
    }
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
      void refreshIndependentReads()
      void synchronizeLocalDrafts()
        .then(() => refreshDocumentFromRemoteOnce())
        .then(() => recoverUnknownGenerationSubmission())
        .then(() => recoverPersistentAgentRuns())
        .catch(() => recordSentryBreadcrumb('canvas-sync', '草稿同步链中断，等待下一次 focus/online 重试。'))
    }
    syncDrafts()
    window.addEventListener('online', syncDrafts)
    return () => window.removeEventListener('online', syncDrafts)
  }, [documentId, hydrated, recoverPersistentAgentRuns, recoverUnknownGenerationSubmission, refreshDocumentFromRemoteOnce, refreshIndependentReads, synchronizeLocalDrafts])

  useEffect(() => {
    if (!hydrated || !workspaceActive || !serverPersistenceEnabled) return
    const refresh = () => {
      collaborationRef.current?.refresh()
      void refreshIndependentReads()
      void refreshDocumentFromRemoteOnce()
        .then(() => recoverUnknownGenerationSubmission())
        .then(() => recoverPersistentAgentRuns())
        .catch(() => recordSentryBreadcrumb('canvas-sync', '任务恢复失败，独立读取继续。'))
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
  }, [hydrated, recoverPersistentAgentRuns, recoverUnknownGenerationSubmission, refreshDocumentFromRemoteOnce, refreshIndependentReads, workspaceActive])

  useEffect(() => {
    if (!hydrated || !workspaceActive || !serverPersistenceEnabled) return
    if (!remoteProjectReady) return
    const current = useCanvasStore.getState().document
    const updateRealtimeStatus = (state: ProjectRealtimeConnectionState | CanvasSyncStatus, failure?: { code: string }) => {
      if (useCanvasStore.getState().document.id !== current.id) return
      const realtimeStatus: CollaborationStatus = state === 'closed' ? 'disabled' : state
      useCanvasStore.setState({ collaborationStatus: realtimeStatus })
      setCollaborationAwareness((awareness) => ({ ...awareness, realtimeStatus, realtimeRetryError: canvasSyncFailureMessage(failure?.code, locale) }))
    }
    setCollaborationAwareness((awareness) => ({ ...awareness, realtimeRetrying: false, realtimeRetryError: undefined }))
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
        void refreshAgentEntitiesFromRemote(true).catch(() => recordSentryBreadcrumb('canvas-sync', 'Agent 状态更新失败，消息独立刷新。'))
        void refreshAgentSessionMessagesRef?.current?.(true).catch(() => recordSentryBreadcrumb('canvas-sync', '消息更新失败，保留已读取内容。'))
      },
      onPresenceChanged: (event) => {
        collaboratorNamesRef.current = new Map(event.members.flatMap((member) => member.actorName ? [[member.userId, member.actorName] as const] : []))
        setCollaborationAwareness((current) => ({
          ...current,
          onlineCollaboratorCount: event.members.filter((member) => member.userId !== currentUserId).length,
        }))
      },
      onReconnected: () => {
        void refreshIndependentReads(true)
        void synchronizeLocalDrafts()
          .then(() => recoverUnknownGenerationSubmission())
          .then(() => recoverPersistentAgentRuns())
          .then(() => refreshDocumentFromRemoteOnce())
          .then(() => resumeBatchVariations())
          .catch(() => recordSentryBreadcrumb('canvas-sync', '重连任务恢复失败，独立读取继续。'))
      },
      onConnectionStateChanged: updateRealtimeStatus,
      onSyncStatusChanged: updateRealtimeStatus,
      onSyncProtocolEpochChanged: (epoch) => {
        setCollaborationAwareness((current) => ({ ...current, syncProtocolEpoch: epoch }))
      },
    })
    collaborationRef.current = collaboration
    const unsubscribeGraph = useCanvasStore.subscribe((state, previous) => {
      if (state.document.id !== current.id
        || (state.document.nodes === previous.document.nodes && state.document.edges === previous.document.edges)) return
      collaboration.replaceLocalGraph({ nodes: state.document.nodes, edges: state.document.edges })
    })
    return () => {
      unsubscribeGraph()
      if (collaborationRef.current === collaboration) collaborationRef.current = null
      collaboration.close()
      if (useCanvasStore.getState().document.id === current.id) useCanvasStore.setState({ collaborationStatus: 'disabled' })
    }
  }, [applyAgentRunSnapshot, applyCollaborativeGraph, copy.canvasUpdated, currentUserId, documentId, hydrated, loadCollaborationActivities, locale, recordRemoteChange, recoverAgentRunResults, recoverPersistentAgentRuns, recoverUnknownGenerationSubmission, refreshAgentEntitiesFromRemote, refreshAgentSessionMessagesRef, refreshDocumentFromRemoteOnce, refreshIndependentReads, remoteProjectReady, resumeBatchVariations, synchronizeLocalDrafts, workspaceActive])

  useEffect(() => () => { agentRefreshRef.current?.controller.abort() }, [documentId])

  useEffect(() => {
    collaboratorNamesRef.current.clear()
    const syncProtocolEpoch = lastKnownCanvasSyncProtocolEpoch(documentId)
    setCollaborationAwareness((current) => ({
      ...emptyCollaborationAwareness,
      realtimeStatus: current.realtimeStatus,
      ...(syncProtocolEpoch === undefined ? {} : { syncProtocolEpoch }),
    }))
  }, [documentId])

  useEffect(() => {
    if (!hydrated || !workspaceActive || !serverPersistenceEnabled) return
    void refreshIndependentReads()
  }, [documentId, hydrated, refreshIndependentReads, remoteProjectReady, workspaceActive])

  useEffect(() => {
    if (persistenceStatus !== 'conflict' || !serverPersistenceEnabled || (collaborationAwareness.syncProtocolEpoch ?? 1) >= 2) {
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
  }, [collaborationAwareness.syncProtocolEpoch, documentId, locale, persistenceStatus])

  useEffect(() => {
    if (!hydrated || !workspaceActive || !serverPersistenceEnabled) return
    void recoverPersistentAgentRuns().catch(() => undefined)
  }, [documentId, hydrated, recoverPersistentAgentRuns, remoteProjectReady, workspaceActive])

  useEffect(() => {
    if (!hydrated || !workspaceActive || !serverPersistenceEnabled) return
    if (!hasActiveAgentRuns) return
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
  }, [documentId, hasActiveAgentRuns, hydrated, recoverPersistentAgentRuns, workspaceActive])

  return {
    canvasHydrationFailed,
    hydrateCanvas,
    refreshAgentCanvasFromRemote,
    retryAgentCanvasPersistence,
    retryBlockedCanvasSync,
    collaborationAwareness,
    dismissRemoteChange,
    clearCollaborationActivities,
    loadMoreCollaborationActivities,
    reloadCollaborationActivities: retryCollaborationHistory,
  }
}
