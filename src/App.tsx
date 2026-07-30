import { type CSSProperties, type DragEvent, type FormEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  ConnectionLineType,
  Handle,
  NodeToolbar,
  PanOnScrollMode,
  Panel,
  Position,
  ReactFlow,
  SelectionMode,
  useReactFlow,
  useViewport,
  type NodeProps,
  type Connection,
  type Edge,
  type OnEdgesChange,
  type OnNodesChange,
  type SetCenter,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { defaultGenerationModels } from './domain/canvas'
import type {
  AssetRecord,
  AssetRole,
  AssetSource,
  AssetNodeData,
  CanvasNode,
  CanvasTemplate,
  DeliveryArtifact,
  DeliveryPresetId,
  GenerationCandidate,
  GenerationModelOption,
  GenerationRecipe,
  GenerationSettings,
  GenerateNodeData,
  PromptNodeData,
  ReferenceGroupNodeData,
  ResultNodeData,
  TextNodeData,
  UploadedAssetInput,
} from './domain/canvas'
import { deliveryPresets, downloadDeliveryPackage } from './lib/deliveryExport'
import { getGenerationServiceHealth } from './lib/generationApi'
import { deleteCanvasDocument, readCanvasDocument, readCanvasDocuments, writeCanvasDocument } from './lib/db'
import { ProductApiError, createProductSession, readProductSession, serverPersistenceEnabled, supabaseAuthEnabled, type ProductUser } from './lib/productSession'
import { createEmptyCanvasDocument } from './data/seed'
import { useCanvasStore } from './store/canvasStore'
import { OperatingDashboard, ProjectLibrary, type WorkspaceProject } from './components/WorkspaceViews'
import closeIcon from './assets/figma/icon-close.svg'
import plusIcon from './assets/figma/icon-plus.svg'
import folderIcon from './assets/figma/icon-folder.svg'
import templatesIcon from './assets/figma/icon-templates.svg'
import historyIcon from './assets/figma/icon-history.svg'
import chevronIcon from './assets/figma/icon-chevron.svg'
import sidebarIcon from './assets/figma/icon-sidebar.svg'
import sendIcon from './assets/figma/icon-send.svg'
import sceneImage from './assets/figma/scene.png'
import resultImage from './assets/figma/result.png'

const creativeAssistantEnabled = false

type WorkspaceView = 'dashboard' | 'projects' | 'canvas'

type WorkspaceTransitionDirection = 'forward' | 'backward' | 'replace'
type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { finished: Promise<void> }
}

function workspaceTransitionDirection(from: WorkspaceView, to: WorkspaceView): WorkspaceTransitionDirection {
  if (from === to) return 'replace'
  if ((from === 'dashboard' && to === 'projects') || (from === 'projects' && to === 'canvas')) return 'forward'
  if ((from === 'canvas' && to === 'projects') || (from === 'projects' && to === 'dashboard')) return 'backward'
  return 'replace'
}

function reducedMotionRequested() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

let workspaceTransitionSequence = 0

function runWorkspaceTransition(direction: WorkspaceTransitionDirection, update: () => void) {
  const hostDocument = window.document as ViewTransitionDocument
  if (!hostDocument.startViewTransition || reducedMotionRequested()) {
    update()
    return
  }

  const root = hostDocument.documentElement
  const transitionId = String(++workspaceTransitionSequence)
  root.dataset.workspaceTransition = direction
  root.dataset.workspaceTransitionId = transitionId
  const transition = hostDocument.startViewTransition(update)
  void transition.finished.catch(() => undefined).finally(() => {
    if (root.dataset.workspaceTransitionId !== transitionId) return
    delete root.dataset.workspaceTransition
    delete root.dataset.workspaceTransitionId
  })
}

// V2 对应 V17 的初始画布间距迁移，避免旧缓存重新带回紧凑布局的观察视角。
const canvasViewportStoragePrefix = 'botanic-canvas-viewport:v2:'

function readCachedCanvasViewport(documentId: string) {
  try {
    const value = JSON.parse(window.localStorage.getItem(`${canvasViewportStoragePrefix}${documentId}`) ?? '') as Partial<{ x: number; y: number; zoom: number }>
    if (Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.zoom) && value.zoom! > 0) {
      return { x: value.x!, y: value.y!, zoom: value.zoom! }
    }
  } catch {
    // 回退到项目文档中的视角。
  }
  return undefined
}

function cacheCanvasViewport(documentId: string, viewport: { x: number; y: number; zoom: number }) {
  try {
    window.localStorage.setItem(`${canvasViewportStoragePrefix}${documentId}`, JSON.stringify(viewport))
  } catch {
    // 本地缓存不可用时，仍由项目文档继续保存。
  }
}

function FigmaIcon({ src, alt = '' }: { src: string; alt?: string }) {
  return <img src={src} alt={alt} aria-hidden={alt === ''} />
}

/** 植物学 Figma · Iconly/Sharp/Download（1228:231097） */
function DownloadIcon() {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 15.935V3.157" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
    <path d="m8.727 13.395 3.275 3.29 3.276-3.29" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
    <path d="M16.625 9.414H21.25v11.429H2.75V9.414h4.625" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
  </svg>
}

function visibleAssetTags(tags: string[], fallback?: string) {
  const values = tags.filter((tag) => !/mock/i.test(tag))
  return values.length ? values : fallback ? [fallback] : []
}

function ImageNodeTitle({ nodeId, name }: { nodeId: string; name: string }) {
  const renameCanvasNode = useCanvasStore((state) => state.renameCanvasNode)
  const [draft, setDraft] = useState(name)
  const discardPendingRename = useRef(false)

  useEffect(() => {
    setDraft(name)
  }, [name, nodeId])

  const save = () => {
    if (discardPendingRename.current) {
      discardPendingRename.current = false
      return
    }
    const nextName = draft.trim()
    if (!nextName || nextName === name) {
      setDraft(name)
      return
    }
    renameCanvasNode(nodeId, nextName)
  }

  return (
    <div className="image-node__title nodrag nowheel" onPointerDown={(event) => event.stopPropagation()}>
      <svg className="image-node__title-icon" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1.5" y="2" width="13" height="12" rx="2" />
        <circle cx="11.25" cy="5.25" r="1.15" />
        <path d="m3.25 11 3-3 2.15 2.05 1.65-1.5 2.75 2.45" />
      </svg>
      <input
        value={draft}
        maxLength={48}
        aria-label="图片名称"
        title="点击重命名"
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter') {
            event.preventDefault()
            event.currentTarget.blur()
          }
          if (event.key === 'Escape') {
            discardPendingRename.current = true
            setDraft(name)
            event.currentTarget.blur()
          }
        }}
      />
    </div>
  )
}

function AssetNode({ data, id, selected }: NodeProps) {
  const asset = data as AssetNodeData
  const removeNodeFromCanvas = useCanvasStore((state) => state.removeNodeFromCanvas)
  const [loadedImageSize, setLoadedImageSize] = useState<{ width: number; height: number } | null>(null)
  const imageWidth = asset.imageWidth ?? loadedImageSize?.width
  const imageHeight = asset.imageHeight ?? loadedImageSize?.height
  const previewSize = imageWidth && imageHeight
    ? imagePreviewSize(imageWidth, imageHeight)
    : undefined
  const nodeStyle = previewSize
    ? {
        width: `${previewSize.width}px`,
        '--asset-image-ratio': `${imageWidth} / ${imageHeight}`,
      } as CSSProperties
    : undefined
  return (
    <div className={['asset-node', asset.deleted ? 'is-deleted' : '', selected ? 'is-selected' : ''].filter(Boolean).join(' ')} style={nodeStyle}>
      <ImageNodeTitle nodeId={id} name={asset.name} />
      <button
        className="asset-node__remove nodrag"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          removeNodeFromCanvas(id)
        }}
        aria-label={`从画布移除 ${asset.name}`}
      >
        ×
      </button>
      <div className="asset-node__image-wrap">
        <img
          src={asset.image}
          alt={asset.name}
          className="asset-node__image"
          draggable={false}
          onLoad={(event) => {
            if (asset.imageWidth && asset.imageHeight) return
            const { naturalWidth, naturalHeight } = event.currentTarget
            if (naturalWidth && naturalHeight) setLoadedImageSize({ width: naturalWidth, height: naturalHeight })
          }}
          onDragStart={(event) => event.preventDefault()}
        />
      </div>
      <Handle
        className="flow-handle flow-handle--source flow-handle--image"
        id="asset-output"
        type="source"
        position={Position.Right}
        aria-label={`从 ${asset.name} 连线`}
        title="从这里拖到生成节点的输入端"
      />
    </div>
  )
}

function TextNode({ data, id, selected }: NodeProps) {
  const text = data as TextNodeData
  const updateTextNode = useCanvasStore((state) => state.updateTextNode)
  const removeNodeFromCanvas = useCanvasStore((state) => state.removeNodeFromCanvas)
  return (
    <div className={`graph-node text-node${selected ? ' is-selected' : ''}`}>
      <span className="graph-node__port-label graph-node__port-label--out">描述</span>
      <Handle
        className="flow-handle flow-handle--graph flow-handle--source"
        id="output"
        type="source"
        position={Position.Right}
        aria-label={`从 ${text.label} 连线`}
        title="从这里拖到生成节点的输入端"
      />
      <header className="graph-node__header">
        <span className="graph-node__eyebrow">TEXT</span>
        <strong>{text.label}</strong>
        <button
          className="graph-node__remove nodrag"
          type="button"
          aria-label={`从画布移除 ${text.label}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            removeNodeFromCanvas(id)
          }}
        >×</button>
      </header>
      <textarea
        className="nodrag nowheel"
        value={text.content}
        aria-label={`${text.label}内容`}
        placeholder="写下视觉目标或文案要求"
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => updateTextNode(id, event.target.value)}
      />
      <footer>连到生成节点，作为本次描述</footer>
    </div>
  )
}

function GenerateNode({ data, id, selected }: NodeProps) {
  const generate = data as GenerateNodeData
  const document = useCanvasStore((state) => state.document)
  const availableModels = useCanvasStore((state) => state.availableModels)
  const removeNodeFromCanvas = useCanvasStore((state) => state.removeNodeFromCanvas)
  const connectedInputs = useMemo(() => document.edges
      .filter((edge) => edge.target === id)
      .map((edge) => document.nodes.find((node) => node.id === edge.source))
      .filter((node): node is CanvasNode => Boolean(node)), [document.edges, document.nodes, id])
  const inputSummary = useMemo(() => ({
    images: connectedInputs.filter((node) => node.type === 'asset').length,
    texts: connectedInputs.filter((node) => node.type === 'text').length,
    results: connectedInputs.filter((node) => node.type === 'result').length,
    readyResults: connectedInputs.filter((node) => node.type === 'result' && Boolean((node.data as ResultNodeData).image)).length,
  }), [connectedInputs])
  const references = connectedInputs.flatMap((node) => {
    if (node.type === 'asset') {
      const asset = node.data as AssetNodeData
      return [{ id: node.id, image: asset.image, name: asset.name }]
    }
    if (node.type === 'result') {
      const result = node.data as ResultNodeData
      return result.image ? [{ id: node.id, image: result.image, name: result.label ?? '上游输出' }] : []
    }
    return []
  })
  const hasPrimaryInput = document.edges
    .some((edge) => edge.source === generate.primaryInputId && edge.target === id)
  const hasVisualInput = Boolean(inputSummary.images || inputSummary.readyResults)
  const modelOptions = availableModels.some((model) => model.id === generate.settings.model)
    ? availableModels
    : [{ id: generate.settings.model, label: generate.settings.model }, ...availableModels]
  const modelLabel = modelOptions.find((model) => model.id === generate.settings.model)?.label ?? generate.settings.model

  return (
    <div className={`graph-node generate-node${selected ? ' is-selected' : ''}${hasVisualInput ? '' : ' is-missing-input'}`}>
      <Handle
        className="flow-handle flow-handle--graph flow-handle--target"
        id="input"
        type="target"
        position={Position.Left}
        aria-label={`${generate.label} 输入端`}
        title="将图片、文本或已选首图连到这里"
      />
      <Handle
        className="flow-handle flow-handle--graph flow-handle--source"
        id="output"
        type="source"
        position={Position.Right}
        isConnectable={false}
        aria-label={`${generate.label} 自动输出端`}
        title="任务完成后，系统会自动创建输出图片"
      />
      <header className="graph-node__header">
        <strong>{generate.label}</strong>
        <small>{references.length} 参考 · {modelLabel} · {generate.settings.aspectRatio} · {generate.settings.resolution}</small>
        <button
          className="graph-node__remove nodrag"
          type="button"
          aria-label={`从画布移除 ${generate.label}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            removeNodeFromCanvas(id)
          }}
        >×</button>
      </header>
      <div className="generate-node__summary">
        {references.length ? (
          <div className="generate-node__reference-stack" aria-label={`已连接 ${references.length} 个参考`}>
            {references.slice(0, 4).map((reference) => <img key={reference.id} src={reference.image} alt={reference.name} title={reference.name} />)}
            {references.length > 4 ? <span>+{references.length - 4}</span> : null}
          </div>
        ) : <span className="generate-node__empty-input">连接图片或文本作为输入</span>}
        <p>{generate.prompt.trim() || '点击节点，编辑本次生成描述与参数'}</p>
        <footer>{hasPrimaryInput || inputSummary.readyResults ? '点击编辑本次生成' : '先连接主商品后生成'}</footer>
      </div>
    </div>
  )
}

type ComposerFocusReference = {
  id: string
  image: string
  name: string
  role: AssetRole
  source?: AssetSource
  primary: boolean
}

type GeneratedHistoryItem = {
  id: string
  image: string
  name: string
  createdAt: number
  nodeId?: string
  versionId?: string
}

type CanvasComposerProps = {
  mode: 'generate' | 'result'
  nodeLabel: string
  prompt: string
  batchCount: number
  maximumBatchCount: number
  settings: GenerationSettings
  models: GenerationModelOption[]
  references: ComposerFocusReference[]
  textCount: number
  status: 'idle' | 'uploading' | 'queued' | 'running' | 'error'
  error?: string
  canGenerate: boolean
  onNodeLabelChange?: (label: string) => void
  onPromptChange: (prompt: string) => void
  onBatchCountChange: (batchCount: number) => void
  onSettingsChange: (settings: GenerationSettings) => void
  onOpenReferences?: () => void
  onOpenAssets?: () => void
  onGenerate: () => void
  onClose: () => void
  layout: ComposerLayout
  onLayoutChange: (layout: ComposerLayout) => void
}

function CanvasComposer({ mode, nodeLabel, prompt, batchCount, maximumBatchCount, settings, models, references, textCount, status, error, canGenerate, onNodeLabelChange, onPromptChange, onBatchCountChange, onSettingsChange, onOpenReferences, onOpenAssets, onGenerate, onClose, layout, onLayoutChange }: CanvasComposerProps) {
  const isGenerating = status === 'uploading' || status === 'queued' || status === 'running'
  const modelOptions = models.some((model) => model.id === settings.model)
    ? models
    : [{ id: settings.model, label: settings.model }, ...models]
  const primaryReference = references.find((reference) => reference.primary)
  const updateSettings = (patch: Partial<GenerationSettings>) => onSettingsChange({ ...settings, ...patch })
  const composerRef = useRef<HTMLElement>(null)
  const dragStateRef = useRef<{ pointerId: number; startClientX: number; startClientY: number; x: number; y: number; started: boolean } | null>(null)
  const [dragPosition, setDragPosition] = useState<{ x: number; y: number } | null>(null)
  const expanded = !layout.collapsed
  const storedFreePosition = layout.dock === 'free' && typeof layout.x === 'number' && typeof layout.y === 'number'
    ? { x: layout.x, y: layout.y }
    : null
  const displayedPosition = dragPosition ?? storedFreePosition
  const composerStyle: CSSProperties = displayedPosition
    ? { left: `${displayedPosition.x}px`, top: `${displayedPosition.y}px`, right: 'auto', bottom: 'auto', transform: 'none' }
    : { transform: 'translateX(-50%)' }

  const stopDragging = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const dragState = dragStateRef.current
    if (!dragState || dragState.pointerId !== event.pointerId) return
    dragStateRef.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    if (!dragState.started) return
    onLayoutChange({ dock: 'free', x: dragState.x, y: dragState.y, collapsed: layout.collapsed })
  }, [layout.collapsed, onLayoutChange])

  const startDragging = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as Element).closest('button, input, textarea, select, a')) return
    const composer = composerRef.current
    const pane = composer?.closest<HTMLElement>('.canvas-pane')
    if (!composer || !pane) return
    const composerRect = composer.getBoundingClientRect()
    const paneRect = pane.getBoundingClientRect()
    const initialPosition = displayedPosition ?? {
      x: composerRect.left - paneRect.left,
      y: composerRect.top - paneRect.top,
    }
    dragStateRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      x: initialPosition.x,
      y: initialPosition.y,
      started: false,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [displayedPosition])

  const moveComposer = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const dragState = dragStateRef.current
    if (!dragState || dragState.pointerId !== event.pointerId) return
    const composer = composerRef.current
    const pane = composer?.closest<HTMLElement>('.canvas-pane')
    if (!composer || !pane) return
    const deltaX = event.clientX - dragState.startClientX
    const deltaY = event.clientY - dragState.startClientY
    if (!dragState.started && Math.hypot(deltaX, deltaY) < 6) return
    dragState.started = true
    const paneRect = pane.getBoundingClientRect()
    const composerRect = composer.getBoundingClientRect()
    const maxX = Math.max(12, paneRect.width - composerRect.width - 12)
    const maxY = Math.max(12, paneRect.height - composerRect.height - 12)
    const nextPosition = {
      x: Math.min(maxX, Math.max(12, dragState.x + deltaX)),
      y: Math.min(maxY, Math.max(12, dragState.y + deltaY)),
    }
    dragState.x = nextPosition.x
    dragState.y = nextPosition.y
    dragState.startClientX = event.clientX
    dragState.startClientY = event.clientY
    setDragPosition(nextPosition)
  }, [])

  useEffect(() => {
    if (dragStateRef.current) return
    setDragPosition(null)
  }, [layout.dock, layout.x, layout.y])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <section
      ref={composerRef}
      className={`canvas-composer${expanded ? ' is-expanded' : ' is-collapsed'}`}
      role="region"
      aria-label={`${mode === 'result' ? '基于此图继续生成' : '生成器'}：${nodeLabel}`}
      style={composerStyle}
    >
      <header
        className="canvas-composer__header"
        title="拖动移动生成器"
        onPointerDown={startDragging}
        onPointerMove={moveComposer}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
      >
        <div className="canvas-composer__drag-title" id="canvas-composer-title">
          <span className="canvas-composer__magic" aria-hidden="true">✦</span>
          <div className="canvas-composer__reference-strip" aria-label={`本次 ${references.length} 个参考`}>
            {references.slice(0, 4).map((reference) => <img key={reference.id} src={reference.image} alt={reference.name} className={reference.primary ? 'is-primary' : ''} />)}
            {references.length > 4 ? <span className="canvas-composer__reference-overflow">+{references.length - 4}</span> : null}
          </div>
          <strong>{references.length ? `${mode === 'result' ? '基于此图' : '本次参考'} · ${references.length}${textCount ? ` 图 ${textCount} 文` : ' 图'}` : '添加参考素材'}</strong>
          {onOpenAssets ? <button type="button" className="canvas-composer__add-reference" onClick={onOpenAssets}>＋ 素材</button> : null}
          {onOpenReferences && references.length ? <button type="button" className="canvas-composer__manage-reference" onClick={onOpenReferences}>管理</button> : null}
          {!expanded ? <small>已收起</small> : null}
        </div>
        <div className="canvas-composer__header-actions">
          <button
            type="button"
            className="canvas-composer__collapse"
            onClick={() => onLayoutChange({ ...layout, collapsed: expanded })}
            aria-expanded={expanded}
            aria-label={expanded ? '折叠生成器' : '展开生成器'}
            title={expanded ? '折叠' : '展开'}
          >{expanded ? '−' : '＋'}</button>
          <button type="button" className="canvas-composer__close" onClick={onClose} aria-label="关闭生成器" title="关闭">×</button>
        </div>
      </header>

      <div className="canvas-composer__expanded-content" aria-hidden={!expanded} inert={expanded ? undefined : true}>
        <div className="canvas-composer__body">
          <main className="canvas-composer__editor">
            <label className="canvas-composer__field canvas-composer__prompt">
              <textarea
                value={prompt}
                autoFocus={expanded}
                aria-label={`${nodeLabel}描述`}
                placeholder="描述商品、场景、构图、光线与留白要求"
                onChange={(event) => onPromptChange(event.target.value)}
              />
            </label>
          </main>
        </div>

        <footer className="canvas-composer__footer">
          <div className="canvas-composer__settings" aria-label="生成参数">
            <label>
              <span>模型</span>
              <select aria-label="图像模型" value={settings.model} disabled={isGenerating} onChange={(event) => updateSettings({ model: event.target.value })}>
                {modelOptions.map((model) => <option value={model.id} key={model.id}>{model.label}</option>)}
              </select>
            </label>
            <label>
              <span>比例</span>
              <select aria-label="画面比例" value={settings.aspectRatio} disabled={isGenerating} onChange={(event) => updateSettings({ aspectRatio: event.target.value as GenerationSettings['aspectRatio'] })}>
                <option value="1:1">1:1 方图</option><option value="3:4">3:4 竖图</option><option value="4:5">4:5 竖图</option><option value="9:16">9:16 长图</option>
              </select>
            </label>
            <label>
              <span>分辨率</span>
              <select aria-label="输出规格" value={settings.resolution} disabled={isGenerating} onChange={(event) => updateSettings({ resolution: event.target.value as GenerationSettings['resolution'] })}>
                <option value="1K">1K</option><option value="2K">2K</option>
              </select>
            </label>
            <label>
              <span>候选数</span>
              <input aria-label="候选数量" type="number" min="1" max={maximumBatchCount} value={batchCount} disabled={isGenerating} onChange={(event) => onBatchCountChange(Number(event.target.value))} />
            </label>
          </div>
          <div className={error ? 'canvas-composer__feedback is-error' : 'canvas-composer__feedback'} role={error ? 'alert' : 'status'}>
            {error ?? (isGenerating
              ? (status === 'uploading' ? '正在上传参考素材…' : status === 'queued' ? '任务已入队…' : '图像服务正在生成…')
              : canGenerate ? (primaryReference ? `主参考 · ${primaryReference.name}` : '参数已准备好，提交后会在画布中创建新的结果节点。') : '连接并设置主商品后即可生成。')}
          </div>
          <button type="button" className="canvas-composer__submit" disabled={isGenerating || !canGenerate || !prompt.trim()} onClick={onGenerate}>
            {isGenerating ? '生成中…' : `生成 ${batchCount} 张候选`}
          </button>
        </footer>
      </div>
    </section>
  )
}

