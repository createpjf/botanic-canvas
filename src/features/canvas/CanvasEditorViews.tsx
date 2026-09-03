import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react'
import { generationJobErrorCopy, generationTaskErrorMessage, generationTaskFeedback, type ResultGroupPresentation } from '../../domain/canvasPresentation'
import { reducedAspectRatio } from '../../domain/mediaPresentation'
import { mediaRetryUrl } from '../../domain/mediaRecovery'
import {
  applyClarityBoost,
  clarityBoostModel,
  clearClarityBoost,
  everydayResolutions,
  primaryGenerationReference,
  settingsForGenerationModel,
} from '../../domain/generationRecipe'
import { applyCustomGenerationSize, generationSettingsSizeLabel, modelSupportsCustomSize, withoutCustomGenerationSize } from '../../domain/generationOutputSize'
import { videoAspectRatioPolicy } from '../../domain/videoGeneration'
import { useMotionPresence } from '../../components/motionPresence'
import { GenerationDotsField } from '../../components/GenerationDotsField'
import { BotanicSelect } from '../../components/BotanicSelect'
import { modelDisplayLabel, modelProviderLogo } from '../../components/generationModelPresentation'
import type { AssetNodeData, AssetRole, AssetSource, CanvasNode, GenerateNodeData, GenerationMediaKind, GenerationModelOption, GenerationSettings, PromptNodeData, ReferenceGroupNodeData, RefinementMode, ResultNodeData, TextNodeData, VideoInputMode } from '../../domain/canvas'
import { CanvasFrameNode } from './CanvasFrameNode'
import { downloadMedia } from '../../lib/mediaDownload'
import { refinePrompt } from '../../lib/promptRefinementApi'
import { refreshProductMediaSession } from '../../lib/productSession'
import { useCanvasStore } from '../../store/canvasStore'
import { ArrowUpIcon, ArrowUpRightIcon, ChevronDownIcon, CloseIcon, DeleteIcon, DownloadIcon, PlusIcon, PlusSquareIcon, SparkleIcon } from '../../components/BotanicIcons'
import { localizeProductError } from '../../i18n/core'
import { useProductI18n, useProductMessages } from '../../i18n/react'
import { canvasAssetRoleLabel, canvasDurationLabel, canvasSystemLabel } from './canvasI18n'
const editorMessages = {
  'zh-CN': {
    options: (label: string) => `${label}选项`, imageName: '图片名称', rename: '点击重命名', removeFromCanvas: (name: string) => `从画布移除 ${name}`,
    connectFrom: (name: string) => `从 ${name} 连线`, dragToGenerator: '从这里拖到生成节点的输入端', description: '描述', content: (name: string) => `${name}内容`,
    textPlaceholder: '写下描述或文案要求', expandAll: '展开全文', collapse: '收起', fold: '折叠', textFooter: '连到生成节点，作为本次描述',
    upstreamOutput: '上游输出', inputPort: (name: string) => `${name} 输入端`, connectVisual: '将图片或已选首图连到这里', autoOutput: (name: string) => `${name} 自动输出端`, autoOutputHint: '任务完成后，系统会自动创建输出图片',
    references: (count: number) => `${count} 参考`, connectedReferences: (count: number) => `已连接 ${count} 个参考`, connectReferences: '连接参考素材后即可生成', textConnected: '描述已连到文本节点', editGeneration: '点击节点，编辑本次生成描述与参数', editThis: '点击编辑本次生成', connectPrimary: '先连接主商品后生成',
    firstFrameTitle: '保持首帧', firstFrameDetail: '保持起始画面，比例跟随素材', firstLastTitle: '首尾帧', firstLastDetail: '补间两张图片，比例跟随素材', referenceTitle: '扩展画面', referenceDetail: '按所选比例智能补全，画面可能略有变化',
    addTail: '请添加尾帧', addFirstLast: '请添加首帧和尾帧', addFirst: '请添加首帧', addReference: '请添加参考素材', firstBadge: '首', lastBadge: '尾',
    refineFailed: '润色失败。', unchanged: (detail: string) => `${detail.replace(/[。！!?]+$/, '')}，原文未修改。`, composerLabel: (result: boolean, name: string) => `${result ? '基于此图继续生成' : '生成器'}：${name}`,
    dragComposer: '拖动移动生成器', manageReferences: (count: number) => `管理本次 ${count} 个参考`, manageReferenceTitle: '管理参考', addReferenceAsset: '添加参考素材', addReferenceShort: '添加参考', collapseComposer: '折叠生成器', expandComposer: '展开生成器', closeComposer: '关闭生成器', close: '关闭',
    promptLabel: (name: string) => `${name}描述`, imagePrompt: '描述商品、场景、构图、光线与留白要求', videoPrompt: '描述主体动作、镜头运动、节奏与场景变化', refined: 'Botanic 结构润色已应用', refinePrompt: (video: boolean) => `润色${video ? '视频' : '图像'}生成描述`, refineTitle: '润色描述', refining: '正在按 Botanic 结构润色…', refineFallback: '润色失败，原文未修改。',
    videoInputMode: '视频输入模式', videoInput: '视频输入', chooseVideoInput: '选择视频输入方式', firstFrame: '首帧', firstLast: '首尾帧', referenceAsset: '参考素材', continuationMode: '继续生成方式', faithful: '忠实精修', explore: '探索变体', faithfulDetail: '保留构图与主体，仅执行描述中的改动。', exploreDetail: '保留主体，主动探索构图、机位与光影。',
    commonSettings: '常用生成参数', model: '模型', chooseModel: '选择生成模型', unavailable: '不可用', modelUnavailable: '当前部署未配置此模型', duration: '时长', chooseDuration: '选择视频时长', candidates: '张数', chooseCandidateCount: '选择张数', resultSet: (index: number, total: number) => `${index}/${total} 张`, output: '输出', followAsset: '跟随素材', frame: '画幅', decidedByInput: '由输入素材决定', chooseRatio: '选择画面比例', resolution: '清晰度', chooseResolution: '选择输出清晰度', clarityBoost: '4K', searchGrounding: '参考网页', thinking: '思考', thinkingHigh: '充分', thinkingMinimal: '精简', customPixels: '自定义像素', multiple16: '须为 16 的倍数', width: '宽', height: '高', customWidth: '自定义输出宽度', customHeight: '自定义输出高度', invalidSize: '自定义宽高无效。', snapped: (width: number, height: number) => `已对齐为 ${width}×${height}`, apply: '应用',
    recovering: '正在确认任务，请勿重复提交…', uploading: '正在上传参考素材…', queued: '任务已入队…', serviceGenerating: (video: boolean) => `${video ? '视频' : '图像'}服务正在生成…`, primaryReference: (name: string) => `主参考 · ${name}`, ready: '参数已准备好，提交后会在画布中创建新的结果节点。', modeNeeds: (title: string, requirement: string) => `${title}模式需要${requirement}`, twoImages: '按顺序连接 2 张图片', oneImage: '连接 1 张图片', oneReference: '连接至少 1 个图片或视频参考', setPrimary: '连接并设置主商品后即可生成。', generating: '生成中…', generate: '生成', mediaTagImage: '图片', mediaTagVideo: '视频', previewEmpty: '等待生成预览', addReferenceHint: '添加参考后即可生成',
    taskStatuses: { uploading: '提交素材', submission_unknown: '等待确认', queued: '任务排队', running: '生成中', succeeded: '待挑选', failed: '任务失败', cancelled: '已取消' }, waitedSeconds: (seconds: number) => `已等待 ${seconds} 秒`, waitedMinutes: (minutes: number, seconds: number) => seconds ? `已等待 ${minutes} 分 ${seconds} 秒` : `已等待 ${minutes} 分`,
    promptInput: '描述输入端', promptOutput: '从描述连线', refinementBrief: '定向精修指令', creativeDirection: '描述', taskAttention: '任务需要处理', referenceInput: '参考组输入端', referenceOutput: '从参考组连线', primaryProduct: (name: string) => `主商品 · ${name}`, noPrimary: '未锁定主商品',
    refinedVersion: '精修版本', generatedVersion: '生成版本', automaticOutput: '自动输出端', writtenAutomatically: '由生成节点在任务完成后自动写入', connectResult: '从结果连线', connectVideoResult: '连接到 H3 节点作为参考视频', connectImageResult: '将这张生成结果连到下一生成节点', connectPendingResult: '任务完成后可将生成结果连到下一节点',
    deleteResult: (name: string) => `删除 ${name}`, deleteResultTitle: '删除这个结果节点', download: (name: string) => `下载 ${name}`, downloadOriginal: '下载原图', savedLabel: (name: string) => `${name} 已入库`, saveLabel: (name: string) => `将 ${name} 入库`, saved: '已入库', save: '入库', saveTitle: '存入素材库',
    mediaUnavailable: '媒体无法显示', taskIncomplete: '任务未完成', taskCancelled: '任务已取消', waitingResult: '等待生成结果', mediaError: '媒体读取失败，可能是登录状态或网络中断。', waitingService: '等待生成服务返回结果。', realStatus: '生成服务的真实状态会在此同步。', reload: '重新加载', confirmNow: '立即确认', cancel: '取消', retryRecipe: '用原参数重试', deleteTask: '删除任务', fillMissing: (count: number) => `补 ${count} 张`, collapseCandidates: '收起结果', viewCandidates: (count: number) => `查看 ${count} 张`, candidateCount: (count: number) => `${count} 张`, candidatesThisRun: '本次结果', chooseCandidateHint: '点一张在当前节点查看', waiting: '等待结果', branched: '已形成分支', current: '当前', view: '查看', agentEdit: 'Agent 修改', addNode: '继续生成', continueFromAsset: '引用该节点生成', addContext: '添加上下文',
    restoringTask: '正在恢复任务', noResubmit: '请勿重复提交，联网后自动确认', preparing: '准备生成', lockingReferences: '正在锁定参考', generatingTask: '正在生成', enteredQueue: '已进入队列', keepEditing: '可继续编辑画布', generationConnectionError: '生成服务连接中断，请重试。',
  },
  en: {
    options: (label: string) => `${label} options`, imageName: 'Image name', rename: 'Click to rename', removeFromCanvas: (name: string) => `Remove ${name} from canvas`,
    connectFrom: (name: string) => `Connect from ${name}`, dragToGenerator: 'Drag to a generation node input', description: 'Description', content: (name: string) => `${name} content`,
    textPlaceholder: 'Prompt or copy notes', expandAll: 'Show all', collapse: 'Collapse', fold: 'Fold', textFooter: 'Connect to a generation node as the prompt',
    upstreamOutput: 'Upstream output', inputPort: (name: string) => `${name} input`, connectVisual: 'Connect an image or selected key visual', autoOutput: (name: string) => `${name} automatic output`, autoOutputHint: 'Created automatically when the task finishes',
    references: (count: number) => `${count} ${count === 1 ? 'reference' : 'references'}`, connectedReferences: (count: number) => `${count} ${count === 1 ? 'reference' : 'references'} connected`, connectReferences: 'Connect refs to generate', textConnected: 'Prompt connected to a text node', editGeneration: 'Select to edit prompt and settings', editThis: 'Select to edit this generation', connectPrimary: 'Connect a primary product first',
    firstFrameTitle: 'Keep first frame', firstFrameDetail: 'Keep the opening frame; ratio follows the source', firstLastTitle: 'First and last frames', firstLastDetail: 'Interpolate two images; ratio follows the source', referenceTitle: 'Extend frame', referenceDetail: 'Fill to the selected ratio. The frame may shift.',
    addTail: 'Add an ending frame', addFirstLast: 'Add first and ending frames', addFirst: 'Add a first frame', addReference: 'Add a reference asset', firstBadge: 'F', lastBadge: 'L',
    refineFailed: 'Refinement failed.', unchanged: (detail: string) => `${detail.replace(/[.!?]+$/, '')}. The original text was not changed.`, composerLabel: (result: boolean, name: string) => `${result ? 'Continue from this image' : 'Generator'}: ${name}`,
    dragComposer: 'Drag to move generator', manageReferences: (count: number) => `Manage ${count} ${count === 1 ? 'reference' : 'references'}`, manageReferenceTitle: 'Manage references', addReferenceAsset: 'Add reference asset', addReferenceShort: 'Add reference', collapseComposer: 'Collapse generator', expandComposer: 'Expand generator', closeComposer: 'Close generator', close: 'Close',
    promptLabel: (name: string) => `${name} description`, imagePrompt: 'Product, scene, composition, light, and negative space', videoPrompt: 'Subject motion, camera, pacing, and scene change', refined: 'Botanic structure applied', refinePrompt: (video: boolean) => `Refine ${video ? 'video' : 'image'} prompt`, refineTitle: 'Refine prompt', refining: 'Refining with Botanic structure…', refineFallback: 'Refinement failed. Original text kept.',
    videoInputMode: 'Video input mode', videoInput: 'Video input', chooseVideoInput: 'Choose video input', firstFrame: 'First frame', firstLast: 'First + last', referenceAsset: 'Reference asset', continuationMode: 'Continuation mode', faithful: 'Faithful edit', explore: 'Explore variations', faithfulDetail: 'Keep composition and subject. Apply only the requested edits.', exploreDetail: 'Keep the subject. Explore framing, camera, and light.',
    commonSettings: 'Generation settings', model: 'Model', chooseModel: 'Choose generation model', unavailable: 'Unavailable', modelUnavailable: 'This model is not configured for the current deployment', duration: 'Duration', chooseDuration: 'Choose video duration', candidates: 'Images', chooseCandidateCount: 'Choose image count', resultSet: (index: number, total: number) => `${index}/${total}`, output: 'Output', followAsset: 'Follow source', frame: 'Aspect ratio', decidedByInput: 'Determined by input assets', chooseRatio: 'Choose aspect ratio', resolution: 'Resolution', chooseResolution: 'Choose output resolution', clarityBoost: '4K', searchGrounding: 'Web reference', thinking: 'Thinking', thinkingHigh: 'High', thinkingMinimal: 'Minimal', customPixels: 'Custom pixels', multiple16: 'Must be a multiple of 16', width: 'W', height: 'H', customWidth: 'Custom output width', customHeight: 'Custom output height', invalidSize: 'Invalid custom dimensions.', snapped: (width: number, height: number) => `Adjusted to ${width}×${height}`, apply: 'Apply',
    recovering: 'Confirming task. Do not submit again…', uploading: 'Uploading refs…', queued: 'Task queued…', serviceGenerating: (video: boolean) => `${video ? 'Video' : 'Image'} service is generating…`, primaryReference: (name: string) => `Primary reference · ${name}`, ready: 'Ready. Submit to create a result node.', modeNeeds: (title: string, requirement: string) => `${title} mode needs ${requirement}`, twoImages: '2 images in order', oneImage: '1 connected image', oneReference: 'at least 1 image or video ref', setPrimary: 'Set a primary product to generate.', generating: 'Generating…', generate: 'Generate', mediaTagImage: 'Image', mediaTagVideo: 'Video', previewEmpty: 'Preview pending', addReferenceHint: 'Add a reference to generate',
    taskStatuses: { uploading: 'Uploading assets', submission_unknown: 'Awaiting confirmation', queued: 'Queued', running: 'Generating', succeeded: 'Ready to pick', failed: 'Failed', cancelled: 'Cancelled' }, waitedSeconds: (seconds: number) => `Waiting ${seconds}s`, waitedMinutes: (minutes: number, seconds: number) => seconds ? `Waiting ${minutes}m ${seconds}s` : `Waiting ${minutes}m`,
    promptInput: 'Prompt input', promptOutput: 'Connect from prompt', refinementBrief: 'Directed refinement brief', creativeDirection: 'Prompt', taskAttention: 'Task needs attention', referenceInput: 'Reference group input', referenceOutput: 'Connect from reference group', primaryProduct: (name: string) => `Primary product · ${name}`, noPrimary: 'No primary product',
    refinedVersion: 'Refined version', generatedVersion: 'Generated version', automaticOutput: 'Automatic output', writtenAutomatically: 'Written automatically when the generation task finishes', connectResult: 'Connect from result', connectVideoResult: 'Connect to an H3 node as a video reference', connectImageResult: 'Connect this result to the next generation node', connectPendingResult: 'Connect this result to the next node when the task finishes',
    deleteResult: (name: string) => `Delete ${name}`, deleteResultTitle: 'Delete this result node', download: (name: string) => `Download ${name}`, downloadOriginal: 'Download original', savedLabel: (name: string) => `${name} saved`, saveLabel: (name: string) => `Save ${name} to library`, saved: 'Saved', save: 'Save', saveTitle: 'Save to asset library',
    mediaUnavailable: 'Media unavailable', taskIncomplete: 'Task incomplete', taskCancelled: 'Task cancelled', waitingResult: 'Waiting for result', mediaError: 'The media could not be loaded. Your session or network may have been interrupted.', waitingService: 'Waiting for the generation service to return a result.', realStatus: 'The confirmed generation status will appear here.', reload: 'Reload', confirmNow: 'Confirm now', cancel: 'Cancel', retryRecipe: 'Retry with original settings', deleteTask: 'Delete task', fillMissing: (count: number) => `Generate ${count} missing`, collapseCandidates: 'Collapse results', viewCandidates: (count: number) => `View ${count} ${count === 1 ? 'image' : 'images'}`, candidateCount: (count: number) => `${count} ${count === 1 ? 'image' : 'images'}`, candidatesThisRun: 'This run', chooseCandidateHint: 'Select one to view it on this node', waiting: 'Waiting', branched: 'Branched', current: 'Current', view: 'View', agentEdit: 'Edit with Agent', addNode: 'Continue', continueFromAsset: 'Generate from this node', addContext: 'Add context',
    restoringTask: 'Restoring task', noResubmit: 'Do not submit again. It will be confirmed when you reconnect.', preparing: 'Preparing generation', lockingReferences: 'Locking references', generatingTask: 'Generating', enteredQueue: 'Entered queue', keepEditing: 'You can keep editing the canvas', generationConnectionError: 'The generation service connection was interrupted. Try again.',
  },
} as const

