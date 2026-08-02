import { lazy, Suspense, type CSSProperties, type DragEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  ConnectionLineType,
  Handle,
  MiniMap,
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
  type XYPosition,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { defaultGenerationModels } from './domain/canvas'
import { buildBotanicAgentPlan, collectBotanicAgentResults, createBotanicAgentRuntimeSteps, creativeDimensionLabel, insertBotanicAgentMention, readBotanicAgentMentionQuery, recordBotanicAgentCanvasWritebacks, resolveBotanicAgentCanvasCommands, resolveBotanicAgentResultSelection, updateBotanicAgentRuntimeStep, type BotanicAgentActionProposal, type BotanicAgentActionResult, type BotanicAgentArtifact, type BotanicAgentCanvasWriteback, type BotanicAgentExecutionMode, type BotanicAgentIntent, type BotanicAgentMemoryItem, type BotanicAgentMemoryKind, type BotanicAgentMentionQuery, type BotanicAgentMessage, type BotanicAgentPlan, type BotanicAgentRun, type BotanicAgentRuntimeStep, type BotanicAgentSession, type BotanicAgentSkill } from './domain/agent'
import { collectAgentMediaSources, prepareAgentMediaSources } from './domain/agentMedia'
import { canvasZoomMode, generationTaskErrorMessage, planResultGroupPresentation, traceCanvasLineage, type ResultGroupPresentation } from './domain/canvasPresentation'
import { buildDeliveryPreviewArtifacts, canUseForImageDelivery, resolveDeliveryDraft, type DeliveryPanelTarget } from './domain/deliveryPresentation'
import { mediaFileExtension, reducedAspectRatio } from './domain/mediaPresentation'
import { mediaRetryUrl } from './domain/mediaRecovery'
import { shouldRefreshFromRealtimeEvent } from './domain/realtimeSync'
import { videoAspectRatioPolicy } from './domain/videoGeneration'
import { summarizeWorkflowTemplate, type WorkflowTemplateSummary } from './domain/workflowTemplates'
import { useMotionPresence, useRestoreFocus, useRetainedValue, type MotionPhase } from './components/motionPresence'
import { AccountDetailsDialog, AccountMenu, WorkspaceAuditDialog, WorkspaceMembersDialog, type AccountMenuAnchor } from './components/AccountCenter'
import type {
  AssetRecord,
  AssetGroup,
  AssetRole,
  AssetSource,
  AssetNodeData,
  CanvasNode,
  CanvasTemplate,
  DeliveryArtifact,
  DeliveryPresetId,
  GenerationCandidate,
  GenerationModelOption,
  GenerationMediaKind,
  GenerationRecipe,
  GenerationSettings,
  VideoInputMode,
  RefinementMode,
  GenerateNodeData,
  PromptNodeData,
  ReferenceGroupNodeData,
  ResultNodeData,
  TextNodeData,
  UploadedAssetInput,
} from './domain/canvas'
import { deliveryPresets, downloadDeliveryPackage } from './lib/deliveryExport'
import { createPersistentBotanicAgentRun, createProjectAgentSkill, executePersistentBotanicAgentRun, executeProjectAgentAction, listPersistentBotanicAgentRuns, listProjectAgentSkills, persistAgentReferenceMedia, requestBotanicAgentPlan } from './lib/agentApi'
import { getGenerationServiceHealth } from './lib/generationApi'
import { refinePrompt } from './lib/promptRefinementApi'
import { connectCanvasCollaboration, type CanvasCollaboration } from './lib/projectCollaboration'
import { createCanvasProject, deleteCanvasDocument, flushPendingCanvasDocumentWrites, readCanvasProjectSummaries, renameCanvasProject, syncPendingCanvasDrafts } from './lib/db'
import { ProductApiError, clearProductSession, completeProductPasswordSetup, createProductSession, enrollProductMfa, hybridAuthEnabled, inviteWorkspaceMember, listWorkspaceAuditEvents, listWorkspaceMembers, productPasswordSetupRequired, readProductMfaStatus, readProductSession, refreshProductMediaSession, removeProductMfa, serverPersistenceEnabled, signOutOtherProductSessions, supabaseAuthEnabled, updateProductPassword, updateWorkspaceMember, verifyProductMfa, type ProductUser } from './lib/productSession'
import { subscribeProductSessionInvalidated } from './lib/productSessionInvalidation'
import { createEmptyCanvasDocument } from './data/seed'
import { useCanvasStore } from './store/canvasStore'
import type { WorkspaceProject } from './components/WorkspaceViews'
import { ArrowDownIcon, ArrowUpIcon, ArrowUpRightIcon, BookmarkIcon, ChecklistIcon, CloseIcon, CopyIcon, DeleteIcon, DownloadIcon, EditIcon, FocusIcon, FolderOutlineIcon, GalleryIcon, HomeIcon, MapIcon, MoreIcon, PlusSquareIcon, RefreshIcon, SparkleIcon, ThumbDownIcon, ThumbUpIcon, UploadIcon } from './components/BotanicIcons'
import plusIcon from './assets/figma/icon-plus.svg'
import folderIcon from './assets/figma/icon-folder.svg'
import templatesIcon from './assets/figma/icon-templates.svg'
import historyIcon from './assets/figma/icon-history.svg'
import chevronIcon from './assets/figma/icon-chevron.svg'
import sendIcon from './assets/figma/icon-send.svg'
import sceneImage from './assets/figma/scene.webp'
import resultImage from './assets/figma/result.webp'
import openAIProviderLogo from './assets/providers/openai.png'
import miniMaxProviderLogo from './assets/providers/minimax.png'

// 项目库与经营驾驶舱不参与画布编辑。按路由加载，避免直接打开画布时额外解析首页内容。
const OperatingDashboard = lazy(() => import('./components/WorkspaceViews').then((module) => ({ default: module.OperatingDashboard })))
const ProjectLibrary = lazy(() => import('./components/WorkspaceViews').then((module) => ({ default: module.ProjectLibrary })))

function DeferredWorkspaceIndicator() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), 500)
    return () => window.clearTimeout(timer)
  }, [])

  if (!visible) return null
  return (
    <div className="workspace-loading-indicator" role="status" aria-label="正在载入项目">
      <span aria-hidden="true"><i /><i /><i /></span>
      <small>载入项目</small>
    </div>
  )
}

function WorkspaceViewLoading() {
  return <main className="workspace-shell workspace-view-loading" aria-live="polite"><DeferredWorkspaceIndicator /></main>
}

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

function viewportMotionDuration(duration: number) {
  return reducedMotionRequested() ? 0 : duration
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

type ComposerOptionPopoverProps = {
  label: string
  value: string
  valueIcon?: string
  disabled?: boolean
  width?: number
  className?: string
  children: (close: () => void) => ReactNode
}

function ComposerOptionPopover({ label, value, valueIcon, disabled = false, width = 180, className = '', children }: ComposerOptionPopoverProps) {
  const menuId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null)
  const menuPresence = useMotionPresence(open, 110)

  const updateAnchor = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    setAnchor({
      left: Math.max(12, Math.min(window.innerWidth - width - 12, rect.left)),
      bottom: Math.max(12, window.innerHeight - rect.top + 7),
    })
  }, [width])

  useEffect(() => {
    if (!open) return
    updateAnchor()
    const closeOnOutsidePress = (event: PointerEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    window.addEventListener('resize', updateAnchor)
    window.addEventListener('scroll', updateAnchor, true)
    document.addEventListener('pointerdown', closeOnOutsidePress)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('resize', updateAnchor)
      window.removeEventListener('scroll', updateAnchor, true)
      document.removeEventListener('pointerdown', closeOnOutsidePress)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, updateAnchor])

  useEffect(() => {
    if (!open || !anchor) return
    const frame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>('[aria-selected="true"], [aria-checked="true"], button')?.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [anchor, open])

  const moveMenuFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return
    const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    if (!options.length) return
    const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement)
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? options.length - 1
        : event.key === 'ArrowDown' || event.key === 'ArrowRight'
          ? (currentIndex + 1 + options.length) % options.length
          : (currentIndex - 1 + options.length) % options.length
    event.preventDefault()
    options[nextIndex]?.focus()
  }

  return <div className={`composer-option-field ${className}`.trim()}>
    <span>{label}</span>
    <button
      ref={triggerRef}
      type="button"
      className={open ? 'composer-option-trigger is-open' : 'composer-option-trigger'}
      disabled={disabled}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      onClick={() => {
        if (!open) updateAnchor()
        setOpen((current) => !current)
      }}
    >
      {valueIcon ? <img className="composer-option-trigger__provider" src={valueIcon} alt="" /> : null}
      <strong>{value}</strong>
    </button>
    {menuPresence.present && anchor && typeof document !== 'undefined' ? createPortal(
      <div
        ref={menuRef}
        id={menuId}
        className={`composer-option-menu ${className} is-${menuPresence.phase}`.trim()}
        style={{ left: anchor.left, bottom: anchor.bottom, width }}
        role="dialog"
        aria-label={`${label}选项`}
        aria-hidden={menuPresence.phase === 'exit' ? true : undefined}
        onKeyDown={moveMenuFocus}
      >{children(() => setOpen(false))}</div>,
      document.body,
    ) : null}
  </div>
}

type BotanicSelectOption = { value: string; label: string }

function BotanicSelect({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  className = '',
  menuWidth,
  placeholder,
}: {
  value: string | number
  options: BotanicSelectOption[]
  onChange: (value: string) => void
  ariaLabel: string
  disabled?: boolean
  className?: string
  menuWidth?: number
  placeholder?: string
}) {
  const menuId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ left: number; top: number; width: number } | null>(null)
  const menuPresence = useMotionPresence(open, 110)
  const normalizedValue = String(value)
  const selected = options.find((option) => option.value === normalizedValue)

  const updateAnchor = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const width = Math.min(window.innerWidth - 24, Math.max(menuWidth ?? 0, rect.width, 116))
    const estimatedHeight = Math.min(280, options.length * 32 + 12)
    const opensAbove = window.innerHeight - rect.bottom < estimatedHeight + 12 && rect.top > estimatedHeight
    setAnchor({
      left: Math.max(12, Math.min(window.innerWidth - width - 12, rect.left)),
      top: opensAbove ? Math.max(12, rect.top - estimatedHeight - 6) : Math.min(window.innerHeight - 48, rect.bottom + 6),
      width,
    })
  }, [menuWidth, options.length])

  useEffect(() => {
    if (!open) return
    updateAnchor()
    const closeOnOutsidePress = (event: PointerEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    window.addEventListener('resize', updateAnchor)
    window.addEventListener('scroll', updateAnchor, true)
    document.addEventListener('pointerdown', closeOnOutsidePress)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('resize', updateAnchor)
      window.removeEventListener('scroll', updateAnchor, true)
      document.removeEventListener('pointerdown', closeOnOutsidePress)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open, updateAnchor])

  useEffect(() => {
    if (!open || !anchor) return
    const frame = window.requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [anchor, open])

  const moveFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    if (!buttons.length) return
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowDown'
      ? (current + 1 + buttons.length) % buttons.length
      : (current - 1 + buttons.length) % buttons.length
    event.preventDefault()
    buttons[next]?.focus()
  }

  return <span className={`botanic-select ${className}${open ? ' is-open' : ''}`.trim()}>
    <button
      ref={triggerRef}
      type="button"
      className="botanic-select__trigger"
      disabled={disabled || !options.length}
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      onClick={() => {
        if (!open) updateAnchor()
        setOpen((current) => !current)
      }}
    >
      <span>{selected?.label ?? placeholder ?? '请选择'}</span>
      <img src={chevronIcon} alt="" />
    </button>
    {menuPresence.present && anchor && typeof document !== 'undefined' ? createPortal(
      <div
        ref={menuRef}
        id={menuId}
        className={`botanic-select__menu is-${menuPresence.phase}`}
        style={anchor}
        role="listbox"
        aria-label={ariaLabel}
        aria-hidden={menuPresence.phase === 'exit' ? true : undefined}
        onKeyDown={moveFocus}
      >
        {options.map((option) => <button
          type="button"
          role="option"
          aria-selected={option.value === normalizedValue}
          className={option.value === normalizedValue ? 'is-selected' : ''}
          key={option.value}
          onClick={() => {
            onChange(option.value)
            setOpen(false)
            triggerRef.current?.focus()
          }}
        >{option.label}{option.value === normalizedValue ? <b>✓</b> : null}</button>)}
      </div>,
      document.body,
    ) : null}
  </span>
}

function modelProviderLogo(model?: GenerationModelOption) {
  const provider = model?.provider ?? (/minimax/i.test(model?.id ?? '') ? 'minimax' : 'openai')
  return provider === 'minimax' ? miniMaxProviderLogo : openAIProviderLogo
}

function modelDisplayLabel(model?: GenerationModelOption) {
  return (model?.label ?? model?.id ?? '').replace(/\s*·\s*(?:图像|视频).*$/u, '').trim()
}

