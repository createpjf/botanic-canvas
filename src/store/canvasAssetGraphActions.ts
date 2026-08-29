import { defaultGenerationModels } from '../domain/canvas'
import type { Edge } from '@xyflow/react'
import { normalizeAssetCollection } from '../domain/assets'
import { normalizeAssetGroupName, upsertCollectionGroups } from '../domain/assetGroups'
import { mergeCollaborativeCanvasGraph } from '../domain/collaborativeGraph'
import { canvasNodeBounds, findOpenCanvasPosition } from '../domain/canvasNodeLayout'
import { hiddenGenerateIds, markStandaloneGeneratesOnManualConnect } from '../domain/canvasWorkingGenerate'
import { findOpenGeneratePosition, planGenerateNodeCreation } from '../domain/generateNodeCreation'
import {
  canvasGenerationReferences,
  clampBatchCount,
  cloneGenerationSettings,
  connectedGenerateInputs,
  defaultImageGenerationModel,
  defaultSettingsForModel,
  maximumReferencesForModel,
  normalizeGenerateNodeInputs,
} from '../domain/generationRecipe'
import type { CanvasGenerationReference } from '../domain/generationRecipe'
import { replaceMediaSources as replaceDocumentMediaSources } from '../domain/agentMedia'
import type {
  AssetGroup,
  AssetNodeData,
  AssetRecord,
  CanvasDocument,
  CanvasNode,
  GenerateNodeData,
  GenerationReference,
  PromptNodeData,
  ReferenceGroupNodeData,
  ResultNodeData,
  TextNodeData,
} from '../domain/canvas'
import { writeGlobalAssetLibrary } from '../lib/db'
import { availableAssets, findAvailableAsset, normalizeSystemOutputEdges } from './canvasDocumentAssets'
import { cleanDisplayName, migrationId, nextTaskFlowStartX, normalizeAssetReferenceNodes } from './canvasDocumentMigration'
import type { CanvasStore } from './canvasStore.types'

function placeOnCanvas(
  document: CanvasDocument,
  preferred: { x: number; y: number } | undefined,
  draft: Pick<CanvasNode, 'type' | 'data'>,
  alreadyPlaced: CanvasNode[] = [],
) {
  const hiddenIds = hiddenGenerateIds(document.nodes, document.edges)
  const size = canvasNodeBounds({
    id: 'placement',
    type: draft.type,
    position: { x: 0, y: 0 },
    data: draft.data,
  } as CanvasNode, hiddenIds)
  return findOpenCanvasPosition(
    [...document.nodes, ...alreadyPlaced],
    preferred ?? { x: 120, y: 120 },
    size,
    hiddenIds,
  )
}

type AssetGraphActions = Pick<CanvasStore,
  | 'setNodes'
  | 'replaceMediaSources'
  | 'setNodesTransient'
  | 'setEdges'
  | 'setViewport'
  | 'applyCollaborativeGraph'
  | 'selectNode'
  | 'setAssetReferenceEnabled'
  | 'setPrimaryProductReference'
  | 'moveGenerationReference'
  | 'applyGenerationRecipe'
  | 'addAssetToCanvas'
  | 'addUploadedAssets'
  | 'addUploadedAssetsToCanvas'
  | 'saveGeneratedImageToLibrary'
  | 'moveAssetToRole'
  | 'createAssetGroup'
  | 'renameAssetGroup'
  | 'deleteAssetGroup'
  | 'addAssetsToGroup'
  | 'removeAssetFromGroup'
  | 'addTextNode'
  | 'addGenerateNode'
  | 'createGenerateBranchFromResult'
  | 'createGenerateFromResultRecipe'
  | 'renameCanvasNode'
  | 'updateTextNode'
  | 'updateGenerateNode'
  | 'setGenerateNodePrimaryInput'
  | 'moveGenerateNodeInput'
  | 'setAvailableModels'
  | 'setMaximumBatchCount'
>

type CommitDocument = (
  document: CanvasDocument,
  extra?: Partial<CanvasStore>,
  options?: { immediate?: boolean; rejectOnFailure?: boolean },
) => Promise<void>