export type ComposerLayout = {
  dock: 'bottom' | 'free'
  x?: number
  y?: number
  collapsed: boolean
}

function primaryReferenceFromRecipe(recipe?: import('../../domain/canvas').GenerationRecipe) {
  return recipe ? primaryGenerationReference(recipe) : undefined
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
  const t = useProductMessages(editorMessages)
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
      event.preventDefault()
      event.stopPropagation()
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
      <ChevronDownIcon className="composer-option-trigger__chevron" />
    </button>
    {menuPresence.present && anchor && typeof document !== 'undefined' ? createPortal(
      <div
        ref={menuRef}
        id={menuId}
        className={`composer-option-menu ${className} is-${menuPresence.phase}`.trim()}
        style={{ left: anchor.left, bottom: anchor.bottom, width }}
        role="dialog"
        aria-label={t.options(label)}
        aria-hidden={menuPresence.phase === 'exit' ? true : undefined}
        onKeyDown={moveMenuFocus}
      >{children(() => setOpen(false))}</div>,
      document.body,
    ) : null}
  </div>
}

function AspectRatioGlyph({ ratio }: { ratio: string }) {
  const [width = 1, height = 1] = ratio.split(':').map(Number)
  const scale = 17 / Math.max(width, height, 1)
  return <i className="composer-aspect-glyph" style={{ width: `${Math.max(7, width * scale)}px`, height: `${Math.max(7, height * scale)}px` }} aria-hidden="true" />
}

