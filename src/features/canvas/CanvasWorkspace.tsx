import { lazy, Suspense, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import {
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
  type Edge,
  type SetCenter,
  type XYPosition,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { defaultGenerationModels } from '../../domain/canvas'
import { settingsForGenerationModel } from '../../domain/generationRecipe'
import { generationTaskErrorMessage, generationTaskFeedback, planResultGroupPresentation, traceCanvasLineage, type ResultGroupPresentation } from '../../domain/canvasPresentation'
import { buildDeliveryPreviewArtifacts, canUseForImageDelivery, resolveDeliveryDraft, type DeliveryPanelTarget } from '../../domain/deliveryPresentation'
import { imageUploadAccept, uploadLimitsLabel } from '../../domain/mediaFormats'
import { reducedAspectRatio } from '../../domain/mediaPresentation'
import { mediaRetryUrl } from '../../domain/mediaRecovery'
import { videoAspectRatioPolicy } from '../../domain/videoGeneration'
import { canvasNodeBounds } from '../../domain/canvasNodeLayout'
import { clipboardMediaFiles, pasteTarget } from '../../domain/clipboardMedia'
import { nextExclusiveSurface, type ExclusiveSurfaceAction } from '../../domain/exclusiveSurface'
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
} from '../../domain/canvas'
import { deliveryPresets, downloadDeliveryPackage } from '../../lib/deliveryExport'
import { downloadMedia } from '../../lib/mediaDownload'
import { maxUploadAssets } from '../../lib/uploadedAssets'
import { getGenerationServiceHealth } from '../../lib/generationApi'
import { refinePrompt } from '../../lib/promptRefinementApi'
import { enrollProductMfa, inviteWorkspaceMember, listWorkspaceAuditEvents, listWorkspaceMembers, readProductMfaStatus, refreshProductMediaSession, removeProductMfa, resendWorkspaceMemberInvite, signOutOtherProductSessions, updateProductPassword, updateWorkspaceMember, verifyProductMfa, type ProductUser } from '../../lib/productSession'
import { useCanvasStore } from '../../store/canvasStore'
import type { WorkspaceProject } from '../../components/WorkspaceViews'
import { ArrowUpRightIcon, CloseIcon, DeleteIcon, DownloadIcon, FigmaIcon, FocusIcon, FolderOutlineIcon, HomeIcon, MapIcon, MoreIcon, PlusSquareIcon, SparkleIcon, UploadIcon } from '../../components/BotanicIcons'
import { BobLauncher } from './BobLauncher'
import {
  sameWorkspaceLocation,
  workspaceHash,
  workspaceLocationFromHash,
  type WorkspaceLocation,
  type WorkspaceView,
} from './canvasWorkspaceNavigation'
import { useWorkspaceProjectCoordinator } from './workspaceProjectCoordinator'
import { useCanvasWorkspaceSynchronization } from './useCanvasWorkspaceSynchronization'
import { useCanvasAgentExecutionBridge } from './useCanvasAgentExecutionBridge'
import { readCachedCanvasViewport, useCanvasInteractionCoordinator, type ScreenToFlowPosition } from './useCanvasInteractionCoordinator'
import { RegionMaskEditor } from './RegionMaskEditor'
import type { BatchVariationRequest, GeneratedHistoryItem } from './CanvasWorkspacePanels'

// 画布首屏只需要节点与导航；素材、模板、历史和投放面板按需加载，避免把整组重型面板打进首屏 chunk。
const AssetLibrary = lazy(() => import('./CanvasWorkspacePanels').then((module) => ({ default: module.AssetLibrary })))
const BatchVariationComposer = lazy(() => import('./CanvasWorkspacePanels').then((module) => ({ default: module.BatchVariationComposer })))
const BatchVariationProgress = lazy(() => import('./CanvasWorkspacePanels').then((module) => ({ default: module.BatchVariationProgress })))
const ConfirmationDialog = lazy(() => import('./CanvasWorkspacePanels').then((module) => ({ default: module.ConfirmationDialog })))
const DeliveryPanel = lazy(() => import('./CanvasWorkspacePanels').then((module) => ({ default: module.DeliveryPanel })))
const GenerationPanel = lazy(() => import('./CanvasWorkspacePanels').then((module) => ({ default: module.GenerationPanel })))
const HistoryPanel = lazy(() => import('./CanvasWorkspacePanels').then((module) => ({ default: module.HistoryPanel })))
const NodeReferencePanel = lazy(() => import('./CanvasWorkspacePanels').then((module) => ({ default: module.NodeReferencePanel })))
const TemplatePanel = lazy(() => import('./CanvasWorkspacePanels').then((module) => ({ default: module.TemplatePanel })))
const UndoToast = lazy(() => import('./CanvasWorkspacePanels').then((module) => ({ default: module.UndoToast })))
import { CanvasComposer, canvasNodeTypes, type ComposerLayout, type ResultGroupCandidateUi, type ResultNodeUiData } from './CanvasEditorViews'
import plusIcon from '../../assets/figma/icon-plus.svg'
import folderIcon from '../../assets/figma/icon-folder.svg'
import templatesIcon from '../../assets/figma/icon-templates.svg'
import historyIcon from '../../assets/figma/icon-history.svg'
import resultImage from '../../assets/figma/result.webp'
import { LanguageSwitcher, useProductI18n, useProductMessages } from '../../i18n/react'
import { localizeProductError } from '../../i18n/core'
import { canvasSystemLabel } from './canvasI18n'

const workspaceMessages = {
  'zh-CN': {
    loadingProject: '正在载入项目', loadingProjectShort: '载入项目', focusSelected: '聚焦选中节点', focusTask: '聚焦本次任务', fitAll: '适配全部节点', canvasNavigation: '画布导航', closeMinimap: '关闭小地图', openMinimap: '打开小地图', minimapNotNeeded: '节点较少，暂不需要小地图', zoomLevel: '画布缩放级别', moreTools: '更多画布工具', exitMarquee: '退出框选', marquee: '框选节点', drag: '拖动', autoLayout: '自动整理', showAll: '显示全部',
    selectedCount: (count: number) => `${count} 个节点已选中`, moveTogether: '拖动任意节点可整体移动', clearSelection: '取消选择', connected: '已连接', invalidConnection: '无法连接到这里', connectionCancelled: '已取消连线', connecting: '正在连线', dragToPort: '拖到绿色空心点', connectionHint: '素材 / 文本 / 已选图片 → 生成；输出由任务自动创建',
    edgeActions: '已选连线操作', systemEdge: '系统输出连线', selectedEdge: '连线已选中', systemEdgeHint: '用于保留生成血缘，不可删除或重连', reconnectHint: '拖动端点可重连', delete: '删除', closeEdgeActions: '关闭连线操作', emptyGuide: '空画布引导', emptyTitle: '从一个创意目标开始', emptyDetail: '拖入商品、场景或灵感图；也可以先添加一个生成节点，逐步搭建这次项目的创作路径。', addAssets: '添加素材', imageGeneration: '图片生成', videoGeneration: '视频生成', agentStart: '先描述目标', agentStartDetail: '让 Agent 先整理商品、场景和交付规格，再决定要生成什么。', dismissNotice: '关闭操作提示',
    initFailed: '画布初始化失败', initFailedDetail: '请重试；若仍失败，请退出后重新登录。', retry: '重试', loadingCanvas: '正在加载画布', canvasLabel: (name: string) => name.endsWith('画布') ? name : `${name}画布`, backProjects: '返回项目', projects: '项目', openProjects: '已打开项目', projectName: '项目名称', openProject: (name: string) => `打开${name}`, renameProject: '双击重命名', closeProject: (name: string) => `关闭${name}`, closeTab: '关闭标签', newProject: '新建创意项目',
    minimapLabel: '画布导航地图', videoModelMissing: '视频模型尚未配置，请先检查 MiniMax H3。', canvasTools: '画布工具', addNode: '新增节点', openAssets: '打开素材库', templates: '模板', history: '画布历史', delivery: '投放交付', account: '打开账户设置', openAgent: '打开 Bob', loadingAgent: '正在载入 Agent…', language: '切换为英文',
    imageAsset: '图片素材', selectedResult: '已选结果', candidate: (index: number) => `候选 ${index}`, builtNodes: (count: number) => `已搭建 ${count} 个节点`, blankCanvasSummary: '空白画布 · 等待开始', refinedVersion: '精修版本', generatedImage: '生成图片', keyVisualVersion: '首图版本', dropToAdd: '松开即可加入画布', uploadLimits: uploadLimitsLabel('zh-CN'), addCanvasNode: '添加画布节点', addFromImage: '基于此图添加', connectSelected: '连接所选节点', addNodeTitle: '添加节点', closeAddNode: '关闭添加节点', continueImage: '基于当前图片继续创作', connectToGenerate: '连接素材与描述生成图片', batchVariations: '批量变体', batchDetail: '用一个素材组逐项生成', continueVideo: '以当前画面或视频继续生成', videoReferenceDetail: '连接首帧、首尾帧或参考素材', assets: '素材', assetsDetail: '添加商品、场景或调性图', localImages: '本地图片', uploadImages: '上传图片', uploadToCanvas: '上传图片并加入画布', preview: (name: string) => `${name}预览`, downloadMedia: '下载原媒体', closePreview: '关闭媒体预览',
  },
  en: {
    loadingProject: 'Loading project', loadingProjectShort: 'Loading project', focusSelected: 'Focus selected nodes', focusTask: 'Focus current task', fitAll: 'Fit all nodes', canvasNavigation: 'Canvas navigation', closeMinimap: 'Close minimap', openMinimap: 'Open minimap', minimapNotNeeded: 'Minimap is not needed for a small canvas', zoomLevel: 'Canvas zoom level', moreTools: 'More canvas tools', exitMarquee: 'Exit marquee select', marquee: 'Select nodes', drag: 'Drag', autoLayout: 'Auto arrange', showAll: 'Show all',
    selectedCount: (count: number) => `${count} ${count === 1 ? 'node' : 'nodes'} selected`, moveTogether: 'Drag any selected node to move them together', clearSelection: 'Clear selection', connected: 'Connected', invalidConnection: 'Cannot connect here', connectionCancelled: 'Connection cancelled', connecting: 'Connecting', dragToPort: 'Drag to a green open port', connectionHint: 'Asset / text / selected image → generation; outputs are created automatically',
    edgeActions: 'Selected connection actions', systemEdge: 'System output connection', selectedEdge: 'Connection selected', systemEdgeHint: 'Preserves generation lineage and cannot be deleted or reconnected', reconnectHint: 'Drag an endpoint to reconnect', delete: 'Delete', closeEdgeActions: 'Close connection actions', emptyGuide: 'Empty canvas guide', emptyTitle: 'Start with a creative direction', emptyDetail: 'Add a product, scene, or inspiration image, or start with a generation node and build the creative workflow step by step.', addAssets: 'Add assets', imageGeneration: 'Image generation', videoGeneration: 'Video generation', agentStart: 'Describe the goal first', agentStartDetail: 'Let Agent organize the product, scene, and delivery specs before you decide what to generate.', dismissNotice: 'Dismiss operation notice',
    initFailed: 'Canvas could not start', initFailedDetail: 'Try again. If it still fails, sign out and sign in again.', retry: 'Retry', loadingCanvas: 'Loading canvas', canvasLabel: (name: string) => `${name} canvas`, backProjects: 'Back to projects', projects: 'Projects', openProjects: 'Open projects', projectName: 'Project name', openProject: (name: string) => `Open ${name}`, renameProject: 'Double-click to rename', closeProject: (name: string) => `Close ${name}`, closeTab: 'Close tab', newProject: 'New creative project',
    minimapLabel: 'Canvas navigation map', videoModelMissing: 'No video model is configured. Check MiniMax H3.', canvasTools: 'Canvas tools', addNode: 'Add node', openAssets: 'Open asset library', templates: 'Templates', history: 'Canvas history', delivery: 'Delivery', account: 'Open account settings', openAgent: 'Open Bob', loadingAgent: 'Loading Agent…', language: 'Switch to Chinese',
    imageAsset: 'Image asset', selectedResult: 'Selected result', candidate: (index: number) => `Candidate ${index}`, builtNodes: (count: number) => `${count} ${count === 1 ? 'node' : 'nodes'} built`, blankCanvasSummary: 'Blank canvas · Ready to start', refinedVersion: 'Refined version', generatedImage: 'Generated image', keyVisualVersion: 'Key visual version', dropToAdd: 'Drop to add to canvas', uploadLimits: uploadLimitsLabel('en'), addCanvasNode: 'Add canvas node', addFromImage: 'Add from this image', connectSelected: 'Connect selected node', addNodeTitle: 'Add node', closeAddNode: 'Close add-node menu', continueImage: 'Continue creating from this image', connectToGenerate: 'Connect assets and a description to generate an image', batchVariations: 'Batch variations', batchDetail: 'Generate once for each asset in a group', continueVideo: 'Continue from the current image or video', videoReferenceDetail: 'Connect a first frame, first and last frames, or reference assets', assets: 'Assets', assetsDetail: 'Add product, scene, or style images', localImages: 'Local images', uploadImages: 'Upload images', uploadToCanvas: 'Upload images and add to canvas', preview: (name: string) => `${name} preview`, downloadMedia: 'Download original media', closePreview: 'Close media preview',
  },
} as const

// 项目库不参与画布编辑。按路由加载，避免直接打开画布时额外解析入口内容。
const ProjectLibrary = lazy(() => import('../../components/WorkspaceViews').then((module) => ({ default: module.ProjectLibrary })))
const AgentWorkspace = lazy(() => import('../../features/agent/AgentWorkspace'))

function DeferredWorkspaceIndicator() {
  const t = useProductMessages(workspaceMessages)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), 500)
    return () => window.clearTimeout(timer)
  }, [])

  if (!visible) return null
  return (
    <div className="workspace-loading-indicator" role="status" aria-label={t.loadingProject}>
      <span aria-hidden="true"><i /><i /><i /></span>
      <small>{t.loadingProjectShort}</small>
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
  if (from === 'projects' && to === 'canvas') return 'forward'
  if (from === 'canvas' && to === 'projects') return 'backward'
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
const defaultWorkspaceLocation: WorkspaceLocation = { view: 'projects' }
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
  const t = useProductMessages(workspaceMessages)
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
    ? t.focusSelected
    : taskNodes.length
      ? t.focusTask
      : t.fitAll
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
      <div className="zoom-panel__controls" aria-label={t.canvasNavigation}>
        <button
          className={miniMapOpen ? 'zoom-panel__icon-button is-active' : 'zoom-panel__icon-button'}
          type="button"
          onClick={onToggleMiniMap}
          disabled={!canShowMiniMap}
          aria-label={miniMapOpen ? t.closeMinimap : t.openMinimap}
          aria-expanded={miniMapOpen}
          aria-controls="canvas-minimap"
          title={canShowMiniMap ? (miniMapOpen ? t.closeMinimap : t.openMinimap) : t.minimapNotNeeded}
        ><MapIcon /></button>
        <button className="zoom-panel__icon-button" type="button" onClick={focusCanvas} aria-label={smartFocusLabel} title={smartFocusLabel}><FocusIcon /></button>
        <div className="zoom-panel__slider">
          <input
            className="zoom-track"
            aria-label={t.zoomLevel}
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
          <summary className="zoom-panel__icon-button" role="button" aria-label={t.moreTools} title={t.moreTools}><MoreIcon /></summary>
          <div className="zoom-panel__menu" role="menu">
            <button
              className={marqueeMode ? 'is-active' : ''}
              type="button"
              role="menuitem"
              onClick={(event) => { onToggleMarqueeMode(); closeMoreMenu(event) }}
            >{marqueeMode ? t.exitMarquee : t.marquee}<span>{touchInput ? t.drag : 'Shift'}</span></button>
            <button type="button" role="menuitem" onClick={(event) => {
              onAutoLayout()
              window.requestAnimationFrame(() => commitViewport(fitView({ duration: viewportMotionDuration(220), padding: 0.16, minZoom: canvasMinZoom, maxZoom: 1 })))
              closeMoreMenu(event)
            }}>{t.autoLayout}</button>
            <button type="button" role="menuitem" onClick={(event) => {
              commitViewport(fitView({ duration: viewportMotionDuration(180), padding: 0.16, minZoom: canvasMinZoom, maxZoom: 1 }))
              closeMoreMenu(event)
            }}>{t.showAll}</button>
          </div>
        </details>
      </div>
    </Panel>
  )
}

