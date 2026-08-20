import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { generationTaskErrorMessage, generationTaskFeedback, type ResultGroupPresentation } from '../../domain/canvasPresentation'
import { reducedAspectRatio } from '../../domain/mediaPresentation'
import { mediaRetryUrl } from '../../domain/mediaRecovery'
import { primaryGenerationReference, settingsForGenerationModel } from '../../domain/generationRecipe'
import { applyCustomGenerationSize, generationSettingsSizeLabel, modelSupportsCustomSize, withoutCustomGenerationSize } from '../../domain/generationOutputSize'
import { videoAspectRatioPolicy } from '../../domain/videoGeneration'
import { useMotionPresence } from '../../components/motionPresence'
import { BotanicSelect } from '../../components/BotanicSelect'
import { modelDisplayLabel, modelProviderLogo } from '../../components/generationModelPresentation'
import type { AssetNodeData, AssetRole, AssetSource, CanvasNode, GenerateNodeData, GenerationMediaKind, GenerationModelOption, GenerationSettings, PromptNodeData, ReferenceGroupNodeData, RefinementMode, ResultNodeData, TextNodeData, VideoInputMode } from '../../domain/canvas'
import { downloadMedia } from '../../lib/mediaDownload'
import { refinePrompt } from '../../lib/promptRefinementApi'
import { refreshProductMediaSession } from '../../lib/productSession'
import { useCanvasStore } from '../../store/canvasStore'
import { ArrowUpRightIcon, ChevronDownIcon, CloseIcon, DeleteIcon, DownloadIcon, PlusSquareIcon, SparkleIcon } from '../../components/BotanicIcons'

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
        aria-label={`${label}选项`}
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

/** 输入停顿多久后才把文字节点内容提交到文档。 */
const textNodeCommitDelayMs = 300

