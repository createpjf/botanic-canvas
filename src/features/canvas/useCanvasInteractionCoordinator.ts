import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type RefObject } from 'react'
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type OnEdgesChange,
  type OnNodesChange,
} from '@xyflow/react'
import { beginCanvasFileDrag, endCanvasFileDrag, hasFileDragPayload } from '../../domain/canvasFileDrag'
import { layoutCanvasNodes } from '../../domain/canvasNodeLayout'
import { canvasZoomMode } from '../../domain/canvasPresentation'
import type {
  AssetNodeData,
  AssetRecord,
  CanvasDocument,
  CanvasNode,
  GenerateNodeData,
  ResultNodeData,
  UploadedAssetInput,
} from '../../domain/canvas'
import { readUploadedAssetInput, validateUploadFiles } from '../../lib/uploadedAssets'
import { useProductI18n } from '../../i18n/react'
import { useCanvasStore } from '../../store/canvasStore'

export type ScreenToFlowPosition = (position: { x: number; y: number }) => { x: number; y: number }

const canvasViewportStoragePrefix = 'botanic-canvas-viewport:v2:'

export function readCachedCanvasViewport(documentId: string) {
  try {
    const value = JSON.parse(window.localStorage.getItem(`${canvasViewportStoragePrefix}${documentId}`) ?? '') as Partial<{ x: number; y: number; zoom: number }>
    if (Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.zoom) && value.zoom! > 0) {
      return { x: value.x!, y: value.y!, zoom: value.zoom! }
    }
  } catch {
    // Fall back to the persisted document viewport.
  }
  return undefined
}

function cacheCanvasViewport(documentId: string, viewport: { x: number; y: number; zoom: number }) {
  try {
    window.localStorage.setItem(`${canvasViewportStoragePrefix}${documentId}`, JSON.stringify(viewport))
  } catch {
    // The document remains the persistence authority when local storage is unavailable.
  }
}

type UseCanvasInteractionCoordinatorOptions = {
  document: CanvasDocument
  hydrated: boolean
  restoredViewportZoom: number
  hiddenResultNodeIds: Set<string>
  focusedLineageEdgeIds: Set<string>
  hasLineageFocus: boolean
  assetLibraryAssets: AssetRecord[]
  assetLibraryTargetGenerateId: string | null
  screenToFlowPositionRef: RefObject<ScreenToFlowPosition | null>
  canvasPaneRef: RefObject<HTMLElement | null>
  viewportReadyRef: RefObject<boolean>
  onSelectionReset: () => void
}

