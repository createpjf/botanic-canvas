import { createEmptyCanvasDocument } from '../data/seed'
import { summarizeWorkflowTemplate } from '../domain/workflowTemplates'
import type {
  AssetNodeData,
  CanvasDocument,
  CanvasHistoryEntry,
  CanvasNode,
  CanvasTemplate,
  GlobalWorkflowTemplateLibrary,
  ResultNodeData,
} from '../domain/canvas'
import {
  readGlobalWorkflowTemplateLibrary,
  writeGlobalWorkflowTemplateLibrary,
} from '../lib/db'
import {
  availableAssets,
  cloneEdges,
  cloneNodes,
  sharedWorkflowTemplateSnapshot,
  snapshotThumbnail,
  workflowTemplateSnapshot,
  workflowTemplateSnapshotFromSnapshot,
} from './canvasDocumentAssets'
import type { CanvasStore } from './canvasStore.types'
import { cloneTemplateSnapshot, projectAssetsForTemplate } from './canvasTemplateHistoryModel'

type SetCanvasStore = (next: Partial<CanvasStore>) => void
type CommitCanvasDocument = (
  set: SetCanvasStore,
  document: CanvasDocument,
  extra?: Partial<CanvasStore>,
) => Promise<void>

type CanvasTemplateHistoryDependencies = {
  set: SetCanvasStore
  get: () => CanvasStore
  commit: CommitCanvasDocument
  editingBlocked: () => boolean
  now?: () => number
}

function instantiateWorkflowTemplateDocument(
  current: CanvasDocument,
  template: CanvasTemplate,
  shared: boolean,
  timestamp: number,
) {
  const cloned = cloneTemplateSnapshot(template.snapshot, shared ? 'shared-template' : 'template', timestamp)
  const name = template.name.trim() || '新项目'
  const project = createEmptyCanvasDocument(`project-${timestamp}`, name)
  const historyEntry: CanvasHistoryEntry = {
    id: `history-template-${timestamp}`,
    name: `${template.name} · 初始模板`,
    image: template.image,
    createdAt: timestamp,
    kind: 'template',
    sourceTemplateId: template.id,
    snapshot: {
      name,
      nodes: cloneNodes(cloned.nodes),
      edges: cloneEdges(cloned.edges),
      viewport: { x: 0, y: 0, zoom: 1 },
    },
  }
  return {
    ...project,
    nodes: cloned.nodes,
    edges: cloned.edges,
    viewport: { x: 0, y: 0, zoom: 1 },
    assets: projectAssetsForTemplate(current.assets, cloned.nodes, shared),
    history: [historyEntry],
    activeTemplateId: template.id,
    activeVersionId: historyEntry.id,
  }
}

/** 模板发布、模板建图和历史恢复的单一命令模块。 */
export function createCanvasTemplateHistoryActions({
  set,
  get,
  commit,
  editingBlocked,
  now = Date.now,
}: CanvasTemplateHistoryDependencies): Pick<CanvasStore,
  | 'saveCurrentAsTemplate'
  | 'refreshSharedTemplates'
  | 'saveCurrentAsSharedTemplate'
  | 'createCanvasFromTemplate'
  | 'createCanvasFromSharedTemplate'
  | 'createDocumentFromTemplate'
  | 'createCanvasFromHistory'
  | 'restoreHistoryVersion'
  | 'saveHistoryAsTemplate'