function TextNode({ data, id, selected }: NodeProps) {
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
        value={draft}
        aria-label={`${text.label}内容`}
        placeholder="写下视觉目标或文案要求"
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
      >{collapsed ? '展开全文' : expanded ? '收起' : '折叠'}</button> : null}
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
    ? `${videoAspectRatioPolicy(inferredVideoInputMode, generate.settings.aspectRatio).controlLabel} · ${generate.settings.resolution}`
    : generationSettingsSizeLabel(generate.settings)

  return (
    <div className={`graph-node generate-node generate-node--${mediaKind}${selected ? ' is-selected' : ''}${hasVisualInput ? '' : ' is-missing-input'}`}>
      <Handle
        className="flow-handle flow-handle--graph flow-handle--target"
        id="input"
        type="target"
        position={Position.Left}
        aria-label={`${generateLabel} 输入端`}
        title="将图片或已选首图连到这里"
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
        <small>{references.length} 参考 · {modelLabel} · {displayedAspectRatio}{generate.settings.duration ? ` · ${generate.settings.duration}秒` : ''}</small>
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
        ) : <span className="generate-node__empty-input">连接参考素材后即可生成</span>}
        {inputSummary.texts
          ? <p>描述已连到文本节点</p>
          : <p>{generate.prompt.trim() || '点击节点，编辑本次生成描述与参数'}</p>}
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
  const [customSizeHint, setCustomSizeHint] = useState('')
  useEffect(() => {
    setCustomWidth(settings.outputWidth ? String(settings.outputWidth) : '')
    setCustomHeight(settings.outputHeight ? String(settings.outputHeight) : '')
  }, [settings.outputWidth, settings.outputHeight])
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
                value={isVideoModel && !videoRatioPolicy.ratioSelectable
                  ? `跟随素材 · ${settings.resolution}`
                  : generationSettingsSizeLabel(settings)}
                disabled={interactionLocked}
                width={allowCustomSize ? 320 : 300}
                className="is-output"
              >
                {(close) => <div className="composer-output-menu">
                  <section>
                    <header><strong>画幅</strong>{isVideoModel && !videoRatioPolicy.ratioSelectable ? <small>由输入素材决定</small> : null}</header>
                    {isVideoModel && !videoRatioPolicy.ratioSelectable ? <div className="composer-output-adaptive"><AspectRatioGlyph ratio="1:1" /><span>跟随素材</span></div> : <div className="composer-aspect-grid" role="radiogroup" aria-label="选择画面比例">
                      {(selectedModel?.aspectRatios ?? ['1:1', '16:9', '4:3', '3:4', '4:5', '9:16']).map((ratio) => <button key={ratio} type="button" role="radio" aria-checked={!settings.outputWidth && settings.aspectRatio === ratio} className={!settings.outputWidth && settings.aspectRatio === ratio ? 'is-selected' : ''} onClick={() => onSettingsChange(withoutCustomGenerationSize({ ...settings, aspectRatio: ratio as GenerationSettings['aspectRatio'] }))}>
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
                  {allowCustomSize ? <section>
                    <header><strong>自定义像素</strong><small>须为 16 的倍数</small></header>
                    <div className="composer-custom-size">
                      <label>宽<input type="number" min={16} max={3840} step={16} value={customWidth} aria-label="自定义输出宽度" onChange={(event) => setCustomWidth(event.target.value)} /></label>
                      <span aria-hidden="true">×</span>
                      <label>高<input type="number" min={16} max={3840} step={16} value={customHeight} aria-label="自定义输出高度" onChange={(event) => setCustomHeight(event.target.value)} /></label>
                      <button type="button" onClick={() => {
                        if (!customWidth.trim() && !customHeight.trim()) {
                          setCustomSizeHint('')
                          onSettingsChange(withoutCustomGenerationSize(settings))
                          return
                        }
                        const applied = applyCustomGenerationSize(settings, Number(customWidth), Number(customHeight))
                        if (!applied.ok || !applied.settings) {
                          setCustomSizeHint(applied.ok ? '自定义宽高无效。' : applied.message)
                          return
                        }
                        setCustomSizeHint(applied.snapped ? `已对齐为 ${applied.width}×${applied.height}` : '')
                        onSettingsChange(applied.settings)
                      }}>应用</button>
                    </div>
                    {customSizeHint ? <small className={customSizeHint.startsWith('已对齐') ? '' : 'is-error'}>{customSizeHint}</small> : null}
                  </section> : null}
                </div>}
              </ComposerOptionPopover>
            </div>
          </div>
          <div className={error ? 'canvas-composer__feedback is-error' : 'canvas-composer__feedback'} role={error ? 'alert' : 'status'}>
            {error ?? (isGenerating
              ? (status === 'recovering' ? '正在确认任务，请勿重复提交…' : status === 'uploading' ? '正在上传参考素材…' : status === 'queued' ? '任务已入队…' : `${selectedModel?.mediaKind === 'video' ? '视频' : '图像'}服务正在生成…`)
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

function taskStatusLabel(status: 'uploading' | 'submission_unknown' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled') {
  const labels = {
    uploading: '提交素材',
    submission_unknown: '等待确认',
    queued: '任务排队',
    running: '真实生成中',
    succeeded: '候选待选',
    failed: '任务失败',
    cancelled: '已取消',
  }
  return labels[status]
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
      <footer><span>{generationSettingsSizeLabel(prompt.settings)}</span><i>{taskStatusLabel(prompt.status)}</i></footer>
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
  const resultName = result.label ?? (result.generationKind === 'refinement' ? '精修版本' : '生成版本')
  const hasDisplayableImage = Boolean(result.image) && !imageFailed
  const isGenerating = result.status === 'generating'
  const isSubmissionUnknown = result.taskStatus === 'submission_unknown'
  const taskFeedback = generationTaskFeedback(result.taskStatus)
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
        className={['result-node', ratioClass, isGenerating ? 'result-node--generating' : '', isSubmissionUnknown ? 'result-node--recovering' : '', isSelected ? 'is-selected' : ''].filter(Boolean).join(' ')}
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
            {isSubmissionUnknown ? <button className="result-node__task-action nodrag nowheel" type="button" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); void recoverUnknownGenerationSubmission() }}>立即确认</button> : null}
            {result.status === 'generating' && !isSubmissionUnknown ? <button className="result-node__task-action nodrag nowheel" type="button" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); cancelGeneration() }}>取消</button> : null}
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

export const canvasNodeTypes = {
  asset: AssetNode,
  text: TextNode,
  generate: GenerateNode,
  prompt: PromptNode,
  reference: ReferenceGroupNode,
  result: ResultNode,
}