function AspectRatioGlyph({ ratio }: { ratio: string }) {
  const [width = 1, height = 1] = ratio.split(':').map(Number)
  const scale = 17 / Math.max(width, height, 1)
  return <i className="composer-aspect-glyph" style={{ width: `${Math.max(7, width * scale)}px`, height: `${Math.max(7, height * scale)}px` }} aria-hidden="true" />
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
  const mediaKind = asset.mediaKind ?? 'image'
  return (
    <div className={['asset-node', mediaKind === 'video' ? 'asset-node--video' : '', asset.deleted ? 'is-deleted' : '', selected ? 'is-selected' : ''].filter(Boolean).join(' ')} style={nodeStyle}>
      <ImageNodeTitle nodeId={id} name={asset.name} />
      <button
        className="asset-node__remove nodrag"
        type="button"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          removeNodeFromCanvas(id)
        }}
        aria-label={`从画布移除 ${asset.name}`}
      >
        <DeleteIcon />
      </button>
      <div className="asset-node__image-wrap">
        {mediaKind === 'video' ? (
          <video
            src={asset.image}
            aria-label={asset.name}
            className="asset-node__image asset-node__video"
            muted
            playsInline
            preload="metadata"
            draggable={false}
            onLoadedMetadata={(event) => {
              if (asset.imageWidth && asset.imageHeight) return
              const { videoWidth, videoHeight } = event.currentTarget
              if (videoWidth && videoHeight) setLoadedImageSize({ width: videoWidth, height: videoHeight })
            }}
            onDragStart={(event) => event.preventDefault()}
          />
        ) : (
          <img
            src={asset.image}
            alt={asset.name}
            className="asset-node__image"
            decoding="async"
            draggable={false}
            onLoad={(event) => {
              if (asset.imageWidth && asset.imageHeight) return
              const { naturalWidth, naturalHeight } = event.currentTarget
              if (naturalWidth && naturalHeight) setLoadedImageSize({ width: naturalWidth, height: naturalHeight })
            }}
            onDragStart={(event) => event.preventDefault()}
          />
        )}
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
        ><DeleteIcon /></button>
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
  const generateLabel = generate.settings.duration !== undefined && generate.label === '图像生成' ? '视频生成' : generate.label
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
      return [{ id: node.id, image: asset.image, name: asset.name, mediaKind: asset.mediaKind ?? 'image' }]
    }
    if (node.type === 'result') {
      const result = node.data as ResultNodeData
      return result.image ? [{ id: node.id, image: result.image, name: result.label ?? '上游输出', mediaKind: result.mediaKind ?? 'image' }] : []
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
  const mediaKind = modelOptions.find((model) => model.id === generate.settings.model)?.mediaKind
    ?? (generate.settings.duration === undefined ? 'image' : 'video')
  const inferredVideoInputMode: VideoInputMode = generate.videoInputMode
    ?? (references.some((reference) => reference.mediaKind === 'video') ? 'reference' : references.length === 2 ? 'first_last' : 'first_frame')
  const displayedAspectRatio = mediaKind === 'video'
    ? videoAspectRatioPolicy(inferredVideoInputMode, generate.settings.aspectRatio).controlLabel
    : generate.settings.aspectRatio

  return (
    <div className={`graph-node generate-node generate-node--${mediaKind}${selected ? ' is-selected' : ''}${hasVisualInput ? '' : ' is-missing-input'}`}>
      <Handle
        className="flow-handle flow-handle--graph flow-handle--target"
        id="input"
        type="target"
        position={Position.Left}
        aria-label={`${generateLabel} 输入端`}
        title="将图片、文本或已选首图连到这里"
      />
      <Handle
        className="flow-handle flow-handle--graph flow-handle--source"
        id="output"
        type="source"
        position={Position.Right}
        isConnectable={false}
        aria-label={`${generateLabel} 自动输出端`}
        title="任务完成后，系统会自动创建输出图片"
      />
      <header className="graph-node__header">
        <strong>{generateLabel}</strong>
        <small>{references.length} 参考 · {modelLabel} · {displayedAspectRatio} · {generate.settings.resolution}{generate.settings.duration ? ` · ${generate.settings.duration}秒` : ''}</small>
        <button
          className="graph-node__remove nodrag"
          type="button"
          aria-label={`从画布移除 ${generateLabel}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            removeNodeFromCanvas(id)
          }}
        ><DeleteIcon /></button>
      </header>
      <div className="generate-node__summary">
        {references.length ? (
          <div className="generate-node__reference-stack" aria-label={`已连接 ${references.length} 个参考`}>
            {references.slice(0, 4).map((reference) => reference.mediaKind === 'video'
              ? <video key={reference.id} src={reference.image} aria-label={reference.name} title={reference.name} muted playsInline preload="metadata" />
              : <img key={reference.id} src={reference.image} alt={reference.name} title={reference.name} />)}
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
  mediaKind?: GenerationMediaKind
}

type GeneratedHistoryItem = {
  id: string
  image: string
  mediaKind: GenerationMediaKind
  name: string
  createdAt: number
  aspectRatio?: string
  resolution?: string
  duration?: number
  nodeId?: string
  versionId?: string
}

type CanvasComposerProps = {
  projectId: string
  mode: 'generate' | 'result'
  nodeLabel: string
  prompt: string
  batchCount: number
  maximumBatchCount: number
  settings: GenerationSettings
  models: GenerationModelOption[]
  references: ComposerFocusReference[]
  status: 'idle' | 'uploading' | 'queued' | 'running' | 'error'
  error?: string
  canGenerate: boolean
  onNodeLabelChange?: (label: string) => void
  onPromptChange: (prompt: string) => void
  onBatchCountChange: (batchCount: number) => void
  onSettingsChange: (settings: GenerationSettings) => void
  videoInputMode?: VideoInputMode
  onVideoInputModeChange?: (mode: VideoInputMode) => void
  refinementMode?: RefinementMode
  onRefinementModeChange?: (mode: RefinementMode) => void
  onOpenReferences?: () => void
  onOpenAssets?: () => void
  onGenerate: () => void
  onClose: () => void
  layout: ComposerLayout
  onLayoutChange: (layout: ComposerLayout) => void
}

type PromptRefinementState = {
  status: 'idle' | 'loading' | 'error'
  message?: string
}

function settingsForModel(settings: GenerationSettings, model: GenerationModelOption): GenerationSettings {
  const aspectRatio = model.aspectRatios?.includes(settings.aspectRatio)
    ? settings.aspectRatio
    : model.aspectRatios?.[0] ?? settings.aspectRatio
  const resolution = model.resolutions?.includes(settings.resolution)
    ? settings.resolution
    : model.resolutions?.[0] ?? settings.resolution
  const duration = model.mediaKind === 'video'
    ? model.durations?.includes(settings.duration ?? -1)
      ? settings.duration
      : model.defaultDuration ?? model.durations?.[0] ?? 5
    : undefined
  return { model: model.id, aspectRatio, resolution, ...(duration === undefined ? {} : { duration }) }
}

function CanvasComposer({ projectId, mode, nodeLabel, prompt, batchCount, maximumBatchCount, settings, models, references, status, error, canGenerate, onNodeLabelChange, onPromptChange, onBatchCountChange, onSettingsChange, videoInputMode = 'first_frame', onVideoInputModeChange, refinementMode = 'faithful', onRefinementModeChange, onOpenReferences, onOpenAssets, onGenerate, onClose, layout, onLayoutChange }: CanvasComposerProps) {
  const isGenerating = status === 'uploading' || status === 'queued' || status === 'running'
  const [refinement, setRefinement] = useState<PromptRefinementState>({ status: 'idle' })
  const refinementRequestRef = useRef<{ id: number; controller?: AbortController }>({ id: 0 })
  const refinementFeedbackTimerRef = useRef<number | null>(null)
  const [refinementSuccessVisible, setRefinementSuccessVisible] = useState(false)
  const promptRef = useRef(prompt)
  promptRef.current = prompt
  const isRefining = refinement.status === 'loading'
  const interactionLocked = isGenerating || isRefining
  const activeMediaKind = models.find((model) => model.id === settings.model)?.mediaKind
    ?? (settings.duration === undefined ? 'image' : 'video')
  const compatibleModels = models.filter((model) => (model.mediaKind ?? 'image') === activeMediaKind)
  const modelOptions = compatibleModels.some((model) => model.id === settings.model)
    ? compatibleModels
    : [{ id: settings.model, label: settings.model, mediaKind: activeMediaKind }, ...compatibleModels]
  const selectedModel = modelOptions.find((model) => model.id === settings.model)
  const isVideoModel = selectedModel?.mediaKind === 'video'
  const primaryReference = references.find((reference) => reference.primary)
  const videoRatioPolicy = videoAspectRatioPolicy(videoInputMode, settings.aspectRatio)
  const videoModeCopy = videoInputMode === 'first_frame'
    ? { title: '保持首帧', detail: '保持起始画面，比例跟随素材' }
    : videoInputMode === 'first_last'
      ? { title: '首尾帧', detail: '补间两张图片，比例跟随素材' }
      : { title: '扩展画面', detail: '按所选比例智能补全，画面可能略有变化' }
  const videoInputHint = !canGenerate && isVideoModel
    ? videoInputMode === 'first_last'
      ? references.length === 1 ? '请添加尾帧' : '请添加首帧和尾帧'
      : videoInputMode === 'first_frame'
        ? '请添加首帧'
        : '请添加参考素材'
    : ''
  const videoReferenceBadge = (index: number) => !isVideoModel
    ? undefined
    : videoInputMode === 'first_last'
      ? index === 0 ? '首' : index === 1 ? '尾' : undefined
      : videoInputMode === 'first_frame' && index === 0 ? '首' : undefined
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
      if (event.key !== 'Escape') return
      onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  useEffect(() => () => {
    refinementRequestRef.current.id += 1
    refinementRequestRef.current.controller?.abort()
    if (refinementFeedbackTimerRef.current !== null) window.clearTimeout(refinementFeedbackTimerRef.current)
  }, [])

  const handlePromptChange = (nextPrompt: string) => {
    if (refinement.status === 'error') {
      setRefinement({ status: 'idle' })
    }
    onPromptChange(nextPrompt)
  }

  const handleRefinePrompt = async () => {
    const originalPrompt = prompt
    const requestPrompt = originalPrompt.trim()
    if (!requestPrompt || isGenerating || isRefining) return

    refinementRequestRef.current.controller?.abort()
    if (refinementFeedbackTimerRef.current !== null) window.clearTimeout(refinementFeedbackTimerRef.current)
    setRefinementSuccessVisible(false)
    const controller = new AbortController()
    const requestId = refinementRequestRef.current.id + 1
    refinementRequestRef.current = { id: requestId, controller }
    setRefinement({ status: 'loading' })

    try {
      const result = await refinePrompt({
        projectId,
        mode: mode === 'generate' ? 'generation' : 'refinement',
        prompt: requestPrompt,
        aspectRatio: settings.aspectRatio,
        references: references.map(({ name, role, primary }) => ({ name, role, primary })),
      }, controller.signal)
      if (refinementRequestRef.current.id !== requestId) return
      if (promptRef.current !== originalPrompt) {
        setRefinement({ status: 'idle' })
        return
      }

      if (result.status === 'unchanged' || result.prompt === requestPrompt) {
        setRefinement({ status: 'idle' })
        return
      }

      onPromptChange(result.prompt)
      setRefinementSuccessVisible(true)
      refinementFeedbackTimerRef.current = window.setTimeout(() => {
        setRefinementSuccessVisible(false)
        refinementFeedbackTimerRef.current = null
      }, 1400)
      setRefinement({ status: 'idle' })
    } catch (caught) {
      if (controller.signal.aborted || refinementRequestRef.current.id !== requestId) return
      const detail = caught instanceof Error ? caught.message : '润色失败。'
      setRefinement({
        status: 'error',
        message: `${detail.replace(/[。！!?]+$/, '')}，原文未修改。`,
      })
    }
  }

  return (
    <section
      ref={composerRef}
      className={`canvas-composer${expanded ? ' is-expanded' : ' is-collapsed'}${layout.dock === 'free' ? ' is-free' : ' is-docked'}`}
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
          {references.length ? (
            <button
              type="button"
              className="canvas-composer__reference-summary"
              onClick={onOpenReferences}
              disabled={!onOpenReferences}
              aria-label={`管理本次 ${references.length} 个参考`}
              title="管理参考"
            >
              <span className="canvas-composer__reference-strip">
                {references.slice(0, 4).map((reference, index) => {
                  const badge = videoReferenceBadge(index)
                  return <span key={reference.id} className="canvas-composer__reference-thumb">
                    {reference.mediaKind === 'video'
                      ? <video src={reference.image} aria-label={reference.name} className={reference.primary ? 'is-primary' : ''} muted playsInline preload="metadata" />
                      : <img src={reference.image} alt="" className={reference.primary ? 'is-primary' : ''} />}
                    {badge ? <i aria-hidden="true">{badge}</i> : null}
                  </span>
                })}
              </span>
              <span className="canvas-composer__reference-count">{references.length}</span>
            </button>
          ) : null}
          {onOpenAssets ? <button type="button" className={references.length ? 'canvas-composer__add-reference' : 'canvas-composer__add-reference is-empty'} onClick={onOpenAssets} aria-label="添加参考素材" title="添加参考素材"><PlusSquareIcon />{references.length ? null : <span>添加参考</span>}</button> : null}
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
          <button type="button" className="canvas-composer__close" onClick={onClose} aria-label="关闭生成器" title="关闭"><CloseIcon /></button>
        </div>
      </header>

      <div className="canvas-composer__expanded-content" aria-hidden={!expanded} inert={expanded ? undefined : true}>
        <div className="canvas-composer__body">
          <main className="canvas-composer__editor">
            <div className={`canvas-composer__field canvas-composer__prompt${refinementSuccessVisible ? ' is-refinement-success' : ''}`}>
              <textarea
                value={prompt}
                autoFocus={expanded}
                aria-label={`${nodeLabel}描述`}
                aria-busy={isRefining}
                placeholder={isVideoModel ? '描述主体动作、镜头运动、节奏与场景变化' : '描述商品、场景、构图、光线与留白要求'}
                readOnly={isRefining}
                onChange={(event) => handlePromptChange(event.target.value)}
              />
              <button
                type="button"
                className={`canvas-composer__refine${refinement.status === 'loading' ? ' is-loading' : ''}${refinementSuccessVisible ? ' is-complete' : ''}`}
                disabled={!prompt.trim() || interactionLocked}
                aria-label={refinementSuccessVisible ? 'Botanic 结构润色已应用' : `润色${isVideoModel ? '视频' : '图像'}生成描述`}
                title="润色描述"
                onClick={() => void handleRefinePrompt()}
              >
                <SparkleIcon />
              </button>
            </div>
            {refinement.status === 'loading' ? (
              <div className="canvas-composer__refinement-status" role="status" aria-live="polite">
                <span>正在按 Botanic 结构润色…</span>
              </div>
            ) : refinement.status === 'error' ? (
              <div className="canvas-composer__refinement-status is-error" role="alert">
                <span>{refinement.message ?? '润色失败，原文未修改。'}</span>
              </div>
            ) : null}
            {isVideoModel ? (
              <section className="canvas-composer__video-input" aria-label="视频输入模式">
                <strong className="canvas-composer__video-input-label">视频输入</strong>
                <div className="canvas-composer__video-modes" role="radiogroup" aria-label="选择视频输入方式">
                  {([
                    ['first_frame', '首帧'],
                    ['first_last', '首尾帧'],
                    ['reference', '参考素材'],
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={videoInputMode === value}
                      className={videoInputMode === value ? 'is-active' : ''}
                      disabled={interactionLocked}
                      onClick={() => onVideoInputModeChange?.(value)}
                    >
                      <strong>{label}</strong>
                    </button>
                  ))}
                </div>
                <p
                  className={`canvas-composer__video-input-hint${videoInputHint ? '' : ' is-empty'}`}
                  aria-live="polite"
                  aria-hidden={!videoInputHint}
                >
                  {videoInputHint || '\u00a0'}
                </p>
              </section>
            ) : null}
            {mode === 'result' ? (
              <div className="canvas-composer__refinement-mode" role="group" aria-label="继续生成方式">
                <button type="button" className={refinementMode === 'faithful' ? 'is-active' : ''} disabled={interactionLocked} onClick={() => onRefinementModeChange?.('faithful')}>
                  忠实精修
                </button>
                <button type="button" className={refinementMode === 'explore' ? 'is-active' : ''} disabled={interactionLocked} onClick={() => onRefinementModeChange?.('explore')}>
                  探索变体
                </button>
                <small>{refinementMode === 'explore' ? '保留主体，主动探索构图、机位与光影。' : '保留构图与主体，仅执行描述中的改动。'}</small>
              </div>
            ) : null}
          </main>
        </div>

        <footer className="canvas-composer__footer">
          <div className="canvas-composer__settings-stack">
            <div className={`canvas-composer__settings canvas-composer__settings--primary${isVideoModel ? ' is-video' : ''}`} aria-label="常用生成参数">
              <ComposerOptionPopover label="模型" value={modelDisplayLabel(selectedModel) || settings.model} valueIcon={modelProviderLogo(selectedModel)} disabled={interactionLocked} width={240} className="is-model">
                {(close) => <div className="composer-model-menu" role="listbox" aria-label="选择生成模型">
                  {modelOptions.map((model) => {
                    const selected = model.id === settings.model
                    return <button key={model.id} type="button" role="option" aria-selected={selected} className={selected ? 'is-selected' : ''} onClick={() => {
                      onSettingsChange(settingsForModel(settings, model))
                      close()
                    }}>
                      <img src={modelProviderLogo(model)} alt="" />
                      <strong>{modelDisplayLabel(model)}</strong>
                      {selected ? <b>✓</b> : null}
                    </button>
                  })}
                </div>}
              </ComposerOptionPopover>
              {isVideoModel ? <ComposerOptionPopover label="时长" value={`${settings.duration ?? selectedModel.defaultDuration ?? 5} 秒`} disabled={interactionLocked} width={112} className="is-compact">
                {(close) => <div className="composer-compact-menu" role="listbox" aria-label="选择视频时长">
                  {(selectedModel.durations ?? [5]).filter((duration) => [5, 10, 15].includes(duration)).map((duration) => <button key={duration} type="button" role="option" aria-selected={(settings.duration ?? selectedModel.defaultDuration ?? 5) === duration} className={(settings.duration ?? selectedModel.defaultDuration ?? 5) === duration ? 'is-selected' : ''} onClick={() => {
                    updateSettings({ duration })
                    close()
                  }}>{duration} 秒</button>)}
                </div>}
              </ComposerOptionPopover> : null}
              <ComposerOptionPopover label="候选数" value={String(batchCount)} disabled={interactionLocked} width={132} className="is-count">
                {(close) => <div className="composer-compact-menu" role="listbox" aria-label="选择候选数量">
                  {Array.from({ length: maximumBatchCount }, (_, index) => index + 1).map((count) => <button key={count} type="button" role="option" aria-selected={batchCount === count} className={batchCount === count ? 'is-selected' : ''} onClick={() => {
                    onBatchCountChange(count)
                    close()
                  }}>{count}</button>)}
                </div>}
              </ComposerOptionPopover>
              <ComposerOptionPopover
                label="输出"
                value={`${isVideoModel && !videoRatioPolicy.ratioSelectable ? '跟随素材' : settings.aspectRatio} · ${settings.resolution}`}
                disabled={interactionLocked}
                width={300}
                className="is-output"
              >
                {(close) => <div className="composer-output-menu">
                  <section>
                    <header><strong>画幅</strong>{isVideoModel && !videoRatioPolicy.ratioSelectable ? <small>由输入素材决定</small> : null}</header>
                    {isVideoModel && !videoRatioPolicy.ratioSelectable ? <div className="composer-output-adaptive"><AspectRatioGlyph ratio="1:1" /><span>跟随素材</span></div> : <div className="composer-aspect-grid" role="radiogroup" aria-label="选择画面比例">
                      {(selectedModel?.aspectRatios ?? ['1:1', '3:4', '4:5', '9:16']).map((ratio) => <button key={ratio} type="button" role="radio" aria-checked={settings.aspectRatio === ratio} className={settings.aspectRatio === ratio ? 'is-selected' : ''} onClick={() => updateSettings({ aspectRatio: ratio as GenerationSettings['aspectRatio'] })}>
                        <AspectRatioGlyph ratio={ratio} /><span>{ratio}</span>
                      </button>)}
                    </div>}
                  </section>
                  <section>
                    <header><strong>清晰度</strong></header>
                    <div className="composer-resolution-grid" role="radiogroup" aria-label="选择输出清晰度">
                      {(selectedModel?.resolutions ?? ['1K', '2K']).map((resolution) => <button key={resolution} type="button" role="radio" aria-checked={settings.resolution === resolution} className={settings.resolution === resolution ? 'is-selected' : ''} onClick={() => {
                        updateSettings({ resolution: resolution as GenerationSettings['resolution'] })
                        close()
                      }}>{resolution}</button>)}
                    </div>
                  </section>
                </div>}
              </ComposerOptionPopover>
            </div>
          </div>
          <div className={error ? 'canvas-composer__feedback is-error' : 'canvas-composer__feedback'} role={error ? 'alert' : 'status'}>
            {error ?? (isGenerating
              ? (status === 'uploading' ? '正在上传参考素材…' : status === 'queued' ? '任务已入队…' : `${selectedModel?.mediaKind === 'video' ? '视频' : '图像'}服务正在生成…`)
              : canGenerate
                ? (primaryReference ? `主参考 · ${primaryReference.name}` : '参数已准备好，提交后会在画布中创建新的结果节点。')
                : isVideoModel
                  ? `${videoModeCopy.title}模式需要${videoInputMode === 'first_last' ? '按顺序连接 2 张图片' : videoInputMode === 'first_frame' ? '连接 1 张图片' : '连接至少 1 个图片或视频参考'}`
                  : '连接并设置主商品后即可生成。')}
          </div>
          <button type="button" className="canvas-composer__submit" disabled={interactionLocked || !canGenerate || !prompt.trim()} onClick={onGenerate}>
            {isGenerating ? '生成中…' : '生成'}
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
    return { title: '准备生成', detail: '正在锁定参考' }
  }
  if (status === 'queued') {
    return { title: '正在生成', detail: '已进入队列' }
  }
  return { title: '正在生成', detail: '可继续编辑画布' }
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
        {reference.recipe.references.slice(0, 4).map((item) => <img key={item.nodeId} src={item.image} alt={item.name} title={`${item.role} · ${item.name}`} decoding="async" />)}
      </div>
      <footer><span>{primary ? `主商品 · ${primary.name}` : '未锁定主商品'}</span><i>{taskStatusLabel(reference.status)}</i></footer>
      {reference.error ? <small title={reference.error}>任务需要处理</small> : null}
    </div>
  )
}

type ResultGroupCandidateUi = {
  id: string
  name: string
  image?: string
  mediaKind: GenerationMediaKind
  active: boolean
  promoted: boolean
}

type ResultNodeUiData = ResultNodeData & {
  __ui?: {
    group?: ResultGroupPresentation
    targetNodeId?: string
    groupCandidates?: ResultGroupCandidateUi[]
    onToggleGroup?: (groupId: string) => void
    onChooseCandidate?: (groupId: string, candidateId: string, promoted: boolean) => void
    onOpenAddMenu?: (resultNodeId: string, screen: { x: number; y: number }) => void
    onOpenAgent?: (resultNodeId: string) => void
  }
}

function ResultNode({ data, id, selected }: NodeProps) {
  const result = data as ResultNodeUiData
  const presentation = result.__ui
  const resultGroup = presentation?.group
  const targetNodeId = presentation?.targetNodeId ?? id
  const groupCandidates = presentation?.groupCandidates ?? []
  const isSelected = selected || Boolean(result.selected)
  const [imageFailed, setImageFailed] = useState(false)
  const [mediaRetryAttempt, setMediaRetryAttempt] = useState(0)
  const [mediaRecoveryPending, setMediaRecoveryPending] = useState(false)
  const [videoDimensions, setVideoDimensions] = useState<{ width: number; height: number } | null>(null)
  const [currentTime, setCurrentTime] = useState(() => Date.now())
  const cancelGeneration = useCanvasStore((state) => state.cancelGeneration)
  const retryGeneration = useCanvasStore((state) => state.retryGeneration)
  const retryMissingGeneration = useCanvasStore((state) => state.retryMissingGeneration)
  const removeNodeFromCanvas = useCanvasStore((state) => state.removeNodeFromCanvas)
  const saveGeneratedImageToLibrary = useCanvasStore((state) => state.saveGeneratedImageToLibrary)
  const isSavedToLibrary = useCanvasStore((state) => result.image
    ? state.document.assets.some((asset) => asset.source === 'generated' && asset.image === result.image)
    : false)
  const missingOutputCount = useCanvasStore((state) => result.jobId
    ? state.document.generationJobs.find((job) => job.id === result.jobId)?.missingOutputCount ?? 0
    : 0)
  const requestedOutputCount = useCanvasStore((state) => result.jobId
    ? state.document.generationJobs.find((job) => job.id === result.jobId)?.batchCount ?? 0
    : 0)
  const settings = result.generationSettings
  const mediaKind = result.mediaKind ?? 'image'
  const displayedAspectRatio = mediaKind === 'video' && videoDimensions
    ? reducedAspectRatio(videoDimensions.width, videoDimensions.height)
    : settings?.aspectRatio
  const ratioClass = settings ? `result-node--ratio-${settings.aspectRatio.replace(':', '-')}` : ''
  const resultName = result.label ?? (result.generationKind === 'refinement' ? '精修版本' : '生成版本')
  const hasDisplayableImage = Boolean(result.image) && !imageFailed
  const isGenerating = result.status === 'generating'
  const taskFeedback = resultTaskFeedback(result.taskStatus)
  const elapsedSeconds = result.submittedAt && isGenerating
    ? Math.max(0, Math.floor((currentTime - result.submittedAt) / 1_000))
    : 0
  const isSlowTask = elapsedSeconds >= 12
  const mediaSource = result.image ? mediaRetryUrl(result.image, mediaRetryAttempt) : undefined

  const recoverMedia = useCallback(async () => {
    if (!result.image || mediaRecoveryPending) return
    setMediaRecoveryPending(true)
    setImageFailed(false)
    try {
      await refreshProductMediaSession()
      setMediaRetryAttempt((attempt) => attempt + 1)
    } catch {
      setImageFailed(true)
    } finally {
      setMediaRecoveryPending(false)
    }
  }, [mediaRecoveryPending, result.image])

  const handleMediaError = useCallback(() => {
    if (mediaRetryAttempt === 0) {
      void recoverMedia()
      return
    }
    setImageFailed(true)
  }, [mediaRetryAttempt, recoverMedia])

  useEffect(() => {
    setImageFailed(false)
    setMediaRetryAttempt(0)
    setMediaRecoveryPending(false)
    setVideoDimensions(null)
  }, [result.image])

  useEffect(() => {
    if (!isGenerating || !result.submittedAt) return
    setCurrentTime(Date.now())
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [isGenerating, result.submittedAt])

  return (
    <div className={['result-node-shell', `result-node-shell--${mediaKind}`, isSelected ? 'is-selected' : ''].filter(Boolean).join(' ')}>
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
        isConnectable
        aria-label="从结果连线"
        title={mediaKind === 'video' ? '连接到 H3 节点作为参考视频' : hasDisplayableImage ? '将这张生成结果连到下一生成节点' : '任务完成后可将生成结果连到下一节点'}
      />
      <header className="result-node__header">
        <ImageNodeTitle nodeId={targetNodeId} name={resultName} />
        {settings ? <span className="result-node__metadata">{displayedAspectRatio} · {settings.resolution}{settings.duration ? ` · ${settings.duration}秒` : ''}</span> : null}
        {hasDisplayableImage ? <button
          className="result-node__header-remove nodrag nowheel"
          type="button"
          aria-label={`删除 ${resultName}`}
          title="删除这个结果节点"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            removeNodeFromCanvas(targetNodeId)
          }}
        ><DeleteIcon /></button> : null}
      </header>
      <div
        className={['result-node', ratioClass, isGenerating ? 'result-node--generating' : '', isSelected ? 'is-selected' : ''].filter(Boolean).join(' ')}
        style={mediaKind === 'video' && videoDimensions
          ? { height: 'auto', aspectRatio: `${videoDimensions.width} / ${videoDimensions.height}` }
          : undefined}
      >
        {hasDisplayableImage ? <button
          className="result-node__download nodrag nowheel"
          type="button"
          aria-label={`下载 ${resultName}`}
          title="下载原图"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            void downloadMedia(result.image!, resultName, mediaKind)
          }}
        ><DownloadIcon /></button> : null}
        {hasDisplayableImage ? <button
          className="result-node__save nodrag nowheel"
          type="button"
          disabled={isSavedToLibrary}
          aria-label={isSavedToLibrary ? `${resultName} 已入库` : `将 ${resultName} 入库`}
          title={isSavedToLibrary ? '已入库' : '存入素材库'}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            saveGeneratedImageToLibrary({ image: result.image!, name: resultName, mediaKind: result.mediaKind ?? 'image' })
          }}
        >{isSavedToLibrary ? '已入库' : '入库'}</button> : null}
        {hasDisplayableImage
          ? mediaKind === 'video'
            ? <video
                src={mediaSource}
                aria-label={resultName}
                className="result-node__video nodrag nowheel"
                controls
                playsInline
                preload="metadata"
                onLoadedMetadata={(event) => {
                  const { videoWidth: width, videoHeight: height } = event.currentTarget
                  if (width > 0 && height > 0) setVideoDimensions({ width, height })
                }}
                onError={handleMediaError}
              />
            : <img src={mediaSource} alt={resultName} className="result-node__image" draggable={false} decoding="async" onError={handleMediaError} />
          : (
          <div className={`result-node__task-state result-node__task-state--${result.status}`}>
            {isGenerating ? <i className="result-node__task-pulse" aria-hidden="true" /> : null}
            <strong aria-live="polite">{imageFailed ? '媒体无法显示' : isGenerating ? taskFeedback.title : result.status === 'failed' ? '任务未完成' : result.status === 'cancelled' ? '任务已取消' : '等待生成结果'}</strong>
            <small>{imageFailed ? '媒体读取失败，可能是登录状态或网络中断。' : isGenerating ? (isSlowTask ? elapsedTaskLabel(elapsedSeconds) : taskFeedback.detail) : generationTaskErrorMessage(result.error) ?? (result.status === 'ready' ? '等待生成服务返回结果。' : '生成服务的真实状态会在此同步。')}</small>
            {imageFailed ? <button className="result-node__task-action nodrag nowheel" type="button" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); void recoverMedia() }}>重新加载</button> : null}
            {result.status === 'generating' ? <button className="result-node__task-action nodrag nowheel" type="button" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); cancelGeneration() }}>取消</button> : null}
            {result.status === 'failed' ? <div className="result-node__task-actions nodrag nowheel" onPointerDown={(event) => event.stopPropagation()}>
              <button className="result-node__task-action" type="button" onClick={(event) => { event.stopPropagation(); void retryGeneration() }}>原配方重试</button>
              <button className="result-node__task-action is-danger" type="button" onClick={(event) => { event.stopPropagation(); removeNodeFromCanvas(targetNodeId) }}>删除任务</button>
            </div> : null}
            {result.status === 'cancelled' ? <button className="result-node__task-action nodrag nowheel is-danger" type="button" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); removeNodeFromCanvas(targetNodeId) }}>删除任务</button> : null}
          </div>
        )}
        {missingOutputCount ? <div className="result-node__partial nodrag nowheel" onPointerDown={(event) => event.stopPropagation()}>
          <span>{requestedOutputCount - missingOutputCount}/{requestedOutputCount}</span>
          <button type="button" onClick={(event) => { event.stopPropagation(); if (result.jobId) void retryMissingGeneration(result.jobId) }}>补 {missingOutputCount} 张</button>
        </div> : null}
        {resultGroup?.representative ? <button
          className="result-node__candidate-toggle nodrag nowheel"
          type="button"
          aria-label={resultGroup.expanded ? '收起候选' : `查看 ${resultGroup.total} 个候选`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); presentation?.onToggleGroup?.(resultGroup.groupId) }}
        >{resultGroup.index}/{resultGroup.total} 候选 <span>{resultGroup.expanded ? '⌃' : '⌄'}</span></button> : null}
      </div>
      {resultGroup?.representative && resultGroup.expanded && groupCandidates.length ? <section className="result-node__candidate-popover nodrag nowheel" aria-label={`${resultGroup.total} 个候选`} onPointerDown={(event) => event.stopPropagation()}>
        <header><strong>本次候选</strong><span>选择后在当前节点查看</span><button type="button" aria-label="收起候选" onClick={(event) => { event.stopPropagation(); presentation?.onToggleGroup?.(resultGroup.groupId) }}><CloseIcon /></button></header>
        <div className="result-node__candidate-grid">
          {groupCandidates.map((candidate, index) => <button
            key={candidate.id}
            className={candidate.active ? 'is-active' : candidate.promoted ? 'is-promoted' : ''}
            type="button"
            onClick={(event) => { event.stopPropagation(); presentation?.onChooseCandidate?.(resultGroup.groupId, candidate.id, candidate.promoted) }}
          >
            <span className="result-node__candidate-media">{candidate.image
              ? candidate.mediaKind === 'video'
                ? <video src={candidate.image} muted playsInline preload="metadata" />
                : <img src={candidate.image} alt="" draggable={false} />
              : <i>等待结果</i>}<em>{String(index + 1).padStart(2, '0')}</em></span>
            <span className="result-node__candidate-name">{candidate.name}<small>{candidate.promoted ? '已形成分支' : candidate.active ? '当前' : '查看'}</small></span>
          </button>)}
        </div>
      </section> : null}
      {isSelected && hasDisplayableImage && presentation?.onOpenAddMenu ? <div className="result-node__actions nodrag nowheel" onPointerDown={(event) => event.stopPropagation()}>
        {presentation.onOpenAgent ? <button type="button" className="is-agent" onClick={(event) => {
          event.stopPropagation()
          presentation.onOpenAgent?.(targetNodeId)
        }}><SparkleIcon /> Agent 修改</button> : null}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            presentation.onOpenAddMenu?.(targetNodeId, { x: event.clientX, y: event.clientY })
          }}
        >添加节点 <ArrowUpRightIcon /></button>
      </div> : null}
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

const defaultAgentPlannerModels = ['deepseek-v4-pro', 'deepseek-v4-flash', 'kimi-k3']

function agentPlannerModelLabel(model: string) {
  if (model === 'deepseek-v4-pro') return 'DeepSeek V4 Pro'
  if (model === 'deepseek-v4-flash') return 'DeepSeek V4 Flash'
  if (model === 'kimi-k3') return 'Kimi K3'
  return model
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
  refinementMode: RefinementMode
}

type BatchVariationRequest = {
  groupId: string
  prompt: string
  candidatesPerAsset: number
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
  return setCenter((left + right) / 2, (top + bottom) / 2 + composerSafeOffset, { zoom: canvasMinZoom, duration: viewportMotionDuration(220) })
}

function miniMapNodeColor(node: CanvasNode) {
  if (node.type === 'asset') return '#b9cdbb'
  if (node.type === 'text') return '#d8cda8'
  if (node.type === 'generate') {
    return (node.data as GenerateNodeData).settings.duration === undefined ? '#5f9570' : '#5f83ab'
  }
  if (node.type === 'result') {
    return ((node.data as ResultNodeData).mediaKind ?? 'image') === 'video' ? '#8aa7c4' : '#91b79a'
  }
  return '#809a84'
}

function CanvasNavigation({
  taskNodes,
  selectedNodes,
  miniMapOpen,
  canShowMiniMap,
  marqueeMode,
  touchInput,
  onToggleMiniMap,
  onToggleMarqueeMode,
  onAutoLayout,
  onViewportChange,
}: {
  taskNodes: CanvasNode[]
  selectedNodes: CanvasNode[]
  miniMapOpen: boolean
  canShowMiniMap: boolean
  marqueeMode: boolean
  touchInput: boolean
  onToggleMiniMap: () => void
  onToggleMarqueeMode: () => void
  onAutoLayout: () => void
  onViewportChange: (viewport: { x: number; y: number; zoom: number }) => void
}) {
  const { getViewport, zoomTo, fitView, setCenter } = useReactFlow()
  const { zoom } = useViewport()
  const directViewportFrame = useRef(0)
  const zoomPercent = Math.round(zoom * 100)
  const zoomFill = `${Math.round(((zoom - canvasMinZoom) / (canvasMaxZoom - canvasMinZoom)) * 100)}%`
  useEffect(() => () => window.cancelAnimationFrame(directViewportFrame.current), [])
  const commitViewport = (operation: Promise<boolean>) => {
    void operation.then(() => onViewportChange(getViewport()))
    window.setTimeout(() => onViewportChange(getViewport()), 260)
  }
  const commitDirectViewport = (operation: Promise<boolean>) => {
    void operation.then(() => {
      window.cancelAnimationFrame(directViewportFrame.current)
      directViewportFrame.current = window.requestAnimationFrame(() => {
        directViewportFrame.current = 0
        onViewportChange(getViewport())
      })
    })
  }
  const smartFocusLabel = selectedNodes.length
    ? '聚焦选中节点'
    : taskNodes.length
      ? '聚焦本次任务'
      : '适配全部节点'
  const focusCanvas = () => {
    if (selectedNodes.length) {
      commitViewport(fitView({ nodes: selectedNodes, duration: viewportMotionDuration(180), padding: 0.32, minZoom: canvasMinZoom, maxZoom: 1.2 }))
      return
    }
    if (taskNodes.length) {
      commitViewport(focusTaskFlow(setCenter, taskNodes))
      return
    }
    commitViewport(fitView({ duration: viewportMotionDuration(180), padding: 0.16, minZoom: canvasMinZoom, maxZoom: 1 }))
  }
  const closeMoreMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.currentTarget.closest('details')?.removeAttribute('open')
  }
  return (
    <Panel position="bottom-left" className="zoom-panel nopan nowheel">
      <div className="zoom-panel__controls" aria-label="画布导航">
        <button
          className={miniMapOpen ? 'zoom-panel__icon-button is-active' : 'zoom-panel__icon-button'}
          type="button"
          onClick={onToggleMiniMap}
          disabled={!canShowMiniMap}
          aria-label={miniMapOpen ? '关闭小地图' : '打开小地图'}
          aria-expanded={miniMapOpen}
          aria-controls="canvas-minimap"
          title={canShowMiniMap ? (miniMapOpen ? '关闭小地图' : '打开小地图') : '节点较少，暂不需要小地图'}
        ><MapIcon /></button>
        <button className="zoom-panel__icon-button" type="button" onClick={focusCanvas} aria-label={smartFocusLabel} title={smartFocusLabel}><FocusIcon /></button>
        <div className="zoom-panel__slider">
          <input
            className="zoom-track"
            aria-label="画布缩放级别"
            type="range"
            min={canvasMinZoom}
            max={canvasMaxZoom}
            step="0.01"
            value={zoom}
            style={{ '--zoom-fill': zoomFill } as CSSProperties}
            onChange={(event) => commitDirectViewport(zoomTo(Number(event.target.value), { duration: 0 }))}
          />
          <output aria-live="polite">{zoomPercent}%</output>
        </div>
        <details className="zoom-panel__more">
          <summary className="zoom-panel__icon-button" role="button" aria-label="更多画布工具" title="更多画布工具"><MoreIcon /></summary>
          <div className="zoom-panel__menu" role="menu">
            <button
              className={marqueeMode ? 'is-active' : ''}
              type="button"
              role="menuitem"
              onClick={(event) => { onToggleMarqueeMode(); closeMoreMenu(event) }}
            >{marqueeMode ? '退出框选' : '框选节点'}<span>{touchInput ? '拖动' : 'Shift'}</span></button>
            <button type="button" role="menuitem" onClick={(event) => {
              onAutoLayout()
              window.requestAnimationFrame(() => commitViewport(fitView({ duration: viewportMotionDuration(220), padding: 0.16, minZoom: canvasMinZoom, maxZoom: 1 })))
              closeMoreMenu(event)
            }}>自动整理</button>
            <button type="button" role="menuitem" onClick={(event) => {
              commitViewport(fitView({ duration: viewportMotionDuration(180), padding: 0.16, minZoom: canvasMinZoom, maxZoom: 1 }))
              closeMoreMenu(event)
            }}>显示全部</button>
          </div>
        </details>
      </div>
    </Panel>
  )
}

function MultiSelectionToolbar({ count, onClear, phase }: { count: number; onClear: () => void; phase: MotionPhase }) {
  return (
    <Panel position="top-center" className="multi-selection-panel">
      <div className={`multi-selection-toolbar is-${phase}`} role="status" aria-live="polite">
        <span><strong>{count}</strong> 个节点已选中</span>
        <i>拖动任意节点可整体移动</i>
        <button type="button" onClick={onClear}>取消选择</button>
      </div>
    </Panel>
  )
}

function ConnectionGuide({ feedback }: { feedback?: 'connected' | 'invalid' | 'cancelled' | null }) {
  if (feedback) {
    const message = feedback === 'connected' ? '已连接' : feedback === 'invalid' ? '无法连接到这里' : '已取消连线'
    return (
      <Panel position="top-center" className="connection-guide-panel">
        <div className={`connection-feedback is-${feedback}`} role="status" aria-live="polite">{message}</div>
      </Panel>
    )
  }
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
  parentResultId?: string
  inputNodeId?: string
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
      void setViewport({ ...viewport, y: viewport.y - bottomOverflow - 18 }, { duration: viewportMotionDuration(180) })
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
  const { present, phase } = useMotionPresence(open, 160)

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
  const height = settings?.aspectRatio === '16:9' ? 169 : settings?.aspectRatio === '4:3' ? 225 : settings?.aspectRatio === '1:1' ? 300 : settings?.aspectRatio === '4:5' ? 375 : settings?.aspectRatio === '9:16' ? 533 : 400
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
 * 按生成血缘整理画布：一个首图任务和从任意候选图延展出的精修分支共享同一条泳道。
 * 这不是通用图算法：素材、生成器、候选图在 Botanic 中有明确语义，需要优先保证
 * “同一任务的输入和输出在一起”，再考虑全局的紧凑程度。
 */
function layoutCanvasNodes(nodes: CanvasNode[], edges: Edge[]): CanvasNode[] {
  const cloned = nodes.map((node) => ({
    ...node,
    position: { ...node.position },
    data: { ...node.data },
  })) as CanvasNode[]
  const nodeById = new Map(cloned.map((node) => [node.id, node]))
  const generateNodes = cloned.filter((node) => node.type === 'generate').sort(canvasNodeSort)
  const positions = new Map<string, XYPosition>()
  const inputGap = 68
  const laneGap = 240
  const columnGap = 172

  const uniqueIds = (ids: string[]) => [...new Set(ids)].filter((id) => nodeById.has(id))
  const sortIds = (ids: string[]) => uniqueIds(ids)
    .map((id) => nodeById.get(id)!)
    .sort(canvasNodeSort)
    .map((node) => node.id)

  const resultOutputOf = new Map<string, string>()
  for (const result of cloned.filter((node) => node.type === 'result')) {
    const outputOf = (result.data as ResultNodeData).outputOf
    if (outputOf && nodeById.get(outputOf)?.type === 'generate') resultOutputOf.set(result.id, outputOf)
  }
  for (const edge of edges) {
    if (nodeById.get(edge.source)?.type === 'generate' && nodeById.get(edge.target)?.type === 'result') {
      resultOutputOf.set(edge.target, edge.source)
    }
  }

  const inputIdsByGenerate = new Map<string, string[]>()
  for (const generate of generateNodes) {
    const ordered = (generate.data as GenerateNodeData).inputOrder ?? []
    const connected = edges
      .filter((edge) => edge.target === generate.id)
      .map((edge) => edge.source)
    inputIdsByGenerate.set(generate.id, uniqueIds([...ordered, ...connected]))
  }

  const parentResultByGenerate = new Map<string, string>()
  for (const generate of generateNodes) {
    const resultInput = inputIdsByGenerate.get(generate.id)?.find((id) => nodeById.get(id)?.type === 'result')
    if (resultInput) parentResultByGenerate.set(generate.id, resultInput)
  }

  const rootByGenerate = new Map<string, string>()
  const resolvingRoots = new Set<string>()
  const rootOfGenerate = (generateId: string): string => {
    const cached = rootByGenerate.get(generateId)
    if (cached) return cached
    if (resolvingRoots.has(generateId)) return generateId
    resolvingRoots.add(generateId)
    const parentResultId = parentResultByGenerate.get(generateId)
    const parentGenerateId = parentResultId ? resultOutputOf.get(parentResultId) : undefined
    const root = parentGenerateId && parentGenerateId !== generateId
      ? rootOfGenerate(parentGenerateId)
      : generateId
    resolvingRoots.delete(generateId)
    rootByGenerate.set(generateId, root)
    return root
  }
  generateNodes.forEach((node) => rootOfGenerate(node.id))

  const rankByGenerate = new Map<string, number>()
  const resolvingRanks = new Set<string>()
  const rankOfGenerate = (generateId: string): number => {
    const cached = rankByGenerate.get(generateId)
    if (typeof cached === 'number') return cached
    if (resolvingRanks.has(generateId)) return 1
    resolvingRanks.add(generateId)
    const parentResultId = parentResultByGenerate.get(generateId)
    const parentGenerateId = parentResultId ? resultOutputOf.get(parentResultId) : undefined
    const rank = parentGenerateId && parentGenerateId !== generateId
      ? rankOfGenerate(parentGenerateId) + 2
      : 1
    resolvingRanks.delete(generateId)
    rankByGenerate.set(generateId, rank)
    return rank
  }
  generateNodes.forEach((node) => rankOfGenerate(node.id))

  const targetGeneratesByInput = new Map<string, string[]>()
  inputIdsByGenerate.forEach((inputIds, generateId) => {
    inputIds.forEach((inputId) => {
      targetGeneratesByInput.set(inputId, [...(targetGeneratesByInput.get(inputId) ?? []), generateId])
    })
  })

  const rootNodes = new Map<string, string[]>()
  const ranks = new Map<string, number>()
  const assignToRoot = (nodeId: string, rootId: string, rank: number) => {
    rootNodes.set(rootId, [...(rootNodes.get(rootId) ?? []), nodeId])
    ranks.set(nodeId, rank)
  }

  for (const generate of generateNodes) {
    assignToRoot(generate.id, rootOfGenerate(generate.id), rankOfGenerate(generate.id))
  }
  for (const [resultId, generateId] of resultOutputOf) {
    assignToRoot(resultId, rootOfGenerate(generateId), rankOfGenerate(generateId) + 1)
  }

  const leftovers: string[] = []
  for (const node of cloned) {
    if (ranks.has(node.id)) continue
    const targets = (targetGeneratesByInput.get(node.id) ?? []).slice().sort((left, right) => {
      const rankDifference = rankOfGenerate(left) - rankOfGenerate(right)
      if (rankDifference) return rankDifference
      return canvasNodeSort(nodeById.get(left)!, nodeById.get(right)!)
    })
    if (!targets.length) {
      leftovers.push(node.id)
      continue
    }
    const owner = targets[0]
    assignToRoot(node.id, rootOfGenerate(owner), Math.max(0, rankOfGenerate(owner) - 1))
  }

  const rootIds = [...rootNodes.keys()]
    .sort((left, right) => canvasNodeSort(nodeById.get(left)!, nodeById.get(right)!))
  const columnWidths = new Map<number, number>()
  ranks.forEach((rank, nodeId) => {
    const width = taskNodeBounds(nodeById.get(nodeId)!).width
    columnWidths.set(rank, Math.max(columnWidths.get(rank) ?? 0, width))
  })
  const maxRank = Math.max(0, ...columnWidths.keys())
  const columnX = new Map<number, number>()
  let nextColumnX = 96
  for (let rank = 0; rank <= maxRank; rank += 1) {
    columnX.set(rank, nextColumnX)
    nextColumnX += (columnWidths.get(rank) ?? 0) + columnGap
  }

  let laneTop = 96
  for (const rootId of rootIds) {
    const nodeIds = uniqueIds(rootNodes.get(rootId) ?? [])
    const nodeIdsByRank = new Map<number, string[]>()
    nodeIds.forEach((nodeId) => {
      const rank = ranks.get(nodeId) ?? 0
      nodeIdsByRank.set(rank, [...(nodeIdsByRank.get(rank) ?? []), nodeId])
    })

    const columnHeights = new Map<number, number>()
    nodeIdsByRank.forEach((ids, rank) => {
      const sorted = sortIds(ids)
      nodeIdsByRank.set(rank, sorted)
      const height = sorted.reduce((total, nodeId) => total + taskNodeBounds(nodeById.get(nodeId)!).height, 0)
        + Math.max(0, sorted.length - 1) * inputGap
      columnHeights.set(rank, height)
    })
    const laneHeight = Math.max(260, ...columnHeights.values())

    nodeIdsByRank.forEach((ids, rank) => {
      let y = laneTop + (laneHeight - (columnHeights.get(rank) ?? 0)) / 2
      ids.forEach((nodeId) => {
        positions.set(nodeId, { x: columnX.get(rank) ?? 96, y })
        y += taskNodeBounds(nodeById.get(nodeId)!).height + inputGap
      })
    })
    laneTop += laneHeight + laneGap
  }

  // 未连接节点不伪装成某个任务的输入，统一收在所有任务之后的左侧素材区。
  let leftoverY = laneTop + 36
  sortIds(leftovers).forEach((nodeId) => {
    positions.set(nodeId, { x: 96, y: leftoverY })
    leftoverY += taskNodeBounds(nodeById.get(nodeId)!).height + inputGap
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
    }, 260)
    return () => window.clearTimeout(timer)
  }, [nodes, setCenter, taskKey])

  return null
}

function FocusCanvasNode({ node, requestId }: { node?: CanvasNode; requestId: number }) {
  const { fitView } = useReactFlow()

  useEffect(() => {
    if (!node) return
    const frame = window.requestAnimationFrame(() => {
      void fitView({ nodes: [node], duration: viewportMotionDuration(220), padding: 0.48, minZoom: canvasMinZoom, maxZoom: 1.05 })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [fitView, node, requestId])

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
      <button type="button" className="edge-actions__close" onClick={onClose} aria-label="关闭连线操作"><CloseIcon /></button>
    </div>
  )
}

function EmptyCanvasGuide({
  onOpenAssets,
  onAddImage,
  onAddVideo,
}: {
  onOpenAssets: () => void
  onAddImage: () => void
  onAddVideo: () => void
}) {
  return (
    <section className="empty-canvas-guide" aria-label="空画布引导">
      <span className="panel-eyebrow">START A PROJECT</span>
      <h2>从一个创意目标开始</h2>
      <p>拖入商品、场景或灵感图；也可以先添加一个生成节点，逐步搭建这次项目的创作路径。</p>
      <div>
        <button type="button" onClick={onOpenAssets}>添加素材</button>
        <button type="button" className="is-primary" onClick={onAddImage}>图片生成</button>
        <button type="button" onClick={onAddVideo}>视频生成</button>
      </div>
    </section>
  )
}

function CanvasWorkspace({ currentUser, onSignOut }: { currentUser?: ProductUser; onSignOut?: () => Promise<void> }) {
  const document = useCanvasStore((state) => state.document)
  const globalAssets = useCanvasStore((state) => state.globalAssets)
  const sharedTemplates = useCanvasStore((state) => state.sharedTemplates)
  const hydrated = useCanvasStore((state) => state.hydrated)
  const persistenceStatus = useCanvasStore((state) => state.persistenceStatus)
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId)
  const hydrate = useCanvasStore((state) => state.hydrate)
  const openDocument = useCanvasStore((state) => state.openDocument)
  const refreshDocumentFromRemote = useCanvasStore((state) => state.refreshDocumentFromRemote)
  const openNewDocument = useCanvasStore((state) => state.openNewDocument)
  const renameDocument = useCanvasStore((state) => state.renameDocument)
  const setNodes = useCanvasStore((state) => state.setNodes)
  const replaceMediaSources = useCanvasStore((state) => state.replaceMediaSources)
  const setNodesTransient = useCanvasStore((state) => state.setNodesTransient)
  const setEdges = useCanvasStore((state) => state.setEdges)
  const setViewport = useCanvasStore((state) => state.setViewport)
  const applyCollaborativeGraph = useCanvasStore((state) => state.applyCollaborativeGraph)
  const selectNode = useCanvasStore((state) => state.selectNode)
  const removeNodeFromCanvas = useCanvasStore((state) => state.removeNodeFromCanvas)
  const addAssetToCanvas = useCanvasStore((state) => state.addAssetToCanvas)
  const addUploadedAssets = useCanvasStore((state) => state.addUploadedAssets)
  const addUploadedAssetsToCanvas = useCanvasStore((state) => state.addUploadedAssetsToCanvas)
  const saveGeneratedImageToLibrary = useCanvasStore((state) => state.saveGeneratedImageToLibrary)
  const moveAssetToRole = useCanvasStore((state) => state.moveAssetToRole)
  const createAssetGroup = useCanvasStore((state) => state.createAssetGroup)
  const renameAssetGroup = useCanvasStore((state) => state.renameAssetGroup)
  const deleteAssetGroup = useCanvasStore((state) => state.deleteAssetGroup)
  const addAssetsToGroup = useCanvasStore((state) => state.addAssetsToGroup)
  const addTextNode = useCanvasStore((state) => state.addTextNode)
  const updateTextNode = useCanvasStore((state) => state.updateTextNode)
  const addGenerateNode = useCanvasStore((state) => state.addGenerateNode)
  const renameCanvasNode = useCanvasStore((state) => state.renameCanvasNode)
  const updateGenerateNode = useCanvasStore((state) => state.updateGenerateNode)
  const runGraphGeneration = useCanvasStore((state) => state.runGraphGeneration)
  const runBatchVariation = useCanvasStore((state) => state.runBatchVariation)
  const saveAgentPlan = useCanvasStore((state) => state.saveAgentPlan)
  const updateAgentRunStatus = useCanvasStore((state) => state.updateAgentRunStatus)
  const applyAgentRunSnapshot = useCanvasStore((state) => state.applyAgentRunSnapshot)
  const retryAgentBranch = useCanvasStore((state) => state.retryAgentBranch)
  const cancelAgentRun = useCanvasStore((state) => state.cancelAgentRun)
  const availableModels = useCanvasStore((state) => state.availableModels)
  const setAvailableModels = useCanvasStore((state) => state.setAvailableModels)
  const setGenerateNodePrimaryInput = useCanvasStore((state) => state.setGenerateNodePrimaryInput)
  const setStoreMaximumBatchCount = useCanvasStore((state) => state.setMaximumBatchCount)
  const createGenerateBranchFromResult = useCanvasStore((state) => state.createGenerateBranchFromResult)
  const createGenerateFromResultRecipe = useCanvasStore((state) => state.createGenerateFromResultRecipe)
  const deleteAsset = useCanvasStore((state) => state.deleteAsset)
  const saveCurrentAsTemplate = useCanvasStore((state) => state.saveCurrentAsTemplate)
  const saveCurrentAsSharedTemplate = useCanvasStore((state) => state.saveCurrentAsSharedTemplate)
  const createDocumentFromTemplate = useCanvasStore((state) => state.createDocumentFromTemplate)
  const refreshSharedTemplates = useCanvasStore((state) => state.refreshSharedTemplates)
  const generationStatus = useCanvasStore((state) => state.generationStatus)
  const generationError = useCanvasStore((state) => state.generationError)
  const expectedCandidateCount = useCanvasStore((state) => state.expectedCandidateCount)
  const generationCandidates = useCanvasStore((state) => state.generationCandidates)
  const lastGenerationRequest = useCanvasStore((state) => state.lastGenerationRequest)
  const cancelGeneration = useCanvasStore((state) => state.cancelGeneration)
  const retryGeneration = useCanvasStore((state) => state.retryGeneration)
  const ensureAgentSession = useCanvasStore((state) => state.ensureAgentSession)
  const startNewAgentSession = useCanvasStore((state) => state.startNewAgentSession)
  const appendAgentMessage = useCanvasStore((state) => state.appendAgentMessage)
  const updateAgentMessage = useCanvasStore((state) => state.updateAgentMessage)
  const updateAgentAction = useCanvasStore((state) => state.updateAgentAction)
  const setAgentSessionContext = useCanvasStore((state) => state.setAgentSessionContext)
  const setAgentSessionExecutionMode = useCanvasStore((state) => state.setAgentSessionExecutionMode)
  const setActiveAgentSession = useCanvasStore((state) => state.setActiveAgentSession)
  const addAgentMemory = useCanvasStore((state) => state.addAgentMemory)
  const removeAgentMemory = useCanvasStore((state) => state.removeAgentMemory)
  const clearGenerationError = useCanvasStore((state) => state.clearGenerationError)
  const selectGenerationCandidate = useCanvasStore((state) => state.selectGenerationCandidate)
  const createLocalDeliveries = useCanvasStore((state) => state.createLocalDeliveries)
  const undoAction = useCanvasStore((state) => state.undoAction)
  const undoLastAction = useCanvasStore((state) => state.undoLastAction)
  const [assetsOpen, setAssetsOpen] = useState(false)
  const [assetLibraryTargetGenerateId, setAssetLibraryTargetGenerateId] = useState<string | null>(null)
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [nodeReferencesOpen, setNodeReferencesOpen] = useState(false)
  const [candidatesOpen, setCandidatesOpen] = useState(false)
  const [nodeInspectorOpen, setNodeInspectorOpen] = useState(false)
  const [deliveryOpen, setDeliveryOpen] = useState(false)
  const [agentOpen, setAgentOpen] = useState(false)
  const agentLauncherRef = useRef<HTMLButtonElement | null>(null)
  const [agentTargetResultId, setAgentTargetResultId] = useState<string | null>(null)
  const [composerOpen, setComposerOpen] = useState(false)
  const [resultComposerDraft, setResultComposerDraft] = useState<ResultComposerDraft | null>(null)
  const [batchComposerTargetId, setBatchComposerTargetId] = useState<string | null>(null)
  const [imagePreview, setImagePreview] = useState<{ image: string; name: string; mediaKind: GenerationMediaKind } | null>(null)
  const [historyFocusRequest, setHistoryFocusRequest] = useState<{ nodeId: string; requestId: number } | null>(null)
  const [renamingProjectTabId, setRenamingProjectTabId] = useState<string | null>(null)
  const [projectTabNameDraft, setProjectTabNameDraft] = useState('')
  const [assetToDelete, setAssetToDelete] = useState<AssetRecord | null>(null)
  const [maximumBatchCount, setMaximumBatchCount] = useState(8)
  const [generationService, setGenerationService] = useState<GenerationServiceState>(initialGenerationServiceState)
  const [agentPlannerModels, setAgentPlannerModels] = useState<string[]>(defaultAgentPlannerModels)
  const [composerLayout, setComposerLayout] = useState<ComposerLayout>(readComposerLayout)
  const [nodePalette, setNodePalette] = useState<NodePalettePosition | null>(null)
  const [isCanvasFileDragging, setIsCanvasFileDragging] = useState(false)
  const [revealingResultNodeIds, setRevealingResultNodeIds] = useState<Map<string, number>>(() => new Map())
  const [canvasUploadMessage, setCanvasUploadMessage] = useState('')
  const [marqueeMode, setMarqueeMode] = useState(false)
  const [miniMapOpen, setMiniMapOpen] = useState(false)
  const [accountMenuAnchor, setAccountMenuAnchor] = useState<AccountMenuAnchor | null>(null)
  const [accountDialog, setAccountDialog] = useState<'profile' | 'security' | 'members' | 'audit' | null>(null)
  const accountTriggerRef = useRef<HTMLButtonElement>(null)
  const accountMenuPresence = useMotionPresence(Boolean(accountMenuAnchor), 180)
  const visibleAccountMenuAnchor = useRetainedValue(accountMenuAnchor)
  const accountDialogPresence = useMotionPresence(Boolean(accountDialog), 220)
  const visibleAccountDialog = useRetainedValue(accountDialog)
  const returnToAccountMenu = useCallback(() => {
    setAccountDialog(null)
    const rect = accountTriggerRef.current?.getBoundingClientRect()
    if (rect) setAccountMenuAnchor({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })
  }, [])
  const [isTouchTablet, setIsTouchTablet] = useState(false)
  const [zoomMode, setZoomMode] = useState(() => canvasZoomMode(document.viewport.zoom))
  const [expandedResultGroupIds, setExpandedResultGroupIds] = useState<Set<string>>(() => new Set())
  const [activeResultByGroupId, setActiveResultByGroupId] = useState<Map<string, string>>(() => new Map())
  const [isConnecting, setIsConnecting] = useState(false)
  const [connectionFeedback, setConnectionFeedback] = useState<'connected' | 'invalid' | 'cancelled' | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [edgeActionPosition, setEdgeActionPosition] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const coarsePointer = window.matchMedia('(pointer: coarse)')
    const updateTouchTablet = () => {
      const hasTouch = navigator.maxTouchPoints > 0 || coarsePointer.matches
      setIsTouchTablet(hasTouch && window.innerWidth >= 701 && window.innerWidth <= 1440)
    }
    updateTouchTablet()
    coarsePointer.addEventListener?.('change', updateTouchTablet)
    window.addEventListener('resize', updateTouchTablet)
    return () => {
      coarsePointer.removeEventListener?.('change', updateTouchTablet)
      window.removeEventListener('resize', updateTouchTablet)
    }
  }, [])
  const imagePreviewPresence = useMotionPresence(Boolean(imagePreview), 140)
  const visibleImagePreview = useRetainedValue(imagePreview)
  const assetDeletePresence = useMotionPresence(Boolean(assetToDelete), 140)
  const visibleAssetToDelete = useRetainedValue(assetToDelete)
  const nodePalettePresence = useMotionPresence(Boolean(nodePalette), 110)
  const visibleNodePalette = useRetainedValue(nodePalette)
  const undoPresence = useMotionPresence(Boolean(undoAction), 120)
  const visibleUndoAction = useRetainedValue(undoAction)
  const canvasDropPresence = useMotionPresence(isCanvasFileDragging, 100)
  useRestoreFocus(Boolean(imagePreview || assetToDelete || nodePalette))

  useEffect(() => {
    if (!connectionFeedback) return
    const timer = window.setTimeout(() => setConnectionFeedback(null), 1_100)
    return () => window.clearTimeout(timer)
  }, [connectionFeedback])

  useEffect(() => {
    if (!imagePreview) return
    const closePreview = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setImagePreview(null)
    }
    window.addEventListener('keydown', closePreview)
    return () => window.removeEventListener('keydown', closePreview)
  }, [imagePreview])
  const [initialWorkspaceLocation] = useState<WorkspaceLocation>(readWorkspaceLocation)
  const [workspaceLocation, setWorkspaceLocation] = useState<WorkspaceLocation>(initialWorkspaceLocation)
  const [workspaceTabIds, setWorkspaceTabIds] = useState<string[]>(() => {
    const saved = readWorkspaceTabs()
    const initialId = initialWorkspaceLocation.view === 'canvas' ? initialWorkspaceLocation.projectId : undefined
    return initialId && !saved.includes(initialId) ? [...saved, initialId] : saved
  })
  const [workspaceRestoring, setWorkspaceRestoring] = useState(initialWorkspaceLocation.view === 'canvas')
  const [workspaceRestored, setWorkspaceRestored] = useState(false)
  const [closingWorkspaceTabId, setClosingWorkspaceTabId] = useState<string | null>(null)
  const [viewportRestoring, setViewportRestoring] = useState(initialWorkspaceLocation.view === 'canvas')
  const [canvasHydrationFailed, setCanvasHydrationFailed] = useState(false)
  const workspaceView = workspaceLocation.view
  const workspaceDocumentMismatch = workspaceView === 'canvas'
    && Boolean(workspaceLocation.projectId)
    && document.id !== workspaceLocation.projectId
  const [workspaceProjects, setWorkspaceProjects] = useState<WorkspaceProject[]>([])
  const [workspaceProjectsLoading, setWorkspaceProjectsLoading] = useState(false)
  const [workspaceProjectsError, setWorkspaceProjectsError] = useState<string | null>(null)
  const assetLibraryAssets = useMemo(() => {
    const seen = new Set<string>()
    return [...globalAssets, ...document.assets].filter((asset) => {
      if (seen.has(asset.id)) return false
      seen.add(asset.id)
      return true
    })
  }, [document.assets, globalAssets])
  const batchComposerTarget = useMemo(() => {
    if (!batchComposerTargetId) return null
    const node = document.nodes.find((item) => item.id === batchComposerTargetId && item.type === 'result')
    if (!node || node.type !== 'result') return null
    const result = node.data as ResultNodeData
    if (!result.image) return null
    return {
      id: node.id,
      name: result.label ?? '已选结果',
      image: result.image,
      settings: result.generationSettings ?? defaultGenerationSettings,
    }
  }, [batchComposerTargetId, document.nodes])
  const projectTemplateSaveSummary = useMemo(
    () => summarizeWorkflowTemplate(document.nodes, document.edges),
    [document.edges, document.nodes],
  )
  const sharedTemplateSaveSummary = useMemo(
    () => summarizeWorkflowTemplate(document.nodes, document.edges, true),
    [document.edges, document.nodes],
  )
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
  const pendingNodePositionSaveRef = useRef(false)
  const collaborationRef = useRef<CanvasCollaboration | null>(null)
  const viewportReadyRef = useRef(false)
  const viewportDocumentIdRef = useRef(document.id)
  if (viewportDocumentIdRef.current !== document.id) {
    viewportDocumentIdRef.current = document.id
    viewportReadyRef.current = false
  }
  const restoredViewport = useMemo(
    () => readCachedCanvasViewport(document.id) ?? document.viewport,
    [document.id, document.viewport],
  )
  useEffect(() => {
    setZoomMode(canvasZoomMode(restoredViewport.zoom))
  }, [document.id, restoredViewport.zoom])
  useEffect(() => {
    setExpandedResultGroupIds(new Set())
    setActiveResultByGroupId(new Map())
  }, [document.id])
  const completeViewportRestore = useCallback(() => {
    // 忽略 React Flow 挂载时补发的默认视角事件，避免写坏已保存的画布位置。
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (viewportDocumentIdRef.current === document.id) {
          viewportReadyRef.current = true
          setViewportRestoring(false)
        }
      })
    })
  }, [document.id])

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

  const returnToProjectLibrary = useCallback(() => {
    // 关闭最后一个标签必须走浏览器真实导航。history.replaceState 不会触发 hashchange，
    // 会让地址栏已经是 /projects 但 React 仍停在旧画布。
    const location: WorkspaceLocation = { view: 'projects' }
    setWorkspaceRestoring(false)
    writeWorkspaceLocationFallback(location)
    const targetHash = workspaceHash(location)
    if (window.location.hash === targetHash) {
      setWorkspaceLocation(location)
      return
    }
    window.location.assign(targetHash)
  }, [])

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

  const hydrateCanvas = useCallback(() => {
    setCanvasHydrationFailed(false)
    void hydrate().catch(() => setCanvasHydrationFailed(true))
  }, [hydrate])

  const synchronizeLocalDrafts = useCallback(async () => {
    const result = await syncPendingCanvasDrafts()
    const current = useCanvasStore.getState()
    if (result.conflictIds.includes(current.document.id)) {
      await openDocument(current.document.id)
      useCanvasStore.setState({ persistenceStatus: 'saved', assistantMessage: '画布已同步。' })
      return result
    }
    if (result.pending === 0 && (current.persistenceStatus === 'offline' || current.persistenceStatus === 'error')) {
      useCanvasStore.setState({ persistenceStatus: 'saved', assistantMessage: '本地草稿已同步。' })
    }
    return result
  }, [])

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
        .catch(() => undefined)
    }
    syncDrafts()
    window.addEventListener('online', syncDrafts)
    return () => window.removeEventListener('online', syncDrafts)
  }, [hydrated, refreshDocumentFromRemote, synchronizeLocalDrafts])

  useEffect(() => {
    if (!hydrated || !workspaceRestored || workspaceView !== 'canvas' || !serverPersistenceEnabled) return
    const refresh = () => { void refreshDocumentFromRemote().catch(() => undefined) }
    const refreshWhenVisible = () => {
      if (window.document.visibilityState === 'visible') refresh()
    }
    window.addEventListener('focus', refresh)
    window.document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      window.removeEventListener('focus', refresh)
      window.document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [hydrated, refreshDocumentFromRemote, workspaceRestored, workspaceView])

  useEffect(() => {
    if (!hydrated || !workspaceRestored || workspaceView !== 'canvas' || !serverPersistenceEnabled) return
    const current = useCanvasStore.getState().document
    const collaboration = connectCanvasCollaboration({
      projectId: current.id,
      initialGraph: { nodes: current.nodes, edges: current.edges },
      onRemoteGraph: applyCollaborativeGraph,
      onProjectUpdated: (event) => {
        const latest = useCanvasStore.getState().document
        if (!shouldRefreshFromRealtimeEvent({
          event,
          currentProjectId: latest.id,
          currentUpdatedAt: latest.updatedAt,
        })) return
        void refreshDocumentFromRemote().catch(() => undefined)
      },
      onAgentRunUpdated: (event) => {
        applyAgentRunSnapshot(event.run)
        const terminal = event.run.branches.every((branch) => ['succeeded', 'failed', 'cancelled'].includes(branch.status))
        if (terminal) void refreshDocumentFromRemote().catch(() => undefined)
      },
    })
    collaborationRef.current = collaboration
    return () => {
      if (collaborationRef.current === collaboration) collaborationRef.current = null
      collaboration.close()
    }
  }, [applyAgentRunSnapshot, applyCollaborativeGraph, document.id, hydrated, refreshDocumentFromRemote, workspaceRestored, workspaceView])

  useEffect(() => {
    if (!hydrated || !workspaceRestored || workspaceView !== 'canvas' || !serverPersistenceEnabled) return
    let active = true
    void listPersistentBotanicAgentRuns(document.id).then((runs) => {
      if (!active) return
      for (const run of runs) applyAgentRunSnapshot(run)
    }).catch(() => undefined)
    return () => { active = false }
  }, [applyAgentRunSnapshot, document.id, hydrated, workspaceRestored, workspaceView])

  useEffect(() => {
    if (!hydrated || !workspaceRestored || workspaceView !== 'canvas' || !serverPersistenceEnabled) return
    if (!document.agentRuns.some((run) => run.status === 'queued' || run.status === 'running' || run.status === 'executing')) return
    let active = true
    let requesting = false
    const recoverProgress = async () => {
      if (!active || requesting || window.document.visibilityState !== 'visible') return
      requesting = true
      try {
        const runs = await listPersistentBotanicAgentRuns(document.id)
        if (!active) return
        for (const run of runs) applyAgentRunSnapshot(run)
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
  }, [applyAgentRunSnapshot, document.agentRuns, document.id, hydrated, workspaceRestored, workspaceView])

  useEffect(() => {
    collaborationRef.current?.replaceLocalGraph({ nodes: document.nodes, edges: document.edges })
  }, [document.edges, document.nodes])

  useEffect(() => {
    if (!hydrated || workspaceRestored) return

    let active = true
    let finished = false
    const finishRestore = (view: WorkspaceView, projectId?: string) => {
      if (!active || finished) return
      finished = true
      window.clearTimeout(restoreTimeout)
      setWorkspaceRestoring(false)
      setWorkspaceRestored(true)
      setWorkspaceView(view, projectId, 'replace')
    }
    // 无论浏览器存储或第三方请求处于何种异常状态，首次路由恢复都必须可退出。
    const restoreTimeout = window.setTimeout(() => finishRestore('projects'), 10_000)
    const restoreWorkspaceLocation = async () => {
      let location = workspaceLocationFromHash(window.location.hash) ?? initialWorkspaceLocation

      while (active) {
        if (location.view !== 'canvas') {
          finishRestore(location.view)
          return
        }

        let opened = false
        try {
          opened = await openDocument(location.projectId!)
        } catch {
          // 项目读取失败时不能一直保留“正在恢复”遮罩；退回项目页，由列表提供重试入口。
          finishRestore('projects')
          return
        }
        if (!active) return
        const latestHashLocation = workspaceLocationFromHash(window.location.hash) ?? initialWorkspaceLocation
        if (!sameWorkspaceLocation(location, latestHashLocation)) {
          location = latestHashLocation
          continue
        }

        finishRestore(opened ? 'canvas' : 'projects', opened ? location.projectId : undefined)
        return
      }
    }

    void restoreWorkspaceLocation()
    return () => {
      active = false
      window.clearTimeout(restoreTimeout)
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

        let opened = false
        try {
          opened = await openDocument(location.projectId!)
        } catch {
          if (sameWorkspaceLocation(location, workspaceLocationFromHash(window.location.hash))) {
            setWorkspaceView('projects', undefined, 'replace')
            setWorkspaceRestoring(false)
          }
          continue
        }
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
    setWorkspaceProjectsLoading(true)
    setWorkspaceProjectsError(null)
    try {
      const summaries = await readCanvasProjectSummaries()
      const projects = summaries
        // 空白草稿没有独立项目价值：不在项目库展示，也不计入项目数。
        .filter((item) => (item.nodeCount ?? 0) > 0 || (item.resultCount ?? 0) > 0)
        .map((item): WorkspaceProject => ({
        id: item.id,
        name: item.name,
        updatedAt: item.updatedAt,
        cover: item.coverImage,
        summary: item.resultCount
          ? `已生成 ${item.resultCount} 张图 · ${item.nodeCount ?? 0} 个节点`
          : item.nodeCount ? `已搭建 ${item.nodeCount} 个节点` : '空白画布',
        isSeed: item.id === 'summer-fragrance-visual-lab',
      }))
      setWorkspaceProjects(projects)
    } catch {
      setWorkspaceProjectsError('请检查网络或稍后重试。')
    } finally {
      setWorkspaceProjectsLoading(false)
    }
  }, [])

  const openWorkspaceProject = useCallback(async (projectId: string) => {
    const opened = await openDocument(projectId)
    if (opened) {
      setWorkspaceView('canvas', projectId)
    }
    return opened
  }, [openDocument, setWorkspaceView])

  const createWorkspaceProject = useCallback(async () => {
    const ordinal = workspaceProjects.filter((item) => item.id.startsWith('project-')).length + 1
    const project = createEmptyCanvasDocument(`project-${Date.now()}`, `创意项目 ${ordinal}`)
    // 先进入本地空白画布；首次添加素材/节点时才会持久化并创建项目。
    // 这样不会制造无法进入创作流程的空项目卡片。
    openNewDocument(project)
    setWorkspaceView('canvas', project.id)
    return true
  }, [openNewDocument, setWorkspaceView, workspaceProjects])

  const createWorkspaceProjectFromTemplate = useCallback(async (templateId: string, shared: boolean) => {
    const project = createDocumentFromTemplate(templateId, shared)
    if (!project) return false
    try {
      const saved = await createCanvasProject(project)
      openNewDocument(saved)
      setWorkspaceProjects((current) => [{
        id: saved.id,
        name: saved.name,
        updatedAt: saved.updatedAt,
        cover: saved.history[0]?.image || undefined,
        summary: `模板项目 · ${saved.nodes.length} 个节点`,
      }, ...current.filter((item) => item.id !== saved.id)])
      setWorkspaceView('canvas', saved.id)
      return true
    } catch {
      return false
    }
  }, [createDocumentFromTemplate, openNewDocument, setWorkspaceView])

  const renameWorkspaceProject = useCallback(async (projectId: string, name: string) => {
    const nextName = name.trim()
    if (!nextName) return false
    if (projectId === document.id) {
      try {
        await renameDocument(nextName)
      } catch {
        return false
      }
      setWorkspaceProjects((current) => current.map((project) => project.id === projectId
        ? { ...project, name: nextName, updatedAt: Date.now() }
        : project))
      return true
    } else {
      try {
        await renameCanvasProject(projectId, nextName)
      } catch {
        return false
      }
    }
    setWorkspaceProjects((current) => current.map((project) => project.id === projectId
      ? { ...project, name: nextName, updatedAt: Date.now() }
      : project))
    return true
  }, [document.id, renameDocument])

  const beginProjectTabRename = useCallback((project: WorkspaceProject) => {
    setProjectTabNameDraft(project.name)
    setRenamingProjectTabId(project.id)
  }, [])

  const commitProjectTabRename = useCallback(async (project: WorkspaceProject) => {
    const nextName = projectTabNameDraft.trim()
    setRenamingProjectTabId(null)
    if (!nextName || nextName === project.name) return
    const saved = await renameWorkspaceProject(project.id, nextName)
    if (!saved) {
      setProjectTabNameDraft(nextName)
      setRenamingProjectTabId(project.id)
    }
  }, [projectTabNameDraft, renameWorkspaceProject])

  const deleteWorkspaceProject = useCallback(async (projectId: string) => {
    const previousProjects = workspaceProjects
    // 删除操作可能涉及远端素材与任务清理。先从当前列表移除，避免界面被网络往返卡住。
    setWorkspaceProjects((current) => current.filter((project) => project.id !== projectId))
    setWorkspaceTabIds((current) => current.filter((id) => id !== projectId))
    if (workspaceLocation.view === 'canvas' && workspaceLocation.projectId === projectId) {
      setWorkspaceView('projects', undefined, 'replace')
    }
    try {
      await deleteCanvasDocument(projectId)
    } catch (error) {
      setWorkspaceProjects(previousProjects)
      throw error
    }
    // 后台校准列表，不阻塞弹窗关闭或用户继续操作。
    void refreshWorkspaceProjects()
  }, [refreshWorkspaceProjects, setWorkspaceView, workspaceLocation, workspaceProjects])

  const closeWorkspaceTab = useCallback((projectId: string) => {
    if (closingWorkspaceTabId) return
    // 本地曾保存过已删除或无权访问的标签 ID；它们不会渲染，却会让“最后一个
    // 可见标签”被误判为仍有下一个项目。关闭时只保留当前确实可打开的项目。
    const knownProjectIds = new Set([document.id, ...workspaceProjects.map((project) => project.id)])
    const remaining = workspaceTabIds.filter((id) => id !== projectId && knownProjectIds.has(id))
    // 标签的“当前”视觉与画布内容都由 document.id 决定。路由 ID 在异步切换时可能
    // 仍是上一个项目，不能再用它判断，否则关闭当前标签会被误当作关闭后台标签。
    if (projectId !== document.id) {
      setWorkspaceTabIds(remaining)
      return
    }
    const nextProjectId = remaining.at(-1)
    setClosingWorkspaceTabId(projectId)
    setWorkspaceTabIds(remaining)
    if (nextProjectId) {
      void openWorkspaceProject(nextProjectId)
        .then((opened) => {
          // 目标项目打不开时，恢复被关闭的当前标签，避免用户失去入口。
          if (!opened) setWorkspaceTabIds((current) => current.includes(projectId) ? current : [...current, projectId])
        })
        .finally(() => setClosingWorkspaceTabId(null))
      return
    }
    returnToProjectLibrary()
    setClosingWorkspaceTabId(null)
  }, [closingWorkspaceTabId, document.id, openWorkspaceProject, returnToProjectLibrary, workspaceProjects, workspaceTabIds])

  useEffect(() => {
    if (hydrated && workspaceView === 'projects') void refreshWorkspaceProjects()
  }, [hydrated, refreshWorkspaceProjects, workspaceView])

  useEffect(() => {
    if (!hydrated || workspaceView !== 'canvas') return
    // 顶部标签只保存项目 ID；直接在画布中新建或刷新时也要补齐项目元数据，
    // 否则旧标签会因找不到名称而被临时过滤，看起来像被新项目替换。
    void refreshWorkspaceProjects()
  }, [hydrated, refreshWorkspaceProjects, workspaceLocation.projectId, workspaceView])

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

  const toggleResultGroup = useCallback((groupId: string) => {
    setExpandedResultGroupIds((current) => {
      const next = new Set(current)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }, [])

  const chooseResultCandidate = useCallback((groupId: string, candidateId: string, promoted: boolean) => {
    setActiveResultByGroupId((current) => new Map(current).set(groupId, candidateId))
    selectNode(candidateId)
    if (promoted) {
      setExpandedResultGroupIds((current) => {
        const next = new Set(current)
        next.delete(groupId)
        return next
      })
    }
  }, [selectNode])

  const openAddMenuFromResult = useCallback((resultNodeId: string, screen: { x: number; y: number }) => {
    const mapper = screenToFlowPositionRef.current
    const paneRect = canvasPaneRef.current?.getBoundingClientRect()
    if (!mapper || !paneRect) return
    const screenPoint = {
      x: Math.max(paneRect.left + 94, Math.min(paneRect.right - 176, screen.x)),
      y: Math.max(paneRect.top + 92, Math.min(paneRect.bottom - 158, screen.y)),
    }
    setAssetsOpen(false)
    setAssetLibraryTargetGenerateId(null)
    setTemplatesOpen(false)
    setHistoryOpen(false)
    setNodeReferencesOpen(false)
    setCandidatesOpen(false)
    setNodeInspectorOpen(false)
    setDeliveryOpen(false)
    setResultComposerDraft(null)
    setBatchComposerTargetId(null)
    setExpandedResultGroupIds((current) => {
      const next = new Set(current)
      const result = document.nodes.find((node) => node.id === resultNodeId && node.type === 'result')
      const resultData = result?.type === 'result' ? result.data as ResultNodeData : undefined
      const groupId = resultData?.jobId ?? resultData?.taskGroupId
      if (groupId) next.delete(groupId)
      return next
    })
    setNodePalette({
      flow: mapper(screenPoint),
      screen: {
        x: Math.max(94, Math.min(paneRect.width - 262, screenPoint.x - paneRect.left + 8)),
        y: Math.max(70, Math.min(paneRect.height - 268, screenPoint.y - paneRect.top + 8)),
      },
      parentResultId: resultNodeId,
    })
  }, [document.nodes])

  const openAgentForResult = useCallback((resultNodeId: string) => {
    const result = document.nodes.find((node) => node.id === resultNodeId && node.type === 'result')
    const data = result?.type === 'result' ? result.data as ResultNodeData : undefined
    if (!data?.image) return
    selectNode(resultNodeId)
    const sessionId = ensureAgentSession([resultNodeId])
    const session = useCanvasStore.getState().document.agentSessions.find((item) => item.id === sessionId)
    setAgentSessionContext(sessionId, [...(session?.contextNodeIds ?? []), resultNodeId])
    setAgentTargetResultId(resultNodeId)
    setAgentOpen(true)
    setComposerOpen(false)
    setResultComposerDraft(null)
    setBatchComposerTargetId(null)
  }, [document.nodes, ensureAgentSession, selectNode, setAgentSessionContext])

  const selectedFocusNodeIds = useMemo(() => {
    const selectedIds = document.nodes.filter((node) => node.selected).map((node) => node.id)
    if (selectedIds.length) return selectedIds
    return selectedNodeId ? [selectedNodeId] : []
  }, [document.nodes, selectedNodeId])
  const focusedLineage = useMemo(
    () => traceCanvasLineage(selectedFocusNodeIds, document.edges),
    [document.edges, selectedFocusNodeIds],
  )
  const hasLineageFocus = selectedFocusNodeIds.length > 0
  const resultNodesById = useMemo(() => new Map(document.nodes
    .filter((node) => node.type === 'result')
    .map((node) => [node.id, node] as const)), [document.nodes])
  const resultNodesWithDownstream = useMemo(() => new Set(document.edges
    .filter((edge) => resultNodesById.has(edge.source))
    .map((edge) => edge.source)), [document.edges, resultNodesById])
  const resultGroupPresentation = useMemo(() => planResultGroupPresentation(
    document.nodes.flatMap((node) => {
      if (node.type !== 'result') return []
      const result = node.data as ResultNodeData
      return [{
        id: node.id,
        groupId: result.jobId ?? result.taskGroupId,
        selected: Boolean(node.selected || node.id === selectedNodeId || result.selected),
        active: activeResultByGroupId.get(result.jobId ?? result.taskGroupId ?? '') === node.id,
        hasDownstream: resultNodesWithDownstream.has(node.id),
        variant: result.variant,
      }]
    }),
    expandedResultGroupIds,
  ), [activeResultByGroupId, document.nodes, expandedResultGroupIds, resultNodesWithDownstream, selectedNodeId])
  const resultGroupCandidates = useMemo(() => {
    const groups = new Map<string, ResultGroupCandidateUi[]>()
    for (const node of resultNodesById.values()) {
      const group = resultGroupPresentation.get(node.id)
      if (!group) continue
      const result = node.data as ResultNodeData
      const candidates = groups.get(group.groupId) ?? []
      candidates.push({
        id: node.id,
        name: result.label ?? `候选 ${(result.variant ?? candidates.length) + 1}`,
        image: result.image,
        mediaKind: result.mediaKind ?? 'image',
        active: group.activeId === node.id,
        promoted: group.promoted,
      })
      groups.set(group.groupId, candidates)
    }
    for (const candidates of groups.values()) {
      candidates.sort((left, right) => {
        const leftNode = resultNodesById.get(left.id)
        const rightNode = resultNodesById.get(right.id)
        const leftVariant = leftNode?.type === 'result' ? (leftNode.data as ResultNodeData).variant : undefined
        const rightVariant = rightNode?.type === 'result' ? (rightNode.data as ResultNodeData).variant : undefined
        return (leftVariant ?? Number.MAX_SAFE_INTEGER) - (rightVariant ?? Number.MAX_SAFE_INTEGER)
          || left.id.localeCompare(right.id)
      })
    }
    return groups
  }, [resultGroupPresentation, resultNodesById])
  const hiddenResultNodeIds = useMemo(() => new Set([...resultGroupPresentation]
    .filter(([, presentation]) => presentation.hidden)
    .map(([nodeId]) => nodeId)), [resultGroupPresentation])

  const renderedNodes = useMemo(() => document.nodes.map((node) => {
    const entryIndex = revealingResultNodeIds.get(node.id)
    const group = resultGroupPresentation.get(node.id)
    const focusNodeId = group?.representative ? group.activeId : node.id
    const focusClass = hasLineageFocus
      ? focusedLineage.nodeIds.has(focusNodeId) ? 'is-lineage' : 'is-lineage-muted'
      : ''
    const revealClass = node.type === 'result' && entryIndex !== undefined ? 'result-node--arriving' : ''
    const isResult = node.type === 'result'
    const activeResultNode = isResult && group?.representative ? resultNodesById.get(group.activeId) : undefined
    const displayedData = activeResultNode?.data ?? node.data
    if (!focusClass && !revealClass && !isResult) return node
    return {
      ...node,
      className: `${node.className ?? ''} ${focusClass} ${revealClass}`.trim(),
      selected: Boolean(node.selected || (group?.representative && group.activeId === selectedNodeId)),
      hidden: Boolean(node.hidden || group?.hidden),
      ...(isResult ? {
        data: {
          ...displayedData,
          __ui: {
            group,
            targetNodeId: group?.representative ? group.activeId : node.id,
            groupCandidates: group?.representative ? resultGroupCandidates.get(group.groupId) : undefined,
            onToggleGroup: toggleResultGroup,
            onChooseCandidate: chooseResultCandidate,
            onOpenAddMenu: openAddMenuFromResult,
            onOpenAgent: openAgentForResult,
          },
        } as ResultNodeUiData,
      } : {}),
      ...(entryIndex === undefined ? {} : {
        style: {
          ...node.style,
          '--result-entry-delay': `${entryIndex * 45}ms`,
        } as CSSProperties,
      }),
    }
  }), [chooseResultCandidate, document.nodes, focusedLineage.nodeIds, hasLineageFocus, openAddMenuFromResult, openAgentForResult, resultGroupCandidates, resultGroupPresentation, resultNodesById, revealingResultNodeIds, selectedNodeId, toggleResultGroup])

  const refreshGenerationService = useCallback(async () => {
    setGenerationService(initialGenerationServiceState)
    try {
      const health = await getGenerationServiceHealth()
      if (typeof health.maxBatchCount === 'number' && Number.isInteger(health.maxBatchCount)) {
        const maximum = Math.max(1, health.maxBatchCount)
        setMaximumBatchCount(maximum)
        setStoreMaximumBatchCount(maximum)
      }
      const models = Array.isArray(health.modelOptions) && health.modelOptions.length
        ? health.modelOptions
        : Array.isArray(health.models)
          ? health.models
            .filter((model): model is string => typeof model === 'string' && Boolean(model.trim()))
            .map((model) => ({ id: model, label: model === 'gpt-image-2' ? 'GPT Image 2' : model }))
        : defaultGenerationModels
      setAvailableModels(models)
      setAgentPlannerModels(Array.isArray(health.agentPlanner?.models) && health.agentPlanner.models.length
        ? health.agentPlanner.models
        : defaultAgentPlannerModels)
      setGenerationService(health.configured
        ? { status: 'ready', message: '真实生图服务已就绪。' }
        : { status: 'unconfigured', message: '服务已启动，但尚未配置 OPENAI_API_KEY 或 MINIMAX_API_KEY。' })
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
      const nextNodes = applyNodeChanges(changes, useCanvasStore.getState().document.nodes)
      // 框选、单选只是即时 UI 状态，不应触发整份画布远端保存。
      if (changes.every((change) => change.type === 'select')) {
        setNodesTransient(nextNodes)
        return
      }
      // 拖动期间只更新画布，直到鼠标松开时才持久化最终坐标。
      // 键盘等非拖动的位置变更仍立即保存，避免遗漏可访问性操作。
      const positionOnly = changes.length > 0 && changes.every((change) => change.type === 'position')
      const dragging = positionOnly && changes.some((change) => change.type === 'position' && change.dragging === true)
      if (dragging) {
        pendingNodePositionSaveRef.current = true
        setNodesTransient(nextNodes)
        return
      }
      if (positionOnly) pendingNodePositionSaveRef.current = false
      setNodes(nextNodes)
    },
    [hydrated, setNodes, setNodesTransient],
  )

  const persistDraggedNodes = useCallback(() => {
    if (!hydrated || !pendingNodePositionSaveRef.current) return
    pendingNodePositionSaveRef.current = false
    setNodes(useCanvasStore.getState().document.nodes)
  }, [hydrated, setNodes])

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

  const onCanvasMove = useCallback((_event: unknown, viewport: typeof document.viewport) => {
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
    setNodeInspectorOpen(false)
    setNodePalette(null)
    setResultComposerDraft(null)
  }, [])

  const closeWorkbenchPanels = useCallback(() => {
    setAssetsOpen(false)
    setAssetLibraryTargetGenerateId(null)
    setTemplatesOpen(false)
    setHistoryOpen(false)
    setNodeReferencesOpen(false)
    setCandidatesOpen(false)
    setNodeInspectorOpen(false)
    setDeliveryOpen(false)
    setResultComposerDraft(null)
    setBatchComposerTargetId(null)
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

  const onCanvasDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    // 素材库中的卡片仍然保留在原处，拖入画布本质上是一次“添加”。
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const onCanvasDrop = useCallback((event: DragEvent<HTMLElement>) => {
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
    // Safari / 部分内嵌浏览器会在 drop 阶段丢弃自定义 MIME，只保留 text/plain。
    const assetId = event.dataTransfer.getData('application/x-botanic-asset-id')
      || event.dataTransfer.getData('text/plain')
    if (assetId && assetLibraryAssets.some((asset) => asset.id === assetId)) addAssetToCanvas(assetId, position)
  }, [addAssetToCanvas, addDroppedFilesToCanvas, assetLibraryAssets])

  const isFlowDropTarget = useCallback((target: EventTarget | null) => (
    target instanceof Element && Boolean(target.closest('.react-flow'))
  ), [])

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

  const openNodePalette = useCallback((event: ReactMouseEvent, fromDock = false, parentResultId?: string) => {
    const mapper = screenToFlowPositionRef.current
    const paneRect = canvasPaneRef.current?.getBoundingClientRect()
    if (!mapper || !paneRect) return
    const selectedNode = document.nodes.find((node) => node.id === selectedNodeId)
    const selectedResult = selectedNode?.type === 'result' ? selectedNode : undefined
    const selectedResultData = selectedResult?.type === 'result' ? selectedResult.data as ResultNodeData : undefined
    const contextualResultId = parentResultId ?? (selectedResultData?.image ? selectedResult?.id : undefined)
    const contextualInputNodeId = !contextualResultId && (selectedNode?.type === 'asset' || selectedNode?.type === 'text')
      ? selectedNode.id
      : undefined
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
      parentResultId: contextualResultId,
      inputNodeId: contextualInputNodeId,
    })
  }, [closeWorkbenchPanels, document.nodes, selectedNodeId])

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
      return {
        stroke: '#3f6f9d',
        strokeWidth: 1.8,
        ...(source?.type === 'result' && target?.type === 'generate' ? { strokeDasharray: '4 3' } : {}),
      }
    }
    if (source?.type === 'result' && target?.type === 'generate') {
      return { stroke: '#7e9785', strokeWidth: 1.25, strokeDasharray: '4 3' }
    }
    if (source?.type === 'generate' && target?.type === 'result') {
      return { stroke: '#2a5238', strokeWidth: 1.7 }
    }
    return { stroke: '#4f805b', strokeWidth: 1.6 }
  }, [document.nodes, isVideoConnection])

  const renderedEdges = useMemo(() => document.edges.map((edge) => ({
    ...edge,
    hidden: Boolean(edge.hidden || hiddenResultNodeIds.has(edge.source) || hiddenResultNodeIds.has(edge.target)),
    className: [
      edge.className ?? '',
      isVideoConnection(edge) ? 'media-edge--video' : '',
      hasLineageFocus ? focusedLineage.edgeIds.has(edge.id) ? 'is-lineage' : 'is-lineage-muted' : '',
    ].filter(Boolean).join(' '),
    style: { ...edge.style, ...graphEdgeStyle(edge) },
  })), [document.edges, focusedLineage.edgeIds, graphEdgeStyle, hasLineageFocus, hiddenResultNodeIds, isVideoConnection])

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

  const addAssetFromLibrary = useCallback((assetId: string) => {
    const target = assetLibraryTargetGenerateId
      ? document.nodes.find((node) => node.id === assetLibraryTargetGenerateId && node.type === 'generate')
      : undefined
    addAssetToCanvas(assetId, undefined, target?.id)
  }, [addAssetToCanvas, assetLibraryTargetGenerateId, document.nodes])

  const canvasClassName = 'app-shell app-shell--agent-closed'
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
    // 正在关闭的当前项目不能再被旧画布状态兜底补回，否则会出现“点击关闭但标签还在”。
    const ids = workspaceTabIds.includes(document.id) || closingWorkspaceTabId === document.id
      ? workspaceTabIds
      : [...workspaceTabIds, document.id]
    return ids.flatMap((id) => {
      const project = projectsById.get(id)
      return project ? [project] : []
    })
  }, [closingWorkspaceTabId, document.id, document.name, document.nodes.length, document.updatedAt, workspaceProjects, workspaceTabIds])

  const generatedHistoryItems = useMemo<GeneratedHistoryItem[]>(() => {
    const results = document.nodes.flatMap((node) => {
      if (node.type !== 'result') return []
      const result = node.data as ResultNodeData
      if (!result.image) return []
      const settings = result.generationSettings ?? result.generationRecipe?.settings
      return [{
        id: node.id,
        nodeId: node.id,
        versionId: result.versionId,
        image: result.image,
        mediaKind: result.mediaKind ?? 'image',
        name: result.label ?? (result.generationKind === 'refinement' ? '精修版本' : '生成图片'),
        createdAt: result.submittedAt ?? 0,
        aspectRatio: settings?.aspectRatio,
        resolution: settings?.resolution,
        duration: settings?.duration,
      }]
    })
    const resultVersionIds = new Set(results.map((item) => item.versionId).filter((id): id is string => Boolean(id)))
    const legacyHistory = document.history
      .filter((entry) => entry.kind !== 'template' && !resultVersionIds.has(entry.id))
      .map((entry) => ({
        id: `history-${entry.id}`,
        image: entry.image,
        mediaKind: 'image' as const,
        name: entry.name,
        createdAt: entry.createdAt,
      }))
    return [...results, ...legacyHistory].sort((left, right) => right.createdAt - left.createdAt)
  }, [document.history, document.nodes])
  const deliveryTargets = useMemo<DeliveryPanelTarget[]>(() => generatedHistoryItems.flatMap((item) => (
    item.nodeId && canUseForImageDelivery(item.mediaKind)
      ? [{ nodeId: item.nodeId, versionId: item.versionId, image: item.image, label: item.name }]
      : []
  )), [generatedHistoryItems])
  const selectedCanvasNode = document.nodes.find((node) => node.id === selectedNodeId)
  const selectedEdge = selectedEdgeId ? document.edges.find((edge) => edge.id === selectedEdgeId) : undefined
  const selectedResult = selectedCanvasNode?.type === 'result' ? selectedCanvasNode : undefined
  const selectedResultData = selectedResult?.type === 'result' ? selectedResult.data as ResultNodeData : undefined
  const selectedGenerate = selectedCanvasNode?.type === 'generate' ? selectedCanvasNode : undefined
  const selectedGenerateData = selectedGenerate?.type === 'generate' ? selectedGenerate.data as GenerateNodeData : undefined
  const selectedCanvasNodes = document.nodes.filter((node) => Boolean(node.selected))
  const multiSelectionPresence = useMotionPresence(selectedCanvasNodes.length > 1, 120)
  const visibleMultiSelectionCount = useRetainedValue(selectedCanvasNodes.length > 1 ? selectedCanvasNodes.length : null)
  const latestTaskResult = [...document.nodes].reverse().find((node) => node.type === 'result' && node.id.startsWith('result-task-'))
  const latestTaskResultData = latestTaskResult?.type === 'result' ? latestTaskResult.data as ResultNodeData : undefined
  const latestTaskJobId = latestTaskResultData?.jobId
  const latestTaskGenerateId = latestTaskResult
    ? document.edges.find((edge) => edge.target === latestTaskResult.id && document.nodes.some((node) => node.id === edge.source && node.type === 'generate'))?.source
    : undefined
  const latestTaskInputIds = latestTaskGenerateId
    ? document.edges
      .filter((edge) => edge.target === latestTaskGenerateId)
      .map((edge) => edge.source)
    : []
  // 一次任务的额外输出节点不会再使用 result-task-* 前缀；聚焦时必须把同一 job
  // 的所有结果一起纳入，否则视角会停留在左侧占位节点，用户看不到刚回填的图片。
  const latestTaskOutputIds = latestTaskJobId
    ? document.nodes
      .filter((node) => node.type === 'result' && (node.data as ResultNodeData).jobId === latestTaskJobId)
      .map((node) => node.id)
    : []
  const latestTaskKey = latestTaskResult
    ? `${latestTaskResult.id}:${latestTaskJobId ?? ''}:${latestTaskOutputIds.length}:${latestTaskResultData?.status ?? ''}`
    : undefined
  const latestTaskNodeIds = new Set([latestTaskResult?.id, latestTaskGenerateId, ...latestTaskInputIds, ...latestTaskOutputIds].filter(Boolean))
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
        mediaKind: resultComposerData.mediaKind ?? 'image',
        label: resultComposerData.label ?? (resultComposerData.generationKind === 'refinement' ? '精修版本' : '首图版本'),
        recipe: resultComposerData.generationRecipe,
      }
    : undefined
  const activeAgentSession = document.agentSessions.find((session) => session.id === document.activeAgentSessionId)
  const activeAgentContextNodeIds = activeAgentSession?.contextNodeIds ?? selectedFocusNodeIds
  const contextualResultId = activeAgentContextNodeIds.find((nodeId) => {
    const node = document.nodes.find((item) => item.id === nodeId && item.type === 'result')
    const result = node?.type === 'result' ? node.data as ResultNodeData : undefined
    return Boolean(result?.image) && canUseForImageDelivery(result?.mediaKind)
  })
  const effectiveAgentTargetResultId = agentTargetResultId ?? contextualResultId
  const agentTargetNode = effectiveAgentTargetResultId
    ? document.nodes.find((node) => node.id === effectiveAgentTargetResultId && node.type === 'result')
    : undefined
  const agentTargetData = agentTargetNode?.type === 'result' ? agentTargetNode.data as ResultNodeData : undefined
  const agentRootRecipe = agentTargetData?.rootRecipe ?? agentTargetData?.generationRecipe
  const agentTarget: AgentDockTarget | undefined = agentTargetNode?.type === 'result' && agentTargetData?.image && agentRootRecipe
    ? {
        id: agentTargetNode.id,
        label: agentTargetData.label ?? '已选结果',
        image: agentTargetData.image,
        rootRecipe: agentRootRecipe,
      }
    : undefined
  const latestAgentRun = document.agentRuns.find((run) => run.plan.selectedResultNodeId === effectiveAgentTargetResultId)
  const agentArtifacts = useMemo(() => collectBotanicAgentResults({
    sessions: document.agentSessions,
    nodes: document.nodes,
    generationJobs: document.generationJobs,
    assets: document.assets,
  }), [document.agentSessions, document.assets, document.generationJobs, document.nodes])
  const agentContextOptions = document.nodes.flatMap((node): AgentContextItem[] => {
    if (node.type === 'asset') {
      const data = node.data as AssetNodeData
      return [{ id: node.id, label: data.name ?? '图片素材', kind: '素材', image: data.image }]
    }
    if (node.type === 'result') {
      const data = node.data as ResultNodeData
      return data.image && canUseForImageDelivery(data.mediaKind)
        ? [{ id: node.id, label: data.label ?? '生成结果', kind: '结果', image: data.image }]
        : []
    }
    if (node.type === 'text') {
      const data = node.data as TextNodeData
      return [{ id: node.id, label: data.label ?? '文字描述', kind: '文字' }]
    }
    if (node.type === 'generate') {
      const data = node.data as GenerateNodeData
      return [{ id: node.id, label: data.label ?? '生成节点', kind: '节点' }]
    }
    return []
  })

  const createAgentWorkflowDraft = useCallback(async (
    instruction: string,
    contextNodeIds: string[],
    autoExecute: boolean,
  ) => {
    const referenceNodeIds = contextNodeIds.filter((nodeId) => document.nodes.some((node) => {
      if (node.id !== nodeId) return false
      if (node.type === 'asset') return ((node.data as AssetNodeData).mediaKind ?? 'image') === 'image'
      if (node.type !== 'result') return false
      const result = node.data as ResultNodeData
      return Boolean(result.image) && canUseForImageDelivery(result.mediaKind)
    }))
    const origin = document.nodes.length
      ? { x: Math.max(...document.nodes.map((node) => node.position.x)) + 220, y: Math.min(...document.nodes.map((node) => node.position.y)) }
      : { x: 180, y: 160 }
    addTextNode(origin)
    const textNodeId = useCanvasStore.getState().selectedNodeId
    if (!textNodeId) return { created: false, started: false, needsReference: !referenceNodeIds.length }
    updateTextNode(textNodeId, instruction)
    const generateNodeId = addGenerateNode({ x: origin.x + 360, y: origin.y + 40 }, 'image', [...referenceNodeIds, textNodeId])
    if (!generateNodeId) return { created: false, started: false, needsReference: !referenceNodeIds.length }
    updateGenerateNode(generateNodeId, { prompt: instruction })
    if (!autoExecute || !referenceNodeIds.length) return { created: true, started: false, needsReference: !referenceNodeIds.length }
    const started = await runGraphGeneration(generateNodeId)
    return { created: true, started, needsReference: false }
  }, [addGenerateNode, addTextNode, document.nodes, runGraphGeneration, updateGenerateNode, updateTextNode])

  const confirmAgentAction = useCallback(async (action: BotanicAgentActionProposal): Promise<BotanicAgentActionResult> => {
    const response = await executeProjectAgentAction({ projectId: document.id, action })
    const output = response.output
    const nodes = useCanvasStore.getState().document.nodes
    const origin = nodes.length
      ? { x: Math.max(...nodes.map((node) => node.position.x)) + 220, y: Math.min(...nodes.map((node) => node.position.y)) + 120 }
      : { x: 180, y: 160 }
    const writebacks: BotanicAgentCanvasWriteback[] = []
    for (const [index, resolved] of resolveBotanicAgentCanvasCommands(output).entries()) {
      const position = { x: origin.x + (index % 2) * 240, y: origin.y + Math.floor(index / 2) * 260 }
      if (resolved.command.type === 'create_text_node' && resolved.artifact.content) {
        addTextNode(position)
        const nodeId = useCanvasStore.getState().selectedNodeId
        if (!nodeId) throw new Error('行动已执行，但文字节点创建失败。')
        updateTextNode(nodeId, resolved.artifact.content)
        renameCanvasNode(nodeId, resolved.artifact.label)
        writebacks.push({ artifactId: resolved.artifact.id, nodeId })
      }
      if (resolved.command.type === 'create_media_node' && resolved.artifact.url) {
        addUploadedAssetsToCanvas([{
          name: resolved.artifact.label,
          image: resolved.artifact.url,
          role: '场景',
          mediaKind: resolved.artifact.kind === 'video' ? 'video' : 'image',
          collection: 'Agent 产物',
          tags: ['Agent', resolved.artifact.provenance.externalTool ?? resolved.artifact.provenance.toolName],
        }], position)
        const nodeId = useCanvasStore.getState().selectedNodeId
        if (nodeId) writebacks.push({ artifactId: resolved.artifact.id, nodeId })
      }
    }
    return recordBotanicAgentCanvasWritebacks(output, writebacks)
  }, [addTextNode, addUploadedAssetsToCanvas, document.id, renameCanvasNode, updateTextNode])

  const confirmAgentPlan = useCallback(async (plan: BotanicAgentPlan) => {
    const group = plan.assetGroupId ? document.assetGroups.find((item) => item.id === plan.assetGroupId) : undefined
    const branchInputs = plan.output.mode === 'batch_by_asset' && group
      ? group.assetIds.map((assetId, index) => ({ assetId, branchId: `branch-${crypto.randomUUID()}`, label: `分支 ${index + 1}` }))
      : [{ branchId: `branch-${crypto.randomUUID()}`, label: plan.summary }]
    let runId: string
    if (serverPersistenceEnabled) {
      try {
        const activeDocument = useCanvasStore.getState().document
        const sources = collectAgentMediaSources(activeDocument, plan.selectedResultNodeId, plan.assetGroupId)
        const replacements = await prepareAgentMediaSources(
          sources,
          (source) => persistAgentReferenceMedia(activeDocument.id, source),
        )
        await replaceMediaSources(replacements)
        const snapshot = await createPersistentBotanicAgentRun({
          projectId: document.id,
          plan,
          branches: branchInputs.map((branch) => ({
            id: branch.branchId,
            label: branch.label,
            ...('assetId' in branch ? { assetId: branch.assetId } : {}),
          })),
        })
        runId = saveAgentPlan(plan, { id: snapshot.id, branches: snapshot.branches })
        applyAgentRunSnapshot(snapshot)
        await flushPendingCanvasDocumentWrites()
        const execution = await executePersistentBotanicAgentRun(document.id, runId)
        applyAgentRunSnapshot(execution.run)
        await refreshDocumentFromRemote().catch(() => false)
        return { started: execution.jobIds.length > 0, runId }
      } catch (caught) {
        throw new Error(caught instanceof Error ? caught.message : 'Agent Run 无法持久化，请稍后重试。')
      }
    } else {
      runId = saveAgentPlan(plan)
      updateAgentRunStatus(runId, 'executing')
    }
    let started = false
    if (plan.output.mode === 'batch_by_asset' && plan.assetGroupId) {
      started = await runBatchVariation({
        sourceResultNodeId: plan.selectedResultNodeId,
        groupId: plan.assetGroupId,
        prompt: plan.prompt,
        candidatesPerAsset: plan.output.candidatesPerItem,
        settings: plan.settings,
        agentRunId: serverPersistenceEnabled ? runId : undefined,
        agentBranches: group ? branchInputs.map((branch, index) => ({ assetId: group.assetIds[index], branchId: branch.branchId })) : undefined,
      })
    } else {
      const branchId = plan.intent === 'redo_from_root'
        ? createGenerateFromResultRecipe(plan.selectedResultNodeId)
        : createGenerateBranchFromResult(plan.selectedResultNodeId, {
            prompt: plan.prompt,
            batchCount: plan.output.count,
            settings: plan.settings,
            refinementMode: 'faithful',
          })
      if (branchId) {
        if (plan.intent === 'redo_from_root') updateGenerateNode(branchId, { prompt: plan.prompt, settings: plan.settings })
        started = await runGraphGeneration(branchId, serverPersistenceEnabled ? { runId, branchId: branchInputs[0].branchId } : undefined)
      }
    }
    if (!started) {
      updateAgentRunStatus(runId, 'failed', '生成任务未启动，请检查参考素材与生成服务。')
      return { started: false, runId }
    }
    return { started: true, runId }
  }, [applyAgentRunSnapshot, createGenerateBranchFromResult, createGenerateFromResultRecipe, document.assetGroups, document.id, refreshDocumentFromRemote, replaceMediaSources, runBatchVariation, runGraphGeneration, saveAgentPlan, updateAgentRunStatus, updateGenerateNode])

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
      mediaKind: asset.mediaKind ?? 'image',
    }]
  })
  const selectedGenerateTextCount = selectedGenerateInputs.filter((node) => node.type === 'text').length
  const selectedGenerateParent = selectedGenerateInputs.find((node) => {
    if (node.type !== 'result') return false
    const result = node.data as ResultNodeData
    return Boolean(result.image) && (result.mediaKind ?? 'image') === 'image'
  })
  const selectedGenerateResultReferences = selectedGenerateInputs.flatMap((node) => {
    if (node.type !== 'result') return []
    const result = node.data as ResultNodeData
    if (!result.image) return []
    return [{
      id: node.id,
      image: result.image,
      name: result.label ?? '上游输出',
      role: (result.mediaKind === 'video' ? '调性' : '首图') as AssetRole,
      source: 'generated' as const,
      primary: result.mediaKind !== 'video',
      mediaKind: result.mediaKind ?? 'image',
    }]
  })
  const selectedGeneratePrimaryReference = selectedGenerateReferences.find((asset) => asset.primary) ?? selectedGenerateReferences[0]
  const selectedGenerateParentReference = selectedGenerateInputs
    .filter((node) => node.type === 'result')
    .map((node) => primaryReferenceFromRecipe((node.data as ResultNodeData).generationRecipe))
    .find(Boolean)
  const composerReferences = [
    ...selectedGenerateReferences,
    ...selectedGenerateResultReferences,
  ]
  const selectedGenerateModel = availableModels.find((model) => model.id === selectedGenerateData?.settings.model)
  const selectedGenerateIsVideo = selectedGenerateModel?.mediaKind === 'video'
  const selectedGenerateLabel = selectedGenerateIsVideo && selectedGenerateData?.label === '图像生成'
    ? '视频生成'
    : selectedGenerateData?.label
  const selectedVideoInputMode: VideoInputMode = selectedGenerateData?.videoInputMode
    ?? (composerReferences.some((reference) => reference.mediaKind === 'video') ? 'reference' : composerReferences.length === 2 ? 'first_last' : 'first_frame')
  const selectedVideoInputsValid = selectedVideoInputMode === 'reference'
    ? composerReferences.length > 0
    : selectedVideoInputMode === 'first_frame'
      ? composerReferences.length === 1 && composerReferences[0]?.mediaKind !== 'video'
      : composerReferences.length === 2 && composerReferences.every((reference) => reference.mediaKind !== 'video')
  const composerReferenceCount = composerReferences.length
  const composerPrimaryReferenceName = selectedGenerateParent?.type === 'result'
    ? ((selectedGenerateParent.data as ResultNodeData).label ?? '上游输出')
    : (selectedGeneratePrimaryReference?.name ?? selectedGenerateParentReference?.name)
  const composerContext: ComposerContext | undefined = selectedGenerateData
    ? {
        kind: 'generate',
        label: `节点 · ${selectedGenerateLabel}`,
        detail: `已连 ${composerReferences.length} 图 · ${selectedGenerateTextCount} 文${selectedGenerateParent ? ' · 继承上游输出' : ''}`,
      }
    : undefined
  const composerHint = generationError
    ?? (selectedGenerateData
      ? (composerReferences.length
        ? `正在编辑「${selectedGenerateLabel}」；已连 ${composerReferences.length} 个素材、${selectedGenerateTextCount} 条描述。`
        : `正在编辑「${selectedGenerateLabel}」；请把素材或文本连到左侧输入端。`)
      : '选择一个生成节点以编辑本次任务。')

  if (canvasHydrationFailed) {
    return (
      <main className={canvasClassName}>
        <section className="canvas-pane canvas-loading" aria-label="画布初始化失败">
          <div>
            <span className="panel-eyebrow">BOTANIC CANVAS</span>
            <strong>画布初始化失败</strong>
            <p>请重试；若仍失败，请退出后重新登录。</p>
            <button type="button" onClick={hydrateCanvas}>重试</button>
          </div>
        </section>
      </main>
    )
  }

  if (!hydrated || workspaceRestoring || workspaceDocumentMismatch) {
    return (
      <main className={canvasClassName}>
        <section className="canvas-pane canvas-loading canvas-loading--restoring" aria-label="正在加载画布">
          <DeferredWorkspaceIndicator />
        </section>
      </main>
    )
  }

  if (workspaceView === 'dashboard') {
    return <Suspense fallback={<WorkspaceViewLoading />}><OperatingDashboard onOpenProjects={() => setWorkspaceView('projects')} /></Suspense>
  }

  if (workspaceView === 'projects') {
    return (
      <Suspense fallback={<WorkspaceViewLoading />}><ProjectLibrary
        projects={workspaceProjects}
        currentUser={currentUser}
        loading={workspaceProjectsLoading}
        loadError={workspaceProjectsError}
        onBack={() => setWorkspaceView('dashboard')}
        onSignOut={onSignOut}
        onChangePassword={updateProductPassword}
        onReadMfaStatus={readProductMfaStatus}
        onEnrollMfa={enrollProductMfa}
        onVerifyMfa={verifyProductMfa}
        onRemoveMfa={removeProductMfa}
        onSignOutOtherSessions={signOutOtherProductSessions}
        onListMembers={listWorkspaceMembers}
        onListAuditEvents={listWorkspaceAuditEvents}
        onInviteMember={inviteWorkspaceMember}
        onUpdateMember={updateWorkspaceMember}
        onOpenProject={openWorkspaceProject}
        onCreateProject={createWorkspaceProject}
        onRenameProject={renameWorkspaceProject}
        onDeleteProject={deleteWorkspaceProject}
        onRetry={() => void refreshWorkspaceProjects()}
      /></Suspense>
    )
  }

  return (
    <main className={canvasClassName}>
      <section
        ref={canvasPaneRef}
        className={[
          'canvas-pane',
          isCanvasFileDragging ? 'is-file-dragging' : '',
          viewportRestoring ? 'is-restoring-viewport' : '',
          isTouchTablet ? 'is-touch-tablet' : '',
          assetsOpen ? 'has-asset-library' : '',
          composerOpen || resultComposerDraft || batchComposerTargetId ? 'has-open-composer' : '',
        ].filter(Boolean).join(' ')}
        aria-label={document.name.endsWith('画布') ? document.name : `${document.name}画布`}
        onDragEnter={onCanvasFileDragEnter}
        onDragLeave={onCanvasFileDragLeave}
        onDragOverCapture={(event) => {
          if (!isFlowDropTarget(event.target)) return
          onCanvasDragOver(event)
        }}
        onDropCapture={(event) => {
          if (!isFlowDropTarget(event.target)) return
          event.stopPropagation()
          onCanvasDrop(event)
        }}
      >
        <header className="tab-bar" data-node-id="894:230346">
          <button className="home-tab" onClick={() => { void refreshWorkspaceProjects(); setWorkspaceView('projects') }} aria-label="返回项目"><HomeIcon /> <span>项目</span></button>
          <span className="tab-divider" />
          <nav className="project-tabs" aria-label="已打开项目">
            {workspaceTabs.map((project) => {
              const active = project.id === document.id
              return (
                <div className={active ? 'project-tab is-active' : 'project-tab'} key={project.id}>
                  {renamingProjectTabId === project.id ? (
                    <div className="project-tab__main project-tab__main--editing">
                      <i />
                      <input
                        autoFocus
                        value={projectTabNameDraft}
                        aria-label="项目名称"
                        onChange={(event) => setProjectTabNameDraft(event.target.value)}
                        onBlur={() => { void commitProjectTabRename(project) }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') event.currentTarget.blur()
                          if (event.key === 'Escape') setRenamingProjectTabId(null)
                        }}
                      />
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="project-tab__main"
                      aria-current={active ? 'page' : undefined}
                      aria-label={`打开${project.name}`}
                      title={active ? '双击重命名' : undefined}
                      onClick={() => { if (!active) void openWorkspaceProject(project.id) }}
                      onDoubleClick={() => { if (active) beginProjectTabRename(project) }}
                    >
                      <i />
                      <strong>{project.name}</strong>
                    </button>
                  )}
                  <button
                    type="button"
                    className="project-tab__close"
                    onClick={() => closeWorkspaceTab(project.id)}
                    disabled={Boolean(closingWorkspaceTabId)}
                    aria-label={`关闭${project.name}`}
                    title="关闭标签"
                  >
                    <CloseIcon />
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
          edges={renderedEdges}
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
          onNodeDragStop={persistDraggedNodes}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onReconnect={onReconnect}
          onEdgeClick={selectEdgeActions}
          onConnectStart={() => {
            setConnectionFeedback(null)
            setIsConnecting(true)
          }}
          onConnectEnd={(_, connectionState) => {
            setIsConnecting(false)
            setConnectionFeedback(connectionState.isValid ? 'connected' : connectionState.toNode ? 'invalid' : 'cancelled')
          }}
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
          }}
          onNodeDoubleClick={(event, node) => {
            const isResult = node.type === 'result'
            const isAsset = node.type === 'asset'
            if (!isResult && !isAsset) return
            const imageNode = node.data as ResultNodeData | AssetNodeData
            if (!imageNode.image) return
            event.preventDefault()
            event.stopPropagation()
            setImagePreview({
              image: imageNode.image,
              name: isResult
                ? (imageNode as ResultNodeData).label ?? '生成结果'
                : (imageNode as AssetNodeData).name,
              mediaKind: imageNode.mediaKind ?? 'image',
            })
          }}
          onPaneClick={() => {
            selectNode(null)
            setIsConnecting(false)
            setSelectedEdgeId(null)
            setEdgeActionPosition(null)
            setNodeInspectorOpen(false)
            setComposerOpen(false)
            setResultComposerDraft(null)
            setBatchComposerTargetId(null)
            setNodePalette(null)
          }}
          onDoubleClick={(event) => {
            if ((event.target as Element).closest('.react-flow__pane')) openNodePalette(event)
          }}
          onMove={onCanvasMove}
          onMoveEnd={onMoveEnd}
          proOptions={{ hideAttribution: true }}
          className={`botanic-flow semantic-zoom--${zoomMode}${hasLineageFocus ? ' has-lineage-focus' : ''}${isConnecting ? ' is-connecting' : ''}${selectedCanvasNodes.length > 1 ? ' has-multi-selection' : ''}`}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#d7ddd3" />
          {miniMapOpen && document.nodes.length > 2 ? <MiniMap<CanvasNode>
            id="canvas-minimap"
            className="canvas-minimap nopan nowheel"
            nodeColor={miniMapNodeColor}
            nodeStrokeColor={(node) => node.selected ? '#1f5d38' : 'rgba(255, 255, 255, 0.84)'}
            nodeStrokeWidth={3}
            nodeBorderRadius={5}
            bgColor="rgba(250, 252, 249, 0.96)"
            maskColor="rgba(234, 241, 234, 0.58)"
            maskStrokeColor="#3f7650"
            maskStrokeWidth={1.5}
            pannable
            zoomable
            ariaLabel="画布导航地图"
          /> : null}
          {!document.nodes.length ? (
            <Panel position="top-left" className="empty-canvas-guide-panel">
              <EmptyCanvasGuide
                onOpenAssets={() => { closeWorkbenchPanels(); setAssetsOpen(true) }}
                onAddImage={() => {
                  addGenerateNode({ x: 460, y: 330 }, 'image')
                  showComposer()
                }}
                onAddVideo={() => {
                  if (!availableModels.some((model) => model.mediaKind === 'video')) {
                    useCanvasStore.setState({ assistantMessage: '视频模型尚未配置，请先检查 MiniMax H3。' })
                    return
                  }
                  addGenerateNode({ x: 460, y: 330 }, 'video')
                  showComposer()
                }}
              />
            </Panel>
          ) : null}
          <CanvasDropBridge onReady={setScreenToFlowPosition} />
          <Panel position="top-left" className="task-flow-focus-panel"><TaskFlowFocus taskKey={latestTaskKey} nodes={latestTaskNodes} /></Panel>
          {historyFocusRequest ? <FocusCanvasNode
            node={renderedNodes.find((node) => node.id === historyFocusRequest.nodeId)}
            requestId={historyFocusRequest.requestId}
          /> : null}

          {multiSelectionPresence.present && visibleMultiSelectionCount ? <MultiSelectionToolbar count={visibleMultiSelectionCount} phase={multiSelectionPresence.phase} onClear={() => { selectNode(null); setComposerOpen(false) }} /> : null}
          {isConnecting || connectionFeedback ? <ConnectionGuide feedback={isConnecting ? null : connectionFeedback} /> : null}

          <Panel position="top-left" className="dock-panel">
            <nav className="dock" aria-label="画布工具">
              <button className="dock__add" onClick={(event) => openNodePalette(event, true)} aria-label="新增节点"><FigmaIcon src={plusIcon} /></button>
              <button className={assetsOpen ? 'dock__button is-active' : 'dock__button'} onClick={() => { closeWorkbenchPanels(); setAssetsOpen(true) }} aria-label="打开素材库"><FigmaIcon src={folderIcon} /></button>
              <button className={templatesOpen ? 'dock__button is-active' : 'dock__button'} onClick={() => { closeWorkbenchPanels(); setTemplatesOpen(true) }} aria-label="模板"><FigmaIcon src={templatesIcon} /></button>
              <button className={historyOpen ? 'dock__button is-active' : 'dock__button'} onClick={() => { closeWorkbenchPanels(); setHistoryOpen(true) }} aria-label="画布历史"><FigmaIcon src={historyIcon} /></button>
              <button className={deliveryOpen ? 'dock__button dock__button--delivery is-active' : 'dock__button dock__button--delivery'} onClick={() => { closeWorkbenchPanels(); setDeliveryOpen(true) }} aria-label="投放交付"><ArrowUpRightIcon /></button>
              <button ref={accountTriggerRef} className={accountMenuAnchor ? 'dock__account is-active' : 'dock__account'} aria-label="打开账户设置" aria-expanded={Boolean(accountMenuAnchor)} onClick={(event) => {
                if (accountMenuAnchor) {
                  setAccountMenuAnchor(null)
                  return
                }
                const rect = event.currentTarget.getBoundingClientRect()
                setAccountMenuAnchor({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })
              }}>
                <img src="/botanique-logo.png" alt="" />
              </button>
            </nav>
          </Panel>

          <CanvasNavigation
            taskNodes={latestTaskNodes}
            selectedNodes={selectedCanvasNodes}
            miniMapOpen={miniMapOpen && document.nodes.length > 2}
            canShowMiniMap={document.nodes.length > 2}
            marqueeMode={marqueeMode}
            touchInput={isTouchTablet}
            onToggleMiniMap={() => setMiniMapOpen((open) => !open)}
            onToggleMarqueeMode={() => setMarqueeMode((active) => !active)}
            onAutoLayout={autoLayoutCanvas}
            onViewportChange={persistViewport}
          />
          <RestoreCanvasViewport
            enabled={hydrated}
            canvasKey={document.id}
            viewport={restoredViewport}
            onRestored={completeViewportRestore}
          />
        </ReactFlow>

        {!agentOpen ? <button ref={agentLauncherRef} type="button" className="agent-launcher" onClick={() => {
          const sessionId = ensureAgentSession(selectedFocusNodeIds)
          const session = useCanvasStore.getState().document.agentSessions.find((item) => item.id === sessionId)
          if (selectedFocusNodeIds.length) setAgentSessionContext(sessionId, [...(session?.contextNodeIds ?? []), ...selectedFocusNodeIds])
          setAgentTargetResultId(selectedReadyResultData ? selectedResult!.id : null)
          setAgentOpen(true)
        }} aria-label="打开生图 Agent" title="Agent"><SparkleIcon /></button> : null}

        {agentOpen ? <AgentWorkspace
          projectId={document.id}
          target={agentTarget}
          groups={document.assetGroups}
          sessions={document.agentSessions}
          session={activeAgentSession}
          contextOptions={agentContextOptions}
          memory={document.agentMemory}
          artifacts={agentArtifacts}
          latestRun={latestAgentRun}
          runs={document.agentRuns}
          plannerModels={agentPlannerModels}
          onConfirm={confirmAgentPlan}
          onConfirmAction={confirmAgentAction}
          onCreateDraft={createAgentWorkflowDraft}
          onAppendMessage={appendAgentMessage}
          onUpdateMessage={updateAgentMessage}
          onUpdateAction={updateAgentAction}
          onContextChange={setAgentSessionContext}
          onExecutionModeChange={setAgentSessionExecutionMode}
          onAddMemory={addAgentMemory}
          onRemoveMemory={removeAgentMemory}
          onNewSession={() => {
            const nextSessionId = startNewAgentSession(selectedFocusNodeIds)
            setAgentTargetResultId(selectedReadyResultData ? selectedResult!.id : null)
            return nextSessionId
          }}
          onSelectSession={(sessionId) => {
            setActiveAgentSession(sessionId)
            const nextSession = document.agentSessions.find((session) => session.id === sessionId)
            const nextResultId = nextSession?.contextNodeIds.find((nodeId) => document.nodes.some((node) => {
              if (node.id !== nodeId || node.type !== 'result') return false
              const result = node.data as ResultNodeData
              return Boolean(result.image) && canUseForImageDelivery(result.mediaKind)
            }))
            setAgentTargetResultId(nextResultId ?? null)
          }}
          onRetryBranch={(runId, branchId) => retryAgentBranch(runId, branchId)}
          onCancelRun={(runId) => cancelAgentRun(runId)}
          onLocateNode={selectNode}
          onSaveArtifact={(artifact) => {
            if (!artifact.url || (artifact.kind !== 'image' && artifact.kind !== 'video')) return
            saveGeneratedImageToLibrary({ image: artifact.url, name: artifact.label, mediaKind: artifact.kind })
          }}
          onUseResultContext={(sourceNodeIds) => {
            const currentDocument = useCanvasStore.getState().document
            const sessionId = currentDocument.activeAgentSessionId ?? ensureAgentSession(sourceNodeIds)
            const currentSession = useCanvasStore.getState().document.agentSessions.find((item) => item.id === sessionId)
            setAgentSessionContext(sessionId, [...(currentSession?.contextNodeIds ?? []), ...sourceNodeIds])
            const resultNodeId = sourceNodeIds.find((nodeId) => useCanvasStore.getState().document.nodes.some((node) => node.id === nodeId && node.type === 'result'))
            setAgentTargetResultId(resultNodeId ?? null)
            if (resultNodeId) selectNode(resultNodeId)
          }}
          onClose={() => {
            setAgentOpen(false)
            requestAnimationFrame(() => agentLauncherRef.current?.focus())
          }}
        /> : null}

        {composerOpen && selectedGenerate && selectedGenerateData && !resultComposerDraft ? (
          <CanvasComposer
            key={`generate-${selectedGenerate.id}`}
            projectId={document.id}
            mode="generate"
            nodeLabel={selectedGenerateLabel ?? selectedGenerateData.label}
            prompt={selectedGenerateData.prompt}
            batchCount={selectedGenerateData.batchCount}
            maximumBatchCount={maximumBatchCount}
            settings={selectedGenerateData.settings}
            models={availableModels}
            references={composerReferences}
            status={generationStatus}
            error={generationError ?? undefined}
            canGenerate={selectedGenerateIsVideo ? selectedVideoInputsValid : Boolean(composerPrimaryReferenceName)}
            videoInputMode={selectedVideoInputMode}
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
            onVideoInputModeChange={(videoInputMode) => {
              updateGenerateNode(selectedGenerate.id, { videoInputMode })
              clearGenerationError()
            }}
            onOpenReferences={() => {
              setNodeReferencesOpen(false)
              setAssetLibraryTargetGenerateId(selectedGenerate.id)
              setAssetsOpen(true)
            }}
            onOpenAssets={() => {
              setAssetLibraryTargetGenerateId(selectedGenerate.id)
              setAssetsOpen(true)
            }}
            onGenerate={() => {
              void runGraphGeneration(selectedGenerate.id).then((started) => {
                if (started) {
                  setComposerOpen(false)
                  setAssetLibraryTargetGenerateId(null)
                }
              })
            }}
            onClose={() => {
              setComposerOpen(false)
              setAssetLibraryTargetGenerateId(null)
            }}
          />
        ) : null}

        {resultComposerDraft && resultComposerTarget ? (
          <CanvasComposer
            key={`result-${resultComposerTarget.nodeId}`}
            projectId={document.id}
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
              mediaKind: resultComposerTarget.mediaKind,
            }]}
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
            refinementMode={resultComposerDraft.refinementMode}
            onRefinementModeChange={(refinementMode) => {
              setResultComposerDraft((current) => current ? { ...current, refinementMode } : current)
            }}
            onGenerate={() => {
              const draft = resultComposerDraft
              if (resultComposerSubmissionRef.current || !draft || !draft.prompt.trim()) return
              resultComposerSubmissionRef.current = true
              const branchId = createGenerateBranchFromResult(draft.resultNodeId, {
                prompt: draft.prompt.trim(),
                batchCount: draft.batchCount,
                settings: draft.settings,
                refinementMode: draft.refinementMode,
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

        {batchComposerTarget ? <BatchVariationComposer
          key={batchComposerTarget.id}
          target={batchComposerTarget}
          groups={document.assetGroups}
          assets={assetLibraryAssets}
          models={availableModels}
          maximumCandidates={maximumBatchCount}
          busy={generationStatus === 'uploading' || generationStatus === 'queued' || generationStatus === 'running'}
          onOpenAssets={() => {
            setBatchComposerTargetId(null)
            setAssetsOpen(true)
          }}
          onSubmit={(request) => {
            void runBatchVariation({ sourceResultNodeId: batchComposerTarget.id, ...request }).then((started) => {
              if (started) setBatchComposerTargetId(null)
            })
          }}
          onClose={() => setBatchComposerTargetId(null)}
        /> : null}

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

        {canvasDropPresence.present ? (
          <div className={`canvas-file-drop is-${canvasDropPresence.phase}`} aria-hidden="true">
            <span>图片素材</span>
            <strong>松开即可加入画布</strong>
            <small>PNG / JPEG / WebP，单张不超过 8MB</small>
          </div>
        ) : null}
        {canvasUploadMessage ? <div className="canvas-upload-message" role="status">{canvasUploadMessage}</div> : null}
        {nodePalettePresence.present && visibleNodePalette ? (
          <div className={`node-palette is-${nodePalettePresence.phase}`} style={{ left: visibleNodePalette.screen.x, top: visibleNodePalette.screen.y }} role="dialog" aria-label="添加画布节点" aria-hidden={nodePalettePresence.phase === 'exit' ? true : undefined} onPointerDown={(event) => event.stopPropagation()}>
            <div className="node-palette__title"><span>{visibleNodePalette.parentResultId ? '基于此图添加' : visibleNodePalette.inputNodeId ? '连接所选节点' : '添加节点'}</span><button onClick={() => setNodePalette(null)} aria-label="关闭添加节点"><CloseIcon /></button></div>
            <button onClick={() => { addTextNode(visibleNodePalette.flow); setNodePalette(null) }}>
              <b>T</b><span><strong>描述</strong><small>补充画面、卖点或构图</small></span>
            </button>
            <button onClick={() => {
              const parentNode = visibleNodePalette.parentResultId
                ? document.nodes.find((node) => node.id === visibleNodePalette.parentResultId && node.type === 'result')
                : undefined
              const parentMediaKind = parentNode?.type === 'result' ? (parentNode.data as ResultNodeData).mediaKind ?? 'image' : 'image'
              const imageModel = availableModels.find((model) => (model.mediaKind ?? 'image') === 'image')
              const imageSettings = parentMediaKind === 'video' && imageModel
                ? settingsForModel({
                    model: imageModel.id,
                    aspectRatio: '3:4',
                    resolution: '2K',
                  }, imageModel)
                : undefined
              const branchId = visibleNodePalette.parentResultId
                ? createGenerateBranchFromResult(visibleNodePalette.parentResultId, imageSettings ? { settings: imageSettings } : undefined)
                : null
              if (!visibleNodePalette.parentResultId) addGenerateNode(visibleNodePalette.flow, 'image', visibleNodePalette.inputNodeId ? [visibleNodePalette.inputNodeId] : undefined)
              if (!visibleNodePalette.parentResultId || branchId) showComposer()
              setNodePalette(null)
            }}>
              <b><SparkleIcon /></b><span><strong>图片生成</strong><small>{visibleNodePalette.parentResultId ? '基于当前图片继续创作' : '连接素材与描述生成图片'}</small></span>
            </button>
            {visibleNodePalette.parentResultId ? <button onClick={() => {
              setBatchComposerTargetId(visibleNodePalette.parentResultId ?? null)
              setNodePalette(null)
            }}>
              <b>×N</b><span><strong>批量变体</strong><small>用一个素材组逐项生成</small></span>
            </button> : null}
            <button onClick={() => {
              const videoModel = availableModels.find((model) => model.mediaKind === 'video')
              if (!videoModel) {
                setNodePalette(null)
                useCanvasStore.setState({ assistantMessage: '视频模型尚未配置，请先检查 MiniMax H3。' })
                return
              }
              const videoSettings = settingsForModel({
                model: videoModel.id,
                aspectRatio: '3:4',
                resolution: '2K',
              }, videoModel)
              const parentNode = visibleNodePalette.parentResultId
                ? document.nodes.find((node) => node.id === visibleNodePalette.parentResultId && node.type === 'result')
                : undefined
              const branchId = visibleNodePalette.parentResultId
                ? createGenerateBranchFromResult(visibleNodePalette.parentResultId, { settings: videoSettings })
                : null
              if (branchId) {
                const parentMediaKind = parentNode?.type === 'result' ? (parentNode.data as ResultNodeData).mediaKind ?? 'image' : 'image'
                updateGenerateNode(branchId, {
                  settings: videoSettings,
                  videoInputMode: parentMediaKind === 'video' ? 'reference' : 'first_frame',
                })
              } else if (!visibleNodePalette.parentResultId) {
                addGenerateNode(visibleNodePalette.flow, 'video', visibleNodePalette.inputNodeId ? [visibleNodePalette.inputNodeId] : undefined)
              }
              if (!visibleNodePalette.parentResultId || branchId) showComposer()
              setNodePalette(null)
            }}>
              <b className="node-palette__video-icon">▶</b><span><strong>视频生成</strong><small>{visibleNodePalette.parentResultId ? '以当前画面或视频继续生成' : '连接首帧、首尾帧或参考素材'}</small></span>
            </button>
            <button onClick={() => { setNodePalette(null); setAssetsOpen(true) }}>
              <b><FolderOutlineIcon /></b><span><strong>素材</strong><small>添加商品、场景或调性图</small></span>
            </button>
            <div className="node-palette__upload"><span>本地图片</span><button onClick={() => nodeFileInputRef.current?.click()}><UploadIcon />上传图片</button></div>
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
            groups={document.assetGroups}
            onAdd={addAssetFromLibrary}
            onUpload={addUploadedAssets}
            onMoveToRole={moveAssetToRole}
            onCreateGroup={createAssetGroup}
            onRenameGroup={renameAssetGroup}
            onDeleteGroup={deleteAssetGroup}
            onAddAssetsToGroup={addAssetsToGroup}
            onDelete={setAssetToDelete}
            onClose={() => {
              setAssetsOpen(false)
              setAssetLibraryTargetGenerateId(null)
            }}
          />
        </CanvasPanelPresence>
        <CanvasPanelPresence open={templatesOpen} side="right">
          <TemplatePanel
            templates={document.templates}
            sharedTemplates={sharedTemplates}
            currentName={document.name}
            projectSaveSummary={projectTemplateSaveSummary}
            sharedSaveSummary={sharedTemplateSaveSummary}
            onSave={saveCurrentAsTemplate}
            onSaveShared={saveCurrentAsSharedTemplate}
            onCreateProject={createWorkspaceProjectFromTemplate}
            onRefresh={refreshSharedTemplates}
            onClose={() => setTemplatesOpen(false)}
          />
        </CanvasPanelPresence>
        <CanvasPanelPresence open={historyOpen} side="right">
          <HistoryPanel
            results={generatedHistoryItems}
            onPreview={(item) => {
              setImagePreview({ image: item.image, name: item.name, mediaKind: item.mediaKind })
            }}
            onLocate={(item) => {
              if (!item.nodeId) return
              const group = resultGroupPresentation.get(item.nodeId)
              const representativeNodeId = group
                ? [...resultGroupPresentation].find(([, presentation]) => presentation.groupId === group.groupId && presentation.representative)?.[0]
                : undefined
              selectNode(item.nodeId)
              setComposerOpen(false)
              setResultComposerDraft(null)
              setHistoryFocusRequest({ nodeId: representativeNodeId ?? item.nodeId, requestId: Date.now() })
              setHistoryOpen(false)
            }}
            onSaveToLibrary={(item) => saveGeneratedImageToLibrary({ image: item.image, name: item.name, mediaKind: item.mediaKind })}
            isSaved={(item) => document.assets.some((asset) => asset.source === 'generated' && asset.image === item.image)}
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
            target={selectedReadyResultData && selectedResult && canUseForImageDelivery(selectedReadyResultData.mediaKind) ? {
              nodeId: selectedResult.id,
              versionId: selectedReadyResultData.versionId,
              image: selectedReadyResultData.image!,
              label: selectedReadyResultData.label ?? '已选首图',
            } : undefined}
            targets={deliveryTargets}
            blockedVideo={Boolean(selectedReadyResultData && !canUseForImageDelivery(selectedReadyResultData.mediaKind))}
            deliveries={document.deliveries}
            onCreate={createLocalDeliveries}
            onSelectTarget={selectNode}
            onClose={() => setDeliveryOpen(false)}
          />
        </CanvasPanelPresence>
        {assetDeletePresence.present && visibleAssetToDelete ? (
          <ConfirmationDialog
            asset={visibleAssetToDelete}
            phase={assetDeletePresence.phase}
            onConfirm={() => {
              deleteAsset(visibleAssetToDelete.id)
              setAssetToDelete(null)
            }}
            onCancel={() => setAssetToDelete(null)}
          />
        ) : null}
        {imagePreviewPresence.present && visibleImagePreview ? (
          <div className={`image-preview-backdrop motion-overlay is-${imagePreviewPresence.phase}`} role="presentation" aria-hidden={imagePreviewPresence.phase === 'exit' ? true : undefined} onMouseDown={() => setImagePreview(null)}>
            <section className="image-preview-dialog" role="dialog" aria-modal="true" aria-label={`${visibleImagePreview.name}预览`} onMouseDown={(event) => event.stopPropagation()}>
              <button className="image-preview-dialog__download" type="button" aria-label="下载原媒体" title="下载原媒体" onClick={() => void downloadMedia(visibleImagePreview.image, visibleImagePreview.name, visibleImagePreview.mediaKind)}><DownloadIcon /></button>
              <button className="image-preview-dialog__close" type="button" onClick={() => setImagePreview(null)} aria-label="关闭媒体预览"><CloseIcon /></button>
              {visibleImagePreview.mediaKind === 'video'
                ? <video src={visibleImagePreview.image} aria-label={visibleImagePreview.name} controls playsInline preload="metadata" />
                : <img src={visibleImagePreview.image} alt={visibleImagePreview.name} />}
            </section>
          </div>
        ) : null}

        {undoPresence.present && visibleUndoAction ? <UndoToast label={visibleUndoAction.label} phase={undoPresence.phase} onUndo={undoLastAction} /> : null}
      </section>

      {accountMenuPresence.present && visibleAccountMenuAnchor ? <AccountMenu
        user={currentUser}
        anchor={visibleAccountMenuAnchor}
        phase={accountMenuPresence.phase}
        onOpenProfile={() => { setAccountMenuAnchor(null); if (currentUser) setAccountDialog('profile') }}
        onOpenSecurity={() => { setAccountMenuAnchor(null); if (currentUser) setAccountDialog('security') }}
        onOpenMembers={() => { setAccountMenuAnchor(null); if (currentUser?.role === 'owner') setAccountDialog('members') }}
        onOpenAudit={() => { setAccountMenuAnchor(null); if (currentUser?.role === 'owner') setAccountDialog('audit') }}
        onSignOut={onSignOut ? async () => { setAccountMenuAnchor(null); await onSignOut() } : undefined}
        onClose={() => setAccountMenuAnchor(null)}
      /> : null}
      {currentUser && accountDialogPresence.present && (visibleAccountDialog === 'profile' || visibleAccountDialog === 'security') ? <AccountDetailsDialog
        mode={visibleAccountDialog}
        user={currentUser}
        phase={accountDialogPresence.phase}
        returnFocusTarget={null}
        onChangePassword={updateProductPassword}
        onReadMfaStatus={readProductMfaStatus}
        onEnrollMfa={enrollProductMfa}
        onVerifyMfa={verifyProductMfa}
        onRemoveMfa={removeProductMfa}
        onSignOutOtherSessions={signOutOtherProductSessions}
        onModeChange={setAccountDialog}
        onClose={returnToAccountMenu}
      /> : null}
      {currentUser?.role === 'owner' && accountDialogPresence.present && visibleAccountDialog === 'members' ? <WorkspaceMembersDialog
        currentUser={currentUser}
        phase={accountDialogPresence.phase}
        returnFocusTarget={null}
        onListMembers={listWorkspaceMembers}
        onInviteMember={inviteWorkspaceMember}
        onUpdateMember={updateWorkspaceMember}
        onClose={returnToAccountMenu}
      /> : null}
      {currentUser?.role === 'owner' && accountDialogPresence.present && visibleAccountDialog === 'audit' ? <WorkspaceAuditDialog
        phase={accountDialogPresence.phase}
        returnFocusTarget={null}
        onListEvents={listWorkspaceAuditEvents}
        onListMembers={listWorkspaceMembers}
        onClose={returnToAccountMenu}
      /> : null}

    </main>
  )
}

type AssetLibraryProps = {
  assets: AssetRecord[]
  groups: AssetGroup[]
  onAdd: (id: string) => void
  onUpload: (assets: UploadedAssetInput[]) => void
  onMoveToRole: (id: string, role: AssetRole) => void
  onCreateGroup: (name: string, role: AssetGroup['role'], assetIds?: string[]) => string | null
  onRenameGroup: (groupId: string, name: string) => void
  onDeleteGroup: (groupId: string) => void
  onAddAssetsToGroup: (groupId: string, assetIds: string[]) => void
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
  const pathSegments = file.webkitRelativePath.split('/').filter(Boolean)
  const folderName = pathSegments[0]
  const collection = pathSegments.length > 1 ? pathSegments.slice(0, -1).join(' / ') : undefined
  return {
    name: file.name.replace(/\.[^.]+$/, ''),
    image,
    imageWidth,
    imageHeight,
    role,
    mediaKind: 'image',
    collection,
    tags: folderName ? ['上传素材', folderName] : ['上传素材'],
  }
}

function imagePreviewSize(imageWidth: number, imageHeight: number) {
  const scale = Math.min(320 / imageWidth, 340 / imageHeight, 1)
  return {
    width: Math.max(1, Math.round(imageWidth * scale)),
    height: Math.max(1, Math.round(imageHeight * scale)),
  }
}

function triggerDownload(source: string, filename: string) {
  const anchor = document.createElement('a')
  anchor.href = source
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

async function downloadMedia(image: string, name: string, mediaKind: GenerationMediaKind = 'image') {
  const safeName = name.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-').slice(0, 80) || `botanic-${mediaKind}`
  if (mediaKind === 'video') {
    // 视频直接交给浏览器流式下载，避免先把完整 MP4 读入内存后丢失用户手势。
    triggerDownload(image, `${safeName}.${mediaFileExtension(mediaKind)}`)
    return
  }
  try {
    const response = await fetch(image)
    if (!response.ok) throw new Error('图片下载失败')
    const blob = await response.blob()
    const extension = mediaFileExtension(mediaKind, blob.type)
    const objectUrl = URL.createObjectURL(blob)
    triggerDownload(objectUrl, `${safeName}.${extension}`)
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

function batchVariationDefaultPrompt(role: AssetGroup['role']) {
  if (role === '场景') return '保持父图中的人物、服装与商品主体一致，分别替换为素材组中的场景，并让光线、透视与接触关系自然融合。'
  if (role === '调性') return '保持父图中的人物、服装、商品与构图一致，分别参考素材组中的视觉风格调整色彩、光线与质感。'
  if (role === '模特') return '保持父图中的服装、商品、场景与整体构图，分别替换为素材组中的模特，并自然适配姿势与光线。'
  return '保持父图中的人物、场景与视觉风格，分别替换为素材组中的商品或服装，并保持商品结构、图案与标识清晰。'
}

function BatchVariationComposer({
  target,
  groups,
  assets,
  models,
  maximumCandidates,
  busy,
  onOpenAssets,
  onSubmit,
  onClose,
}: {
  target: { id: string; name: string; image: string; settings: GenerationSettings }
  groups: AssetGroup[]
  assets: AssetRecord[]
  models: GenerationModelOption[]
  maximumCandidates: number
  busy: boolean
  onOpenAssets: () => void
  onSubmit: (request: BatchVariationRequest) => void
  onClose: () => void
}) {
  const imageAssetIds = useMemo(() => new Set(assets.filter((asset) => (asset.mediaKind ?? 'image') === 'image').map((asset) => asset.id)), [assets])
  const availableGroups = useMemo(() => groups.map((group) => ({
    ...group,
    assetIds: group.assetIds.filter((assetId) => imageAssetIds.has(assetId)),
  })).filter((group) => group.assetIds.length), [groups, imageAssetIds])
  const [groupId, setGroupId] = useState(availableGroups[0]?.id ?? '')
  const activeGroup = availableGroups.find((group) => group.id === groupId) ?? availableGroups[0]
  const [prompt, setPrompt] = useState(() => batchVariationDefaultPrompt(availableGroups[0]?.role ?? '场景'))
  const [candidatesPerAsset, setCandidatesPerAsset] = useState(1)
  const [settings, setSettings] = useState(() => {
    const imageModel = models.find((model) => model.id === target.settings.model && (model.mediaKind ?? 'image') === 'image')
      ?? models.find((model) => (model.mediaKind ?? 'image') === 'image')
    return imageModel ? settingsForModel(target.settings, imageModel) : target.settings
  })
  const selectedModel = models.find((model) => model.id === settings.model)
  const total = (activeGroup?.assetIds.length ?? 0) * candidatesPerAsset
  const overLimit = total > 20

  useEffect(() => {
    if (groupId || !availableGroups[0]) return
    setGroupId(availableGroups[0].id)
  }, [availableGroups, groupId])

  return createPortal(
    <div className="batch-variation-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="batch-variation-composer" role="dialog" aria-modal="true" aria-label="批量变体">
        <header>
          <div><span>BATCH VARIATION</span><h2>批量变体</h2></div>
          <button type="button" onClick={onClose} aria-label="关闭批量变体"><CloseIcon /></button>
        </header>
        <div className="batch-variation-source"><img src={target.image} alt="" /><div><span>父图</span><strong>{target.name}</strong><small>新结果会形成子分支，不覆盖父图</small></div></div>
        {availableGroups.length ? <>
          <label className="batch-variation-field"><span>可变素材组</span><BotanicSelect value={activeGroup?.id ?? ''} ariaLabel="选择可变素材组" options={availableGroups.map((group) => ({ value: group.id, label: `${group.name} · ${group.assetIds.length} 个${group.role}` }))} onChange={(value) => {
            const next = availableGroups.find((group) => group.id === value)
            setGroupId(value)
            if (next) setPrompt(batchVariationDefaultPrompt(next.role))
          }} /></label>
          <div className="batch-variation-locks"><span>父图主参考</span><strong>锁定核心主体</strong><i>可变：{activeGroup?.role}</i></div>
          <label className="batch-variation-field"><span>变化说明</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} /></label>
          <div className="batch-variation-parameters">
            <label><span>模型</span><BotanicSelect value={settings.model} ariaLabel="选择批量生成模型" menuWidth={180} options={models.filter((model) => (model.mediaKind ?? 'image') === 'image').map((model) => ({ value: model.id, label: model.label }))} onChange={(value) => {
              const model = models.find((item) => item.id === value)
              if (model) setSettings((current) => settingsForModel(current, model))
            }} /></label>
            <label><span>比例</span><BotanicSelect value={settings.aspectRatio} ariaLabel="选择批量画面比例" options={(selectedModel?.aspectRatios ?? ['1:1', '3:4', '4:5', '9:16']).map((ratio) => ({ value: ratio, label: ratio }))} onChange={(value) => setSettings((current) => ({ ...current, aspectRatio: value as GenerationSettings['aspectRatio'] }))} /></label>
            <label><span>分辨率</span><BotanicSelect value={settings.resolution} ariaLabel="选择批量输出分辨率" options={(selectedModel?.resolutions ?? ['1K', '2K']).map((resolution) => ({ value: resolution, label: resolution }))} onChange={(value) => setSettings((current) => ({ ...current, resolution: value as GenerationSettings['resolution'] }))} /></label>
            <label><span>每项候选</span><input type="number" min={1} max={maximumCandidates} value={candidatesPerAsset} onChange={(event) => setCandidatesPerAsset(Math.min(maximumCandidates, Math.max(1, Math.round(Number(event.target.value)) || 1)))} /></label>
          </div>
          <footer><span className={overLimit ? 'is-error' : ''}>{activeGroup?.assetIds.length ?? 0} 个素材 × {candidatesPerAsset} = {total} 张{overLimit ? '（最多 20 张）' : ''}</span><button type="button" disabled={busy || overLimit || !prompt.trim()} onClick={() => activeGroup && onSubmit({ groupId: activeGroup.id, prompt, candidatesPerAsset, settings })}>{busy ? '已有任务运行中' : `生成 ${total} 张`}</button></footer>
        </> : <div className="batch-variation-empty"><strong>先创建一个素材组</strong><p>可在素材库上传整个文件夹，系统会自动形成素材组。</p><button type="button" onClick={onOpenAssets}>打开素材库</button></div>}
      </section>
    </div>,
    document.body,
  )
}

function AssetLibrary({
  assets,
  groups,
  onAdd,
  onUpload,
  onMoveToRole,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onAddAssetsToGroup,
  onDelete,
  onClose,
}: AssetLibraryProps) {
  const [mediaKind, setMediaKind] = useState<GenerationMediaKind>('image')
  const [role, setRole] = useState<'全部' | AssetRole>('全部')
  const [source, setSource] = useState<'全部' | AssetSource>('全部')
  const [groupId, setGroupId] = useState('全部')
  const [query, setQuery] = useState('')
  const [selectedAssetIds, setSelectedAssetIds] = useState<Set<string>>(() => new Set())
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([])
  const [isDraggingFiles, setIsDraggingFiles] = useState(false)
  const [uploadMessage, setUploadMessage] = useState('')
  const [assetMenuId, setAssetMenuId] = useState<string | null>(null)
  const [assetMenuAnchor, setAssetMenuAnchor] = useState<{ left: number; top: number; placement: 'above' | 'below' } | null>(null)
  const [previewAssetId, setPreviewAssetId] = useState<string | null>(null)
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [groupNameDraft, setGroupNameDraft] = useState('')
  const [groupRoleDraft, setGroupRoleDraft] = useState<AssetGroup['role']>('场景')
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null)
  const [groupRenameDraft, setGroupRenameDraft] = useState('')
  const [deleteGroupId, setDeleteGroupId] = useState<string | null>(null)
  const [batchGroupId, setBatchGroupId] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const assetMenuRef = useRef<HTMLDivElement>(null)
  const assetMenuTriggerRef = useRef<HTMLButtonElement | null>(null)
  const assetDropPresence = useMotionPresence(isDraggingFiles, 100)
  useRestoreFocus(Boolean(previewAssetId || assetMenuId))
  const roles: Array<'全部' | AssetRole> = ['全部', '商品', '模特', '场景', '调性']
  const stageFiles = async (files: File[]) => {
    const { accepted: imageFiles, message } = validateUploadFiles(files)
    const allowed = imageFiles.slice(0, Math.max(0, maxUploadAssets - pendingUploads.length))
    if (!allowed.length) {
      setUploadMessage(pendingUploads.length >= maxUploadAssets ? `单次最多暂存 ${maxUploadAssets} 张图片` : message || '请选择 PNG、JPEG 或 WebP 图片')
      return
    }

    const loaded = await Promise.allSettled(allowed.map(async (file, index): Promise<PendingUpload> => {
      const upload = await readUploadedAssetInput(file, '商品')
      return {
        ...upload,
        id: `pending-${Date.now()}-${index}-${file.webkitRelativePath || file.name}`,
        tagsText: upload.tags.join(', '),
      }
    }))
    const staged = loaded
      .filter((result): result is PromiseFulfilledResult<PendingUpload> => result.status === 'fulfilled')
      .map((result) => result.value)
    setPendingUploads((items) => [...items, ...staged])
    const notices = [
      message,
      imageFiles.length > allowed.length ? `已暂存 ${staged.length} 张，单次最多 ${maxUploadAssets} 张。` : '',
      loaded.length > staged.length ? `${loaded.length - staged.length} 张图片读取失败。` : '',
    ].filter(Boolean)
    setUploadMessage(notices.join(' '))
  }
  const updatePending = (id: string, patch: Partial<PendingUpload>) => {
    setPendingUploads((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item))
  }
  const savePendingUploads = () => {
    if (!pendingUploads.length) return
    onUpload(pendingUploads.map(({ name, image, imageWidth, imageHeight, role: itemRole, mediaKind, collection, tagsText }) => ({
      name,
      image,
      imageWidth,
      imageHeight,
      role: itemRole,
      mediaKind,
      collection,
      tags: tagsText.split(/[，,]/).map((tag) => tag.trim()).filter(Boolean),
    })))
    setPendingUploads([])
    setSource('upload')
    setQuery('')
    setUploadMessage('已存入本地素材库')
  }
  const deferredQuery = useDeferredValue(query)
  const mediaCounts = useMemo(() => ({
    image: assets.filter((item) => (item.mediaKind ?? 'image') === 'image').length,
    video: assets.filter((item) => item.mediaKind === 'video').length,
  }), [assets])
  const visibleGroups = useMemo(() => groups.filter((group) => group.assetIds.some((assetId) => {
    const asset = assets.find((item) => item.id === assetId)
    return asset && (asset.mediaKind ?? 'image') === mediaKind
  })), [assets, groups, mediaKind])
  const activeGroup = groups.find((group) => group.id === groupId)
  const visibleItems = useMemo(() => assets.filter((item) => {
    const matchesMediaKind = (item.mediaKind ?? 'image') === mediaKind
    const matchesRole = role === '全部' || item.role === role
    const matchesSource = source === '全部' || item.source === source
    const matchesGroup = !activeGroup || activeGroup.assetIds.includes(item.id)
    const keyword = deferredQuery.trim().toLowerCase()
    const matchesQuery = !keyword || [item.name, item.role, item.source, item.collection ?? '', ...item.tags].join(' ').toLowerCase().includes(keyword)
    return matchesMediaKind && matchesRole && matchesSource && matchesGroup && matchesQuery
  }), [activeGroup, assets, deferredQuery, mediaKind, role, source])
  const previewAsset = assets.find((item) => item.id === previewAssetId) ?? null
  const assetMenuAsset = assets.find((item) => item.id === assetMenuId) ?? null
  const previewPresence = useMotionPresence(Boolean(previewAsset), 140)
  const visiblePreviewAsset = useRetainedValue(previewAsset)
  const activeFilterCount = Number(role !== '全部') + Number(source !== '全部') + Number(groupId !== '全部')
  const advancedFilterCount = Number(source !== '全部')
  const sourceLabel = (itemSource: AssetSource) => itemSource === 'brand' ? '共享品牌' : itemSource === 'upload' ? '本地上传' : '生成入库'
  const assetMenuPosition = (trigger: HTMLButtonElement) => {
    const rect = trigger.getBoundingClientRect()
    const width = 260
    const estimatedHeight = Math.min(360, 190 + groups.length * 36)
    const opensAbove = window.innerHeight - rect.bottom < estimatedHeight + 16 && rect.top > estimatedHeight
    return {
      left: Math.max(12, Math.min(window.innerWidth - width - 12, rect.right - width)),
      top: opensAbove
        ? Math.max(12, rect.top - estimatedHeight - 8)
        : Math.max(12, Math.min(window.innerHeight - estimatedHeight - 12, rect.bottom + 8)),
      placement: opensAbove ? 'above' as const : 'below' as const,
    }
  }

  useEffect(() => {
    if (!previewAsset) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewAssetId(null)
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [previewAsset])

  useEffect(() => {
    if (!assetMenuId) return
    let positionFrame = 0
    const closeMenu = (event: PointerEvent) => {
      const target = event.target as Node
      if (assetMenuRef.current?.contains(target) || assetMenuTriggerRef.current?.contains(target)) return
      setAssetMenuId(null)
      setAssetMenuAnchor(null)
    }
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setAssetMenuId(null)
      setAssetMenuAnchor(null)
      assetMenuTriggerRef.current?.focus()
    }
    const syncMenuPosition = () => {
      window.cancelAnimationFrame(positionFrame)
      positionFrame = window.requestAnimationFrame(() => {
        const trigger = assetMenuTriggerRef.current
        if (!trigger?.isConnected) {
          setAssetMenuId(null)
          setAssetMenuAnchor(null)
          return
        }
        setAssetMenuAnchor(assetMenuPosition(trigger))
      })
    }
    document.addEventListener('pointerdown', closeMenu)
    document.addEventListener('keydown', closeOnKey)
    window.addEventListener('resize', syncMenuPosition)
    window.addEventListener('scroll', syncMenuPosition, true)
    return () => {
      window.cancelAnimationFrame(positionFrame)
      document.removeEventListener('pointerdown', closeMenu)
      document.removeEventListener('keydown', closeOnKey)
      window.removeEventListener('resize', syncMenuPosition)
      window.removeEventListener('scroll', syncMenuPosition, true)
    }
  }, [assetMenuId, groups.length])

  const openAssetMenu = (assetId: string, trigger: HTMLButtonElement) => {
    if (assetMenuId === assetId) {
      setAssetMenuId(null)
      setAssetMenuAnchor(null)
      return
    }
    assetMenuTriggerRef.current = trigger
    setAssetMenuAnchor(assetMenuPosition(trigger))
    setAssetMenuId(assetId)
  }

  return (
    <aside
      className={`${pendingUploads.length ? 'asset-library has-pending-uploads' : 'asset-library'}${isDraggingFiles ? ' is-dragging-files' : ''}`}
      aria-label="素材库"
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('Files')) return
        event.preventDefault()
        setIsDraggingFiles(true)
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setIsDraggingFiles(false)
      }}
      onDrop={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('Files')) return
        event.preventDefault()
        setIsDraggingFiles(false)
        void stageFiles(Array.from(event.dataTransfer.files))
      }}
    >
      <div className="asset-library__header">
        <div>
          <h2>素材库</h2>
        </div>
        <div className="asset-library__header-actions">
          <details className="asset-upload-menu">
            <summary aria-label="上传素材"><UploadIcon />上传</summary>
            <div>
              <button type="button" onClick={(event) => {
                fileInputRef.current?.click()
                event.currentTarget.closest('details')?.removeAttribute('open')
              }}>
                <strong>上传图片</strong>
                <span>最多 {maxUploadAssets} 张</span>
              </button>
              <button type="button" onClick={(event) => {
                folderInputRef.current?.click()
                event.currentTarget.closest('details')?.removeAttribute('open')
              }}>
                <strong>上传文件夹</strong>
                <span>递归读取图片</span>
              </button>
            </div>
          </details>
          <button className="close-panel" onClick={onClose} aria-label="关闭素材库"><CloseIcon /></button>
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
      <input
        ref={folderInputRef}
        className="asset-file-input"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        aria-label="批量上传图片文件夹"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? [])
          event.currentTarget.value = ''
          void stageFiles(files)
        }}
      />
      {assetDropPresence.present ? <div className={`asset-drop-overlay is-${assetDropPresence.phase}`}><UploadIcon /><strong>松开以上传</strong><span>PNG、JPEG、WebP</span></div> : null}
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
                    <BotanicSelect value={item.role} onChange={(value) => updatePending(item.id, { role: value as UploadedAssetInput['role'] })} ariaLabel={`${item.name} 的角色`} options={uploadRoles.map((itemRole) => ({ value: itemRole, label: itemRole }))} />
                    <input value={item.tagsText} onChange={(event) => updatePending(item.id, { tagsText: event.target.value })} placeholder="标签，用逗号分隔" aria-label={`${item.name} 的标签`} />
                  </div>
                </div>
                <button className="upload-staging__remove" onClick={() => setPendingUploads((items) => items.filter((pending) => pending.id !== item.id))} aria-label={`移除待上传素材 ${item.name}`}><DeleteIcon /></button>
              </article>
            ))}
          </div>
          <div className="upload-staging__footer">
            <span>确认后可拖入画布</span>
            <button onClick={savePendingUploads}>入库 {pendingUploads.length} 张</button>
          </div>
        </section>
      ) : null}
      <div className="asset-library__media-tabs" role="tablist" aria-label="素材媒体类型">
        {(['image', 'video'] as const).map((kind) => (
          <button
            type="button"
            role="tab"
            aria-selected={mediaKind === kind}
            className={mediaKind === kind ? 'is-active' : ''}
            key={kind}
            onClick={() => {
              setMediaKind(kind)
              setGroupId('全部')
              setSelectedAssetIds(new Set())
            }}
          >{kind === 'image' ? '图片' : '视频'} <span>{mediaCounts[kind]}</span></button>
        ))}
      </div>
      <div className="asset-library__toolbar">
        <input className="asset-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索素材或标签" aria-label="搜索素材" />
        <details className="asset-filter-popover">
          <summary aria-label={`筛选素材来源${advancedFilterCount ? `，已启用 ${advancedFilterCount} 项` : ''}`}>
            来源{advancedFilterCount ? <i>{advancedFilterCount}</i> : null}
          </summary>
          <div className="asset-filter-popover__panel">
            <section>
              <span>素材来源</span>
              <div className="asset-filter-options asset-filter-options--source" role="group" aria-label="素材来源">
                {(['全部', 'brand', 'upload', 'generated'] as const).map((item) => (
                  <button type="button" key={item} className={source === item ? 'is-active' : ''} aria-pressed={source === item} onClick={() => setSource(item)}>
                    {item === '全部' ? '全部' : sourceLabel(item)}
                  </button>
                ))}
              </div>
            </section>
            {advancedFilterCount ? <button className="asset-filter-popover__reset" type="button" onClick={() => setSource('全部')}>清除来源筛选</button> : null}
          </div>
        </details>
      </div>
      <section className="asset-library__facet" aria-labelledby="asset-role-heading">
        <div className="asset-library__section-heading"><strong id="asset-role-heading">素材类型</strong></div>
        <div className="asset-library__role-tabs" role="group" aria-label="素材类型">
          {roles.map((item) => (
            <button type="button" key={item} className={role === item ? 'is-active' : ''} aria-pressed={role === item} onClick={() => setRole(item)}>{item}</button>
          ))}
        </div>
      </section>
      <section className="asset-library__facet asset-library__groups" aria-labelledby="asset-group-heading">
        <div className="asset-library__section-heading">
          <strong id="asset-group-heading">素材组</strong>
          <button className="asset-group-create-button" type="button" onClick={() => {
            setGroupRoleDraft(role === '全部' || role === '首图' ? '场景' : role)
            setCreatingGroup(true)
          }}><PlusSquareIcon />新建</button>
        </div>
        <div className="asset-library__collections" aria-label="素材组">
          <button type="button" className={groupId === '全部' ? 'is-active' : ''} onClick={() => setGroupId('全部')}>全部</button>
          {visibleGroups.map((group) => <button type="button" key={group.id} className={groupId === group.id ? 'is-active' : ''} onClick={() => setGroupId(group.id)}>{group.name} · {group.assetIds.length}</button>)}
          {!visibleGroups.length ? <span>暂无素材组</span> : null}
        </div>
        {creatingGroup ? (
          <form className="asset-group-create" onSubmit={(event) => {
            event.preventDefault()
            const createdId = onCreateGroup(groupNameDraft, groupRoleDraft, [...selectedAssetIds])
            if (!createdId) return
            setGroupId(createdId)
            setBatchGroupId(createdId)
            setGroupNameDraft('')
            setCreatingGroup(false)
            setSelectedAssetIds(new Set())
          }}>
            <input autoFocus value={groupNameDraft} onChange={(event) => setGroupNameDraft(event.target.value)} placeholder="素材组名称" aria-label="素材组名称" />
            <BotanicSelect value={groupRoleDraft} onChange={(value) => setGroupRoleDraft(value as AssetGroup['role'])} ariaLabel="素材组类型" options={uploadRoles.map((itemRole) => ({ value: itemRole, label: itemRole }))} />
            <div className="asset-group-create__actions">
              <button type="button" onClick={() => { setCreatingGroup(false); setGroupNameDraft('') }}>取消</button>
              <button type="submit" disabled={!groupNameDraft.trim()}>创建{selectedAssetIds.size ? `并加入 ${selectedAssetIds.size} 项` : ''}</button>
            </div>
          </form>
        ) : null}
      </section>
      {activeGroup ? (
        <div className="asset-group-toolbar">
          {renamingGroupId === activeGroup.id ? (
            <form onSubmit={(event) => {
              event.preventDefault()
              if (!groupRenameDraft.trim()) return
              onRenameGroup(activeGroup.id, groupRenameDraft)
              setRenamingGroupId(null)
            }}>
              <input autoFocus value={groupRenameDraft} onChange={(event) => setGroupRenameDraft(event.target.value)} aria-label="重命名素材组" />
              <div className="asset-group-toolbar__actions">
                <button type="button" onClick={() => setRenamingGroupId(null)}>取消</button>
                <button type="submit">保存</button>
              </div>
            </form>
          ) : deleteGroupId === activeGroup.id ? (
            <>
              <strong>{activeGroup.name}</strong>
              <span>素材仍会保留</span>
              <div className="asset-group-toolbar__actions">
                <button type="button" onClick={() => setDeleteGroupId(null)}>取消</button>
                <button type="button" className="is-danger" onClick={() => { onDeleteGroup(activeGroup.id); setGroupId('全部'); setDeleteGroupId(null) }}>确认删除</button>
              </div>
            </>
          ) : (
            <>
              <strong>{activeGroup.name}</strong>
              <div className="asset-group-toolbar__actions">
                <button type="button" onClick={() => { setRenamingGroupId(activeGroup.id); setGroupRenameDraft(activeGroup.name) }}>重命名</button>
                <button type="button" className="is-danger" onClick={() => setDeleteGroupId(activeGroup.id)}>删除组</button>
              </div>
            </>
          )}
        </div>
      ) : null}
      <div className="asset-library__results"><strong>{activeFilterCount || query ? '筛选结果' : '全部素材'}</strong><span>{visibleItems.length} 项</span></div>
      <div className="asset-grid">
        {visibleItems.length ? visibleItems.map((item) => (
          <article
            className={['asset-card', assetMenuId === item.id ? 'is-menu-open' : '', selectedAssetIds.has(item.id) ? 'is-selected' : '', item.mediaKind === 'video' ? 'asset-card--video' : ''].filter(Boolean).join(' ')}
            key={item.id}
            draggable
            tabIndex={0}
            title="点击预览，或拖拽到画布"
            onClick={() => setPreviewAssetId(item.id)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              setPreviewAssetId(item.id)
            }}
            onDragStart={(event) => {
              event.dataTransfer.setData('text/plain', item.id)
              event.dataTransfer.setData('application/x-botanic-asset-id', item.id)
              event.dataTransfer.effectAllowed = 'copy'
            }}
          >
            <div className="asset-card__visual">
              {item.mediaKind === 'video'
                ? <video src={item.image} aria-label={item.name} muted playsInline preload="metadata" />
                : <img src={item.image} alt={item.name} loading="lazy" decoding="async" />}
              <button
                type="button"
                className="asset-card__select"
                aria-label={`${selectedAssetIds.has(item.id) ? '取消选择' : '选择'} ${item.name}`}
                aria-pressed={selectedAssetIds.has(item.id)}
                onClick={(event) => {
                  event.stopPropagation()
                  setSelectedAssetIds((current) => {
                    const next = new Set(current)
                    if (next.has(item.id)) next.delete(item.id)
                    else next.add(item.id)
                    return next
                  })
                }}
              >{selectedAssetIds.has(item.id) ? '✓' : ''}</button>
              {source === '全部' ? <span className={`asset-card__source asset-card__source--${item.source}`}>{sourceLabel(item.source)}</span> : null}
              <div className="asset-card__quick-actions">
                <button type="button" className="asset-card__add" aria-label={`将 ${item.name} 加入画布`} title="加入画布" onClick={(event) => { event.stopPropagation(); onAdd(item.id) }}><PlusSquareIcon /></button>
                <div className="asset-card__more-wrap">
                  <button
                    className="asset-card__more"
                    type="button"
                    aria-label={`更多操作：${item.name}`}
                    aria-expanded={assetMenuId === item.id}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation()
                      openAssetMenu(item.id, event.currentTarget)
                    }}
                  ><MoreIcon /></button>
                </div>
              </div>
            </div>
            <div className="asset-card__copy">
              <strong>{item.name}</strong>
              <span>{visibleAssetTags(item.tags).filter((tag) => item.source !== 'generated' || !/^(生成|真实生成|已入库|生成入库)$/i.test(tag)).slice(0, 2).join(' · ')}</span>
            </div>
          </article>
        )) : <p className="asset-empty">没有匹配的素材</p>}
      </div>
      {assetMenuAsset && assetMenuAnchor && typeof document !== 'undefined' ? createPortal(
        <div
          ref={assetMenuRef}
          className={`asset-card__menu is-${assetMenuAnchor.placement}`}
          role="menu"
          aria-label={`${assetMenuAsset.name} 的更多操作`}
          style={{ left: assetMenuAnchor.left, top: assetMenuAnchor.top }}
          onClick={(event) => event.stopPropagation()}
        >
          <section className="asset-card__role-section" aria-label={`设置 ${assetMenuAsset.name} 的素材类型`}>
            <div><span>素材类型</span></div>
            <div className="asset-card__role-options">
              {uploadRoles.map((itemRole) => <button
                type="button"
                key={itemRole}
                aria-pressed={assetMenuAsset.role === itemRole}
                onClick={() => onMoveToRole(assetMenuAsset.id, itemRole)}
              >{itemRole}</button>)}
            </div>
          </section>
          <button
            className="asset-card__delete"
            type="button"
            role="menuitem"
            onClick={() => {
              setAssetMenuId(null)
              setAssetMenuAnchor(null)
              onDelete(assetMenuAsset)
            }}
          >删除素材</button>
        </div>,
        document.body,
      ) : null}
      {previewPresence.present && visiblePreviewAsset && typeof document !== 'undefined' ? createPortal(
        <div className={`asset-preview-backdrop motion-overlay is-${previewPresence.phase}`} role="presentation" aria-hidden={previewPresence.phase === 'exit' ? true : undefined} onPointerDown={(event) => {
          if (event.target === event.currentTarget) setPreviewAssetId(null)
        }}>
          <section className="asset-preview" role="dialog" aria-modal="true" aria-label={`预览素材 ${visiblePreviewAsset.name}`}>
            <header>
              <div><span>{sourceLabel(visiblePreviewAsset.source)} · {visiblePreviewAsset.role}</span><h3>{visiblePreviewAsset.name}</h3></div>
              <button type="button" autoFocus onClick={() => setPreviewAssetId(null)} aria-label="关闭素材预览"><CloseIcon /></button>
            </header>
            <div className="asset-preview__image">{visiblePreviewAsset.mediaKind === 'video'
              ? <video src={visiblePreviewAsset.image} aria-label={visiblePreviewAsset.name} controls playsInline preload="metadata" />
              : <img src={visiblePreviewAsset.image} alt={visiblePreviewAsset.name} />}</div>
            <footer>
              <div>
                <span>{visiblePreviewAsset.imageWidth && visiblePreviewAsset.imageHeight ? `${visiblePreviewAsset.imageWidth} × ${visiblePreviewAsset.imageHeight}` : visiblePreviewAsset.mediaKind === 'video' ? '视频素材' : '图片素材'}{visiblePreviewAsset.collection ? ` · ${visiblePreviewAsset.collection}` : ''}</span>
                <p>{visibleAssetTags(visiblePreviewAsset.tags).slice(0, 4).join(' · ') || '暂无标签'}</p>
              </div>
              <div className="asset-preview__actions">
                <button type="button" className="asset-preview__download" onClick={() => void downloadMedia(visiblePreviewAsset.image, visiblePreviewAsset.name, visiblePreviewAsset.mediaKind ?? 'image')}><DownloadIcon />下载</button>
                <button type="button" className="asset-preview__add" onClick={() => { onAdd(visiblePreviewAsset.id); setPreviewAssetId(null) }}><PlusSquareIcon />加入画布</button>
              </div>
            </footer>
          </section>
        </div>,
        document.body,
      ) : null}
      {selectedAssetIds.size ? (
        <div className="asset-library__batch-bar" role="toolbar" aria-label="批量素材操作">
          <strong>已选 {selectedAssetIds.size} 项</strong>
          <button type="button" onClick={() => {
            selectedAssetIds.forEach((id) => onAdd(id))
            setSelectedAssetIds(new Set())
          }}><PlusSquareIcon />加入画布</button>
          <BotanicSelect className="asset-batch-group-select" value={batchGroupId} placeholder="加入素材组" ariaLabel="将所选素材加入素材组" options={[
            ...groups.map((group) => ({ value: group.id, label: group.name })),
            { value: '__create_asset_group__', label: '＋ 新建素材组' },
          ]} onChange={(nextGroupId) => {
            if (nextGroupId === '__create_asset_group__') {
              setBatchGroupId('')
              setGroupRoleDraft(role === '全部' || role === '首图' ? '场景' : role)
              setGroupNameDraft('')
              setCreatingGroup(true)
              return
            }
            if (!nextGroupId) return
            onAddAssetsToGroup(nextGroupId, [...selectedAssetIds])
            setSelectedAssetIds(new Set())
            setGroupId(nextGroupId)
            setBatchGroupId('')
          }} />
          <button type="button" onClick={() => setSelectedAssetIds(new Set())}>取消</button>
        </div>
      ) : null}
    </aside>
  )
}

function TemplatePanel({
  templates,
  sharedTemplates,
  currentName,
  projectSaveSummary,
  sharedSaveSummary,
  onSave,
  onSaveShared,
  onCreateProject,
  onRefresh,
  onClose,
}: {
  templates: CanvasTemplate[]
  sharedTemplates: CanvasTemplate[]
  currentName: string
  projectSaveSummary: WorkflowTemplateSummary
  sharedSaveSummary: WorkflowTemplateSummary
  onSave: (name: string) => void
  onSaveShared: (name: string) => Promise<boolean>
  onCreateProject: (id: string, shared: boolean) => Promise<boolean>
  onRefresh: () => Promise<void>
  onClose: () => void
}) {
  const [activeTab, setActiveTab] = useState<'shared' | 'project'>(sharedTemplates.length ? 'shared' : 'project')
  const [name, setName] = useState(`${currentName} · 模板`)
  const [saveOpen, setSaveOpen] = useState(false)
  const [scope, setScope] = useState<'project' | 'shared'>('project')
  const [saving, setSaving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const [creatingTemplateId, setCreatingTemplateId] = useState<string | null>(null)
  const [createError, setCreateError] = useState('')
  const saveDialogPresence = useMotionPresence(saveOpen, 140)
  useRestoreFocus(saveOpen)
  const saveSummary = scope === 'shared' ? sharedSaveSummary : projectSaveSummary
  const visibleTemplates = activeTab === 'shared' ? sharedTemplates : templates

  useEffect(() => {
    let active = true
    setRefreshing(true)
    setRefreshError('')
    void onRefresh()
      .catch(() => { if (active) setRefreshError('团队模板暂时无法更新，当前显示上次同步结果。') })
      .finally(() => { if (active) setRefreshing(false) })
    return () => { active = false }
  }, [onRefresh])

  useEffect(() => {
    if (!saveOpen) return
    const closeDialog = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) setSaveOpen(false)
    }
    document.addEventListener('keydown', closeDialog)
    return () => document.removeEventListener('keydown', closeDialog)
  }, [saveOpen, saving])

  const openSaveDialog = () => {
    setName(`${currentName} · 模板`)
    setScope('project')
    setSaveOpen(true)
  }
  const saveTemplate = async () => {
    if (!name.trim() || !saveSummary.canSave || saving) return
    setSaving(true)
    try {
      if (scope === 'shared') {
        if (!await onSaveShared(name)) return
        setActiveTab('shared')
      } else {
        onSave(name)
        setActiveTab('project')
      }
      setSaveOpen(false)
    } finally {
      setSaving(false)
    }
  }
  const createFromTemplate = async (templateId: string) => {
    if (creatingTemplateId) return
    setCreateError('')
    setCreatingTemplateId(templateId)
    const created = await onCreateProject(templateId, activeTab === 'shared')
    setCreatingTemplateId(null)
    if (created) onClose()
    else setCreateError('项目未创建，请检查网络后重试。')
  }

  return (
    <aside className="workbench-panel template-panel" aria-label="模板">
      <PanelHeader eyebrow="TEMPLATES" title="模板" onClose={onClose} />
      <button type="button" className="template-save-trigger" disabled={!projectSaveSummary.canSave} onClick={openSaveDialog}>
        <PlusSquareIcon />保存当前画布为模板
      </button>
      {!projectSaveSummary.canSave ? <p className="panel-note">添加素材、文本或生成节点后，即可保存完整工作流设置。</p> : null}
      <div className="template-tabs" role="tablist" aria-label="模板范围">
        <button type="button" role="tab" aria-selected={activeTab === 'shared'} className={activeTab === 'shared' ? 'is-active' : ''} onClick={() => setActiveTab('shared')}>团队模板 <span>{sharedTemplates.length}</span></button>
        <button type="button" role="tab" aria-selected={activeTab === 'project'} className={activeTab === 'project' ? 'is-active' : ''} onClick={() => setActiveTab('project')}>本项目 <span>{templates.length}</span></button>
      </div>
      {refreshing && activeTab === 'shared' ? <p className="template-sync-state" role="status">正在更新团队模板…</p> : null}
      {refreshError && activeTab === 'shared' ? <p className="template-sync-state is-error">{refreshError}</p> : null}
      {createError ? <p className="template-sync-state is-error" role="alert">{createError}</p> : null}
      <section className="template-section" aria-label={activeTab === 'shared' ? '团队模板' : '本项目模板'}>
        <div className="template-list">
          {visibleTemplates.map((template) => {
            const summary = summarizeWorkflowTemplate(template.snapshot.nodes, template.snapshot.edges)
            const workflowKind = summary.videoWorkflowCount && summary.imageWorkflowCount
              ? '图片 + 视频'
              : summary.videoWorkflowCount ? '视频工作流' : '图片工作流'
            return (
              <article className="template-card" key={template.id}>
                {template.image ? <img src={template.image} alt="" /> : <div className="template-card__placeholder" aria-hidden="true">模板</div>}
                <div>
                  <strong>{template.name}</strong>
                  <span>{workflowKind} · {summary.nodeCount} 个节点 · {summary.promptCount} 条 Prompt</span>
                  {summary.settings[0] ? <small>{summary.settings[0]}</small> : null}
                  <button type="button" onClick={() => void createFromTemplate(template.id)} disabled={Boolean(creatingTemplateId)}>{creatingTemplateId === template.id ? '创建中…' : '从模板创建'}</button>
                </div>
              </article>
            )
          })}
          {!visibleTemplates.length && !refreshing ? <div className="template-empty"><strong>{activeTab === 'shared' ? '还没有团队模板' : '本项目还没有模板'}</strong><span>{activeTab === 'shared' ? '将稳定的工作流保存为团队模板，其他项目即可复用。' : '保存当前画布后，可随时从相同 Prompt 和参数开始。'}</span></div> : null}
        </div>
      </section>
      {saveDialogPresence.present && typeof document !== 'undefined' ? createPortal(
        <div className={`template-dialog-backdrop motion-overlay is-${saveDialogPresence.phase}`} role="presentation" aria-hidden={saveDialogPresence.phase === 'exit' ? true : undefined} onMouseDown={() => !saving && setSaveOpen(false)}>
          <form className="template-dialog" role="dialog" aria-modal="true" aria-labelledby="save-template-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void saveTemplate() }}>
            <header><div><span className="panel-eyebrow">SAVE TEMPLATE</span><h2 id="save-template-title">保存为模板</h2></div><button type="button" onClick={() => setSaveOpen(false)} disabled={saving} aria-label="关闭"><CloseIcon /></button></header>
            <label htmlFor="template-name">模板名称</label>
            <input id="template-name" autoFocus value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />
            <fieldset>
              <legend>保存范围</legend>
              <div className="template-dialog__scope">
                <button type="button" className={scope === 'project' ? 'is-active' : ''} aria-pressed={scope === 'project'} onClick={() => setScope('project')}><strong>仅本项目</strong><span>保留当前素材与完整设置</span></button>
                <button type="button" className={scope === 'shared' ? 'is-active' : ''} aria-pressed={scope === 'shared'} onClick={() => setScope('shared')}><strong>团队共享</strong><span>其他项目也可以使用</span></button>
              </div>
            </fieldset>
            <section className="template-dialog__summary" aria-label="模板保存内容">
              <strong>将保存</strong>
              <p>{saveSummary.nodeCount} 个节点 · {saveSummary.edgeCount} 条连线 · {saveSummary.promptCount} 条 Prompt</p>
              {saveSummary.settings.length ? <small>{saveSummary.settings.slice(0, 2).join(' / ')}</small> : null}
              {scope === 'shared' && sharedSaveSummary.privateAssetCount ? <em>{sharedSaveSummary.privateAssetCount} 个项目私有素材不会包含，Prompt 和生成参数仍会保留。</em> : null}
            </section>
            <footer><button type="button" onClick={() => setSaveOpen(false)} disabled={saving}>取消</button><button type="submit" className="is-primary" disabled={saving || !name.trim() || !saveSummary.canSave}>{saving ? '保存中…' : '保存模板'}</button></footer>
          </form>
        </div>,
        document.body,
      ) : null}
    </aside>
  )
}

function historyItemMeta(item: GeneratedHistoryItem) {
  return [
    item.aspectRatio,
    item.resolution,
    item.mediaKind === 'video' && item.duration ? `${item.duration}秒` : undefined,
  ].filter(Boolean).join(' · ')
}

function historyItemTime(createdAt: number) {
  if (!createdAt) return ''
  const date = new Date(createdAt)
  const today = new Date()
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  }
  return `${date.getMonth() + 1}/${date.getDate()}`
}

type HistoryTimeGroup = 'today' | 'yesterday' | 'earlier' | 'archive'

function historyTimeGroup(createdAt: number): HistoryTimeGroup {
  if (!createdAt) return 'archive'
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (createdAt >= today.getTime()) return 'today'
  if (createdAt >= yesterday.getTime()) return 'yesterday'
  return 'earlier'
}

const historyTimeGroupLabels: Record<HistoryTimeGroup, string> = {
  today: '今天',
  yesterday: '昨天',
  earlier: '更早',
  archive: '历史记录',
}

function HistoryPanel({
  results,
  onPreview,
  onLocate,
  onSaveToLibrary,
  isSaved,
  onClose,
}: {
  results: GeneratedHistoryItem[]
  onPreview: (item: GeneratedHistoryItem) => void
  onLocate: (item: GeneratedHistoryItem) => void
  onSaveToLibrary: (item: GeneratedHistoryItem) => void
  isSaved: (item: GeneratedHistoryItem) => boolean
  onClose: () => void
}) {
  const [filter, setFilter] = useState<'all' | GenerationMediaKind>('all')
  const imageCount = results.filter((item) => item.mediaKind === 'image').length
  const videoCount = results.length - imageCount
  const visibleResults = filter === 'all' ? results : results.filter((item) => item.mediaKind === filter)
  const latestVisibleId = visibleResults[0]?.id
  const groupedResults = (['today', 'yesterday', 'earlier', 'archive'] as HistoryTimeGroup[]).flatMap((group) => {
    const items = visibleResults.filter((item) => historyTimeGroup(item.createdAt) === group)
    return items.length ? [{ group, items }] : []
  })

  return (
    <aside className="workbench-panel history-panel" aria-label="画布历史">
      <PanelHeader title="画布历史" onClose={onClose} />
      <div className="history-filters" role="tablist" aria-label="筛选历史类型">
        <button type="button" role="tab" aria-selected={filter === 'all'} className={filter === 'all' ? 'is-active' : ''} onClick={() => setFilter('all')}>全部 <span>{results.length}</span></button>
        <button type="button" role="tab" aria-selected={filter === 'image'} className={filter === 'image' ? 'is-active' : ''} onClick={() => setFilter('image')}>图片 <span>{imageCount}</span></button>
        <button type="button" role="tab" aria-selected={filter === 'video'} className={filter === 'video' ? 'is-active' : ''} onClick={() => setFilter('video')}>视频 <span>{videoCount}</span></button>
      </div>
      {visibleResults.length ? <div className="history-groups">
        {groupedResults.map(({ group, items }) => <section className="history-group" key={group} aria-labelledby={`history-group-${group}`}>
          <header><strong id={`history-group-${group}`}>{historyTimeGroupLabels[group]}</strong><span>{items.length}</span></header>
          <div className="history-gallery">
        {items.map((item) => {
          const saved = isSaved(item)
          const metadata = historyItemMeta(item)
          const timestamp = historyItemTime(item.createdAt)
          return <article className={`history-gallery__item history-gallery__item--${item.mediaKind}`} key={item.id}>
            <button type="button" className="history-gallery__open" onClick={() => onPreview(item)} aria-label={`预览 ${item.name}`} title={`预览 ${item.name}`}>
              {item.mediaKind === 'video'
                ? <video src={item.image} aria-hidden="true" muted playsInline preload="metadata" />
                : <img src={item.image} alt="" />}
              {item.mediaKind === 'video' ? <><span className="history-gallery__type">视频</span><span className="history-gallery__play" aria-hidden="true">▶</span>{item.duration ? <span className="history-gallery__duration">{item.duration}秒</span> : null}</> : null}
              {item.id === latestVisibleId ? <span className={`history-gallery__latest${item.mediaKind === 'video' ? ' is-video' : ''}`}>最新</span> : null}
            </button>
            <div className="history-gallery__copy">
              <strong title={item.name}>{item.name}</strong>
              <span>{metadata || (item.mediaKind === 'video' ? '视频' : '图片')}{timestamp ? ` · ${timestamp}` : ''}</span>
            </div>
            <footer className="history-gallery__actions">
              {item.nodeId ? <button type="button" onClick={() => onLocate(item)} aria-label={`在画布定位 ${item.name}`} title="在画布定位"><FocusIcon /><span>定位</span></button> : <span />}
              <button type="button" aria-label={`下载 ${item.name}`} title="下载原媒体" onClick={() => void downloadMedia(item.image, item.name, item.mediaKind)}><DownloadIcon /></button>
              <button type="button" className={saved ? 'is-saved' : ''} disabled={saved} aria-label={saved ? `${item.name} 已入库` : `将 ${item.name} 入库`} title={saved ? '已入库' : '存入素材库'} onClick={() => onSaveToLibrary(item)}>{saved ? '已入库' : '入库'}</button>
            </footer>
          </article>
        })}
          </div>
        </section>)}
      </div> : <div className="template-empty history-empty"><strong>{results.length ? `暂无${filter === 'video' ? '视频' : '图片'}` : '暂无生成内容'}</strong><span>{results.length ? '切换类型查看其他历史内容。' : '完成图片或视频生成后，结果会出现在这里。'}</span></div>}
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
        <small>真实任务 · {displayedRecipe.batchCount} 个候选</small>
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
                    <button disabled={disabled} onClick={() => onMoveReference(reference.nodeId, 'earlier')} aria-label={`提升 ${reference.name} 的参考优先级`}><ArrowUpIcon /></button>
                    <button disabled={disabled} onClick={() => onMoveReference(reference.nodeId, 'later')} aria-label={`降低 ${reference.name} 的参考优先级`}><ArrowDownIcon /></button>
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
  const selectedModel = modelOptions.find((model) => model.id === settings.model)
  const cleanPrompt = prompt.trim()

  return (
    <section className="node-inspector__draft" aria-label="下一次任务草稿">
      <div className="node-inspector__draft-title"><span>下一次任务草稿</span><small>原任务不会被改写</small></div>
      <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} aria-label="编辑生成描述" placeholder="描述下一次要生成的画面" />
      <div className="node-inspector__draft-settings">
        <label><span>模型</span><BotanicSelect ariaLabel="草稿生成模型" value={settings.model} menuWidth={180} options={modelOptions.map((model) => ({ value: model.id, label: model.label }))} onChange={(value) => {
          const model = modelOptions.find((option) => option.id === value)
          if (model) setSettings((current) => settingsForModel(current, model))
        }} /></label>
        <label><span>比例</span><BotanicSelect ariaLabel="草稿画面比例" value={settings.aspectRatio} options={(selectedModel?.aspectRatios ?? ['1:1', '3:4', '4:5', '9:16']).map((ratio) => ({ value: ratio, label: ratio }))} onChange={(value) => updateSettings({ aspectRatio: value as GenerationSettings['aspectRatio'] })} /></label>
        <label><span>规格</span><BotanicSelect ariaLabel="草稿输出规格" value={settings.resolution} options={(selectedModel?.resolutions ?? ['1K', '2K']).map((resolution) => ({ value: resolution, label: resolution }))} onChange={(value) => updateSettings({ resolution: value as GenerationSettings['resolution'] })} /></label>
        {selectedModel?.mediaKind === 'video' ? <label><span>时长</span><BotanicSelect ariaLabel="草稿视频时长" value={settings.duration ?? selectedModel.defaultDuration ?? 5} options={(selectedModel.durations ?? [5]).map((duration) => ({ value: String(duration), label: `${duration} 秒` }))} onChange={(value) => updateSettings({ duration: Number(value) })} /></label> : null}
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
          <div className="node-inspector__metadata"><span>{data.settings.model}</span><span>{data.settings.aspectRatio} · {data.settings.resolution}</span><span>{data.batchCount} 个候选</span></div>
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
          <div className="node-inspector__metadata"><span>{data.settings.model}</span><span>{data.batchCount} 个候选</span></div>
          <p>图片和文本的连线决定本次输入；参数与补充描述可直接在节点内调整。</p>
        </section>
      </aside>
    )
  }

  const data = node.data as ResultNodeData
  const taskCandidates = candidates.filter((candidate) => candidate.resultNodeId === node.id)
  const resultStatus = data.image ? '已生成' : data.status === 'generating' ? '生成服务处理中' : data.status === 'failed' ? '任务未完成' : data.status === 'cancelled' ? '任务已取消' : '等待生成结果'
  return (
    <aside className="workbench-panel node-inspector" aria-label="结果节点详情">
      <PanelHeader eyebrow="RESULT NODE" title={data.image ? '结果版本' : '任务结果'} onClose={onClose} />
      <NodeNameEditor node={node} onRename={onRename} />
      <section className="node-inspector__section">
        {data.image
          ? data.mediaKind === 'video'
            ? <video className="node-inspector__result-image" src={data.image} aria-label={data.label ?? '视频结果'} controls playsInline preload="metadata" />
            : <img className="node-inspector__result-image" src={data.image} alt={data.label ?? '结果版本'} />
          : null}
        <div className="node-inspector__section-title"><span>状态</span><strong>{resultStatus}</strong></div>
        <p>{data.label ?? (data.generationKind === 'refinement' ? '定向精修结果' : '生成结果')}</p>
        {data.generationRecipe ? <div className="node-inspector__metadata"><span>{recipeSummary(data.generationRecipe)}</span></div> : null}
        {data.error ? <p className="node-inspector__error">{data.error}</p> : null}
        <div className="node-inspector__actions">
          {taskCandidates.length ? <button className="node-inspector__primary-action" onClick={onOpenCandidates}>查看 {taskCandidates.length} 个候选</button> : null}
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
      ? '生成服务已接收任务，正在排队'
      : '生成服务正在处理'
  const isRefinement = kind === 'refinement' || candidates[0]?.kind === 'refinement'
  const parent = candidates.find((candidate) => candidate.kind === 'refinement' && candidate.parentImage)
  const sourceAssetNames = candidates[0]?.sourceAssetNames ?? []
  const recipe = candidates[0]?.recipe
  const primaryReference = primaryReferenceFromRecipe(recipe)
  const isPartial = status === 'idle' && pendingCount > candidates.length
  return (
    <aside className="workbench-panel generation-panel" aria-label="真实生成候选">
      <PanelHeader eyebrow={isRefinement ? 'REAL REFINEMENT' : 'REAL GENERATION'} title={isInFlight ? statusMessage : status === 'error' ? '生成需要处理' : `${isRefinement ? '精修' : '首图'}候选 · ${isPartial ? `${candidates.length}/${pendingCount}` : candidates.length}`} onClose={onClose} />
      <p className="panel-note">{isRefinement ? '候选会继承父版本配方；选择后写入同一条“素材/文本 → 生成 → 结果”图谱，并可在历史中一键回退。' : sourceAssetNames.length ? `真实任务以已选参考「${sourceAssetNames.join('、')}」为依据，并固定主商品。` : '选择一张首图会写入结果节点、生成版本分支，并进入素材库的“生成入库”。'}</p>
      {recipe ? <div className="candidate-recipe" aria-label="候选生成配方"><strong>{primaryReference ? `主商品 · ${primaryReference.name}` : '继承父版本'}</strong><span>{recipe.references.length} 个参考 · {recipe.settings.aspectRatio} / {recipe.settings.resolution}</span></div> : null}
      {isInFlight ? (
        <div className="generation-progress" role="status" aria-label={`正在真实生成 ${pendingCount} 个候选`}>
          <div><span className="is-indeterminate" /></div>
          <span>{statusMessage} · 目标 {pendingCount} 个</span>
          <button onClick={onCancel}>取消生成</button>
        </div>
      ) : null}
      {status === 'error' ? (
        <div className="generation-error" role="alert">
          <span>{error ?? '生成失败，请重试。'}</span>
          <button onClick={onRetry}>重试</button>
        </div>
      ) : null}
      {isPartial ? (
        <div className="generation-partial" role="status">
          <span>已有 {candidates.length} 张可用，缺少 {pendingCount - candidates.length} 张。</span>
          <button onClick={onRetry}>补生成 {pendingCount - candidates.length} 张</button>
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
            {candidate.mediaKind === 'video'
              ? <video src={candidate.image} aria-label={candidate.name} controls playsInline preload="metadata" />
              : <img src={candidate.image} alt={candidate.name} />}
            <span>{candidate.name}</span>
            <small>{candidate.kind === 'refinement' ? `精修自 ${candidate.parentLabel ?? '已选首图'}` : `主商品 · ${primaryReferenceFromRecipe(candidate.recipe)?.name ?? '未锁定'}`} · {candidate.recipe.references.length} 参考</small>
          </button>
        )) : null}
      </div>
    </aside>
  )
}

function DeliveryPanel({
  target,
  targets,
  blockedVideo,
  deliveries,
  onCreate,
  onSelectTarget,
  onClose,
}: {
  target?: DeliveryPanelTarget
  targets: DeliveryPanelTarget[]
  blockedVideo: boolean
  deliveries: DeliveryArtifact[]
  onCreate: (input: {
    targetNodeId: string
    presets: DeliveryPresetId[]
    title: string
    subtitle: string
    safeZone: boolean
  }) => void
  onSelectTarget: (nodeId: string) => void
  onClose: () => void
}) {
  const [selectedPresets, setSelectedPresets] = useState<DeliveryPresetId[]>(() => deliveryPresets.map((preset) => preset.id))
  const [activePreviewPreset, setActivePreviewPreset] = useState<DeliveryPresetId>('taobao')
  const [title, setTitle] = useState('')
  const [subtitle, setSubtitle] = useState('')
  const [safeZone, setSafeZone] = useState(true)
  const [targetPickerOpen, setTargetPickerOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportMessage, setExportMessage] = useState('')

  const previewArtifacts = useMemo(() => target
    ? buildDeliveryPreviewArtifacts({
        target,
        presets: selectedPresets,
        draft: { title, subtitle, safeZone },
      })
    : [], [safeZone, selectedPresets, subtitle, target, title])
  const activePreview = previewArtifacts.find((item) => item.presetId === activePreviewPreset) ?? previewArtifacts[0]
  const activePreviewDefinition = activePreview
    ? deliveryPresets.find((item) => item.id === activePreview.presetId)
    : undefined
  const persistedDraft = useMemo(() => target ? resolveDeliveryDraft(target.nodeId, deliveries) : undefined, [deliveries, target?.nodeId])

  useEffect(() => {
    setTargetPickerOpen(false)
    setExportMessage('')
    if (!target) {
      setTitle('')
      setSubtitle('')
      setSafeZone(true)
      return
    }
    setTitle(persistedDraft?.title ?? '')
    setSubtitle(persistedDraft?.subtitle ?? '')
    setSafeZone(persistedDraft?.safeZone ?? true)
  }, [persistedDraft?.safeZone, persistedDraft?.subtitle, persistedDraft?.title, target?.nodeId])

  const togglePreset = (presetId: DeliveryPresetId) => {
    if (selectedPresets.includes(presetId)) {
      const next = selectedPresets.filter((item) => item !== presetId)
      setSelectedPresets(next)
      if (activePreviewPreset === presetId && next[0]) setActivePreviewPreset(next[0])
      return
    }
    setSelectedPresets([...selectedPresets, presetId])
    setActivePreviewPreset(presetId)
  }

  const selectTarget = (nodeId: string) => {
    onSelectTarget(nodeId)
    setTargetPickerOpen(false)
    setExportMessage('')
  }

  const handleExport = async () => {
    if (!target || !previewArtifacts.length || exporting) return
    setExporting(true)
    setExportMessage('')
    try {
      const result = await downloadDeliveryPackage(previewArtifacts)
      onCreate({
        targetNodeId: target.nodeId,
        presets: selectedPresets,
        title,
        subtitle,
        safeZone,
      })
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
            <small>{target.versionId ? '已保存的画布版本' : '来自当前画布'}</small>
          </div>
          <button type="button" className="delivery-target__change" onClick={() => setTargetPickerOpen((open) => !open)}>更换</button>
        </div>
      ) : blockedVideo ? (
        <div className="delivery-blocked">
          <strong>视频暂不支持图片投放交付</strong>
          <span>请选择一张生成图片，视频交付将在独立流程中处理。</span>
          <button type="button" onClick={() => setTargetPickerOpen(true)}>选择图片</button>
        </div>
      ) : (
        <div className="delivery-empty">
          <span>请选择一张生成图片开始投放交付。</span>
          <button type="button" onClick={() => setTargetPickerOpen(true)}>选择图片</button>
        </div>
      )}

      {targetPickerOpen ? (
        <section className="delivery-target-picker" aria-label="选择交付素材">
          <div className="delivery-section__title"><strong>最近生成图片</strong><span>{targets.length} 张</span></div>
          {targets.length ? (
            <div className="delivery-target-picker__list">
              {targets.map((item) => (
                <button
                  type="button"
                  className={target?.nodeId === item.nodeId ? 'is-active' : ''}
                  key={item.nodeId}
                  onClick={() => selectTarget(item.nodeId)}
                  aria-pressed={target?.nodeId === item.nodeId}
                >
                  <img src={item.image} alt="" />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          ) : <p>暂无可用于交付的生成图片。</p>}
        </section>
      ) : null}

      {target ? <>
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

      <section className="delivery-live-preview" aria-label="实时预览">
          <div className="delivery-section__title"><strong>实时预览</strong><span>边调边看</span></div>
          {selectedPresets.length ? (
            <>
              <div className="delivery-preview-tabs" role="tablist" aria-label="预览渠道">
                {selectedPresets.map((presetId) => {
                  const preset = deliveryPresets.find((item) => item.id === presetId)
                  if (!preset) return null
                  const active = activePreview?.presetId === presetId
                  return <button type="button" role="tab" aria-selected={active} className={active ? 'is-active' : ''} key={presetId} onClick={() => setActivePreviewPreset(presetId)}>{preset.channel}</button>
                })}
              </div>
              {activePreview && activePreviewDefinition ? (
                <div className="delivery-live-preview__stage">
                  <div className={`delivery-preview delivery-preview--${activePreview.presetId}`}>
                    <img src={activePreview.image} alt={`${activePreview.targetLabel} · ${activePreviewDefinition.channel}`} />
                    {activePreview.title || activePreview.subtitle ? (
                      <div className="delivery-preview__copy">
                        {activePreview.title ? <strong>{activePreview.title}</strong> : null}
                        {activePreview.subtitle ? <small>{activePreview.subtitle}</small> : null}
                      </div>
                    ) : null}
                    {activePreview.safeZone ? <span className="delivery-preview__safe">安全区</span> : null}
                  </div>
                  <p><strong>{activePreviewDefinition.channel}</strong><span>{activePreviewDefinition.ratio} · {activePreviewDefinition.width}×{activePreviewDefinition.height}</span></p>
                </div>
              ) : null}
            </>
          ) : <p className="delivery-live-preview__empty">至少选择一个投放规格。</p>}
      </section>

      <section className="delivery-copy" aria-label="文案与版式">
        <div className="delivery-section__title"><strong>文案与版式</strong><span>可选</span></div>
        <label htmlFor="delivery-title">主标题</label>
        <input id="delivery-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="输入投放主标题" />
        <label htmlFor="delivery-subtitle">副标题</label>
        <input id="delivery-subtitle" value={subtitle} onChange={(event) => setSubtitle(event.target.value)} placeholder="输入补充卖点" />
        <label className="delivery-safe-toggle">
          <input type="checkbox" checked={safeZone} onChange={(event) => setSafeZone(event.target.checked)} />
          <span><strong>显示安全区辅助线</strong><small>仅用于预览定位，导出文件不包含辅助线</small></span>
          <i aria-hidden="true" />
        </label>
      </section>

      <button className="delivery-export" onClick={() => void handleExport()} disabled={!target || !selectedPresets.length || exporting}>{exporting ? '正在打包…' : `导出 ${selectedPresets.length || ''} 个规格`}</button>
      <p className="delivery-note">本地裁切并打包，不会直接发布到平台。</p>
      {exportMessage ? <p className="delivery-export-message" role="status">{exportMessage}</p> : null}
      </> : null}
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
      <button className="close-panel" onClick={onClose} aria-label={`关闭${title}`}><CloseIcon /></button>
    </div>
  )
}

function ConfirmationDialog({ asset, phase, onConfirm, onCancel }: { asset: AssetRecord; phase: MotionPhase; onConfirm: () => void; onCancel: () => void }) {
  const isSharedBrandAsset = asset.source === 'brand'
  return (
    <div className={`confirm-backdrop motion-overlay is-${phase}`} aria-hidden={phase === 'exit' ? true : undefined}>
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
  const selectedModel = modelOptions.find((model) => model.id === settings.model)
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
          <button onClick={onOpenAssets} aria-label="添加参考素材"><PlusSquareIcon /></button>
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
          <label className="parameter-select composer-model-select"><span className="visually-hidden">生成模型</span><BotanicSelect ariaLabel="生成模型" value={settings.model} disabled={isGenerating} menuWidth={180} options={modelOptions.map((model) => ({ value: model.id, label: model.label }))} onChange={(value) => {
            const model = modelOptions.find((option) => option.id === value)
            if (model) onSettingsChange(settingsForModel(settings, model))
          }} /></label>
          <label className="parameter-select"><span className="visually-hidden">画面比例</span><BotanicSelect ariaLabel="画面比例" value={settings.aspectRatio} disabled={isGenerating} options={(selectedModel?.aspectRatios ?? ['1:1', '3:4', '4:5', '9:16']).map((ratio) => ({ value: ratio, label: ratio }))} onChange={(value) => updateSettings({ aspectRatio: value as GenerationSettings['aspectRatio'] })} /></label>
          <label className="parameter-select"><span className="visually-hidden">输出规格</span><BotanicSelect ariaLabel="输出规格" value={settings.resolution} disabled={isGenerating} options={(selectedModel?.resolutions ?? ['1K', '2K']).map((resolution) => ({ value: resolution, label: resolution }))} onChange={(value) => updateSettings({ resolution: value as GenerationSettings['resolution'] })} /></label>
          {selectedModel?.mediaKind === 'video' ? <label className="parameter-select"><span className="visually-hidden">视频时长</span><BotanicSelect ariaLabel="视频时长" value={settings.duration ?? selectedModel.defaultDuration ?? 5} disabled={isGenerating} options={(selectedModel.durations ?? [5]).map((duration) => ({ value: String(duration), label: `${duration} 秒` }))} onChange={(value) => updateSettings({ duration: Number(value) })} /></label> : null}
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
          ? (status === 'uploading' ? '正在上传参考素材…' : status === 'queued' ? '真实任务已入队…' : `${selectedModel?.mediaKind === 'video' ? '视频' : '图像'}服务正在生成…`)
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

function UndoToast({ label, phase, onUndo }: { label: string; phase: MotionPhase; onUndo: () => void }) {
  return (
    <div className={`undo-toast is-${phase}`} role="status" aria-hidden={phase === 'exit' ? true : undefined}>
      <span>{label}</span>
      <button onClick={onUndo}>撤销</button>
    </div>
  )
}

type AgentDockTarget = {
  id: string
  label: string
  image: string
  rootRecipe: GenerationRecipe
}

type AgentContextItem = {
  id: string
  label: string
  kind: '素材' | '结果' | '文字' | '节点'
  image?: string
}

const agentQuickActions: Array<{ intent: BotanicAgentIntent; label: string; instruction: string }> = [
  { intent: 'replace_scene', label: '换场景', instruction: '保持人物、服装和商品不变，只替换场景与环境光线。' },
  { intent: 'change_pose', label: '换动作', instruction: '保持人物、服装、商品和场景不变，调整动作姿势与构图。' },
  { intent: 'change_style', label: '换风格', instruction: '保持人物、服装、商品、场景和动作不变，调整视觉风格与光线。' },
  { intent: 'replace_person', label: '换模特', instruction: '保持服装、商品、场景和风格不变，替换模特。' },
  { intent: 'replace_product', label: '换商品', instruction: '保持人物、场景和风格不变，替换服装或商品。' },
  { intent: 'redo_from_root', label: '原配方重做', instruction: '复用原始参考素材、提示词和参数，重新生成独立首图。' },
]

function agentGroupRole(intent: BotanicAgentIntent): AssetGroup['role'] | null {
  if (intent === 'replace_scene') return '场景'
  if (intent === 'replace_person') return '模特'
  if (intent === 'replace_product') return '商品'
  if (intent === 'change_style') return '调性'
  return null
}

function agentToolStatusLabel(status: NonNullable<BotanicAgentPlan['toolCalls']>[number]['status']) {
  if (status === 'succeeded') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'awaiting_confirmation') return '待确认'
  if (status === 'running') return '执行中'
  return '待执行'
}

function agentRuntimeStepStatusLabel(status: BotanicAgentRuntimeStep['status']) {
  if (status === 'succeeded') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'running') return '执行中'
  return '待执行'
}

function agentRuntimeStepMarker(step: BotanicAgentRuntimeStep) {
  if (step.status === 'succeeded') return '✓'
  if (step.status === 'failed') return '!'
  if (step.status === 'running') return '·'
  if (step.kind === 'search') return '⌕'
  if (step.kind === 'write') return '↗'
  return '○'
}

function agentMemoryKindLabel(kind: BotanicAgentMemoryKind) {
  if (kind === 'approved') return '已确认方向'
  if (kind === 'avoid') return '避免事项'
  return '长期规则'
}

function agentArtifactKindLabel(artifact: BotanicAgentArtifact) {
  if (artifact.kind === 'image') return '图片'
  if (artifact.kind === 'video') return '视频'
  if (artifact.kind === 'workflow') return '工作流'
  if (artifact.kind === 'asset_group') return '素材组'
  if (artifact.kind === 'file') return '文件'
  return '文本'
}

function AgentWorkspace({
  projectId,
  target,
  groups,
  sessions,
  session,
  contextOptions,
  memory,
  artifacts,
  latestRun,
  runs,
  plannerModels,
  onConfirm,
  onConfirmAction,
  onCreateDraft,
  onAppendMessage,
  onUpdateMessage,
  onUpdateAction,
  onContextChange,
  onExecutionModeChange,
  onAddMemory,
  onRemoveMemory,
  onNewSession,
  onSelectSession,
  onRetryBranch,
  onCancelRun,
  onLocateNode,
  onSaveArtifact,
  onUseResultContext,
  onClose,
}: {
  projectId: string
  target?: AgentDockTarget
  groups: AssetGroup[]
  sessions: BotanicAgentSession[]
  session?: BotanicAgentSession
  contextOptions: AgentContextItem[]
  memory: BotanicAgentMemoryItem[]
  artifacts: BotanicAgentArtifact[]
  latestRun?: BotanicAgentRun
  runs: BotanicAgentRun[]
  plannerModels: string[]
  onConfirm: (plan: BotanicAgentPlan) => Promise<{ started: boolean; runId: string }>
  onConfirmAction: (action: BotanicAgentActionProposal) => Promise<BotanicAgentActionResult>
  onCreateDraft: (instruction: string, contextNodeIds: string[], autoExecute: boolean) => Promise<{ created: boolean; started: boolean; needsReference: boolean }>
  onAppendMessage: (sessionId: string, message: BotanicAgentMessage) => void
  onUpdateMessage: (sessionId: string, messageId: string, patch: Partial<Pick<BotanicAgentMessage, 'content' | 'runId' | 'status' | 'feedback'>>) => void
  onUpdateAction: (sessionId: string, messageId: string, actionId: string, patch: Partial<Pick<BotanicAgentActionProposal, 'status' | 'error' | 'result'>>) => void
  onContextChange: (sessionId: string, contextNodeIds: string[]) => void
  onExecutionModeChange: (sessionId: string, mode: BotanicAgentExecutionMode) => void
  onAddMemory: (kind: BotanicAgentMemoryKind, content: string, sourceNodeIds?: string[]) => string | null
  onRemoveMemory: (memoryId: string) => void
  onNewSession: () => string
  onSelectSession: (sessionId: string) => void
  onRetryBranch: (runId: string, branchId: string) => Promise<boolean>
  onCancelRun: (runId: string) => Promise<boolean>
  onLocateNode: (nodeId: string) => void
  onSaveArtifact: (artifact: BotanicAgentArtifact) => void
  onUseResultContext: (sourceNodeIds: string[]) => void
  onClose: () => void
}) {
  const [intent, setIntent] = useState<BotanicAgentIntent>('replace_scene')
  const [instruction, setInstruction] = useState('')
  const [groupId, setGroupId] = useState('')
  const [plannerModel, setPlannerModel] = useState(plannerModels[0] ?? defaultAgentPlannerModels[0])
  const [error, setError] = useState('')
  const [planning, setPlanning] = useState(false)
  const [runtimeSteps, setRuntimeSteps] = useState<BotanicAgentRuntimeStep[]>([])
  const [runtimeDetailsOpen, setRuntimeDetailsOpen] = useState(true)
  const [submittingMessageId, setSubmittingMessageId] = useState('')
  const [executingActionId, setExecutingActionId] = useState('')
  const [retryingBranchId, setRetryingBranchId] = useState('')
  const [cancellingRunId, setCancellingRunId] = useState('')
  const [contextMenuOpen, setContextMenuOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const [skillPanelOpen, setSkillPanelOpen] = useState(false)
  const [taskPanelOpen, setTaskPanelOpen] = useState(false)
  const [resultPanelOpen, setResultPanelOpen] = useState(false)
  const [resultFilter, setResultFilter] = useState<'all' | 'image' | 'video' | 'file'>('all')
  const [selectedArtifactIds, setSelectedArtifactIds] = useState<string[]>([])
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false)
  const [memoryKind, setMemoryKind] = useState<BotanicAgentMemoryKind>('rule')
  const [memoryDraft, setMemoryDraft] = useState('')
  const [mentionQuery, setMentionQuery] = useState<BotanicAgentMentionQuery>()
  const [skills, setSkills] = useState<BotanicAgentSkill[]>([])
  const [skillName, setSkillName] = useState('')
  const [skillInstructions, setSkillInstructions] = useState('')
  const [skillConfirming, setSkillConfirming] = useState(false)
  const [skillSaving, setSkillSaving] = useState(false)
  const [skillError, setSkillError] = useState('')
  const plannerControllerRef = useRef<AbortController | null>(null)
  const reportedRunIdsRef = useRef(new Set<string>())
  const messageEndRef = useRef<HTMLDivElement | null>(null)
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const historyTriggerRef = useRef<HTMLButtonElement | null>(null)
  const contextMenuButtonRef = useRef<HTMLButtonElement | null>(null)
  const modeMenuButtonRef = useRef<HTMLButtonElement | null>(null)
  const utilityButtonRef = useRef<HTMLButtonElement | null>(null)
  const skillCreateButtonRef = useRef<HTMLButtonElement | null>(null)
  const historyMenuId = useId()
  const contextMenuId = useId()
  const modeMenuId = useId()
  const compatibleGroups = groups.filter((group) => group.role === agentGroupRole(intent) && group.assetIds.length)
  const contextItems = contextOptions.filter((item) => session?.contextNodeIds.includes(item.id))
  const hasMessages = Boolean(session?.messages.length)
  const filteredArtifacts = useMemo(() => artifacts.filter((artifact) => {
    if (resultFilter === 'all') return true
    if (resultFilter === 'file') return artifact.kind !== 'image' && artifact.kind !== 'video'
    return artifact.kind === resultFilter
  }), [artifacts, resultFilter])
  const artifactGroups = useMemo(() => {
    const groups = new Map<string, { id: string; label: string; artifacts: BotanicAgentArtifact[] }>()
    for (const artifact of filteredArtifacts) {
      const runId = artifact.provenance.runId
      const id = runId ?? `action:${artifact.provenance.actionId}`
      const label = runId ? runs.find((run) => run.id === runId)?.plan.summary ?? '生成批次' : '工具产物'
      const group = groups.get(id) ?? { id, label, artifacts: [] }
      group.artifacts.push(artifact)
      groups.set(id, group)
    }
    return [...groups.values()]
  }, [filteredArtifacts, runs])
  const selectedArtifactBatch = useMemo(
    () => resolveBotanicAgentResultSelection(artifacts, selectedArtifactIds),
    [artifacts, selectedArtifactIds],
  )
  const selectedResultNodeIds = useMemo(() => {
    const resultNodeIds = new Set(contextOptions.filter((item) => item.kind === '结果').map((item) => item.id))
    return selectedArtifactBatch.sourceNodeIds.filter((nodeId) => resultNodeIds.has(nodeId))
  }, [contextOptions, selectedArtifactBatch.sourceNodeIds])
  const mentionOptions = useMemo(() => {
    if (!mentionQuery) return []
    const query = mentionQuery.query.trim().toLocaleLowerCase()
    return contextOptions.filter((item) => !query || `${item.label} ${item.kind}`.toLocaleLowerCase().includes(query)).slice(0, 6)
  }, [contextOptions, mentionQuery])
  const utilityPanelOpen = taskPanelOpen || skillPanelOpen || resultPanelOpen || memoryPanelOpen
  const runtimeFailed = runtimeSteps.some((step) => step.status === 'failed')
  const runtimeComplete = Boolean(runtimeSteps.length) && runtimeSteps.every((step) => step.status === 'succeeded')

  useEffect(() => {
    const frame = requestAnimationFrame(() => composerTextareaRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [])

  useEffect(() => {
    const closeLayerOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (mentionQuery) {
        setMentionQuery(undefined)
        requestAnimationFrame(() => composerTextareaRef.current?.focus())
      } else if (contextMenuOpen) {
        setContextMenuOpen(false)
        requestAnimationFrame(() => contextMenuButtonRef.current?.focus())
      } else if (modeMenuOpen) {
        setModeMenuOpen(false)
        requestAnimationFrame(() => modeMenuButtonRef.current?.focus())
      } else if (historyOpen) {
        setHistoryOpen(false)
        requestAnimationFrame(() => historyTriggerRef.current?.focus())
      } else if (skillConfirming) {
        setSkillConfirming(false)
        requestAnimationFrame(() => skillCreateButtonRef.current?.focus())
      } else if (utilityPanelOpen) {
        setTaskPanelOpen(false)
        setSkillPanelOpen(false)
        setResultPanelOpen(false)
        setMemoryPanelOpen(false)
        requestAnimationFrame(() => utilityButtonRef.current?.focus())
      } else {
        return
      }
      event.preventDefault()
    }
    window.addEventListener('keydown', closeLayerOnEscape)
    return () => window.removeEventListener('keydown', closeLayerOnEscape)
  }, [contextMenuOpen, historyOpen, mentionQuery, modeMenuOpen, skillConfirming, utilityPanelOpen])

  useEffect(() => {
    setError('')
    setGroupId('')
    setInstruction('')
    setContextMenuOpen(false)
    setHistoryOpen(false)
    setModeMenuOpen(false)
    setSkillPanelOpen(false)
    setTaskPanelOpen(false)
    setResultPanelOpen(false)
    setSelectedArtifactIds([])
    setMemoryPanelOpen(false)
    setMentionQuery(undefined)
    setSkillConfirming(false)
    setRuntimeSteps([])
    setRuntimeDetailsOpen(true)
    plannerControllerRef.current?.abort()
  }, [session?.id])

  useEffect(() => {
    setSelectedArtifactIds((current) => current.filter((id) => artifacts.some((artifact) => artifact.id === id)))
  }, [artifacts])

  useEffect(() => () => plannerControllerRef.current?.abort(), [])

  useEffect(() => {
    if (!skillPanelOpen) return
    let active = true
    setSkillError('')
    void listProjectAgentSkills(projectId).then((items) => {
      if (active) setSkills(items)
    }).catch((caught) => {
      if (active) setSkillError(caught instanceof Error ? caught.message : 'Skill 列表加载失败。')
    })
    return () => { active = false }
  }, [projectId, skillPanelOpen])

  useEffect(() => {
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
    messageEndRef.current?.scrollIntoView({ block: 'end', behavior })
  }, [session?.messages.length, latestRun?.updatedAt, planning, runtimeSteps.length, runtimeSteps[runtimeSteps.length - 1]?.status])

  useEffect(() => {
    if (!compatibleGroups.some((group) => group.id === groupId)) setGroupId('')
  }, [compatibleGroups, groupId])

  useEffect(() => {
    if (!plannerModels.includes(plannerModel)) setPlannerModel(plannerModels[0] ?? defaultAgentPlannerModels[0])
  }, [plannerModel, plannerModels])

  const appendMessage = (message: Omit<BotanicAgentMessage, 'id' | 'createdAt'>) => {
    if (!session) return ''
    const messageId = `agent-message-${crypto.randomUUID()}`
    onAppendMessage(session.id, { ...message, id: messageId, createdAt: Date.now() })
    return messageId
  }

  useEffect(() => {
    if (!session) return
    for (const message of session.messages) {
      if (message.kind === 'run' && message.runId) reportedRunIdsRef.current.add(message.runId)
    }
    const linkedRunIds = new Set(session.messages.flatMap((message) => message.runId ? [message.runId] : []))
    for (const run of runs) {
      if (!linkedRunIds.has(run.id) || reportedRunIdsRef.current.has(run.id)) continue
      if (run.status !== 'completed' && run.status !== 'partial' && run.status !== 'failed' && run.status !== 'cancelled') continue
      reportedRunIdsRef.current.add(run.id)
      const outputCount = artifacts.filter((artifact) => artifact.provenance.runId === run.id).length
      const content = run.status === 'completed'
        ? `任务已完成，生成 ${outputCount} 项结果。可在「结果」中批量查看、下载或入库。`
        : run.status === 'partial'
          ? `任务部分完成，已产出 ${outputCount} 项结果；失败分支可在「任务」中单独重试。`
          : `任务未完成。请在「任务」中查看失败原因并重试分支。`
      appendMessage({ role: 'assistant', kind: 'run', runId: run.id, content })
    }
  }, [artifacts, runs, session])

  const confirmSkillCreation = async () => {
    if (!skillName.trim() || !skillInstructions.trim() || skillSaving) return
    setSkillSaving(true)
    setSkillError('')
    try {
      const result = await createProjectAgentSkill({
        projectId,
        name: skillName.trim(),
        instructions: skillInstructions.trim(),
      })
      setSkills((items) => [result.output.skill, ...items.filter((item) => item.id !== result.output.skill.id)])
      setSkillName('')
      setSkillInstructions('')
      setSkillConfirming(false)
    } catch (caught) {
      setSkillError(caught instanceof Error ? caught.message : 'Skill 创建失败。')
    } finally {
      setSkillSaving(false)
    }
  }

  const saveMemory = () => {
    if (!memoryDraft.trim()) return
    const memoryId = onAddMemory(memoryKind, memoryDraft, session?.contextNodeIds ?? [])
    if (!memoryId) return
    setMemoryDraft('')
  }

  const selectMention = (item: AgentContextItem) => {
    if (!session || !mentionQuery) return
    const inserted = insertBotanicAgentMention(instruction, mentionQuery, item.label)
    setInstruction(inserted.value)
    if (!session.contextNodeIds.includes(item.id)) onContextChange(session.id, [...session.contextNodeIds, item.id])
    setMentionQuery(undefined)
    requestAnimationFrame(() => {
      composerTextareaRef.current?.focus()
      composerTextareaRef.current?.setSelectionRange(inserted.caret, inserted.caret)
    })
  }

  const beginRuntimeTrace = (input: {
    hasTarget: boolean
    referenceCount: number
    memoryCount: number
    assetGroupCount: number
  }) => {
    const steps = createBotanicAgentRuntimeSteps({
      ...input,
      plannerLabel: agentPlannerModelLabel(plannerModel),
    })
    const firstStep = steps[0]
    const started = firstStep ? updateBotanicAgentRuntimeStep(steps, firstStep.id, 'running') : steps
    setRuntimeSteps(started)
    setRuntimeDetailsOpen(true)
    return started
  }

  const updateRuntimeStep = (
    stepId: string,
    status: BotanicAgentRuntimeStep['status'],
    errorMessage?: string,
  ) => {
    setRuntimeSteps((steps) => updateBotanicAgentRuntimeStep(steps, stepId, status, Date.now(), errorMessage))
  }

  const attachPlannerToolTrace = (plan?: BotanicAgentPlan) => {
    const labels = plan?.toolCalls?.map((call) => call.label).filter(Boolean) ?? []
    if (!labels.length) return
    setRuntimeSteps((steps) => steps.map((step) => step.id === 'call-planner'
      ? { ...step, detail: `已调用：${[...new Set(labels)].join('、')}` }
      : step))
  }

  const yieldRuntimeFrame = () => new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve())
  })

  const completeRuntimeContextReads = async (steps: BotanicAgentRuntimeStep[]) => {
    const contextSteps = steps.filter((step) => step.id !== 'call-planner' && step.id !== 'finalize-plan' && step.id !== 'create-workflow')
    for (const step of contextSteps) {
      updateRuntimeStep(step.id, 'running')
      await yieldRuntimeFrame()
      updateRuntimeStep(step.id, 'succeeded')
    }
  }

  const completeRuntimeTrace = async (hasTarget: boolean) => {
    updateRuntimeStep('call-planner', 'succeeded')
    const finalStepId = hasTarget ? 'finalize-plan' : 'create-workflow'
    updateRuntimeStep(finalStepId, 'running')
    await yieldRuntimeFrame()
    updateRuntimeStep(finalStepId, 'succeeded')
    setRuntimeDetailsOpen(false)
  }

  const failRuntimeTrace = (message: string) => {
    setRuntimeSteps((steps) => {
      const active = steps.find((step) => step.status === 'running')
      return active
        ? updateBotanicAgentRuntimeStep(steps, active.id, 'failed', Date.now(), message)
        : steps
    })
  }

  const preparePlan = async (cleanInstruction: string) => {
    if (!target) return null
    const assetGroup = compatibleGroups.find((group) => group.id === groupId)
    const input = {
      projectId,
      plannerModel,
      instruction: cleanInstruction,
      requestedIntent: intent,
      selectedResultNodeId: target.id,
      selectedResultLabel: target.label,
      rootRecipe: target.rootRecipe,
      assetGroup,
      availableAssetGroups: groups,
      projectMemory: memory,
    }
    plannerControllerRef.current?.abort()
    const controller = new AbortController()
    plannerControllerRef.current = controller
    setPlanning(true)
    setError('')
    updateRuntimeStep('call-planner', 'running')
    try {
      const nextPlan = await requestBotanicAgentPlan(input, controller.signal)
      if (controller.signal.aborted) return
      attachPlannerToolTrace(nextPlan)
      updateRuntimeStep('call-planner', 'succeeded')
      await completeRuntimeTrace(true)
      return nextPlan
    } catch (planError) {
      if (controller.signal.aborted) return
      const canUseLocalFallback = planError instanceof ProductApiError
        && (planError.status === 0 || planError.status === 404 || planError.status >= 500)
      if (canUseLocalFallback) {
        try {
          const fallbackPlan = { ...buildBotanicAgentPlan({
            instruction: cleanInstruction,
            intent,
            selectedResultNodeId: target.id,
            selectedResultLabel: target.label,
            rootRecipe: target.rootRecipe,
            assetGroup,
          }), plannerModel }
          attachPlannerToolTrace(fallbackPlan)
          updateRuntimeStep('call-planner', 'succeeded')
          await completeRuntimeTrace(true)
          return fallbackPlan
        } catch (fallbackError) {
          setError(fallbackError instanceof Error ? fallbackError.message : '暂时无法生成计划。')
        }
      } else {
        setError(planError instanceof Error ? planError.message : '暂时无法生成计划。')
      }
      failRuntimeTrace(planError instanceof Error ? planError.message : '暂时无法生成计划。')
    } finally {
      if (plannerControllerRef.current === controller) plannerControllerRef.current = null
      setPlanning(false)
    }
    return null
  }

  const confirmMessagePlan = async (message: BotanicAgentMessage) => {
    if (!session || !message.plan || message.status === 'submitted') return
    if (message.plan.actions?.some((action) => action.status === 'awaiting_confirmation' || action.status === 'running')) {
      setError('请先确认或跳过行动卡，再执行生成计划。')
      return
    }
    setSubmittingMessageId(message.id)
    setError('')
    try {
      const submission = await onConfirm(message.plan)
      onUpdateMessage(session.id, message.id, { status: submission.started ? 'submitted' : 'failed', runId: submission.runId })
      appendMessage({
        role: 'assistant', kind: submission.started ? 'notice' : 'text', runId: submission.runId,
        content: submission.started ? '任务已提交。结果会直接出现在画布中，你可以继续告诉我下一步要改什么。' : '任务没有启动，请检查参考素材与生成服务后重试。',
      })
    } catch (caught) {
      onUpdateMessage(session.id, message.id, { status: 'failed' })
      setError(caught instanceof Error ? caught.message : '任务未能启动，请稍后重试。')
    } finally {
      setSubmittingMessageId('')
    }
  }

  const confirmAction = async (message: BotanicAgentMessage, action: BotanicAgentActionProposal) => {
    if (!session || executingActionId || action.status === 'running' || action.status === 'succeeded') return
    setExecutingActionId(action.id)
    setError('')
    onUpdateAction(session.id, message.id, action.id, { status: 'running', error: undefined })
    try {
      const result = await onConfirmAction(action)
      onUpdateAction(session.id, message.id, action.id, { status: 'succeeded', result, error: undefined })
      appendMessage({
        role: 'assistant', kind: 'notice',
        content: `${result.message}${result.canvasNodeId ? ' 已写入画布。' : ''}`,
      })
    } catch (caught) {
      const actionError = caught instanceof Error ? caught.message : '行动执行失败，请重试。'
      onUpdateAction(session.id, message.id, action.id, { status: 'failed', error: actionError })
      setError(actionError)
    } finally {
      setExecutingActionId('')
    }
  }

  const sendInstruction = async () => {
    if (!session || planning) return
    const cleanInstruction = instruction.trim()
    if (!cleanInstruction) return
    appendMessage({ role: 'user', kind: 'text', content: cleanInstruction })
    setInstruction('')
    setMentionQuery(undefined)
    setError('')
    setPlanning(true)
    const runtimeTrace = beginRuntimeTrace({
      hasTarget: Boolean(target),
      referenceCount: target?.rootRecipe.references.length ?? contextItems.length,
      memoryCount: memory.length,
      assetGroupCount: compatibleGroups.length,
    })
    await completeRuntimeContextReads(runtimeTrace)
    updateRuntimeStep('call-planner', 'running')
    if (!target) {
      try {
        const result = await onCreateDraft(cleanInstruction, session.contextNodeIds, session.executionMode === 'auto')
        const content = result.started
          ? '已根据画布上下文创建工作流并提交生成，结果会出现在画布中。'
          : result.needsReference
            ? '已在画布创建文字与生成节点。再添加一张商品图或参考图，我就可以继续执行。'
              : result.created
                ? '已在画布创建可编辑的生成工作流，你可以检查节点后手动生成。'
                : '暂时无法创建工作流，请检查画布状态后重试。'
        if (result.created) {
          await completeRuntimeTrace(false)
        } else {
          updateRuntimeStep('call-planner', 'succeeded')
          updateRuntimeStep('create-workflow', 'failed', content)
        }
        appendMessage({ role: 'assistant', kind: result.created ? 'notice' : 'text', content })
      } catch (caught) {
        failRuntimeTrace(caught instanceof Error ? caught.message : '暂时无法创建工作流。')
        setError(caught instanceof Error ? caught.message : '暂时无法创建工作流。')
      } finally {
        setPlanning(false)
      }
      return
    }
    const nextPlan = await preparePlan(cleanInstruction)
    if (!nextPlan || !session) return
    const planMessageId = appendMessage({
      role: 'assistant', kind: 'plan', plan: nextPlan, status: 'pending',
      content: nextPlan.summary,
    })
    if (session.executionMode === 'auto' && planMessageId && !nextPlan.actions?.length) {
      await confirmMessagePlan({
        id: planMessageId, role: 'assistant', kind: 'plan', content: nextPlan.summary,
        createdAt: Date.now(), plan: nextPlan, status: 'pending',
      })
    }
  }

  const toggleArtifactSelection = (artifactId: string) => {
    setSelectedArtifactIds((current) => current.includes(artifactId)
      ? current.filter((id) => id !== artifactId)
      : [...current, artifactId])
  }

  const toggleArtifactGroupSelection = (groupArtifacts: BotanicAgentArtifact[]) => {
    const groupIds = groupArtifacts.map((artifact) => artifact.id)
    setSelectedArtifactIds((current) => {
      const allSelected = groupIds.every((id) => current.includes(id))
      return allSelected
        ? current.filter((id) => !groupIds.includes(id))
        : [...current, ...groupIds.filter((id) => !current.includes(id))]
    })
  }

  const createNextRoundFromSelection = () => {
    if (!selectedResultNodeIds.length) return
    onUseResultContext(selectedResultNodeIds)
    setInstruction(selectedArtifactBatch.artifacts.length === 1
      ? '基于这张结果继续生成：'
      : `基于这 ${selectedArtifactBatch.artifacts.length} 张结果继续生成：`)
    setResultPanelOpen(false)
    requestAnimationFrame(() => composerTextareaRef.current?.focus())
  }

  return (
    <aside className="agent-workspace nopan nowheel" aria-label="Botanic 生图 Agent">
      <header className="agent-workspace__header">
        <div className="agent-workspace__title">
          <button type="button" className="agent-workspace__history-button" onClick={(event) => { historyTriggerRef.current = event.currentTarget; setHistoryOpen((open) => !open) }} aria-controls={historyMenuId} aria-expanded={historyOpen} aria-label="对话历史" title="对话历史"><FigmaIcon src={historyIcon} /></button>
          <button type="button" className="agent-workspace__title-button" onClick={(event) => { historyTriggerRef.current = event.currentTarget; setHistoryOpen((open) => !open) }} aria-controls={historyMenuId} aria-expanded={historyOpen}>{session?.title ?? '新建对话'} <span aria-hidden="true">⌄</span></button>
        </div>
        <div className="agent-workspace__header-actions">
          <button type="button" className={`agent-workspace__skill-button${resultPanelOpen ? ' is-active' : ''}`} aria-pressed={resultPanelOpen} aria-label="结果与文件" title="结果与文件" onClick={(event) => { utilityButtonRef.current = event.currentTarget; setResultPanelOpen((open) => !open); setTaskPanelOpen(false); setSkillPanelOpen(false); setMemoryPanelOpen(false); setHistoryOpen(false) }}><GalleryIcon /><span className="visually-hidden">结果</span></button>
          <button type="button" className={`agent-workspace__skill-button${taskPanelOpen ? ' is-active' : ''}`} aria-pressed={taskPanelOpen} aria-label="生成任务" title="生成任务" onClick={(event) => { utilityButtonRef.current = event.currentTarget; setTaskPanelOpen((open) => !open); setResultPanelOpen(false); setSkillPanelOpen(false); setMemoryPanelOpen(false); setHistoryOpen(false) }}><ChecklistIcon /><span className="visually-hidden">任务</span></button>
          <button type="button" className={`agent-workspace__skill-button${memoryPanelOpen ? ' is-active' : ''}`} aria-pressed={memoryPanelOpen} aria-label="项目记忆" title="项目记忆" onClick={(event) => { utilityButtonRef.current = event.currentTarget; setMemoryPanelOpen((open) => !open); setResultPanelOpen(false); setTaskPanelOpen(false); setSkillPanelOpen(false); setHistoryOpen(false) }}><BookmarkIcon /><span className="visually-hidden">记忆</span></button>
          <button type="button" className={`agent-workspace__skill-button${skillPanelOpen ? ' is-active' : ''}`} aria-pressed={skillPanelOpen} aria-label="创作技能" title="创作技能" onClick={(event) => { utilityButtonRef.current = event.currentTarget; setSkillPanelOpen((open) => !open); setResultPanelOpen(false); setTaskPanelOpen(false); setMemoryPanelOpen(false); setHistoryOpen(false) }}><SparkleIcon /><span className="visually-hidden">技能</span></button>
          <button type="button" className="agent-workspace__close" onClick={onClose} aria-label="收起生图 Agent"><CloseIcon /></button>
        </div>
        {historyOpen ? <div id={historyMenuId} className="agent-workspace__history" aria-label="对话历史">
          <button type="button" onClick={() => { onNewSession(); setHistoryOpen(false) }}><PlusSquareIcon /> 新建对话</button>
          {sessions.map((item) => <button key={item.id} type="button" className={item.id === session?.id ? 'is-active' : ''} onClick={() => { onSelectSession(item.id); setHistoryOpen(false) }}><span>{item.title}</span><small>{item.messages.length} 条</small></button>)}
        </div> : null}
      </header>
      <div className="agent-workspace__messages" role="log" aria-live="polite" aria-relevant="additions text">
        {resultPanelOpen ? <section className="agent-result-panel" aria-label="Agent 结果与文件">
          <header><div><small>AGENT OUTPUTS</small><h2>结果与文件</h2></div><span>{artifacts.length} 项</span></header>
          <p>生成图与 Skill / MCP 产物统一按任务分组；画布节点和版本血缘不变。</p>
          <div className="agent-result-panel__filters" role="group" aria-label="结果类型">
            {([['all', '全部'], ['image', '图片'], ['video', '视频'], ['file', '文件']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={resultFilter === value} className={resultFilter === value ? 'is-active' : ''} onClick={() => setResultFilter(value)}>{label}</button>)}
          </div>
          {selectedArtifactBatch.artifacts.length ? <div className="agent-result-panel__selection" aria-label="批量操作">
            <strong>已选 {selectedArtifactBatch.artifacts.length} 项</strong>
            <div>
              {selectedArtifactBatch.mediaArtifacts.length ? <>
                <button type="button" disabled={selectedArtifactBatch.mediaArtifacts.every((artifact) => artifact.metadata?.savedToLibrary === true)} onClick={() => selectedArtifactBatch.mediaArtifacts.filter((artifact) => artifact.metadata?.savedToLibrary !== true).forEach(onSaveArtifact)}>入库</button>
                <button type="button" onClick={() => void (async () => {
                  for (const artifact of selectedArtifactBatch.mediaArtifacts) {
                    await downloadMedia(artifact.url!, artifact.label, artifact.kind === 'video' ? 'video' : 'image')
                  }
                })()}>下载</button>
              </> : null}
              <button type="button" className="is-primary" disabled={!selectedResultNodeIds.length} onClick={createNextRoundFromSelection}>创建下一轮</button>
              <button type="button" onClick={() => setSelectedArtifactIds([])}>取消</button>
            </div>
          </div> : null}
          <div className="agent-result-panel__groups">
            {artifactGroups.map((group) => <section key={group.id} className="agent-result-group">
              <header><span><strong>{group.label}</strong><small>{group.artifacts.length} 项</small></span><div>
                <button type="button" onClick={() => toggleArtifactGroupSelection(group.artifacts)}>{group.artifacts.every((artifact) => selectedArtifactIds.includes(artifact.id)) ? '取消本组' : '选择本组'}</button>
              </div></header>
              <div className="agent-result-panel__grid">
                {group.artifacts.map((artifact) => <article key={artifact.id} className={selectedArtifactIds.includes(artifact.id) ? 'is-selected' : ''}>
                  <button type="button" className="agent-result-panel__select" aria-pressed={selectedArtifactIds.includes(artifact.id)} aria-label={`${selectedArtifactIds.includes(artifact.id) ? '取消选择' : '选择'} ${artifact.label}`} onClick={() => toggleArtifactSelection(artifact.id)}>{selectedArtifactIds.includes(artifact.id) ? '✓' : ''}</button>
                  {artifact.url && (artifact.kind === 'image' || artifact.kind === 'video') ? <div className="agent-result-panel__preview">
                    {artifact.kind === 'image' ? <img src={artifact.url} alt="" /> : <video src={artifact.url} muted playsInline />}
                  </div> : <div className="agent-result-panel__document"><span>{artifact.kind === 'workflow' ? '⌘' : 'Aa'}</span><p>{artifact.content ?? artifact.label}</p></div>}
                  <div className="agent-result-panel__meta"><span><strong>{artifact.label}</strong><small>{agentArtifactKindLabel(artifact)} · {artifact.provenance.toolName}</small></span><div>
                    {artifact.provenance.sourceNodeIds?.[0] ? <button type="button" aria-label={`在画布定位 ${artifact.label}`} title="在画布定位" onClick={() => onLocateNode(artifact.provenance.sourceNodeIds![0])}><FocusIcon /></button> : null}
                    {artifact.url && (artifact.kind === 'image' || artifact.kind === 'video') ? <button type="button" aria-label={`下载 ${artifact.label}`} title="下载" onClick={() => void downloadMedia(artifact.url!, artifact.label, artifact.kind === 'video' ? 'video' : 'image')}><DownloadIcon /></button> : artifact.url ? <a href={artifact.url} target="_blank" rel="noreferrer" aria-label={`打开 ${artifact.label}`} title="打开"><ArrowUpRightIcon /></a> : null}
                    {artifact.url && (artifact.kind === 'image' || artifact.kind === 'video') ? <button type="button" aria-label={artifact.metadata?.savedToLibrary === true ? `${artifact.label} 已入库` : `将 ${artifact.label} 入库`} title={artifact.metadata?.savedToLibrary === true ? '已入库' : '存入素材库'} disabled={artifact.metadata?.savedToLibrary === true} onClick={() => onSaveArtifact(artifact)}><FolderOutlineIcon /></button> : null}
                  </div></div>
                </article>)}
              </div>
            </section>)}
            {!filteredArtifacts.length ? <div className="agent-skill-panel__empty">还没有该类型结果。生成或执行 Skill / MCP 后会自动汇总。</div> : null}
          </div>
        </section> : null}
        {memoryPanelOpen ? <section className="agent-memory-panel" aria-label="项目创作记忆">
          <header><div><small>PROJECT MEMORY</small><h2>项目记忆</h2></div><span>{memory.length} 条</span></header>
          <p>仅用于当前项目的后续规划；保存品牌规则、认可方向与禁区。</p>
          <div className="agent-memory-panel__form">
            <BotanicSelect value={memoryKind} ariaLabel="记忆类型" options={[
              { value: 'rule', label: '长期规则' },
              { value: 'approved', label: '已确认方向' },
              { value: 'avoid', label: '避免事项' },
            ]} onChange={(value) => setMemoryKind(value as BotanicAgentMemoryKind)} />
            <textarea value={memoryDraft} maxLength={500} onChange={(event) => setMemoryDraft(event.target.value)} placeholder="例如：商品包装与品牌色不可改变" aria-label="项目记忆内容" />
            <button type="button" disabled={!memoryDraft.trim()} onClick={saveMemory}>保存记忆</button>
          </div>
          <div className="agent-memory-panel__list">
            {memory.map((item) => <article key={item.id} className={`is-${item.kind}`}><span><small>{agentMemoryKindLabel(item.kind)}</small><p>{item.content}</p></span><div>{item.sourceNodeIds[0] ? <button type="button" aria-label={`在画布定位记忆 ${item.content}`} title="在画布定位" onClick={() => onLocateNode(item.sourceNodeIds[0])}><FocusIcon /></button> : null}<button type="button" className="is-delete" aria-label={`删除记忆 ${item.content}`} title="删除记忆" onClick={() => onRemoveMemory(item.id)}><DeleteIcon /></button></div></article>)}
            {!memory.length ? <div className="agent-skill-panel__empty">还没有项目记忆。</div> : null}
          </div>
        </section> : null}
        {taskPanelOpen ? <section className="agent-task-panel" aria-label="Agent 任务与结果">
          <header><div><small>AGENT RUNS</small><h2>任务与结果</h2></div><span>{runs.length} 个</span></header>
          <p>查看所有分支状态；失败分支可单独重试，不会覆盖已完成结果。</p>
          <div className="agent-task-panel__list">
            {runs.map((run) => <article key={run.id} className={`is-${run.status}`}>
              <header><span><strong>{run.plan.summary}</strong><small>{run.status === 'completed' ? '已完成' : run.status === 'partial' ? '部分完成' : run.status === 'failed' ? '失败' : run.status === 'cancelled' ? '已取消' : '处理中'}</small></span><div>{run.status === 'queued' || run.status === 'running' || run.status === 'executing' ? <button type="button" className="agent-icon-button agent-icon-button--danger" aria-label="取消任务" title="取消任务" disabled={cancellingRunId === run.id} onClick={() => { setCancellingRunId(run.id); void onCancelRun(run.id).finally(() => setCancellingRunId('')) }}>{cancellingRunId === run.id ? <span className="agent-workspace__mini-spinner" /> : <CloseIcon />}</button> : null}<b>{run.completedBranchCount}/{run.branches.length}</b></div></header>
              <div className="agent-run-card__track" aria-hidden="true"><i style={{ width: `${run.branches.length ? Math.round(run.completedBranchCount / run.branches.length * 100) : 0}%` }} /></div>
              <div className="agent-task-panel__summary" aria-label="分支状态汇总"><span><b>{run.branches.filter((branch) => branch.status === 'succeeded').length}</b>完成</span><span><b>{run.branches.filter((branch) => branch.status === 'running').length}</b>生成中</span><span><b>{run.branches.filter((branch) => branch.status === 'queued').length}</b>排队</span><span><b>{run.branches.filter((branch) => branch.status === 'failed' || branch.status === 'cancelled').length}</b>失败</span></div>
              <div className="agent-task-panel__matrix" aria-label="批量分支矩阵">{run.branches.map((branch, index) => <div key={branch.id} className={`is-${branch.status}`} title={`${branch.label} · ${branch.status}`}><span>{index + 1}</span><small>{branch.label}</small></div>)}</div>
              {run.branches.filter((branch) => branch.status === 'failed' || branch.status === 'cancelled').map((branch) => <div className="agent-task-panel__branch" key={branch.id}><span><strong>{branch.label}</strong><small>{branch.error ?? '该分支未完成'}</small></span><button type="button" className="agent-icon-button" aria-label={`重试 ${branch.label}`} title="重试" disabled={retryingBranchId === branch.id} onClick={() => { setRetryingBranchId(branch.id); void onRetryBranch(run.id, branch.id).finally(() => setRetryingBranchId('')) }}>{retryingBranchId === branch.id ? <span className="agent-workspace__mini-spinner" /> : <RefreshIcon />}</button></div>)}
            </article>)}
            {!runs.length ? <div className="agent-skill-panel__empty">还没有 Agent 任务。</div> : null}
          </div>
        </section> : null}
        {skillPanelOpen ? <section className="agent-skill-panel" aria-label="项目 Skill">
          <header><div><small>PROJECT SKILLS</small><h2>创作技能</h2></div><span>{skills.length} 个</span></header>
          <p>把常用的锁定项和创作规则保存到当前项目，Agent 规划时可自动调用。</p>
          <div className="agent-skill-panel__form">
            <input value={skillName} onChange={(event) => { setSkillName(event.target.value); setSkillConfirming(false); setSkillError('') }} maxLength={80} placeholder="技能名称，例如：夏日换景" aria-label="Skill 名称" />
            <textarea value={skillInstructions} onChange={(event) => { setSkillInstructions(event.target.value); setSkillConfirming(false); setSkillError('') }} maxLength={4000} placeholder="描述必须保持什么、允许改变什么，以及结果规则。" aria-label="Skill 规则" />
            {skillConfirming ? <div className="agent-skill-panel__confirm">
              <span><strong>创建项目 Skill</strong><small>将写入当前项目，之后可被 Agent 调用。</small></span>
              <div><button type="button" autoFocus onClick={() => { setSkillConfirming(false); requestAnimationFrame(() => skillCreateButtonRef.current?.focus()) }}>取消</button><button type="button" disabled={skillSaving} onClick={() => void confirmSkillCreation()}>{skillSaving ? '创建中…' : '确认创建'}</button></div>
            </div> : <button ref={skillCreateButtonRef} type="button" className="agent-skill-panel__create" disabled={!skillName.trim() || !skillInstructions.trim()} onClick={() => setSkillConfirming(true)}>创建 Skill</button>}
            {skillError ? <p role="alert">{skillError}</p> : null}
          </div>
          <div className="agent-skill-panel__list">
            {skills.map((skill) => <article key={skill.id}><strong>{skill.name}</strong><p>{skill.instructions}</p><small>项目 Skill · 可自动调用</small></article>)}
            {!skills.length && !skillError ? <div className="agent-skill-panel__empty">还没有项目 Skill。</div> : null}
          </div>
        </section> : null}
        {!utilityPanelOpen && !hasMessages ? <section className="agent-workspace__welcome">
          <span className="agent-workspace__mark"><SparkleIcon /></span>
          <small>BOTANIC AGENT</small>
          <h2>{target ? `继续优化「${target.label}」` : '今天一起创作什么？'}</h2>
          <p>{target ? '我会继承当前图片与原始配方，只改变你明确提出的内容。' : '描述目标，或先把画布上的商品、模特和场景加入上下文。'}</p>
          <div className="agent-workspace__starters">
            {agentQuickActions.slice(0, 3).map((action) => <button key={action.intent} type="button" onClick={() => { setIntent(action.intent); setInstruction(action.instruction) }}><strong>{action.label}</strong><span>{action.instruction}</span></button>)}
          </div>
        </section> : null}
        {!utilityPanelOpen ? session?.messages.map((message) => <article key={message.id} className={`agent-message is-${message.role} is-${message.kind}`}>
          <div className="agent-message__role">{message.role === 'assistant' ? <SparkleIcon /> : <span>你</span>}</div>
          <div className="agent-message__body">
            <p>{message.content}</p>
            <div className="agent-message__utilities">
              {message.role === 'user' ? <button type="button" aria-label="编辑消息" title="编辑消息" onClick={() => { setInstruction(message.content); requestAnimationFrame(() => composerTextareaRef.current?.focus()) }}><EditIcon /></button> : null}
              {message.role === 'assistant' && session ? <>
                <button type="button" className={message.feedback === 'positive' ? 'is-selected' : ''} aria-label="这个回答有帮助" title="有帮助" onClick={() => onUpdateMessage(session.id, message.id, { feedback: message.feedback === 'positive' ? undefined : 'positive' })}><ThumbUpIcon /></button>
                <button type="button" className={message.feedback === 'negative' ? 'is-selected' : ''} aria-label="这个回答需要改进" title="需改进" onClick={() => onUpdateMessage(session.id, message.id, { feedback: message.feedback === 'negative' ? undefined : 'negative' })}><ThumbDownIcon /></button>
              </> : null}
              <button type="button" aria-label="复制消息" title="复制消息" onClick={() => void navigator.clipboard.writeText(message.content)}><CopyIcon /></button>
            </div>
            {message.plan ? <div className="agent-message__plan">
              {message.plan.toolCalls?.length ? <div className="agent-message__tools" aria-label="Agent 工具调用">
                {message.plan.toolCalls.map((call) => <div key={call.id} className={`agent-message__tool is-${call.status}`}>
                  <span aria-hidden="true">↳</span><strong>{call.label}</strong><small>{agentToolStatusLabel(call.status)}</small>
                </div>)}
              </div> : null}
              {message.plan.actions?.length ? <div className="agent-message__actions" aria-label="待确认行动">
                {message.plan.actions.map((action) => <article key={action.id} className={`agent-action-card is-${action.status}`}>
                  <header><span>{action.kind === 'skill' ? 'SKILL' : 'MCP'}</span><small>{action.risk === 'external' ? '外部调用' : action.toolName === 'skill_create' ? '写入项目' : '写入画布'}</small></header>
                  <strong>{action.label}</strong>
                  <p>{action.summary}</p>
                  <div className="agent-action-card__impact"><span>输入</span><b>{action.toolName === 'mcp_call' ? `${String(action.arguments.server)}.${String(action.arguments.tool)}` : action.toolName === 'skill_create' ? '新项目 Skill' : '当前项目 Skill'}</b><span>输出</span><b>{action.toolName === 'mcp_call' ? '文件 / 画布节点' : action.toolName === 'skill_create' ? '可复用 Skill' : '工作流规则节点'}</b></div>
                  <details className="agent-action-card__details"><summary>查看执行内容</summary><pre>{JSON.stringify(action.arguments, null, 2)}</pre></details>
                  {action.error ? <small className="agent-action-card__error">{action.error}</small> : null}
                  {action.status === 'succeeded' ? <div className="agent-action-card__result"><span>已执行</span>{action.result?.canvasNodeIds?.length ? <small>已创建 {action.result.canvasNodeIds.length} 个画布节点</small> : action.result?.artifacts?.length ? <small>已产出 {action.result.artifacts.length} 项</small> : null}{action.result?.canvasNodeId ? <button type="button" className="agent-icon-button" aria-label="在画布定位结果" title="在画布定位" onClick={() => onLocateNode(action.result!.canvasNodeId!)}><FocusIcon /></button> : null}</div> : null}
                  {action.status === 'dismissed' ? <span className="agent-action-card__dismissed">已跳过</span> : null}
                  {action.status === 'running' ? <span className="agent-action-card__running">执行中…</span> : null}
                  {action.status === 'awaiting_confirmation' || action.status === 'failed' ? <div className="agent-action-card__buttons">
                    {action.status === 'awaiting_confirmation' ? <button type="button" className="is-secondary" onClick={() => session && onUpdateAction(session.id, message.id, action.id, { status: 'dismissed' })}>跳过</button> : null}
                    <button type="button" disabled={executingActionId === action.id} onClick={() => void confirmAction(message, action)}>{executingActionId === action.id ? '执行中…' : action.status === 'failed' ? '重试' : '确认执行'}</button>
                  </div> : null}
                </article>)}
              </div> : null}
              <div className="agent-message__constraints">
                {message.plan.constraints.map((constraint) => <span key={constraint.dimension} className={constraint.mode === 'preserve' ? 'is-locked' : 'is-variable'}>{constraint.mode === 'preserve' ? '锁定' : '变化'} · {creativeDimensionLabel(constraint.dimension)}</span>)}
              </div>
              <small>{message.plan.references.length} 个输入 · {message.plan.output.mode === 'batch_by_asset' ? `${message.plan.output.count} 个分支` : '1 个新版本'}</small>
              <details className="agent-message__route"><summary>执行路由</summary><div><span>规划</span><b>{agentPlannerModelLabel(message.plan.plannerModel ?? plannerModel)}</b><span>生成</span><b>{message.plan.settings.model}</b><span>外部行动</span><b>{message.plan.actions?.length ? `${message.plan.actions.length} 项，确认后执行` : '无'}</b></div></details>
              {message.status !== 'submitted' ? <button type="button" disabled={submittingMessageId === message.id || message.plan.actions?.some((action) => action.status === 'awaiting_confirmation' || action.status === 'running')} onClick={() => void confirmMessagePlan(message)}>{submittingMessageId === message.id ? '正在提交…' : message.plan.actions?.some((action) => action.status === 'awaiting_confirmation' || action.status === 'running') ? '先处理行动卡' : message.status === 'failed' ? '重新执行' : '确认生成'}</button> : <span className="agent-message__submitted">已提交</span>}
            </div> : null}
          </div>
        </article>) : null}
        {!utilityPanelOpen && runtimeSteps.length ? (() => {
          const activeStep = runtimeSteps.find((step) => step.status === 'running')
          const completedCount = runtimeSteps.filter((step) => step.status === 'succeeded').length
          const statusLabel = planning
            ? activeStep ? `正在${activeStep.label}` : 'Agent 正在工作'
            : runtimeFailed ? 'Agent 运行未完成' : 'Agent 已完成'
          const summary = planning
            ? `${completedCount}/${runtimeSteps.length} 项已完成`
            : runtimeFailed ? '已保留失败位置，可修改要求后重试' : `${runtimeSteps.length} 项操作已记录`
          return <section className={`agent-runtime-feed${runtimeFailed ? ' is-failed' : runtimeComplete ? ' is-complete' : ''}`} role="status" aria-live={planning ? 'polite' : undefined} aria-label="Agent 运行记录">
            <header className="agent-runtime-feed__header">
              <span className="agent-runtime-feed__status">
                <span className="agent-runtime-feed__mark" aria-hidden="true">
                  {planning && !runtimeFailed ? <span className="agent-composer__spinner" /> : runtimeFailed ? '!' : '✓'}
                </span>
                <strong>{statusLabel}</strong>
              </span>
              <button type="button" className="agent-runtime-feed__toggle" aria-expanded={runtimeDetailsOpen} onClick={() => setRuntimeDetailsOpen((open) => !open)}>
                {runtimeDetailsOpen ? '收起' : '查看记录'}
              </button>
            </header>
            <p className="agent-runtime-feed__summary">{activeStep?.detail ?? summary}</p>
            {runtimeDetailsOpen ? <ol aria-label="运行步骤">
              {runtimeSteps.map((step) => <li key={step.id} className={`is-${step.status}`}>
                <span className="agent-runtime-feed__step-marker" aria-hidden="true">{agentRuntimeStepMarker(step)}</span>
                <span className="agent-runtime-feed__step-copy"><strong>{step.status === 'running' ? `正在${step.label}` : step.label}</strong><small>{step.error ?? step.detail}</small></span>
                <em>{agentRuntimeStepStatusLabel(step.status)}</em>
              </li>)}
            </ol> : null}
          </section>
        })() : null}
        {!utilityPanelOpen && latestRun?.branches.length ? <section className="agent-run-card" aria-label="Agent Run 实时进度">
          <header><span><strong>生成任务</strong><small>{latestRun.status === 'completed' ? '已完成' : latestRun.status === 'partial' ? '部分完成' : latestRun.status === 'failed' ? '失败' : latestRun.status === 'cancelled' ? '已取消' : '处理中'}</small></span><div>{latestRun.status === 'queued' || latestRun.status === 'running' || latestRun.status === 'executing' ? <button type="button" className="agent-icon-button agent-icon-button--danger" aria-label="取消任务" title="取消任务" disabled={cancellingRunId === latestRun.id} onClick={() => { setCancellingRunId(latestRun.id); setError(''); void onCancelRun(latestRun.id).then((ok) => { if (!ok) setError('任务取消失败，请稍后重试。') }).finally(() => setCancellingRunId('')) }}>{cancellingRunId === latestRun.id ? <span className="agent-workspace__mini-spinner" /> : <CloseIcon />}</button> : null}<b>{latestRun.completedBranchCount}/{latestRun.branches.length}</b></div></header>
          <div className="agent-run-card__track" aria-hidden="true"><i style={{ width: `${Math.round(latestRun.completedBranchCount / latestRun.branches.length * 100)}%` }} /></div>
          <div className="agent-run-card__branches">
            {latestRun.branches.map((branch) => <div key={branch.id}><span><strong>{branch.label}</strong><small>{branch.status === 'succeeded' ? '已完成' : branch.status === 'running' ? '生成中' : branch.status === 'queued' ? '排队中' : branch.status === 'cancelled' ? '已取消' : '失败'}</small></span>{branch.status === 'failed' || branch.status === 'cancelled' ? <button type="button" className="agent-icon-button" aria-label={`重试 ${branch.label}`} title="重试" disabled={retryingBranchId === branch.id} onClick={() => { setRetryingBranchId(branch.id); setError(''); void onRetryBranch(latestRun.id, branch.id).then((ok) => { if (!ok) setError(`「${branch.label}」重试失败，请稍后再试。`) }).finally(() => setRetryingBranchId('')) }}>{retryingBranchId === branch.id ? <span className="agent-workspace__mini-spinner" /> : <RefreshIcon />}</button> : null}</div>)}
          </div>
        </section> : null}
        <div ref={messageEndRef} />
      </div>
      {!utilityPanelOpen ? <div className="agent-composer">
        {contextItems.length ? <div className="agent-composer__context">{contextItems.map((item) => <button key={item.id} type="button" aria-label={`移除 ${item.label}`} onClick={() => session && onContextChange(session.id, session.contextNodeIds.filter((id) => id !== item.id))}>{item.image ? <img src={item.image} alt="" /> : <span>{item.kind.slice(0, 1)}</span>}<b>{item.label}</b><i aria-hidden="true">×</i></button>)}</div> : null}
        {mentionQuery ? <div className="agent-composer__mention-menu" role="group" aria-label="引用画布内容">
          {mentionOptions.map((item) => <button key={item.id} type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => selectMention(item)}>{item.image ? <img src={item.image} alt="" /> : <span>{item.kind.slice(0, 1)}</span>}<b>{item.label}</b><small>{item.kind}</small></button>)}
          {!mentionOptions.length ? <p>没有匹配的画布内容</p> : null}
        </div> : null}
        <textarea ref={composerTextareaRef} value={instruction} onChange={(event) => { const value = event.target.value; setInstruction(value); setMentionQuery(readBotanicAgentMentionQuery(value, event.target.selectionStart ?? value.length)); setError('') }} onClick={(event) => setMentionQuery(readBotanicAgentMentionQuery(instruction, event.currentTarget.selectionStart ?? instruction.length))} onKeyDown={(event) => {
          if (event.key === 'Escape' && mentionQuery) { event.preventDefault(); setMentionQuery(undefined); return }
          if (event.key === 'Enter' && mentionQuery && mentionOptions[0]) { event.preventDefault(); selectMention(mentionOptions[0]); return }
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendInstruction() }
        }} placeholder="描述创意或需求，@ 引用画布内容" aria-label="Agent 创作要求" />
        {error ? <p className="agent-composer__error" role="alert">{error}</p> : null}
        <div className="agent-composer__toolbar">
          <div>
            <button ref={contextMenuButtonRef} type="button" className="agent-composer__add" onClick={() => setContextMenuOpen((open) => !open)} aria-controls={contextMenuId} aria-expanded={contextMenuOpen} aria-label="添加画布内容"><PlusSquareIcon /></button>
            <button ref={modeMenuButtonRef} type="button" className="agent-composer__mode" onClick={() => setModeMenuOpen((open) => !open)} aria-controls={modeMenuId} aria-expanded={modeMenuOpen}>{session?.executionMode === 'auto' ? '自动执行' : '手动确认'} <span aria-hidden="true">⌄</span></button>
            <BotanicSelect className="agent-composer__model-select" value={plannerModel} ariaLabel="Agent 规划模型" menuWidth={220} options={plannerModels.map((model) => ({ value: model, label: agentPlannerModelLabel(model) }))} onChange={setPlannerModel} />
            {compatibleGroups.length ? <BotanicSelect className="agent-composer__group-select" value={groupId} placeholder="素材组" ariaLabel="批量素材组" options={[{ value: '', label: '单张' }, ...compatibleGroups.map((group) => ({ value: group.id, label: `${group.name} · ${group.assetIds.length}` }))]} onChange={setGroupId} /> : null}
          </div>
          <button type="button" className="agent-composer__send" disabled={!instruction.trim() || planning || !session} onClick={() => void sendInstruction()} aria-label="发送给 Agent">{planning ? <span className="agent-composer__spinner" /> : <ArrowUpIcon />}</button>
        </div>
        {contextMenuOpen ? <div id={contextMenuId} className="agent-composer__context-menu" role="group" aria-label="添加画布内容">
          <header><strong>添加画布内容</strong><button type="button" aria-label="关闭添加画布内容" onClick={() => { setContextMenuOpen(false); requestAnimationFrame(() => contextMenuButtonRef.current?.focus()) }}><CloseIcon /></button></header>
          {contextOptions.length ? contextOptions.map((item) => { const selected = session?.contextNodeIds.includes(item.id); return <button key={item.id} type="button" className={selected ? 'is-selected' : ''} onClick={() => { if (!session) return; onContextChange(session.id, selected ? session.contextNodeIds.filter((id) => id !== item.id) : [...session.contextNodeIds, item.id]) }}>{item.image ? <img src={item.image} alt="" /> : <span>{item.kind.slice(0, 1)}</span>}<b>{item.label}</b><small>{item.kind}</small></button> }) : <p>画布还没有可引用的内容。</p>}
        </div> : null}
        {modeMenuOpen ? <div id={modeMenuId} className="agent-composer__mode-menu" role="group" aria-label="执行模式">
          <button type="button" className={session?.executionMode === 'manual' ? 'is-selected' : ''} onClick={() => { if (session) onExecutionModeChange(session.id, 'manual'); setModeMenuOpen(false); requestAnimationFrame(() => modeMenuButtonRef.current?.focus()) }}><strong>手动确认</strong><small>执行生成前先确认锁定项</small></button>
          <button type="button" className={session?.executionMode === 'auto' ? 'is-selected' : ''} onClick={() => { if (session) onExecutionModeChange(session.id, 'auto'); setModeMenuOpen(false); requestAnimationFrame(() => modeMenuButtonRef.current?.focus()) }}><strong>自动执行</strong><small>规划完成后直接创建任务</small></button>
        </div> : null}
      </div> : null}
    </aside>
  )
}

function App() {
  const [state, setState] = useState<'checking' | 'sign-in' | 'password-setup' | 'ready' | 'error'>(() => serverPersistenceEnabled ? 'checking' : 'ready')
  const [user, setUser] = useState<ProductUser | null>(null)
  const [accessToken, setAccessToken] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirmation, setPasswordConfirmation] = useState('')
  const [authMethod, setAuthMethod] = useState<'account' | 'legacy'>('account')
  const [needsPasswordSetup] = useState(() => productPasswordSetupRequired())
  const [message, setMessage] = useState('')
  const useLegacyToken = hybridAuthEnabled && authMethod === 'legacy'

  useEffect(() => subscribeProductSessionInvalidated((invalidationMessage) => {
    setUser(null)
    setMessage(invalidationMessage)
    setState('sign-in')
  }), [])

  useEffect(() => {
    if (!serverPersistenceEnabled) return
    let active = true
    let settled = false
    // Supabase 本地会话或 Cookie 同步异常时，不能让整个应用永久停在“正在进入”。
    const restoreTimeout = window.setTimeout(() => {
      if (!active || settled) return
      settled = true
      setMessage('登录恢复超时，请重新登录。')
      setState('sign-in')
    }, 32_000)
    void readProductSession()
      .then((session) => {
        if (!active || settled) return
        settled = true
        window.clearTimeout(restoreTimeout)
        if (session) {
          setUser(session)
          setState(needsPasswordSetup ? 'password-setup' : 'ready')
        } else {
          setState('sign-in')
        }
      })
      .catch((error) => {
        if (!active || settled) return
        settled = true
        window.clearTimeout(restoreTimeout)
        setMessage(error instanceof Error ? error.message : '无法连接工作区服务。')
        setState('error')
      })
    return () => {
      active = false
      window.clearTimeout(restoreTimeout)
    }
  }, [needsPasswordSetup])

  const signIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!accessToken.trim() || (!useLegacyToken && supabaseAuthEnabled && !password)) return
    setState('checking')
    setMessage('')
    try {
      const session = await createProductSession(useLegacyToken
        ? { accessToken: accessToken.trim() }
        : supabaseAuthEnabled
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

  const signOut = async () => {
    setMessage('')
    try {
      await clearProductSession()
    } catch (error) {
      setMessage(error instanceof ProductApiError ? error.message : '退出失败，请稍后重试。')
    } finally {
      setUser(null)
      setState('sign-in')
    }
  }

  const completePasswordSetup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (password.length < 8 || password !== passwordConfirmation) return
    setState('checking')
    setMessage('')
    try {
      await completeProductPasswordSetup(password)
      setPassword('')
      setPasswordConfirmation('')
      setState('ready')
    } catch (error) {
      setMessage(error instanceof ProductApiError ? error.message : '密码未保存，请稍后重试。')
      setState('password-setup')
    }
  }

  if (state === 'ready') return <CanvasWorkspace currentUser={user ?? undefined} onSignOut={serverPersistenceEnabled ? signOut : undefined} />

  return (
    <main className="product-access" aria-live="polite">
      <section>
        <span>BOTANIC</span>
        <h1>{state === 'checking' ? '正在进入…' : state === 'password-setup' ? '设置登录密码' : '登录工作台'}</h1>
        {state === 'checking' ? <p>正在同步你的工作区。</p> : (
          state === 'password-setup' ? <form onSubmit={completePasswordSetup}>
            <p>邀请已确认。设置密码后，下次可直接使用邮箱登录。</p>
            <label><span>新密码</span><input autoComplete="new-password" type="password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 8 个字符" /></label>
            <label><span>确认密码</span><input autoComplete="new-password" type="password" minLength={8} value={passwordConfirmation} onChange={(event) => setPasswordConfirmation(event.target.value)} placeholder="再输入一次" /></label>
            {passwordConfirmation && password !== passwordConfirmation ? <small role="alert">两次输入的密码不一致。</small> : message ? <small role="alert">{message}</small> : null}
            <button type="submit" disabled={password.length < 8 || password !== passwordConfirmation}>保存并进入工作台</button>
          </form> : <form onSubmit={signIn}>
            <p>{useLegacyToken ? '迁移期间仍可使用原访问令牌。' : supabaseAuthEnabled ? '使用工作区账号登录。' : '输入管理员提供的访问令牌。'}</p>
            <label>
              <span>{useLegacyToken ? '访问令牌' : supabaseAuthEnabled ? '邮箱' : '访问令牌'}</span>
              <input autoComplete={useLegacyToken || !supabaseAuthEnabled ? 'current-password' : 'email'} type={useLegacyToken || !supabaseAuthEnabled ? 'password' : 'email'} value={accessToken} onChange={(event) => setAccessToken(event.target.value)} placeholder={useLegacyToken || !supabaseAuthEnabled ? '粘贴访问令牌' : 'name@company.com'} />
            </label>
            {supabaseAuthEnabled && !useLegacyToken ? <label>
              <span>密码</span>
              <input autoComplete="current-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="输入密码" />
            </label> : null}
            {message ? <small role="alert">{message}</small> : null}
            <button type="submit">进入工作台</button>
            {hybridAuthEnabled ? <button className="product-access__alternate" type="button" onClick={() => {
              setAuthMethod(useLegacyToken ? 'account' : 'legacy')
              setAccessToken('')
              setPassword('')
              setMessage('')
            }}>{useLegacyToken ? '返回邮箱登录' : '使用旧访问令牌'}</button> : null}
          </form>
        )}
        {user ? <small>{user.name}</small> : null}
      </section>
    </main>
  )
}

export default App