function taskStatusLabel(status: 'uploading' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled') {
  const labels = {
    uploading: '提交素材',
    queued: '任务排队',
    running: '真实生成中',
    succeeded: '候选待选',
    failed: '任务失败',
    cancelled: '已取消',
  }
  return labels[status]
}

function resultTaskFeedback(status: ResultNodeData['taskStatus']) {
  if (status === 'uploading') {
    return { title: '正在整理参考素材', detail: '已锁定本次参考与画面描述' }
  }
  if (status === 'queued') {
    return { title: '已进入生成队列', detail: '任务已提交，正在等待图像服务处理' }
  }
  return { title: '正在构建画面', detail: '正在合成参考中的主体、场景与光线' }
}

function elapsedTaskLabel(seconds: number) {
  if (seconds < 60) return `已等待 ${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder ? `已等待 ${minutes} 分 ${remainder} 秒` : `已等待 ${minutes} 分`
}

function PromptNode({ data, selected }: NodeProps) {
  const prompt = data as PromptNodeData
  return (
    <div className={`task-node task-node--prompt task-node--${prompt.status}${selected ? ' is-selected' : ''}`}>
      <Handle className="flow-handle flow-handle--target" id="input" type="target" position={Position.Left} aria-label="视觉目标输入端" />
      <Handle className="flow-handle flow-handle--source" type="source" position={Position.Right} aria-label="从视觉目标连线" />
      <span className="task-node__eyebrow">01 · PROMPT</span>
      <strong>{prompt.label || (prompt.generationKind === 'refinement' ? '定向精修指令' : '视觉目标')}</strong>
      <p>{prompt.prompt}</p>
      <footer><span>{prompt.settings.aspectRatio} · {prompt.settings.resolution}</span><i>{taskStatusLabel(prompt.status)}</i></footer>
      {prompt.error ? <small title={prompt.error}>任务需要处理</small> : null}
    </div>
  )
}

function ReferenceGroupNode({ data, selected }: NodeProps) {
  const reference = data as ReferenceGroupNodeData
  const primary = primaryReferenceFromRecipe(reference.recipe)
  return (
    <div className={`task-node task-node--reference task-node--${reference.status}${selected ? ' is-selected' : ''}`}>
      <Handle className="flow-handle flow-handle--target" type="target" position={Position.Left} aria-label="参考组输入端" />
      <Handle className="flow-handle flow-handle--source" type="source" position={Position.Right} aria-label="从参考组连线" />
      <span className="task-node__eyebrow">02 · REFERENCES</span>
      <strong>{reference.label}</strong>
      <div className="task-node__reference-strip">
        {reference.recipe.references.slice(0, 4).map((item) => <img key={item.nodeId} src={item.image} alt={item.name} title={`${item.role} · ${item.name}`} />)}
      </div>
      <footer><span>{primary ? `主商品 · ${primary.name}` : '未锁定主商品'}</span><i>{taskStatusLabel(reference.status)}</i></footer>
      {reference.error ? <small title={reference.error}>任务需要处理</small> : null}
    </div>
  )
}

function ResultNode({ data, id, selected }: NodeProps) {
  const result = data as ResultNodeData
  const isSelected = selected || Boolean(result.selected)
  const [imageFailed, setImageFailed] = useState(false)
  const [currentTime, setCurrentTime] = useState(() => Date.now())
  const cancelGeneration = useCanvasStore((state) => state.cancelGeneration)
  const retryGeneration = useCanvasStore((state) => state.retryGeneration)
  const removeNodeFromCanvas = useCanvasStore((state) => state.removeNodeFromCanvas)
  const settings = result.generationSettings
  const ratioClass = settings ? `result-node--ratio-${settings.aspectRatio.replace(':', '-')}` : ''
  const resultName = result.label ?? (result.generationKind === 'refinement' ? '精修版本' : '首图版本')
  const hasDisplayableImage = Boolean(result.image) && !imageFailed
  const isGenerating = result.status === 'generating'
  const taskFeedback = resultTaskFeedback(result.taskStatus)
  const elapsedSeconds = result.submittedAt && isGenerating
    ? Math.max(0, Math.floor((currentTime - result.submittedAt) / 1_000))
    : 0
  const isSlowTask = elapsedSeconds >= 12

  useEffect(() => {
    setImageFailed(false)
  }, [result.image])

  useEffect(() => {
    if (!isGenerating || !result.submittedAt) return
    setCurrentTime(Date.now())
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [isGenerating, result.submittedAt])

  return (
    <div className={['result-node-shell', isSelected ? 'is-selected' : ''].filter(Boolean).join(' ')}>
      <Handle
        className="flow-handle flow-handle--target flow-handle--image"
        id="input"
        type="target"
        position={Position.Left}
        isConnectable={false}
        aria-label="自动输出端"
        title="由生成节点在任务完成后自动写入"
      />
      <Handle
        className="flow-handle flow-handle--source flow-handle--image"
        id="output"
        type="source"
        position={Position.Right}
        aria-label="从结果连线"
        title={hasDisplayableImage ? '将这张生成结果连到下一生成节点' : '任务完成后可将生成结果连到下一节点'}
      />
      <header className="result-node__header">
        <ImageNodeTitle nodeId={id} name={resultName} />
        {settings ? <span className="result-node__metadata">{settings.aspectRatio} · {settings.resolution}</span> : null}
      </header>
      <div className={['result-node', ratioClass, isGenerating ? 'result-node--generating' : '', isSelected ? 'is-selected' : ''].filter(Boolean).join(' ')}>
        {hasDisplayableImage ? <button
          className="result-node__remove nodrag nowheel"
          type="button"
          aria-label={`删除 ${resultName}`}
          title="删除这张生成结果"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
          removeNodeFromCanvas(id)
        }}
        >×</button> : null}
        {hasDisplayableImage ? <button
          className="result-node__download nodrag nowheel"
          type="button"
          aria-label={`下载 ${resultName}`}
          title="下载原图"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            void downloadImage(result.image!, resultName)
          }}
        ><DownloadIcon /></button> : null}
        {hasDisplayableImage ? <img src={result.image} alt={resultName} className="result-node__image" draggable={false} onError={() => setImageFailed(true)} /> : (
          <div className={`result-node__task-state result-node__task-state--${result.status}`}>
            <span>03 · RESULT</span>
            {isGenerating ? <i className="result-node__task-pulse" aria-hidden="true" /> : null}
            <strong aria-live="polite">{imageFailed ? '图片无法显示' : isGenerating ? taskFeedback.title : result.status === 'failed' ? '任务未完成' : result.status === 'cancelled' ? '任务已取消' : '等待生成结果'}</strong>
            <small>{imageFailed ? '图片数据异常或本地保存未完成，请重新生成。' : isGenerating ? taskFeedback.detail : result.error ?? (result.status === 'ready' ? '任务完成后，每张图片会作为独立节点写入画布。' : '图像服务的真实状态会在此同步。')}</small>
            {isGenerating ? <em>{isSlowTask ? `${elapsedTaskLabel(elapsedSeconds)} · 可继续编辑画布` : '参考已锁定 · 可继续编辑画布'}</em> : null}
            {result.status === 'generating' ? <button className="result-node__task-action nodrag nowheel" type="button" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); cancelGeneration() }}>取消</button> : null}
            {result.status === 'failed' ? <button className="result-node__task-action nodrag nowheel" type="button" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); void retryGeneration() }}>原配方重试</button> : null}
          </div>
        )}
        {result.generationKind === 'refinement' ? <span className="result-node__refinement">基于上版</span> : null}
        {result.status === 'generating' ? <div className="result-node__loading">处理中</div> : null}
        {isSelected ? <span className="result-node__check">✓</span> : null}
      </div>
    </div>
  )
}

const nodeTypes = {
  asset: AssetNode,
  text: TextNode,
  generate: GenerateNode,
  prompt: PromptNode,
  reference: ReferenceGroupNode,
  result: ResultNode,
}

const defaultGenerationSettings: GenerationSettings = {
  model: 'gpt-image-2',
  aspectRatio: '3:4',
  resolution: '2K',
}

const canvasMinZoom = 0.1
const canvasMaxZoom = 1.6
const composerLayoutStorageKey = 'botanic:composer-layout:v1'
const workspaceLocationStorageKey = 'botanic:workspace-location:v1'
const workspaceTabsStorageKey = 'botanic:workspace-tabs:v1'

type ComposerDock = 'bottom' | 'free'

type WorkspaceLocation = {
  view: WorkspaceView
  projectId?: string
}

type WorkspaceHistoryMode = 'push' | 'replace' | 'none'

type GenerationServiceState = {
  status: 'checking' | 'ready' | 'unconfigured' | 'offline'
  message: string
}

type ComposerLayout = {
  dock: ComposerDock
  x?: number
  y?: number
  collapsed: boolean
}

type ResultComposerDraft = {
  resultNodeId: string
  prompt: string
  batchCount: number
  settings: GenerationSettings
}

const defaultComposerLayout: ComposerLayout = { dock: 'bottom', collapsed: false }
const defaultWorkspaceLocation: WorkspaceLocation = { view: 'dashboard' }
const initialGenerationServiceState: GenerationServiceState = {
  status: 'checking',
  message: '正在检查真实生图服务…',
}

function readComposerLayout(): ComposerLayout {
  if (typeof window === 'undefined') return defaultComposerLayout
  try {
    const stored = JSON.parse(window.localStorage.getItem(composerLayoutStorageKey) ?? '') as Partial<ComposerLayout>
    const dock = stored.dock === 'free' ? 'free' : defaultComposerLayout.dock
    return {
      dock,
      x: typeof stored.x === 'number' && Number.isFinite(stored.x) ? stored.x : undefined,
      y: typeof stored.y === 'number' && Number.isFinite(stored.y) ? stored.y : undefined,
      collapsed: Boolean(stored.collapsed),
    }
  } catch {
    return defaultComposerLayout
  }
}

function workspaceLocationFromHash(hash: string): WorkspaceLocation | null {
  const path = hash.replace(/^#\/?/, '').replace(/\/+$/, '')
  if (path === 'dashboard') return { view: 'dashboard' }
  if (path === 'projects') return { view: 'projects' }

  const canvasMatch = path.match(/^canvas\/([^/]+)$/)
  if (!canvasMatch) return null

  try {
    const projectId = decodeURIComponent(canvasMatch[1]).trim()
    return projectId ? { view: 'canvas', projectId } : null
  } catch {
    return null
  }
}

function workspaceHash(location: WorkspaceLocation) {
  if (location.view === 'canvas' && location.projectId) return `#/canvas/${encodeURIComponent(location.projectId)}`
  return `#/${location.view}`
}

function sameWorkspaceLocation(left: WorkspaceLocation | null, right: WorkspaceLocation | null) {
  return left?.view === right?.view && left?.projectId === right?.projectId
}

function readWorkspaceLocation(): WorkspaceLocation {
  if (typeof window === 'undefined') return defaultWorkspaceLocation
  const locationFromHash = workspaceLocationFromHash(window.location.hash)
  if (locationFromHash) return locationFromHash

  try {
    const stored = JSON.parse(window.localStorage.getItem(workspaceLocationStorageKey) ?? '') as Partial<WorkspaceLocation>
    if (stored.view === 'canvas' && typeof stored.projectId === 'string' && stored.projectId.trim()) {
      return { view: 'canvas', projectId: stored.projectId }
    }
    if (stored.view === 'projects') return { view: 'projects' }
  } catch {
    // A malformed saved location should never prevent the workspace from opening.
  }
  return defaultWorkspaceLocation
}

function writeWorkspaceLocationFallback(location: WorkspaceLocation) {
  if (typeof window === 'undefined') return
  try {
    // The hash remains authoritative; this only restores legacy root URLs.
    window.localStorage.setItem(workspaceLocationStorageKey, JSON.stringify(location))
  } catch {
    // Navigation must still work when local storage is unavailable.
  }
}

function readWorkspaceTabs() {
  if (typeof window === 'undefined') return [] as string[]
  try {
    const saved = JSON.parse(window.localStorage.getItem(workspaceTabsStorageKey) ?? '')
    return Array.isArray(saved)
      ? [...new Set(saved.filter((id): id is string => typeof id === 'string' && Boolean(id.trim())))]
      : []
  } catch {
    return []
  }
}

function writeWorkspaceTabs(projectIds: string[]) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(workspaceTabsStorageKey, JSON.stringify(projectIds))
  } catch {
    // 标签只影响工作区导航，不影响项目数据保存。
  }
}

function writeWorkspaceHash(location: WorkspaceLocation, mode: Exclude<WorkspaceHistoryMode, 'none'>) {
  if (typeof window === 'undefined') return
  const nextHash = workspaceHash(location)
  if (window.location.hash === nextHash) return
  const nextUrl = `${window.location.pathname}${window.location.search}${nextHash}`
  window.history[mode === 'replace' ? 'replaceState' : 'pushState'](null, '', nextUrl)
}

function primaryReferenceFromRecipe(recipe?: GenerationRecipe) {
  if (!recipe) return undefined
  return recipe.references.find((reference) => reference.nodeId === recipe.primaryReferenceNodeId)
    ?? recipe.references.find((reference) => reference.primary)
    ?? recipe.references[0]
}

function recipeSummary(recipe?: GenerationRecipe) {
  const primary = primaryReferenceFromRecipe(recipe)
  if (!recipe) return '暂无已保存的生成配方'
  return `${primary ? `主参考 · ${primary.name}` : '未锁定主参考'} · ${recipe.references.length} 个参考 · ${recipe.settings.aspectRatio} / ${recipe.settings.resolution}`
}

function focusTaskFlow(setCenter: SetCenter, nodes: CanvasNode[]) {
  if (!nodes.length) return Promise.resolve(false)
  const left = Math.min(...nodes.map((node) => node.position.x))
  const top = Math.min(...nodes.map((node) => node.position.y))
  const right = Math.max(...nodes.map((node) => node.position.x + taskNodeBounds(node).width))
  const bottom = Math.max(...nodes.map((node) => node.position.y + taskNodeBounds(node).height))
  const composerSafeOffset = Math.max(72, Math.min(148, (bottom - top) * 0.2))
  return setCenter((left + right) / 2, (top + bottom) / 2 + composerSafeOffset, { zoom: canvasMinZoom, duration: 220 })
}

function CanvasNavigation({
  taskNodes,
  marqueeMode,
  onToggleMarqueeMode,
  onAutoLayout,
  onViewportChange,
}: {
  taskNodes: CanvasNode[]
  marqueeMode: boolean
  onToggleMarqueeMode: () => void
  onAutoLayout: () => void
  onViewportChange: (viewport: { x: number; y: number; zoom: number }) => void
}) {
  const { getViewport, zoomIn, zoomOut, zoomTo, fitView, setCenter } = useReactFlow()
  const { zoom } = useViewport()
  const zoomPercent = Math.round(zoom * 100)
  const zoomFill = `${Math.round(((zoom - canvasMinZoom) / (canvasMaxZoom - canvasMinZoom)) * 100)}%`
  const atMinimumZoom = zoom <= canvasMinZoom + 0.005
  const atMaximumZoom = zoom >= canvasMaxZoom - 0.005
  const commitViewport = (operation: Promise<boolean>) => {
    void operation.then(() => onViewportChange(getViewport()))
    window.setTimeout(() => onViewportChange(getViewport()), 260)
  }
  return (
    <Panel position="bottom-left" className="zoom-panel nopan nowheel">
      <div className="zoom-panel__controls" aria-label="画布缩放">
        <button onClick={() => commitViewport(zoomOut({ duration: 120 }))} disabled={atMinimumZoom} aria-label="缩小画布" title="缩小画布">−</button>
        <input
          className="zoom-track"
          aria-label="画布缩放级别"
          type="range"
          min={canvasMinZoom}
          max={canvasMaxZoom}
          step="0.01"
          value={zoom}
          style={{ '--zoom-fill': zoomFill } as CSSProperties}
          onChange={(event) => commitViewport(zoomTo(Number(event.target.value), { duration: 90 }))}
        />
        <strong aria-live="polite">{zoomPercent}%</strong>
        <button onClick={() => commitViewport(zoomIn({ duration: 120 }))} disabled={atMaximumZoom} aria-label="放大画布" title="放大画布">＋</button>
        <span className="zoom-panel__divider" aria-hidden="true" />
        <button className={marqueeMode ? 'zoom-panel__action is-active' : 'zoom-panel__action'} onClick={onToggleMarqueeMode} aria-pressed={marqueeMode} aria-label={marqueeMode ? '退出框选模式' : '进入框选模式'}>{marqueeMode ? '框选中' : '框选'}</button>
        <button className="zoom-panel__action" onClick={() => {
          onAutoLayout()
          window.requestAnimationFrame(() => commitViewport(fitView({ duration: 220, padding: 0.16, minZoom: canvasMinZoom, maxZoom: 1 })))
        }} aria-label="自动整理布局" title="按流程自动整理节点">整理</button>
        <button className="zoom-panel__action" onClick={() => commitViewport(fitView({ duration: 180, padding: 0.16, minZoom: canvasMinZoom, maxZoom: 1 }))} aria-label="适配画布">适配</button>
        {taskNodes.length ? <button className="zoom-panel__action" onClick={() => commitViewport(focusTaskFlow(setCenter, taskNodes))} aria-label="聚焦本次任务">本次任务</button> : null}
      </div>
      <span className="zoom-panel__hint">{marqueeMode ? '拖拽空白处框选 · 空格/中键平移' : '绿色实心点 → 空心点连线 · Shift 框选'}</span>
    </Panel>
  )
}

function MultiSelectionToolbar({ count, onClear }: { count: number; onClear: () => void }) {
  return (
    <Panel position="top-center" className="multi-selection-panel">
      <div className="multi-selection-toolbar" role="status" aria-live="polite">
        <span><strong>{count}</strong> 个节点已选中</span>
        <i>拖动任意节点可整体移动</i>
        <button type="button" onClick={onClear}>取消选择</button>
      </div>
    </Panel>
  )
}

function ConnectionGuide() {
  return (
    <Panel position="top-center" className="connection-guide-panel">
      <div className="connection-guide" role="status" aria-live="polite">
        <b>正在连线</b>
        <span>拖到绿色空心点</span>
        <i>素材 / 文本 / 已选图片 → 生成；输出由任务自动创建</i>
      </div>
    </Panel>
  )
}

function RestoreCanvasViewport({
  enabled,
  canvasKey,
  viewport,
  onRestored,
}: {
  enabled: boolean
  canvasKey: string
  viewport: { x: number; y: number; zoom: number }
  onRestored: () => void
}) {
  const { fitView, setViewport } = useReactFlow()
  const restoredCanvasKey = useRef<string | null>(null)

  useEffect(() => {
    if (!enabled) return

    if (restoredCanvasKey.current === canvasKey) return
    restoredCanvasKey.current = canvasKey
    // React Flow 会在挂载后补一次默认变换；等两个绘制帧让节点尺寸落位，避免 800ms 后再把用户拉回。
    let firstFrame = 0
    let secondFrame = 0
    let retryFrame = 0
    let cancelled = false
    let restored = false
    const finishRestore = () => {
      if (cancelled || restored) return
      restored = true
      onRestored()
    }
    const restore = () => {
      if (cancelled) return
      const hasDefaultViewport = viewport.x === 0 && viewport.y === 0 && viewport.zoom === 1
      if (hasDefaultViewport) {
        // 旧快照被默认视角覆盖时，仅此一次按真实节点边界恢复，避免图片在 100% 下堆叠。
        void fitView({ duration: 0, padding: 0.16, minZoom: canvasMinZoom, maxZoom: 1, includeHiddenNodes: true })
          .then((fitted) => {
            if (cancelled) return
            // 节点刚挂载时偶尔尚未完成尺寸计算；下一帧重试一次再开放保存。
            if (!fitted) {
              retryFrame = window.requestAnimationFrame(() => {
                void fitView({ duration: 0, padding: 0.16, minZoom: canvasMinZoom, maxZoom: 1, includeHiddenNodes: true })
                  .then(() => {
                    finishRestore()
                  })
              })
              return
            }
            finishRestore()
          })
        return
      }
      void setViewport(viewport, { duration: 0 })
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        finishRestore()
      }))
    }
    firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(restore)
    })
    return () => {
      cancelled = true
      window.cancelAnimationFrame(firstFrame)
      window.cancelAnimationFrame(secondFrame)
      window.cancelAnimationFrame(retryFrame)
      if (!restored && restoredCanvasKey.current === canvasKey) restoredCanvasKey.current = null
    }
  }, [canvasKey, enabled, fitView, onRestored, setViewport, viewport])

  return null
}

type ScreenToFlowPosition = (position: { x: number; y: number }) => { x: number; y: number }

type NodePalettePosition = {
  screen: { x: number; y: number }
  flow: { x: number; y: number }
}

function CanvasDropBridge({ onReady }: { onReady: (mapper: ScreenToFlowPosition) => void }) {
  const { screenToFlowPosition } = useReactFlow()

  useEffect(() => {
    onReady((position) => screenToFlowPosition(position))
  }, [onReady, screenToFlowPosition])

  return null
}

