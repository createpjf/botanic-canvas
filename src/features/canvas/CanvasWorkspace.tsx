import { lazy, Suspense, type CSSProperties, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import { defaultGenerationModels } from '../../domain/canvas'
import { settingsForGenerationModel } from '../../domain/generationRecipe'
import { collectBotanicAgentResults, mergeBotanicAgentArtifactIndex, recordBotanicAgentCanvasWritebacks, resolveBotanicAgentCanvasCommands, shouldRecoverAgentRunResults, type BotanicAgentActionProposal, type BotanicAgentActionResult, type BotanicAgentCanvasWriteback, type BotanicAgentPlan } from '../../domain/agent'
import { collectAgentMediaSources, prepareAgentMediaSources } from '../../domain/agentMedia'
import { canvasZoomMode, generationTaskErrorMessage, generationTaskFeedback, planResultGroupPresentation, traceCanvasLineage, type ResultGroupPresentation } from '../../domain/canvasPresentation'
import { buildDeliveryPreviewArtifacts, canUseForImageDelivery, resolveDeliveryDraft, type DeliveryPanelTarget } from '../../domain/deliveryPresentation'
import { reducedAspectRatio } from '../../domain/mediaPresentation'
import { mediaRetryUrl } from '../../domain/mediaRecovery'
import { shouldRefreshFromRealtimeEvent } from '../../domain/realtimeSync'
import { videoAspectRatioPolicy } from '../../domain/videoGeneration'
import { beginCanvasFileDrag, endCanvasFileDrag, hasFileDragPayload } from '../../domain/canvasFileDrag'
import { canvasNodeBounds, layoutCanvasNodes } from '../../domain/canvasNodeLayout'
import { nextExclusiveSurface, type ExclusiveSurfaceAction } from '../../domain/exclusiveSurface'
import { createLatestOperation } from '../../domain/latestOperation'
import { topOverlayLayer } from '../../domain/overlayPriority'
import { summarizeWorkflowTemplate, type WorkflowTemplateSummary } from '../../domain/workflowTemplates'
import { useMotionPresence, useRestoreFocus, useRetainedValue, type MotionPhase } from '../../components/motionPresence'
import { AccountDetailsDialog, AccountMenu, WorkspaceAuditDialog, WorkspaceMembersDialog, type AccountMenuAnchor } from '../../components/AccountCenter'
import { useDialogFocusTrap } from '../../components/useDialogFocusTrap'
import { BotanicSelect } from '../../components/BotanicSelect'
import { defaultAgentPlannerModels, modelDisplayLabel, modelProviderLogo } from '../../components/generationModelPresentation'
import type {
  AssetRecord,
  AssetGroup,
  AssetRole,
  AssetSource,
  AssetNodeData,
  BatchVariationRun,
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
} from '../../domain/canvas'
import { deliveryPresets, downloadDeliveryPackage } from '../../lib/deliveryExport'
import { downloadMedia } from '../../lib/mediaDownload'
import { maxUploadAssets, readUploadedAssetInput, validateUploadFiles } from '../../lib/uploadedAssets'
import { createPersistentBotanicAgentRun, executePersistentBotanicAgentRun, executeProjectAgentAction, listPersistentBotanicAgentRuns, listProjectAgentArtifacts, persistAgentReferenceMedia } from '../../lib/agentApi'
import { getGenerationServiceHealth } from '../../lib/generationApi'
import { refinePrompt } from '../../lib/promptRefinementApi'
import { connectCanvasCollaboration, type CanvasCollaboration } from '../../lib/projectCollaboration'
import { createCanvasProject, deleteCanvasDocument, flushPendingCanvasDocumentWrites, readCanvasProjectSummaries, refreshCanvasDocumentFromRemote, renameCanvasProject, syncPendingCanvasDrafts } from '../../lib/db'
import { enrollProductMfa, inviteWorkspaceMember, listWorkspaceAuditEvents, listWorkspaceMembers, readProductMfaStatus, refreshProductMediaSession, removeProductMfa, resendWorkspaceMemberInvite, serverPersistenceEnabled, signOutOtherProductSessions, updateProductPassword, updateWorkspaceMember, verifyProductMfa, type ProductUser } from '../../lib/productSession'
import { createEmptyCanvasDocument } from '../../data/seed'
import { useCanvasStore } from '../../store/canvasStore'
import type { WorkspaceProject } from '../../components/WorkspaceViews'
import { ArrowUpRightIcon, CloseIcon, DeleteIcon, DownloadIcon, FigmaIcon, FocusIcon, FolderOutlineIcon, HomeIcon, MapIcon, MoreIcon, PlusSquareIcon, SparkleIcon, UploadIcon } from '../../components/BotanicIcons'
import type { AgentArtifactIndexState, AgentContextItem, AgentDockTarget } from '../../features/agent/agentWorkspace.types'
import {
  sameWorkspaceLocation,
  workspaceHash,
  workspaceLocationFromHash,
  type WorkspaceLocation,
  type WorkspaceView,
} from './canvasWorkspaceNavigation'
import {
  AssetLibrary,
  BatchVariationComposer,
  BatchVariationProgress,
  ConfirmationDialog,
  DeliveryPanel,
  GenerationPanel,
  HistoryPanel,
  NodeReferencePanel,
  TemplatePanel,
  UndoToast,
  type BatchVariationRequest,
  type GeneratedHistoryItem,
} from './CanvasWorkspacePanels'
import { CanvasComposer, canvasNodeTypes, type ComposerLayout, type ResultGroupCandidateUi, type ResultNodeUiData } from './CanvasEditorViews'
import plusIcon from '../../assets/figma/icon-plus.svg'
import folderIcon from '../../assets/figma/icon-folder.svg'
import templatesIcon from '../../assets/figma/icon-templates.svg'
import historyIcon from '../../assets/figma/icon-history.svg'
import resultImage from '../../assets/figma/result.webp'

// 项目库与经营驾驶舱不参与画布编辑。按路由加载，避免直接打开画布时额外解析首页内容。
const OperatingDashboard = lazy(() => import('../../components/WorkspaceViews').then((module) => ({ default: module.OperatingDashboard })))
const ProjectLibrary = lazy(() => import('../../components/WorkspaceViews').then((module) => ({ default: module.ProjectLibrary })))
const AgentWorkspace = lazy(() => import('../../features/agent/AgentWorkspace'))

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

type WorkspaceHistoryMode = 'push' | 'replace' | 'none'

type ResultComposerDraft = {
  resultNodeId: string
  prompt: string
  batchCount: number
  settings: GenerationSettings
  refinementMode: RefinementMode
}

const defaultComposerLayout: ComposerLayout = { dock: 'bottom', collapsed: false }
const defaultWorkspaceLocation: WorkspaceLocation = { view: 'dashboard' }
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

function focusTaskFlow(setCenter: SetCenter, nodes: CanvasNode[]) {
  if (!nodes.length) return Promise.resolve(false)
  const left = Math.min(...nodes.map((node) => node.position.x))
  const top = Math.min(...nodes.map((node) => node.position.y))
  const right = Math.max(...nodes.map((node) => node.position.x + canvasNodeBounds(node).width))
  const bottom = Math.max(...nodes.map((node) => node.position.y + canvasNodeBounds(node).height))
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

function FocusCanvasNodes({ nodes, requestId }: { nodes: CanvasNode[]; requestId: number }) {
  const { fitView } = useReactFlow()

  useEffect(() => {
    if (!nodes.length) return
    const frame = window.requestAnimationFrame(() => {
      void fitView({ nodes, duration: viewportMotionDuration(220), padding: 0.34, minZoom: canvasMinZoom, maxZoom: 1.05 })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [fitView, nodes, requestId])

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

type CanvasPrimarySurface = 'assets' | 'templates' | 'history' | 'references' | 'candidates' | 'inspector' | 'delivery' | 'agent'

export default function CanvasWorkspace({ currentUser, onSignOut }: { currentUser?: ProductUser; onSignOut?: () => Promise<void> }) {
  const document = useCanvasStore((state) => state.document)
  const globalAssets = useCanvasStore((state) => state.globalAssets)
  const sharedTemplates = useCanvasStore((state) => state.sharedTemplates)
  const hydrated = useCanvasStore((state) => state.hydrated)
  const persistenceStatus = useCanvasStore((state) => state.persistenceStatus)
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId)
  const hydrate = useCanvasStore((state) => state.hydrate)
  const openDocument = useCanvasStore((state) => state.openDocument)
  const refreshDocumentFromRemote = useCanvasStore((state) => state.refreshDocumentFromRemote)
  const recoverGenerationResultsFromRemote = useCanvasStore((state) => state.recoverGenerationResultsFromRemote)
  const recoverUnknownGenerationSubmission = useCanvasStore((state) => state.recoverUnknownGenerationSubmission)
  const openNewDocument = useCanvasStore((state) => state.openNewDocument)
  const renameDocument = useCanvasStore((state) => state.renameDocument)
  const setNodes = useCanvasStore((state) => state.setNodes)
  const replaceMediaSources = useCanvasStore((state) => state.replaceMediaSources)
  const setNodesTransient = useCanvasStore((state) => state.setNodesTransient)
  const setEdges = useCanvasStore((state) => state.setEdges)
  const setViewport = useCanvasStore((state) => state.setViewport)
  const applyCollaborativeGraph = useCanvasStore((state) => state.applyCollaborativeGraph)
  const selectNode = useCanvasStore((state) => state.selectNode)
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
  const retryBatchVariationItem = useCanvasStore((state) => state.retryBatchVariationItem)
  const batchVariationRuns = useCanvasStore((state) => state.document.batchVariationRuns)
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
  const [activeCanvasSurface, setActiveCanvasSurface] = useState<CanvasPrimarySurface | null>(null)
  const canvasSurfaceTriggerRef = useRef<HTMLElement | null>(null)
  const setCanvasSurfaceOpen = useCallback((surface: CanvasPrimarySurface, action: ExclusiveSurfaceAction) => {
    if (action === true && globalThis.document.activeElement instanceof HTMLElement) canvasSurfaceTriggerRef.current = globalThis.document.activeElement
    setActiveCanvasSurface((current) => nextExclusiveSurface(current, surface, action))
  }, [])
  const assetsOpen = activeCanvasSurface === 'assets'
  const templatesOpen = activeCanvasSurface === 'templates'
  const historyOpen = activeCanvasSurface === 'history'
  const nodeReferencesOpen = activeCanvasSurface === 'references'
  const candidatesOpen = activeCanvasSurface === 'candidates'
  const deliveryOpen = activeCanvasSurface === 'delivery'
  const agentOpen = activeCanvasSurface === 'agent'
  const setAssetsOpen = useCallback((action: ExclusiveSurfaceAction) => setCanvasSurfaceOpen('assets', action), [setCanvasSurfaceOpen])
  const setTemplatesOpen = useCallback((action: ExclusiveSurfaceAction) => setCanvasSurfaceOpen('templates', action), [setCanvasSurfaceOpen])
  const setHistoryOpen = useCallback((action: ExclusiveSurfaceAction) => setCanvasSurfaceOpen('history', action), [setCanvasSurfaceOpen])
  const setNodeReferencesOpen = useCallback((action: ExclusiveSurfaceAction) => setCanvasSurfaceOpen('references', action), [setCanvasSurfaceOpen])
  const setCandidatesOpen = useCallback((action: ExclusiveSurfaceAction) => setCanvasSurfaceOpen('candidates', action), [setCanvasSurfaceOpen])
  const setNodeInspectorOpen = useCallback((action: ExclusiveSurfaceAction) => setCanvasSurfaceOpen('inspector', action), [setCanvasSurfaceOpen])
  const setDeliveryOpen = useCallback((action: ExclusiveSurfaceAction) => setCanvasSurfaceOpen('delivery', action), [setCanvasSurfaceOpen])
  const setAgentOpen = useCallback((action: ExclusiveSurfaceAction) => setCanvasSurfaceOpen('agent', action), [setCanvasSurfaceOpen])
  const [assetLibraryTargetGenerateId, setAssetLibraryTargetGenerateId] = useState<string | null>(null)
  const [agentArtifactIndex, setAgentArtifactIndex] = useState<AgentArtifactIndexState>({
    projectId: '', artifacts: [], status: 'idle',
  })
  const agentLauncherRef = useRef<HTMLButtonElement | null>(null)
  const [agentTargetResultId, setAgentTargetResultId] = useState<string | null>(null)
  const [composerOpen, setComposerOpen] = useState(false)
  const [resultComposerDraft, setResultComposerDraft] = useState<ResultComposerDraft | null>(null)
  const [batchComposerTargetId, setBatchComposerTargetId] = useState<string | null>(null)
  const [imagePreview, setImagePreview] = useState<{ image: string; name: string; mediaKind: GenerationMediaKind } | null>(null)
  const [historyFocusRequest, setHistoryFocusRequest] = useState<{ nodeId: string; requestId: number } | null>(null)
  const [agentFocusRequest, setAgentFocusRequest] = useState<{ nodeIds: string[]; requestId: number } | null>(null)
  const [renamingProjectTabId, setRenamingProjectTabId] = useState<string | null>(null)
  const [projectTabNameDraft, setProjectTabNameDraft] = useState('')
  const [assetToDelete, setAssetToDelete] = useState<AssetRecord | null>(null)
  const [maximumBatchCount, setMaximumBatchCount] = useState(8)
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
  const imagePreviewDialogRef = useDialogFocusTrap(Boolean(imagePreview))

  useEffect(() => {
    if (!connectionFeedback) return
    const timer = window.setTimeout(() => setConnectionFeedback(null), 1_100)
    return () => window.clearTimeout(timer)
  }, [connectionFeedback])

  useEffect(() => {
    if (!imagePreview) return
    const closePreview = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setImagePreview(null)
    }
    window.addEventListener('keydown', closePreview)
    return () => window.removeEventListener('keydown', closePreview)
  }, [imagePreview])

  useEffect(() => {
    if (!assetToDelete) return
    const closeConfirmation = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setAssetToDelete(null)
    }
    window.addEventListener('keydown', closeConfirmation)
    return () => window.removeEventListener('keydown', closeConfirmation)
  }, [assetToDelete])
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
  const workspaceProjectRequests = useMemo(() => createLatestOperation(), [])
  const invalidateWorkspaceProjectRequests = useCallback(() => {
    workspaceProjectRequests.invalidate()
    setWorkspaceProjectsLoading(false)
  }, [workspaceProjectRequests])
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
  useLayoutEffect(() => {
    if (viewportDocumentIdRef.current === document.id) return
    viewportDocumentIdRef.current = document.id
    viewportReadyRef.current = false
  }, [document.id])
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
    resultComposerSubmissionRef.current = false
    skipAutoComposerNodeIdRef.current = null
    setImagePreview(null)
    setAssetToDelete(null)
    setResultComposerDraft(null)
    setBatchComposerTargetId(null)
    setNodePalette(null)
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

  const workspaceNavigationRunRef = useRef(0)
  const setWorkspaceView = useCallback((view: WorkspaceView, projectId?: string, historyMode: WorkspaceHistoryMode = 'push') => {
    workspaceNavigationRunRef.current += 1
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
    workspaceNavigationRunRef.current += 1
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
    setActiveCanvasSurface(null)
    setComposerLayout((current) => current.collapsed ? { ...current, collapsed: false } : current)
    setComposerOpen(true)
  }, [])

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

  const recoverPersistentAgentRuns = useCallback(async () => {
    const projectId = useCanvasStore.getState().document.id
    const runs = await listPersistentBotanicAgentRuns(projectId)
    if (useCanvasStore.getState().document.id !== projectId) return
    let shouldRecoverResults = false
    for (const run of runs) {
      const current = useCanvasStore.getState().document.agentRuns.find((candidate) => candidate.id === run.id)
      if (shouldRecoverAgentRunResults(current, run)) shouldRecoverResults = true
      applyAgentRunSnapshot(run)
    }
    if (shouldRecoverResults) await recoverGenerationResultsFromRemote()
  }, [applyAgentRunSnapshot, recoverGenerationResultsFromRemote])

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
        .catch(() => undefined)
    }
    syncDrafts()
    window.addEventListener('online', syncDrafts)
    return () => window.removeEventListener('online', syncDrafts)
  }, [hydrated, recoverPersistentAgentRuns, recoverUnknownGenerationSubmission, refreshDocumentFromRemote, synchronizeLocalDrafts])

  useEffect(() => {
    if (!hydrated || !workspaceRestored || workspaceView !== 'canvas' || !serverPersistenceEnabled) return
    const refresh = () => {
      void refreshDocumentFromRemote()
        .then(() => recoverUnknownGenerationSubmission())
        .then(() => recoverPersistentAgentRuns())
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
  }, [hydrated, recoverPersistentAgentRuns, recoverUnknownGenerationSubmission, refreshDocumentFromRemote, workspaceRestored, workspaceView])

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
        if (terminal) {
          void recoverGenerationResultsFromRemote()
            .then(() => refreshDocumentFromRemote())
            .catch(() => undefined)
        }
      },
      onReconnected: () => {
        void synchronizeLocalDrafts()
          .then(() => recoverUnknownGenerationSubmission())
          .then(() => recoverPersistentAgentRuns())
          .then(() => refreshDocumentFromRemote())
          .catch(() => undefined)
      },
    })
    collaborationRef.current = collaboration
    return () => {
      if (collaborationRef.current === collaboration) collaborationRef.current = null
      collaboration.close()
    }
  }, [applyAgentRunSnapshot, applyCollaborativeGraph, document.id, hydrated, recoverGenerationResultsFromRemote, recoverPersistentAgentRuns, recoverUnknownGenerationSubmission, refreshDocumentFromRemote, synchronizeLocalDrafts, workspaceRestored, workspaceView])

  useEffect(() => {
    if (!hydrated || !workspaceRestored || workspaceView !== 'canvas' || !serverPersistenceEnabled) return
    void recoverPersistentAgentRuns().catch(() => undefined)
  }, [document.id, hydrated, recoverPersistentAgentRuns, workspaceRestored, workspaceView])

  useEffect(() => {
    if (!hydrated || !workspaceRestored || workspaceView !== 'canvas' || !serverPersistenceEnabled) return
    if (!document.agentRuns.some((run) => run.status === 'queued' || run.status === 'running' || run.status === 'executing')) return
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
  }, [document.agentRuns, document.id, hydrated, recoverPersistentAgentRuns, workspaceRestored, workspaceView])

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
      workspaceNavigationRunRef.current += 1
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
    const operationToken = workspaceProjectRequests.begin()
    setWorkspaceProjectsLoading(true)
    setWorkspaceProjectsError(null)
    try {
      const summaries = await readCanvasProjectSummaries()
      if (!workspaceProjectRequests.isCurrent(operationToken)) return
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
      if (workspaceProjectRequests.isCurrent(operationToken)) setWorkspaceProjectsError('请检查网络或稍后重试。')
    } finally {
      if (workspaceProjectRequests.isCurrent(operationToken)) setWorkspaceProjectsLoading(false)
    }
  }, [workspaceProjectRequests])

  const openWorkspaceProject = useCallback(async (projectId: string) => {
    const navigationRunId = workspaceNavigationRunRef.current
    const opened = await openDocument(projectId)
    if (opened && navigationRunId === workspaceNavigationRunRef.current) {
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
    const navigationRunId = workspaceNavigationRunRef.current
    const project = createDocumentFromTemplate(templateId, shared)
    if (!project) return false
    try {
      const saved = await createCanvasProject(project)
      invalidateWorkspaceProjectRequests()
      setWorkspaceProjects((current) => [{
        id: saved.id,
        name: saved.name,
        updatedAt: saved.updatedAt,
        cover: saved.history[0]?.image || undefined,
        summary: `模板项目 · ${saved.nodes.length} 个节点`,
      }, ...current.filter((item) => item.id !== saved.id)])
      if (navigationRunId === workspaceNavigationRunRef.current) {
        openNewDocument(saved)
        setWorkspaceView('canvas', saved.id)
      }
      return true
    } catch {
      return false
    }
  }, [createDocumentFromTemplate, invalidateWorkspaceProjectRequests, openNewDocument, setWorkspaceView])

  const renameWorkspaceProject = useCallback(async (projectId: string, name: string) => {
    const nextName = name.trim()
    if (!nextName) return false
    invalidateWorkspaceProjectRequests()
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
  }, [document.id, invalidateWorkspaceProjectRequests, renameDocument])

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
    const removedIndex = workspaceProjects.findIndex((project) => project.id === projectId)
    const removedProject = removedIndex >= 0 ? workspaceProjects[removedIndex] : undefined
    invalidateWorkspaceProjectRequests()
    // 删除操作可能涉及远端素材与任务清理。先从当前列表移除，避免界面被网络往返卡住。
    setWorkspaceProjects((current) => current.filter((project) => project.id !== projectId))
    setWorkspaceTabIds((current) => current.filter((id) => id !== projectId))
    if (workspaceLocation.view === 'canvas' && workspaceLocation.projectId === projectId) {
      setWorkspaceView('projects', undefined, 'replace')
    }
    try {
      await deleteCanvasDocument(projectId)
    } catch (error) {
      if (removedProject) {
        setWorkspaceProjects((current) => {
          if (current.some((project) => project.id === projectId)) return current
          const next = [...current]
          next.splice(Math.min(removedIndex, next.length), 0, removedProject)
          return next
        })
      }
      throw error
    }
    // 后台校准列表，不阻塞弹窗关闭或用户继续操作。
    void refreshWorkspaceProjects()
  }, [invalidateWorkspaceProjectRequests, refreshWorkspaceProjects, setWorkspaceView, workspaceLocation, workspaceProjects])

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
    setActiveCanvasSurface(null)
    setComposerOpen(false)
    setAccountMenuAnchor(null)
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
    setComposerOpen(false)
    setResultComposerDraft(null)
    setBatchComposerTargetId(null)
    setNodePalette(null)
    setAccountMenuAnchor(null)
    setAgentOpen(true)
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
      return health.configured
    } catch {
      return false
    }
  }, [setAvailableModels, setStoreMaximumBatchCount])

  useEffect(() => {
    void refreshGenerationService()
  }, [refreshGenerationService])

  const canAutoOpenCandidates = Boolean(
    generationCandidates.length
    && activeCanvasSurface === null
    && !composerOpen
    && !resultComposerDraft
    && !batchComposerTargetId
    && !accountMenuAnchor
    && !accountDialog
    && !imagePreview
    && !assetToDelete,
  )
  useEffect(() => {
    if (canAutoOpenCandidates) setCandidatesOpen(true)
  }, [canAutoOpenCandidates])

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

  const openDockSurface = useCallback((surface: Extract<CanvasPrimarySurface, 'assets' | 'templates' | 'history' | 'delivery'>) => {
    setComposerOpen(false)
    setResultComposerDraft(null)
    setBatchComposerTargetId(null)
    setNodePalette(null)
    setCanvasSurfaceOpen(surface, true)
  }, [setCanvasSurfaceOpen])

  useEffect(() => {
    const closeFrontSurfaceOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || agentOpen) return
      if (accountMenuAnchor || accountDialog || imagePreview || assetToDelete) return
      if (composerOpen || resultComposerDraft) return
      if (batchComposerTargetId) {
        setBatchComposerTargetId(null)
        event.preventDefault()
        return
      }
      const eventTarget = event.target instanceof Element ? event.target : null
      if (eventTarget?.closest('[aria-modal="true"], .botanic-select__menu, .composer-option-menu')) return
      if (nodePalette) {
        setNodePalette(null)
        event.preventDefault()
        return
      }
      if (!activeCanvasSurface) return
      setActiveCanvasSurface(null)
      event.preventDefault()
      requestAnimationFrame(() => {
        const trigger = canvasSurfaceTriggerRef.current
        if (trigger?.isConnected) trigger.focus()
      })
    }
    window.addEventListener('keydown', closeFrontSurfaceOnEscape)
    return () => window.removeEventListener('keydown', closeFrontSurfaceOnEscape)
  }, [accountDialog, accountMenuAnchor, activeCanvasSurface, agentOpen, assetToDelete, batchComposerTargetId, composerOpen, imagePreview, nodePalette, resultComposerDraft])

  const setScreenToFlowPosition = useCallback((mapper: ScreenToFlowPosition) => {
    screenToFlowPositionRef.current = mapper
  }, [])

  const addDroppedFilesToCanvas = useCallback(async (files: File[], position: { x: number; y: number }) => {
    const projectId = document.id
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
    if (uploads.length && useCanvasStore.getState().document.id === projectId) {
      addUploadedAssetsToCanvas(uploads, position)
      if (!message) setCanvasUploadMessage('已加入画布并存入素材库。')
    }
  }, [addUploadedAssetsToCanvas, document.id, document.nodes])

  const onCanvasDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    // 素材库中的卡片仍然保留在原处，拖入画布本质上是一次“添加”。
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
    // Safari / 部分内嵌浏览器会在 drop 阶段丢弃自定义 MIME，只保留 text/plain。
    const assetId = event.dataTransfer.getData('application/x-botanic-asset-id')
      || event.dataTransfer.getData('text/plain')
    if (assetId && assetLibraryAssets.some((asset) => asset.id === assetId)) addAssetToCanvas(assetId, position)
  }, [addAssetToCanvas, addDroppedFilesToCanvas, assetLibraryAssets, resetCanvasFileDragState])

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
    // Agent/素材库会阻止 drop 冒泡；捕获阶段仍能保证画布状态复位。
    window.addEventListener('drop', resetOnGlobalFileDrop, true)
    window.addEventListener('dragend', resetOnGlobalFileDrop, true)
    window.addEventListener('blur', resetOnWindowBlur)
    return () => {
      window.removeEventListener('drop', resetOnGlobalFileDrop, true)
      window.removeEventListener('dragend', resetOnGlobalFileDrop, true)
      window.removeEventListener('blur', resetOnWindowBlur)
    }
  }, [resetCanvasFileDragState])

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
    setActiveCanvasSurface(null)
    setComposerOpen(false)
    setResultComposerDraft(null)
    setBatchComposerTargetId(null)
    setAccountMenuAnchor(null)
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
  const batchVariationProgressRun = batchVariationRuns.find((run) => run.status !== 'succeeded' && run.status !== 'cancelled')
  const latestAgentRun = document.agentRuns.find((run) => run.plan.selectedResultNodeId === effectiveAgentTargetResultId)
  const focusAgentNodes = useCallback((nodeIds: string[]) => {
    const validNodeIds = [...new Set(nodeIds)].filter((nodeId) => document.nodes.some((node) => node.id === nodeId))
    if (!validNodeIds.length) return
    selectNode(validNodeIds[0])
    setComposerOpen(false)
    setResultComposerDraft(null)
    setAgentFocusRequest({ nodeIds: validNodeIds, requestId: Date.now() })
  }, [document.nodes, selectNode])
  const localAgentArtifacts = useMemo(() => collectBotanicAgentResults({
    sessions: document.agentSessions,
    nodes: document.nodes,
    generationJobs: document.generationJobs,
    assets: document.assets,
  }), [document.agentSessions, document.assets, document.generationJobs, document.nodes])
  useEffect(() => {
    if (!agentOpen || !serverPersistenceEnabled) return
    const controller = new AbortController()
    setAgentArtifactIndex({ projectId: document.id, artifacts: [], status: 'loading' })
    void listProjectAgentArtifacts(document.id, { limit: 100, signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return
      setAgentArtifactIndex({
        projectId: document.id,
        artifacts: result.artifacts,
        nextBefore: result.nextBefore,
        status: 'ready',
      })
    }).catch(() => {
      if (controller.signal.aborted) return
      setAgentArtifactIndex({ projectId: document.id, artifacts: [], status: 'error' })
    })
    return () => controller.abort()
  }, [agentOpen, document.id])
  const indexedAgentArtifacts = agentArtifactIndex.projectId === document.id ? agentArtifactIndex.artifacts : []
  const agentArtifacts = useMemo(
    () => mergeBotanicAgentArtifactIndex(indexedAgentArtifacts, localAgentArtifacts),
    [indexedAgentArtifacts, localAgentArtifacts],
  )
  const loadMoreAgentArtifacts = useCallback(async () => {
    const cursor = agentArtifactIndex.projectId === document.id ? agentArtifactIndex.nextBefore : undefined
    if (cursor === undefined || agentArtifactIndex.status === 'loading-more') return
    setAgentArtifactIndex((current) => current.projectId === document.id ? { ...current, status: 'loading-more' } : current)
    try {
      const result = await listProjectAgentArtifacts(document.id, { limit: 100, before: cursor })
      setAgentArtifactIndex((current) => {
        if (current.projectId !== document.id) return current
        const artifacts = new Map(current.artifacts.map((artifact) => [artifact.id, artifact]))
        for (const artifact of result.artifacts) if (!artifacts.has(artifact.id)) artifacts.set(artifact.id, artifact)
        return {
          projectId: document.id,
          artifacts: [...artifacts.values()],
          nextBefore: result.nextBefore,
          status: 'ready',
        }
      })
    } catch {
      setAgentArtifactIndex((current) => current.projectId === document.id ? { ...current, status: 'error' } : current)
    }
  }, [agentArtifactIndex.nextBefore, agentArtifactIndex.projectId, agentArtifactIndex.status, document.id])
  const agentContextOptions = document.nodes.flatMap((node): AgentContextItem[] => {
    if (node.type === 'asset') {
      const data = node.data as AssetNodeData
      return [{
        id: node.id,
        label: data.name ?? '图片素材',
        kind: '素材',
        image: data.image,
        assetId: data.assetId,
        role: data.role,
        mediaKind: data.mediaKind ?? 'image',
        source: data.source,
      }]
    }
    if (node.type === 'result') {
      const data = node.data as ResultNodeData
      return data.image && canUseForImageDelivery(data.mediaKind)
        ? [{ id: node.id, label: data.label ?? '生成结果', kind: '结果', image: data.image, mediaKind: data.mediaKind ?? 'image', source: 'generated' }]
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
    generationOverrides?: Partial<Pick<GenerationSettings, 'model' | 'aspectRatio' | 'resolution'>>,
  ) => {
    const projectId = document.id
    if (useCanvasStore.getState().document.id !== projectId) return { created: false, started: false, needsReference: false }
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
    // Agent 默认把描述写入生成节点，避免为一次生成额外创建文字节点。
    const generateNodeId = addGenerateNode({ x: origin.x + 360, y: origin.y + 40 }, 'image', referenceNodeIds)
    if (!generateNodeId) return { created: false, started: false, needsReference: !referenceNodeIds.length }
    if (useCanvasStore.getState().document.id !== projectId) return { created: false, started: false, needsReference: false }
    const generatedNode = useCanvasStore.getState().document.nodes.find((node) => node.id === generateNodeId)
    const generatedData = generatedNode?.type === 'generate' ? generatedNode.data as GenerateNodeData : undefined
    const selectedModel = availableModels.find((model) => model.id === generationOverrides?.model)
    const nextSettings = generatedData
      ? selectedModel
        ? settingsForGenerationModel({ ...generatedData.settings, ...generationOverrides }, selectedModel)
        : { ...generatedData.settings, ...generationOverrides }
      : undefined
    updateGenerateNode(generateNodeId, { prompt: instruction, ...(nextSettings ? { settings: nextSettings } : {}) })
    if (!autoExecute || !referenceNodeIds.length) return { created: true, started: false, needsReference: !referenceNodeIds.length }
    const started = await runGraphGeneration(generateNodeId)
    return { created: true, started, needsReference: false }
  }, [addGenerateNode, availableModels, document.id, document.nodes, runGraphGeneration, updateGenerateNode])

  const addAgentUploadedImages = useCallback((uploads: UploadedAssetInput[]) => {
    if (!uploads.length) return
    const projectId = document.id
    const currentDocument = useCanvasStore.getState().document
    if (currentDocument.id !== projectId) return
    const existingNodeIds = new Set(currentDocument.nodes.map((node) => node.id))
    const hasProduct = currentDocument.nodes.some((node) => node.type === 'asset' && (node.data as AssetNodeData).role === '商品')
    const normalizedUploads = uploads.map((upload, index) => ({
      ...upload,
      role: !hasProduct && index === 0 ? '商品' as const : upload.role,
    }))
    const origin = currentDocument.nodes.length
      ? { x: Math.max(...currentDocument.nodes.map((node) => node.position.x)) + 220, y: Math.min(...currentDocument.nodes.map((node) => node.position.y)) }
      : { x: 180, y: 160 }
    addUploadedAssetsToCanvas(normalizedUploads, origin)
    const addedNodeIds = useCanvasStore.getState().document.nodes
      .filter((node) => node.type === 'asset' && !existingNodeIds.has(node.id))
      .map((node) => node.id)
    if (!addedNodeIds.length) return
    const latestDocument = useCanvasStore.getState().document
    const sessionId = latestDocument.activeAgentSessionId ?? ensureAgentSession()
    const activeSession = useCanvasStore.getState().document.agentSessions.find((session) => session.id === sessionId)
    setAgentSessionContext(sessionId, [...new Set([...(activeSession?.contextNodeIds ?? []), ...addedNodeIds])])
  }, [addUploadedAssetsToCanvas, document.id, ensureAgentSession, setAgentSessionContext])

  const confirmAgentAction = useCallback(async (action: BotanicAgentActionProposal): Promise<BotanicAgentActionResult> => {
    const projectId = document.id
    const response = await executeProjectAgentAction({ projectId, action })
    const output = response.output
    if (useCanvasStore.getState().document.id !== projectId) {
      return { ...output, message: `${output.message} 已切换项目，结果保留在原项目，未写入当前画布。` }
    }
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

  const confirmAgentPlan = useCallback(async (plan: BotanicAgentPlan, submissionKey?: string) => {
    const projectId = document.id
    const group = plan.assetGroupId ? document.assetGroups.find((item) => item.id === plan.assetGroupId) : undefined
    const branchInputs = plan.output.mode === 'batch_by_asset' && group
      ? group.assetIds.map((assetId, index) => ({ assetId, branchId: `branch-${crypto.randomUUID()}`, label: `分支 ${index + 1}` }))
      : [{ branchId: `branch-${crypto.randomUUID()}`, label: plan.summary }]
    let runId: string
    if (serverPersistenceEnabled) {
      try {
        const activeDocument = useCanvasStore.getState().document
        if (activeDocument.id !== projectId) throw new Error('项目已切换，本次计划未启动。')
        const sources = collectAgentMediaSources(activeDocument, plan.selectedResultNodeId, plan.assetGroupId)
        const replacements = await prepareAgentMediaSources(
          sources,
          (source) => persistAgentReferenceMedia(activeDocument.id, source),
        )
        if (useCanvasStore.getState().document.id !== projectId) throw new Error('项目已切换，本次计划未启动。')
        await replaceMediaSources(replacements)
        if (useCanvasStore.getState().document.id !== projectId) throw new Error('项目已切换，本次计划未启动。')
        const snapshot = await createPersistentBotanicAgentRun({
          projectId,
          plan,
          idempotencyKey: submissionKey,
          branches: branchInputs.map((branch) => ({
            id: branch.branchId,
            label: branch.label,
            ...('assetId' in branch ? { assetId: branch.assetId } : {}),
          })),
        })
        if (useCanvasStore.getState().document.id !== projectId) {
          const execution = await executePersistentBotanicAgentRun(projectId, snapshot.id)
          return { started: execution.jobIds.length > 0, runId: snapshot.id }
        }
        runId = saveAgentPlan(plan, { id: snapshot.id, branches: snapshot.branches })
        applyAgentRunSnapshot(snapshot)
        await flushPendingCanvasDocumentWrites()
        if (useCanvasStore.getState().document.id !== projectId) {
          const execution = await executePersistentBotanicAgentRun(projectId, runId)
          return { started: execution.jobIds.length > 0, runId }
        }
        const execution = await executePersistentBotanicAgentRun(projectId, runId)
        if (useCanvasStore.getState().document.id !== projectId) return { started: execution.jobIds.length > 0, runId }
        applyAgentRunSnapshot(execution.run)
        await refreshDocumentFromRemote().catch(() => false)
        return { started: execution.jobIds.length > 0, runId }
      } catch (caught) {
        throw new Error(caught instanceof Error ? caught.message : 'Agent Run 无法持久化，请稍后重试。')
      }
    } else {
      if (useCanvasStore.getState().document.id !== projectId) throw new Error('项目已切换，本次计划未启动。')
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
    if (agentOpen) {
      selectedNodeTransitionRef.current = selectedNodeId
      setComposerOpen(false)
      return
    }
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
  }, [agentOpen, hydrated, selectedGenerate, selectedNodeId, showComposer])

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
  const composerPrimaryReferenceName = selectedGenerateParent?.type === 'result'
    ? ((selectedGenerateParent.data as ResultNodeData).label ?? '上游输出')
    : (selectedGeneratePrimaryReference?.name ?? selectedGenerateParentReference?.name)
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
        onResendInvite={resendWorkspaceMemberInvite}
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
                          if (event.key === 'Escape') {
                            event.preventDefault()
                            event.stopPropagation()
                            setRenamingProjectTabId(null)
                          }
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
          nodeTypes={canvasNodeTypes}
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
            if (agentOpen) {
              setComposerOpen(false)
              setResultComposerDraft(null)
              setBatchComposerTargetId(null)
              setIsConnecting(false)
              setSelectedEdgeId(null)
              setEdgeActionPosition(null)
              setNodePalette(null)
              return
            }
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
                onOpenAssets={() => openDockSurface('assets')}
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
          {agentFocusRequest ? <FocusCanvasNodes
            nodes={agentFocusRequest.nodeIds.flatMap((nodeId) => {
              const node = renderedNodes.find((item) => item.id === nodeId)
              return node ? [node] : []
            })}
            requestId={agentFocusRequest.requestId}
          /> : null}

          {multiSelectionPresence.present && visibleMultiSelectionCount ? <MultiSelectionToolbar count={visibleMultiSelectionCount} phase={multiSelectionPresence.phase} onClear={() => { selectNode(null); setComposerOpen(false) }} /> : null}
          {isConnecting || connectionFeedback ? <ConnectionGuide feedback={isConnecting ? null : connectionFeedback} /> : null}

          <Panel position="top-left" className="dock-panel">
            <nav className="dock" aria-label="画布工具">
              <button className="dock__add" onClick={(event) => openNodePalette(event, true)} aria-label="新增节点"><FigmaIcon src={plusIcon} /></button>
              <button className={assetsOpen ? 'dock__button is-active' : 'dock__button'} onClick={() => openDockSurface('assets')} aria-label="打开素材库"><FigmaIcon src={folderIcon} /></button>
              <button className={templatesOpen ? 'dock__button is-active' : 'dock__button'} onClick={() => openDockSurface('templates')} aria-label="模板"><FigmaIcon src={templatesIcon} /></button>
              <button className={historyOpen ? 'dock__button is-active' : 'dock__button'} onClick={() => openDockSurface('history')} aria-label="画布历史"><FigmaIcon src={historyIcon} /></button>
              <button className={deliveryOpen ? 'dock__button dock__button--delivery is-active' : 'dock__button dock__button--delivery'} onClick={() => openDockSurface('delivery')} aria-label="投放交付"><ArrowUpRightIcon /></button>
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

        {batchVariationProgressRun ? <BatchVariationProgress
          run={batchVariationProgressRun}
          onRetry={(runId, itemId) => retryBatchVariationItem(runId, itemId)}
        /> : null}

        {!agentOpen ? <button ref={agentLauncherRef} type="button" className="agent-launcher" onClick={() => {
          const sessionId = ensureAgentSession(selectedFocusNodeIds)
          const session = useCanvasStore.getState().document.agentSessions.find((item) => item.id === sessionId)
          if (selectedFocusNodeIds.length) setAgentSessionContext(sessionId, [...(session?.contextNodeIds ?? []), ...selectedFocusNodeIds])
          setAgentTargetResultId(selectedReadyResultData ? selectedResult!.id : null)
          setComposerOpen(false)
          setResultComposerDraft(null)
          setBatchComposerTargetId(null)
          setNodePalette(null)
          setAccountMenuAnchor(null)
          setAgentOpen(true)
        }} aria-label="打开 Agent" title="Agent"><SparkleIcon /></button> : null}

        {agentOpen ? <Suspense fallback={<aside className="agent-workspace" aria-label="Botanic Agent"><div className="workspace-loading-indicator" role="status">正在载入 Agent…</div></aside>}><AgentWorkspace
          key={`${document.id}:${activeAgentSession?.id ?? 'none'}`}
          projectId={document.id}
          escapeEnabled={topOverlayLayer([
            'agent',
            ...(accountMenuAnchor || accountDialog ? ['account' as const] : []),
            ...(imagePreview ? ['preview' as const] : []),
            ...(assetToDelete ? ['confirmation' as const] : []),
          ]) === 'agent'}
          persistenceStatus={persistenceStatus}
          target={agentTarget}
          groups={document.assetGroups}
          sessions={document.agentSessions}
          session={activeAgentSession}
          contextOptions={agentContextOptions}
          memory={document.agentMemory}
          artifacts={agentArtifacts}
          artifactIndexStatus={agentArtifactIndex.projectId === document.id ? agentArtifactIndex.status : 'idle'}
          artifactIndexHasMore={agentArtifactIndex.projectId === document.id && agentArtifactIndex.nextBefore !== undefined}
          latestRun={latestAgentRun}
          runs={document.agentRuns}
          plannerModels={agentPlannerModels}
          generationModels={availableModels}
          onConfirm={confirmAgentPlan}
          onConfirmAction={confirmAgentAction}
          onCreateDraft={createAgentWorkflowDraft}
          onUploadImages={addAgentUploadedImages}
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
          onFocusNodes={focusAgentNodes}
          onSaveArtifact={(artifact) => {
            if (!artifact.url || (artifact.kind !== 'image' && artifact.kind !== 'video')) return
            saveGeneratedImageToLibrary({ image: artifact.url, name: artifact.label, mediaKind: artifact.kind })
          }}
          onContinueArtifact={(artifact) => {
            let currentDocument = useCanvasStore.getState().document
            let sourceNodeIds = (artifact.provenance.sourceNodeIds ?? [])
              .filter((nodeId) => currentDocument.nodes.some((node) => node.id === nodeId))
            if (!sourceNodeIds.length && artifact.url && (artifact.kind === 'image' || artifact.kind === 'video')) {
              const existingNodeIds = new Set(currentDocument.nodes.map((node) => node.id))
              addUploadedAssetsToCanvas([{
                name: artifact.label,
                image: artifact.url,
                role: '场景',
                mediaKind: artifact.kind,
                collection: 'Agent 历史结果',
                tags: ['Agent', '历史结果'],
              }])
              currentDocument = useCanvasStore.getState().document
              sourceNodeIds = currentDocument.nodes
                .filter((node) => node.type === 'asset' && !existingNodeIds.has(node.id))
                .map((node) => node.id)
            }
            if (!sourceNodeIds.length) return
            const sessionId = currentDocument.activeAgentSessionId ?? ensureAgentSession(sourceNodeIds)
            const currentSession = useCanvasStore.getState().document.agentSessions.find((item) => item.id === sessionId)
            setAgentSessionContext(sessionId, [...(currentSession?.contextNodeIds ?? []), ...sourceNodeIds])
            const resultNodeId = sourceNodeIds.find((nodeId) => currentDocument.nodes.some((node) => node.id === nodeId && node.type === 'result'))
            setAgentTargetResultId(resultNodeId ?? null)
            selectNode(sourceNodeIds[0])
            setAgentFocusRequest({ nodeIds: sourceNodeIds, requestId: Date.now() })
          }}
          onLoadMoreArtifacts={loadMoreAgentArtifacts}
          onUseResultContext={(sourceNodeIds) => {
            const currentDocument = useCanvasStore.getState().document
            const sessionId = currentDocument.activeAgentSessionId ?? ensureAgentSession(sourceNodeIds)
            const currentSession = useCanvasStore.getState().document.agentSessions.find((item) => item.id === sessionId)
            setAgentSessionContext(sessionId, [...(currentSession?.contextNodeIds ?? []), ...sourceNodeIds])
            const resultNodeId = sourceNodeIds.find((nodeId) => useCanvasStore.getState().document.nodes.some((node) => node.id === nodeId && node.type === 'result'))
            setAgentTargetResultId(resultNodeId ?? null)
            if (resultNodeId) selectNode(resultNodeId)
          }}
          onRetryPersistence={retryAgentCanvasPersistence}
          onRefreshRemote={refreshAgentCanvasFromRemote}
          onClose={() => {
            setAgentOpen(false)
            requestAnimationFrame(() => agentLauncherRef.current?.focus())
          }}
        /></Suspense> : null}

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
              const submissionProjectId = document.id
              void runGraphGeneration(selectedGenerate.id).then((started) => {
                if (useCanvasStore.getState().document.id !== submissionProjectId) return
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
              const submissionProjectId = document.id
              void runGraphGeneration(branchId).then((started) => {
                if (useCanvasStore.getState().document.id !== submissionProjectId) return
                resultComposerSubmissionRef.current = false
                if (started) {
                  setCandidatesOpen(true)
                  return
                }
                skipAutoComposerNodeIdRef.current = null
                showComposer()
              }).catch(() => {
                if (useCanvasStore.getState().document.id !== submissionProjectId) return
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
          busy={generationStatus === 'uploading' || generationStatus === 'queued' || generationStatus === 'running' || generationStatus === 'recovering'}
          onOpenAssets={() => {
            setBatchComposerTargetId(null)
            setAssetsOpen(true)
          }}
          onSubmit={(request) => {
            const submissionProjectId = document.id
            void runBatchVariation({ sourceResultNodeId: batchComposerTarget.id, ...request }).then((started) => {
              if (useCanvasStore.getState().document.id !== submissionProjectId) return
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
            <button onClick={() => {
              const parentNode = visibleNodePalette.parentResultId
                ? document.nodes.find((node) => node.id === visibleNodePalette.parentResultId && node.type === 'result')
                : undefined
              const parentMediaKind = parentNode?.type === 'result' ? (parentNode.data as ResultNodeData).mediaKind ?? 'image' : 'image'
              const imageModel = availableModels.find((model) => (model.mediaKind ?? 'image') === 'image')
              const imageSettings = parentMediaKind === 'video' && imageModel
                ? settingsForGenerationModel({
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
              const videoSettings = settingsForGenerationModel({
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
            key={document.id}
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
            key={document.id}
            projectId={document.id}
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
            disabled={generationStatus === 'uploading' || generationStatus === 'queued' || generationStatus === 'running' || generationStatus === 'recovering'}
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
              const submissionProjectId = document.id
              void retryGeneration().then((started) => {
                if (useCanvasStore.getState().document.id !== submissionProjectId) return
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
            <section ref={imagePreviewDialogRef} className="image-preview-dialog" role="dialog" aria-modal="true" aria-label={`${visibleImagePreview.name}预览`} onMouseDown={(event) => event.stopPropagation()}>
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
        onResendInvite={resendWorkspaceMemberInvite}
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