function MultiSelectionToolbar({ count, onClear, phase }: { count: number; onClear: () => void; phase: MotionPhase }) {
  const t = useProductMessages(workspaceMessages)
  return (
    <Panel position="top-center" className="multi-selection-panel">
      <div className={`multi-selection-toolbar is-${phase}`} role="status" aria-live="polite">
        <span>{t.selectedCount(count)}</span>
        <i>{t.moveTogether}</i>
        <button type="button" onClick={onClear}>{t.clearSelection}</button>
      </div>
    </Panel>
  )
}

function ConnectionGuide({ feedback }: { feedback?: 'connected' | 'invalid' | 'cancelled' | null }) {
  const t = useProductMessages(workspaceMessages)
  if (feedback) {
    const message = feedback === 'connected' ? t.connected : feedback === 'invalid' ? t.invalidConnection : t.connectionCancelled
    return (
      <Panel position="top-center" className="connection-guide-panel">
        <div className={`connection-feedback is-${feedback}`} role="status" aria-live="polite">{message}</div>
      </Panel>
    )
  }
  return (
    <Panel position="top-center" className="connection-guide-panel">
      <div className="connection-guide" role="status" aria-live="polite">
        <b>{t.connecting}</b>
        <span>{t.dragToPort}</span>
        <i>{t.connectionHint}</i>
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

/**
 * 定位是一次性动作，只能由新的 requestId 触发。
 *
 * 节点数组/对象是父组件每次 render 现算的新引用，而生成期间结果节点状态一直在变
 * （queued → generating → ready、轮询与实时推送），画布因此频繁重渲染。若把节点放进
 * 依赖数组，fitView 会在每次重渲染时重跑，视角被钉死在生成节点上，用户平移完立刻被拉回。
 */
function useFocusOnRequest(requestId: number, focus: () => void) {
  const focusRef = useRef(focus)
  focusRef.current = focus
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => focusRef.current())
    return () => window.cancelAnimationFrame(frame)
  }, [requestId])
}