function KeepResultComposerVisible({ nodeId }: { nodeId: string }) {
  const { getViewport, setViewport } = useReactFlow()

  useEffect(() => {
    let frame = 0
    let followUpFrame = 0
    const revealComposer = () => {
      const toolbar = document.querySelector<HTMLElement>('.result-composer-toolbar')
      const flow = toolbar?.closest<HTMLElement>('.react-flow')
      if (!toolbar || !flow) return
      const toolbarRect = toolbar.getBoundingClientRect()
      const flowRect = flow.getBoundingClientRect()
      const bottomOverflow = toolbarRect.bottom - (flowRect.bottom - 18)
      if (bottomOverflow <= 0) return
      const viewport = getViewport()
      void setViewport({ ...viewport, y: viewport.y - bottomOverflow - 18 }, { duration: 180 })
    }
    frame = window.requestAnimationFrame(() => {
      followUpFrame = window.requestAnimationFrame(revealComposer)
    })
    return () => {
      window.cancelAnimationFrame(frame)
      window.cancelAnimationFrame(followUpFrame)
    }
  }, [getViewport, nodeId, setViewport])

  return null
}

function CanvasPanelPresence({
  open,
  side,
  children,
}: {
  open: boolean
  side: 'left' | 'right'
  children: ReactNode
}) {
  const [present, setPresent] = useState(open)
  const [phase, setPhase] = useState<'enter' | 'open' | 'exit'>(open ? 'enter' : 'exit')

  useEffect(() => {
    let frame = 0
    let closeTimer = 0
    if (open) {
      setPresent(true)
      setPhase('enter')
      frame = window.requestAnimationFrame(() => setPhase('open'))
    } else if (present) {
      setPhase('exit')
      closeTimer = window.setTimeout(() => setPresent(false), 190)
    }

    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(closeTimer)
    }
  }, [open, present])

  if (!present) return null
  return (
    <div
      className={`canvas-panel-presence canvas-panel-presence--${side} is-${phase}`}
      aria-hidden={phase === 'exit' ? true : undefined}
    >
      {children}
    </div>
  )
}

function taskNodeBounds(node: CanvasNode) {
  const measuredWidth = node.measured?.width
  const measuredHeight = node.measured?.height
  if (measuredWidth && measuredHeight) return { width: measuredWidth, height: measuredHeight }
  if (node.type === 'asset') {
    const asset = node.data as AssetNodeData
    const preview = asset.imageWidth && asset.imageHeight
      ? imagePreviewSize(asset.imageWidth, asset.imageHeight)
      : { width: 255, height: 340 }
    return { width: preview.width, height: preview.height + 28 }
  }
  if (node.type === 'prompt') return { width: 252, height: 126 }
  if (node.type === 'reference') return { width: 252, height: 148 }
  if (node.type === 'text') return { width: 236, height: 158 }
  if (node.type === 'generate') return { width: 360, height: 276 }
  const settings = (node.data as ResultNodeData).generationSettings
  const height = settings?.aspectRatio === '1:1' ? 300 : settings?.aspectRatio === '4:5' ? 375 : settings?.aspectRatio === '9:16' ? 533 : 400
  return { width: 300, height: height + 36 }
}

function canvasNodeSort(left: CanvasNode, right: CanvasNode) {
  const typeRank = (node: CanvasNode) => {
    if (node.type === 'asset') return 0
    if (node.type === 'text') return 1
    if (node.type === 'prompt') return 2
    if (node.type === 'reference') return 3
    if (node.type === 'generate') return 4
    return 5
  }
  const leftTypeRank = typeRank(left)
  const rightTypeRank = typeRank(right)
  if (leftTypeRank !== rightTypeRank) return leftTypeRank - rightTypeRank
  if (left.type === 'asset' && right.type === 'asset') {
    const roleRank = { 商品: 0, 场景: 1, 模特: 2, 调性: 3, 首图: 4 } as const
    const roleDifference = roleRank[(left.data as AssetNodeData).role] - roleRank[(right.data as AssetNodeData).role]
    if (roleDifference) return roleDifference
  }
  if (left.position.y !== right.position.y) return left.position.y - right.position.y
  if (left.position.x !== right.position.x) return left.position.x - right.position.x
  return left.id.localeCompare(right.id)
}

function canvasNodeBaseLevel(node: CanvasNode) {
  if (node.type === 'generate' || node.type === 'reference') return 1
  if (node.type === 'result') return 2
  return 0
}

/**
 * 按“一个生成节点 + 它实际连接的输入素材”分组整理。
 * 不再把所有商品、场景按角色堆到同一列，避免不同任务的素材混在一起。
 */
function layoutCanvasNodes(nodes: CanvasNode[], edges: Edge[]): CanvasNode[] {
  const cloned = nodes.map((node) => ({
    ...node,
    position: { ...node.position },
    data: { ...node.data },
  })) as CanvasNode[]
  const nodeById = new Map(cloned.map((node) => [node.id, node]))
  const generateNodes = cloned.filter((node) => node.type === 'generate').sort(canvasNodeSort)
  const positions = new Map<string, { x: number; y: number }>()
  const assigned = new Set<string>()
  const generatedResultIds = new Set(edges
    .filter((edge) => nodeById.get(edge.source)?.type === 'generate' && nodeById.get(edge.target)?.type === 'result')
    .map((edge) => edge.target))

  // 一个素材若被多个任务共享，仍只摆放一次：归到最靠前的生成组，连线保留其共享关系。
  const inputOwner = new Map<string, string>()
  for (const generate of generateNodes) {
    edges
      .filter((edge) => edge.target === generate.id)
      .map((edge) => nodeById.get(edge.source))
      .filter((node): node is CanvasNode => Boolean(node) && !generatedResultIds.has(node!.id))
      .forEach((node) => {
        if (!inputOwner.has(node.id)) inputOwner.set(node.id, generate.id)
      })
  }

  let groupX = 96
  for (const generate of generateNodes) {
    const inputs = cloned
      .filter((node) => inputOwner.get(node.id) === generate.id)
      .sort(canvasNodeSort)
    const outputs = edges
      .filter((edge) => edge.source === generate.id && nodeById.get(edge.target)?.type === 'result')
      .map((edge) => nodeById.get(edge.target)!)
      .filter((node, index, all) => all.findIndex((item) => item.id === node.id) === index)
      .sort(canvasNodeSort)
    const inputColumns = inputs.length > 3 ? 2 : 1
    const inputWidth = inputs.length ? Math.max(...inputs.map((node) => taskNodeBounds(node).width)) : 0
    const inputGap = 56
    let inputY = 96

    for (let start = 0; start < inputs.length; start += inputColumns) {
      const row = inputs.slice(start, start + inputColumns)
      const rowHeight = Math.max(...row.map((node) => taskNodeBounds(node).height))
      row.forEach((node, column) => {
        positions.set(node.id, { x: groupX + column * (inputWidth + inputGap), y: inputY })
        assigned.add(node.id)
      })
      inputY += rowHeight + 68
    }

    const inputHeight = Math.max(0, inputY - 96 - (inputs.length ? 68 : 0))
    const generateBounds = taskNodeBounds(generate)
    const generateX = groupX + (inputs.length ? inputColumns * inputWidth + (inputColumns - 1) * inputGap + 172 : 0)
    const generateY = Math.max(96, 96 + (inputHeight - generateBounds.height) / 2)
    positions.set(generate.id, { x: generateX, y: generateY })
    assigned.add(generate.id)

    const outputX = generateX + generateBounds.width + 188
    let outputY = Math.max(96, generateY)
    let outputWidth = 0
    outputs.forEach((node) => {
      const bounds = taskNodeBounds(node)
      positions.set(node.id, { x: outputX, y: outputY })
      assigned.add(node.id)
      outputY += bounds.height + 68
      outputWidth = Math.max(outputWidth, bounds.width)
    })

    const inputsWidth = inputs.length ? inputColumns * inputWidth + (inputColumns - 1) * inputGap : 0
    groupX += Math.max(
      inputsWidth + generateBounds.width + (outputs.length ? outputWidth + 360 : 180),
      760,
    ) + 180
  }

  // 未接入任何生成组的节点仍会被整理到最后，且不会挤入某个任务的素材区。
  const leftovers = cloned.filter((node) => !assigned.has(node.id)).sort(canvasNodeSort)
  let leftoverY = 96
  leftovers.forEach((node) => {
    positions.set(node.id, { x: groupX, y: leftoverY })
    leftoverY += taskNodeBounds(node).height + 68
  })

  return cloned.map((node) => ({ ...node, position: positions.get(node.id) ?? { ...node.position } })) as CanvasNode[]
}

function TaskFlowFocus({ taskKey, nodes }: { taskKey?: string; nodes: CanvasNode[] }) {
  const { setCenter } = useReactFlow()
  const previousTaskKey = useRef<string | undefined>(undefined)
  const initialized = useRef(false)

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true
      previousTaskKey.current = taskKey
      return
    }
    if (!taskKey || !nodes.length || previousTaskKey.current === taskKey) {
      previousTaskKey.current = taskKey
      return
    }
    previousTaskKey.current = taskKey

    const timer = window.setTimeout(() => {
      void focusTaskFlow(setCenter, nodes)
    }, 180)
    return () => window.clearTimeout(timer)
  }, [nodes, setCenter, taskKey])

  return null
}

function EdgeActions({ edge, position, onDelete, onClose }: {
  edge: Edge
  position: { x: number; y: number }
  onDelete: () => void
  onClose: () => void
}) {
  const isSystemEdge = Boolean(edge.data?.system)
  return (
    <div
      className="edge-actions"
      style={{ left: position.x, top: position.y }}
      role="toolbar"
      aria-label="已选连线操作"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span>{isSystemEdge ? '系统输出连线' : '连线已选中'}</span>
      <small>{isSystemEdge ? '用于保留生成血缘，不可删除或重连' : '拖动端点可重连'}</small>
      {!isSystemEdge ? <button type="button" onClick={onDelete}>删除</button> : null}
      <button type="button" className="edge-actions__close" onClick={onClose} aria-label="关闭连线操作">×</button>
    </div>
  )
}

function EmptyCanvasGuide({
  onOpenAssets,
  onAddGenerate,
}: {
  onOpenAssets: () => void
  onAddGenerate: () => void
}) {
  return (
    <section className="empty-canvas-guide" aria-label="空画布引导">
      <span className="panel-eyebrow">START A PROJECT</span>
      <h2>从一个创意目标开始</h2>
      <p>拖入商品、场景或灵感图；也可以先添加一个生成节点，逐步搭建这次项目的创作路径。</p>
      <div>
        <button type="button" onClick={onOpenAssets}>添加素材</button>
        <button type="button" className="is-primary" onClick={onAddGenerate}>新建生成节点</button>
      </div>
    </section>
  )
}