/** Owns canvas graph mutations, references, project assets and editable node commands. */
export function createCanvasAssetGraphActions({
  set,
  get,
  commitDocument,
}: {
  set: (next: Partial<CanvasStore>) => void
  get: () => CanvasStore
  commitDocument: CommitDocument
}): AssetGraphActions {
  return {
    setNodes: (nodes) => {
      const normalizedNodes = normalizeGenerateNodeInputs(nodes, get().document.edges)
      const synchronizedNodes = normalizedNodes.map((node) => ({
        ...node,
        data: node.type === 'result' ? { ...node.data, selected: Boolean(node.selected) } : { ...node.data },
      })) as CanvasNode[]
      const selected = synchronizedNodes.filter((node) => node.selected)
      void commitDocument({ ...get().document, nodes: synchronizedNodes }, { selectedNodeId: selected.length === 1 ? selected[0].id : null })
    },

    replaceMediaSources: async (replacements) => {
      if (!Object.keys(replacements).length) return
      const document = get().document
      const nextDocument = replaceDocumentMediaSources(document, replacements)
      if (nextDocument === document) return
      await commitDocument(nextDocument, { assistantMessage: '参考图片已准备完成。' }, { immediate: true })
    },

    setNodesTransient: (nodes) => {
      const synchronizedNodes = nodes.map((node) => ({
        ...node,
        data: node.type === 'result' ? { ...node.data, selected: Boolean(node.selected) } : { ...node.data },
      })) as CanvasNode[]
      const selected = synchronizedNodes.filter((node) => node.selected)
      set({ document: { ...get().document, nodes: synchronizedNodes }, selectedNodeId: selected.length === 1 ? selected[0].id : null })
    },

    setEdges: (edges) => {
      const document = get().document
      const normalizedEdges = normalizeSystemOutputEdges(document.nodes, edges)
      const nodes = markStandaloneGeneratesOnManualConnect(document.nodes, document.edges, normalizedEdges)
      void commitDocument({
        ...document,
        edges: normalizedEdges,
        nodes: normalizeGenerateNodeInputs(nodes, normalizedEdges),
      })
    },

    setViewport: (viewport) => {
      void commitDocument({ ...get().document, viewport })
    },

    applyCollaborativeGraph: ({ nodes, edges }) => {
      const current = get().document
      const synchronized = mergeCollaborativeCanvasGraph(
        { nodes: current.nodes, edges: current.edges },
        { nodes, edges },
      )
      const synchronizedNodeIds = new Set(synchronized.nodes.map((node) => node.id))
      const normalizedEdges = normalizeSystemOutputEdges(
        synchronized.nodes,
        synchronized.edges.filter((edge) => synchronizedNodeIds.has(edge.source) && synchronizedNodeIds.has(edge.target)),
      )
      const normalizedNodes = normalizeGenerateNodeInputs(synchronized.nodes, normalizedEdges)
      const selected = normalizedNodes.filter((node) => node.selected)
      set({
        document: { ...current, nodes: normalizedNodes, edges: normalizedEdges },
        selectedNodeId: selected.length === 1 ? selected[0].id : null,
      })
    },

    selectNode: (selectedNodeId) => {
      if (!selectedNodeId) {
        const nodes = get().document.nodes.map((node) => ({
          ...node,
          selected: false,
          data: node.type === 'result' ? { ...node.data, selected: false } : { ...node.data },
        })) as CanvasNode[]
        set({ document: { ...get().document, nodes }, selectedNodeId: null })
        return
      }
      const nodes = get().document.nodes.map((node) => ({
        ...node,
        selected: node.id === selectedNodeId,
        data: node.type === 'result' ? { ...node.data, selected: node.id === selectedNodeId } : { ...node.data },
      })) as CanvasNode[]
      set({ document: { ...get().document, nodes }, selectedNodeId })
    },

    setAssetReferenceEnabled: (nodeId, referenceEnabled) => {
      const document = get().document
      const target = document.nodes.find((node) => node.id === nodeId)
      if (!target || target.type !== 'asset') return
      const targetAsset = target.data as AssetNodeData
      if (targetAsset.primary && targetAsset.referenceEnabled !== false && !referenceEnabled) {
        const alternateProduct = document.nodes.find((node) => node.type === 'asset'
          && node.id !== nodeId
          && (node.data as AssetNodeData).role === '商品'
          && (node.data as AssetNodeData).referenceEnabled !== false)
        if (!alternateProduct) {
          set({ assistantMessage: `「${targetAsset.name}」是已锁定的主商品。请先加入另一张商品并设为主商品。` })
          return
        }
      }
      let nodes = document.nodes.map((node) => {
        if (node.type !== 'asset') return node
        const asset = node.data as AssetNodeData
        if (node.id !== nodeId) return { ...node, data: { ...asset } }
        return { ...node, data: { ...asset, referenceEnabled, primary: referenceEnabled ? asset.primary : false } }
      }) as CanvasNode[]
      const activeProducts = nodes.filter((node) => node.type === 'asset'
        && (node.data as AssetNodeData).role === '商品'
        && (node.data as AssetNodeData).referenceEnabled !== false)
      if (!activeProducts.some((node) => Boolean((node.data as AssetNodeData).primary)) && activeProducts.length) {
        nodes = nodes.map((node) => node.type === 'asset' && node.id === activeProducts[0].id
          ? { ...node, data: { ...(node.data as AssetNodeData), primary: true } }
          : node) as CanvasNode[]
      }
      void commitDocument({ ...document, nodes }, {
        assistantMessage: referenceEnabled
          ? `已让「${targetAsset.name}」参与本次生成。`
          : `已从本次生成参考中排除「${targetAsset.name}」。`,
      })
    },

    setPrimaryProductReference: (nodeId) => {
      const document = get().document
      const target = document.nodes.find((node) => node.id === nodeId)
      if (!target || target.type !== 'asset') return
      const targetAsset = target.data as AssetNodeData
      if (targetAsset.role !== '商品') {
        set({ assistantMessage: '只有「商品」角色可以锁定为主商品。' })
        return
      }
      const nodes = document.nodes.map((node) => {
        if (node.type !== 'asset') return node
        const asset = node.data as AssetNodeData
        if (asset.role !== '商品') return { ...node, data: { ...asset } }
        return { ...node, data: { ...asset, referenceEnabled: node.id === nodeId ? true : asset.referenceEnabled !== false, primary: node.id === nodeId } }
      }) as CanvasNode[]
      void commitDocument({ ...document, nodes }, { assistantMessage: `已锁定「${targetAsset.name}」为本次生成的主商品。` })
    },

    moveGenerationReference: (nodeId, direction) => {
      const document = get().document
      const references = canvasGenerationReferences(document).filter((reference) => reference.enabled)
      const target = references.find((reference) => reference.nodeId === nodeId)
      if (!target) return
      if (target.primary) {
        set({ assistantMessage: '主商品固定为 P1；可调整其余参考的顺序。' })
        return
      }
      const movable = references.filter((reference) => !reference.primary)
      const index = movable.findIndex((reference) => reference.nodeId === nodeId)
      const nextIndex = direction === 'earlier' ? index - 1 : index + 1
      if (index < 0 || nextIndex < 0 || nextIndex >= movable.length) {
        set({ assistantMessage: direction === 'earlier' ? '该参考已排在最前。' : '该参考已排在最后。' })
        return
      }
      const reordered = [...movable]
      ;[reordered[index], reordered[nextIndex]] = [reordered[nextIndex], reordered[index]]
      const ordered = [references.find((reference) => reference.primary), ...reordered].filter(Boolean) as CanvasGenerationReference[]
      const priorityByNodeId = new Map(ordered.map((reference, order) => [reference.nodeId, order + 1]))
      const nodes = document.nodes.map((node) => node.type === 'asset'
        ? { ...node, data: { ...(node.data as AssetNodeData), referencePriority: priorityByNodeId.get(node.id) ?? (node.data as AssetNodeData).referencePriority } }
        : node) as CanvasNode[]
      void commitDocument({ ...document, nodes }, { assistantMessage: `已调整「${target.name}」的参考优先级。` })
    },

    applyGenerationRecipe: (recipe) => {
      const document = get().document
      const referencesByNodeId = new Map(recipe.references.map((reference) => [reference.nodeId, reference]))
      const referencesByAssetId = new Map<string, GenerationReference[]>()
      for (const reference of recipe.references) referencesByAssetId.set(reference.assetId, [...(referencesByAssetId.get(reference.assetId) ?? []), reference])
      const usedReferences = new Set<GenerationReference>()
      const resolvedNodeIds = new Set<string>()
      let nodes = document.nodes.map((node) => {
        if (node.type !== 'asset') return node
        const asset = node.data as AssetNodeData
        const direct = referencesByNodeId.get(node.id)
        const reference = direct && !usedReferences.has(direct)
          ? direct
          : (referencesByAssetId.get(asset.assetId) ?? []).find((candidate) => !usedReferences.has(candidate))
        if (reference) {
          usedReferences.add(reference)
          resolvedNodeIds.add(node.id)
        }
        return { ...node, data: {
          ...asset,
          referenceEnabled: Boolean(reference),
          primary: Boolean(reference && (reference.primary || reference.nodeId === recipe.primaryReferenceNodeId)),
          referencePriority: reference?.priority ?? asset.referencePriority,
        } }
      }) as CanvasNode[]
      const remainingReferences = recipe.references.filter((reference) => !usedReferences.has(reference))
      const restored: CanvasNode[] = []
      remainingReferences.forEach((reference, index) => {
        const asset = findAvailableAsset(document, get().globalAssets, reference.assetId)
        if (!asset) return
        const nodeId = `asset-${asset.id}-restored-${Date.now()}-${index}`
        resolvedNodeIds.add(nodeId)
        const data = {
          kind: 'asset' as const, assetId: asset.id, role: asset.role, name: asset.name,
          image: asset.image, imageWidth: asset.imageWidth, imageHeight: asset.imageHeight,
          source: asset.source, mediaKind: asset.mediaKind ?? 'image', referenceEnabled: true,
          primary: Boolean(reference.primary || reference.nodeId === recipe.primaryReferenceNodeId),
          referencePriority: reference.priority,
        }
        restored.push({
          id: nodeId,
          type: 'asset',
          position: placeOnCanvas(document, undefined, { type: 'asset', data }, restored),
          draggable: true,
          data,
        })
      })
      nodes = normalizeAssetReferenceNodes([...nodes, ...restored] as CanvasNode[])
      const unavailable = remainingReferences.length - restored.length
      const restoredCount = nodes.filter((node) => node.type === 'asset' && resolvedNodeIds.has(node.id)).length
      void commitDocument({ ...document, nodes }, {
        assistantMessage: unavailable
          ? `已恢复 ${restoredCount} 个参考；${unavailable} 个已删除素材未加入下一次草稿。`
          : `已恢复 ${restoredCount} 个参考到下一次生成草稿。`,
      })
    },

    addAssetToCanvas: (assetId, dropPosition, connectToGenerateId) => {
      const document = get().document
      const asset = findAvailableAsset(document, get().globalAssets, assetId)
      if (!asset) return
      const assetNodes = document.nodes.filter((node) => node.type === 'asset')
      const nodeId = `asset-${asset.id}-${Date.now()}`
      const hasPrimaryProduct = assetNodes.some((item) => item.type === 'asset'
        && (item.data as AssetNodeData).role === '商品'
        && (item.data as AssetNodeData).referenceEnabled !== false
        && Boolean((item.data as AssetNodeData).primary))
      const data = {
        kind: 'asset' as const, assetId: asset.id, role: asset.role, name: asset.name, image: asset.image,
        imageWidth: asset.imageWidth, imageHeight: asset.imageHeight, source: asset.source,
        mediaKind: asset.mediaKind ?? 'image', referenceEnabled: true,
        primary: asset.role === '商品' && !hasPrimaryProduct, referencePriority: assetNodes.length + 1,
      }
      const node: CanvasNode = {
        id: nodeId,
        type: 'asset',
        position: placeOnCanvas(document, dropPosition, { type: 'asset', data }),
        draggable: true,
        selected: true,
        data,
      }
      const target = connectToGenerateId ? document.nodes.find((item) => item.id === connectToGenerateId && item.type === 'generate') : undefined
      const targetData = target?.type === 'generate' ? target.data as GenerateNodeData : undefined
      const targetModel = targetData
        ? get().availableModels.find((model) => model.id === targetData.settings.model)
        : undefined
      const maximumReferences = maximumReferencesForModel(targetModel)
      const connectedReferenceCount = target
        ? connectedGenerateInputs(document, target.id).filter((item) => item.type === 'asset' || item.type === 'result').length
        : 0
      const canConnect = Boolean(target && connectedReferenceCount < maximumReferences)
      const edges = canConnect && target
        ? [...document.edges, {
            id: `graph-edge-${nodeId}-${target.id}-${Date.now()}`,
            source: nodeId, sourceHandle: 'asset-output', target: target.id, targetHandle: 'input',
            type: 'default', style: { stroke: '#4f805b', strokeWidth: 1.6 }, reconnectable: true,
          }]
        : document.edges
      const nodes = normalizeGenerateNodeInputs([
        ...document.nodes.map((item) => ({ ...item, selected: target ? item.id === target.id : false })),
        { ...node, selected: !target },
      ] as CanvasNode[], edges)
      void commitDocument({ ...document, nodes, edges }, {
        selectedNodeId: target?.id ?? nodeId,
        assistantMessage: canConnect
          ? `已将「${asset.name}」加入画布，并连接到「${(target!.data as GenerateNodeData).label}」。`
          : target
            ? `已将「${asset.name}」加入画布；「${(target.data as GenerateNodeData).label}」最多可连接 ${maximumReferences} 个参考素材。`
            : `已将「${asset.name}」加入画布，可拖拽调整位置。`,
      })
    },

    addUploadedAssets: (uploads) => {
      if (!uploads.length) return
      const document = get().document
      const timestamp = Date.now()
      const assets: AssetRecord[] = uploads.map((upload, index) => ({
        id: `upload-${timestamp}-${index}`,
        role: upload.role,
        name: upload.name.trim() || `上传素材 ${String(index + 1).padStart(2, '0')}`,
        image: upload.image,
        imageWidth: upload.imageWidth,
        imageHeight: upload.imageHeight,
        source: 'upload',
        mediaKind: upload.mediaKind ?? 'image',
        collection: normalizeAssetCollection(upload.collection),
        tags: upload.tags.length ? [...new Set(upload.tags)] : ['上传素材'],
      }))
      void commitDocument({
        ...document,
        assets: [...assets, ...document.assets],
        assetGroups: upsertCollectionGroups(document.assetGroups, assets, timestamp),
      }, { assistantMessage: `已将 ${assets.length} 张本地素材存入当前项目素材库。拖入画布后，可将它们作为生成参考。` })
    },

    addUploadedAssetsToCanvas: (uploads, dropPosition) => {
      if (!uploads.length) return
      const document = get().document
      const timestamp = Date.now()
      const assets: AssetRecord[] = uploads.map((upload, index) => ({
        id: `upload-${timestamp}-${index}`,
        role: upload.role,
        name: upload.name.trim() || `上传素材 ${String(index + 1).padStart(2, '0')}`,
        image: upload.image,
        imageWidth: upload.imageWidth,
        imageHeight: upload.imageHeight,
        source: 'upload',
        mediaKind: upload.mediaKind ?? 'image',
        collection: normalizeAssetCollection(upload.collection),
        tags: upload.tags.length ? [...new Set(upload.tags)] : ['上传素材'],
      }))
      const existingAssetNodes = document.nodes.filter((node) => node.type === 'asset')
      let hasPrimaryProduct = existingAssetNodes.some((node) => node.type === 'asset'
        && (node.data as AssetNodeData).role === '商品'
        && (node.data as AssetNodeData).referenceEnabled !== false
        && Boolean((node.data as AssetNodeData).primary))
      const placed: CanvasNode[] = []
      const nodes = assets.map((asset, index) => {
        const shouldBePrimary = asset.role === '商品' && !hasPrimaryProduct
        if (shouldBePrimary) hasPrimaryProduct = true
        const data = {
          kind: 'asset' as const, assetId: asset.id, role: asset.role, name: asset.name, image: asset.image,
          imageWidth: asset.imageWidth, imageHeight: asset.imageHeight, source: 'upload' as const,
          mediaKind: asset.mediaKind ?? 'image', referenceEnabled: true, primary: shouldBePrimary,
          referencePriority: existingAssetNodes.length + index + 1,
        }
        const node = {
          id: `asset-${asset.id}`,
          type: 'asset' as const,
          position: placeOnCanvas(document, dropPosition, { type: 'asset', data }, placed),
          draggable: true,
          selected: index === 0,
          data,
        } as CanvasNode
        placed.push(node)
        return node
      })
      void commitDocument({
        ...document,
        assets: [...assets, ...document.assets],
        assetGroups: upsertCollectionGroups(document.assetGroups, assets, timestamp),
        nodes: [...document.nodes.map((node) => ({ ...node, selected: false })), ...nodes] as CanvasNode[],
      }, {
        selectedNodeId: nodes[0]?.id ?? null,
        assistantMessage: `已将 ${assets.length} 张本地图片直接加入画布，并同步存入当前项目素材库。`,
      })
    },

    saveGeneratedImageToLibrary: ({ image, name, mediaKind = 'image' }) => {
      const document = get().document
      if (document.assets.some((asset) => asset.source === 'generated' && asset.image === image)) {
        set({ assistantMessage: `「${name}」已在当前项目素材库中。` })
        return
      }
      const asset: AssetRecord = {
        id: `generated-library-${Date.now()}`,
        role: '首图',
        name: name.trim() || (mediaKind === 'video' ? '生成视频' : '生成图片'),
        image,
        source: 'generated',
        mediaKind,
        collection: '生成结果',
        tags: [mediaKind === 'video' ? '视频' : '首图', '画布入库'],
      }
      void commitDocument({ ...document, assets: [asset, ...document.assets] }, { assistantMessage: `已将「${asset.name}」存入当前项目素材库。` })
    },

    moveAssetToRole: (assetId, role) => {
      const document = get().document
      const globalAsset = get().globalAssets.find((asset) => asset.id === assetId)
      const localAsset = document.assets.find((asset) => asset.id === assetId)
      const target = globalAsset ?? localAsset
      if (!target || target.role === role) return
      const updateNodeRoles = (nodes: CanvasNode[]) => normalizeAssetReferenceNodes(nodes.map((node) => {
        if (node.type !== 'asset' || (node.data as AssetNodeData).assetId !== assetId) return node
        const assetNode = node.data as AssetNodeData
        return { ...node, data: { ...assetNode, role, primary: role === '商品' ? assetNode.primary : false } }
      }) as CanvasNode[])
      const nodes = updateNodeRoles(document.nodes)
      if (globalAsset) {
        const previousGlobalAssets = get().globalAssets
        const globalAssets = previousGlobalAssets.map((asset) => asset.id === assetId ? { ...asset, role } : asset)
        void commitDocument({ ...document, nodes }, { globalAssets, assistantMessage: `已将「${target.name}」移动到「${role}」分组。` })
        void writeGlobalAssetLibrary({ id: 'global-brand-assets', schemaVersion: 1, assets: globalAssets, updatedAt: Date.now() }).catch(() => {
          const activeDocument = get().document
          const activeGlobalAsset = get().globalAssets.find((asset) => asset.id === assetId)
          if (activeGlobalAsset?.role !== role) return
          const revertedNodes = activeDocument.id === document.id
            ? normalizeAssetReferenceNodes(activeDocument.nodes.map((node) => {
                if (node.type !== 'asset' || (node.data as AssetNodeData).assetId !== assetId) return node
                return { ...node, data: { ...(node.data as AssetNodeData), role: target.role } }
              }) as CanvasNode[])
            : activeDocument.nodes
          void commitDocument({ ...activeDocument, nodes: revertedNodes }, {
            globalAssets: previousGlobalAssets,
            assistantMessage: `「${target.name}」的分组未能保存，请重试。`,
          })
        })
        return
      }
      void commitDocument({
        ...document,
        nodes,
        assets: document.assets.map((asset) => asset.id === assetId ? { ...asset, role } : asset),
      }, { assistantMessage: `已将「${target.name}」移动到「${role}」分组。` })
    },

    createAssetGroup: (name, role, assetIds = []) => {
      const cleanName = normalizeAssetGroupName(name)
      if (!cleanName) return null
      const document = get().document
      const availableIds = new Set(availableAssets(document, get().globalAssets).map((asset) => asset.id))
      const normalizedAssetIds = [...new Set(assetIds)].filter((assetId) => availableIds.has(assetId))
      const timestamp = Date.now()
      const group: AssetGroup = {
        id: `asset-group-${timestamp}`, name: cleanName, role, assetIds: normalizedAssetIds,
        coverAssetId: normalizedAssetIds[0], createdAt: timestamp, updatedAt: timestamp,
      }
      void commitDocument({ ...document, assetGroups: [group, ...document.assetGroups] }, {
        assistantMessage: normalizedAssetIds.length
          ? `已创建素材组「${cleanName}」，并加入 ${normalizedAssetIds.length} 项素材。`
          : `已创建素材组「${cleanName}」。`,
      })
      return group.id
    },

    renameAssetGroup: (groupId, name) => {
      const cleanName = normalizeAssetGroupName(name)
      if (!cleanName) return
      const document = get().document
      if (!document.assetGroups.some((group) => group.id === groupId)) return
      void commitDocument({
        ...document,
        assetGroups: document.assetGroups.map((group) => group.id === groupId ? { ...group, name: cleanName, updatedAt: Date.now() } : group),
      }, { assistantMessage: `素材组已重命名为「${cleanName}」。` })
    },

    deleteAssetGroup: (groupId) => {
      const document = get().document
      const group = document.assetGroups.find((item) => item.id === groupId)
      if (!group) return
      void commitDocument({ ...document, assetGroups: document.assetGroups.filter((item) => item.id !== groupId) }, {
        assistantMessage: `已删除素材组「${group.name}」，组内素材仍保留在素材库。`,
      })
    },

    addAssetsToGroup: (groupId, assetIds) => {
      const document = get().document
      const availableIds = new Set(availableAssets(document, get().globalAssets).map((asset) => asset.id))
      const additions = [...new Set(assetIds)].filter((assetId) => availableIds.has(assetId))
      if (!additions.length || !document.assetGroups.some((group) => group.id === groupId)) return
      const timestamp = Date.now()
      void commitDocument({
        ...document,
        assetGroups: document.assetGroups.map((group) => {
          if (group.id !== groupId) return group
          const nextAssetIds = [...new Set([...group.assetIds, ...additions])]
          return { ...group, assetIds: nextAssetIds, coverAssetId: group.coverAssetId ?? nextAssetIds[0], updatedAt: timestamp }
        }),
      }, { assistantMessage: `已将 ${additions.length} 项素材加入素材组。` })
    },

    removeAssetFromGroup: (groupId, assetId) => {
      const document = get().document
      const group = document.assetGroups.find((item) => item.id === groupId)
      if (!group?.assetIds.includes(assetId)) return
      const assetIds = group.assetIds.filter((id) => id !== assetId)
      void commitDocument({
        ...document,
        assetGroups: document.assetGroups.map((item) => item.id === groupId
          ? { ...item, assetIds, coverAssetId: item.coverAssetId === assetId ? assetIds[0] : item.coverAssetId, updatedAt: Date.now() }
          : item),
      }, { assistantMessage: '已将素材移出当前素材组；素材原件仍保留。' })
    },

    addTextNode: (position, options) => {
      const document = get().document
      const select = options?.select ?? true
      const nodeId = `text-${Date.now()}`
      const data = { kind: 'text' as const, label: '视觉描述', content: '描述商品、场景、构图与留白要求' }
      const node: CanvasNode = {
        id: nodeId,
        type: 'text',
        position: placeOnCanvas(document, position, { type: 'text', data }),
        draggable: true,
        selected: select,
        data,
      }
      void commitDocument({
        ...document,
        nodes: select
          ? [...document.nodes.map((item) => ({ ...item, selected: false })), node] as CanvasNode[]
          : [...document.nodes, node] as CanvasNode[],
      }, select
        ? { selectedNodeId: nodeId, assistantMessage: '已创建文本节点；将右侧端口连到生成节点即可作为本次描述。' }
        : {})
      return nodeId
    },

    addGenerateNode: (position, mediaKind = 'image', inputNodeIds, options) => {
      const document = get().document
      const select = options?.select ?? true
      const nodeId = `generate-${Date.now()}`
      const matchingModel = defaultImageGenerationModel(get().availableModels, mediaKind)
      if (!matchingModel && mediaKind === 'video') {
        set({ assistantMessage: '视频模型尚未配置，请先检查 MiniMax H3。' })
        return null
      }
      const planned = planGenerateNodeCreation({
        nodes: document.nodes,
        nodeId,
        position: position ?? placeOnCanvas(document, { x: 470, y: 240 }, {
          type: 'generate',
          data: { kind: 'generate', label: '', prompt: '', batchCount: 1, settings: defaultSettingsForModel(matchingModel ?? defaultImageGenerationModel(get().availableModels, mediaKind)) },
        }),
        mediaKind,
        settings: defaultSettingsForModel(matchingModel ?? defaultImageGenerationModel(get().availableModels, mediaKind)),
        inputNodeIds,
        standalone: options?.standalone,
      })
      const node = { ...planned.node, selected: select }
      void commitDocument({
        ...document,
        nodes: select
          ? [...document.nodes.map((item) => ({ ...item, selected: false })), node] as CanvasNode[]
          : [...document.nodes, node] as CanvasNode[],
        edges: [...document.edges, ...planned.edges],
      }, select
        ? {
          selectedNodeId: nodeId,
          assistantMessage: planned.edges.length
            ? `已创建「${planned.node.data.label}」并连接所选输入。`
            : mediaKind === 'video'
              ? '已创建视频生成节点；连接首帧、首尾帧或参考素材后即可生成。'
              : '已创建图像生成节点；连接商品图片后，可直接填写描述并生成。',
        }
        : {})
      return nodeId
    },

    createGenerateBranchFromResult: (resultNodeId, draft) => {
      const document = get().document
      const parent = document.nodes.find((node) => node.id === resultNodeId && node.type === 'result')
      if (!parent || parent.type !== 'result') return null
      const result = parent.data as ResultNodeData
      if (!result.image) return null
      const timestamp = Date.now()
      const nodeId = `generate-branch-${timestamp}`
      const recipe = result.generationRecipe
      const defaultSettings = recipe?.settings ?? result.generationSettings
      const branchSettings = cloneGenerationSettings({ ...defaultSettings, ...draft?.settings })
      const branchModel = get().availableModels.find((model) => model.id === branchSettings.model)
      const branchMediaKind = branchModel?.mediaKind ?? (branchSettings.duration === undefined ? 'image' : 'video')
      const siblingBranchCount = document.edges.filter((edge) => edge.source === resultNodeId
        && document.nodes.some((node) => node.id === edge.target && node.type === 'generate')).length
      const planned = planGenerateNodeCreation({
        nodes: document.nodes,
        nodeId,
        position: findOpenGeneratePosition(document.nodes, {
          x: parent.position.x + 372,
          y: parent.position.y + 38 + siblingBranchCount * 238,
        }),
        mediaKind: branchMediaKind,
        settings: branchSettings,
        inputNodeIds: [resultNodeId],
      })
      const node: CanvasNode = {
        ...planned.node,
        data: {
          ...planned.node.data,
          prompt: draft?.prompt ?? '',
          batchCount: Math.min(get().maximumBatchCount, clampBatchCount(draft?.batchCount ?? recipe?.batchCount ?? 1)),
          refinementMode: draft?.refinementMode ?? 'faithful',
        },
      }
      const nodes = [
        ...document.nodes.map((item) => ({
          ...item,
          selected: false,
          data: item.type === 'result' ? { ...item.data, selected: false } : { ...item.data },
        })),
        node,
      ] as CanvasNode[]
      void commitDocument({ ...document, nodes, edges: [...document.edges, ...planned.edges] }, {
        selectedNodeId: nodeId,
        assistantMessage: `已基于「${result.label ?? '已选输出'}」创建下一版本生成节点。`,
      })
      return nodeId
    },

    createGenerateFromResultRecipe: (resultNodeId) => {
      const document = get().document
      const resultNode = document.nodes.find((node) => node.id === resultNodeId && node.type === 'result')
      if (!resultNode || resultNode.type !== 'result') return null
      const result = resultNode.data as ResultNodeData
      const recipe = result.rootRecipe ?? result.generationRecipe
      if (!recipe) return null
      const timestamp = Date.now()
      const usedNodeIds = new Set(document.nodes.map((node) => node.id))
      const nodeId = migrationId(`generate-recipe-${timestamp}`, usedNodeIds)
      const orderedReferences = recipe.references
        .map((reference, index) => ({ reference, index }))
        .sort((left, right) => (left.reference.priority ?? left.index + 1) - (right.reference.priority ?? right.index + 1) || left.index - right.index)
      const usedAssetNodeIds = new Set<string>()
      const restoredAssetNodes: CanvasNode[] = []
      const restoredInputs = orderedReferences.flatMap(({ reference }) => {
        const direct = document.nodes.find((node) => node.id === reference.nodeId && node.type === 'asset' && !usedAssetNodeIds.has(node.id))
        const fallback = direct ?? document.nodes.find((node) => node.type === 'asset'
          && (node.data as AssetNodeData).assetId === reference.assetId
          && !usedAssetNodeIds.has(node.id))
        if (fallback?.type === 'asset') {
          usedAssetNodeIds.add(fallback.id)
          return [{ reference, nodeId: fallback.id }]
        }
        const asset = findAvailableAsset(document, get().globalAssets, reference.assetId)
        if (!asset) return []
        const restoredNodeId = migrationId(`asset-${asset.id}-recipe-${timestamp}`, usedNodeIds)
        const data = {
          kind: 'asset' as const, assetId: asset.id, role: asset.role, name: asset.name, image: asset.image,
          imageWidth: asset.imageWidth, imageHeight: asset.imageHeight, source: asset.source,
          referenceEnabled: true,
          primary: Boolean(reference.primary || reference.nodeId === recipe.primaryReferenceNodeId),
          referencePriority: reference.priority,
        }
        restoredAssetNodes.push({
          id: restoredNodeId,
          type: 'asset',
          position: placeOnCanvas(document, undefined, { type: 'asset', data }, restoredAssetNodes),
          draggable: true,
          data,
        })
        usedAssetNodeIds.add(restoredNodeId)
        return [{ reference, nodeId: restoredNodeId }]
      })
      const primaryReference = orderedReferences.find(({ reference }) => reference.nodeId === recipe.primaryReferenceNodeId && reference.role === '商品')?.reference
        ?? orderedReferences.find(({ reference }) => reference.role === '商品' && Boolean(reference.primary))?.reference
      const primaryInputId = restoredInputs.find((input) => input.reference === primaryReference)?.nodeId
      const node: CanvasNode = {
        id: nodeId,
        type: 'generate',
        position: { x: Math.max(resultNode.position.x + 372, nextTaskFlowStartX(document.nodes)), y: resultNode.position.y + 38 },
        draggable: true,
        selected: true,
        data: {
          kind: 'generate', label: '复用原始参考重做首图', prompt: recipe.prompt,
          batchCount: Math.min(get().maximumBatchCount, clampBatchCount(recipe.batchCount)),
          settings: cloneGenerationSettings(recipe.settings),
          inputOrder: restoredInputs.map((input) => input.nodeId),
          primaryInputId,
          standalone: true,
        },
      }
      const usedEdgeIds = new Set(document.edges.map((edge) => edge.id))
      const restoredEdges: Edge[] = restoredInputs.map((input, index) => ({
        id: migrationId(`recipe-input-${timestamp}-${index}`, usedEdgeIds),
        source: input.nodeId, sourceHandle: 'asset-output', target: nodeId, targetHandle: 'input',
        type: 'default', style: { stroke: '#4f805b', strokeWidth: 1.6 }, reconnectable: true,
      }))
      const edges = [...document.edges, ...restoredEdges]
      const nodes = normalizeGenerateNodeInputs([
        ...document.nodes.map((item) => ({
          ...item,
          selected: false,
          data: item.type === 'result' ? { ...item.data, selected: false } : { ...item.data },
        })),
        ...restoredAssetNodes,
        node,
      ] as CanvasNode[], edges)
      const missingReferenceCount = recipe.references.length - restoredInputs.length
      void commitDocument({ ...document, nodes, edges }, {
        selectedNodeId: nodeId,
        assistantMessage: missingReferenceCount
          ? `已从「${result.label ?? '已选输出'}」新建独立首图节点，恢复 ${restoredInputs.length} 个原始参考；${missingReferenceCount} 个素材已不在画布中。`
          : `已从「${result.label ?? '已选输出'}」新建独立首图节点，并恢复原始参数与 ${restoredInputs.length} 个参考。`,
      })
      return nodeId
    },

    renameCanvasNode: (nodeId, label) => {
      const nextLabel = cleanDisplayName(label, '')
      if (!nextLabel) return
      const document = get().document
      const nodes = document.nodes.map((node) => {
        if (node.id !== nodeId) return node
        if (node.type === 'asset') return { ...node, data: { ...(node.data as AssetNodeData), name: nextLabel } }
        if (node.type === 'text') return { ...node, data: { ...(node.data as TextNodeData), label: nextLabel } }
        if (node.type === 'generate') return { ...node, data: { ...(node.data as GenerateNodeData), label: nextLabel } }
        if (node.type === 'prompt') return { ...node, data: { ...(node.data as PromptNodeData), label: nextLabel } }
        if (node.type === 'reference') return { ...node, data: { ...(node.data as ReferenceGroupNodeData), label: nextLabel } }
        return { ...node, data: { ...(node.data as ResultNodeData), label: nextLabel } }
      }) as CanvasNode[]
      void commitDocument({ ...document, nodes })
    },

    updateTextNode: (nodeId, content) => {
      const document = get().document
      const nodes = document.nodes.map((node) => node.id === nodeId && node.type === 'text'
        ? { ...node, data: { ...(node.data as TextNodeData), content } }
        : node) as CanvasNode[]
      void commitDocument({ ...document, nodes })
    },

    updateGenerateNode: (nodeId, patch) => {
      const document = get().document
      const nodes = document.nodes.map((node) => {
        if (node.id !== nodeId || node.type !== 'generate') return node
        const current = node.data as GenerateNodeData
        return { ...node, data: {
          ...current,
          ...patch,
          batchCount: patch.batchCount === undefined ? current.batchCount : clampBatchCount(patch.batchCount),
          settings: patch.settings ? cloneGenerationSettings(patch.settings) : cloneGenerationSettings(current.settings),
        } }
      }) as CanvasNode[]
      void commitDocument({ ...document, nodes })
    },

    setGenerateNodePrimaryInput: (nodeId, assetNodeId) => {
      const document = get().document
      const target = document.nodes.find((node) => node.id === assetNodeId && node.type === 'asset')
      const isConnected = document.edges.some((edge) => edge.source === assetNodeId && edge.target === nodeId)
      if (!target || !isConnected) return
      const nodes = document.nodes.map((node) => node.id === nodeId && node.type === 'generate'
        ? { ...node, data: { ...(node.data as GenerateNodeData), primaryInputId: assetNodeId } }
        : node) as CanvasNode[]
      void commitDocument({ ...document, nodes }, { assistantMessage: `已将「${(target.data as AssetNodeData).name}」设为当前生成节点的主商品。` })
    },

    moveGenerateNodeInput: (nodeId, inputNodeId, direction) => {
      const document = get().document
      const generate = document.nodes.find((node) => node.id === nodeId && node.type === 'generate')
      if (!generate || generate.type !== 'generate') return
      const connected = connectedGenerateInputs(document, nodeId).map((node) => node.id)
      const current = generate.data as GenerateNodeData
      const inputOrder = [
        ...(current.inputOrder ?? []).filter((inputId) => connected.includes(inputId)),
        ...connected.filter((inputId) => !(current.inputOrder ?? []).includes(inputId)),
      ]
      const index = inputOrder.indexOf(inputNodeId)
      const nextIndex = direction === 'earlier' ? index - 1 : index + 1
      if (index < 0 || nextIndex < 0 || nextIndex >= inputOrder.length) return
      ;[inputOrder[index], inputOrder[nextIndex]] = [inputOrder[nextIndex], inputOrder[index]]
      const nodes = document.nodes.map((node) => node.id === nodeId && node.type === 'generate'
        ? { ...node, data: { ...(node.data as GenerateNodeData), inputOrder } }
        : node) as CanvasNode[]
      void commitDocument({ ...document, nodes }, { assistantMessage: '已调整当前生成节点的输入顺序。' })
    },

    setAvailableModels: (models) => {
      const seen = new Set<string>()
      const availableModels = models
        .filter((model) => typeof model?.id === 'string' && model.id.trim())
        .filter((model) => {
          if (seen.has(model.id)) return false
          seen.add(model.id)
          return true
        })
        .map((model) => ({ ...model, id: model.id, label: model.label?.trim() || model.id }))
      set({ availableModels: availableModels.length ? availableModels : defaultGenerationModels.map((model) => ({ ...model })) })
    },

    setMaximumBatchCount: (count) => {
      const maximumBatchCount = Math.max(1, Math.round(count) || 1)
      const document = get().document
      const nodes = document.nodes.map((node) => node.type === 'generate'
        ? { ...node, data: {
            ...(node.data as GenerateNodeData),
            batchCount: Math.min(maximumBatchCount, clampBatchCount((node.data as GenerateNodeData).batchCount)),
          } }
        : node) as CanvasNode[]
      void commitDocument({ ...document, nodes }, { maximumBatchCount })
    },
  }
}
