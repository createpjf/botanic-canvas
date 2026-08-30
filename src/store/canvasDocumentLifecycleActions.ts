import { createEmptyCanvasDocument, seedGlobalAssets } from '../data/seed'
import type { CanvasDocument, ResultNodeData } from '../domain/canvas'
import {
  canvasDocumentLifecycleAssistantMessage,
  canvasDocumentReadyAssistantMessage,
} from '../domain/canvasDocumentLifecycleCopy'
import { createLatestOperation } from '../domain/latestOperation'
import { readProductLocale } from '../i18n/core'
import { resolveRemoteCanvasRefresh } from '../domain/remoteDocumentSync'
import {
  ensureGlobalAssetLibrary,
  flushPendingCanvasDocumentWrites,
  persistAcceptedRemoteCanvasDocument,
  readCanvasDocument,
  readGlobalWorkflowTemplateLibrary,
  readLatestCanvasDocument,
  renameCanvasProject,
  writeCanvasDocument,
} from '../lib/db'
import { cleanDisplayName, hasCrampedStarterV03Layout } from './canvasDocumentMigration'
import { restoreGenerationLifecycleState } from './canvasGenerationLifecycle'
import { settleExpiredGenerationSubmissions } from './canvasGenerationProjection'
import type { CanvasStore } from './canvasStore.types'

type DocumentLifecycleActions = Pick<CanvasStore,
  | 'hydrate'
  | 'openDocument'
  | 'refreshDocumentFromRemote'
  | 'openNewDocument'
  | 'renameDocument'
>

type CanvasDocumentLifecycleDependencies = {
  set: (next: Partial<CanvasStore>) => void
  get: () => CanvasStore
  normalizeDocument: (document: CanvasDocument | undefined) => CanvasDocument
  invalidatePersistence: () => void
  stopGenerationPolling: () => void
  pollGenerationJob: (jobId: string) => void
  recoverGenerationResults: (documentId: string) => Promise<boolean>
}

const openDocumentOperations = createLatestOperation()