function FocusCanvasNode({ node, requestId }: { node?: CanvasNode; requestId: number }) {
  const { fitView } = useReactFlow()
  useFocusOnRequest(requestId, () => {
    if (!node) return
    void fitView({ nodes: [node], duration: viewportMotionDuration(220), padding: 0.48, minZoom: canvasMinZoom, maxZoom: 1.05 })
  })
  return null
}

function FocusCanvasNodes({ nodes, requestId }: { nodes: CanvasNode[]; requestId: number }) {
  const { fitView } = useReactFlow()
  useFocusOnRequest(requestId, () => {
    if (!nodes.length) return
    void fitView({ nodes, duration: viewportMotionDuration(220), padding: 0.34, minZoom: canvasMinZoom, maxZoom: 1.05 })
  })
  return null
}

function EdgeActions({ edge, position, onDelete, onClose }: {
  edge: Edge
  position: { x: number; y: number }
  onDelete: () => void
  onClose: () => void
}) {
  const t = useProductMessages(workspaceMessages)
  const isSystemEdge = Boolean(edge.data?.system)
  return (
    <div
      className="edge-actions"
      style={{ left: position.x, top: position.y }}
      role="toolbar"
      aria-label={t.edgeActions}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span>{isSystemEdge ? t.systemEdge : t.selectedEdge}</span>
      <small>{isSystemEdge ? t.systemEdgeHint : t.reconnectHint}</small>
      {!isSystemEdge ? <button type="button" onClick={onDelete}>{t.delete}</button> : null}
      <button type="button" className="edge-actions__close" onClick={onClose} aria-label={t.closeEdgeActions}><CloseIcon /></button>
    </div>
  )
}

function CanvasAssistantNotice({
  message,
  dismissLabel,
  onDismiss,
}: {
  message: string
  dismissLabel: string
  onDismiss: () => void
}) {
  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(onDismiss, 8_000)
    return () => window.clearTimeout(timer)
  }, [message, onDismiss])

  if (!message) return null
  return (
    <div className="canvas-assistant-notice" role="status" aria-live="polite">
      <span>{message}</span>
      <button type="button" aria-label={dismissLabel} title={dismissLabel} onClick={onDismiss}><CloseIcon /></button>
    </div>
  )
}

function EmptyCanvasGuide({
  onOpenAssets,
  onOpenAgent,
  onAddImage,
  onAddVideo,
}: {
  onOpenAssets: () => void
  onOpenAgent: () => void
  onAddImage: () => void
  onAddVideo: () => void
}) {
  const t = useProductMessages(workspaceMessages)
  return (
    <section className="empty-canvas-guide" aria-label={t.emptyGuide}>
      <span className="panel-eyebrow">START A PROJECT</span>
      <h2>{t.emptyTitle}</h2>
      <p>{t.emptyDetail}</p>
      <button type="button" className="empty-canvas-guide__agent" onClick={onOpenAgent}>
        <strong>{t.agentStart}</strong>
        <small>{t.agentStartDetail}</small>
      </button>
      <div>
        <button type="button" onClick={onOpenAssets}>{t.addAssets}</button>
        <button type="button" className="is-primary" onClick={onAddImage}>{t.imageGeneration}</button>
        <button type="button" onClick={onAddVideo}>{t.videoGeneration}</button>
      </div>
    </section>
  )
}