function CanvasWorkspace() {
  const document = useCanvasStore((state) => state.document)
  const globalAssets = useCanvasStore((state) => state.globalAssets)
  const hydrated = useCanvasStore((state) => state.hydrated)
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId)
  const hydrate = useCanvasStore((state) => state.hydrate)
  const openDocument = useCanvasStore((state) => state.openDocument)
  const renameDocument = useCanvasStore((state) => state.renameDocument)
  const setNodes = useCanvasStore((state) => state.setNodes)
  const setEdges = useCanvasStore((state) => state.setEdges)
  const setViewport = useCanvasStore((state) => state.setViewport)
  const selectNode = useCanvasStore((state) => state.selectNode)
  const removeNodeFromCanvas = useCanvasStore((state) => state.removeNodeFromCanvas)
  const addAssetToCanvas = useCanvasStore((state) => state.addAssetToCanvas)
  const addUploadedAssets = useCanvasStore((state) => state.addUploadedAssets)
  const addUploadedAssetsToCanvas = useCanvasStore((state) => state.addUploadedAssetsToCanvas)
  const addTextNode = useCanvasStore((state) => state.addTextNode)
  const addGenerateNode = useCanvasStore((state) => state.addGenerateNode)
  const renameCanvasNode = useCanvasStore((state) => state.renameCanvasNode)
  const updateGenerateNode = useCanvasStore((state) => state.updateGenerateNode)
  const runGraphGeneration = useCanvasStore((state) => state.runGraphGeneration)
  const availableModels = useCanvasStore((state) => state.availableModels)
  const setAvailableModels = useCanvasStore((state) => state.setAvailableModels)
  const setGenerateNodePrimaryInput = useCanvasStore((state) => state.setGenerateNodePrimaryInput)
  const setStoreMaximumBatchCount = useCanvasStore((state) => state.setMaximumBatchCount)
  const createGenerateBranchFromResult = useCanvasStore((state) => state.createGenerateBranchFromResult)
  const createGenerateFromResultRecipe = useCanvasStore((state) => state.createGenerateFromResultRecipe)
  const deleteAsset = useCanvasStore((state) => state.deleteAsset)
  const saveCurrentAsTemplate = useCanvasStore((state) => state.saveCurrentAsTemplate)
  const createCanvasFromTemplate = useCanvasStore((state) => state.createCanvasFromTemplate)
  const assistantMessage = useCanvasStore((state) => state.assistantMessage)
  const generationStatus = useCanvasStore((state) => state.generationStatus)
  const generationError = useCanvasStore((state) => state.generationError)
  const expectedCandidateCount = useCanvasStore((state) => state.expectedCandidateCount)
  const generationCandidates = useCanvasStore((state) => state.generationCandidates)
  const lastGenerationRequest = useCanvasStore((state) => state.lastGenerationRequest)
  const cancelGeneration = useCanvasStore((state) => state.cancelGeneration)
  const retryGeneration = useCanvasStore((state) => state.retryGeneration)
  const clearGenerationError = useCanvasStore((state) => state.clearGenerationError)
  const selectGenerationCandidate = useCanvasStore((state) => state.selectGenerationCandidate)
  const createLocalDeliveries = useCanvasStore((state) => state.createLocalDeliveries)
  const undoAction = useCanvasStore((state) => state.undoAction)
  const undoLastAction = useCanvasStore((state) => state.undoLastAction)
  const [assetsOpen, setAssetsOpen] = useState(false)
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [nodeReferencesOpen, setNodeReferencesOpen] = useState(false)
  const [candidatesOpen, setCandidatesOpen] = useState(false)
  const [nodeInspectorOpen, setNodeInspectorOpen] = useState(false)
  const [deliveryOpen, setDeliveryOpen] = useState(false)
  const [agentOpen, setAgentOpen] = useState(true)
  const [composerOpen, setComposerOpen] = useState(false)
  const [resultComposerDraft, setResultComposerDraft] = useState<ResultComposerDraft | null>(null)
  const [imagePreview, setImagePreview] = useState<{ image: string; name: string } | null>(null)
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [assetToDelete, setAssetToDelete] = useState<AssetRecord | null>(null)
  const [maximumBatchCount, setMaximumBatchCount] = useState(8)
  const [generationService, setGenerationService] = useState<GenerationServiceState>(initialGenerationServiceState)
  const [composerLayout, setComposerLayout] = useState<ComposerLayout>(readComposerLayout)
  const [nodePalette, setNodePalette] = useState<NodePalettePosition | null>(null)
  const [isCanvasFileDragging, setIsCanvasFileDragging] = useState(false)
  const [revealingResultNodeIds, setRevealingResultNodeIds] = useState<Map<string, number>>(() => new Map())
  const [canvasUploadMessage, setCanvasUploadMessage] = useState('')
  const [marqueeMode, setMarqueeMode] = useState(false)
  const [isConnecting, setIsConnecting] = useState(false)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [edgeActionPosition, setEdgeActionPosition] = useState<{ x: number; y: number } | null>(null)
  const [initialWorkspaceLocation] = useState<WorkspaceLocation>(readWorkspaceLocation)
  const [workspaceLocation, setWorkspaceLocation] = useState<WorkspaceLocation>(initialWorkspaceLocation)
  const [workspaceTabIds, setWorkspaceTabIds] = useState<string[]>(() => {
    const saved = readWorkspaceTabs()
    const initialId = initialWorkspaceLocation.view === 'canvas' ? initialWorkspaceLocation.projectId : undefined
    return initialId && !saved.includes(initialId) ? [...saved, initialId] : saved
  })
  const [workspaceRestoring, setWorkspaceRestoring] = useState(initialWorkspaceLocation.view === 'canvas')
  const [workspaceRestored, setWorkspaceRestored] = useState(false)
  const [viewportRestoring, setViewportRestoring] = useState(initialWorkspaceLocation.view === 'canvas')
  const workspaceView = workspaceLocation.view
  const workspaceDocumentMismatch = workspaceView === 'canvas'
    && Boolean(workspaceLocation.projectId)
    && document.id !== workspaceLocation.projectId
  const [workspaceProjects, setWorkspaceProjects] = useState<WorkspaceProject[]>([])
  const assetLibraryAssets = useMemo(() => {
    const seen = new Set<string>()
    return [...globalAssets, ...document.assets].filter((asset) => {
      if (seen.has(asset.id)) return false
      seen.add(asset.id)
      return true
    })
  }, [document.assets, globalAssets])
  const screenToFlowPositionRef = useRef<ScreenToFlowPosition | null>(null)
  const canvasPaneRef = useRef<HTMLElement | null>(null)
  const nodeFileInputRef = useRef<HTMLInputElement>(null)
  const canvasFileDragDepthRef = useRef(0)
  const selectedNodeIdsRef = useRef<Set<string>>(new Set())
  const selectedNodeTransitionRef = useRef<string | null | undefined>(undefined)
  const skipAutoComposerNodeIdRef = useRef<string | null>(null)
  const resultComposerSubmissionRef = useRef(false)
  const renderedResultNodeStateRef = useRef<Map<string, { candidateId?: string; hasImage: boolean }> | null>(null)
  const resultRevealTimersRef = useRef<Map<string, number>>(new Map())
  const viewportReadyRef = useRef(false)
  const viewportDocumentIdRef = useRef(document.id)
  if (viewportDocumentIdRef.current !== document.id) {
    viewportDocumentIdRef.current = document.id
    viewportReadyRef.current = false
  }

  const setWorkspaceView = useCallback((view: WorkspaceView, projectId?: string, historyMode: WorkspaceHistoryMode = 'push') => {
    const location: WorkspaceLocation = view === 'canvas'
      ? { view, projectId: projectId ?? useCanvasStore.getState().document.id }
      : { view }
    const updateLocation = () => {
      if (location.view === 'canvas' && !sameWorkspaceLocation(workspaceLocation, location)) setViewportRestoring(true)
      setWorkspaceLocation(location)
      writeWorkspaceLocationFallback(location)
      if (historyMode !== 'none') writeWorkspaceHash(location, historyMode)
    }
    const shouldAnimate = workspaceRestored && !workspaceRestoring && historyMode !== 'none'
    if (!shouldAnimate) {
      updateLocation()
      return
    }
    runWorkspaceTransition(workspaceTransitionDirection(workspaceLocation.view, view), () => {
      flushSync(updateLocation)
    })
  }, [workspaceLocation, workspaceRestored, workspaceRestoring])

  useEffect(() => {
    writeWorkspaceTabs(workspaceTabIds)
  }, [workspaceTabIds])

  useEffect(() => {
    if (workspaceLocation.view !== 'canvas' || !workspaceLocation.projectId) return
    setWorkspaceTabIds((current) => current.includes(workspaceLocation.projectId!)
      ? current
      : [...current, workspaceLocation.projectId!])
  }, [workspaceLocation])

  const showComposer = useCallback(() => {
    setComposerLayout((current) => current.collapsed ? { ...current, collapsed: false } : current)
    setComposerOpen(true)
  }, [])

  const reopenComposer = useCallback(() => {
    const selectedGenerateNode = document.nodes.find((node) => node.id === selectedNodeId && node.type === 'generate')
    const firstGenerateNode = document.nodes.find((node) => node.type === 'generate')
    const target = selectedGenerateNode ?? firstGenerateNode

    if (target) selectNode(target.id)
    else addGenerateNode()
    showComposer()
  }, [addGenerateNode, document.nodes, selectNode, selectedNodeId, showComposer])

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  useEffect(() => {
    if (!hydrated || workspaceRestored) return

    let active = true
    const restoreWorkspaceLocation = async () => {
      let location = workspaceLocationFromHash(window.location.hash) ?? initialWorkspaceLocation

      while (active) {
        if (location.view !== 'canvas') {
          setWorkspaceView(location.view, undefined, 'replace')
          break
        }

        const stored = location.projectId ? await readCanvasDocument(location.projectId) : undefined
        if (!active) return
        const hashLocation = workspaceLocationFromHash(window.location.hash) ?? initialWorkspaceLocation
        if (!sameWorkspaceLocation(location, hashLocation)) {
          location = hashLocation
          continue
        }

        if (!stored) {
          setWorkspaceView('projects', undefined, 'replace')
          break
        }

        const opened = await openDocument(location.projectId!)
        if (!active) return
        const latestHashLocation = workspaceLocationFromHash(window.location.hash) ?? initialWorkspaceLocation
        if (!sameWorkspaceLocation(location, latestHashLocation)) {
          location = latestHashLocation
          continue
        }

        setWorkspaceView(opened ? 'canvas' : 'projects', opened ? location.projectId : undefined, 'replace')
        break
      }

      if (!active) return
      setWorkspaceRestoring(false)
      setWorkspaceRestored(true)
    }

    void restoreWorkspaceLocation()
    return () => {
      active = false
    }
  }, [hydrated, initialWorkspaceLocation, openDocument, setWorkspaceView, workspaceRestored])

  useEffect(() => {
    if (!hydrated || !workspaceRestored) return

    let active = true
    let running = false
    let pendingLocation: WorkspaceLocation | null = null

    const queueLatestHashLocation = () => {
      const location = workspaceLocationFromHash(window.location.hash)
      if (!location) return
      pendingLocation = location
      setWorkspaceLocation(location)
      setWorkspaceRestoring(location.view === 'canvas')
      if (!running) void runNavigationQueue()
    }

    const runNavigationQueue = async () => {
      if (running) return
      running = true

      while (active && pendingLocation) {
        const location = pendingLocation
        pendingLocation = null

        if (location.view !== 'canvas') {
          if (sameWorkspaceLocation(location, workspaceLocationFromHash(window.location.hash))) {
            setWorkspaceView(location.view, undefined, 'none')
            setWorkspaceRestoring(false)
          }
          continue
        }

        const stored = location.projectId ? await readCanvasDocument(location.projectId) : undefined
        if (!active) break

        const hashLocation = workspaceLocationFromHash(window.location.hash)
        if (pendingLocation || !sameWorkspaceLocation(location, hashLocation)) {
          pendingLocation ??= hashLocation
          continue
        }

        if (!stored) {
          setWorkspaceView('projects', undefined, 'replace')
          setWorkspaceRestoring(false)
          continue
        }

        const opened = await openDocument(location.projectId!)
        if (!active) break

        const latestHashLocation = workspaceLocationFromHash(window.location.hash)
        if (pendingLocation || !sameWorkspaceLocation(location, latestHashLocation)) {
          pendingLocation ??= latestHashLocation
          continue
        }

        setWorkspaceView(opened ? 'canvas' : 'projects', opened ? location.projectId : undefined, opened ? 'none' : 'replace')
        setWorkspaceRestoring(false)
      }

      running = false
      if (active && pendingLocation) void runNavigationQueue()
    }
    const onWorkspaceHistoryChange = () => {
      queueLatestHashLocation()
    }

    window.addEventListener('hashchange', onWorkspaceHistoryChange)
    window.addEventListener('popstate', onWorkspaceHistoryChange)
    return () => {
      active = false
      window.removeEventListener('hashchange', onWorkspaceHistoryChange)
      window.removeEventListener('popstate', onWorkspaceHistoryChange)
    }
  }, [hydrated, openDocument, setWorkspaceView, workspaceRestored])

  const refreshWorkspaceProjects = useCallback(async () => {
    const documents = await readCanvasDocuments()
    const projects = documents.map((item): WorkspaceProject => ({
      id: item.id,
      name: item.name,
      updatedAt: item.updatedAt,
      cover: item.id.includes('fig') ? sceneImage : resultImage,
      summary: item.nodes.length ? `已搭建 ${item.nodes.length} 个节点` : '空白画布 · 等待开始',
      isSeed: item.id === 'summer-fragrance-visual-lab',
    }))
    setWorkspaceProjects(projects)
  }, [])

  const openWorkspaceProject = useCallback(async (projectId: string) => {
    const stored = await readCanvasDocument(projectId)
    if (!stored) return
    if (await openDocument(projectId)) {
      setWorkspaceView('canvas', projectId)
      void refreshWorkspaceProjects()
    }
  }, [openDocument, refreshWorkspaceProjects, setWorkspaceView])

  const createWorkspaceProject = useCallback(async () => {
    const documents = await readCanvasDocuments()
    const ordinal = documents.filter((item) => item.id.startsWith('project-')).length + 1
    const project = createEmptyCanvasDocument(`project-${Date.now()}`, `创意项目 ${ordinal}`)
    await writeCanvasDocument(project)
    await openDocument(project.id)
    setWorkspaceView('canvas', project.id)
    void refreshWorkspaceProjects()
  }, [openDocument, refreshWorkspaceProjects, setWorkspaceView])

  const renameWorkspaceProject = useCallback(async (projectId: string, name: string) => {
    const nextName = name.trim()
    if (!nextName) return false
    if (projectId === document.id) {
      renameDocument(nextName)
      setWorkspaceProjects((current) => current.map((project) => project.id === projectId
        ? { ...project, name: nextName, updatedAt: Date.now() }
        : project))
      return true
    } else {
      const project = await readCanvasDocument(projectId)
      if (!project) return false
      await writeCanvasDocument({ ...project, name: nextName, updatedAt: Date.now() })
    }
    await refreshWorkspaceProjects()
    return true
  }, [document.id, refreshWorkspaceProjects, renameDocument])

  const deleteWorkspaceProject = useCallback(async (projectId: string) => {
    await deleteCanvasDocument(projectId)
    setWorkspaceTabIds((current) => current.filter((id) => id !== projectId))
    await refreshWorkspaceProjects()
    if (workspaceLocation.view === 'canvas' && workspaceLocation.projectId === projectId) {
      setWorkspaceView('projects', undefined, 'replace')
    }
  }, [refreshWorkspaceProjects, setWorkspaceView, workspaceLocation])

  const closeWorkspaceTab = useCallback((projectId: string) => {
    const remaining = workspaceTabIds.filter((id) => id !== projectId)
    setWorkspaceTabIds(remaining)
    if (workspaceLocation.view !== 'canvas' || workspaceLocation.projectId !== projectId) return
    const nextProjectId = remaining.at(-1)
    if (nextProjectId) {
      void openWorkspaceProject(nextProjectId)
      return
    }
    setWorkspaceView('projects')
  }, [openWorkspaceProject, setWorkspaceView, workspaceLocation, workspaceTabIds])

  useEffect(() => {
    if (hydrated) void refreshWorkspaceProjects()
  }, [document.id, document.updatedAt, hydrated, refreshWorkspaceProjects])

  useEffect(() => {
    selectedNodeIdsRef.current = new Set(document.nodes.filter((node) => node.selected).map((node) => node.id))
  }, [document.nodes])

  useEffect(() => {
    const currentResultNodes = new Map(document.nodes
      .filter((node) => node.type === 'result')
      .map((node) => {
        const result = node.data as ResultNodeData
        return [node.id, { candidateId: result.candidateId, hasImage: Boolean(result.image) }] as const
      }))
    const previousResultNodes = renderedResultNodeStateRef.current
    renderedResultNodeStateRef.current = currentResultNodes
    if (!previousResultNodes) return

    const landedNodeIds = [...currentResultNodes]
      .filter(([id, current]) => {
        if (!current.candidateId || !current.hasImage) return false
        const previous = previousResultNodes.get(id)
        return !previous || !previous.hasImage || previous.candidateId !== current.candidateId
      })
      .map(([id]) => id)
    if (!landedNodeIds.length || reducedMotionRequested()) return

    setRevealingResultNodeIds((current) => {
      const next = new Map(current)
      landedNodeIds.forEach((id, index) => next.set(id, index))
      return next
    })
    landedNodeIds.forEach((id, index) => {
      window.clearTimeout(resultRevealTimersRef.current.get(id))
      const timer = window.setTimeout(() => {
        resultRevealTimersRef.current.delete(id)
        setRevealingResultNodeIds((current) => {
          if (!current.has(id)) return current
          const next = new Map(current)
          next.delete(id)
          return next
        })
      }, 560 + index * 45)
      resultRevealTimersRef.current.set(id, timer)
    })
  }, [document.nodes])

  useEffect(() => () => {
    resultRevealTimersRef.current.forEach((timer) => window.clearTimeout(timer))
  }, [])

  const renderedNodes = useMemo(() => document.nodes.map((node) => {
    const entryIndex = revealingResultNodeIds.get(node.id)
    if (node.type !== 'result' || entryIndex === undefined) return node
    return {
      ...node,
      className: `${node.className ?? ''} result-node--arriving`.trim(),
      style: {
        ...node.style,
        '--result-entry-delay': `${entryIndex * 45}ms`,
      } as CSSProperties,
    }
  }), [document.nodes, revealingResultNodeIds])

  const refreshGenerationService = useCallback(async () => {
    setGenerationService(initialGenerationServiceState)
    try {
      const health = await getGenerationServiceHealth()
      if (typeof health.maxBatchCount === 'number' && Number.isInteger(health.maxBatchCount)) {
        const maximum = Math.max(1, health.maxBatchCount)
        setMaximumBatchCount(maximum)
        setStoreMaximumBatchCount(maximum)
      }
      const models = Array.isArray(health.models)
        ? health.models
          .filter((model): model is string => typeof model === 'string' && Boolean(model.trim()))
          .map((model) => ({ id: model, label: model === 'gpt-image-2' ? 'GPT Image 2' : model }))
        : defaultGenerationModels
      setAvailableModels(models)
      setGenerationService(health.configured
        ? { status: 'ready', message: '真实生图服务已就绪。' }
        : { status: 'unconfigured', message: '服务已启动，但尚未配置 OPENAI_API_KEY；填写 .env 后重启 npm run server。' })
      return health.configured
    } catch {
      setGenerationService({ status: 'offline', message: '真实生图服务未启动：请在项目目录执行 npm run server。' })
      return false
    }
  }, [setAvailableModels, setStoreMaximumBatchCount])

  useEffect(() => {
    void refreshGenerationService()
  }, [refreshGenerationService])

  useEffect(() => {
    if (generationCandidates.length) setCandidatesOpen(true)
  }, [generationCandidates.length])

  useEffect(() => {
    try {
      window.localStorage.setItem(composerLayoutStorageKey, JSON.stringify(composerLayout))
    } catch {
      // Layout persistence is a convenience; generation must remain available if storage is blocked.
    }
  }, [composerLayout])

  const onNodesChange: OnNodesChange<CanvasNode> = useCallback(
    (changes) => {
      if (!hydrated) return
      setNodes(applyNodeChanges(changes, useCanvasStore.getState().document.nodes))
    },
    [hydrated, setNodes],
  )

  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => {
      if (!hydrated) return
      const currentEdges = useCanvasStore.getState().document.edges
      const protectedEdgeIds = new Set(currentEdges
        .filter((edge) => Boolean(edge.data?.system))
        .map((edge) => edge.id))
      const safeChanges = changes.filter((change) => change.type !== 'remove' || !protectedEdgeIds.has(change.id))
      setEdges(applyEdgeChanges(safeChanges, currentEdges))
    },
    [hydrated, setEdges],
  )

  const persistViewport = useCallback((viewport: typeof document.viewport) => {
    if (!hydrated) return
    cacheCanvasViewport(document.id, viewport)
    setViewport(viewport)
  }, [document.id, hydrated, setViewport])

  const onMoveEnd = useCallback((event: unknown, viewport: typeof document.viewport) => {
    // React Flow 挂载会以空事件上报默认 100% 视角；它不是用户平移，不能覆盖已恢复的视角。
    if (!event || !hydrated || !viewportReadyRef.current) return
    persistViewport(viewport)
  }, [hydrated, persistViewport])

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
    setNodeInspectorOpen(false)
    setNodePalette(null)
    setResultComposerDraft(null)
  }, [])

  const closeWorkbenchPanels = useCallback(() => {
    setAssetsOpen(false)
    setTemplatesOpen(false)
    setHistoryOpen(false)
    setNodeReferencesOpen(false)
    setCandidatesOpen(false)
    setNodeInspectorOpen(false)
    setDeliveryOpen(false)
    setResultComposerDraft(null)
  }, [])

  const setScreenToFlowPosition = useCallback((mapper: ScreenToFlowPosition) => {
    screenToFlowPositionRef.current = mapper
  }, [])

  const getTaskFlowLayout = useCallback(() => {
    const mapper = screenToFlowPositionRef.current
    const flowRect = canvasPaneRef.current?.querySelector('.react-flow')?.getBoundingClientRect()
    if (!mapper || !flowRect) return undefined

    if (flowRect.width < 680) {
      const x = flowRect.left + Math.max(62, (flowRect.width - 300) / 2)
      return {
        generate: mapper({ x, y: flowRect.top + 214 }),
        result: mapper({ x, y: flowRect.top + 520 }),
      }
    }

    const generateX = flowRect.left + Math.max(104, Math.min(206, flowRect.width * 0.28))
    const resultX = flowRect.left + Math.max(
      generateX - flowRect.left + 344,
      Math.min(flowRect.width - 314, flowRect.width * 0.58),
    )
    return {
      generate: mapper({ x: generateX, y: flowRect.top + 238 }),
      result: mapper({ x: resultX, y: flowRect.top + 200 }),
    }
  }, [])

  const applyRecipeAsDraft = useCallback((recipe: ComposerRecipe) => {
    const target = document.nodes.find((node) => node.id === selectedNodeId && node.type === 'generate')
    if (!target) return
    updateGenerateNode(target.id, {
      prompt: recipe.prompt,
      batchCount: Math.min(maximumBatchCount, Math.max(1, Math.round(recipe.batchCount) || 1)),
      settings: recipe.settings,
    })
    clearGenerationError()
    showComposer()
    closeWorkbenchPanels()
  }, [clearGenerationError, closeWorkbenchPanels, document.nodes, maximumBatchCount, selectedNodeId, showComposer, updateGenerateNode])

  const openResultComposer = useCallback((resultNodeId: string) => {
    const resultNode = document.nodes.find((node) => node.id === resultNodeId && node.type === 'result')
    if (!resultNode || resultNode.type !== 'result') return
    const result = resultNode.data as ResultNodeData
    if (!result.image) return
    const recipe = result.generationRecipe
    const inheritedPrompt = recipe?.prompt.trim()
    closeWorkbenchPanels()
    clearGenerationError()
    setComposerOpen(false)
    selectNode(resultNodeId)
    setResultComposerDraft({
      resultNodeId,
      prompt: inheritedPrompt || '保持当前商品与主体，基于当前图片做一版新的视觉迭代。',
      batchCount: Math.min(maximumBatchCount, Math.max(1, recipe?.batchCount ?? 1)),
      settings: { ...(recipe?.settings ?? result.generationSettings ?? defaultGenerationSettings) },
    })
  }, [clearGenerationError, closeWorkbenchPanels, document.nodes, maximumBatchCount, selectNode])

  const rebuildHeroFromResult = useCallback((resultNodeId: string) => {
    const draftId = createGenerateFromResultRecipe(resultNodeId)
    if (!draftId) return
    clearGenerationError()
    closeWorkbenchPanels()
    showComposer()
  }, [clearGenerationError, closeWorkbenchPanels, createGenerateFromResultRecipe, showComposer])

  const addDroppedFilesToCanvas = useCallback(async (files: File[], position: { x: number; y: number }) => {
    const { accepted, message } = validateUploadFiles(files)
    const imageFiles = accepted.slice(0, 12)
    setCanvasUploadMessage(message)
    if (!imageFiles.length) return
    const hasProduct = document.nodes.some((node) => node.type === 'asset'
      && (node.data as AssetNodeData).role === '商品')
    const loaded = await Promise.allSettled(imageFiles.map((file, index) => readUploadedAssetInput(
      file,
      !hasProduct && index === 0 ? '商品' : '场景',
    )))
    const uploads = loaded
      .filter((result): result is PromiseFulfilledResult<UploadedAssetInput> => result.status === 'fulfilled')
      .map((result) => result.value)
    if (uploads.length) {
      addUploadedAssetsToCanvas(uploads, position)
      if (!message) setCanvasUploadMessage('已加入画布并存入素材库。')
    }
  }, [addUploadedAssetsToCanvas, document.nodes])

  const onCanvasDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = Array.from(event.dataTransfer.types).includes('Files') ? 'copy' : 'move'
  }, [])

  const onCanvasDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    canvasFileDragDepthRef.current = 0
    setIsCanvasFileDragging(false)
    const mapper = screenToFlowPositionRef.current
    if (!mapper) return
    const position = mapper({ x: event.clientX, y: event.clientY })
    const files = Array.from(event.dataTransfer.files)
    if (files.length) {
      void addDroppedFilesToCanvas(files, position)
      return
    }
    const assetId = event.dataTransfer.getData('application/x-botanic-asset-id')
    if (assetId) addAssetToCanvas(assetId, position)
  }, [addAssetToCanvas, addDroppedFilesToCanvas])

  const onCanvasFileDragEnter = useCallback((event: DragEvent<HTMLElement>) => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return
    canvasFileDragDepthRef.current += 1
    setIsCanvasFileDragging(true)
  }, [])

  const onCanvasFileDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return
    canvasFileDragDepthRef.current = Math.max(0, canvasFileDragDepthRef.current - 1)
    if (!canvasFileDragDepthRef.current) setIsCanvasFileDragging(false)
  }, [])

  const openNodePalette = useCallback((event: ReactMouseEvent, fromDock = false) => {
    const mapper = screenToFlowPositionRef.current
    const paneRect = canvasPaneRef.current?.getBoundingClientRect()
    if (!mapper || !paneRect) return
    const screenPoint = {
      x: fromDock
        ? Math.max(paneRect.left + 172, Math.min(paneRect.right - 176, event.clientX + 132))
        : Math.max(paneRect.left + 94, Math.min(paneRect.right - 176, event.clientX)),
      y: Math.max(paneRect.top + 92, Math.min(paneRect.bottom - 158, event.clientY)),
    }
    closeWorkbenchPanels()
    setNodePalette({
      flow: mapper(screenPoint),
      screen: {
        x: Math.max(94, Math.min(paneRect.width - 262, screenPoint.x - paneRect.left + 8)),
        y: Math.max(70, Math.min(paneRect.height - 268, screenPoint.y - paneRect.top + 8)),
      },
    })
  }, [closeWorkbenchPanels])

  const isGraphConnectionValid = useCallback((connection: Connection | Edge, ignoredEdgeId?: string) => {
    const sourceId = connection.source
    const targetId = connection.target
    if (!sourceId || !targetId || sourceId === targetId) return false
    const source = document.nodes.find((node) => node.id === sourceId)
    const target = document.nodes.find((node) => node.id === targetId)
    if (!source || !target) return false
    const existingEdges = document.edges.filter((edge) => edge.id !== ignoredEdgeId)
    const connectsToGenerate = target.type === 'generate' && (source.type === 'asset' || source.type === 'text' || source.type === 'result')
    if (!connectsToGenerate) return false
    if (existingEdges.some((edge) => edge.source === sourceId && edge.target === targetId
      && (edge.sourceHandle ?? null) === (connection.sourceHandle ?? null)
      && (edge.targetHandle ?? null) === (connection.targetHandle ?? null))) return false
    if (source.type === 'asset') {
      const connectedImages = existingEdges
        .filter((edge) => edge.target === targetId)
        .map((edge) => document.nodes.find((node) => node.id === edge.source))
        .filter((node) => node?.type === 'asset')
      if (connectedImages.length >= 8) return false
    }
    if (source.type === 'result') {
      const connectedResults = existingEdges
        .filter((edge) => edge.target === targetId)
        .map((edge) => document.nodes.find((node) => node.id === edge.source))
        .filter((node) => node?.type === 'result')
      if (connectedResults.length >= 1) return false
    }
    return true
  }, [document.edges, document.nodes])

  const graphEdgeStyle = useCallback((connection: Connection | Edge) => {
    const source = document.nodes.find((node) => node.id === connection.source)
    const target = document.nodes.find((node) => node.id === connection.target)
    if (source?.type === 'result' && target?.type === 'generate') {
      return { stroke: '#7e9785', strokeWidth: 1.25, strokeDasharray: '4 3' }
    }
    if (source?.type === 'generate' && target?.type === 'result') {
      return { stroke: '#2a5238', strokeWidth: 1.7 }
    }
    return { stroke: '#4f805b', strokeWidth: 1.6 }
  }, [document.nodes])

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
    if (oldEdge.data?.system) return
    if (!isGraphConnectionValid(connection, oldEdge.id)) return
    const nextEdge: Edge = {
      ...oldEdge,
      ...connection,
      id: oldEdge.id,
      type: 'default',
      style: graphEdgeStyle(connection),
      reconnectable: true,
      selected: true,
    }
    setEdges(document.edges.map((edge) => edge.id === oldEdge.id ? nextEdge : { ...edge, selected: false }))
    setSelectedEdgeId(oldEdge.id)
  }, [document.edges, graphEdgeStyle, isGraphConnectionValid, setEdges])

  const selectEdgeActions = useCallback((event: ReactMouseEvent, edge: Edge) => {
    event.stopPropagation()
    const paneRect = canvasPaneRef.current?.getBoundingClientRect()
    if (!paneRect) return
    setEdges(document.edges.map((item) => ({ ...item, selected: item.id === edge.id })))
    setSelectedEdgeId(edge.id)
    setEdgeActionPosition({
      x: Math.max(12, Math.min(paneRect.width - 178, event.clientX - paneRect.left + 10)),
      y: Math.max(78, Math.min(paneRect.height - 48, event.clientY - paneRect.top + 10)),
    })
  }, [document.edges, setEdges])

  const removeSelectedEdge = useCallback(() => {
    if (!selectedEdgeId) return
    const edge = document.edges.find((item) => item.id === selectedEdgeId)
    if (edge?.data?.system) {
      setSelectedEdgeId(null)
      setEdgeActionPosition(null)
      return
    }
    setEdges(document.edges.filter((edge) => edge.id !== selectedEdgeId))
    setSelectedEdgeId(null)
    setEdgeActionPosition(null)
  }, [document.edges, selectedEdgeId, setEdges])

  const toggleNodeReference = useCallback((generateNodeId: string, assetNodeId: string, enabled: boolean) => {
    const connection: Connection = {
      source: assetNodeId,
      sourceHandle: 'asset-output',
      target: generateNodeId,
      targetHandle: 'input',
    }
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

  const canvasClassName = useMemo(
    () => (creativeAssistantEnabled && agentOpen ? 'app-shell' : 'app-shell app-shell--agent-closed'),
    [agentOpen],
  )
  const workspaceTabs = useMemo(() => {
    const projectsById = new Map(workspaceProjects.map((project) => [project.id, project]))
    if (!projectsById.has(document.id)) {
      projectsById.set(document.id, {
        id: document.id,
        name: document.name,
        updatedAt: document.updatedAt,
        cover: resultImage,
        summary: document.nodes.length ? `已搭建 ${document.nodes.length} 个节点` : '空白画布 · 等待开始',
      })
    }
    const ids = workspaceTabIds.includes(document.id) ? workspaceTabIds : [...workspaceTabIds, document.id]
    return ids.flatMap((id) => {
      const project = projectsById.get(id)
      return project ? [project] : []
    })
  }, [document.id, document.name, document.nodes.length, document.updatedAt, workspaceProjects, workspaceTabIds])

  const activeHistory = document.history.find((item) => item.id === document.activeVersionId)
  const generatedHistoryItems = useMemo<GeneratedHistoryItem[]>(() => {
    const results = document.nodes.flatMap((node) => {
      if (node.type !== 'result') return []
      const result = node.data as ResultNodeData
      if (!result.image) return []
      return [{
        id: node.id,
        nodeId: node.id,
        versionId: result.versionId,
        image: result.image,
        name: result.label ?? (result.generationKind === 'refinement' ? '精修版本' : '生成图片'),
        createdAt: result.submittedAt ?? 0,
      }]
    })
    const resultVersionIds = new Set(results.map((item) => item.versionId).filter((id): id is string => Boolean(id)))
    const legacyHistory = document.history
      .filter((entry) => entry.kind !== 'template' && !resultVersionIds.has(entry.id))
      .map((entry) => ({
        id: `history-${entry.id}`,
        image: entry.image,
        name: entry.name,
        createdAt: entry.createdAt,
      }))
    return [...results, ...legacyHistory].sort((left, right) => right.createdAt - left.createdAt)
  }, [document.history, document.nodes])
  const selectedCanvasNode = document.nodes.find((node) => node.id === selectedNodeId)
  const selectedEdge = selectedEdgeId ? document.edges.find((edge) => edge.id === selectedEdgeId) : undefined
  const selectedResult = selectedCanvasNode?.type === 'result' ? selectedCanvasNode : undefined
  const selectedResultData = selectedResult?.type === 'result' ? selectedResult.data as ResultNodeData : undefined
  const selectedGenerate = selectedCanvasNode?.type === 'generate' ? selectedCanvasNode : undefined
  const selectedGenerateData = selectedGenerate?.type === 'generate' ? selectedGenerate.data as GenerateNodeData : undefined
  const selectedCanvasNodes = document.nodes.filter((node) => Boolean(node.selected))
  const latestTaskResult = [...document.nodes].reverse().find((node) => node.type === 'result' && node.id.startsWith('result-task-'))
  const latestTaskKey = latestTaskResult?.id.replace('result-task-', '')
  const latestTaskGenerateId = latestTaskResult
    ? document.edges.find((edge) => edge.target === latestTaskResult.id && document.nodes.some((node) => node.id === edge.source && node.type === 'generate'))?.source
    : undefined
  const latestTaskInputIds = latestTaskGenerateId
    ? document.edges
      .filter((edge) => edge.target === latestTaskGenerateId)
      .map((edge) => edge.source)
    : []
  const latestTaskNodeIds = new Set([latestTaskResult?.id, latestTaskGenerateId, ...latestTaskInputIds].filter(Boolean))
  const latestTaskNodes = document.nodes.filter((node) => latestTaskNodeIds.has(node.id))
  const selectedReadyResultData = selectedResultData?.image ? selectedResultData : undefined
  const resultComposerNode = resultComposerDraft
    ? document.nodes.find((node) => node.id === resultComposerDraft.resultNodeId && node.type === 'result')
    : undefined
  const resultComposerData = resultComposerNode?.type === 'result' ? resultComposerNode.data as ResultNodeData : undefined
  const resultComposerTarget = resultComposerNode?.type === 'result' && resultComposerData?.image
    ? {
        nodeId: resultComposerNode.id,
        image: resultComposerData.image,
        label: resultComposerData.label ?? (resultComposerData.generationKind === 'refinement' ? '精修版本' : '首图版本'),
        recipe: resultComposerData.generationRecipe,
      }
    : undefined

  useEffect(() => {
    if (!hydrated) return
    if (selectedNodeTransitionRef.current === undefined) {
      selectedNodeTransitionRef.current = selectedNodeId
      return
    }
    if (selectedNodeTransitionRef.current === selectedNodeId) return
    selectedNodeTransitionRef.current = selectedNodeId
    if (selectedGenerate) {
      if (skipAutoComposerNodeIdRef.current === selectedGenerate.id) {
        skipAutoComposerNodeIdRef.current = null
        setComposerOpen(false)
      } else {
        showComposer()
      }
    } else {
      setComposerOpen(false)
    }
  }, [hydrated, selectedGenerate, selectedNodeId, showComposer])

  const canvasAssetReferences = document.nodes
    .flatMap((node, index) => {
      if (node.type !== 'asset') return []
      const asset = node.data as AssetNodeData
      return [{
        nodeId: node.id,
        ...asset,
        referenceEnabled: true,
        primary: false,
        referencePriority: index + 1,
      }]
    })
    .map((asset, index) => ({ ...asset, priority: index + 1 }))
  const selectedGenerateInputIds = selectedGenerate
    ? document.edges.filter((edge) => edge.target === selectedGenerate.id)
      .map((edge) => edge.source)
      .filter((sourceId) => document.nodes.some((node) => node.id === sourceId && (node.type === 'asset' || node.type === 'text' || node.type === 'result')))
    : []
  const selectedGenerateInputs = selectedGenerate
    ? [
        ...(selectedGenerateData?.inputOrder ?? []).filter((id) => selectedGenerateInputIds.includes(id)),
        ...selectedGenerateInputIds.filter((id) => !(selectedGenerateData?.inputOrder ?? []).includes(id)),
      ]
      .map((nodeId) => document.nodes.find((node) => node.id === nodeId))
      .filter((node): node is CanvasNode => Boolean(node))
    : []
  const selectedGenerateReferenceNodeIds = new Set(selectedGenerateInputs
    .filter((node) => node.type === 'asset')
    .map((node) => node.id))
  const selectedGenerateReferences = selectedGenerateInputs.flatMap((node) => {
    if (node.type !== 'asset') return []
    const asset = node.data as AssetNodeData
    return [{
      id: node.id,
      image: asset.image,
      name: asset.name,
      role: asset.role,
      source: asset.source,
      primary: node.id === selectedGenerateData?.primaryInputId,
    }]
  })
  const selectedGenerateTextCount = selectedGenerateInputs.filter((node) => node.type === 'text').length
  const selectedGenerateParent = selectedGenerateInputs.find((node) => node.type === 'result' && Boolean((node.data as ResultNodeData).image))
  const selectedGeneratePrimaryReference = selectedGenerateReferences.find((asset) => asset.primary) ?? selectedGenerateReferences[0]
  const selectedGenerateParentReference = selectedGenerateInputs
    .filter((node) => node.type === 'result')
    .map((node) => primaryReferenceFromRecipe((node.data as ResultNodeData).generationRecipe))
    .find(Boolean)
  const composerReferences = [
    ...selectedGenerateReferences,
    ...(selectedGenerateParent?.type === 'result' && (selectedGenerateParent.data as ResultNodeData).image
      ? [{
          id: selectedGenerateParent.id,
          image: (selectedGenerateParent.data as ResultNodeData).image!,
          name: (selectedGenerateParent.data as ResultNodeData).label ?? '上游输出',
          role: '首图' as const,
          source: 'generated' as const,
          primary: true,
        }]
      : []),
  ]
  const composerReferenceCount = composerReferences.length
  const composerPrimaryReferenceName = selectedGenerateParent?.type === 'result'
    ? ((selectedGenerateParent.data as ResultNodeData).label ?? '上游输出')
    : (selectedGeneratePrimaryReference?.name ?? selectedGenerateParentReference?.name)
  const composerContext: ComposerContext | undefined = selectedGenerateData
    ? {
        kind: 'generate',
        label: `节点 · ${selectedGenerateData.label}`,
        detail: `已连 ${composerReferences.length} 图 · ${selectedGenerateTextCount} 文${selectedGenerateParent ? ' · 继承上游输出' : ''}`,
      }
    : undefined
  const composerHint = generationError
    ?? (selectedGenerateData
      ? (composerReferences.length
        ? `正在编辑「${selectedGenerateData.label}」；已连 ${composerReferences.length} 张图片、${selectedGenerateTextCount} 条描述。`
        : `正在编辑「${selectedGenerateData.label}」；请把图片或文本连到左侧输入端。`)
      : '选择一个生成节点以编辑本次任务。')

  if (!hydrated || workspaceRestoring || workspaceDocumentMismatch) {
    return (
      <main className={canvasClassName}>
        <section className="canvas-pane canvas-loading" aria-label="正在加载画布">
          <div><span className="panel-eyebrow">BOTANIC CANVAS</span><strong>正在恢复本地画布…</strong></div>
        </section>
      </main>
    )
  }

  if (workspaceView === 'dashboard') {
    return <OperatingDashboard onOpenProjects={() => setWorkspaceView('projects')} />
  }

  if (workspaceView === 'projects') {
    return (
      <ProjectLibrary
        projects={workspaceProjects}
        onBack={() => setWorkspaceView('dashboard')}
        onOpenProject={openWorkspaceProject}
        onCreateProject={createWorkspaceProject}
        onRenameProject={renameWorkspaceProject}
        onDeleteProject={deleteWorkspaceProject}
      />
    )
  }

  return (
    <main className={canvasClassName}>
      <section
        ref={canvasPaneRef}
        className={['canvas-pane', isCanvasFileDragging ? 'is-file-dragging' : '', viewportRestoring ? 'is-restoring-viewport' : ''].filter(Boolean).join(' ')}
        aria-label={document.name.endsWith('画布') ? document.name : `${document.name}画布`}
        onDragEnter={onCanvasFileDragEnter}
        onDragLeave={onCanvasFileDragLeave}
      >
        <header className="tab-bar" data-node-id="894:230346">
          <div className="brand-mark">B</div>
          <button className="home-tab" onClick={() => { void refreshWorkspaceProjects(); setWorkspaceView('projects') }} aria-label="返回项目">⌂ <span>项目</span></button>
          <span className="tab-divider" />
          <nav className="project-tabs" aria-label="已打开项目">
            {workspaceTabs.map((project) => {
              const active = project.id === document.id
              return (
                <div className={active ? 'project-tab is-active' : 'project-tab'} key={project.id}>
                  <button
                    type="button"
                    aria-current={active ? 'page' : undefined}
                    aria-label={`打开${project.name}`}
                    onClick={() => { if (!active) void openWorkspaceProject(project.id) }}
                  >
                    <i />
                    <strong>{project.name}</strong>
                  </button>
                  <button
                    type="button"
                    className="project-tab__close"
                    onClick={() => closeWorkspaceTab(project.id)}
                    aria-label={`关闭${project.name}`}
                    title="关闭标签"
                  >
                    <FigmaIcon src={closeIcon} />
                  </button>
                </div>
              )
            })}
          </nav>
          <button
            className="new-tab"
            onClick={() => { void createWorkspaceProject() }}
            aria-label="新建创意项目"
          >
            <FigmaIcon src={plusIcon} />
          </button>
        </header>

        <ReactFlow
          nodes={renderedNodes}
          edges={document.edges}
          nodeTypes={nodeTypes}
          defaultViewport={document.viewport}
          minZoom={canvasMinZoom}
          maxZoom={canvasMaxZoom}
          nodesDraggable
          nodesConnectable
          connectOnClick
          connectionLineType={ConnectionLineType.Bezier}
          connectionLineStyle={{ stroke: '#4f805b', strokeWidth: 1.7 }}
          defaultEdgeOptions={{ type: 'default', style: { stroke: '#4f805b', strokeWidth: 1.6 }, reconnectable: true }}
          edgesReconnectable
          elementsSelectable
          selectionKeyCode="Shift"
          multiSelectionKeyCode={['Meta', 'Control']}
          selectionMode={SelectionMode.Partial}
          selectNodesOnDrag
          deleteKeyCode={null}
          selectionOnDrag={marqueeMode}
          panOnDrag={marqueeMode ? [1, 2] : [0, 1]}
          panOnScroll
          panOnScrollMode={PanOnScrollMode.Free}
          panOnScrollSpeed={0.8}
          zoomOnScroll={false}
          zoomOnPinch
          zoomOnDoubleClick={false}
          panActivationKeyCode="Space"
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onReconnect={onReconnect}
          onEdgeClick={selectEdgeActions}
          onConnectStart={() => setIsConnecting(true)}
          onConnectEnd={() => setIsConnecting(false)}
          isValidConnection={isGraphConnectionValid}
          onSelectionChange={onSelectionChange}
          onNodeClick={(event, node) => {
            if (event.metaKey || event.ctrlKey) {
              const nextSelectedIds = new Set(selectedNodeIdsRef.current)
              if (nextSelectedIds.has(node.id)) nextSelectedIds.delete(node.id)
              else nextSelectedIds.add(node.id)
              setNodes(useCanvasStore.getState().document.nodes.map((item) => ({
                ...item,
                selected: nextSelectedIds.has(item.id),
              })) as CanvasNode[])
              setNodeInspectorOpen(false)
              setComposerOpen(false)
              setResultComposerDraft(null)
              setNodePalette(null)
              return
            }
            const opensResultComposer = node.type === 'result'
              && Boolean((node.data as ResultNodeData).image)
            const opensResultCandidates = node.type === 'result'
              && generationCandidates.some((candidate) => candidate.resultNodeId === node.id)
            selectNode(node.id)
            if (node.type === 'generate') showComposer()
            else setComposerOpen(false)
            setIsConnecting(false)
            setSelectedEdgeId(null)
            setEdgeActionPosition(null)
            closeWorkbenchPanels()
            setNodePalette(null)
            setNodeInspectorOpen(node.type !== 'asset' && node.type !== 'result' && node.type !== 'generate')
            if (opensResultCandidates) setCandidatesOpen(true)
            if (opensResultComposer) openResultComposer(node.id)
          }}
          onNodeDoubleClick={(event, node) => {
            if (node.type !== 'result') return
            const result = node.data as ResultNodeData
            if (!result.image) return
            event.preventDefault()
            setImagePreview({ image: result.image, name: result.label ?? '生成图片' })
          }}
          onPaneClick={() => {
            selectNode(null)
            setIsConnecting(false)
            setSelectedEdgeId(null)
            setEdgeActionPosition(null)
            setNodeInspectorOpen(false)
            setComposerOpen(false)
            setResultComposerDraft(null)
            setNodePalette(null)
          }}
          onDoubleClick={(event) => {
            if ((event.target as Element).closest('.react-flow__pane')) openNodePalette(event)
          }}
          onDragOver={onCanvasDragOver}
          onDrop={onCanvasDrop}
          onMoveEnd={onMoveEnd}
          proOptions={{ hideAttribution: true }}
          className="botanic-flow"
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#d7ddd3" />
          {!document.nodes.length ? (
            <Panel position="top-left" className="empty-canvas-guide-panel">
              <EmptyCanvasGuide
                onOpenAssets={() => { closeWorkbenchPanels(); setAssetsOpen(true) }}
                onAddGenerate={() => {
                  addGenerateNode({ x: 460, y: 330 })
                  showComposer()
                }}
              />
            </Panel>
          ) : null}
          <CanvasDropBridge onReady={setScreenToFlowPosition} />
          {selectedReadyResultData && selectedResult && !resultComposerDraft ? (
            <NodeToolbar
              nodeId={selectedResult.id}
              isVisible
              position={Position.Bottom}
              offset={12}
              className="result-branch-toolbar"
            >
              <div className="result-branch-actions nodrag nowheel" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
                <button type="button" className="result-branch-actions__continue" onClick={() => openResultComposer(selectedResult.id)}>
                  基于此图继续生成 <span aria-hidden="true">↗</span>
                </button>
                <button
                  type="button"
                  className="result-branch-actions__restart"
                  onClick={() => rebuildHeroFromResult(selectedResult.id)}
                  title="恢复原始素材、提示词与参数，不使用当前成图"
                >复用原始参考重做首图</button>
              </div>
            </NodeToolbar>
          ) : null}
          <Panel position="top-left" className="task-flow-focus-panel"><TaskFlowFocus taskKey={latestTaskKey} nodes={latestTaskNodes} /></Panel>

          {selectedCanvasNodes.length > 1 ? <MultiSelectionToolbar count={selectedCanvasNodes.length} onClear={() => { selectNode(null); setComposerOpen(false) }} /> : null}
          {isConnecting ? <ConnectionGuide /> : null}

          <Panel position="top-left" className="project-title-panel">
            <button className="project-title" onClick={() => setProjectMenuOpen((open) => !open)} aria-expanded={projectMenuOpen}>
              <strong>{document.name}</strong>
              <FigmaIcon src={chevronIcon} />
            </button>
            {projectMenuOpen ? (
              <div className="project-menu">
                <span>当前分支</span>
                <button onClick={() => { setProjectMenuOpen(false); setHistoryOpen(true) }}>
                  {activeHistory?.name ?? '首图主版本'}
                </button>
                <button onClick={() => { setProjectMenuOpen(false); setTemplatesOpen(true) }}>
                  从当前画布沉淀视觉目标
                </button>
              </div>
            ) : null}
          </Panel>

          <Panel position="top-left" className="dock-panel">
            <nav className="dock" aria-label="画布工具">
              <button className="dock__add" onClick={(event) => openNodePalette(event, true)} aria-label="新增节点"><FigmaIcon src={plusIcon} /></button>
              <button className={assetsOpen ? 'dock__button is-active' : 'dock__button'} onClick={() => { closeWorkbenchPanels(); setAssetsOpen(true) }} aria-label="打开素材库"><FigmaIcon src={folderIcon} /></button>
              <button className={templatesOpen ? 'dock__button is-active' : 'dock__button'} onClick={() => { closeWorkbenchPanels(); setTemplatesOpen(true) }} aria-label="视觉目标与模板"><FigmaIcon src={templatesIcon} /></button>
              <button className={historyOpen ? 'dock__button is-active' : 'dock__button'} onClick={() => { closeWorkbenchPanels(); setHistoryOpen(true) }} aria-label="画布历史"><FigmaIcon src={historyIcon} /></button>
              <button className={deliveryOpen ? 'dock__button dock__button--delivery is-active' : 'dock__button dock__button--delivery'} onClick={() => { closeWorkbenchPanels(); setDeliveryOpen(true) }} aria-label="投放交付">↗</button>
              <button className="dock__account" aria-label="账户">L</button>
            </nav>
          </Panel>

          <CanvasNavigation
            taskNodes={latestTaskNodes}
            marqueeMode={marqueeMode}
            onToggleMarqueeMode={() => setMarqueeMode((active) => !active)}
            onAutoLayout={autoLayoutCanvas}
            onViewportChange={persistViewport}
          />
          <RestoreCanvasViewport
            enabled={hydrated}
            canvasKey={document.id}
            viewport={readCachedCanvasViewport(document.id) ?? document.viewport}
            onRestored={() => {
              // 忽略 React Flow 挂载时补发的默认视角事件，避免写坏已保存的画布位置。
              window.requestAnimationFrame(() => {
                window.requestAnimationFrame(() => {
                  if (viewportDocumentIdRef.current === document.id) {
                    viewportReadyRef.current = true
                    setViewportRestoring(false)
                  }
                })
              })
            }}
          />
        </ReactFlow>

        {composerOpen && selectedGenerate && selectedGenerateData && !resultComposerDraft ? (
          <CanvasComposer
            key={`generate-${selectedGenerate.id}`}
            mode="generate"
            nodeLabel={selectedGenerateData.label}
            prompt={selectedGenerateData.prompt}
            batchCount={selectedGenerateData.batchCount}
            maximumBatchCount={maximumBatchCount}
            settings={selectedGenerateData.settings}
            models={availableModels}
            references={composerReferences}
            textCount={selectedGenerateTextCount}
            status={generationStatus}
            error={generationError ?? undefined}
            canGenerate={Boolean(composerPrimaryReferenceName)}
            layout={composerLayout}
            onLayoutChange={setComposerLayout}
            onNodeLabelChange={(label) => updateGenerateNode(selectedGenerate.id, { label })}
            onPromptChange={(prompt) => {
              updateGenerateNode(selectedGenerate.id, { prompt })
              clearGenerationError()
            }}
            onBatchCountChange={(batchCount) => {
              updateGenerateNode(selectedGenerate.id, { batchCount: Math.min(maximumBatchCount, Math.max(1, Math.round(batchCount) || 1)) })
              clearGenerationError()
            }}
            onSettingsChange={(settings) => {
              updateGenerateNode(selectedGenerate.id, { settings })
              clearGenerationError()
            }}
            onOpenReferences={() => {
              setComposerOpen(false)
              setNodeReferencesOpen(true)
            }}
            onOpenAssets={() => {
              setComposerOpen(false)
              setAssetsOpen(true)
            }}
            onGenerate={() => {
              void runGraphGeneration(selectedGenerate.id).then((started) => {
                if (started) setComposerOpen(false)
              })
            }}
            onClose={() => setComposerOpen(false)}
          />
        ) : null}

        {resultComposerDraft && resultComposerTarget ? (
          <CanvasComposer
            key={`result-${resultComposerTarget.nodeId}`}
            mode="result"
            nodeLabel={resultComposerTarget.label}
            prompt={resultComposerDraft.prompt}
            batchCount={resultComposerDraft.batchCount}
            maximumBatchCount={maximumBatchCount}
            settings={resultComposerDraft.settings}
            models={availableModels}
            references={[{
              id: resultComposerTarget.nodeId,
              image: resultComposerTarget.image,
              name: resultComposerTarget.label,
              role: '首图',
              source: 'generated',
              primary: true,
            }]}
            textCount={0}
            status={generationStatus}
            error={generationError ?? undefined}
            canGenerate
            layout={composerLayout}
            onLayoutChange={setComposerLayout}
            onPromptChange={(prompt) => {
              setResultComposerDraft((current) => current ? { ...current, prompt } : current)
              clearGenerationError()
            }}
            onBatchCountChange={(batchCount) => {
              const nextBatchCount = Math.min(maximumBatchCount, Math.max(1, Math.round(batchCount) || 1))
              setResultComposerDraft((current) => current ? { ...current, batchCount: nextBatchCount } : current)
              clearGenerationError()
            }}
            onSettingsChange={(settings) => {
              setResultComposerDraft((current) => current ? { ...current, settings } : current)
              clearGenerationError()
            }}
            onGenerate={() => {
              const draft = resultComposerDraft
              if (resultComposerSubmissionRef.current || !draft || !draft.prompt.trim()) return
              resultComposerSubmissionRef.current = true
              const branchId = createGenerateBranchFromResult(draft.resultNodeId, {
                prompt: draft.prompt.trim(),
                batchCount: draft.batchCount,
                settings: draft.settings,
              })
              if (!branchId) {
                resultComposerSubmissionRef.current = false
                return
              }
              skipAutoComposerNodeIdRef.current = branchId
              setResultComposerDraft(null)
              setComposerOpen(false)
              void runGraphGeneration(branchId).then((started) => {
                resultComposerSubmissionRef.current = false
                if (started) {
                  setCandidatesOpen(true)
                  return
                }
                skipAutoComposerNodeIdRef.current = null
                showComposer()
              }).catch(() => {
                resultComposerSubmissionRef.current = false
                skipAutoComposerNodeIdRef.current = null
                showComposer()
              })
            }}
            onClose={() => setResultComposerDraft(null)}
          />
        ) : null}

        {selectedEdge && edgeActionPosition ? (
          <EdgeActions
            edge={selectedEdge}
            position={edgeActionPosition}
            onDelete={removeSelectedEdge}
            onClose={() => {
              setSelectedEdgeId(null)
              setEdgeActionPosition(null)
            }}
          />
        ) : null}

        {isCanvasFileDragging ? (
          <div className="canvas-file-drop" aria-hidden="true">
            <span>图片素材</span>
            <strong>松开即可加入画布</strong>
            <small>PNG / JPEG / WebP，单张不超过 8MB</small>
          </div>
        ) : null}
        {canvasUploadMessage ? <div className="canvas-upload-message" role="status">{canvasUploadMessage}</div> : null}
        {nodePalette ? (
          <div className="node-palette" style={{ left: nodePalette.screen.x, top: nodePalette.screen.y }} role="dialog" aria-label="添加画布节点" onPointerDown={(event) => event.stopPropagation()}>
            <div className="node-palette__title"><span>添加节点</span><button onClick={() => setNodePalette(null)} aria-label="关闭添加节点">×</button></div>
            <button onClick={() => { addTextNode(nodePalette.flow); setNodePalette(null) }}>
              <b>T</b><span><strong>文本</strong><small>视觉描述、卖点与构图要求</small></span>
            </button>
            <button onClick={() => { addGenerateNode(nodePalette.flow); showComposer(); setNodePalette(null) }}>
              <b>✦</b><span><strong>生成</strong><small>连接素材与文本后生成首图</small></span>
            </button>
            <button onClick={() => { setNodePalette(null); setAssetsOpen(true) }}>
              <b>▧</b><span><strong>素材库</strong><small>选择已有商品、场景或调性图</small></span>
            </button>
            <div className="node-palette__upload"><span>添加资源</span><button onClick={() => nodeFileInputRef.current?.click()}>↑ 上传图片</button></div>
          </div>
        ) : null}
        <input
          ref={nodeFileInputRef}
          className="asset-file-input"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          aria-label="上传图片并加入画布"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? [])
            event.currentTarget.value = ''
            if (nodePalette && files.length) void addDroppedFilesToCanvas(files, nodePalette.flow)
            setNodePalette(null)
          }}
        />

        <CanvasPanelPresence open={assetsOpen} side="left">
          <AssetLibrary
            assets={assetLibraryAssets}
            onAdd={addAssetToCanvas}
            onUpload={addUploadedAssets}
            onDelete={setAssetToDelete}
            onClose={() => setAssetsOpen(false)}
          />
        </CanvasPanelPresence>
        <CanvasPanelPresence open={templatesOpen} side="right">
          <TemplatePanel
            templates={document.templates}
            currentName={document.name}
            canSave={document.nodes.length > 0}
            onSave={saveCurrentAsTemplate}
            onUse={(id) => {
              createCanvasFromTemplate(id)
              setTemplatesOpen(false)
            }}
            onClose={() => setTemplatesOpen(false)}
          />
        </CanvasPanelPresence>
        <CanvasPanelPresence open={historyOpen} side="right">
          <HistoryPanel
            results={generatedHistoryItems}
            onOpen={(item) => {
              if (item.nodeId) {
                selectNode(item.nodeId)
                openResultComposer(item.nodeId)
                setHistoryOpen(false)
                return
              }
              setImagePreview({ image: item.image, name: item.name })
            }}
            onClose={() => setHistoryOpen(false)}
          />
        </CanvasPanelPresence>
        {nodeReferencesOpen && selectedGenerate ? (
          <NodeReferencePanel
            node={{ id: selectedGenerate.id, data: selectedGenerate.data as GenerateNodeData }}
            references={canvasAssetReferences}
            connectedNodeIds={selectedGenerateReferenceNodeIds}
            disabled={generationStatus === 'uploading' || generationStatus === 'queued' || generationStatus === 'running'}
            onToggle={(assetNodeId, enabled) => toggleNodeReference(selectedGenerate.id, assetNodeId, enabled)}
            onSetPrimary={(assetNodeId) => setGenerateNodePrimaryInput(selectedGenerate.id, assetNodeId)}
            onClose={() => setNodeReferencesOpen(false)}
          />
        ) : null}
        {candidatesOpen ? (
          <GenerationPanel
            status={generationStatus}
            pendingCount={expectedCandidateCount}
            error={generationError}
            kind={lastGenerationRequest?.kind}
            candidates={generationCandidates}
            onSelect={(id) => {
              selectGenerationCandidate(id)
              setCandidatesOpen(false)
            }}
            onCancel={() => {
              cancelGeneration()
              setCandidatesOpen(false)
            }}
            onRetry={() => {
              void retryGeneration().then((started) => {
                if (started) setCandidatesOpen(true)
              })
            }}
            onClose={() => setCandidatesOpen(false)}
          />
        ) : null}
        <CanvasPanelPresence open={deliveryOpen} side="right">
          <DeliveryPanel
            target={selectedReadyResultData && selectedResult ? {
              nodeId: selectedResult.id,
              versionId: selectedReadyResultData.versionId,
              image: selectedReadyResultData.image!,
              label: selectedReadyResultData.label ?? '已选首图',
            } : undefined}
            deliveries={document.deliveries}
            onCreate={createLocalDeliveries}
            onClose={() => setDeliveryOpen(false)}
          />
        </CanvasPanelPresence>
        {assetToDelete ? (
          <ConfirmationDialog
            asset={assetToDelete}
            onConfirm={() => {
              deleteAsset(assetToDelete.id)
              setAssetToDelete(null)
            }}
            onCancel={() => setAssetToDelete(null)}
          />
        ) : null}
        {imagePreview ? (
          <div className="image-preview-backdrop" role="presentation" onMouseDown={() => setImagePreview(null)}>
            <section className="image-preview-dialog" role="dialog" aria-modal="true" aria-label={`${imagePreview.name}预览`} onMouseDown={(event) => event.stopPropagation()}>
              <button className="image-preview-dialog__download" type="button" aria-label="下载原图" title="下载原图" onClick={() => void downloadImage(imagePreview.image, imagePreview.name)}><DownloadIcon /></button>
              <button className="image-preview-dialog__close" type="button" onClick={() => setImagePreview(null)} aria-label="关闭图片预览">×</button>
              <img src={imagePreview.image} alt={imagePreview.name} />
            </section>
          </div>
        ) : null}

        {undoAction ? <UndoToast label={undoAction.label} onUndo={undoLastAction} /> : null}
      </section>

      {creativeAssistantEnabled && agentOpen ? <AgentPanel message={assistantMessage} onClose={() => setAgentOpen(false)} /> : null}
      {creativeAssistantEnabled && !agentOpen ? <button className="reopen-agent" onClick={() => setAgentOpen(true)}>打开创作助手</button> : null}
    </main>
  )
}