/** Coordinates React Flow mutations, viewport persistence, connections and file drops. */
export function useCanvasInteractionCoordinator({
  document,
  hydrated,
  restoredViewportZoom,
  hiddenResultNodeIds,
  focusedLineageEdgeIds,
  hasLineageFocus,
  assetLibraryAssets,
  assetLibraryTargetGenerateId,
  screenToFlowPositionRef,
  canvasPaneRef,
  viewportReadyRef,
  onSelectionReset,
}: UseCanvasInteractionCoordinatorOptions) {
  const { locale } = useProductI18n()
  const setNodes = useCanvasStore((state) => state.setNodes)
  const setNodesTransient = useCanvasStore((state) => state.setNodesTransient)
  const setEdges = useCanvasStore((state) => state.setEdges)
  const setViewport = useCanvasStore((state) => state.setViewport)
  const addAssetToCanvas = useCanvasStore((state) => state.addAssetToCanvas)
  const addUploadedAssetsToCanvas = useCanvasStore((state) => state.addUploadedAssetsToCanvas)

  const pendingNodePositionSaveRef = useRef(false)
  const canvasFileDragDepthRef = useRef(0)
  const [zoomMode, setZoomMode] = useState(() => canvasZoomMode(restoredViewportZoom))
  const [isConnecting, setIsConnecting] = useState(false)
  const [connectionFeedback, setConnectionFeedback] = useState<'connected' | 'invalid' | 'cancelled' | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [edgeActionPosition, setEdgeActionPosition] = useState<{ x: number; y: number } | null>(null)
  const [isCanvasFileDragging, setIsCanvasFileDragging] = useState(false)
  const [canvasUploadMessage, setCanvasUploadMessage] = useState('')

  useEffect(() => {
    setZoomMode(canvasZoomMode(restoredViewportZoom))
  }, [document.id, restoredViewportZoom])

  useEffect(() => {
    if (!connectionFeedback) return
    const timer = window.setTimeout(() => setConnectionFeedback(null), 1_100)
    return () => window.clearTimeout(timer)
  }, [connectionFeedback])

  const onNodesChange: OnNodesChange<CanvasNode> = useCallback((changes) => {
    if (!hydrated) return
    const nextNodes = applyNodeChanges(changes, useCanvasStore.getState().document.nodes)
    if (changes.every((change) => change.type === 'select')) {
      setNodesTransient(nextNodes)
      return
    }
    const positionOnly = changes.length > 0 && changes.every((change) => change.type === 'position')
    const dragging = positionOnly && changes.some((change) => change.type === 'position' && change.dragging === true)
    if (dragging) {
      pendingNodePositionSaveRef.current = true
      setNodesTransient(nextNodes)
      return
    }
    if (positionOnly) pendingNodePositionSaveRef.current = false
    setNodes(nextNodes)
  }, [hydrated, setNodes, setNodesTransient])

  const persistDraggedNodes = useCallback(() => {
    if (!hydrated || !pendingNodePositionSaveRef.current) return
    pendingNodePositionSaveRef.current = false
    setNodes(useCanvasStore.getState().document.nodes)
  }, [hydrated, setNodes])

  const onEdgesChange: OnEdgesChange = useCallback((changes) => {
    if (!hydrated) return
    const currentEdges = useCanvasStore.getState().document.edges
    const protectedEdgeIds = new Set(currentEdges.filter((edge) => Boolean(edge.data?.system)).map((edge) => edge.id))
    const safeChanges = changes.filter((change) => change.type !== 'remove' || !protectedEdgeIds.has(change.id))
    setEdges(applyEdgeChanges(safeChanges, currentEdges))
  }, [hydrated, setEdges])

  const persistViewport = useCallback((viewport: CanvasDocument['viewport']) => {
    if (!hydrated) return
    cacheCanvasViewport(document.id, viewport)
    setViewport(viewport)
  }, [document.id, hydrated, setViewport])

  const onMoveEnd = useCallback((event: unknown, viewport: CanvasDocument['viewport']) => {
    if (!event || !hydrated || !viewportReadyRef.current) return
    persistViewport(viewport)
  }, [hydrated, persistViewport, viewportReadyRef])

  const onCanvasMove = useCallback((_event: unknown, viewport: CanvasDocument['viewport']) => {
    const nextMode = canvasZoomMode(viewport.zoom)
    setZoomMode((current) => current === nextMode ? current : nextMode)
  }, [])

  const autoLayoutCanvas = useCallback(() => {
    if (!document.nodes.length) return
    setNodes(layoutCanvasNodes(document.nodes, document.edges))
  }, [document.edges, document.nodes, setNodes])

  const onSelectionChange = useCallback(({ nodes, edges }: { nodes: CanvasNode[]; edges: Edge[] }) => {
    if (edges.length === 1) {
      setSelectedEdgeId(edges[0].id)
      return
    }
    if (nodes.length === 1) return
    setSelectedEdgeId(null)
    setEdgeActionPosition(null)
    onSelectionReset()
  }, [onSelectionReset])

  const setScreenToFlowPosition = useCallback((mapper: ScreenToFlowPosition) => {
    screenToFlowPositionRef.current = mapper
  }, [screenToFlowPositionRef])

  const addDroppedFilesToCanvas = useCallback(async (files: File[], position: { x: number; y: number }) => {
    const projectId = document.id
    const { accepted, message } = validateUploadFiles(files, locale)
    const imageFiles = accepted.slice(0, 12)
    setCanvasUploadMessage(message)
    if (!imageFiles.length) return
    const hasProduct = document.nodes.some((node) => node.type === 'asset' && (node.data as AssetNodeData).role === '商品')
    const loaded = await Promise.allSettled(imageFiles.map((file, index) => readUploadedAssetInput(
      file,
      !hasProduct && index === 0 ? '商品' : '场景',
    )))
    const uploads = loaded
      .filter((result): result is PromiseFulfilledResult<UploadedAssetInput> => result.status === 'fulfilled')
      .map((result) => result.value)
    if (uploads.length && useCanvasStore.getState().document.id === projectId) {
      addUploadedAssetsToCanvas(uploads, position)
      if (!message) setCanvasUploadMessage(locale === 'en' ? 'Added to the canvas and saved to the asset library.' : '已加入画布并存入素材库。')
    }
  }, [addUploadedAssetsToCanvas, document.id, document.nodes, locale])

  /**
   * 把文件加到当前视口中心。
   *
   * 粘贴不是指针事件，没有 `clientX/Y` 可用 —— `onCanvasDrop` 正是靠它。
   * 记录最后指针位置需要新增状态，且指针从未进过画布时仍要回落；视口中心
   * 可预测、无新状态：用户粘贴后，东西出现在他正在看的地方。
   */
  const pasteFilesToCanvasCenter = useCallback((files: File[]) => {
    const mapper = screenToFlowPositionRef.current
    if (!mapper) return
    const surface = window.document.querySelector('.react-flow')
    if (!surface) return
    const rect = surface.getBoundingClientRect()
    const position = mapper({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
    void addDroppedFilesToCanvas(files, position)
  }, [addDroppedFilesToCanvas, screenToFlowPositionRef])

  const onCanvasDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const resetCanvasFileDragState = useCallback(() => {
    canvasFileDragDepthRef.current = 0
    setIsCanvasFileDragging(false)
  }, [])

  const onCanvasDrop = useCallback((event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    resetCanvasFileDragState()
    const mapper = screenToFlowPositionRef.current
    if (!mapper) return
    const position = mapper({ x: event.clientX, y: event.clientY })
    const files = Array.from(event.dataTransfer.files)
    if (files.length) {
      void addDroppedFilesToCanvas(files, position)
      return
    }
    const assetId = event.dataTransfer.getData('application/x-botanic-asset-id') || event.dataTransfer.getData('text/plain')
    if (assetId && assetLibraryAssets.some((asset) => asset.id === assetId)) addAssetToCanvas(assetId, position)
  }, [addAssetToCanvas, addDroppedFilesToCanvas, assetLibraryAssets, resetCanvasFileDragState, screenToFlowPositionRef])

  const isFlowDropTarget = useCallback((target: EventTarget | null) => (
    target instanceof Element && Boolean(target.closest('.react-flow'))
  ), [])

  const onCanvasFileDragEnter = useCallback((event: DragEvent<HTMLElement>) => {
    const next = beginCanvasFileDrag(
      { depth: canvasFileDragDepthRef.current, active: isCanvasFileDragging },
      Array.from(event.dataTransfer.types),
      isFlowDropTarget(event.target),
    )
    canvasFileDragDepthRef.current = next.depth
    setIsCanvasFileDragging(next.active)
  }, [isCanvasFileDragging, isFlowDropTarget])

  const onCanvasFileDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    if (!hasFileDragPayload(Array.from(event.dataTransfer.types)) || !isFlowDropTarget(event.target)) return
    const next = endCanvasFileDrag({ depth: canvasFileDragDepthRef.current, active: isCanvasFileDragging })
    canvasFileDragDepthRef.current = next.depth
    setIsCanvasFileDragging(next.active)
  }, [isCanvasFileDragging, isFlowDropTarget])

  useEffect(() => {
    const resetOnGlobalFileDrop = (event: globalThis.DragEvent) => {
      if (hasFileDragPayload(Array.from(event.dataTransfer?.types ?? []))) resetCanvasFileDragState()
    }
    const resetOnWindowBlur = () => resetCanvasFileDragState()
    window.addEventListener('drop', resetOnGlobalFileDrop, true)
    window.addEventListener('dragend', resetOnGlobalFileDrop, true)
    window.addEventListener('blur', resetOnWindowBlur)
    return () => {
      window.removeEventListener('drop', resetOnGlobalFileDrop, true)
      window.removeEventListener('dragend', resetOnGlobalFileDrop, true)
      window.removeEventListener('blur', resetOnWindowBlur)
    }
  }, [resetCanvasFileDragState])

  const isGraphConnectionValid = useCallback((connection: Connection | Edge, ignoredEdgeId?: string) => {
    const sourceId = connection.source
    const targetId = connection.target
    if (!sourceId || !targetId || sourceId === targetId) return false
    const source = document.nodes.find((node) => node.id === sourceId)
    const target = document.nodes.find((node) => node.id === targetId)
    if (!source || !target) return false
    const existingEdges = document.edges.filter((edge) => edge.id !== ignoredEdgeId)
    if (!(target.type === 'generate' && (source.type === 'asset' || source.type === 'text' || source.type === 'result'))) return false
    if (existingEdges.some((edge) => edge.source === sourceId && edge.target === targetId
      && (edge.sourceHandle ?? null) === (connection.sourceHandle ?? null)
      && (edge.targetHandle ?? null) === (connection.targetHandle ?? null))) return false
    if (source.type === 'asset') {
      const connectedImages = existingEdges.filter((edge) => edge.target === targetId)
        .map((edge) => document.nodes.find((node) => node.id === edge.source))
        .filter((node) => node?.type === 'asset')
      if (connectedImages.length >= 8) return false
    }
    if (source.type === 'result') {
      const connectedResults = existingEdges.filter((edge) => edge.target === targetId)
        .map((edge) => document.nodes.find((node) => node.id === edge.source))
        .filter((node) => node?.type === 'result')
      if (connectedResults.length >= 1) return false
    }
    return true
  }, [document.edges, document.nodes])

  const isVideoConnection = useCallback((connection: Connection | Edge) => {
    const source = document.nodes.find((node) => node.id === connection.source)
    const target = document.nodes.find((node) => node.id === connection.target)
    const isVideoNode = (node?: CanvasNode) => node?.type === 'generate'
      ? (node.data as GenerateNodeData).settings.duration !== undefined
      : node?.type === 'result' && ((node.data as ResultNodeData).mediaKind ?? 'image') === 'video'
    return isVideoNode(source) || isVideoNode(target)
  }, [document.nodes])

  const graphEdgeStyle = useCallback((connection: Connection | Edge) => {
    const source = document.nodes.find((node) => node.id === connection.source)
    const target = document.nodes.find((node) => node.id === connection.target)
    if (isVideoConnection(connection)) {
      return { stroke: '#3f6f9d', strokeWidth: 1.8, ...(source?.type === 'result' && target?.type === 'generate' ? { strokeDasharray: '4 3' } : {}) }
    }
    if (source?.type === 'result' && target?.type === 'generate') return { stroke: '#7e9785', strokeWidth: 1.25, strokeDasharray: '4 3' }
    if (source?.type === 'generate' && target?.type === 'result') return { stroke: '#2a5238', strokeWidth: 1.7 }
    return { stroke: '#4f805b', strokeWidth: 1.6 }
  }, [document.nodes, isVideoConnection])

  const renderedEdges = useMemo(() => document.edges.map((edge) => ({
    ...edge,
    hidden: Boolean(edge.hidden || hiddenResultNodeIds.has(edge.source) || hiddenResultNodeIds.has(edge.target)),
    className: [
      edge.className ?? '',
      isVideoConnection(edge) ? 'media-edge--video' : '',
      hasLineageFocus ? focusedLineageEdgeIds.has(edge.id) ? 'is-lineage' : 'is-lineage-muted' : '',
    ].filter(Boolean).join(' '),
    style: { ...edge.style, ...graphEdgeStyle(edge) },
  })), [document.edges, focusedLineageEdgeIds, graphEdgeStyle, hasLineageFocus, hiddenResultNodeIds, isVideoConnection])

  const onConnect = useCallback((connection: Connection) => {
    if (!isGraphConnectionValid(connection)) return
    setEdges(addEdge({
      ...connection,
      id: `graph-edge-${connection.source}-${connection.target}-${Date.now()}`,
      type: 'default',
      style: graphEdgeStyle(connection),
      reconnectable: true,
    }, document.edges))
    setIsConnecting(false)
  }, [document.edges, graphEdgeStyle, isGraphConnectionValid, setEdges])

  const onReconnect = useCallback((oldEdge: Edge, connection: Connection) => {
    if (oldEdge.data?.system || !isGraphConnectionValid(connection, oldEdge.id)) return
    const nextEdge: Edge = { ...oldEdge, ...connection, id: oldEdge.id, type: 'default', style: graphEdgeStyle(connection), reconnectable: true, selected: true }
    setEdges(document.edges.map((edge) => edge.id === oldEdge.id ? nextEdge : { ...edge, selected: false }))
    setSelectedEdgeId(oldEdge.id)
  }, [document.edges, graphEdgeStyle, isGraphConnectionValid, setEdges])

  const selectEdgeActions = useCallback((event: MouseEvent, edge: Edge) => {
    event.stopPropagation()
    const paneRect = canvasPaneRef.current?.getBoundingClientRect()
    if (!paneRect) return
    setEdges(document.edges.map((item) => ({ ...item, selected: item.id === edge.id })))
    setSelectedEdgeId(edge.id)
    setEdgeActionPosition({
      x: Math.max(12, Math.min(paneRect.width - 178, event.clientX - paneRect.left + 10)),
      y: Math.max(78, Math.min(paneRect.height - 48, event.clientY - paneRect.top + 10)),
    })
  }, [canvasPaneRef, document.edges, setEdges])

  const removeSelectedEdge = useCallback(() => {
    if (!selectedEdgeId) return
    const edge = document.edges.find((item) => item.id === selectedEdgeId)
    if (!edge?.data?.system) setEdges(document.edges.filter((item) => item.id !== selectedEdgeId))
    setSelectedEdgeId(null)
    setEdgeActionPosition(null)
  }, [document.edges, selectedEdgeId, setEdges])

  const toggleNodeReference = useCallback((generateNodeId: string, assetNodeId: string, enabled: boolean) => {
    const connection: Connection = { source: assetNodeId, sourceHandle: 'asset-output', target: generateNodeId, targetHandle: 'input' }
    if (!enabled) {
      setEdges(document.edges.filter((edge) => !(edge.source === assetNodeId && edge.target === generateNodeId)))
      return
    }
    if (!isGraphConnectionValid(connection)) return
    setEdges(addEdge({
      ...connection,
      id: `graph-edge-${assetNodeId}-${generateNodeId}-${Date.now()}`,
      type: 'default',
      style: graphEdgeStyle(connection),
      reconnectable: true,
    }, document.edges))
  }, [document.edges, graphEdgeStyle, isGraphConnectionValid, setEdges])

  const addAssetFromLibrary = useCallback((assetId: string) => {
    const target = assetLibraryTargetGenerateId
      ? document.nodes.find((node) => node.id === assetLibraryTargetGenerateId && node.type === 'generate')
      : undefined
    addAssetToCanvas(assetId, undefined, target?.id)
  }, [addAssetToCanvas, assetLibraryTargetGenerateId, document.nodes])

  const startConnecting = useCallback(() => {
    setConnectionFeedback(null)
    setIsConnecting(true)
  }, [])
  const finishConnecting = useCallback((isValid: boolean, hasTarget: boolean) => {
    setIsConnecting(false)
    setConnectionFeedback(isValid ? 'connected' : hasTarget ? 'invalid' : 'cancelled')
  }, [])
  const clearConnectionSelection = useCallback(() => {
    setIsConnecting(false)
    setSelectedEdgeId(null)
    setEdgeActionPosition(null)
  }, [])

  return {
    zoomMode,
    isConnecting,
    connectionFeedback,
    selectedEdgeId,
    selectedEdge: selectedEdgeId ? document.edges.find((edge) => edge.id === selectedEdgeId) : undefined,
    edgeActionPosition,
    isCanvasFileDragging,
    canvasUploadMessage,
    onNodesChange,
    persistDraggedNodes,
    onEdgesChange,
    persistViewport,
    onMoveEnd,
    onCanvasMove,
    autoLayoutCanvas,
    onSelectionChange,
    setScreenToFlowPosition,
    onCanvasDragOver,
    onCanvasDrop,
    onCanvasFileDragEnter,
    onCanvasFileDragLeave,
    isFlowDropTarget,
    addDroppedFilesToCanvas,
    pasteFilesToCanvasCenter,
    renderedEdges,
    onConnect,
    onReconnect,
    selectEdgeActions,
    removeSelectedEdge,
    toggleNodeReference,
    addAssetFromLibrary,
    isGraphConnectionValid,
    startConnecting,
    finishConnecting,
    clearConnectionSelection,
  }
}