type CanvasPrimarySurface = 'assets' | 'templates' | 'history' | 'references' | 'candidates' | 'inspector' | 'delivery' | 'agent'

export default function CanvasWorkspace({
  currentUser,
  onSignOut,
  onReturnToLanding,
  productHomeLabel,
}: {
  currentUser?: ProductUser
  onSignOut?: () => Promise<void>
  onReturnToLanding: () => void
  productHomeLabel: string
}) {
  const { locale } = useProductI18n()
  const t = useProductMessages(workspaceMessages)
  const document = useCanvasStore((state) => state.document)
  const globalAssets = useCanvasStore((state) => state.globalAssets)
  const sharedTemplates = useCanvasStore((state) => state.sharedTemplates)
  const hydrated = useCanvasStore((state) => state.hydrated)
  const persistenceStatus = useCanvasStore((state) => state.persistenceStatus)
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId)
  const openDocument = useCanvasStore((state) => state.openDocument)
  const refreshDocumentFromRemote = useCanvasStore((state) => state.refreshDocumentFromRemote)
  const openNewDocument = useCanvasStore((state) => state.openNewDocument)
  const renameDocument = useCanvasStore((state) => state.renameDocument)
  const setNodes = useCanvasStore((state) => state.setNodes)
  const setNodesTransient = useCanvasStore((state) => state.setNodesTransient)
  const setEdges = useCanvasStore((state) => state.setEdges)
  const setViewport = useCanvasStore((state) => state.setViewport)
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
  const addGenerateNode = useCanvasStore((state) => state.addGenerateNode)
  const updateGenerateNode = useCanvasStore((state) => state.updateGenerateNode)
  const updateTextNode = useCanvasStore((state) => state.updateTextNode)
  const runGraphGeneration = useCanvasStore((state) => state.runGraphGeneration)
  const runBatchVariation = useCanvasStore((state) => state.runBatchVariation)
  const runRefinement = useCanvasStore((state) => state.runRefinement)
  const retryBatchVariationItem = useCanvasStore((state) => state.retryBatchVariationItem)
  const batchVariationRuns = useCanvasStore((state) => state.document.batchVariationRuns)
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
  const assistantMessage = useCanvasStore((state) => state.assistantMessage)
  const generationError = useCanvasStore((state) => state.generationError)
  const expectedCandidateCount = useCanvasStore((state) => state.expectedCandidateCount)
  const generationCandidates = useCanvasStore((state) => state.generationCandidates)
  const lastGenerationRequest = useCanvasStore((state) => state.lastGenerationRequest)
  const cancelGeneration = useCanvasStore((state) => state.cancelGeneration)
  const retryGeneration = useCanvasStore((state) => state.retryGeneration)
  const appendAgentMessage = useCanvasStore((state) => state.appendAgentMessage)
  const updateAgentMessage = useCanvasStore((state) => state.updateAgentMessage)
  const updateAgentAction = useCanvasStore((state) => state.updateAgentAction)
  const setAgentSessionContext = useCanvasStore((state) => state.setAgentSessionContext)
  const setAgentSessionExecutionMode = useCanvasStore((state) => state.setAgentSessionExecutionMode)
  const setAgentSessionPlannerModel = useCanvasStore((state) => state.setAgentSessionPlannerModel)
  const setAgentSessionSkills = useCanvasStore((state) => state.setAgentSessionSkills)
  const renameAgentSession = useCanvasStore((state) => state.renameAgentSession)
  const addAgentMemory = useCanvasStore((state) => state.addAgentMemory)
  const removeAgentMemory = useCanvasStore((state) => state.removeAgentMemory)
  const clearGenerationError = useCanvasStore((state) => state.clearGenerationError)
  const clearAssistantMessage = useCanvasStore((state) => state.clearAssistantMessage)
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
  const agentLauncherRef = useRef<HTMLButtonElement | null>(null)
  const openAgentForResultRef = useRef<(resultNodeId: string) => void>(() => undefined)
  const openAgentForResult = useCallback((resultNodeId: string) => openAgentForResultRef.current(resultNodeId), [])
  const [composerOpen, setComposerOpen] = useState(false)
  const [resultComposerDraft, setResultComposerDraft] = useState<ResultComposerDraft | null>(null)
  const [batchComposerTargetId, setBatchComposerTargetId] = useState<string | null>(null)
  const [regionEditTargetId, setRegionEditTargetId] = useState<string | null>(null)
  const [imagePreview, setImagePreview] = useState<{ image: string; name: string; mediaKind: GenerationMediaKind } | null>(null)
  const [historyFocusRequest, setHistoryFocusRequest] = useState<{ nodeId: string; requestId: number } | null>(null)
  const [renamingProjectTabId, setRenamingProjectTabId] = useState<string | null>(null)
  const [projectTabNameDraft, setProjectTabNameDraft] = useState('')
  const [assetToDelete, setAssetToDelete] = useState<AssetRecord | null>(null)
  const [maximumBatchCount, setMaximumBatchCount] = useState(8)
  const [agentPlannerModels, setAgentPlannerModels] = useState<string[]>(defaultAgentPlannerModels)
  const [composerLayout, setComposerLayout] = useState<ComposerLayout>(readComposerLayout)
  const [nodePalette, setNodePalette] = useState<NodePalettePosition | null>(null)
  const [revealingResultNodeIds, setRevealingResultNodeIds] = useState<Map<string, number>>(() => new Map())
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
  const [expandedResultGroupIds, setExpandedResultGroupIds] = useState<Set<string>>(() => new Set())
  const [activeResultByGroupId, setActiveResultByGroupId] = useState<Map<string, string>>(() => new Map())

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
  useRestoreFocus(Boolean(imagePreview || assetToDelete || nodePalette))
  const imagePreviewDialogRef = useDialogFocusTrap(Boolean(imagePreview))


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
  const workspaceView = workspaceLocation.view
  const {
    canvasHydrationFailed,
    hydrateCanvas,
    refreshAgentCanvasFromRemote,
    retryAgentCanvasPersistence,
    collaborationAwareness,
    dismissRemoteChange,
    clearCollaborationActivities,
    loadMoreCollaborationActivities,
    reloadCollaborationActivities,
  } = useCanvasWorkspaceSynchronization({
    workspaceActive: workspaceRestored && workspaceView === 'canvas',
    currentUserId: currentUser?.id,
  })
  const workspaceDocumentMismatch = workspaceView === 'canvas'
    && Boolean(workspaceLocation.projectId)
    && document.id !== workspaceLocation.projectId
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
      name: result.label ? canvasSystemLabel(result.label, locale) : t.selectedResult,
      image: result.image,
      settings: result.generationSettings ?? defaultGenerationSettings,
    }
  }, [batchComposerTargetId, document.nodes, locale, t.selectedResult])
  const regionEditTarget = useMemo(() => {
    if (!regionEditTargetId) return null
    const node = document.nodes.find((item) => item.id === regionEditTargetId && item.type === 'result')
    if (!node || node.type !== 'result') return null
    const result = node.data as ResultNodeData
    if (!result.image || result.mediaKind === 'video') return null
    return {
      id: node.id,
      name: result.label ? canvasSystemLabel(result.label, locale) : t.selectedResult,
      image: result.image,
      settings: result.generationSettings ?? result.generationRecipe?.settings ?? defaultGenerationSettings,
    }
  }, [document.nodes, locale, regionEditTargetId, t.selectedResult])
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
  const selectedNodeIdsRef = useRef<Set<string>>(new Set())
  const selectedNodeTransitionRef = useRef<string | null | undefined>(undefined)
  const skipAutoComposerNodeIdRef = useRef<string | null>(null)
  const resultComposerSubmissionRef = useRef(false)
  const renderedResultNodeStateRef = useRef<Map<string, { candidateId?: string; hasImage: boolean }> | null>(null)
  const resultRevealTimersRef = useRef<Map<string, number>>(new Map())
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

  const handleWorkspaceProjectOpened = useCallback((projectId: string) => {
    setWorkspaceView('canvas', projectId)
  }, [setWorkspaceView])

  const handleWorkspaceProjectDeleted = useCallback((projectId: string) => {
    setWorkspaceTabIds((current) => current.filter((id) => id !== projectId))
    if (workspaceLocation.view === 'canvas' && workspaceLocation.projectId === projectId) {
      setWorkspaceView('projects', undefined, 'replace')
    }
  }, [setWorkspaceView, workspaceLocation])

  const {
    projects: workspaceProjects,
    loading: workspaceProjectsLoading,
    error: workspaceProjectsError,
    refresh: refreshWorkspaceProjects,
    openProject: openWorkspaceProject,
    createProject: createWorkspaceProject,
    createProjectFromTemplate: createWorkspaceProjectFromTemplate,
    renameProject: renameWorkspaceProject,
    deleteProject: deleteWorkspaceProject,
  } = useWorkspaceProjectCoordinator({
    activeDocumentId: document.id,
    refreshKey: hydrated && (workspaceView === 'projects' || workspaceView === 'canvas')
      ? `${workspaceView}:${workspaceLocation.projectId ?? ''}`
      : null,
    navigationSequence: workspaceNavigationRunRef,
    openDocument,
    openNewDocument,
    renameDocument,
    createDocumentFromTemplate,
    onProjectOpened: handleWorkspaceProjectOpened,
    onProjectDeleted: handleWorkspaceProjectDeleted,
  })

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
        hasOutput: Boolean(result.image),
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
        name: result.label ? canvasSystemLabel(result.label, locale) : t.candidate((result.variant ?? candidates.length) + 1),
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
  }, [locale, resultGroupPresentation, resultNodesById, t])
  const hiddenResultNodeIds = useMemo(() => new Set([...resultGroupPresentation]
    .filter(([, presentation]) => presentation.hidden)
    .map(([nodeId]) => nodeId)), [resultGroupPresentation])
  const resetCanvasSelectionSurfaces = useCallback(() => {
    setNodeInspectorOpen(false)
    setNodePalette(null)
    setResultComposerDraft(null)
  }, [setNodeInspectorOpen])
  const canvasInteraction = useCanvasInteractionCoordinator({
    document,
    hydrated,
    restoredViewportZoom: restoredViewport.zoom,
    hiddenResultNodeIds,
    focusedLineageEdgeIds: focusedLineage.edgeIds,
    hasLineageFocus,
    assetLibraryAssets,
    assetLibraryTargetGenerateId,
    screenToFlowPositionRef,
    canvasPaneRef,
    viewportReadyRef,
    onSelectionReset: resetCanvasSelectionSurfaces,
  })
  const {
    zoomMode,
    isConnecting,
    connectionFeedback,
    selectedEdge,
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
    clearConnectionSelection,
  } = canvasInteraction
  const canvasDropPresence = useMotionPresence(canvasInteraction.isCanvasFileDragging, 100)

  useEffect(() => {
    const onPaste = (event: globalThis.ClipboardEvent) => {
      const target = event.target
      const element = target instanceof Element ? target : null
      // Agent 面板内部的粘贴由 AgentWorkspace 自己的 onPaste 处理（同一份判定式）。
      // 两个监听器管的是同一次事件，靠这个判定式互斥而不是互不重叠——
      // BotanicSelect 的下拉菜单用 createPortal 挂到 document.body，DOM 上不再
      // 是 .agent-workspace 的子孙，光靠 closest() 会漏判成「不在面板里」，
      // 导致这次粘贴被两边同时接了一遍。Agent 面板与画布侧的其它面板
      // （素材库、模板、批量变体等）互斥，同一时刻最多挂载一个，所以「面板已挂载」
      // 加上「粘贴目标在某个下拉菜单里」就能安全地反推出这个菜单属于 Agent 面板，
      // 不必去猜它具体是哪个 BotanicSelect 实例。
      const agentPanelMounted = Boolean(window.document.querySelector('.agent-workspace'))
      const insideAgentPanel = Boolean(element?.closest('.agent-workspace'))
        || (agentPanelMounted && Boolean(element?.closest('.botanic-select__menu')))
      const insideTextEntry = Boolean(
        element?.closest('input, textarea, [contenteditable="true"]'),
      )
      // 用「文档里是否存在打开的模态弹层」而不是从事件目标 closest() 向上找——
      // 焦点常常停在弹层的遮罩或 document.body 上，closest() 会完全漏掉它。
      // 只认 [aria-modal="true"]，不强制搭配 role="dialog"：alertdialog 之类的
      // 确认框也算模态，这与 Escape 键那条守卫用的是同一套口径。
      const modalOpen = Boolean(window.document.querySelector('[aria-modal="true"]'))
      const files = clipboardMediaFiles(Array.from(event.clipboardData?.items ?? []))
      if (pasteTarget({ hasMediaFiles: files.length > 0, insideAgentPanel, insideTextEntry, modalOpen }) !== 'canvas') return
      // 落点算不出来（React Flow 还没挂载，比如素材库/加载视图）就不要拦截默认行为——
      // 静默吞掉这次粘贴却什么都不做，正是这个功能一直在避免的那类问题。
      if (!pasteFilesToCanvasCenter(files)) return
      event.preventDefault()
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [pasteFilesToCanvasCenter])

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
            onOpenRegionEdit: setRegionEditTargetId,
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

  const canvasClassName = `app-shell app-shell--agent-${agentOpen ? 'open' : 'closed'}`
  const workspaceTabs = useMemo(() => {
    const projectsById = new Map(workspaceProjects.map((project) => [project.id, project]))
    if (!projectsById.has(document.id)) {
      projectsById.set(document.id, {
        id: document.id,
        name: document.name,
        updatedAt: document.updatedAt,
        cover: resultImage,
        summary: document.nodes.length ? t.builtNodes(document.nodes.length) : t.blankCanvasSummary,
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
  }, [closingWorkspaceTabId, document.id, document.name, document.nodes.length, document.updatedAt, t, workspaceProjects, workspaceTabIds])

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
        name: result.label ? canvasSystemLabel(result.label, locale) : (result.generationKind === 'refinement' ? t.refinedVersion : t.generatedImage),
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
  }, [document.history, document.nodes, locale, t])
  const deliveryTargets = useMemo<DeliveryPanelTarget[]>(() => generatedHistoryItems.flatMap((item) => (
    item.nodeId && canUseForImageDelivery(item.mediaKind)
      ? [{ nodeId: item.nodeId, versionId: item.versionId, image: item.image, label: item.name }]
      : []
  )), [generatedHistoryItems])
  const selectedCanvasNode = document.nodes.find((node) => node.id === selectedNodeId)
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
        label: resultComposerData.label ?? (resultComposerData.generationKind === 'refinement' ? t.refinedVersion : t.keyVisualVersion),
        recipe: resultComposerData.generationRecipe,
      }
    : undefined
  const prepareAgentOpen = useCallback(() => {
    setComposerOpen(false)
    setResultComposerDraft(null)
    setBatchComposerTargetId(null)
    setNodePalette(null)
    setAccountMenuAnchor(null)
    setAgentOpen(true)
  }, [setAgentOpen])
  const prepareAgentCanvasFocus = useCallback(() => {
    setComposerOpen(false)
    setResultComposerDraft(null)
  }, [])
  const agentBridge = useCanvasAgentExecutionBridge({
    document,
    agentOpen,
    selectedFocusNodeIds,
    selectedReadyResultId: selectedReadyResultData ? selectedResult!.id : undefined,
    onPrepareAgentOpen: prepareAgentOpen,
    onPrepareCanvasFocus: prepareAgentCanvasFocus,
  })
  openAgentForResultRef.current = agentBridge.openForResult
  const batchVariationProgressRun = batchVariationRuns.find((run) => run.status !== 'succeeded' && run.status !== 'cancelled')

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
  const selectedGeneratePromptTexts = selectedGenerateInputs.filter((node) => node.type === 'text')
  const selectedGeneratePromptText = selectedGeneratePromptTexts.length === 1 ? selectedGeneratePromptTexts[0] : undefined
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
      name: result.label ?? canvasSystemLabel('上游输出', locale),
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
  const selectedGenerateLabel = selectedGenerateData
    ? canvasSystemLabel(selectedGenerateIsVideo ? '视频生成' : selectedGenerateData.label, locale)
    : undefined
  const selectedVideoInputMode: VideoInputMode = selectedGenerateData?.videoInputMode
    ?? (composerReferences.some((reference) => reference.mediaKind === 'video') ? 'reference' : composerReferences.length === 2 ? 'first_last' : 'first_frame')
  const selectedVideoInputsValid = selectedVideoInputMode === 'reference'
    ? composerReferences.length > 0
    : selectedVideoInputMode === 'first_frame'
      ? composerReferences.length === 1 && composerReferences[0]?.mediaKind !== 'video'
      : composerReferences.length === 2 && composerReferences.every((reference) => reference.mediaKind !== 'video')
  const composerPrimaryReferenceName = selectedGenerateParent?.type === 'result'
    ? ((selectedGenerateParent.data as ResultNodeData).label ?? canvasSystemLabel('上游输出', locale))
    : (selectedGeneratePrimaryReference?.name ?? selectedGenerateParentReference?.name)
  if (canvasHydrationFailed) {
    return (
      <main className={canvasClassName}>
        <section className="canvas-pane canvas-loading" aria-label={t.initFailed}>
          <div>
            <span className="panel-eyebrow">BOTANIC CANVAS</span>
            <strong>{t.initFailed}</strong>
            <p>{t.initFailedDetail}</p>
            <button type="button" onClick={hydrateCanvas}>{t.retry}</button>
          </div>
        </section>
      </main>
    )
  }

  if (!hydrated || workspaceRestoring || workspaceDocumentMismatch) {
    return (
      <main className={canvasClassName}>
        <section className="canvas-pane canvas-loading canvas-loading--restoring" aria-label={t.loadingCanvas}>
          <DeferredWorkspaceIndicator />
        </section>
      </main>
    )
  }

  if (workspaceView === 'projects') {
    return (
      <Suspense fallback={<WorkspaceViewLoading />}><ProjectLibrary
        projects={workspaceProjects}
        currentUser={currentUser}
        loading={workspaceProjectsLoading}
        loadError={workspaceProjectsError}
        onSignOut={onSignOut}
        onReturnToLanding={onReturnToLanding}
        productHomeLabel={productHomeLabel}
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
          agentOpen ? 'has-agent-open' : '',
          composerOpen || resultComposerDraft || batchComposerTargetId ? 'has-open-composer' : '',
        ].filter(Boolean).join(' ')}
        aria-label={t.canvasLabel(document.name)}
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
          <button className="home-tab" onClick={() => { void refreshWorkspaceProjects(); setWorkspaceView('projects') }} aria-label={t.backProjects}><HomeIcon /> <span>{t.projects}</span></button>
          <span className="tab-divider" />
          <nav className="project-tabs" aria-label={t.openProjects}>
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
                        aria-label={t.projectName}
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
                      aria-label={t.openProject(project.name)}
                      title={active ? t.renameProject : undefined}
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
                    aria-label={t.closeProject(project.name)}
                    title={t.closeTab}
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
            aria-label={t.newProject}
          >
            <FigmaIcon src={plusIcon} />
          </button>
          <LanguageSwitcher className="canvas-language-switcher" />
          <button type="button" className="product-home-tab" onClick={onReturnToLanding} aria-label={productHomeLabel}>
            <span>{productHomeLabel}</span>
            <ArrowUpRightIcon />
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
          onConnectStart={canvasInteraction.startConnecting}
          onConnectEnd={(_, connectionState) => {
            canvasInteraction.finishConnecting(connectionState.isValid === true, Boolean(connectionState.toNode))
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
              agentBridge.attachNodeContext(node.id)
              setComposerOpen(false)
              setResultComposerDraft(null)
              setBatchComposerTargetId(null)
              clearConnectionSelection()
              setNodePalette(null)
              return
            }
            if (node.type === 'generate') showComposer()
            else setComposerOpen(false)
            clearConnectionSelection()
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
                ? (imageNode as ResultNodeData).label ?? canvasSystemLabel('生成结果', locale)
                : (imageNode as AssetNodeData).name,
              mediaKind: imageNode.mediaKind ?? 'image',
            })
          }}
          onPaneClick={() => {
            selectNode(null)
            clearConnectionSelection()
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
            ariaLabel={t.minimapLabel}
          /> : null}
          {!document.nodes.length ? (
            <Panel position="top-left" className="empty-canvas-guide-panel">
              <EmptyCanvasGuide
                onOpenAssets={() => openDockSurface('assets')}
                onOpenAgent={agentBridge.open}
                onAddImage={() => {
                  addGenerateNode({ x: 460, y: 330 }, 'image')
                  showComposer()
                }}
                onAddVideo={() => {
                  if (!availableModels.some((model) => model.mediaKind === 'video')) {
                    useCanvasStore.setState({ assistantMessage: t.videoModelMissing })
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
          {agentBridge.focusRequest ? <FocusCanvasNodes
            nodes={agentBridge.focusRequest.nodeIds.flatMap((nodeId) => {
              const node = renderedNodes.find((item) => item.id === nodeId)
              return node ? [node] : []
            })}
            requestId={agentBridge.focusRequest.requestId}
          /> : null}

          {multiSelectionPresence.present && visibleMultiSelectionCount ? <MultiSelectionToolbar count={visibleMultiSelectionCount} phase={multiSelectionPresence.phase} onClear={() => { selectNode(null); setComposerOpen(false) }} /> : null}
          {isConnecting || connectionFeedback ? <ConnectionGuide feedback={isConnecting ? null : connectionFeedback} /> : null}

          <Panel position="top-left" className="dock-panel">
            <nav className="dock" aria-label={t.canvasTools}>
              <button className="dock__add" onClick={(event) => openNodePalette(event, true)} aria-label={t.addNode}><FigmaIcon src={plusIcon} /></button>
              <button className={assetsOpen ? 'dock__button is-active' : 'dock__button'} onClick={() => openDockSurface('assets')} aria-label={t.openAssets}><FigmaIcon src={folderIcon} /></button>
              <button className={templatesOpen ? 'dock__button is-active' : 'dock__button'} onClick={() => openDockSurface('templates')} aria-label={t.templates}><FigmaIcon src={templatesIcon} /></button>
              <button className={historyOpen ? 'dock__button is-active' : 'dock__button'} onClick={() => openDockSurface('history')} aria-label={t.history}><FigmaIcon src={historyIcon} /></button>
              <button className={deliveryOpen ? 'dock__button dock__button--delivery is-active' : 'dock__button dock__button--delivery'} onClick={() => openDockSurface('delivery')} aria-label={t.delivery}><ArrowUpRightIcon /></button>
              <button ref={accountTriggerRef} data-account-menu-trigger className={accountMenuAnchor ? 'dock__account is-active' : 'dock__account'} aria-label={t.account} aria-expanded={Boolean(accountMenuAnchor)} onClick={(event) => {
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

        <Suspense fallback={null}>{batchVariationProgressRun ? <BatchVariationProgress
          run={batchVariationProgressRun}
          onRetry={(runId, itemId) => retryBatchVariationItem(runId, itemId)}
        /> : null}</Suspense>

        {!agentOpen ? <BobLauncher projectId={document.id} buttonRef={agentLauncherRef} label={t.openAgent} onOpen={agentBridge.open} /> : null}

        {agentOpen ? <Suspense fallback={<aside className="agent-workspace" aria-label="Botanic Agent"><div className="workspace-loading-indicator" role="status">{t.loadingAgent}</div></aside>}><AgentWorkspace
          key={`${document.id}:${agentBridge.activeSession?.id ?? 'none'}`}
          projectId={document.id}
          escapeEnabled={topOverlayLayer([
            'agent',
            ...(accountMenuAnchor || accountDialog ? ['account' as const] : []),
            ...(imagePreview ? ['preview' as const] : []),
            ...(assetToDelete ? ['confirmation' as const] : []),
          ]) === 'agent'}
          persistenceStatus={persistenceStatus}
          collaborationAwareness={collaborationAwareness}
          target={agentBridge.target}
          groups={document.assetGroups}
          sessions={document.agentSessions}
          session={agentBridge.activeSession}
          contextOptions={agentBridge.contextOptions}
          memory={document.agentMemory}
          artifacts={agentBridge.artifacts}
          artifactIndexStatus={agentBridge.artifactIndexStatus}
          artifactIndexHasMore={agentBridge.artifactIndexHasMore}
          latestRun={agentBridge.latestRun}
          runs={document.agentRuns}
          plannerModels={agentPlannerModels}
          generationModels={availableModels}
          onConfirm={agentBridge.confirmPlan}
          onConfirmAction={agentBridge.confirmAction}
          onUploadImages={agentBridge.addUploadedImages}
          onAppendMessage={appendAgentMessage}
          onUpdateMessage={updateAgentMessage}
          onUpdateAction={updateAgentAction}
          onContextChange={setAgentSessionContext}
          onExecutionModeChange={setAgentSessionExecutionMode}
          onPlannerModelChange={setAgentSessionPlannerModel}
          onSkillsChange={setAgentSessionSkills}
          onRenameSession={renameAgentSession}
          onAddMemory={addAgentMemory}
          onRemoveMemory={removeAgentMemory}
          onNewSession={agentBridge.newSession}
          onSelectSession={agentBridge.selectSession}
          onUpdateReadingAnchor={agentBridge.updateSessionReadingAnchor}
          onRetryBranch={(runId, branchId) => retryAgentBranch(runId, branchId)}
          onCancelRun={(runId) => cancelAgentRun(runId)}
          onLocateNode={selectNode}
          onFocusNodes={agentBridge.focusNodes}
          onResolveRunNodes={agentBridge.resolveRunNodes}
          onSaveArtifact={agentBridge.saveArtifact}
          onContinueArtifact={agentBridge.continueArtifact}
          onLoadMoreArtifacts={agentBridge.loadMoreArtifacts}
          onUseResultContext={agentBridge.useResultContext}
          onRetryPersistence={retryAgentCanvasPersistence}
          onRefreshRemote={refreshAgentCanvasFromRemote}
          onDismissRemoteChange={dismissRemoteChange}
          onClearCollaborationActivities={clearCollaborationActivities}
          onLoadMoreCollaborationActivities={loadMoreCollaborationActivities}
          onReloadCollaborationActivities={reloadCollaborationActivities}
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
            prompt={selectedGeneratePromptText
              ? (selectedGeneratePromptText.data as TextNodeData).content
              : selectedGenerateData.prompt}
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
              if (selectedGeneratePromptText) updateTextNode(selectedGeneratePromptText.id, prompt)
              else updateGenerateNode(selectedGenerate.id, { prompt })
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

        <Suspense fallback={null}>{batchComposerTarget ? <BatchVariationComposer
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
        /> : null}</Suspense>

        {regionEditTarget ? <RegionMaskEditor
          key={regionEditTarget.id}
          target={regionEditTarget}
          busy={generationStatus === 'uploading' || generationStatus === 'queued' || generationStatus === 'running' || generationStatus === 'recovering'}
          onSubmit={({ rect, prompt }) => {
            const submissionProjectId = document.id
            // 选区外由蒙版保持。标识类参考由 runRefinement 从原配方补回，供选区内合成。
            void runRefinement({
              targetNodeId: regionEditTarget.id,
              prompt,
              batchCount: 1,
              settings: regionEditTarget.settings,
              recipe: {
                references: [],
                prompt,
                batchCount: 1,
                settings: regionEditTarget.settings,
                maskRegion: rect,
              },
            }).then((started) => {
              if (useCanvasStore.getState().document.id !== submissionProjectId) return
              if (started) setRegionEditTargetId(null)
            })
          }}
          onClose={() => setRegionEditTargetId(null)}
        /> : null}

        {selectedEdge && edgeActionPosition ? (
          <EdgeActions
            edge={selectedEdge}
            position={edgeActionPosition}
            onDelete={removeSelectedEdge}
            onClose={clearConnectionSelection}
          />
        ) : null}

        {canvasDropPresence.present ? (
          <div className={`canvas-file-drop is-${canvasDropPresence.phase}`} aria-hidden="true">
            <span>{t.imageAsset}</span>
            <strong>{t.dropToAdd}</strong>
            <small>{t.uploadLimits}</small>
          </div>
        ) : null}
        {canvasUploadMessage ? <div className="canvas-upload-message" role="status">{canvasUploadMessage}</div> : null}
        <CanvasAssistantNotice message={assistantMessage} dismissLabel={t.dismissNotice} onDismiss={clearAssistantMessage} />
        {nodePalettePresence.present && visibleNodePalette ? (
          <div className={`node-palette is-${nodePalettePresence.phase}`} style={{ left: visibleNodePalette.screen.x, top: visibleNodePalette.screen.y }} role="dialog" aria-label={t.addCanvasNode} aria-hidden={nodePalettePresence.phase === 'exit' ? true : undefined} onPointerDown={(event) => event.stopPropagation()}>
            <div className="node-palette__title"><span>{visibleNodePalette.parentResultId ? t.addFromImage : visibleNodePalette.inputNodeId ? t.connectSelected : t.addNodeTitle}</span><button onClick={() => setNodePalette(null)} aria-label={t.closeAddNode}><CloseIcon /></button></div>
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
              <b><SparkleIcon /></b><span><strong>{t.imageGeneration}</strong><small>{visibleNodePalette.parentResultId ? t.continueImage : t.connectToGenerate}</small></span>
            </button>
            {visibleNodePalette.parentResultId ? <button onClick={() => {
              setBatchComposerTargetId(visibleNodePalette.parentResultId ?? null)
              setNodePalette(null)
            }}>
              <b>×N</b><span><strong>{t.batchVariations}</strong><small>{t.batchDetail}</small></span>
            </button> : null}
            <button onClick={() => {
              const videoModel = availableModels.find((model) => model.mediaKind === 'video')
              if (!videoModel) {
                setNodePalette(null)
                useCanvasStore.setState({ assistantMessage: t.videoModelMissing })
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
              <b className="node-palette__video-icon">▶</b><span><strong>{t.videoGeneration}</strong><small>{visibleNodePalette.parentResultId ? t.continueVideo : t.videoReferenceDetail}</small></span>
            </button>
            <button onClick={() => { setNodePalette(null); setAssetsOpen(true) }}>
              <b><FolderOutlineIcon /></b><span><strong>{t.assets}</strong><small>{t.assetsDetail}</small></span>
            </button>
            <div className="node-palette__upload"><span>{t.localImages}</span><button onClick={() => nodeFileInputRef.current?.click()}><UploadIcon />{t.uploadImages}</button></div>
          </div>
        ) : null}
        <input
          ref={nodeFileInputRef}
          className="asset-file-input"
          type="file"
          accept={imageUploadAccept()}
          multiple
          aria-label={t.uploadToCanvas}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? [])
            event.currentTarget.value = ''
            if (nodePalette && files.length) void addDroppedFilesToCanvas(files, nodePalette.flow)
            setNodePalette(null)
          }}
        />

        <CanvasPanelPresence open={assetsOpen} side="left">
          <Suspense fallback={null}><AssetLibrary
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
          /></Suspense>
        </CanvasPanelPresence>
        <CanvasPanelPresence open={templatesOpen} side="right">
          <Suspense fallback={null}><TemplatePanel
            key={document.id}
            projectId={document.id}
            canvasDocument={document}
            templates={document.templates}
            sharedTemplates={sharedTemplates}
            currentName={document.name}
            projectSaveSummary={projectTemplateSaveSummary}
            sharedSaveSummary={sharedTemplateSaveSummary}
            onSave={saveCurrentAsTemplate}
            onSaveShared={saveCurrentAsSharedTemplate}
            onCreateProject={createWorkspaceProjectFromTemplate}
            onRefresh={refreshSharedTemplates}
            onOpenHistory={() => {
              setTemplatesOpen(false)
              setHistoryOpen(true)
            }}
            onLocateWorkflowNode={(nodeId) => {
              selectNode(nodeId)
              setHistoryFocusRequest({ nodeId, requestId: Date.now() })
              setTemplatesOpen(false)
            }}
            onClose={() => setTemplatesOpen(false)}
          /></Suspense>
        </CanvasPanelPresence>
        <CanvasPanelPresence open={historyOpen} side="right">
          <Suspense fallback={null}><HistoryPanel
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
          /></Suspense>
        </CanvasPanelPresence>
        {nodeReferencesOpen && selectedGenerate ? (
          <Suspense fallback={null}><NodeReferencePanel
            node={{ id: selectedGenerate.id, data: selectedGenerate.data as GenerateNodeData }}
            references={canvasAssetReferences}
            connectedNodeIds={selectedGenerateReferenceNodeIds}
            disabled={generationStatus === 'uploading' || generationStatus === 'queued' || generationStatus === 'running' || generationStatus === 'recovering'}
            onToggle={(assetNodeId, enabled) => toggleNodeReference(selectedGenerate.id, assetNodeId, enabled)}
            onSetPrimary={(assetNodeId) => setGenerateNodePrimaryInput(selectedGenerate.id, assetNodeId)}
            onClose={() => setNodeReferencesOpen(false)}
          /></Suspense>
        ) : null}
        {candidatesOpen ? (
          <Suspense fallback={null}><GenerationPanel
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
          /></Suspense>
        ) : null}
        <CanvasPanelPresence open={deliveryOpen} side="right">
          <Suspense fallback={null}><DeliveryPanel
            target={selectedReadyResultData && selectedResult && canUseForImageDelivery(selectedReadyResultData.mediaKind) ? {
              nodeId: selectedResult.id,
              versionId: selectedReadyResultData.versionId,
              image: selectedReadyResultData.image!,
              label: selectedReadyResultData.label ?? (locale === 'en' ? 'Selected key visual' : '已选首图'),
            } : undefined}
            targets={deliveryTargets}
            blockedVideo={Boolean(selectedReadyResultData && !canUseForImageDelivery(selectedReadyResultData.mediaKind))}
            deliveries={document.deliveries}
            onCreate={createLocalDeliveries}
            onSelectTarget={selectNode}
            onClose={() => setDeliveryOpen(false)}
          /></Suspense>
        </CanvasPanelPresence>
        {assetDeletePresence.present && visibleAssetToDelete ? (
          <Suspense fallback={null}><ConfirmationDialog
            asset={visibleAssetToDelete}
            phase={assetDeletePresence.phase}
            onConfirm={() => {
              deleteAsset(visibleAssetToDelete.id)
              setAssetToDelete(null)
            }}
            onCancel={() => setAssetToDelete(null)}
          /></Suspense>
        ) : null}
        {imagePreviewPresence.present && visibleImagePreview ? (
          <div className={`image-preview-backdrop motion-overlay is-${imagePreviewPresence.phase}`} role="presentation" aria-hidden={imagePreviewPresence.phase === 'exit' ? true : undefined} onMouseDown={() => setImagePreview(null)}>
            <section ref={imagePreviewDialogRef} className="image-preview-dialog" role="dialog" aria-modal="true" aria-label={t.preview(visibleImagePreview.name)} onMouseDown={(event) => event.stopPropagation()}>
              <button className="image-preview-dialog__download" type="button" aria-label={t.downloadMedia} title={t.downloadMedia} onClick={() => void downloadMedia(visibleImagePreview.image, visibleImagePreview.name, visibleImagePreview.mediaKind)}><DownloadIcon /></button>
              <button className="image-preview-dialog__close" type="button" onClick={() => setImagePreview(null)} aria-label={t.closePreview}><CloseIcon /></button>
              {visibleImagePreview.mediaKind === 'video'
                ? <video src={visibleImagePreview.image} aria-label={visibleImagePreview.name} controls playsInline preload="metadata" />
                : <img src={visibleImagePreview.image} alt={visibleImagePreview.name} />}
            </section>
          </div>
        ) : null}

        <Suspense fallback={null}>{undoPresence.present && visibleUndoAction ? <UndoToast label={visibleUndoAction.label} phase={undoPresence.phase} onUndo={undoLastAction} /> : null}</Suspense>
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