type AssetLibraryProps = {
  assets: AssetRecord[]
  onAdd: (id: string) => void
  onUpload: (assets: UploadedAssetInput[]) => void
  onDelete: (asset: AssetRecord) => void
  onClose: () => void
}

type PendingUpload = UploadedAssetInput & {
  id: string
  tagsText: string
}

const maxUploadAssets = 12
const maximumUploadImageBytes = 8 * 1024 * 1024
const supportedUploadTypes = new Set(['image/png', 'image/jpeg', 'image/webp'])
const uploadRoles: UploadedAssetInput['role'][] = ['商品', '模特', '场景', '调性']

function validateUploadFiles(files: File[]) {
  const accepted = files.filter((file) => supportedUploadTypes.has(file.type) && file.size > 0 && file.size <= maximumUploadImageBytes)
  const rejected = files.length - accepted.length
  const message = rejected
    ? `已跳过 ${rejected} 个文件：仅支持 PNG、JPEG、WebP，单张不超过 8MB。`
    : ''
  return { accepted, message }
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('读取图片失败'))
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

function readImageDimensions(source: string) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => reject(new Error('无法读取图片尺寸'))
    image.src = source
  })
}

async function readUploadedAssetInput(
  file: File,
  role: UploadedAssetInput['role'],
): Promise<UploadedAssetInput> {
  const image = await readFileAsDataUrl(file)
  const { width: imageWidth, height: imageHeight } = await readImageDimensions(image)
  return {
    name: file.name.replace(/\.[^.]+$/, ''),
    image,
    imageWidth,
    imageHeight,
    role,
    tags: ['上传素材'],
  }
}