/** Owns project opening, refresh, creation and rename transitions. */
export function createCanvasDocumentLifecycleActions({
  set,
  get,
  normalizeDocument,
  invalidatePersistence,
  stopGenerationPolling,
  pollGenerationJob,
  recoverGenerationResults,
}: CanvasDocumentLifecycleDependencies): DocumentLifecycleActions {
  const applyRemoteDocumentRefresh = (
    remoteDocument: CanvasDocument,
    baselineUpdatedAt: number,
    hasPendingDraft = false,
  ) => {
    const current = get().document
    const normalizedRemote = settleExpiredGenerationSubmissions(normalizeDocument(remoteDocument)).document
    const resolved = resolveRemoteCanvasRefresh({ current, remote: normalizedRemote, baselineUpdatedAt, hasPendingDraft })
    if (!resolved.applied) return false
    stopGenerationPolling()
    const document = resolved.document
    const selectedNode = [...document.nodes].reverse().find(
      (node) => node.selected || (node.type === 'result' && Boolean((node.data as ResultNodeData).selected)),
    )
    const syncedMessage = canvasDocumentLifecycleAssistantMessage({ kind: 'synced', locale: readProductLocale() })
    const recoveredGeneration = restoreGenerationLifecycleState(document, syncedMessage)
    set({
      document,
      persistenceStatus: 'saved',
      selectedNodeId: selectedNode?.id ?? null,
      ...recoveredGeneration.state,
      assistantMessage: recoveredGeneration.state.generationStatus === 'recovering'
        ? recoveredGeneration.state.assistantMessage
        : syncedMessage,
      undoAction: null,
      undoSnapshot: null,
    })
    if (recoveredGeneration.pollJobId) pollGenerationJob(recoveredGeneration.pollJobId)
    else if (recoveredGeneration.state.generationStatus === 'recovering') {
      queueMicrotask(() => { void get().recoverUnknownGenerationSubmission() })
    }
    return true
  }

  return {
    hydrate: async () => {
      const document = createEmptyCanvasDocument('workspace-placeholder', '未命名画布')
      const selectedNode = [...document.nodes].reverse().find(
        (node) => node.selected || (node.type === 'result' && Boolean((node.data as ResultNodeData).selected)),
      )
      const recoveredGeneration = restoreGenerationLifecycleState(
        document,
        canvasDocumentReadyAssistantMessage(document, readProductLocale()),
      )
      set({
        document,
        globalAssets: [],
        sharedTemplates: [],
        hydrated: true,
        persistenceStatus: 'saved',
        selectedNodeId: selectedNode?.id ?? null,
        ...recoveredGeneration.state,
      })
    },

    openDocument: async (documentId) => {
      const operationToken = openDocumentOperations.begin()
      // 上一项目的远端保存继续在后台跑；打开当前项目不能被它的 15s 超时堵住。
      void flushPendingCanvasDocumentWrites().catch(() => undefined)
      if (!openDocumentOperations.isCurrent(operationToken)) return false
      const stored = await readCanvasDocument(documentId, {
        onRemoteDocument: ({ cachedDocument, remoteDocument }) => (
          applyRemoteDocumentRefresh(remoteDocument, cachedDocument.updatedAt)
        ),
      })
      if (!stored || !openDocumentOperations.isCurrent(operationToken)) return false
      stopGenerationPolling()
      invalidatePersistence()
      const normalizedDocument = normalizeDocument(stored)
      const settledSubmission = settleExpiredGenerationSubmissions(normalizedDocument)
      const document = settledSubmission.document
      const selectedNode = [...document.nodes].reverse().find(
        (node) => node.selected || (node.type === 'result' && Boolean((node.data as ResultNodeData).selected)),
      )
      const recoveredGeneration = restoreGenerationLifecycleState(
        document,
        canvasDocumentReadyAssistantMessage(document, readProductLocale()),
      )
      set({
        document,
        globalAssets: get().globalAssets,
        hydrated: true,
        persistenceStatus: 'saved',
        selectedNodeId: selectedNode?.id ?? null,
        ...recoveredGeneration.state,
        undoAction: null,
        undoSnapshot: null,
      })
      if (settledSubmission.changed || document.schemaVersion !== stored.schemaVersion || hasCrampedStarterV03Layout(stored.nodes)) {
        try {
          await writeCanvasDocument(document)
          if (openDocumentOperations.isCurrent(operationToken) && get().document.id === documentId) set({ persistenceStatus: 'saved' })
        } catch {
          if (openDocumentOperations.isCurrent(operationToken) && get().document.id === documentId) {
            set({ persistenceStatus: 'error', assistantMessage: '项目迁移保存失败：请先不要刷新。' })
          }
        }
      }
      void ensureGlobalAssetLibrary(seedGlobalAssets).then((library) => {
        if (get().document.id !== documentId) return
        set({ globalAssets: library.assets })
        get().resumeBatchVariations()
      }).catch(() => undefined)
      void readGlobalWorkflowTemplateLibrary()
        .then((library) => set({ sharedTemplates: library?.templates ?? [] }))
        .catch(() => undefined)
      if (recoveredGeneration.pollJobId) pollGenerationJob(recoveredGeneration.pollJobId)
      else if (recoveredGeneration.state.generationStatus === 'recovering') {
        queueMicrotask(() => { void get().recoverUnknownGenerationSubmission() })
      }
      if (get().globalAssets.length) window.setTimeout(() => get().resumeBatchVariations(), 0)
      void recoverGenerationResults(documentId)
      return true
    },

    refreshDocumentFromRemote: async () => {
      const baseline = get().document
      try {
        const latest = await readLatestCanvasDocument(baseline.id)
        if (!latest.document) return false
        const applied = applyRemoteDocumentRefresh(latest.document, baseline.updatedAt, latest.hasPendingDraft)
        if (applied) await persistAcceptedRemoteCanvasDocument(latest.document)
        return applied
      } catch {
        return false
      }
    },

    openNewDocument: (inputDocument) => {
      openDocumentOperations.invalidate()
      invalidatePersistence()
      stopGenerationPolling()
      const document = settleExpiredGenerationSubmissions(inputDocument).document
      const selectedNode = [...document.nodes].reverse().find(
        (node) => node.selected || (node.type === 'result' && Boolean((node.data as ResultNodeData).selected)),
      )
      const recoveredGeneration = restoreGenerationLifecycleState(
        document,
        canvasDocumentReadyAssistantMessage(document, readProductLocale()),
      )
      set({
        document,
        hydrated: true,
        persistenceStatus: 'saved',
        selectedNodeId: selectedNode?.id ?? null,
        ...recoveredGeneration.state,
        undoAction: null,
        undoSnapshot: null,
      })
      void ensureGlobalAssetLibrary(seedGlobalAssets)
        .then((library) => set({ globalAssets: library.assets }))
        .catch(() => undefined)
      void readGlobalWorkflowTemplateLibrary()
        .then((library) => set({ sharedTemplates: library?.templates ?? [] }))
        .catch(() => undefined)
      if (recoveredGeneration.state.generationStatus === 'recovering') {
        queueMicrotask(() => { void get().recoverUnknownGenerationSubmission() })
      }
      window.setTimeout(() => get().resumeBatchVariations(), 0)
    },

    renameDocument: (name) => {
      const nextName = cleanDisplayName(name, '')
      if (!nextName || nextName === get().document.name) return Promise.resolve()
      const current = get().document
      set({
        document: { ...current, name: nextName },
        persistenceStatus: 'saving',
        assistantMessage: canvasDocumentLifecycleAssistantMessage({ kind: 'renaming', name: nextName, locale: readProductLocale() }),
      })
      return renameCanvasProject(current.id, nextName).then((saved) => {
        if (get().document.id !== current.id) return
        const active = get().document
        set({
          document: { ...active, name: saved.name, updatedAt: Math.max(active.updatedAt, saved.updatedAt) },
          persistenceStatus: 'saved',
          assistantMessage: canvasDocumentLifecycleAssistantMessage({ kind: 'renamed', name: nextName, locale: readProductLocale() }),
        })
      }).catch((error) => {
        if (get().document.id === current.id) {
          const active = get().document
          set({
            document: active.name === nextName ? { ...active, name: current.name } : active,
            persistenceStatus: 'error',
            assistantMessage: canvasDocumentLifecycleAssistantMessage({ kind: 'renameFailed', locale: readProductLocale() }),
          })
        }
        throw error
      })
    },
  }
}