function imagePreviewSize(imageWidth: number, imageHeight: number) {
  const scale = Math.min(320 / imageWidth, 340 / imageHeight, 1)
  return {
    width: Math.max(1, Math.round(imageWidth * scale)),
    height: Math.max(1, Math.round(imageHeight * scale)),
  }
}

function ImageNodeTitle({ nodeId, name }: { nodeId: string; name: string }) {
  const t = useProductMessages(editorMessages)
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
        aria-label={t.imageName}
        title={t.rename}
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
            event.preventDefault()
            event.stopPropagation()
            discardPendingRename.current = true
            setDraft(name)
            event.currentTarget.blur()
          }
        }}
      />
    </div>
  )
}

export type AssetNodeUiData = AssetNodeData & {
  __ui?: {
    workingGenerateId?: string
    onOpenAddMenu?: (assetNodeId: string, screen: { x: number; y: number }) => void
    onOpenAddContext?: (mediaNodeId: string) => void
    onOpenAssets?: (generateNodeId: string) => void
    maximumBatchCount?: number
    onRemoveGenerate?: (generateNodeId: string) => void
  }
}

function MediaPortHandle({
  handleId,
  type,
  ariaLabel,
  title,
  onClick,
}: {
  handleId: string
  type: 'source' | 'target'
  ariaLabel: string
  title: string
  onClick?: (screen: { x: number; y: number }) => void
}) {
  const origin = useRef<{ x: number; y: number } | null>(null)
  const dragged = useRef(false)
  return (
    <Handle
      className={`flow-handle flow-handle--add ${type === 'source' ? 'flow-handle--source flow-handle--add-source' : 'flow-handle--target flow-handle--add-target'}`}
      id={handleId}
      type={type}
      position={type === 'source' ? Position.Right : Position.Left}
      aria-label={ariaLabel}
      title={title}
      onPointerDown={(event) => {
        origin.current = { x: event.clientX, y: event.clientY }
        dragged.current = false
      }}
      onPointerMove={(event) => {
        if (!origin.current) return
        const dx = event.clientX - origin.current.x
        const dy = event.clientY - origin.current.y
        if (dx * dx + dy * dy > 25) dragged.current = true
      }}
      onPointerUp={(event) => {
        const wasDrag = dragged.current
        origin.current = null
        dragged.current = false
        if (wasDrag || !onClick) return
        event.stopPropagation()
        onClick({ x: event.clientX, y: event.clientY })
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <PlusIcon />
    </Handle>
  )
}

function AssetNode({ data, id, selected }: NodeProps) {
  const t = useProductMessages(editorMessages)
  const asset = data as AssetNodeUiData
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
  const onOpenAddMenu = asset.__ui?.onOpenAddMenu
  const onOpenAddContext = asset.__ui?.onOpenAddContext
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
        aria-label={t.removeFromCanvas(asset.name)}
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
      {selected && asset.__ui?.workingGenerateId ? (
        <div className="media-compose-dock generate-node is-editing is-dock-only nodrag nowheel">
          <GenerateDock
            generateId={asset.__ui.workingGenerateId}
            onOpenAssets={asset.__ui.onOpenAssets}
            maximumBatchCount={asset.__ui.maximumBatchCount}
            onRemove={asset.__ui.onRemoveGenerate}
          />
        </div>
      ) : null}
      {!asset.deleted ? (
        <>
          <MediaPortHandle
            handleId="context"
            type="target"
            ariaLabel={t.addContext}
            title={t.addContext}
            onClick={onOpenAddContext ? () => onOpenAddContext(id) : undefined}
          />
          <MediaPortHandle
            handleId="asset-output"
            type="source"
            ariaLabel={t.continueFromAsset}
            title={t.continueFromAsset}
            onClick={onOpenAddMenu ? (screen) => onOpenAddMenu(id, screen) : undefined}
          />
        </>
      ) : null}
    </div>
  )
}

/** 输入停顿多久后才把文字节点内容提交到文档。 */
const textNodeCommitDelayMs = 300

function TextNode({ data, id, selected }: NodeProps) {
  const t = useProductMessages(editorMessages)
  const text = data as TextNodeData
  const updateTextNode = useCanvasStore((state) => state.updateTextNode)
  const removeNodeFromCanvas = useCanvasStore((state) => state.removeNodeFromCanvas)
  // 每次按键都提交整份文档会触发全画布重渲染与一次持久化写入，节点一多就打不动字。
  // 输入期间只更新本地草稿，停顿或失焦后再提交一次。
  const [draft, setDraft] = useState(text.content)
  const committedRef = useRef(text.content)
  const commitTimerRef = useRef<number | null>(null)
  const [focused, setFocused] = useState(false)
  const [expanded, setExpanded] = useState(false)

  // 协作、撤销等外部改动要同步回输入框；自己提交造成的回流不覆盖正在输入的内容。
  useEffect(() => {
    if (text.content === committedRef.current) return
    committedRef.current = text.content
    setDraft(text.content)
  }, [text.content])

  useEffect(() => () => {
    if (commitTimerRef.current !== null) window.clearTimeout(commitTimerRef.current)
  }, [])

  const commitContent = (value: string) => {
    if (commitTimerRef.current !== null) {
      window.clearTimeout(commitTimerRef.current)
      commitTimerRef.current = null
    }
    if (value === committedRef.current) return
    committedRef.current = value
    updateTextNode(id, value)
  }

  const longContent = draft.length > 48 || draft.split('\n').length > 2
  const collapsed = longContent && !selected && !focused && !expanded

  return (
    <div className={`graph-node text-node${selected ? ' is-selected' : ''}${collapsed ? ' is-collapsed' : ''}${expanded || focused ? ' is-expanded' : ''}`}>
      <span className="graph-node__port-label graph-node__port-label--out">{t.description}</span>
      <Handle
        className="flow-handle flow-handle--graph flow-handle--source"
        id="output"
        type="source"
        position={Position.Right}
        aria-label={t.connectFrom(text.label)}
        title={t.dragToGenerator}
      />
      <header className="graph-node__header">
        <span className="graph-node__eyebrow">TEXT</span>
        <strong>{text.label}</strong>
        <button
          className="graph-node__remove nodrag"
          type="button"
          aria-label={t.removeFromCanvas(text.label)}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            removeNodeFromCanvas(id)
          }}
        ><DeleteIcon /></button>
      </header>
      <textarea
        className="nodrag nowheel"
        value={draft}
        aria-label={t.content(text.label)}
        placeholder={t.textPlaceholder}
        onClick={(event) => event.stopPropagation()}
        onFocus={() => setFocused(true)}
        onChange={(event) => {
          const { value } = event.target
          setDraft(value)
          if (commitTimerRef.current !== null) window.clearTimeout(commitTimerRef.current)
          commitTimerRef.current = window.setTimeout(() => {
            commitTimerRef.current = null
            commitContent(value)
          }, textNodeCommitDelayMs)
        }}
        onBlur={(event) => {
          setFocused(false)
          commitContent(event.currentTarget.value)
        }}
      />
      {longContent ? <button
        type="button"
        className="text-node__expand nodrag"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          setExpanded((open) => !open)
        }}
      >{collapsed ? t.expandAll : expanded ? t.collapse : t.fold}</button> : null}
      <footer>{t.textFooter}</footer>
    </div>
  )
}

export type GenerateNodeUiData = GenerateNodeData & {
  __ui?: {
    onOpenAssets?: (generateNodeId: string) => void
    maximumBatchCount?: number
    onRemoveGenerate?: (generateNodeId: string) => void
  }
}