function imagePreviewSize(imageWidth: number, imageHeight: number) {
  const scale = Math.min(320 / imageWidth, 340 / imageHeight, 1)
  return {
    width: Math.max(1, Math.round(imageWidth * scale)),
    height: Math.max(1, Math.round(imageHeight * scale)),
  }
}

async function downloadImage(image: string, name: string) {
  const safeName = name.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-').slice(0, 80) || 'botanic-image'
  try {
    const response = await fetch(image)
    if (!response.ok) throw new Error('图片下载失败')
    const blob = await response.blob()
    const extension = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png'
    const objectUrl = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = `${safeName}.${extension}`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000)
  } catch {
    const anchor = document.createElement('a')
    anchor.href = image
    anchor.download = `${safeName}.png`
    anchor.target = '_blank'
    anchor.rel = 'noreferrer'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  }
}

function AssetLibrary({ assets, onAdd, onUpload, onDelete, onClose }: AssetLibraryProps) {
  const [role, setRole] = useState<'全部' | AssetRole>('全部')
  const [source, setSource] = useState<'全部' | AssetSource>('全部')
  const [query, setQuery] = useState('')
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([])
  const [isDraggingFiles, setIsDraggingFiles] = useState(false)
  const [uploadMessage, setUploadMessage] = useState('')
  const [assetMenuId, setAssetMenuId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const roles: Array<'全部' | AssetRole> = ['全部', '商品', '模特', '场景', '调性']
  const stageFiles = async (files: File[]) => {
    const { accepted: imageFiles, message } = validateUploadFiles(files)
    const allowed = imageFiles.slice(0, Math.max(0, maxUploadAssets - pendingUploads.length))
    if (!allowed.length) {
      setUploadMessage(pendingUploads.length >= maxUploadAssets ? `单次最多暂存 ${maxUploadAssets} 张图片` : message || '请选择 PNG、JPEG 或 WebP 图片')
      return
    }

    const loaded = await Promise.allSettled(allowed.map(async (file, index): Promise<PendingUpload> => ({
      ...await readUploadedAssetInput(file, '商品'),
      id: `pending-${Date.now()}-${index}-${file.name}`,
      tagsText: '上传素材',
    })))
    const staged = loaded
      .filter((result): result is PromiseFulfilledResult<PendingUpload> => result.status === 'fulfilled')
      .map((result) => result.value)
    setPendingUploads((items) => [...items, ...staged])
    setUploadMessage(message || (imageFiles.length > allowed.length ? `已暂存 ${staged.length} 张，单次最多 ${maxUploadAssets} 张` : ''))
  }
  const updatePending = (id: string, patch: Partial<PendingUpload>) => {
    setPendingUploads((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item))
  }
  const savePendingUploads = () => {
    if (!pendingUploads.length) return
    onUpload(pendingUploads.map(({ name, image, imageWidth, imageHeight, role: itemRole, tagsText }) => ({
      name,
      image,
      imageWidth,
      imageHeight,
      role: itemRole,
      tags: tagsText.split(/[，,]/).map((tag) => tag.trim()).filter(Boolean),
    })))
    setPendingUploads([])
    setSource('upload')
    setQuery('')
    setUploadMessage('已存入本地素材库')
  }
  const visibleItems = assets.filter((item) => {
    const matchesRole = role === '全部' || item.role === role
    const matchesSource = source === '全部' || item.source === source
    const keyword = query.trim().toLowerCase()
    const matchesQuery = !keyword || [item.name, item.role, item.source, ...item.tags].join(' ').toLowerCase().includes(keyword)
    return matchesRole && matchesSource && matchesQuery
  })

  return (
    <aside className={pendingUploads.length ? 'asset-library has-pending-uploads' : 'asset-library'} aria-label="素材库">
      <div className="asset-library__header">
        <div>
          <h2>素材库</h2>
        </div>
        <div className="asset-library__header-actions">
          <button className="close-panel" onClick={onClose} aria-label="关闭素材库">×</button>
        </div>
      </div>
      <input
        ref={fileInputRef}
        className="asset-file-input"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        aria-label="批量上传图片素材"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? [])
          event.currentTarget.value = ''
          void stageFiles(files)
        }}
      />
      <div
        className={isDraggingFiles ? 'asset-dropzone is-dragging' : 'asset-dropzone'}
        onDragOver={(event) => {
          event.preventDefault()
          setIsDraggingFiles(true)
        }}
        onDragLeave={() => setIsDraggingFiles(false)}
        onDrop={(event) => {
          event.preventDefault()
          setIsDraggingFiles(false)
          void stageFiles(Array.from(event.dataTransfer.files))
        }}
      >
        <span>拖入图片，或</span>
        <button onClick={() => fileInputRef.current?.click()}>选择文件</button>
        <small>PNG / JPEG / WebP，单张不超过 8MB，单次最多 {maxUploadAssets} 张</small>
      </div>
      {uploadMessage ? <p className="upload-message">{uploadMessage}</p> : null}
      {pendingUploads.length ? (
        <section className="upload-staging" aria-label="待入库素材">
          <div className="upload-staging__header">
            <strong>待入库 · {pendingUploads.length}/{maxUploadAssets}</strong>
            <button onClick={() => setPendingUploads([])}>清空</button>
          </div>
          <div className="upload-staging__list">
            {pendingUploads.map((item) => (
              <article className="upload-staging__item" key={item.id}>
                <img src={item.image} alt={item.name} />
                <div>
                  <input value={item.name} onChange={(event) => updatePending(item.id, { name: event.target.value })} aria-label={`素材名称 ${item.name}`} />
                  <div className="upload-staging__fields">
                    <select value={item.role} onChange={(event) => updatePending(item.id, { role: event.target.value as UploadedAssetInput['role'] })} aria-label={`${item.name} 的角色`}>
                      {uploadRoles.map((itemRole) => <option value={itemRole} key={itemRole}>{itemRole}</option>)}
                    </select>
                    <input value={item.tagsText} onChange={(event) => updatePending(item.id, { tagsText: event.target.value })} placeholder="标签，用逗号分隔" aria-label={`${item.name} 的标签`} />
                  </div>
                </div>
                <button className="upload-staging__remove" onClick={() => setPendingUploads((items) => items.filter((pending) => pending.id !== item.id))} aria-label={`移除待上传素材 ${item.name}`}>×</button>
              </article>
            ))}
          </div>
          <div className="upload-staging__footer">
            <span>确认后可拖入画布</span>
            <button onClick={savePendingUploads}>入库 {pendingUploads.length} 张</button>
          </div>
        </section>
      ) : null}
      <input className="asset-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索素材或标签" aria-label="搜索素材" />
      <div className="asset-filter-group">
        <span className="asset-filter-group__label">类型</span>
        <div className="asset-tabs" role="group" aria-label="素材类型">
          {roles.map((item) => (
            <button type="button" key={item} className={role === item ? 'is-active' : ''} aria-pressed={role === item} onClick={() => setRole(item)}>{item}</button>
          ))}
        </div>
      </div>
      <div className="asset-filter-group">
        <span className="asset-filter-group__label">来源</span>
        <div className="asset-source-tabs" role="group" aria-label="素材来源">
          {(['全部', 'brand', 'upload', 'generated'] as const).map((item) => (
            <button type="button" key={item} className={source === item ? 'is-active' : ''} aria-pressed={source === item} onClick={() => setSource(item)}>
              {item === '全部' ? '全部' : item === 'brand' ? '共享品牌' : item === 'upload' ? '本地上传' : '生成入库'}
            </button>
          ))}
        </div>
      </div>
      <p className="asset-library__count">{role === '全部' && source === '全部' ? '全部素材' : `${role === '全部' ? '' : `${role} · `}${source === '全部' ? '' : source === 'brand' ? '共享品牌' : source === 'upload' ? '本地上传' : '生成入库'}`} · {visibleItems.length} 个素材</p>
      <div className="asset-grid">
        {visibleItems.length ? visibleItems.map((item) => (
          <article
            className={assetMenuId === item.id ? 'asset-card is-menu-open' : 'asset-card'}
            key={item.id}
            draggable
            title="可直接拖拽到画布"
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData('application/x-botanic-asset-id', item.id)
              event.dataTransfer.setData('text/plain', item.id)
            }}
          >
            <img src={item.image} alt={item.name} />
            {source === '全部' ? <span className={`asset-card__source asset-card__source--${item.source}`}>{item.source === 'brand' ? '共享品牌' : item.source === 'upload' ? '本地上传' : '生成入库'}</span> : null}
            <div className="asset-card__copy">
              <strong>{item.name}</strong>
              <span>{visibleAssetTags(item.tags).filter((tag) => item.source !== 'generated' || !/^(生成|真实生成|已入库|生成入库)$/i.test(tag)).slice(0, 2).join(' · ')}</span>
            </div>
            <div className="asset-card__actions">
              <button className="asset-card__add" onClick={() => onAdd(item.id)}>加入画布</button>
              <div className="asset-card__more-wrap">
                <button
                  className="asset-card__more"
                  type="button"
                  aria-label={`更多操作：${item.name}`}
                  aria-expanded={assetMenuId === item.id}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation()
                    setAssetMenuId((activeId) => activeId === item.id ? null : item.id)
                  }}
                >⋯</button>
                {assetMenuId === item.id ? (
                  <div className="asset-card__menu" role="menu" aria-label={`${item.name} 的更多操作`}>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setAssetMenuId(null)
                        onDelete(item)
                      }}
                    >删除素材</button>
                  </div>
                ) : null}
              </div>
            </div>
          </article>
        )) : <p className="asset-empty">没有匹配的素材</p>}
      </div>
    </aside>
  )
}

function TemplatePanel({
  templates,
  currentName,
  canSave,
  onSave,
  onUse,
  onClose,
}: {
  templates: CanvasTemplate[]
  currentName: string
  canSave: boolean
  onSave: (name: string) => void
  onUse: (id: string) => void
  onClose: () => void
}) {
  const [name, setName] = useState(`${currentName} · 视觉目标`)
  return (
    <aside className="workbench-panel template-panel" aria-label="工作流模板">
      <PanelHeader eyebrow="WORKFLOW TEMPLATE" title="工作流模板" onClose={onClose} />
      <form className="template-save" onSubmit={(event) => { event.preventDefault(); if (canSave) onSave(name) }}>
        <label htmlFor="template-name">将当前节点结构保存为模板</label>
        <div>
          <input id="template-name" value={name} onChange={(event) => setName(event.target.value)} disabled={!canSave} />
          <button type="submit" disabled={!canSave}>保存</button>
        </div>
      </form>
      <p className="panel-note">{canSave ? '仅保留素材、文本、生成节点和参数；不会复制已执行任务、候选或旧输出。' : '添加素材、描述或生成节点后，可保存为模板。'}</p>
      <div className="template-list">
        {templates.map((template) => (
          <article className="template-card" key={template.id}>
            <img src={template.image} alt={template.name} />
            <div>
              <strong>{template.name}</strong>
              <span>{template.sourceHistoryId ? '源自画布历史' : '当前画布模板'}</span>
              <button onClick={() => onUse(template.id)}>使用模板</button>
            </div>
          </article>
        ))}
      </div>
    </aside>
  )
}

function HistoryPanel({
  results,
  onOpen,
  onClose,
}: {
  results: GeneratedHistoryItem[]
  onOpen: (item: GeneratedHistoryItem) => void
  onClose: () => void
}) {
  return (
    <aside className="workbench-panel history-panel" aria-label="画布历史">
      <PanelHeader title="画布历史" onClose={onClose} />
      {results.length ? <div className="history-gallery">
        {results.map((item) => <article className="history-gallery__item" key={item.id}>
          <button type="button" className="history-gallery__open" onClick={() => onOpen(item)} aria-label={`打开 ${item.name}`} title={item.name}>
            <img src={item.image} alt={item.name} />
          </button>
          <button
            type="button"
            className="history-gallery__download"
            aria-label={`下载 ${item.name}`}
            title="下载原图"
            onClick={() => void downloadImage(item.image, item.name)}
          ><DownloadIcon /></button>
        </article>)}
      </div> : <p className="panel-note">暂无生成图片</p>}
    </aside>
  )
}

type CanvasReferenceControl = {
  nodeId: string
  assetId: string
  name: string
  image: string
  role: AssetRole
  source?: AssetSource
  referenceEnabled: boolean
  primary: boolean
  priority: number
}

