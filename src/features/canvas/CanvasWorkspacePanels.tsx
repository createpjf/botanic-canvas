import { type DragEvent, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { buildDeliveryPreviewArtifacts, resolveDeliveryDraft, type DeliveryPanelTarget } from '../../domain/deliveryPresentation'
import { topOverlayLayer } from '../../domain/overlayPriority'
import { primaryGenerationReference, settingsForGenerationModel } from '../../domain/generationRecipe'
import { summarizeWorkflowTemplate, type WorkflowTemplateSummary } from '../../domain/workflowTemplates'
import { productionWorkflowDraftFromCanvas } from '../../domain/productionWorkflows'
import { useMotionPresence, useRestoreFocus, useRetainedValue, type MotionPhase } from '../../components/motionPresence'
import { useDialogFocusTrap } from '../../components/useDialogFocusTrap'
import { BotanicSelect } from '../../components/BotanicSelect'
import type {
  AssetGroup,
  AssetRecord,
  AssetRole,
  AssetSource,
  BatchVariationRun,
  CanvasNode,
  CanvasDocument,
  CanvasTemplate,
  DeliveryArtifact,
  DeliveryPresetId,
  GenerationCandidate,
  GenerationMediaKind,
  GenerationModelOption,
  GenerationRecipe,
  GenerationSettings,
  GenerateNodeData,
  ProductionWorkflow,
  ProductionWorkflowRun,
  UploadedAssetInput,
} from '../../domain/canvas'
import { useCanvasStore } from '../../store/canvasStore'
import { deliveryPresets, downloadDeliveryPackage } from '../../lib/deliveryExport'
import { downloadMedia } from '../../lib/mediaDownload'
import {
  listProductionWorkflowRuns,
  listProductionWorkflows,
  publishProductionWorkflow,
  readProductionWorkflowRun,
  startProductionWorkflowRun,
  updateProductionWorkflowRun,
} from '../../lib/productionWorkflowApi'
import { maxUploadAssets, readUploadedAssetInput, validateUploadFiles } from '../../lib/uploadedAssets'
import { CloseIcon, DeleteIcon, DownloadIcon, FocusIcon, MoreIcon, PlusSquareIcon, UploadIcon } from '../../components/BotanicIcons'

export type GeneratedHistoryItem = {
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

export type BatchVariationRequest = {
  groupId: string
  prompt: string
  candidatesPerAsset: number
  settings: GenerationSettings
}

function visibleAssetTags(tags: string[], fallback?: string) {
  const values = tags.filter((tag) => !/mock/i.test(tag))
  return values.length ? values : fallback ? [fallback] : []
}

function primaryReferenceFromRecipe(recipe?: GenerationRecipe) {
  return recipe ? primaryGenerationReference(recipe) : undefined
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

const uploadRoles: UploadedAssetInput['role'][] = ['商品', '模特', '场景', '调性']

function imagePreviewSize(imageWidth: number, imageHeight: number) {
  const scale = Math.min(320 / imageWidth, 340 / imageHeight, 1)
  return {
    width: Math.max(1, Math.round(imageWidth * scale)),
    height: Math.max(1, Math.round(imageHeight * scale)),
  }
}

function batchVariationDefaultPrompt(role: AssetGroup['role']) {
  if (role === '场景') return '保持父图中的人物、服装与商品主体一致，分别替换为素材组中的场景，并让光线、透视与接触关系自然融合。'
  if (role === '调性') return '保持父图中的人物、服装、商品与构图一致，分别参考素材组中的视觉风格调整色彩、光线与质感。'
  if (role === '模特') return '保持父图中的服装、商品、场景与整体构图，分别替换为素材组中的模特，并自然适配姿势与光线。'
  return '保持父图中的人物、场景与视觉风格，分别替换为素材组中的商品或服装，并保持商品结构、图案与标识清晰。'
}

export function BatchVariationProgress({
  run,
  onRetry,
}: {
  run: BatchVariationRun
  onRetry: (runId: string, itemId: string) => void
}) {
  const completedCount = run.items.filter((item) => item.status === 'succeeded').length
  const settledCount = run.items.filter((item) => item.status === 'succeeded' || item.status === 'failed' || item.status === 'cancelled').length
  const progress = run.items.length ? Math.round((settledCount / run.items.length) * 100) : 0
  const statusLabel = run.status === 'queued'
    ? '排队中'
    : run.status === 'running'
      ? '处理中'
      : run.status === 'partial'
        ? '部分完成'
        : run.status === 'failed'
          ? '未完成'
          : run.status === 'cancelled'
            ? '已取消'
            : '已完成'
  const itemStatusLabel = (status: BatchVariationRun['items'][number]['status']) => status === 'queued'
    ? '排队中'
    : status === 'running'
      ? '生成中'
      : status === 'succeeded'
        ? '已完成'
        : status === 'cancelled'
          ? '已取消'
          : '失败'

  return createPortal(
    <aside className="batch-variation-progress" role="status" aria-live="polite" aria-label="批量变体进度">
      <header>
        <span><strong>批量变体</strong><small>{run.groupName} · {completedCount}/{run.items.length} 张完成</small></span>
        <b>{statusLabel}</b>
      </header>
      <div className="batch-variation-progress__track" aria-hidden="true"><i style={{ width: `${progress}%` }} /></div>
      <ul>
        {run.items.map((item) => <li key={item.id} className={`is-${item.status}`}>
          <span className="batch-variation-progress__marker" aria-hidden="true">{item.status === 'succeeded' ? '✓' : item.status === 'failed' ? '!' : item.status === 'cancelled' ? '–' : ''}</span>
          <span className="batch-variation-progress__copy"><strong>{item.assetName}</strong><small>{item.error ?? itemStatusLabel(item.status)}</small></span>
          {item.status === 'failed' ? <button type="button" onClick={() => onRetry(run.id, item.id)}>重试</button> : null}
        </li>)}
      </ul>
    </aside>,
    document.body,
  )
}

export function BatchVariationComposer({
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
  const dialogRef = useDialogFocusTrap(true)
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
    return imageModel ? settingsForGenerationModel(target.settings, imageModel) : target.settings
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
      <section ref={dialogRef} className="batch-variation-composer" role="dialog" aria-modal="true" aria-label="批量变体">
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
              if (model) setSettings((current) => settingsForGenerationModel(current, model))
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

export function AssetLibrary({
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
  const previewDialogRef = useDialogFocusTrap(Boolean(previewAssetId))
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

  useEffect(() => {
    if (!previewAssetId) return
    const closePreview = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setPreviewAssetId(null)
    }
    document.addEventListener('keydown', closePreview)
    return () => document.removeEventListener('keydown', closePreview)
  }, [previewAssetId])
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
      event.preventDefault()
      event.stopPropagation()
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
            title="点击预览，或拖拽到画布"
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
              <button type="button" className="asset-card__preview-hitbox" onClick={() => setPreviewAssetId(item.id)} aria-label={`预览 ${item.name}`} />
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
            <button type="button" className="asset-card__copy" onClick={() => setPreviewAssetId(item.id)} aria-label={`预览 ${item.name}`}>
              <strong>{item.name}</strong>
              <span>{visibleAssetTags(item.tags).filter((tag) => item.source !== 'generated' || !/^(生成|真实生成|已入库|生成入库)$/i.test(tag)).slice(0, 2).join(' · ')}</span>
            </button>
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
          <section ref={previewDialogRef} className="asset-preview" role="dialog" aria-modal="true" aria-label={`预览素材 ${visiblePreviewAsset.name}`}>
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

export function TemplatePanel({
  projectId,
  canvasDocument,
  templates,
  sharedTemplates,
  currentName,
  projectSaveSummary,
  sharedSaveSummary,
  onSave,
  onSaveShared,
  onCreateProject,
  onRefresh,
  onOpenHistory,
  onLocateWorkflowNode,
  onClose,
}: {
  projectId: string
  canvasDocument: CanvasDocument
  templates: CanvasTemplate[]
  sharedTemplates: CanvasTemplate[]
  currentName: string
  projectSaveSummary: WorkflowTemplateSummary
  sharedSaveSummary: WorkflowTemplateSummary
  onSave: (name: string) => void
  onSaveShared: (name: string) => Promise<boolean>
  onCreateProject: (id: string, shared: boolean) => Promise<boolean>
  onRefresh: () => Promise<void>
  onOpenHistory: () => void
  onLocateWorkflowNode: (nodeId: string) => void
  onClose: () => void
}) {
  const [activeTab, setActiveTab] = useState<'shared' | 'project' | 'automation'>(sharedTemplates.length ? 'shared' : 'project')
  const [name, setName] = useState(`${currentName} · 模板`)
  const [saveOpen, setSaveOpen] = useState(false)
  const [scope, setScope] = useState<'project' | 'shared'>('project')
  const [saving, setSaving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const [creatingTemplateId, setCreatingTemplateId] = useState<string | null>(null)
  const [createError, setCreateError] = useState('')
  const [productionWorkflows, setProductionWorkflows] = useState<ProductionWorkflow[]>(canvasDocument.productionWorkflows ?? [])
  const [productionRuns, setProductionRuns] = useState<ProductionWorkflowRun[]>(canvasDocument.productionWorkflowRuns ?? [])
  const [productionBusy, setProductionBusy] = useState('')
  const [productionError, setProductionError] = useState('')
  const saveDialogPresence = useMotionPresence(saveOpen, 140)
  useRestoreFocus(saveOpen)
  const saveDialogRef = useDialogFocusTrap(saveOpen)
  const saveSummary = scope === 'shared' ? sharedSaveSummary : projectSaveSummary
  const visibleTemplates = activeTab === 'shared' ? sharedTemplates : templates
  const productionDraft = useMemo(() => productionWorkflowDraftFromCanvas(canvasDocument), [canvasDocument])

  const refreshProductionWorkflows = async () => {
    const workflows = await listProductionWorkflows(projectId)
    const runGroups = await Promise.all(workflows.map(async (workflow) => {
      const runs = await listProductionWorkflowRuns(projectId, workflow.id)
      return Promise.all(runs.map((run) => ['queued', 'running', 'paused'].includes(run.status)
        ? readProductionWorkflowRun(projectId, run.id)
        : run))
    }))
    setProductionWorkflows(workflows)
    setProductionRuns(runGroups.flat().sort((left, right) => right.createdAt - left.createdAt))
  }

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
    let active = true
    void refreshProductionWorkflows().catch(() => {
      if (active) setProductionError('生产工作流暂时无法同步，当前显示上次保存的记录。')
    })
    return () => { active = false }
  }, [projectId])

  useEffect(() => {
    if (activeTab !== 'automation' || !productionRuns.some((run) => ['queued', 'running'].includes(run.status))) return
    const timer = window.setInterval(() => void refreshProductionWorkflows().catch(() => undefined), 3_000)
    return () => window.clearInterval(timer)
  }, [activeTab, productionRuns])

  useEffect(() => {
    if (!saveOpen) return
    const closeDialog = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || saving) return
      event.preventDefault()
      event.stopPropagation()
      setSaveOpen(false)
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
    if (useCanvasStore.getState().document.id !== projectId) return
    setCreatingTemplateId(null)
    if (created) onClose()
    else setCreateError('项目未创建，请检查网络后重试。')
  }
  const publishAutomation = async () => {
    if (!productionDraft || productionBusy) return
    setProductionBusy('publish')
    setProductionError('')
    try {
      await publishProductionWorkflow({
        projectId,
        id: `production-${productionDraft.sourceNodeId}`,
        name: productionDraft.name,
        definition: productionDraft.definition,
      })
      await refreshProductionWorkflows()
      setActiveTab('automation')
    } catch (error) {
      setProductionError(error instanceof Error ? error.message : '生产工作流保存失败，请稍后重试。')
    } finally {
      setProductionBusy('')
    }
  }
  const startAutomation = async (workflow: ProductionWorkflow) => {
    if (productionBusy) return
    setProductionBusy(workflow.id)
    setProductionError('')
    try {
      const runId = `run-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`
      await startProductionWorkflowRun({
        projectId,
        workflowId: workflow.id,
        workflowVersion: workflow.currentVersion,
        id: runId,
        items: [{ id: 'item-1' }],
      })
      await refreshProductionWorkflows()
    } catch (error) {
      setProductionError(error instanceof Error ? error.message : '生产工作流启动失败，请稍后重试。')
    } finally {
      setProductionBusy('')
    }
  }
  const updateAutomation = async (run: ProductionWorkflowRun, action: 'pause' | 'resume' | 'cancel' | 'retry-failed') => {
    if (productionBusy) return
    setProductionBusy(run.id)
    setProductionError('')
    try {
      const updated = await updateProductionWorkflowRun(projectId, run.id, action)
      setProductionRuns((current) => current.map((item) => item.id === updated.id ? updated : item))
      await refreshProductionWorkflows()
    } catch (error) {
      setProductionError(error instanceof Error ? error.message : '生产工作流操作失败，请稍后重试。')
    } finally {
      setProductionBusy('')
    }
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
        <button type="button" role="tab" aria-selected={activeTab === 'automation'} className={activeTab === 'automation' ? 'is-active' : ''} onClick={() => setActiveTab('automation')}>生产 <span>{productionWorkflows.length}</span></button>
      </div>
      {refreshing && activeTab === 'shared' ? <p className="template-sync-state" role="status">正在更新团队模板…</p> : null}
      {refreshError && activeTab === 'shared' ? <p className="template-sync-state is-error">{refreshError}</p> : null}
      {createError ? <p className="template-sync-state is-error" role="alert">{createError}</p> : null}
      {productionError ? <p className="template-sync-state is-error" role="alert">{productionError}</p> : null}
      {activeTab !== 'automation' ? <section className="template-section" aria-label={activeTab === 'shared' ? '团队模板' : '本项目模板'}>
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
      </section> : (
        <section className="template-section production-workflow-section" aria-label="生产工作流">
          <button type="button" className="production-workflow-publish" disabled={!productionDraft || Boolean(productionBusy)} onClick={() => void publishAutomation()}>
            <PlusSquareIcon />{productionBusy === 'publish' ? '正在保存…' : productionDraft?.sourceAgentRunId ? '保存已验证 Agent 操作' : '保存当前生成流程'}
          </button>
          {!productionDraft ? <p className="panel-note">先完成一条已连接稳定入库素材的生成流程，再保存为生产工作流。</p> : null}
          <div className="production-workflow-list">
            {productionWorkflows.map((workflow) => {
              const runs = productionRuns.filter((run) => run.workflowId === workflow.id)
              const latestRun = runs[0]
              const resultNodeId = latestRun?.items.flatMap((item) => item.canvasNodeIds ?? [])[0]
              const hasFailed = latestRun?.items.some((item) => item.status === 'failed')
              return <article className="production-workflow-card" key={workflow.id}>
                <header><div><strong>{workflow.name}</strong><span>版本 {workflow.currentVersion} · {runs.length} 次运行</span></div><em>{latestRun?.status ?? '未运行'}</em></header>
                <p>{workflow.versions.at(-1)?.definition.prompt}</p>
                <small>{workflow.versions.at(-1)?.definition.model} · {String(workflow.versions.at(-1)?.definition.output?.aspectRatio ?? '')} · {String(workflow.versions.at(-1)?.definition.output?.resolution ?? '')}</small>
                <footer>
                  <button type="button" disabled={Boolean(productionBusy)} onClick={() => void startAutomation(workflow)}>{productionBusy === workflow.id ? '处理中…' : '运行当前版本'}</button>
                  {latestRun?.status === 'running' ? <button type="button" onClick={() => void updateAutomation(latestRun, 'pause')}>暂停</button> : null}
                  {latestRun?.status === 'paused' ? <button type="button" onClick={() => void updateAutomation(latestRun, 'resume')}>恢复</button> : null}
                  {latestRun && ['queued', 'running', 'paused'].includes(latestRun.status) ? <button type="button" onClick={() => void updateAutomation(latestRun, 'cancel')}>取消</button> : null}
                  {hasFailed ? <button type="button" onClick={() => void updateAutomation(latestRun, 'retry-failed')}>重试失败项</button> : null}
                  {resultNodeId ? <button type="button" onClick={() => onLocateWorkflowNode(resultNodeId)}>定位结果</button> : null}
                  {latestRun?.items.some((item) => item.artifactIds?.length) ? <button type="button" onClick={onOpenHistory}>审核与交付</button> : null}
                </footer>
              </article>
            })}
            {!productionWorkflows.length ? <div className="template-empty"><strong>还没有生产工作流</strong><span>将已验证的 Agent 或画布生成流程保存为不可变版本，之后可批量运行与恢复。</span></div> : null}
          </div>
        </section>
      )}
      {saveDialogPresence.present && typeof document !== 'undefined' ? createPortal(
        <div className={`template-dialog-backdrop motion-overlay is-${saveDialogPresence.phase}`} role="presentation" aria-hidden={saveDialogPresence.phase === 'exit' ? true : undefined} onMouseDown={() => !saving && setSaveOpen(false)}>
          <form ref={(element) => { saveDialogRef.current = element }} className="template-dialog" role="dialog" aria-modal="true" aria-labelledby="save-template-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void saveTemplate() }}>
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

export function HistoryPanel({
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


export function NodeReferencePanel({
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


export function GenerationPanel({
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
  status: 'idle' | 'uploading' | 'queued' | 'running' | 'recovering' | 'error'
  pendingCount: number
  error: string | null
  kind?: GenerationCandidate['kind']
  candidates: GenerationCandidate[]
  onSelect: (id: string) => void
  onCancel: () => void
  onRetry: () => void
  onClose: () => void
}) {
  const isInFlight = status === 'uploading' || status === 'queued' || status === 'running' || status === 'recovering'
  const statusMessage = status === 'recovering'
    ? '正在确认任务，请勿重复提交'
    : status === 'uploading'
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
          <article className={`${candidate.selected ? 'candidate-card is-selected' : 'candidate-card'} candidate-card--ratio-${candidate.settings.aspectRatio.replace(':', '-')}`} key={candidate.id}>
            {candidate.mediaKind === 'video'
              ? <video src={candidate.image} aria-label={candidate.name} controls playsInline preload="metadata" />
              : <img src={candidate.image} alt={candidate.name} />}
            <button type="button" className="candidate-card__select" onClick={() => onSelect(candidate.id)} aria-pressed={candidate.selected}>
              <span>{candidate.name}</span>
              <small>{candidate.kind === 'refinement' ? `精修自 ${candidate.parentLabel ?? '已选首图'}` : `主商品 · ${primaryReferenceFromRecipe(candidate.recipe)?.name ?? '未锁定'}`} · {candidate.recipe.references.length} 参考</small>
            </button>
          </article>
        )) : null}
      </div>
    </aside>
  )
}

export function DeliveryPanel({
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

export function ConfirmationDialog({ asset, phase, onConfirm, onCancel }: { asset: AssetRecord; phase: MotionPhase; onConfirm: () => void; onCancel: () => void }) {
  const isSharedBrandAsset = asset.source === 'brand'
  const dialogRef = useDialogFocusTrap(phase !== 'exit')
  return (
    <div className={`confirm-backdrop motion-overlay is-${phase}`} aria-hidden={phase === 'exit' ? true : undefined}>
      <section ref={dialogRef} className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-asset-title">
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


export function UndoToast({ label, phase, onUndo }: { label: string; phase: MotionPhase; onUndo: () => void }) {
  return (
    <div className={`undo-toast is-${phase}`} role="status" aria-hidden={phase === 'exit' ? true : undefined}>
      <span>{label}</span>
      <button onClick={onUndo}>撤销</button>
    </div>
  )
}