export function GenerateDock({
  generateId,
  onOpenAssets,
  maximumBatchCount: maximumBatchCountOverride,
  onRemove,
}: {
  generateId: string
  onOpenAssets?: (generateNodeId: string) => void
  maximumBatchCount?: number
  onRemove?: (generateNodeId: string) => void
}) {
  const { locale } = useProductI18n()
  const t = useProductMessages(editorMessages)
  const generateNode = useCanvasStore((state) => state.document.nodes.find((node) => node.id === generateId))
  const generate = generateNode?.type === 'generate' ? generateNode.data as GenerateNodeData : undefined
  const document = useCanvasStore((state) => state.document)
  const availableModels = useCanvasStore((state) => state.availableModels)
  const unavailableModels = useCanvasStore((state) => state.unavailableModels)
  const maximumBatchCount = useCanvasStore((state) => maximumBatchCountOverride ?? state.maximumBatchCount)
  const generationStatus = useCanvasStore((state) => state.generationStatus)
  const generationError = useCanvasStore((state) => state.generationError)
  const removeNodeFromCanvas = useCanvasStore((state) => state.removeNodeFromCanvas)
  const updateGenerateNode = useCanvasStore((state) => state.updateGenerateNode)
  const updateTextNode = useCanvasStore((state) => state.updateTextNode)
  const runGraphGeneration = useCanvasStore((state) => state.runGraphGeneration)
  const clearGenerationError = useCanvasStore((state) => state.clearGenerationError)
  const id = generateId
  const rawGenerateLabel = generate && generate.settings.duration !== undefined && generate.label === '图像生成' ? '视频生成' : generate?.label
  const generateLabel = canvasSystemLabel(rawGenerateLabel ?? '', locale)

  const connectedInputs = useMemo(() => {
    const inputIds = document.edges.filter((edge) => edge.target === id).map((edge) => edge.source)
    const ordered = [
      ...(generate?.inputOrder ?? []).filter((nodeId) => inputIds.includes(nodeId)),
      ...inputIds.filter((nodeId) => !(generate?.inputOrder ?? []).includes(nodeId)),
    ]
    return ordered
      .map((nodeId) => document.nodes.find((node) => node.id === nodeId))
      .filter((node): node is CanvasNode => Boolean(node))
  }, [document.edges, document.nodes, generate?.inputOrder, id])

  const inputSummary = useMemo(() => ({
    images: connectedInputs.filter((node) => node.type === 'asset').length,
    texts: connectedInputs.filter((node) => node.type === 'text').length,
    results: connectedInputs.filter((node) => node.type === 'result').length,
    readyResults: connectedInputs.filter((node) => node.type === 'result' && Boolean((node.data as ResultNodeData).image)).length,
  }), [connectedInputs])

  const promptTextNode = connectedInputs.filter((node) => node.type === 'text').length === 1
    ? connectedInputs.find((node) => node.type === 'text')
    : undefined
  const promptValue = promptTextNode
    ? (promptTextNode.data as TextNodeData).content
    : generate?.prompt ?? ''

  const references = connectedInputs.flatMap((node) => {
    if (node.type === 'asset') {
      const asset = node.data as AssetNodeData
      return [{
        id: node.id,
        image: asset.image,
        name: asset.name,
        role: asset.role,
        primary: node.id === generate?.primaryInputId,
        mediaKind: asset.mediaKind ?? 'image' as GenerationMediaKind,
      }]
    }
    if (node.type === 'result') {
      const result = node.data as ResultNodeData
      if (!result.image) return []
      return [{
        id: node.id,
        image: result.image,
        name: result.label ? canvasSystemLabel(result.label, locale) : t.upstreamOutput,
        role: (result.mediaKind === 'video' ? '调性' : '首图') as AssetRole,
        primary: result.mediaKind !== 'video',
        mediaKind: result.mediaKind ?? 'image' as GenerationMediaKind,
      }]
    }
    return []
  })

  const hasPrimaryInput = Boolean(generate && document.edges.some((edge) => edge.source === generate.primaryInputId && edge.target === id))

  const catalogModels = [...availableModels, ...unavailableModels]
  const activeMediaKind = catalogModels.find((model) => model.id === generate?.settings.model)?.mediaKind
    ?? (generate?.settings.duration === undefined ? 'image' : 'video')
  const compatibleModels = catalogModels.filter((model) => (model.mediaKind ?? 'image') === activeMediaKind)
  const modelOptions = generate && compatibleModels.some((model) => model.id === generate.settings.model)
    ? compatibleModels
    : generate
      ? [{ id: generate.settings.model, label: generate.settings.model, mediaKind: activeMediaKind, available: false, unavailableReason: t.modelUnavailable }, ...compatibleModels]
      : compatibleModels
  const selectedModel = generate ? modelOptions.find((model) => model.id === generate.settings.model) : undefined
  const mediaKind = selectedModel?.mediaKind ?? activeMediaKind
  const isVideoModel = mediaKind === 'video'
  const videoInputMode: VideoInputMode = generate?.videoInputMode
    ?? (references.some((reference) => reference.mediaKind === 'video') ? 'reference' : references.length === 2 ? 'first_last' : 'first_frame')
  const videoRatioPolicy = videoAspectRatioPolicy(videoInputMode, generate?.settings.aspectRatio ?? '1:1')
  const modelLabel = `${modelDisplayLabel(selectedModel) || generate?.settings.model || ''}${selectedModel?.available === false ? ` · ${t.unavailable}` : ''}`
  const batchLimit = maximumBatchCount
  const isGenerating = generationStatus === 'uploading' || generationStatus === 'queued' || generationStatus === 'running' || generationStatus === 'recovering'
  const videoInputsValid = videoInputMode === 'reference'
    ? references.length > 0
    : videoInputMode === 'first_frame'
      ? references.length === 1 && references[0]?.mediaKind !== 'video'
      : references.length === 2 && references.every((reference) => reference.mediaKind !== 'video')
  const canGenerate = selectedModel?.available !== false && (isVideoModel ? videoInputsValid : Boolean(hasPrimaryInput || inputSummary.readyResults || references.some((item) => item.primary) || references[0]))
  if (!generate) return null
  const updateSettings = (patch: Partial<GenerationSettings>) => {
    updateGenerateNode(id, { settings: { ...generate.settings, ...patch } })
    clearGenerationError()
  }

  const videoModeLabel = videoInputMode === 'first_last' ? t.firstLast : videoInputMode === 'reference' ? t.referenceAsset : t.firstFrame
  const outputChipValue = (isVideoModel
    ? `${videoModeLabel} · ${videoRatioPolicy.ratioSelectable ? videoRatioPolicy.controlLabel : t.followAsset} · ${generate.settings.resolution}`
    : generationSettingsSizeLabel(generate.settings)
  ).replaceAll(' · ', '  ·  ')

  return (
    <div className="generate-node__editor nodrag nowheel">
      <div className="generate-node__dock">
        <div className="generate-node__dock-top">
          <div className="generate-node__references">
            {references.length ? references.slice(0, 5).map((reference) => (
              reference.mediaKind === 'video'
                ? <video key={reference.id} src={reference.image} aria-label={reference.name} className={reference.primary ? 'is-primary' : ''} muted playsInline preload="metadata" />
                : <img key={reference.id} src={reference.image} alt="" title={reference.name} className={reference.primary ? 'is-primary' : ''} />
            )) : (
              onOpenAssets ? (
                <button
                  type="button"
                  className="generate-node__add-ref is-cta"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation()
                    onOpenAssets(id)
                  }}
                ><PlusSquareIcon /><span>{t.addReferenceHint}</span></button>
              ) : <span className="generate-node__empty-input">{t.addReferenceHint}</span>
            )}
            {references.length && onOpenAssets ? (
              <button
                type="button"
                className="generate-node__add-ref"
                aria-label={t.addReferenceAsset}
                title={t.addReferenceAsset}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  onOpenAssets(id)
                }}
              ><PlusSquareIcon /></button>
            ) : null}
          </div>
          <button
            className="generate-node__dock-remove nodrag"
            type="button"
            aria-label={t.removeFromCanvas(generateLabel)}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              if (onRemove) onRemove(id)
              else removeNodeFromCanvas(id)
            }}
          ><DeleteIcon /></button>
        </div>

            <textarea
              className="nodrag nowheel"
              value={promptValue}
              aria-label={t.promptLabel(generateLabel)}
              placeholder={isVideoModel ? t.videoPrompt : t.imagePrompt}
              disabled={isGenerating}
              onPointerDown={(event) => event.stopPropagation()}
              onChange={(event) => {
                if (promptTextNode) updateTextNode(promptTextNode.id, event.target.value)
                else updateGenerateNode(id, { prompt: event.target.value })
                clearGenerationError()
              }}
            />

            <div className="generate-node__toolbar" aria-label={t.commonSettings}>
              <div className="generate-node__chips">
                <ComposerOptionPopover label={t.model} value={modelLabel} valueIcon={modelProviderLogo(selectedModel)} disabled={isGenerating} width={240} className="is-model is-chip">
                  {(close) => <div className="composer-model-menu" role="listbox" aria-label={t.chooseModel}>
                    {modelOptions.map((model) => {
                      const active = model.id === generate.settings.model
                      return <button key={model.id} type="button" role="option" aria-selected={active} className={active ? 'is-selected' : ''} disabled={model.available === false} title={model.unavailableReason} onClick={() => {
                        updateGenerateNode(id, { settings: settingsForGenerationModel(generate.settings, model) })
                        clearGenerationError()
                        close()
                      }}>
                        <img src={modelProviderLogo(model)} alt="" />
                        <strong>{modelDisplayLabel(model)}</strong>
                        {model.available === false ? <b>{t.unavailable}</b> : active ? <b>✓</b> : null}
                      </button>
                    })}
                  </div>}
                </ComposerOptionPopover>
                <ComposerOptionPopover label={t.output} value={outputChipValue} disabled={isGenerating} width={300} className="is-output is-chip">
                  {(close) => <div className="composer-output-menu">
                    {isVideoModel ? (
                      <section>
                        <header><strong>{t.videoInput}</strong></header>
                        <div className="composer-resolution-grid" role="radiogroup" aria-label={t.chooseVideoInput}>
                          {([
                            ['first_frame', t.firstFrame],
                            ['first_last', t.firstLast],
                            ['reference', t.referenceAsset],
                          ] as const).map(([value, label]) => (
                            <button
                              key={value}
                              type="button"
                              role="radio"
                              aria-checked={videoInputMode === value}
                              className={videoInputMode === value ? 'is-selected' : ''}
                              onClick={() => {
                                updateGenerateNode(id, { videoInputMode: value })
                                clearGenerationError()
                              }}
                            >{label}</button>
                          ))}
                        </div>
                      </section>
                    ) : null}
                    <section>
                      <header><strong>{t.frame}</strong></header>
                      {isVideoModel && !videoRatioPolicy.ratioSelectable ? (
                        <div className="composer-output-adaptive"><AspectRatioGlyph ratio="1:1" /><span>{t.followAsset}</span></div>
                      ) : (
                        <div className="composer-aspect-grid" role="radiogroup" aria-label={t.chooseRatio}>
                          {(selectedModel?.aspectRatios ?? ['1:1', '16:9', '4:3', '3:4', '4:5', '9:16']).map((ratio) => (
                            <button key={ratio} type="button" role="radio" aria-checked={!generate.settings.outputWidth && generate.settings.aspectRatio === ratio} className={!generate.settings.outputWidth && generate.settings.aspectRatio === ratio ? 'is-selected' : ''} onClick={() => {
                              updateGenerateNode(id, { settings: withoutCustomGenerationSize({ ...generate.settings, aspectRatio: ratio as GenerationSettings['aspectRatio'] }) })
                              clearGenerationError()
                            }}>
                              <AspectRatioGlyph ratio={ratio} /><span>{ratio}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </section>
                    <section>
                      <header><strong>{t.resolution}</strong></header>
                      <div className="composer-resolution-grid" role="radiogroup" aria-label={t.chooseResolution}>
                        {everydayResolutions(selectedModel).map((resolution) => (
                          <button key={resolution} type="button" role="radio" aria-checked={generate.settings.resolution === resolution} className={generate.settings.resolution === resolution ? 'is-selected' : ''} onClick={() => {
                            updateSettings({ resolution: resolution as GenerationSettings['resolution'] })
                            close()
                          }}>{resolution}</button>
                        ))}
                      </div>
                    </section>
                  </div>}
                </ComposerOptionPopover>
                <ComposerOptionPopover label={t.candidates} value={`${generate.batchCount}×`} disabled={isGenerating} width={120} className="is-count is-chip is-compact">
                  {(close) => <div className="composer-compact-menu" role="listbox" aria-label={t.chooseCandidateCount}>
                    {Array.from({ length: batchLimit }, (_, index) => index + 1).map((count) => (
                      <button key={count} type="button" role="option" aria-selected={generate.batchCount === count} className={generate.batchCount === count ? 'is-selected' : ''} onClick={() => {
                        updateGenerateNode(id, { batchCount: count })
                        clearGenerationError()
                        close()
                      }}>{count}</button>
                    ))}
                  </div>}
                </ComposerOptionPopover>
              </div>
              <button
                type="button"
                className="generate-node__send"
                aria-label={isGenerating ? t.generating : t.generate}
                disabled={isGenerating || !canGenerate || !promptValue.trim()}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  void runGraphGeneration(id)
                }}
              ><ArrowUpIcon /></button>
            </div>

        {generationError ? <p className="generate-node__error" role="alert">{localizeProductError(new Error(generationError), locale, { 'zh-CN': generationError, en: 'Generation could not be completed. Try again.' })}</p> : null}
      </div>
    </div>
  )
}

function GenerateNode({ data, id, selected }: NodeProps) {
  const { locale } = useProductI18n()
  const t = useProductMessages(editorMessages)
  const generate = data as GenerateNodeUiData
  const ui = generate.__ui
  const rawGenerateLabel = generate.settings.duration !== undefined && generate.label === '图像生成' ? '视频生成' : generate.label
  const generateLabel = canvasSystemLabel(rawGenerateLabel, locale)
  const availableModels = useCanvasStore((state) => state.availableModels)
  const updateNodeInternals = useUpdateNodeInternals()
  const activeMediaKind = availableModels.find((model) => model.id === generate.settings.model)?.mediaKind
    ?? (generate.settings.duration === undefined ? 'image' : 'video')
  const mediaKind = activeMediaKind
  useLayoutEffect(() => {
    updateNodeInternals(id)
  }, [id, selected, updateNodeInternals])

  return (
    <div className={`graph-node generate-node generate-node--orphan generate-node--${mediaKind}${selected ? ' is-selected is-editing is-dock-only' : ''}`}>
      <Handle
        className="flow-handle flow-handle--graph flow-handle--target"
        id="input"
        type="target"
        position={Position.Left}
        aria-label={t.inputPort(generateLabel)}
        title={t.connectVisual}
      />
      <Handle
        className="flow-handle flow-handle--graph flow-handle--source"
        id="output"
        type="source"
        position={Position.Right}
        isConnectable={false}
        aria-label={t.autoOutput(generateLabel)}
        title={t.autoOutputHint}
      />
      <div className="generate-node__placeholder">
        <svg viewBox="0 0 24 24" width="36" height="36" fill="none" aria-hidden="true">
          <rect x="3.5" y="5" width="17" height="14" rx="3" stroke="currentColor" strokeWidth="1.4" />
          <path d="M10 9.2v5.6l5-2.8-5-2.8Z" fill="currentColor" />
        </svg>
        <span>{generateLabel}</span>
      </div>
      {selected ? (
        <GenerateDock
          generateId={id}
          onOpenAssets={ui?.onOpenAssets}
          maximumBatchCount={ui?.maximumBatchCount}
          onRemove={ui?.onRemoveGenerate}
        />
      ) : null}
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
  status: 'idle' | 'uploading' | 'queued' | 'running' | 'recovering' | 'error'
  error?: string
  canGenerate: boolean
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

export function CanvasComposer({ projectId, mode, nodeLabel, prompt, batchCount, maximumBatchCount, settings, models, references, status, error, canGenerate, onPromptChange, onBatchCountChange, onSettingsChange, videoInputMode = 'first_frame', onVideoInputModeChange, refinementMode = 'faithful', onRefinementModeChange, onOpenReferences, onOpenAssets, onGenerate, onClose, layout, onLayoutChange }: CanvasComposerProps) {
  const { locale } = useProductI18n()
  const t = useProductMessages(editorMessages)
  const isGenerating = status === 'uploading' || status === 'queued' || status === 'running' || status === 'recovering'
  const [refinement, setRefinement] = useState<PromptRefinementState>({ status: 'idle' })
  const refinementRequestRef = useRef<{ id: number; controller?: AbortController }>({ id: 0 })
  const refinementFeedbackTimerRef = useRef<number | null>(null)
  const [refinementSuccessVisible, setRefinementSuccessVisible] = useState(false)
  const promptRef = useRef(prompt)
  useEffect(() => { promptRef.current = prompt }, [prompt])
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
  const allowCustomSize = !isVideoModel && modelSupportsCustomSize(selectedModel)
  const [customWidth, setCustomWidth] = useState(settings.outputWidth ? String(settings.outputWidth) : '')
  const [customHeight, setCustomHeight] = useState(settings.outputHeight ? String(settings.outputHeight) : '')
  const [customSizeHint, setCustomSizeHint] = useState<{ message: string; error: boolean } | null>(null)
  useEffect(() => {
    setCustomWidth(settings.outputWidth ? String(settings.outputWidth) : '')
    setCustomHeight(settings.outputHeight ? String(settings.outputHeight) : '')
  }, [settings.outputWidth, settings.outputHeight])
  const primaryReference = references.find((reference) => reference.primary)
  const videoRatioPolicy = videoAspectRatioPolicy(videoInputMode, settings.aspectRatio)
  const videoModeCopy = videoInputMode === 'first_frame'
    ? { title: t.firstFrameTitle, detail: t.firstFrameDetail }
    : videoInputMode === 'first_last'
      ? { title: t.firstLastTitle, detail: t.firstLastDetail }
      : { title: t.referenceTitle, detail: t.referenceDetail }
  const videoInputHint = !canGenerate && isVideoModel
    ? videoInputMode === 'first_last'
      ? references.length === 1 ? t.addTail : t.addFirstLast
      : videoInputMode === 'first_frame'
        ? t.addFirst
        : t.addReference
    : ''
  const videoReferenceBadge = (index: number) => !isVideoModel
    ? undefined
    : videoInputMode === 'first_last'
      ? index === 0 ? t.firstBadge : index === 1 ? t.lastBadge : undefined
      : videoInputMode === 'first_frame' && index === 0 ? t.firstBadge : undefined
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
      const detail = localizeProductError(caught, locale, { 'zh-CN': t.refineFailed, en: t.refineFailed })
      setRefinement({
        status: 'error',
        message: t.unchanged(detail),
      })
    }
  }

  return (
    <section
      ref={composerRef}
      className={`canvas-composer${expanded ? ' is-expanded' : ' is-collapsed'}${layout.dock === 'free' ? ' is-free' : ' is-docked'}`}
      aria-label={t.composerLabel(mode === 'result', canvasSystemLabel(nodeLabel, locale))}
      style={composerStyle}
    >
      <header
        className="canvas-composer__header"
        title={t.dragComposer}
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
              aria-label={t.manageReferences(references.length)}
              title={t.manageReferenceTitle}
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
          {onOpenAssets ? <button type="button" className={references.length ? 'canvas-composer__add-reference' : 'canvas-composer__add-reference is-empty'} onClick={onOpenAssets} aria-label={t.addReferenceAsset} title={t.addReferenceAsset}><PlusSquareIcon />{references.length ? null : <span>{t.addReferenceShort}</span>}</button> : null}
        </div>
        <div className="canvas-composer__header-actions">
          <button
            type="button"
            className="canvas-composer__collapse"
            onClick={() => onLayoutChange({ ...layout, collapsed: expanded })}
            aria-expanded={expanded}
            aria-label={expanded ? t.collapseComposer : t.expandComposer}
            title={expanded ? t.fold : t.expandAll}
          >{expanded ? '−' : '＋'}</button>
          <button type="button" className="canvas-composer__close" onClick={onClose} aria-label={t.closeComposer} title={t.close}><CloseIcon /></button>
        </div>
      </header>

      <div className="canvas-composer__expanded-content" aria-hidden={!expanded} inert={expanded ? undefined : true}>
        <div className="canvas-composer__body">
          <main className="canvas-composer__editor">
            <div className={`canvas-composer__field canvas-composer__prompt${refinementSuccessVisible ? ' is-refinement-success' : ''}`}>
              <textarea
                value={prompt}
                autoFocus={expanded}
                aria-label={t.promptLabel(canvasSystemLabel(nodeLabel, locale))}
                aria-busy={isRefining}
                placeholder={isVideoModel ? t.videoPrompt : t.imagePrompt}
                readOnly={isRefining}
                onChange={(event) => handlePromptChange(event.target.value)}
              />
              <button
                type="button"
                className={`canvas-composer__refine${refinement.status === 'loading' ? ' is-loading' : ''}${refinementSuccessVisible ? ' is-complete' : ''}`}
                disabled={!prompt.trim() || interactionLocked}
                aria-label={refinementSuccessVisible ? t.refined : t.refinePrompt(isVideoModel)}
                title={t.refineTitle}
                onClick={() => void handleRefinePrompt()}
              >
                <SparkleIcon />
              </button>
            </div>
            {refinement.status === 'loading' ? (
              <div className="canvas-composer__refinement-status" role="status" aria-live="polite">
                <span>{t.refining}</span>
              </div>
            ) : refinement.status === 'error' ? (
              <div className="canvas-composer__refinement-status is-error" role="alert">
                <span>{refinement.message ?? t.refineFallback}</span>
              </div>
            ) : null}
            {isVideoModel ? (
              <section className="canvas-composer__video-input" aria-label={t.videoInputMode}>
                <strong className="canvas-composer__video-input-label">{t.videoInput}</strong>
                <div className="canvas-composer__video-modes" role="radiogroup" aria-label={t.chooseVideoInput}>
                  {([
                    ['first_frame', t.firstFrame],
                    ['first_last', t.firstLast],
                    ['reference', t.referenceAsset],
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
              <div className="canvas-composer__refinement-mode" role="group" aria-label={t.continuationMode}>
                <button type="button" className={refinementMode === 'faithful' ? 'is-active' : ''} disabled={interactionLocked} onClick={() => onRefinementModeChange?.('faithful')}>
                  {t.faithful}
                </button>
                <button type="button" className={refinementMode === 'explore' ? 'is-active' : ''} disabled={interactionLocked} onClick={() => onRefinementModeChange?.('explore')}>
                  {t.explore}
                </button>
                <small>{refinementMode === 'explore' ? t.exploreDetail : t.faithfulDetail}</small>
              </div>
            ) : null}
          </main>
        </div>

        <footer className="canvas-composer__footer">
          <div className="canvas-composer__settings-stack">
            <div className={`canvas-composer__settings canvas-composer__settings--primary${isVideoModel ? ' is-video' : ''}`} aria-label={t.commonSettings}>
              <ComposerOptionPopover label={t.model} value={modelDisplayLabel(selectedModel) || settings.model} valueIcon={modelProviderLogo(selectedModel)} disabled={interactionLocked} width={240} className="is-model">
                {(close) => <div className="composer-model-menu" role="listbox" aria-label={t.chooseModel}>
                  {modelOptions.map((model) => {
                    const selected = model.id === settings.model
                    return <button key={model.id} type="button" role="option" aria-selected={selected} className={selected ? 'is-selected' : ''} onClick={() => {
                      onSettingsChange(settingsForGenerationModel(settings, model))
                      close()
                    }}>
                      <img src={modelProviderLogo(model)} alt="" />
                      <strong>{modelDisplayLabel(model)}</strong>
                      {selected ? <b>✓</b> : null}
                    </button>
                  })}
                </div>}
              </ComposerOptionPopover>
              {isVideoModel ? <ComposerOptionPopover label={t.duration} value={canvasDurationLabel(settings.duration ?? selectedModel.defaultDuration ?? 5, locale)} disabled={interactionLocked} width={112} className="is-compact">
                {(close) => <div className="composer-compact-menu" role="listbox" aria-label={t.chooseDuration}>
                  {(selectedModel.durations ?? [5]).filter((duration) => [5, 10, 15].includes(duration)).map((duration) => <button key={duration} type="button" role="option" aria-selected={(settings.duration ?? selectedModel.defaultDuration ?? 5) === duration} className={(settings.duration ?? selectedModel.defaultDuration ?? 5) === duration ? 'is-selected' : ''} onClick={() => {
                    updateSettings({ duration })
                    close()
                  }}>{canvasDurationLabel(duration, locale)}</button>)}
                </div>}
              </ComposerOptionPopover> : null}
              <ComposerOptionPopover label={t.candidates} value={String(batchCount)} disabled={interactionLocked} width={132} className="is-count">
                {(close) => <div className="composer-compact-menu" role="listbox" aria-label={t.chooseCandidateCount}>
                  {Array.from({ length: maximumBatchCount }, (_, index) => index + 1).map((count) => <button key={count} type="button" role="option" aria-selected={batchCount === count} className={batchCount === count ? 'is-selected' : ''} onClick={() => {
                    onBatchCountChange(count)
                    close()
                  }}>{count}</button>)}
                </div>}
              </ComposerOptionPopover>
              <ComposerOptionPopover
                label={t.output}
                value={isVideoModel && !videoRatioPolicy.ratioSelectable
                  ? `${t.followAsset} · ${settings.resolution}`
                  : generationSettingsSizeLabel(settings)}
                disabled={interactionLocked}
                width={allowCustomSize ? 320 : 300}
                className="is-output"
              >
                {(close) => <div className="composer-output-menu">
                  <section>
                    <header><strong>{t.frame}</strong>{isVideoModel && !videoRatioPolicy.ratioSelectable ? <small>{t.decidedByInput}</small> : null}</header>
                    {isVideoModel && !videoRatioPolicy.ratioSelectable ? <div className="composer-output-adaptive"><AspectRatioGlyph ratio="1:1" /><span>{t.followAsset}</span></div> : <div className="composer-aspect-grid" role="radiogroup" aria-label={t.chooseRatio}>
                      {(selectedModel?.aspectRatios ?? ['1:1', '16:9', '4:3', '3:4', '4:5', '9:16']).map((ratio) => <button key={ratio} type="button" role="radio" aria-checked={!settings.outputWidth && settings.aspectRatio === ratio} className={!settings.outputWidth && settings.aspectRatio === ratio ? 'is-selected' : ''} onClick={() => onSettingsChange(withoutCustomGenerationSize({ ...settings, aspectRatio: ratio as GenerationSettings['aspectRatio'] }))}>
                        <AspectRatioGlyph ratio={ratio} /><span>{ratio}</span>
                      </button>)}
                    </div>}
                  </section>
                  <section>
                    <header><strong>{t.resolution}</strong></header>
                    <div className="composer-resolution-grid" role="radiogroup" aria-label={t.chooseResolution}>
                      {everydayResolutions(selectedModel).map((resolution) => <button key={resolution} type="button" role="radio" aria-checked={settings.resolution === resolution} className={settings.resolution === resolution ? 'is-selected' : ''} onClick={() => {
                        updateSettings({ resolution: resolution as GenerationSettings['resolution'] })
                        close()
                      }}>{resolution}</button>)}
                      {clarityBoostModel(models) ? (
                        <button
                          type="button"
                          role="radio"
                          aria-checked={settings.resolution === '4K'}
                          className={settings.resolution === '4K' ? 'is-selected' : ''}
                          disabled={interactionLocked}
                          onClick={() => {
                            onSettingsChange(settings.resolution === '4K'
                              ? clearClarityBoost(settings, models)
                              : applyClarityBoost(settings, models))
                            close()
                          }}
                        >{t.clarityBoost}</button>
                      ) : null}
                    </div>
                  </section>
                  {selectedModel?.supportsSearchGrounding || selectedModel?.thinkingLevels?.length ? (
                    <section>
                      <header><strong>{t.searchGrounding}</strong></header>
                      <div className="composer-resolution-grid">
                        {selectedModel.supportsSearchGrounding ? (
                          <button type="button" className={settings.searchGrounding !== false ? 'is-selected' : ''} onClick={() => updateSettings({ searchGrounding: settings.searchGrounding === false })}>
                            {t.searchGrounding}
                          </button>
                        ) : null}
                        {selectedModel.thinkingLevels?.includes('high') ? (
                          <button type="button" className={(settings.thinkingLevel ?? 'high') === 'high' ? 'is-selected' : ''} onClick={() => updateSettings({ thinkingLevel: 'high' })}>
                            {t.thinkingHigh}
                          </button>
                        ) : null}
                        {selectedModel.thinkingLevels?.includes('minimal') ? (
                          <button type="button" className={settings.thinkingLevel === 'minimal' ? 'is-selected' : ''} onClick={() => updateSettings({ thinkingLevel: 'minimal' })}>
                            {t.thinkingMinimal}
                          </button>
                        ) : null}
                      </div>
                    </section>
                  ) : null}
                  {allowCustomSize ? <section>
                    <header><strong>{t.customPixels}</strong><small>{t.multiple16}</small></header>
                    <div className="composer-custom-size">
                      <label>{t.width}<input type="number" min={16} max={3840} step={16} value={customWidth} aria-label={t.customWidth} onChange={(event) => setCustomWidth(event.target.value)} /></label>
                      <span aria-hidden="true">×</span>
                      <label>{t.height}<input type="number" min={16} max={3840} step={16} value={customHeight} aria-label={t.customHeight} onChange={(event) => setCustomHeight(event.target.value)} /></label>
                      <button type="button" onClick={() => {
                        if (!customWidth.trim() && !customHeight.trim()) {
                          setCustomSizeHint(null)
                          onSettingsChange(withoutCustomGenerationSize(settings))
                          return
                        }
                        const applied = applyCustomGenerationSize(settings, Number(customWidth), Number(customHeight))
                        if (!applied.ok || !applied.settings) {
                          setCustomSizeHint({ message: applied.ok ? t.invalidSize : localizeProductError(new Error(applied.message), locale, { 'zh-CN': t.invalidSize, en: t.invalidSize }), error: true })
                          return
                        }
                        setCustomSizeHint(applied.snapped ? { message: t.snapped(applied.width, applied.height), error: false } : null)
                        onSettingsChange(applied.settings)
                      }}>{t.apply}</button>
                    </div>
                    {customSizeHint ? <small className={customSizeHint.error ? 'is-error' : ''}>{customSizeHint.message}</small> : null}
                  </section> : null}
                </div>}
              </ComposerOptionPopover>
            </div>
          </div>
          <div className={error ? 'canvas-composer__feedback is-error' : 'canvas-composer__feedback'} role={error ? 'alert' : 'status'}>
            {(error ? localizeProductError(new Error(error), locale, { 'zh-CN': error, en: 'Generation could not be completed. Try again.' }) : undefined) ?? (isGenerating
              ? (status === 'recovering' ? t.recovering : status === 'uploading' ? t.uploading : status === 'queued' ? t.queued : t.serviceGenerating(selectedModel?.mediaKind === 'video'))
              : canGenerate
                ? (primaryReference ? t.primaryReference(primaryReference.name) : t.ready)
                : isVideoModel
                  ? t.modeNeeds(videoModeCopy.title, videoInputMode === 'first_last' ? t.twoImages : videoInputMode === 'first_frame' ? t.oneImage : t.oneReference)
                  : t.setPrimary)}
          </div>
          <button type="button" className="canvas-composer__submit" disabled={interactionLocked || !canGenerate || !prompt.trim()} onClick={onGenerate}>
            {isGenerating ? t.generating : t.generate}
          </button>
        </footer>
      </div>
    </section>
  )
}

function taskStatusLabel(status: 'uploading' | 'submission_unknown' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled', locale: 'zh-CN' | 'en') {
  return editorMessages[locale].taskStatuses[status]
}

function elapsedTaskLabel(seconds: number, locale: 'zh-CN' | 'en') {
  const t = editorMessages[locale]
  if (seconds < 60) return t.waitedSeconds(seconds)
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return t.waitedMinutes(minutes, remainder)
}

function PromptNode({ data, selected }: NodeProps) {
  const { locale } = useProductI18n()
  const t = useProductMessages(editorMessages)
  const prompt = data as PromptNodeData
  return (
    <div className={`task-node task-node--prompt task-node--${prompt.status}${selected ? ' is-selected' : ''}`}>
      <Handle className="flow-handle flow-handle--target" id="input" type="target" position={Position.Left} aria-label={t.promptInput} />
      <Handle className="flow-handle flow-handle--source" type="source" position={Position.Right} aria-label={t.promptOutput} />
      <span className="task-node__eyebrow">01 · PROMPT</span>
      <strong>{prompt.label ? canvasSystemLabel(prompt.label, locale) : prompt.generationKind === 'refinement' ? t.refinementBrief : t.creativeDirection}</strong>
      <p>{prompt.prompt}</p>
      <footer><span>{generationSettingsSizeLabel(prompt.settings)}</span><i>{taskStatusLabel(prompt.status, locale)}</i></footer>
      {prompt.error ? <small title={localizeProductError(new Error(prompt.error), locale, { 'zh-CN': prompt.error, en: t.taskAttention })}>{t.taskAttention}</small> : null}
    </div>
  )
}

function ReferenceGroupNode({ data, selected }: NodeProps) {
  const { locale } = useProductI18n()
  const t = useProductMessages(editorMessages)
  const reference = data as ReferenceGroupNodeData
  const primary = primaryReferenceFromRecipe(reference.recipe)
  return (
    <div className={`task-node task-node--reference task-node--${reference.status}${selected ? ' is-selected' : ''}`}>
      <Handle className="flow-handle flow-handle--target" type="target" position={Position.Left} aria-label={t.referenceInput} />
      <Handle className="flow-handle flow-handle--source" type="source" position={Position.Right} aria-label={t.referenceOutput} />
      <span className="task-node__eyebrow">02 · REFERENCES</span>
      <strong>{canvasSystemLabel(reference.label, locale)}</strong>
      <div className="task-node__reference-strip">
        {reference.recipe.references.slice(0, 4).map((item) => <img key={item.nodeId} src={item.image} alt={item.name} title={`${canvasAssetRoleLabel(item.role, locale)} · ${item.name}`} decoding="async" />)}
      </div>
      <footer><span>{primary ? t.primaryProduct(primary.name) : t.noPrimary}</span><i>{taskStatusLabel(reference.status, locale)}</i></footer>
      {reference.error ? <small title={localizeProductError(new Error(reference.error), locale, { 'zh-CN': reference.error, en: t.taskAttention })}>{t.taskAttention}</small> : null}
    </div>
  )
}

export type ResultGroupCandidateUi = {
  id: string
  name: string
  image?: string
  mediaKind: GenerationMediaKind
  active: boolean
  promoted: boolean
}

export type ResultNodeUiData = ResultNodeData & {
  __ui?: {
    group?: ResultGroupPresentation
    targetNodeId?: string
    groupCandidates?: ResultGroupCandidateUi[]
    workingGenerateId?: string
    onToggleGroup?: (groupId: string) => void
    onChooseCandidate?: (groupId: string, candidateId: string, promoted: boolean) => void
    onOpenAddMenu?: (resultNodeId: string, screen: { x: number; y: number }) => void
    onOpenContinueGeneration?: (resultNodeId: string) => void
    onOpenAddContext?: (mediaNodeId: string) => void
    onOpenAgent?: (resultNodeId: string) => void
    onOpenRegionEdit?: (resultNodeId: string) => void
    onOpenAssets?: (generateNodeId: string) => void
    maximumBatchCount?: number
    onRemoveGenerate?: (generateNodeId: string) => void
  }
}

function ResultNode({ data, id, selected }: NodeProps) {
  const { locale } = useProductI18n()
  const t = useProductMessages(editorMessages)
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
  const recoverUnknownGenerationSubmission = useCanvasStore((state) => state.recoverUnknownGenerationSubmission)
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
  const resultName = result.label ? canvasSystemLabel(result.label, locale) : result.generationKind === 'refinement' ? t.refinedVersion : t.generatedVersion
  const hasDisplayableImage = Boolean(result.image) && !imageFailed
  const isGenerating = result.status === 'generating'
  const isSubmissionUnknown = result.taskStatus === 'submission_unknown'
  const defaultTaskFeedback = generationTaskFeedback(result.taskStatus)
  const taskFeedback = locale === 'zh-CN' ? defaultTaskFeedback : result.taskStatus === 'submission_unknown'
    ? { title: t.restoringTask, detail: t.noResubmit }
    : result.taskStatus === 'uploading'
      ? { title: t.preparing, detail: t.lockingReferences }
      : result.taskStatus === 'queued'
        ? { title: t.generatingTask, detail: t.enteredQueue }
        : { title: t.generatingTask, detail: t.keepEditing }
  const elapsedSeconds = result.submittedAt && isGenerating
    ? Math.max(0, Math.floor((currentTime - result.submittedAt) / 1_000))
    : 0
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
        aria-label={t.automaticOutput}
        title={t.writtenAutomatically}
      />
      {hasDisplayableImage ? (
        <MediaPortHandle
          handleId="context"
          type="target"
          ariaLabel={t.addContext}
          title={t.addContext}
          onClick={presentation?.onOpenAddContext ? () => presentation.onOpenAddContext?.(targetNodeId) : undefined}
        />
      ) : null}
      <MediaPortHandle
        handleId="output"
        type="source"
        ariaLabel={t.continueFromAsset}
        title={t.continueFromAsset}
        onClick={presentation?.onOpenAddMenu ? (screen) => presentation.onOpenAddMenu?.(targetNodeId, screen) : undefined}
      />
      <header className="result-node__header">
        <ImageNodeTitle nodeId={targetNodeId} name={resultName} />
        {settings ? <span className="result-node__metadata">{displayedAspectRatio} · {settings.resolution}{settings.duration ? ` · ${canvasDurationLabel(settings.duration, locale)}` : ''}</span> : null}
        {hasDisplayableImage ? <button
          className="result-node__header-remove nodrag nowheel"
          type="button"
          aria-label={t.deleteResult(resultName)}
          title={t.deleteResultTitle}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            removeNodeFromCanvas(targetNodeId)
          }}
        ><DeleteIcon /></button> : null}
      </header>
      <div
        className={['result-node', ratioClass, isGenerating ? 'result-node--generating' : '', isSubmissionUnknown ? 'result-node--recovering' : '', isSelected ? 'is-selected' : ''].filter(Boolean).join(' ')}
        style={mediaKind === 'video' && videoDimensions
          ? { height: 'auto', aspectRatio: `${videoDimensions.width} / ${videoDimensions.height}` }
          : undefined}
      >
        {hasDisplayableImage ? <button
          className="result-node__download nodrag nowheel"
          type="button"
          aria-label={t.download(resultName)}
          title={t.downloadOriginal}
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
          aria-label={isSavedToLibrary ? t.savedLabel(resultName) : t.saveLabel(resultName)}
          title={isSavedToLibrary ? t.saved : t.saveTitle}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            saveGeneratedImageToLibrary({ image: result.image!, name: resultName, mediaKind: result.mediaKind ?? 'image' })
          }}
        >{isSavedToLibrary ? t.saved : t.save}</button> : null}
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
            {isGenerating ? (
              <GenerationDotsField compact={displayedAspectRatio === '16:9'} />
            ) : null}
            {isGenerating ? (
              isSubmissionUnknown
                ? <button className="result-node__task-action nodrag nowheel" type="button" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); void recoverUnknownGenerationSubmission() }}>{t.confirmNow}</button>
                : <button className="result-node__task-action nodrag nowheel" type="button" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); cancelGeneration() }}>{t.cancel}</button>
            ) : (
            <div className="result-node__task-copy">
            <strong aria-live="polite">{imageFailed ? t.mediaUnavailable : result.status === 'failed' ? t.taskIncomplete : result.status === 'cancelled' ? t.taskCancelled : t.waitingResult}</strong>
            {/* 已登记错误码（如 IMAGE_TOO_LARGE_PIXELS）已经是按 locale 解析好的双语文案，
                直接用；不走 localizeProductError——那条路径把 Error 对象当容器传 code，
                这里没有 code 可传，走了也只会落回英文兜底文案，白白丢掉刚解析出的正确译文。
                未登记错误码维持原有行为不变。 */}
            <small>{imageFailed ? t.mediaError : (result.error ? (generationJobErrorCopy(result.errorCode, locale) ?? localizeProductError(new Error(generationTaskErrorMessage(result.error) ?? result.error), locale, { 'zh-CN': generationTaskErrorMessage(result.error) ?? result.error, en: t.generationConnectionError })) : undefined) ?? (result.status === 'ready' ? t.waitingService : t.realStatus)}</small>
            {imageFailed ? <button className="result-node__task-action nodrag nowheel" type="button" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); void recoverMedia() }}>{t.reload}</button> : null}
            {result.status === 'failed' ? <div className="result-node__task-actions nodrag nowheel" onPointerDown={(event) => event.stopPropagation()}>
              <button className="result-node__task-action" type="button" onClick={(event) => { event.stopPropagation(); void retryGeneration() }}>{t.retryRecipe}</button>
              <button className="result-node__task-action is-danger" type="button" onClick={(event) => { event.stopPropagation(); removeNodeFromCanvas(targetNodeId) }}>{t.deleteTask}</button>
            </div> : null}
            {result.status === 'cancelled' ? <button className="result-node__task-action nodrag nowheel is-danger" type="button" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); removeNodeFromCanvas(targetNodeId) }}>{t.deleteTask}</button> : null}
            </div>
            )}
          </div>
        )}
        {missingOutputCount ? <div className="result-node__partial nodrag nowheel" onPointerDown={(event) => event.stopPropagation()}>
          <span>{requestedOutputCount - missingOutputCount}/{requestedOutputCount}</span>
          <button type="button" onClick={(event) => { event.stopPropagation(); if (result.jobId) void retryMissingGeneration(result.jobId) }}>{t.fillMissing(missingOutputCount)}</button>
        </div> : null}
        {resultGroup?.representative ? <button
          className="result-node__candidate-toggle nodrag nowheel"
          type="button"
          aria-label={resultGroup.expanded ? t.collapseCandidates : t.viewCandidates(resultGroup.total)}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); presentation?.onToggleGroup?.(resultGroup.groupId) }}
        >{t.resultSet(resultGroup.index, resultGroup.total)} <span>{resultGroup.expanded ? '⌃' : '⌄'}</span></button> : null}
      </div>
      {isGenerating ? (
        <div className="result-node__task-copy">
          <strong aria-live="polite">{taskFeedback.title}</strong>
          <small>{elapsedTaskLabel(elapsedSeconds, locale)}</small>
        </div>
      ) : null}
      {resultGroup?.representative && resultGroup.expanded && groupCandidates.length ? <section className="result-node__candidate-popover nodrag nowheel" aria-label={t.candidateCount(resultGroup.total)} onPointerDown={(event) => event.stopPropagation()}>
        <header><strong>{t.candidatesThisRun}</strong><span>{t.chooseCandidateHint}</span><button type="button" aria-label={t.collapseCandidates} onClick={(event) => { event.stopPropagation(); presentation?.onToggleGroup?.(resultGroup.groupId) }}><CloseIcon /></button></header>
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
              : <i>{t.waiting}</i>}<em>{String(index + 1).padStart(2, '0')}</em></span>
            <span className="result-node__candidate-name">{canvasSystemLabel(candidate.name, locale)}<small>{candidate.promoted ? t.branched : candidate.active ? t.current : t.view}</small></span>
          </button>)}
        </div>
      </section> : null}
      {isSelected && hasDisplayableImage && (presentation?.onOpenAddMenu || presentation?.onOpenContinueGeneration) ? <div className="result-node__actions nodrag nowheel" onPointerDown={(event) => event.stopPropagation()}>
        {presentation.onOpenAgent ? <button type="button" className="is-agent" onClick={(event) => {
          event.stopPropagation()
          presentation.onOpenAgent?.(targetNodeId)
        }}><SparkleIcon /> {t.agentEdit}</button> : null}
        {presentation.onOpenRegionEdit && result.mediaKind !== 'video' ? <button type="button" onClick={(event) => {
          event.stopPropagation()
          presentation.onOpenRegionEdit?.(targetNodeId)
        }}>{locale === 'en' ? 'Redraw region' : '局部重绘'}</button> : null}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            if (presentation.onOpenContinueGeneration) presentation.onOpenContinueGeneration(targetNodeId)
            else presentation.onOpenAddMenu?.(targetNodeId, { x: event.clientX, y: event.clientY })
          }}
        >{t.addNode} <ArrowUpRightIcon /></button>
      </div> : null}
      {isSelected && presentation?.workingGenerateId ? (
        <div className="media-compose-dock generate-node is-editing is-dock-only nodrag nowheel">
          <GenerateDock
            generateId={presentation.workingGenerateId}
            onOpenAssets={presentation.onOpenAssets}
            maximumBatchCount={presentation.maximumBatchCount}
            onRemove={presentation.onRemoveGenerate}
          />
        </div>
      ) : null}
    </div>
  )
}
export const canvasNodeTypes = {
  asset: AssetNode,
  text: TextNode,
  generate: GenerateNode,
  prompt: PromptNode,
  reference: ReferenceGroupNode,
  result: ResultNode,
  frame: CanvasFrameNode,
}