> {
  const applyTemplateToCurrentCanvas = (template: CanvasTemplate, shared: boolean) => {
    const document = get().document
    const timestamp = now()
    const nextName = `${template.name} · 新画布`
    const cloned = cloneTemplateSnapshot(template.snapshot, shared ? 'shared-template' : 'template', timestamp)
    const historyEntry: CanvasHistoryEntry = {
      id: `history-${shared ? 'shared-' : ''}template-${timestamp}`,
      name: nextName,
      image: template.image,
      createdAt: timestamp,
      kind: 'template',
      parentVersionId: document.activeVersionId,
      sourceTemplateId: template.id,
      snapshot: {
        name: nextName,
        nodes: cloneNodes(cloned.nodes),
        edges: cloneEdges(cloned.edges),
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    }

    void commit(set, {
      ...document,
      name: nextName,
      nodes: cloned.nodes,
      edges: cloned.edges,
      viewport: { x: 0, y: 0, zoom: 1 },
      activeTemplateId: template.id,
      activeVersionId: historyEntry.id,
      history: [...document.history, historyEntry],
    }, {
      selectedNodeId: null,
      assistantMessage: shared
        ? `已从共享工作流「${template.name}」新建画布，可补充项目素材后生成。`
        : `已从工作流模板「${template.name}」新建画布，可继续补充素材并生成。`,
    })
  }

  return {
    saveCurrentAsTemplate: (name) => {
      const document = get().document
      if (!summarizeWorkflowTemplate(document.nodes, document.edges).canSave) {
        set({ assistantMessage: '请先添加素材、描述或生成节点，再保存为模板。' })
        return
      }
      const cleanedName = name.trim() || `${document.name} · 模板`
      const timestamp = now()
      const template: CanvasTemplate = {
        id: `template-${timestamp}`,
        name: cleanedName,
        image: snapshotThumbnail(document.nodes, availableAssets(document, get().globalAssets)[0]?.image ?? ''),
        createdAt: timestamp,
        sourceHistoryId: document.activeVersionId,
        snapshot: workflowTemplateSnapshot(document, cleanedName),
      }
      void commit(set, { ...document, templates: [template, ...document.templates] }, {
        assistantMessage: `已将当前画布保存为模板「${cleanedName}」。`,
      })
    },

    refreshSharedTemplates: async () => {
      const library = await readGlobalWorkflowTemplateLibrary()
      set({ sharedTemplates: library?.templates ?? [] })
    },

    saveCurrentAsSharedTemplate: async (name) => {
      if (editingBlocked()) return false
      const document = get().document
      if (!summarizeWorkflowTemplate(document.nodes, document.edges, true).canSave) {
        set({ assistantMessage: '请先添加素材、描述或生成节点，再保存为共享模板。' })
        return false
      }
      const cleanedName = name.trim() || `${document.name} · 模板`
      let existingTemplates = get().sharedTemplates
      try {
        const library = await readGlobalWorkflowTemplateLibrary()
        existingTemplates = library?.templates ?? []
      } catch {
        if (get().document.id === document.id) set({ assistantMessage: '共享模板库暂时不可用，请检查网络后重试。' })
        return false
      }
      if (editingBlocked() || get().document.id !== document.id) return false
      const { snapshot, omittedPrivateAssetCount } = sharedWorkflowTemplateSnapshot(document, cleanedName)
      const image = snapshot.nodes.find((node) => node.type === 'asset' && (node.data as AssetNodeData).source === 'brand')
      const timestamp = now()
      const template: CanvasTemplate = {
        id: `shared-template-${timestamp}`,
        name: cleanedName,
        image: image ? (image.data as AssetNodeData).image : '',
        createdAt: timestamp,
        sourceHistoryId: document.activeVersionId,
        snapshot,
      }
      const nextTemplates = [template, ...existingTemplates]
      const library: GlobalWorkflowTemplateLibrary = {
        id: 'global-workflow-templates',
        schemaVersion: 1,
        templates: nextTemplates,
        updatedAt: timestamp,
      }
      try {
        if (editingBlocked() || get().document.id !== document.id) return false
        await writeGlobalWorkflowTemplateLibrary(library)
        set({
          sharedTemplates: nextTemplates,
          ...(get().document.id === document.id ? {
            assistantMessage: omittedPrivateAssetCount
              ? `已发布共享工作流「${cleanedName}」，已移除 ${omittedPrivateAssetCount} 个项目私有素材。`
              : `已发布共享工作流「${cleanedName}」。`,
          } : {}),
        })
        return true
      } catch {
        set({
          sharedTemplates: existingTemplates,
          ...(get().document.id === document.id ? { assistantMessage: '共享模板保存失败，请检查网络后重试。' } : {}),
        })
        return false
      }
    },

    createCanvasFromTemplate: (templateId) => {
      const template = get().document.templates.find((item) => item.id === templateId)
      if (template) applyTemplateToCurrentCanvas(template, false)
    },

    createCanvasFromSharedTemplate: (templateId) => {
      const template = get().sharedTemplates.find((item) => item.id === templateId)
      if (template) applyTemplateToCurrentCanvas(template, true)
    },

    createDocumentFromTemplate: (templateId, shared) => {
      const template = shared
        ? get().sharedTemplates.find((item) => item.id === templateId)
        : get().document.templates.find((item) => item.id === templateId)
      return template ? instantiateWorkflowTemplateDocument(get().document, template, shared, now()) : null
    },

    createCanvasFromHistory: (historyId) => {
      const document = get().document
      const source = document.history.find((item) => item.id === historyId)
      if (!source) return
      const timestamp = now()
      const nextName = `${source.name} · 延展`
      const cloned = cloneTemplateSnapshot(source.snapshot, 'history', timestamp)
      const historyEntry: CanvasHistoryEntry = {
        id: `history-continue-${timestamp}`,
        name: nextName,
        image: source.image,
        createdAt: timestamp,
        kind: 'generation',
        parentVersionId: source.id,
        snapshot: {
          name: nextName,
          nodes: cloneNodes(cloned.nodes),
          edges: cloneEdges(cloned.edges),
          viewport: { x: 0, y: 0, zoom: 1 },
        },
      }
      void commit(set, {
        ...document,
        name: nextName,
        nodes: cloned.nodes,
        edges: cloned.edges,
        viewport: { x: 0, y: 0, zoom: 1 },
        activeTemplateId: undefined,
        activeVersionId: historyEntry.id,
        history: [...document.history, historyEntry],
      }, {
        selectedNodeId: null,
        assistantMessage: `已基于「${source.name}」创建延展画布，下一次生成会作为它的分支。`,
      })
    },

    restoreHistoryVersion: (historyId) => {
      const document = get().document
      const source = document.history.find((item) => item.id === historyId)
      if (!source) return
      const lastResult = [...source.snapshot.nodes].reverse().find((node) => node.type === 'result')
      const selectedNodeId = lastResult?.id ?? null
      const nodes = cloneNodes(source.snapshot.nodes).map((node) => ({
        ...node,
        selected: node.id === selectedNodeId,
        data: node.type === 'result'
          ? { ...node.data, selected: node.id === selectedNodeId } as ResultNodeData
          : { ...node.data },
      })) as CanvasNode[]
      void commit(set, {
        ...document,
        name: source.snapshot.name,
        nodes,
        edges: cloneEdges(source.snapshot.edges),
        viewport: { ...source.snapshot.viewport },
        activeVersionId: source.id,
      }, {
        selectedNodeId,
        assistantMessage: `已回到「${source.name}」。历史分支均保留，可继续在此版定向精修。`,
      })
    },

    saveHistoryAsTemplate: (historyId) => {
      const document = get().document
      const source = document.history.find((item) => item.id === historyId)
      if (!source) return
      const timestamp = now()
      const template: CanvasTemplate = {
        id: `template-history-${timestamp}`,
        name: `${source.name} · 模板`,
        image: source.image,
        createdAt: timestamp,
        sourceHistoryId: source.id,
        snapshot: workflowTemplateSnapshotFromSnapshot(source.snapshot, `${source.name} · 模板`),
      }
      void commit(set, { ...document, templates: [template, ...document.templates] }, {
        assistantMessage: `已将历史画布「${source.name}」保存为可复用模板。`,
      })
    },
  }
}