function ReferenceRecipePanel({
  references,
  prompt,
  batchCount,
  settings,
  inheritedRecipe,
  isRefinement,
  disabled,
  onSetReferenceEnabled,
  onSetPrimary,
  onMoveReference,
  onClose,
}: {
  references: CanvasReferenceControl[]
  prompt: string
  batchCount: number
  settings: GenerationSettings
  inheritedRecipe?: GenerationRecipe
  isRefinement: boolean
  disabled: boolean
  onSetReferenceEnabled: (nodeId: string, enabled: boolean) => void
  onSetPrimary: (nodeId: string) => void
  onMoveReference: (nodeId: string, direction: 'earlier' | 'later') => void
  onClose: () => void
}) {
  const activeReferences = references.filter((reference) => reference.referenceEnabled)
  const livePrimary = activeReferences.find((reference) => reference.primary && reference.role === '商品')
    ?? activeReferences.find((reference) => reference.role === '商品')
  const liveRecipe: GenerationRecipe = {
    primaryReferenceNodeId: livePrimary?.nodeId,
    references: activeReferences.map((reference) => ({
      nodeId: reference.nodeId,
      assetId: reference.assetId,
      name: reference.name,
      image: reference.image,
      role: reference.role,
      source: reference.source,
      primary: reference.nodeId === livePrimary?.nodeId,
      priority: reference.priority,
    })),
    prompt,
    batchCount,
    settings,
  }
  const displayedRecipe = inheritedRecipe ?? liveRecipe
  const recipePrimary = primaryReferenceFromRecipe(displayedRecipe)
  const readOnly = isRefinement
  return (
    <aside className="workbench-panel reference-panel" aria-label="本次生成参考">
      <PanelHeader eyebrow="GENERATION RECIPE" title={isRefinement ? '继承的生成配方' : '本次生成参考'} onClose={onClose} />
      <p className="panel-note">{readOnly
        ? inheritedRecipe ? '精修会继承父版本的参考配方；为保证可追溯性，此处仅供查看。' : '该旧版本尚未保存配方；下方展示当前画布参考。'
        : '勾选本次要使用的画布素材，并锁定一张主商品。主商品会固定生成主体。'}</p>

      <section className="recipe-summary" aria-label="生成配方摘要" aria-live="polite">
        <div><span>主商品</span><strong>{recipePrimary?.name ?? '未锁定'}</strong></div>
        <div><span>参考</span><strong>{displayedRecipe.references.length} 个</strong></div>
        <div><span>输出</span><strong>{displayedRecipe.settings.aspectRatio} · {displayedRecipe.settings.resolution}</strong></div>
        <p title={displayedRecipe.prompt}>{displayedRecipe.prompt || '尚未填写生成描述'}</p>
        <small>真实任务 · {displayedRecipe.batchCount} 张候选</small>
      </section>

      <div className="reference-list" aria-label="画布参考素材">
        {references.length ? references.map((reference) => {
          const isLockedPrimary = reference.primary && reference.referenceEnabled
          return (
            <article className={['reference-item', reference.referenceEnabled ? '' : 'is-off', reference.primary ? 'is-primary' : ''].filter(Boolean).join(' ')} key={reference.nodeId}>
              <img src={reference.image} alt={reference.name} />
              <div className="reference-item__copy">
                <span>P{reference.priority} · {reference.role} · {reference.source === 'upload' ? '本地上传' : reference.source === 'generated' ? '生成入库' : '共享品牌'}</span>
                <strong>{reference.name}</strong>
              </div>
              <div className="reference-item__actions">
                <label className="reference-toggle">
                  <input
                    type="checkbox"
                    checked={reference.referenceEnabled}
                    disabled={disabled || readOnly || isLockedPrimary}
                    onChange={(event) => onSetReferenceEnabled(reference.nodeId, event.target.checked)}
                    aria-label={`${reference.referenceEnabled ? '取消使用' : '使用'} ${reference.name} 作为本次生成参考`}
                  />
                  <span>{isLockedPrimary ? '主商品已锁定' : '参与生成'}</span>
                </label>
                {reference.role === '商品' ? (
                  <button
                    className={reference.primary ? 'reference-primary is-active' : 'reference-primary'}
                    disabled={disabled || readOnly || reference.primary}
                    onClick={() => onSetPrimary(reference.nodeId)}
                  >{reference.primary ? '主商品' : '设为主商品'}</button>
                ) : <span className="reference-role">辅助参考</span>}
                {reference.referenceEnabled && !reference.primary && !readOnly ? (
                  <div className="reference-order-actions" aria-label={`调整 ${reference.name} 的参考顺序`}>
                    <button disabled={disabled} onClick={() => onMoveReference(reference.nodeId, 'earlier')} aria-label={`提升 ${reference.name} 的参考优先级`}>↑</button>
                    <button disabled={disabled} onClick={() => onMoveReference(reference.nodeId, 'later')} aria-label={`降低 ${reference.name} 的参考优先级`}>↓</button>
                  </div>
                ) : null}
              </div>
            </article>
          )
        }) : <p className="asset-empty">画布中还没有可配置的素材</p>}
      </div>
    </aside>
  )
}

function NodeReferencePanel({
  node,
  references,
  connectedNodeIds,
  disabled,
  onToggle,
  onSetPrimary,
  onClose,
}: {
  node: { id: string; data: GenerateNodeData }
  references: CanvasReferenceControl[]
  connectedNodeIds: Set<string>
  disabled: boolean
  onToggle: (assetNodeId: string, enabled: boolean) => void
  onSetPrimary: (assetNodeId: string) => void
  onClose: () => void
}) {
  const connectedReferences = references
    .filter((reference) => connectedNodeIds.has(reference.nodeId))
    .sort((left, right) => {
      const leftIndex = node.data.inputOrder?.indexOf(left.nodeId) ?? -1
      const rightIndex = node.data.inputOrder?.indexOf(right.nodeId) ?? -1
      return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex)
    })
  const primary = connectedReferences.find((reference) => reference.nodeId === node.data.primaryInputId)
  const atLimit = connectedReferences.length >= 8
  return (
    <aside className="workbench-panel reference-panel node-reference-panel" aria-label={`${node.data.label}的参考输入`}>
      <PanelHeader eyebrow="NODE INPUTS" title={`${node.data.label} · ${connectedReferences.length} 个参考`} onClose={onClose} />
      <p className="panel-note">选择要连入当前节点的素材；主商品决定生成主体。</p>

      <div className="reference-list" aria-label="可连接的画布素材">
        {references.length ? references.map((reference) => {
          const connected = connectedNodeIds.has(reference.nodeId)
          const isPrimary = connected && reference.nodeId === primary?.nodeId
          return (
            <article className={['reference-item', connected ? '' : 'is-off', isPrimary ? 'is-primary' : ''].filter(Boolean).join(' ')} key={reference.nodeId}>
              <img src={reference.image} alt={reference.name} />
              <div className="reference-item__copy">
                <span>{reference.role}</span>
                <strong>{reference.name}</strong>
              </div>
              <div className="reference-item__actions">
                <label className="reference-toggle">
                  <input
                    type="checkbox"
                    checked={connected}
                    disabled={disabled || (!connected && atLimit)}
                    onChange={(event) => onToggle(reference.nodeId, event.target.checked)}
                    aria-label={`${connected ? '断开' : '连接'} ${reference.name} 到 ${node.data.label}`}
                  />
                  <span>{connected ? '已连入节点' : atLimit ? '最多 8 张' : '连接到节点'}</span>
                </label>
                {connected && reference.role === '商品' ? (
                  isPrimary
                    ? <span className="reference-role is-primary">主商品</span>
                    : <button type="button" disabled={disabled} onClick={() => onSetPrimary(reference.nodeId)}>设为主商品</button>
                ) : null}
              </div>
            </article>
          )
        }) : <p className="asset-empty">先把素材加入画布，才能连接到此节点</p>}
      </div>
    </aside>
  )
}

type ComposerRecipe = Pick<GenerationRecipe, 'prompt' | 'batchCount' | 'settings'>

function RecipeDraftEditor({
  recipe,
  maximumBatchCount,
  onSave,
  onCancel,
}: {
  recipe: ComposerRecipe
  maximumBatchCount: number
  onSave: (recipe: ComposerRecipe) => void
  onCancel: () => void
}) {
  const [prompt, setPrompt] = useState(recipe.prompt)
  const [batchCount, setBatchCount] = useState(recipe.batchCount)
  const [settings, setSettings] = useState<GenerationSettings>({ ...recipe.settings })
  const models = useCanvasStore((state) => state.availableModels)
  const updateSettings = (patch: Partial<GenerationSettings>) => setSettings((current) => ({ ...current, ...patch }))
  const modelOptions = models.some((model) => model.id === settings.model)
    ? models
    : [{ id: settings.model, label: settings.model }, ...models]
  const cleanPrompt = prompt.trim()

  return (
    <section className="node-inspector__draft" aria-label="下一次任务草稿">
      <div className="node-inspector__draft-title"><span>下一次任务草稿</span><small>原任务不会被改写</small></div>
      <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} aria-label="编辑生成描述" placeholder="描述下一次要生成的画面" />
      <div className="node-inspector__draft-settings">
        <label><span>模型</span><select aria-label="草稿图像模型" value={settings.model} onChange={(event) => updateSettings({ model: event.target.value })}>{modelOptions.map((model) => <option value={model.id} key={model.id}>{model.label}</option>)}</select></label>
        <label><span>比例</span><select aria-label="草稿画面比例" value={settings.aspectRatio} onChange={(event) => updateSettings({ aspectRatio: event.target.value as GenerationSettings['aspectRatio'] })}><option value="1:1">1:1</option><option value="3:4">3:4</option><option value="4:5">4:5</option><option value="9:16">9:16</option></select></label>
        <label><span>规格</span><select aria-label="草稿输出规格" value={settings.resolution} onChange={(event) => updateSettings({ resolution: event.target.value as GenerationSettings['resolution'] })}><option value="1K">1K</option><option value="2K">2K</option></select></label>
        <label><span>候选</span><input aria-label="草稿候选数量" type="number" min="1" max={maximumBatchCount} value={batchCount} onChange={(event) => setBatchCount(Number(event.target.value))} /></label>
      </div>
      <div className="node-inspector__actions">
        <button onClick={onCancel}>取消</button>
        <button
          className="node-inspector__primary-action"
          disabled={!cleanPrompt}
          onClick={() => onSave({
            prompt: cleanPrompt,
            batchCount: Math.min(maximumBatchCount, Math.max(1, Math.round(batchCount) || 1)),
            settings,
          })}
        >保存到生成器</button>
      </div>
    </section>
  )
}

function nodeEditableLabel(node: CanvasNode) {
  if (node.type === 'asset') return (node.data as AssetNodeData).name
  if (node.type === 'text') return (node.data as TextNodeData).label
  if (node.type === 'generate') return (node.data as GenerateNodeData).label
  if (node.type === 'prompt') return (node.data as PromptNodeData).label
  if (node.type === 'reference') return (node.data as ReferenceGroupNodeData).label
  const data = node.data as ResultNodeData
  return data.label ?? (data.generationKind === 'refinement' ? '定向精修结果' : '首图结果')
}

function NodeNameEditor({ node, onRename }: { node: CanvasNode; onRename: (nodeId: string, label: string) => void }) {
  const currentLabel = nodeEditableLabel(node)
  const [draft, setDraft] = useState(currentLabel)

  useEffect(() => {
    setDraft(currentLabel)
  }, [currentLabel, node.id])

  const save = () => {
    const nextLabel = draft.trim()
    if (!nextLabel || nextLabel === currentLabel) {
      setDraft(currentLabel)
      return
    }
    onRename(node.id, nextLabel)
  }

  return (
    <section className="node-inspector__section node-inspector__rename">
      <div className="node-inspector__section-title"><span>节点名称</span><small>回车保存</small></div>
      <div className="node-inspector__rename-control">
        <input
          value={draft}
          maxLength={48}
          aria-label="节点名称"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
            event.preventDefault()
            save()
          }}
        />
        <button type="button" onClick={save} disabled={!draft.trim() || draft.trim() === currentLabel}>保存</button>
      </div>
    </section>
  )
}

function NodeInspector({
  node,
  asset,
  candidates,
  maximumBatchCount,
  onClose,
  onRename,
  onRemoveAssetNode,
  onApplyRecipe,
  onOpenCandidates,
}: {
  node: CanvasNode
  asset?: AssetRecord
  candidates: GenerationCandidate[]
  maximumBatchCount: number
  onClose: () => void
  onRename: (nodeId: string, label: string) => void
  onRemoveAssetNode: (nodeId: string) => void
  onApplyRecipe: (recipe: ComposerRecipe, restoreReferences?: boolean) => void
  onOpenCandidates: () => void
}) {
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null)
  if (node.type === 'asset') {
    const data = node.data as AssetNodeData
    const source = data.source === 'upload' ? '本地上传' : data.source === 'generated' ? '生成入库' : '共享品牌'
    const assetTags = asset ? visibleAssetTags(asset.tags, asset.source === 'generated' ? '生成入库' : undefined) : []
    return (
      <aside className="workbench-panel node-inspector" aria-label={`${data.name} 节点详情`}>
        <PanelHeader eyebrow="ASSET NODE" title="素材节点" onClose={onClose} />
        <NodeNameEditor node={node} onRename={onRename} />
        <section className="node-inspector__asset">
          <img src={data.image} alt={data.name} />
          <div>
            <span>{data.role} · {source}</span>
            <strong>{data.name}</strong>
            {assetTags.length ? <small>{assetTags.join(' · ')}</small> : null}
          </div>
        </section>
        <section className="node-inspector__section">
          <div className="node-inspector__section-title"><span>使用方式</span><strong>素材输入</strong></div>
          <p>将右侧端口连到某个生成节点后，它才会参与该节点的任务。主商品由生成节点本地设定。</p>
          <div className="node-inspector__actions">
            <button className="node-inspector__danger" onClick={() => onRemoveAssetNode(node.id)}>从画布移除</button>
          </div>
        </section>
      </aside>
    )
  }

  if (node.type === 'prompt') {
    const data = node.data as PromptNodeData
    return (
      <aside className="workbench-panel node-inspector" aria-label="提示词节点详情">
        <PanelHeader eyebrow="PROMPT NODE" title={data.generationKind === 'refinement' ? '定向精修指令' : '视觉目标'} onClose={onClose} />
        <NodeNameEditor node={node} onRename={onRename} />
        <section className="node-inspector__section">
          <div className="node-inspector__section-title"><span>任务状态</span><strong>{taskStatusLabel(data.status)}</strong></div>
          <p className="node-inspector__prompt">{data.prompt}</p>
          <div className="node-inspector__metadata"><span>{data.settings.model}</span><span>{data.settings.aspectRatio} · {data.settings.resolution}</span><span>{data.batchCount} 张候选</span></div>
          {data.error ? <p className="node-inspector__error">{data.error}</p> : null}
          {editingNodeId === node.id ? (
            <RecipeDraftEditor
              key={node.id}
              recipe={data}
              maximumBatchCount={maximumBatchCount}
              onCancel={() => setEditingNodeId(null)}
              onSave={(recipe) => onApplyRecipe(recipe)}
            />
          ) : (
            <div className="node-inspector__actions">
              <button className="node-inspector__primary-action" onClick={() => setEditingNodeId(node.id)}>编辑下一次草稿</button>
              <button onClick={() => onApplyRecipe(data)}>复用参数</button>
            </div>
          )}
        </section>
      </aside>
    )
  }

  if (node.type === 'reference') {
    const data = node.data as ReferenceGroupNodeData
    const primary = primaryReferenceFromRecipe(data.recipe)
    return (
      <aside className="workbench-panel node-inspector" aria-label="参考组节点详情">
        <PanelHeader eyebrow="REFERENCE GROUP" title="参考组快照" onClose={onClose} />
        <NodeNameEditor node={node} onRename={onRename} />
        <section className="node-inspector__section">
          <div className="node-inspector__section-title"><span>任务状态</span><strong>{taskStatusLabel(data.status)}</strong></div>
          <p>该组素材已随任务冻结；主商品为「{primary?.name ?? '未锁定'}」。</p>
          <div className="node-inspector__reference-list">
            {data.recipe.references.map((reference) => (
              <article key={reference.nodeId}>
                <img src={reference.image} alt={reference.name} />
                <div><strong>{reference.name}</strong><span>P{reference.priority ?? '—'} · {reference.role}{reference.primary ? ' · 主商品' : ''}</span></div>
              </article>
            ))}
          </div>
          {data.error ? <p className="node-inspector__error">{data.error}</p> : null}
          <div className="node-inspector__actions">
            <button className="node-inspector__primary-action" onClick={() => onApplyRecipe(data.recipe, true)}>编辑下一次参考组</button>
            <button onClick={() => onApplyRecipe(data.recipe)}>只复用提示与规格</button>
          </div>
        </section>
      </aside>
    )
  }

  if (node.type === 'text') {
    const data = node.data as TextNodeData
    return (
      <aside className="workbench-panel node-inspector" aria-label="文本节点详情">
        <PanelHeader eyebrow="TEXT NODE" title="视觉描述" onClose={onClose} />
        <NodeNameEditor node={node} onRename={onRename} />
        <section className="node-inspector__section">
          <div className="node-inspector__section-title"><span>连接用途</span><strong>生成描述输入</strong></div>
          <p className="node-inspector__prompt">{data.content || '尚未填写描述。'}</p>
          <p>直接在画布节点内编辑；把右侧端口连到生成节点即可生效。</p>
        </section>
      </aside>
    )
  }

  if (node.type === 'generate') {
    const data = node.data as GenerateNodeData
    return (
      <aside className="workbench-panel node-inspector" aria-label="生成节点详情">
        <PanelHeader eyebrow="GENERATE NODE" title={data.label} onClose={onClose} />
        <NodeNameEditor node={node} onRename={onRename} />
        <section className="node-inspector__section">
          <div className="node-inspector__section-title"><span>节点参数</span><strong>{data.settings.aspectRatio} · {data.settings.resolution}</strong></div>
          <div className="node-inspector__metadata"><span>{data.settings.model}</span><span>{data.batchCount} 张候选</span></div>
          <p>图片和文本的连线决定本次输入；参数与补充描述可直接在节点内调整。</p>
        </section>
      </aside>
    )
  }

  const data = node.data as ResultNodeData
  const taskCandidates = candidates.filter((candidate) => candidate.resultNodeId === node.id)
  const resultStatus = data.image ? '已生成' : data.status === 'generating' ? '图像服务处理中' : data.status === 'failed' ? '任务未完成' : data.status === 'cancelled' ? '任务已取消' : '等待生成结果'
  return (
    <aside className="workbench-panel node-inspector" aria-label="结果节点详情">
      <PanelHeader eyebrow="RESULT NODE" title={data.image ? '结果版本' : '任务结果'} onClose={onClose} />
      <NodeNameEditor node={node} onRename={onRename} />
      <section className="node-inspector__section">
        {data.image ? <img className="node-inspector__result-image" src={data.image} alt={data.label ?? '结果版本'} /> : null}
        <div className="node-inspector__section-title"><span>状态</span><strong>{resultStatus}</strong></div>
        <p>{data.label ?? (data.generationKind === 'refinement' ? '定向精修结果' : '首图生成结果')}</p>
        {data.generationRecipe ? <div className="node-inspector__metadata"><span>{recipeSummary(data.generationRecipe)}</span></div> : null}
        {data.error ? <p className="node-inspector__error">{data.error}</p> : null}
        <div className="node-inspector__actions">
          {taskCandidates.length ? <button className="node-inspector__primary-action" onClick={onOpenCandidates}>查看 {taskCandidates.length} 张候选</button> : null}
        </div>
        {data.jobId ? <small className="node-inspector__job-id">任务 ID · {data.jobId}</small> : null}
      </section>
    </aside>
  )
}

function GenerationPanel({
  status,
  pendingCount,
  error,
  kind,
  candidates,
  onSelect,
  onCancel,
  onRetry,
  onClose,
}: {
  status: 'idle' | 'uploading' | 'queued' | 'running' | 'error'
  pendingCount: number
  error: string | null
  kind?: GenerationCandidate['kind']
  candidates: GenerationCandidate[]
  onSelect: (id: string) => void
  onCancel: () => void
  onRetry: () => void
  onClose: () => void
}) {
  const isInFlight = status === 'uploading' || status === 'queued' || status === 'running'
  const statusMessage = status === 'uploading'
    ? '正在上传画布参考素材'
    : status === 'queued'
      ? '图像服务已接收任务，正在排队'
      : '图像服务正在真实生成'
  const isRefinement = kind === 'refinement' || candidates[0]?.kind === 'refinement'
  const parent = candidates.find((candidate) => candidate.kind === 'refinement' && candidate.parentImage)
  const sourceAssetNames = candidates[0]?.sourceAssetNames ?? []
  const recipe = candidates[0]?.recipe
  const primaryReference = primaryReferenceFromRecipe(recipe)
  return (
    <aside className="workbench-panel generation-panel" aria-label="真实生成候选">
      <PanelHeader eyebrow={isRefinement ? 'REAL REFINEMENT' : 'REAL GENERATION'} title={isInFlight ? statusMessage : status === 'error' ? '生成需要处理' : `${isRefinement ? '精修' : '首图'}候选 · ${candidates.length}`} onClose={onClose} />
      <p className="panel-note">{isRefinement ? '候选会继承父版本配方；选择后写入同一条“素材/文本 → 生成 → 结果”图谱，并可在历史中一键回退。' : sourceAssetNames.length ? `真实任务以已选参考「${sourceAssetNames.join('、')}」为依据，并固定主商品。` : '选择一张首图会写入结果节点、生成版本分支，并进入素材库的“生成入库”。'}</p>
      {recipe ? <div className="candidate-recipe" aria-label="候选生成配方"><strong>{primaryReference ? `主商品 · ${primaryReference.name}` : '继承父版本'}</strong><span>{recipe.references.length} 个参考 · {recipe.settings.aspectRatio} / {recipe.settings.resolution}</span></div> : null}
      {isInFlight ? (
        <div className="generation-progress" role="status" aria-label={`正在真实生成 ${pendingCount} 个候选`}>
          <div><span className="is-indeterminate" /></div>
          <span>{statusMessage} · 目标 {pendingCount} 张</span>
          <button onClick={onCancel}>取消生成</button>
        </div>
      ) : null}
      {status === 'error' ? (
        <div className="generation-error" role="alert">
          <span>{error ?? '生成失败，请重试。'}</span>
          <button onClick={onRetry}>重试</button>
        </div>
      ) : null}
      {parent ? (
        <section className="version-compare" aria-label="父版本与精修候选对比">
          <img src={parent.parentImage} alt={parent.parentLabel ?? '父版本'} />
          <div>
            <span>父版本</span>
            <strong>{parent.parentLabel ?? '已选首图'}</strong>
            <p>{parent.refinementInstruction}</p>
          </div>
        </section>
      ) : null}
      <div className="candidate-grid">
        {isInFlight ? Array.from({ length: Math.max(1, pendingCount) }, (_, index) => <div className="candidate-skeleton" key={index} />) : null}
        {status === 'idle' && candidates.length === 0 ? <p className="asset-empty">先在下方输入描述并发起真实生成</p> : null}
        {status === 'idle' ? candidates.map((candidate) => (
          <button className={`${candidate.selected ? 'candidate-card is-selected' : 'candidate-card'} candidate-card--ratio-${candidate.settings.aspectRatio.replace(':', '-')}`} key={candidate.id} onClick={() => onSelect(candidate.id)}>
            <img src={candidate.image} alt={candidate.name} />
            <span>{candidate.name}</span>
            <small>{candidate.kind === 'refinement' ? `精修自 ${candidate.parentLabel ?? '已选首图'}` : `主商品 · ${primaryReferenceFromRecipe(candidate.recipe)?.name ?? '未锁定'}`} · {candidate.recipe.references.length} 参考</small>
          </button>
        )) : null}
      </div>
    </aside>
  )
}

type DeliveryPanelTarget = {
  nodeId: string
  versionId?: string
  image: string
  label: string
}

