import { createEmptyCanvasDocument, seedGlobalAssets } from '../data/seed'
import type { CanvasDocument, ResultNodeData } from '../domain/canvas'
import { createLatestOperation } from '../domain/latestOperation'
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
    const recoveredGeneration = restoreGenerationLifecycleState(document, '已同步其他设备的更新。')
    set({
      document,
      persistenceStatus: 'saved',
      selectedNodeId: selectedNode?.id ?? null,
      ...recoveredGeneration.state,
      assistantMessage: recoveredGeneration.state.generationStatus === 'recovering'
        ? recoveredGeneration.state.assistantMessage
        : '已同步其他设备的更新。',
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
        document.nodes.length ? `已打开「${document.name}」。` : `「${document.name}」已创建，可以从素材或一句话开始。`,
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
      await flushPendingCanvasDocumentWrites().catch(() => undefined)
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
        document.nodes.length ? `已打开「${document.name}」。` : `「${document.name}」已创建，可以从素材或一句话开始。`,
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
      if (baseline.id === 'workspace-placeholder') return false
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
        document.nodes.length ? `已打开「${document.name}」。` : `「${document.name}」已创建，可以从素材或一句话开始。`,
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
        assistantMessage: `正在重命名为「${nextName}」。`,
      })
      return renameCanvasProject(current.id, nextName).then((saved) => {
        if (get().document.id !== current.id) return
        const active = get().document
        set({
          document: { ...active, name: saved.name, updatedAt: Math.max(active.updatedAt, saved.updatedAt) },
          persistenceStatus: 'saved',
          assistantMessage: `项目已重命名为「${nextName}」。`,
        })
      }).catch((error) => {
        if (get().document.id === current.id) {
          const active = get().document
          set({
            document: active.name === nextName ? { ...active, name: current.name } : active,
            persistenceStatus: 'error',
            assistantMessage: '项目重命名失败，请检查网络后重试。',
          })
        }
        throw error
      })
    },
  }
}