function DeliveryPanel({
  target,
  deliveries,
  onCreate,
  onClose,
}: {
  target?: DeliveryPanelTarget
  deliveries: DeliveryArtifact[]
  onCreate: (input: {
    targetNodeId: string
    presets: DeliveryPresetId[]
    title: string
    subtitle: string
    safeZone: boolean
  }) => void
  onClose: () => void
}) {
  const [selectedPresets, setSelectedPresets] = useState<DeliveryPresetId[]>(() => deliveryPresets.map((preset) => preset.id))
  const [title, setTitle] = useState('夏日香氛 · 清透留白')
  const [subtitle, setSubtitle] = useState('自然植萃，轻盈入夏')
  const [safeZone, setSafeZone] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [exportMessage, setExportMessage] = useState('')

  const targetDeliveries = useMemo(() => {
    if (!target) return []
    return deliveryPresets.flatMap((preset) => {
      const artifact = deliveries.find((item) => item.targetNodeId === target.nodeId && item.presetId === preset.id)
      return artifact ? [artifact] : []
    })
  }, [deliveries, target])

  useEffect(() => {
    if (!target) return
    const existing = deliveries.find((item) => item.targetNodeId === target.nodeId)
    if (!existing) return
    setTitle(existing.title)
    setSubtitle(existing.subtitle)
    setSafeZone(existing.safeZone)
  }, [deliveries, target])

  const togglePreset = (presetId: DeliveryPresetId) => {
    setSelectedPresets((items) => items.includes(presetId)
      ? items.filter((item) => item !== presetId)
      : [...items, presetId])
  }

  const handleCreate = () => {
    if (!target || !selectedPresets.length) return
    setExportMessage('')
    onCreate({
      targetNodeId: target.nodeId,
      presets: selectedPresets,
      title,
      subtitle,
      safeZone,
    })
  }

  const handleExport = async () => {
    if (!targetDeliveries.length || exporting) return
    setExporting(true)
    setExportMessage('')
    try {
      const result = await downloadDeliveryPackage(targetDeliveries)
      setExportMessage(`已下载 ZIP：${result.fileCount} 个文件（含 manifest）`)
    } catch (error) {
      setExportMessage(error instanceof Error ? error.message : '导出失败，请重试')
    } finally {
      setExporting(false)
    }
  }

  return (
    <aside className="workbench-panel delivery-panel" aria-label="投放交付">
      <PanelHeader eyebrow="DELIVERY KIT" title="投放交付" onClose={onClose} />
      {target ? (
        <div className="delivery-target">
          <img src={target.image} alt={target.label} />
          <div>
            <span>当前首图</span>
            <strong>{target.label}</strong>
            <small>{target.versionId ? '已关联画布版本' : '未写入版本的当前首图'}</small>
          </div>
        </div>
      ) : (
        <p className="delivery-empty">请先在画布中选中一张生成首图，再派生投放规格。</p>
      )}

      <section className="delivery-section" aria-label="投放规格">
        <div className="delivery-section__title">
          <strong>投放规格</strong>
          <span>{selectedPresets.length}/3</span>
        </div>
        <div className="delivery-preset-list">
          {deliveryPresets.map((preset) => {
            const active = selectedPresets.includes(preset.id)
            return (
              <button
                type="button"
                className={active ? 'delivery-preset is-active' : 'delivery-preset'}
                key={preset.id}
                onClick={() => togglePreset(preset.id)}
                aria-pressed={active}
              >
                <span className={`delivery-preset__ratio delivery-preset__ratio--${preset.id}`} />
                <span><strong>{preset.channel}</strong><small>{preset.ratio} · {preset.width}×{preset.height}</small></span>
                <i>{active ? '✓' : ''}</i>
              </button>
            )
          })}
        </div>
      </section>

      <section className="delivery-copy" aria-label="文案与安全区">
        <div className="delivery-section__title"><strong>文案与安全区</strong><span>可选</span></div>
        <label htmlFor="delivery-title">主标题</label>
        <input id="delivery-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="输入投放主标题" />
        <label htmlFor="delivery-subtitle">副标题</label>
        <input id="delivery-subtitle" value={subtitle} onChange={(event) => setSubtitle(event.target.value)} placeholder="输入补充卖点" />
        <label className="delivery-safe-toggle">
          <input type="checkbox" checked={safeZone} onChange={(event) => setSafeZone(event.target.checked)} />
          <span><strong>显示文案安全区</strong><small>预览中标注，导出图会将文案放入该区域</small></span>
          <i aria-hidden="true" />
        </label>
      </section>

      <button className="delivery-create" onClick={handleCreate} disabled={!target || !selectedPresets.length}>派生 {selectedPresets.length || ''} 个规格</button>
      <p className="delivery-note">仅做本地等比例裁切与文案合成；尚未调用真实投放或生成 API。</p>

      {targetDeliveries.length ? (
        <section className="delivery-results" aria-label="投放预览">
          <div className="delivery-section__title"><strong>投放预览</strong><span>{targetDeliveries.length} 个</span></div>
          <div className="delivery-preview-list">
            {targetDeliveries.map((artifact) => {
              const preset = deliveryPresets.find((item) => item.id === artifact.presetId)
              if (!preset) return null
              return (
                <article className="delivery-preview-card" key={artifact.id}>
                  <div className={`delivery-preview delivery-preview--${artifact.presetId}`}>
                    <img src={artifact.image} alt={`${artifact.targetLabel} · ${preset.channel}`} />
                    {artifact.title || artifact.subtitle ? (
                      <div className="delivery-preview__copy">
                        {artifact.title ? <strong>{artifact.title}</strong> : null}
                        {artifact.subtitle ? <small>{artifact.subtitle}</small> : null}
                      </div>
                    ) : null}
                    {artifact.safeZone ? <span className="delivery-preview__safe">安全区</span> : null}
                  </div>
                  <strong>{preset.channel}</strong>
                  <span>{preset.ratio} · {preset.width}×{preset.height}</span>
                </article>
              )
            })}
          </div>
          <button className="delivery-export" onClick={() => void handleExport()} disabled={exporting}>{exporting ? '正在打包…' : '导出 ZIP 交付包'}</button>
          {exportMessage ? <p className="delivery-export-message" role="status">{exportMessage}</p> : null}
        </section>
      ) : null}
    </aside>
  )
}

function PanelHeader({ eyebrow, title, onClose }: { eyebrow?: string; title: string; onClose: () => void }) {
  return (
    <div className="panel-header">
      <div>
        {eyebrow ? <span className="panel-eyebrow">{eyebrow}</span> : null}
        <h2>{title}</h2>
      </div>
      <button className="close-panel" onClick={onClose} aria-label={`关闭${title}`}>×</button>
    </div>
  )
}

function ConfirmationDialog({ asset, onConfirm, onCancel }: { asset: AssetRecord; onConfirm: () => void; onCancel: () => void }) {
  const isSharedBrandAsset = asset.source === 'brand'
  return (
    <div className="confirm-backdrop">
      <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-asset-title">
        <span className="panel-eyebrow">REMOVE ASSET</span>
        <h2 id="delete-asset-title">删除「{asset.name}」？</h2>
        <p>{isSharedBrandAsset
          ? '这会从共享品牌素材库下架，并同步移除所有项目画布、模板与历史配方中的引用。'
          : '这会同步移除当前画布及模板中的引用；历史画布仍会保留为版本记录。'}</p>
        <div>
          <button className="secondary-button" onClick={onCancel}>取消</button>
          <button className="danger-button" onClick={onConfirm}>确认删除</button>
        </div>
      </section>
    </div>
  )
}

type ComposerContext = {
  kind: 'generate' | 'result' | 'asset' | 'text'
  label: string
  detail: string
}

type NodeComposerProps = {
  prompt: string
  batchCount: number
  maximumBatchCount: number
  settings: GenerationSettings
  models: GenerationModelOption[]
  status: 'idle' | 'uploading' | 'queued' | 'running' | 'error'
  service: GenerationServiceState
  hint: string
  canRetry: boolean
  references: Array<{
    id: string
    image: string
    name: string
    role: AssetRole
    source?: AssetSource
    primary: boolean
  }>
  referenceCount: number
  primaryReferenceName?: string
  context?: ComposerContext
  onOpenReferences: () => void
  onOpenAssets: () => void
  onRefreshService: () => void
  target?: {
    nodeId: string
    image: string
    label: string
    recipe?: GenerationRecipe
  }
  placement?: 'canvas' | 'result-anchor'
  onPromptChange: (value: string) => void
  onBatchCountChange: (value: number) => void
  onSettingsChange: (settings: GenerationSettings) => void
  onCancel: () => void
  onRetry: () => void
  onGenerate: () => void
  onDismiss: () => void
  layout: ComposerLayout
  onLayoutChange: (layout: ComposerLayout) => void
}

const refinementShortcuts: Array<{ label: string; prompt: string; aspectRatio?: GenerationSettings['aspectRatio'] }> = [
  { label: '换场景', prompt: '保持商品主体不变，换成阳光穿透的海边度假场景' },
  { label: '调构图', prompt: '保持商品主体不变，让瓶身更突出，顶部留出标题区' },
  { label: '改比例', prompt: '保持商品主体不变，改为 1:1 构图，预留文案空间', aspectRatio: '1:1' },
  { label: '保留商品', prompt: '保持商品主体不变，仅优化光影与环境氛围' },
]

function NodeComposer({ prompt, batchCount, maximumBatchCount, settings, models, status, service, hint, canRetry, references, referenceCount, primaryReferenceName, context, onOpenReferences, onOpenAssets, onRefreshService, target, placement = 'canvas', onPromptChange, onBatchCountChange, onSettingsChange, onCancel, onRetry, onGenerate, onDismiss, layout, onLayoutChange }: NodeComposerProps) {
  const isGenerating = status === 'uploading' || status === 'queued' || status === 'running'
  const isServiceReady = service.status === 'ready'
  const isResultAnchor = placement === 'result-anchor'
  const isNodeBound = context?.kind === 'generate'
  const hasProductReference = Boolean(primaryReferenceName)
  const submissionBlockedReason = !isServiceReady
    ? service.message
    : !prompt.trim()
      ? '请填写本次生成描述。'
      : !hasProductReference
        ? '请在节点输入中设定主商品。'
        : undefined
  const updateSettings = (patch: Partial<GenerationSettings>) => onSettingsChange({ ...settings, ...patch })
  const modelOptions = models.some((model) => model.id === settings.model)
    ? models
    : [{ id: settings.model, label: settings.model }, ...models]
  const composerRef = useRef<HTMLElement | null>(null)
  const dragState = useRef<{ pointerId: number; offsetX: number; offsetY: number; collapsed: boolean } | null>(null)
  const composerStyle: CSSProperties | undefined = !isResultAnchor && layout.dock === 'free' && typeof layout.x === 'number' && typeof layout.y === 'number'
    ? { left: `${layout.x}px`, top: `${layout.y}px`, right: 'auto', bottom: 'auto', transform: 'none' }
    : undefined
  const composerClassName = [
    'node-composer',
    target ? 'is-refining' : '',
    isResultAnchor ? 'is-result-anchor' : '',
    `is-docked-${layout.dock}`,
    layout.collapsed ? 'is-collapsed' : '',
  ].filter(Boolean).join(' ')

  const startComposerDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (isResultAnchor || event.button !== 0) return
    const composer = composerRef.current
    const pane = composer?.closest<HTMLElement>('.canvas-pane')
    if (!composer || !pane) return
    const composerRect = composer.getBoundingClientRect()
    const paneRect = pane.getBoundingClientRect()
    dragState.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - composerRect.left,
      offsetY: event.clientY - composerRect.top,
      collapsed: layout.collapsed,
    }
    onLayoutChange({
      dock: 'free',
      x: Math.max(12, composerRect.left - paneRect.left),
      y: Math.max(12, composerRect.top - paneRect.top),
      collapsed: layout.collapsed,
    })
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  const moveComposer = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragState.current
    const composer = composerRef.current
    const pane = composer?.closest<HTMLElement>('.canvas-pane')
    if (!drag || drag.pointerId !== event.pointerId || !composer || !pane) return
    const paneRect = pane.getBoundingClientRect()
    const composerRect = composer.getBoundingClientRect()
    const maxX = Math.max(12, paneRect.width - composerRect.width - 12)
    const maxY = Math.max(12, paneRect.height - composerRect.height - 12)
    onLayoutChange({
      dock: 'free',
      x: Math.min(maxX, Math.max(12, event.clientX - paneRect.left - drag.offsetX)),
      y: Math.min(maxY, Math.max(12, event.clientY - paneRect.top - drag.offsetY)),
      collapsed: drag.collapsed,
    })
  }

  const stopComposerDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (dragState.current?.pointerId !== event.pointerId) return
    dragState.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return (
    <section ref={composerRef} className={composerClassName} style={composerStyle} aria-label={target ? `${isResultAnchor ? '基于此图继续生成' : '定向精修'} ${target.label}` : context ? `${context.label} 的生成参数` : '生成参数'}>
      <header
        className="node-composer__bar"
        onPointerDown={isResultAnchor ? undefined : startComposerDrag}
        onPointerMove={isResultAnchor ? undefined : moveComposer}
        onPointerUp={isResultAnchor ? undefined : stopComposerDrag}
        onPointerCancel={isResultAnchor ? undefined : stopComposerDrag}
      >
        <div className="node-composer__bar-title"><strong>生成器</strong>{context ? <span title={context.detail}>{context.label}</span> : target ? <span>{isResultAnchor ? '基于此图' : '定向精修'}</span> : null}</div>
        <button
          type="button"
          className="node-composer__collapse"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            onDismiss()
          }}
          aria-label="隐藏生成器"
        >—</button>
      </header>
      {!layout.collapsed ? <>
      {target ? (
        <div className="node-composer__target">
          <img src={target.image} alt={target.label} />
          <div>
            <span>{isResultAnchor ? '当前图片 · 主参考' : '定向精修'}</span>
            <strong>基于 {target.label}</strong>
          </div>
          {isResultAnchor ? <em>继承当前图</em> : <button className="node-composer__recipe-link" onClick={onOpenReferences}>查看配方</button>}
        </div>
      ) : (
        <div className="node-composer__references">
          {references.map((reference) => (
            <span className={reference.primary ? 'composer-reference is-product is-primary' : reference.role === '商品' ? 'composer-reference is-product' : 'composer-reference'} key={reference.id} title={reference.primary ? `${reference.name} · 主商品已锁定` : reference.source === 'upload' ? `${reference.name} · 本地上传` : reference.name}>
              <img src={reference.image} alt={reference.name} />
              <i>{reference.primary ? reference.role === '首图' ? '主参考' : '主商品' : reference.role}</i>
            </span>
          ))}
          <button className="node-composer__reference-button" onClick={onOpenReferences} aria-label={isNodeBound ? '查看当前节点已连参考' : '配置本次生成参考'}>{isNodeBound ? '已连参考' : '本次参考'} · {referenceCount}</button>
          <button onClick={onOpenAssets} aria-label="添加参考素材">＋</button>
        </div>
      )}
      <textarea value={prompt} onChange={(event) => onPromptChange(event.target.value)} aria-invalid={status === 'error'} aria-label={target ? `${isResultAnchor ? '基于' : '精修'} ${target.label} 的描述` : '图像生成描述'} placeholder={target ? '描述这张图要如何调整' : '描述商品、场景、构图与留白要求'} />
      {target ? (
        <div className="refinement-shortcuts" aria-label="精修快捷指令">
          {refinementShortcuts.map((shortcut) => <button key={shortcut.label} onClick={() => {
            onPromptChange(shortcut.prompt)
            if (shortcut.aspectRatio) updateSettings({ aspectRatio: shortcut.aspectRatio })
          }}>{shortcut.label}</button>)}
        </div>
      ) : null}
      <div className="node-composer__footer">
        <div className="parameter-chips">
          <label className="parameter-select composer-model-select"><span className="visually-hidden">图像模型</span><select aria-label="图像模型" value={settings.model} disabled={isGenerating} onChange={(event) => updateSettings({ model: event.target.value })}>{modelOptions.map((model) => <option value={model.id} key={model.id}>{model.label}</option>)}</select></label>
          <label className="parameter-select"><span className="visually-hidden">画面比例</span><select aria-label="画面比例" value={settings.aspectRatio} disabled={isGenerating} onChange={(event) => updateSettings({ aspectRatio: event.target.value as GenerationSettings['aspectRatio'] })}><option value="1:1">1:1</option><option value="3:4">3:4</option><option value="4:5">4:5</option><option value="9:16">9:16</option></select></label>
          <label className="parameter-select"><span className="visually-hidden">输出规格</span><select aria-label="输出规格" value={settings.resolution} disabled={isGenerating} onChange={(event) => updateSettings({ resolution: event.target.value as GenerationSettings['resolution'] })}><option value="1K">1K 快速</option><option value="2K">2K 高质</option></select></label>
          <label>×<input aria-label="候选数量" type="number" min="1" max={maximumBatchCount} value={batchCount} disabled={isGenerating} onChange={(event) => onBatchCountChange(Number(event.target.value))} /></label>
        </div>
        <div className="node-composer__generate">
          <span>{target ? `继续生成 ${batchCount} 张` : `生成 ${batchCount} 张`}</span>
          <button onClick={onGenerate} disabled={isGenerating || Boolean(submissionBlockedReason)} aria-label={target ? '基于当前图片继续生成' : '发起真实生成'} title={submissionBlockedReason}>
            {isGenerating ? <i className="loading-dot" /> : <FigmaIcon src={sendIcon} />}
          </button>
        </div>
      </div>
      <div className={status === 'error' ? 'node-composer__feedback is-error' : 'node-composer__feedback'} role={status === 'error' ? 'alert' : 'status'}>
        <span>{isGenerating
          ? (status === 'uploading' ? '正在上传参考素材…' : status === 'queued' ? '真实任务已入队…' : '图像服务正在生成…')
          : !isServiceReady ? service.message : hint}</span>
        {isGenerating ? <button onClick={onCancel}>取消</button> : null}
        {!isGenerating && !isServiceReady ? <button onClick={onRefreshService} disabled={service.status === 'checking'}>{service.status === 'checking' ? '检查中' : '重新检查'}</button> : null}
        {isServiceReady && status === 'error' && canRetry ? <button onClick={onRetry}>重试</button> : null}
        {!target && !hasProductReference && !isGenerating ? <button onClick={references.length ? onOpenReferences : onOpenAssets}>{references.length ? '锁定主商品' : '添加商品'}</button> : null}
      </div>
      </> : null}
    </section>
  )
}

function UndoToast({ label, onUndo }: { label: string; onUndo: () => void }) {
  return (
    <div className="undo-toast" role="status">
      <span>{label}</span>
      <button onClick={onUndo}>撤销</button>
    </div>
  )
}

function AgentPanel({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <aside className="agent-panel" aria-label="创作助手" data-node-id="894:230350">
      <header className="agent-panel__header">
        <h1>创作助手</h1>
        <button onClick={onClose} aria-label="收起创作助手"><FigmaIcon src={sidebarIcon} /></button>
      </header>
      <div className="agent-panel__message">
        <strong>BOTANIC AGENT</strong>
        <p>{message}</p>
      </div>
      <div className="agent-panel__composer-dock">
        <div className="agent-panel__composer">
          <p>输入 / 调整姿势、光影或构图；@ 可引用节点、素材与版本。</p>
          <div>
            <button>＋ 手动输入</button>
            <button>模型 A <FigmaIcon src={chevronIcon} /></button>
            <span />
            <button className="agent-panel__send" aria-label="发送"><FigmaIcon src={sendIcon} /></button>
          </div>
        </div>
      </div>
    </aside>
  )
}

function App() {
  const [state, setState] = useState<'checking' | 'sign-in' | 'ready' | 'error'>(() => serverPersistenceEnabled ? 'checking' : 'ready')
  const [user, setUser] = useState<ProductUser | null>(null)
  const [accessToken, setAccessToken] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!serverPersistenceEnabled) return
    let active = true
    void readProductSession()
      .then((session) => {
        if (!active) return
        if (session) {
          setUser(session)
          setState('ready')
        } else {
          setState('sign-in')
        }
      })
      .catch((error) => {
        if (!active) return
        setMessage(error instanceof Error ? error.message : '无法连接工作区服务。')
        setState('error')
      })
    return () => { active = false }
  }, [])

  const signIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!accessToken.trim() || (supabaseAuthEnabled && !password)) return
    setState('checking')
    setMessage('')
    try {
      const session = await createProductSession(supabaseAuthEnabled
        ? { email: accessToken.trim(), password }
        : accessToken.trim())
      setUser(session)
      setAccessToken('')
      setPassword('')
      setState('ready')
    } catch (error) {
      setMessage(error instanceof ProductApiError ? error.message : '登录失败，请稍后重试。')
      setState('sign-in')
    }
  }

  if (state === 'ready') return <CanvasWorkspace />

  return (
    <main className="product-access" aria-live="polite">
      <section>
        <span>BOTANIC WORKSPACE</span>
        <h1>{state === 'checking' ? '正在验证工作区访问' : '进入创意工作台'}</h1>
        {state === 'checking' ? <p>正在连接受保护的项目与素材服务…</p> : (
          <form onSubmit={signIn}>
            <p>{state === 'error' ? '服务暂时不可用。' : supabaseAuthEnabled ? '请输入受邀请的工作区邮箱与密码。' : '请输入管理员为你创建的工作区访问令牌。'}</p>
            <label>
              <span>{supabaseAuthEnabled ? '邮箱' : '访问令牌'}</span>
              <input autoComplete={supabaseAuthEnabled ? 'email' : 'current-password'} type={supabaseAuthEnabled ? 'email' : 'password'} value={accessToken} onChange={(event) => setAccessToken(event.target.value)} placeholder={supabaseAuthEnabled ? 'name@company.com' : '粘贴访问令牌'} />
            </label>
            {supabaseAuthEnabled ? <label>
              <span>密码</span>
              <input autoComplete="current-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="输入密码" />
            </label> : null}
            {message ? <small role="alert">{message}</small> : null}
            <button type="submit">进入工作台</button>
          </form>
        )}
        {user ? <small>{user.name}</small> : null}
      </section>
    </main>
  )
}

export default App
