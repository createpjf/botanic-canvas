import { type DragEvent, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { buildDeliveryPreviewArtifacts, resolveDeliveryDraft, type DeliveryPanelTarget } from '../../domain/deliveryPresentation'
import { imageFormatShortList, imageFormatSentenceList, imageUploadAccept } from '../../domain/mediaFormats'
import { topOverlayLayer } from '../../domain/overlayPriority'
import { everydayResolutions, maximumReferencesForModel, primaryGenerationReference, settingsForGenerationModel } from '../../domain/generationRecipe'
import { withoutCustomGenerationSize } from '../../domain/generationOutputSize'
import { summarizeWorkflowTemplate, type WorkflowTemplateSummary } from '../../domain/workflowTemplates'
import { eligibleProductionWorkflowSources, productionWorkflowDraftFromCanvas } from '../../domain/productionWorkflows'
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
  downloadProductionWorkflowRunPackage,
  startProductionWorkflowRun,
  updateProductionWorkflowRun,
} from '../../lib/productionWorkflowApi'
import { cachedProjectCapabilities } from '../../lib/db'
import { canUseProjectEntry, isReadOnlyProject, readOnlyProjectNotice } from '../../domain/projectCapabilities'
import {
  addWorkflowBatchRow,
  canSubmitWorkflowBatch,
  parseWorkflowBatchCsv,
  removeWorkflowBatchRow,
  updateWorkflowBatchCell,
  validateWorkflowBatchItems,
  workflowBatchColumns,
  workflowBatchImportSummary,
  type WorkflowBatchField,
  type WorkflowBatchItem,
} from '../../domain/workflowBatchInput'
import { serverPersistenceEnabled } from '../../lib/productSession'
import { maxUploadAssets, readUploadedAssetInput, validateUploadFiles } from '../../lib/uploadedAssets'
import { CloseIcon, DeleteIcon, DownloadIcon, FocusIcon, MoreIcon, PlusSquareIcon, UploadIcon } from '../../components/BotanicIcons'
import { formatProductDateTime, localizeProductError } from '../../i18n/core'
import { useProductI18n, useProductMessages } from '../../i18n/react'
import { canvasAssetRoleLabel, canvasAssetSourceLabel, canvasDurationLabel, canvasSystemLabel } from './canvasI18n'

const batchCopy = {
  'zh-CN': {
    prompts: {
      '场景': '保持父图中的人物、服装与商品主体一致，分别替换为素材组中的场景，并让光线、透视与接触关系自然融合。',
      '调性': '保持父图中的人物、服装、商品与构图一致，分别参考素材组中的视觉风格调整色彩、光线与质感。',
      '模特': '保持父图中的服装、商品、场景与整体构图，分别替换为素材组中的模特，并自然适配姿势与光线。',
      '商品': '保持父图中的人物、场景与视觉风格，分别替换为素材组中的商品或服装，并保持商品结构、图案与标识清晰。',
      '首图': '保持父图的主体与构图，分别使用素材组中的首图参考。',
    },
    statuses: { queued: '排队中', running: '处理中', partial: '部分完成', failed: '未完成', cancelled: '已取消', succeeded: '已完成' }, itemStatuses: { queued: '排队中', running: '生成中', succeeded: '已完成', cancelled: '已取消', failed: '失败' }, progress: '批量变体进度', eyebrow: '批量变体', title: '批量变体', completed: (done: number, total: number) => `${done}/${total} 张完成`, retry: '重试', close: '关闭批量变体', parent: '父图', branchHint: '新结果会形成子分支，不覆盖父图', variableGroup: '可变素材组', chooseGroup: '选择可变素材组', groupOption: (name: string, count: number, role: string) => `${name} · ${count} 个${role}`, parentReference: '父图主参考', lockSubject: '锁定核心主体', variable: (role: string) => `可变：${role}`, changeBrief: '变化说明', model: '模型', chooseModel: '选择批量生成模型', ratio: '比例', chooseRatio: '选择批量画面比例', resolution: '分辨率', chooseResolution: '选择批量输出分辨率', each: '每项张数', total: (assets: number, each: number, total: number, over: boolean) => `${assets} 个素材 × ${each} = ${total} 张${over ? '（最多 20 张）' : ''}`, taskRunning: '已有任务运行中', generate: (total: number) => `生成 ${total} 张`, createGroup: '先创建一个素材组', createGroupHint: '可在素材库上传整个文件夹，系统会自动形成素材组。', openLibrary: '打开素材库',
  },
  en: {
    prompts: {
      '场景': 'Keep the people, clothing, and product consistent while replacing the scene with each asset in the group. Blend lighting, perspective, and contact naturally.',
      '调性': 'Keep the people, clothing, product, and composition while applying the color, lighting, and texture of each style reference.',
      '模特': 'Keep the clothing, product, scene, and composition while replacing the model with each asset and adapting pose and lighting naturally.',
      '商品': 'Keep the people, scene, and visual style while replacing the product or garment with each asset. Preserve its structure, pattern, and branding.',
      '首图': 'Keep the subject and composition while using each key visual in the group as a reference.',
    },
    statuses: { queued: 'Queued', running: 'Processing', partial: 'Partially complete', failed: 'Incomplete', cancelled: 'Cancelled', succeeded: 'Complete' }, itemStatuses: { queued: 'Queued', running: 'Generating', succeeded: 'Complete', cancelled: 'Cancelled', failed: 'Failed' }, progress: 'Batch variation progress', eyebrow: 'Batch', title: 'Batch variations', completed: (done: number, total: number) => `${done}/${total} complete`, retry: 'Retry', close: 'Close batch variations', parent: 'Parent image', branchHint: 'New results become child branches and do not overwrite the parent', variableGroup: 'Variable asset group', chooseGroup: 'Choose variable asset group', groupOption: (name: string, count: number, role: string) => `${name} · ${count} ${role}`, parentReference: 'Parent reference', lockSubject: 'Lock core subject', variable: (role: string) => `Variable: ${role}`, changeBrief: 'Variation brief', model: 'Model', chooseModel: 'Choose batch model', ratio: 'Ratio', chooseRatio: 'Choose batch aspect ratio', resolution: 'Resolution', chooseResolution: 'Choose batch output resolution', each: 'Images each', total: (assets: number, each: number, total: number, over: boolean) => `${assets} assets × ${each} = ${total}${over ? ' (20 maximum)' : ''}`, taskRunning: 'Another task is running', generate: (total: number) => `Generate ${total}`, createGroup: 'Create an asset group first', createGroupHint: 'Upload a folder in the asset library to create a group automatically.', openLibrary: 'Open asset library',
  },
} as const

const assetCopy = {
  'zh-CN': {
    library: '素材库', uploadAsset: '上传素材', upload: '上传', uploadImages: '上传图片', maxImages: `最多 ${maxUploadAssets} 张`, uploadFolder: '上传文件夹', recursive: '递归读取图片', close: '关闭素材库', bulkImages: '批量上传图片素材', bulkFolder: '批量上传图片文件夹', drop: '松开以上传', staged: '待入库素材', stagedCount: (count: number) => `待入库 · ${count}/${maxUploadAssets}`, clear: '清空', assetName: (name: string) => `素材名称 ${name}`, role: (name: string) => `${name} 的角色`, tags: (name: string) => `${name} 的标签`, tagsPlaceholder: '标签，用逗号分隔', removePending: (name: string) => `移除待上传素材 ${name}`, readyAfterSave: '确认后可拖入画布', saveCount: (count: number) => `入库 ${count} 张`, mediaType: '素材媒体类型', images: '图片', videos: '视频', searchPlaceholder: '搜索素材或标签', search: '搜索素材', sourceFilter: (count: number) => `筛选素材来源${count ? `，已启用 ${count} 项` : ''}`, source: '来源', assetSource: '素材来源', all: '全部', clearSource: '清除来源筛选', assetType: '素材类型', groups: '素材组', newGroup: '新建', noGroups: '暂无素材组', groupName: '素材组名称', groupType: '素材组类型', cancel: '取消', create: (count: number) => `创建${count ? `并加入 ${count} 项` : ''}`, renameGroup: '重命名素材组', save: '保存', assetsRemain: '素材仍会保留', confirmDelete: '确认删除', rename: '重命名', deleteGroup: '删除组', filtered: '筛选结果', allAssets: '全部素材', itemCount: (count: number) => `${count} 项`, cardTitle: '点击预览，或拖拽到画布', preview: (name: string) => `预览 ${name}`, select: (name: string, selected: boolean) => `${selected ? '取消选择' : '选择'} ${name}`, addToCanvas: (name: string) => `将 ${name} 加入画布`, add: '加入画布', more: (name: string) => `更多操作：${name}`, empty: '没有匹配的素材', moreMenu: (name: string) => `${name} 的更多操作`, setType: (name: string) => `设置 ${name} 的素材类型`, deleteAsset: '删除素材', previewAsset: (name: string) => `预览素材 ${name}`, closePreview: '关闭素材预览', videoAsset: '视频素材', imageAsset: '图片素材', noTags: '暂无标签', download: '下载', bulkActions: '批量素材操作', selected: (count: number) => `已选 ${count} 项`, addGroup: '加入素材组', addSelectedGroup: '将所选素材加入素材组', createGroupOption: '＋ 新建素材组', maxStaged: `单次最多暂存 ${maxUploadAssets} 张图片`, chooseImages: `请选择 ${imageFormatSentenceList('zh-CN')} 图片`, stagedNotice: (count: number) => `已暂存 ${count} 张，单次最多 ${maxUploadAssets} 张。`, readFailed: (count: number) => `${count} 张图片读取失败。`, savedLocal: '已存入本地素材库',
  },
  en: {
    library: 'Asset library', uploadAsset: 'Upload assets', upload: 'Upload', uploadImages: 'Upload images', maxImages: `Up to ${maxUploadAssets}`, uploadFolder: 'Upload folder', recursive: 'Read images recursively', close: 'Close asset library', bulkImages: 'Upload multiple image assets', bulkFolder: 'Upload an image folder', drop: 'Drop to upload', staged: 'Assets to save', stagedCount: (count: number) => `Ready to save · ${count}/${maxUploadAssets}`, clear: 'Clear', assetName: (name: string) => `Asset name: ${name}`, role: (name: string) => `${name} role`, tags: (name: string) => `${name} tags`, tagsPlaceholder: 'Tags, separated by commas', removePending: (name: string) => `Remove pending asset ${name}`, readyAfterSave: 'Save before dragging to canvas', saveCount: (count: number) => `Save ${count}`, mediaType: 'Asset media type', images: 'Images', videos: 'Videos', searchPlaceholder: 'Search assets or tags', search: 'Search assets', sourceFilter: (count: number) => `Filter asset source${count ? `, ${count} active` : ''}`, source: 'Source', assetSource: 'Asset source', all: 'All', clearSource: 'Clear source filter', assetType: 'Asset type', groups: 'Asset groups', newGroup: 'New', noGroups: 'No asset groups', groupName: 'Asset group name', groupType: 'Asset group type', cancel: 'Cancel', create: (count: number) => `Create${count ? ` and add ${count}` : ''}`, renameGroup: 'Rename asset group', save: 'Save', assetsRemain: 'Assets will remain', confirmDelete: 'Confirm delete', rename: 'Rename', deleteGroup: 'Delete group', filtered: 'Filtered results', allAssets: 'All assets', itemCount: (count: number) => `${count} ${count === 1 ? 'item' : 'items'}`, cardTitle: 'Select to preview or drag to canvas', preview: (name: string) => `Preview ${name}`, select: (name: string, selected: boolean) => `${selected ? 'Deselect' : 'Select'} ${name}`, addToCanvas: (name: string) => `Add ${name} to canvas`, add: 'Add to canvas', more: (name: string) => `More actions: ${name}`, empty: 'No matching assets', moreMenu: (name: string) => `More actions for ${name}`, setType: (name: string) => `Set asset type for ${name}`, deleteAsset: 'Delete asset', previewAsset: (name: string) => `Preview asset ${name}`, closePreview: 'Close asset preview', videoAsset: 'Video asset', imageAsset: 'Image asset', noTags: 'No tags', download: 'Download', bulkActions: 'Bulk asset actions', selected: (count: number) => `${count} selected`, addGroup: 'Add to asset group', addSelectedGroup: 'Add selected assets to group', createGroupOption: '+ New asset group', maxStaged: `Up to ${maxUploadAssets} images per batch`, chooseImages: `Choose ${imageFormatSentenceList('en')} images`, stagedNotice: (count: number) => `${count} staged, up to ${maxUploadAssets} per batch.`, readFailed: (count: number) => `${count} images could not be read.`, savedLocal: 'Saved to local asset library',
  },
} as const

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

function batchVariationDefaultPrompt(role: AssetGroup['role'], locale: 'zh-CN' | 'en') {
  return batchCopy[locale].prompts[role]
}

export function BatchVariationProgress({
  run,
  onRetry,
}: {
  run: BatchVariationRun
  onRetry: (runId: string, itemId: string) => void
}) {
  const { locale } = useProductI18n()
  const t = batchCopy[locale]
  const completedCount = run.items.filter((item) => item.status === 'succeeded').length
  const settledCount = run.items.filter((item) => item.status === 'succeeded' || item.status === 'failed' || item.status === 'cancelled').length
  const progress = run.items.length ? Math.round((settledCount / run.items.length) * 100) : 0
  const statusLabel = t.statuses[run.status]
  const itemStatusLabel = (status: BatchVariationRun['items'][number]['status']) => t.itemStatuses[status]

  return createPortal(
    <aside className="batch-variation-progress" role="status" aria-live="polite" aria-label={t.progress}>
      <header>
        <span><strong>{t.title}</strong><small>{run.groupName} · {t.completed(completedCount, run.items.length)}</small></span>
        <b>{statusLabel}</b>
      </header>
      <div className="batch-variation-progress__track" aria-hidden="true"><i style={{ width: `${progress}%` }} /></div>
      <ul>
        {run.items.map((item) => <li key={item.id} className={`is-${item.status}`}>
          <span className="batch-variation-progress__marker" aria-hidden="true">{item.status === 'succeeded' ? '✓' : item.status === 'failed' ? '!' : item.status === 'cancelled' ? '–' : ''}</span>
          <span className="batch-variation-progress__copy"><strong>{item.assetName}</strong><small>{item.error ? localizeProductError(new Error(item.error), locale, { 'zh-CN': item.error, en: t.itemStatuses.failed }) : itemStatusLabel(item.status)}</small></span>
          {item.status === 'failed' ? <button type="button" onClick={() => onRetry(run.id, item.id)}>{t.retry}</button> : null}
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
  const { locale } = useProductI18n()
  const t = batchCopy[locale]
  const dialogRef = useDialogFocusTrap(true)
  const imageAssetIds = useMemo(() => new Set(assets.filter((asset) => (asset.mediaKind ?? 'image') === 'image').map((asset) => asset.id)), [assets])
  const availableGroups = useMemo(() => groups.map((group) => ({
    ...group,
    assetIds: group.assetIds.filter((assetId) => imageAssetIds.has(assetId)),
  })).filter((group) => group.assetIds.length), [groups, imageAssetIds])
  const [groupId, setGroupId] = useState(availableGroups[0]?.id ?? '')
  const activeGroup = availableGroups.find((group) => group.id === groupId) ?? availableGroups[0]
  const [prompt, setPrompt] = useState<string>(() => batchVariationDefaultPrompt(availableGroups[0]?.role ?? '场景', locale))
  const [candidatesPerAsset, setCandidatesPerAsset] = useState(1)
  const [settings, setSettings] = useState(() => {
    const imageModel = models.find((model) => model.id === target.settings.model && (model.mediaKind ?? 'image') === 'image')
      ?? models.find((model) => (model.mediaKind ?? 'image') === 'image')
    const next = imageModel ? settingsForGenerationModel(target.settings, imageModel) : target.settings
    const everyday = everydayResolutions(imageModel)
    return everyday.includes(next.resolution)
      ? next
      : { ...next, resolution: everyday.includes('2K') ? '2K' as const : everyday[0] ?? '2K' }
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
      <section ref={dialogRef} className="batch-variation-composer" role="dialog" aria-modal="true" aria-label={t.title}>
        <header>
          <div><span>{t.eyebrow}</span><h2>{t.title}</h2></div>
          <button type="button" onClick={onClose} aria-label={t.close}><CloseIcon /></button>
        </header>
        <div className="batch-variation-source"><img src={target.image} alt="" /><div><span>{t.parent}</span><strong>{target.name}</strong><small>{t.branchHint}</small></div></div>
        {availableGroups.length ? <>
          <label className="batch-variation-field"><span>{t.variableGroup}</span><BotanicSelect value={activeGroup?.id ?? ''} ariaLabel={t.chooseGroup} options={availableGroups.map((group) => ({ value: group.id, label: t.groupOption(group.name, group.assetIds.length, canvasAssetRoleLabel(group.role, locale)) }))} onChange={(value) => {
            const next = availableGroups.find((group) => group.id === value)
            setGroupId(value)
            if (next) setPrompt(batchVariationDefaultPrompt(next.role, locale))
          }} /></label>
          <div className="batch-variation-locks"><span>{t.parentReference}</span><strong>{t.lockSubject}</strong><i>{activeGroup ? t.variable(canvasAssetRoleLabel(activeGroup.role, locale)) : ''}</i></div>
          <label className="batch-variation-field"><span>{t.changeBrief}</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} /></label>
          <div className="batch-variation-parameters">
            <label><span>{t.model}</span><BotanicSelect value={settings.model} ariaLabel={t.chooseModel} menuWidth={180} options={models.filter((model) => (model.mediaKind ?? 'image') === 'image').map((model) => ({ value: model.id, label: model.label }))} onChange={(value) => {
              const model = models.find((item) => item.id === value)
              if (model) setSettings((current) => {
                const next = settingsForGenerationModel(current, model)
                const everyday = everydayResolutions(model)
                return everyday.includes(next.resolution)
                  ? next
                  : { ...next, resolution: everyday.includes('2K') ? '2K' as const : everyday[0] ?? '2K' }
              })
            }} /></label>
            <label><span>{t.ratio}</span><BotanicSelect value={settings.aspectRatio} ariaLabel={t.chooseRatio} options={(selectedModel?.aspectRatios ?? ['1:1', '16:9', '4:3', '3:4', '4:5', '9:16']).map((ratio) => ({ value: ratio, label: ratio }))} onChange={(value) => setSettings((current) => withoutCustomGenerationSize({ ...current, aspectRatio: value as GenerationSettings['aspectRatio'] }))} /></label>
            <label><span>{t.resolution}</span><BotanicSelect value={everydayResolutions(selectedModel).includes(settings.resolution) ? settings.resolution : (everydayResolutions(selectedModel).includes('2K') ? '2K' : everydayResolutions(selectedModel)[0] ?? '2K')} ariaLabel={t.chooseResolution} options={everydayResolutions(selectedModel).map((resolution) => ({ value: resolution, label: resolution }))} onChange={(value) => setSettings((current) => ({ ...current, resolution: value as GenerationSettings['resolution'] }))} /></label>
            <label><span>{t.each}</span><input type="number" min={1} max={maximumCandidates} value={candidatesPerAsset} onChange={(event) => setCandidatesPerAsset(Math.min(maximumCandidates, Math.max(1, Math.round(Number(event.target.value)) || 1)))} /></label>
          </div>
          <footer><span className={overLimit ? 'is-error' : ''}>{t.total(activeGroup?.assetIds.length ?? 0, candidatesPerAsset, total, overLimit)}</span><button type="button" disabled={busy || overLimit || !prompt.trim()} onClick={() => activeGroup && onSubmit({ groupId: activeGroup.id, prompt, candidatesPerAsset, settings })}>{busy ? t.taskRunning : t.generate(total)}</button></footer>
        </> : <div className="batch-variation-empty"><strong>{t.createGroup}</strong><p>{t.createGroupHint}</p><button type="button" onClick={onOpenAssets}>{t.openLibrary}</button></div>}
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
  const { locale } = useProductI18n()
  const t = assetCopy[locale]
  const displayAssetName = (asset: AssetRecord) => asset.source === 'generated'
    ? canvasSystemLabel(asset.name, locale)
    : asset.name
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
    const { accepted: imageFiles, message } = validateUploadFiles(files, locale)
    const allowed = imageFiles.slice(0, Math.max(0, maxUploadAssets - pendingUploads.length))
    if (!allowed.length) {
      setUploadMessage(pendingUploads.length >= maxUploadAssets ? t.maxStaged : (locale === 'zh-CN' ? message : '') || t.chooseImages)
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
      imageFiles.length > allowed.length ? t.stagedNotice(staged.length) : '',
      loaded.length > staged.length ? t.readFailed(loaded.length - staged.length) : '',
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
    setUploadMessage(t.savedLocal)
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
  const sourceLabel = (itemSource: AssetSource) => canvasAssetSourceLabel(itemSource, locale)
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
      aria-label={t.library}
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
          <h2>{t.library}</h2>
        </div>
        <div className="asset-library__header-actions">
          <details className="asset-upload-menu">
            <summary aria-label={t.uploadAsset}><UploadIcon />{t.upload}</summary>
            <div>
              <button type="button" onClick={(event) => {
                fileInputRef.current?.click()
                event.currentTarget.closest('details')?.removeAttribute('open')
              }}>
                <strong>{t.uploadImages}</strong>
                <span>{t.maxImages}</span>
              </button>
              <button type="button" onClick={(event) => {
                folderInputRef.current?.click()
                event.currentTarget.closest('details')?.removeAttribute('open')
              }}>
                <strong>{t.uploadFolder}</strong>
                <span>{t.recursive}</span>
              </button>
            </div>
          </details>
          <button className="close-panel" onClick={onClose} aria-label={t.close}><CloseIcon /></button>
        </div>
      </div>
      <input
        ref={fileInputRef}
        className="asset-file-input"
        type="file"
        accept={imageUploadAccept()}
        multiple
        aria-label={t.bulkImages}
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
        accept={imageUploadAccept()}
        multiple
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        aria-label={t.bulkFolder}
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? [])
          event.currentTarget.value = ''
          void stageFiles(files)
        }}
      />
      {assetDropPresence.present ? <div className={`asset-drop-overlay is-${assetDropPresence.phase}`}><UploadIcon /><strong>{t.drop}</strong><span>{imageFormatShortList()}</span></div> : null}
      {uploadMessage ? <p className="upload-message">{uploadMessage}</p> : null}
      {pendingUploads.length ? (
        <section className="upload-staging" aria-label={t.staged}>
          <div className="upload-staging__header">
            <strong>{t.stagedCount(pendingUploads.length)}</strong>
            <button onClick={() => setPendingUploads([])}>{t.clear}</button>
          </div>
          <div className="upload-staging__list">
            {pendingUploads.map((item) => (
              <article className="upload-staging__item" key={item.id}>
                <img src={item.image} alt={item.name} />
                <div>
                  <input value={item.name} onChange={(event) => updatePending(item.id, { name: event.target.value })} aria-label={t.assetName(item.name)} />
                  <div className="upload-staging__fields">
                    <BotanicSelect value={item.role} onChange={(value) => updatePending(item.id, { role: value as UploadedAssetInput['role'] })} ariaLabel={t.role(item.name)} options={uploadRoles.map((itemRole) => ({ value: itemRole, label: canvasAssetRoleLabel(itemRole, locale) }))} />
                    <input value={item.tagsText} onChange={(event) => updatePending(item.id, { tagsText: event.target.value })} placeholder={t.tagsPlaceholder} aria-label={t.tags(item.name)} />
                  </div>
                </div>
                <button className="upload-staging__remove" onClick={() => setPendingUploads((items) => items.filter((pending) => pending.id !== item.id))} aria-label={t.removePending(item.name)}><DeleteIcon /></button>
              </article>
            ))}
          </div>
          <div className="upload-staging__footer">
            <span>{t.readyAfterSave}</span>
            <button onClick={savePendingUploads}>{t.saveCount(pendingUploads.length)}</button>
          </div>
        </section>
      ) : null}
      <div className="asset-library__media-tabs" role="tablist" aria-label={t.mediaType}>
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
          >{kind === 'image' ? t.images : t.videos} <span>{mediaCounts[kind]}</span></button>
        ))}
      </div>
      <div className="asset-library__toolbar">
        <input className="asset-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t.searchPlaceholder} aria-label={t.search} />
        <details className="asset-filter-popover">
          <summary aria-label={t.sourceFilter(advancedFilterCount)}>
            {t.source}{advancedFilterCount ? <i>{advancedFilterCount}</i> : null}
          </summary>
          <div className="asset-filter-popover__panel">
            <section>
              <span>{t.assetSource}</span>
              <div className="asset-filter-options asset-filter-options--source" role="group" aria-label={t.assetSource}>
                {(['全部', 'brand', 'upload', 'generated'] as const).map((item) => (
                  <button type="button" key={item} className={source === item ? 'is-active' : ''} aria-pressed={source === item} onClick={() => setSource(item)}>
                    {item === '全部' ? t.all : sourceLabel(item)}
                  </button>
                ))}
              </div>
            </section>
            {advancedFilterCount ? <button className="asset-filter-popover__reset" type="button" onClick={() => setSource('全部')}>{t.clearSource}</button> : null}
          </div>
        </details>
      </div>
      <section className="asset-library__facet" aria-labelledby="asset-role-heading">
        <div className="asset-library__section-heading"><strong id="asset-role-heading">{t.assetType}</strong></div>
        <div className="asset-library__role-tabs" role="group" aria-label={t.assetType}>
          {roles.map((item) => (
            <button type="button" key={item} className={role === item ? 'is-active' : ''} aria-pressed={role === item} onClick={() => setRole(item)}>{item === '全部' ? t.all : canvasAssetRoleLabel(item, locale)}</button>
          ))}
        </div>
      </section>
      <section className="asset-library__facet asset-library__groups" aria-labelledby="asset-group-heading">
        <div className="asset-library__section-heading">
          <strong id="asset-group-heading">{t.groups}</strong>
          <button className="asset-group-create-button" type="button" onClick={() => {
            setGroupRoleDraft(role === '全部' || role === '首图' ? '场景' : role)
            setCreatingGroup(true)
          }}><PlusSquareIcon />{t.newGroup}</button>
        </div>
        <div className="asset-library__collections" aria-label={t.groups}>
          <button type="button" className={groupId === '全部' ? 'is-active' : ''} onClick={() => setGroupId('全部')}>{t.all}</button>
          {visibleGroups.map((group) => <button type="button" key={group.id} className={groupId === group.id ? 'is-active' : ''} onClick={() => setGroupId(group.id)}>{group.name} · {group.assetIds.length}</button>)}
          {!visibleGroups.length ? <span>{t.noGroups}</span> : null}
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
            <input autoFocus value={groupNameDraft} onChange={(event) => setGroupNameDraft(event.target.value)} placeholder={t.groupName} aria-label={t.groupName} />
            <BotanicSelect value={groupRoleDraft} onChange={(value) => setGroupRoleDraft(value as AssetGroup['role'])} ariaLabel={t.groupType} options={uploadRoles.map((itemRole) => ({ value: itemRole, label: canvasAssetRoleLabel(itemRole, locale) }))} />
            <div className="asset-group-create__actions">
              <button type="button" onClick={() => { setCreatingGroup(false); setGroupNameDraft('') }}>{t.cancel}</button>
              <button type="submit" disabled={!groupNameDraft.trim()}>{t.create(selectedAssetIds.size)}</button>
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
              <input autoFocus value={groupRenameDraft} onChange={(event) => setGroupRenameDraft(event.target.value)} aria-label={t.renameGroup} />
              <div className="asset-group-toolbar__actions">
                <button type="button" onClick={() => setRenamingGroupId(null)}>{t.cancel}</button>
                <button type="submit">{t.save}</button>
              </div>
            </form>
          ) : deleteGroupId === activeGroup.id ? (
            <>
              <strong>{activeGroup.name}</strong>
              <span>{t.assetsRemain}</span>
              <div className="asset-group-toolbar__actions">
                <button type="button" onClick={() => setDeleteGroupId(null)}>{t.cancel}</button>
                <button type="button" className="is-danger" onClick={() => { onDeleteGroup(activeGroup.id); setGroupId('全部'); setDeleteGroupId(null) }}>{t.confirmDelete}</button>
              </div>
            </>
          ) : (
            <>
              <strong>{activeGroup.name}</strong>
              <div className="asset-group-toolbar__actions">
                <button type="button" onClick={() => { setRenamingGroupId(activeGroup.id); setGroupRenameDraft(activeGroup.name) }}>{t.rename}</button>
                <button type="button" className="is-danger" onClick={() => setDeleteGroupId(activeGroup.id)}>{t.deleteGroup}</button>
              </div>
            </>
          )}
        </div>
      ) : null}
      <div className="asset-library__results"><strong>{activeFilterCount || query ? t.filtered : t.allAssets}</strong><span>{t.itemCount(visibleItems.length)}</span></div>
      <div className="asset-grid">
        {visibleItems.length ? visibleItems.map((item) => (
          <article
            className={['asset-card', assetMenuId === item.id ? 'is-menu-open' : '', selectedAssetIds.has(item.id) ? 'is-selected' : '', item.mediaKind === 'video' ? 'asset-card--video' : ''].filter(Boolean).join(' ')}
            key={item.id}
            draggable
            title={t.cardTitle}
            onDragStart={(event) => {
              event.dataTransfer.setData('text/plain', item.id)
              event.dataTransfer.setData('application/x-botanic-asset-id', item.id)
              event.dataTransfer.effectAllowed = 'copy'
            }}
          >
            <div className="asset-card__visual">
              {item.mediaKind === 'video'
                ? <video src={item.image} aria-label={displayAssetName(item)} muted playsInline preload="metadata" />
                : <img src={item.image} alt={displayAssetName(item)} loading="lazy" decoding="async" />}
              <button type="button" className="asset-card__preview-hitbox" onClick={() => setPreviewAssetId(item.id)} aria-label={t.preview(displayAssetName(item))} />
              <button
                type="button"
                className="asset-card__select"
                aria-label={t.select(displayAssetName(item), selectedAssetIds.has(item.id))}
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
                <button type="button" className="asset-card__add" aria-label={t.addToCanvas(displayAssetName(item))} title={t.add} onClick={(event) => { event.stopPropagation(); onAdd(item.id) }}><PlusSquareIcon /></button>
                <div className="asset-card__more-wrap">
                  <button
                    className="asset-card__more"
                    type="button"
                    aria-label={t.more(displayAssetName(item))}
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
            <button type="button" className="asset-card__copy" onClick={() => setPreviewAssetId(item.id)} aria-label={t.preview(displayAssetName(item))}>
              <strong>{displayAssetName(item)}</strong>
              <span>{visibleAssetTags(item.tags).filter((tag) => item.source !== 'generated' || !/^(生成|真实生成|已入库|生成入库)$/i.test(tag)).slice(0, 2).join(' · ')}</span>
            </button>
          </article>
        )) : <p className="asset-empty">{t.empty}</p>}
      </div>
      {assetMenuAsset && assetMenuAnchor && typeof document !== 'undefined' ? createPortal(
        <div
          ref={assetMenuRef}
          className={`asset-card__menu is-${assetMenuAnchor.placement}`}
          role="menu"
          aria-label={t.moreMenu(displayAssetName(assetMenuAsset))}
          style={{ left: assetMenuAnchor.left, top: assetMenuAnchor.top }}
          onClick={(event) => event.stopPropagation()}
        >
          <section className="asset-card__role-section" aria-label={t.setType(assetMenuAsset.name)}>
            <div><span>{t.assetType}</span></div>
            <div className="asset-card__role-options">
              {uploadRoles.map((itemRole) => <button
                type="button"
                key={itemRole}
                aria-pressed={assetMenuAsset.role === itemRole}
                onClick={() => onMoveToRole(assetMenuAsset.id, itemRole)}
              >{canvasAssetRoleLabel(itemRole, locale)}</button>)}
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
          >{t.deleteAsset}</button>
        </div>,
        document.body,
      ) : null}
      {previewPresence.present && visiblePreviewAsset && typeof document !== 'undefined' ? createPortal(
        <div className={`asset-preview-backdrop motion-overlay is-${previewPresence.phase}`} role="presentation" aria-hidden={previewPresence.phase === 'exit' ? true : undefined} onPointerDown={(event) => {
          if (event.target === event.currentTarget) setPreviewAssetId(null)
        }}>
          <section ref={previewDialogRef} className="asset-preview" role="dialog" aria-modal="true" aria-label={t.previewAsset(displayAssetName(visiblePreviewAsset))}>
            <header>
              <div><span>{sourceLabel(visiblePreviewAsset.source)} · {canvasAssetRoleLabel(visiblePreviewAsset.role, locale)}</span><h3>{displayAssetName(visiblePreviewAsset)}</h3></div>
              <button type="button" autoFocus onClick={() => setPreviewAssetId(null)} aria-label={t.closePreview}><CloseIcon /></button>
            </header>
            <div className="asset-preview__image">{visiblePreviewAsset.mediaKind === 'video'
              ? <video src={visiblePreviewAsset.image} aria-label={displayAssetName(visiblePreviewAsset)} controls playsInline preload="metadata" />
              : <img src={visiblePreviewAsset.image} alt={displayAssetName(visiblePreviewAsset)} />}</div>
            <footer>
              <div>
                <span>{visiblePreviewAsset.imageWidth && visiblePreviewAsset.imageHeight ? `${visiblePreviewAsset.imageWidth} × ${visiblePreviewAsset.imageHeight}` : visiblePreviewAsset.mediaKind === 'video' ? t.videoAsset : t.imageAsset}{visiblePreviewAsset.collection ? ` · ${visiblePreviewAsset.collection}` : ''}</span>
                <p>{visibleAssetTags(visiblePreviewAsset.tags).slice(0, 4).join(' · ') || t.noTags}</p>
              </div>
              <div className="asset-preview__actions">
                <button type="button" className="asset-preview__download" onClick={() => void downloadMedia(visiblePreviewAsset.image, visiblePreviewAsset.name, visiblePreviewAsset.mediaKind ?? 'image')}><DownloadIcon />{t.download}</button>
                <button type="button" className="asset-preview__add" onClick={() => { onAdd(visiblePreviewAsset.id); setPreviewAssetId(null) }}><PlusSquareIcon />{t.add}</button>
              </div>
            </footer>
          </section>
        </div>,
        document.body,
      ) : null}
      {selectedAssetIds.size ? (
        <div className="asset-library__batch-bar" role="toolbar" aria-label={t.bulkActions}>
          <strong>{t.selected(selectedAssetIds.size)}</strong>
          <button type="button" onClick={() => {
            selectedAssetIds.forEach((id) => onAdd(id))
            setSelectedAssetIds(new Set())
          }}><PlusSquareIcon />{t.add}</button>
          <BotanicSelect className="asset-batch-group-select" value={batchGroupId} placeholder={t.addGroup} ariaLabel={t.addSelectedGroup} options={[
            ...groups.map((group) => ({ value: group.id, label: group.name })),
            { value: '__create_asset_group__', label: t.createGroupOption },
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
          <button type="button" onClick={() => setSelectedAssetIds(new Set())}>{t.cancel}</button>
        </div>
      ) : null}
    </aside>
  )
}

const templateCopy = {
  'zh-CN': {
    suffix: '模板', refreshError: '团队模板暂时无法更新，当前显示上次同步结果。', workflowSyncError: '生产工作流暂时无法同步，当前显示上次保存的记录。', createError: '项目未创建，请检查网络后重试。', saveWorkflowError: '生产工作流保存失败，请稍后重试。', startWorkflowError: '生产工作流启动失败，请稍后重试。', updateWorkflowError: '生产工作流操作失败，请稍后重试。', templates: '模板', eyebrow: '模板', saveEyebrow: '保存模板', saveCanvas: '保存当前画布为模板', saveHint: '添加素材、文本或生成节点后，即可保存完整工作流设置。', scope: '模板范围', teamTemplates: '团队模板', thisProject: '本项目', production: '生产', updating: '正在更新团队模板…', projectTemplates: '本项目模板', mixedWorkflow: '图片 + 视频', videoWorkflow: '视频工作流', imageWorkflow: '图片工作流', placeholder: '模板', summary: (nodes: number, prompts: number) => `${nodes} 个节点 · ${prompts} 条 Prompt`, creating: '创建中…', createFromTemplate: '从模板创建', noTeam: '还没有团队模板', noProject: '本项目还没有模板', noTeamHint: '将稳定的工作流保存为团队模板，其他项目即可复用。', noProjectHint: '保存当前画布后，可随时从相同 Prompt 和参数开始。', productionWorkflow: '生产工作流', saving: '正在保存…', saveAgent: '保存已验证 Agent 操作', saveFlow: '保存当前生成流程', productionHint: '先在画布上完成一条生成流程（纯文字也可以），再选择来源发布为生产工作流。', sourceLabel: '发布来源', chooseSource: '选择发布来源', sourceTextOnly: '无参考图', sourceResults: (count: number) => `${count} 张`, sourceNoResults: '暂无结果', sourceNotSelected: '请先选择一个发布来源。', sourceMissing: '所选来源节点已不存在，请重新选择。', sourceNotGenerate: '所选节点不是生成节点。', sourcePromptEmpty: '所选生成节点还没有提示词。', sourceRunPending: '来源 Agent 操作尚未完成，完成后即可发布。', legacySource: '来源未记录', legacySourceHint: '该版本发布于来源校验上线之前，重新选择来源并发布新版本即可恢复可追溯。', productionLocalUnavailable: '本地预览模式不连接生产工作流服务；连接云端后可发布和运行。', versionRuns: (version: number, runs: number) => `版本 ${version} · ${runs} 次运行`, notRun: '未运行', processing: '处理中…', runCurrent: '运行当前版本', downloadPackage: '下载交付包', packaging: '正在打包…', packageEmpty: '还没有经人工批准的结果，批准后即可打包交付。', batchTitle: '批量输入', batchHint: '每一行是一次独立生成。留空的字段走工作流版本里的默认值。', batchPasteCsv: '粘贴 CSV', batchPastePlaceholder: 'sku,channel,language\nSKU-1,tmall,zh\nSKU-2,jd,en', batchImport: '导入', batchAddRow: '添加一行', batchRemoveRow: '删除这一行', batchRunCount: (count: number) => `运行 ${count} 项`, batchEmpty: '还没有批量项，先添加一行或粘贴 CSV。', batchColumn: (name: string) => `列 ${name}`, batchRow: (index: number) => `第 ${index} 行`, pause: '暂停', resume: '恢复', cancel: '取消', retryFailed: '重试失败项', locateResult: '定位结果', reviewDelivery: '审核与交付', noProduction: '还没有生产工作流', noProductionHint: '将已验证的 Agent 或画布生成流程保存为不可变版本，之后可批量运行与恢复。', saveAsTemplate: '保存为模板', close: '关闭', templateName: '模板名称', saveScope: '保存范围', projectOnly: '仅本项目', projectOnlyHint: '保留当前素材与完整设置', teamShared: '团队共享', teamSharedHint: '其他项目也可以使用', savedContent: '模板保存内容', willSave: '将保存', savedSummary: (nodes: number, edges: number, prompts: number) => `${nodes} 个节点 · ${edges} 条连线 · ${prompts} 条 Prompt`, privateAssets: (count: number) => `${count} 个项目私有素材不会包含，Prompt 和生成参数仍会保留。`, saveTemplate: '保存模板',
    runStatuses: { queued: '排队中', running: '运行中', paused: '已暂停', succeeded: '已完成', partial: '部分完成', partially_failed: '部分失败', failed: '已失败', cancelled: '已取消' },
  },
  en: {
    suffix: 'Template', refreshError: 'Team templates could not be updated. Showing the last synced results.', workflowSyncError: 'Production workflows could not be synced. Showing the last saved records.', createError: 'The project was not created. Check your connection and try again.', saveWorkflowError: 'The production workflow could not be saved. Try again later.', startWorkflowError: 'The production workflow could not be started. Try again later.', updateWorkflowError: 'The production workflow action failed. Try again later.', templates: 'Templates', eyebrow: 'Templates', saveEyebrow: 'Save template', saveCanvas: 'Save current canvas as template', saveHint: 'Add an asset, text, or generation node to save the complete workflow settings.', scope: 'Template scope', teamTemplates: 'Team templates', thisProject: 'This project', production: 'Production', updating: 'Updating team templates…', projectTemplates: 'Project templates', mixedWorkflow: 'Image + video', videoWorkflow: 'Video workflow', imageWorkflow: 'Image workflow', placeholder: 'Template', summary: (nodes: number, prompts: number) => `${nodes} ${nodes === 1 ? 'node' : 'nodes'} · ${prompts} ${prompts === 1 ? 'Prompt' : 'Prompts'}`, creating: 'Creating…', createFromTemplate: 'Create from template', noTeam: 'No team templates yet', noProject: 'No templates in this project', noTeamHint: 'Save a stable workflow as a team template so other projects can reuse it.', noProjectHint: 'Save the current canvas to restart later with the same prompts and settings.', productionWorkflow: 'Production workflows', saving: 'Saving…', saveAgent: 'Save verified Agent action', saveFlow: 'Save current generation flow', productionHint: 'Complete a generation flow on the canvas — text-only works too — then choose a source to publish.', sourceLabel: 'Publish source', chooseSource: 'Choose publish source', sourceTextOnly: 'no reference', sourceResults: (count: number) => `${count} ${count === 1 ? 'image' : 'images'}`, sourceNoResults: 'No results yet', sourceNotSelected: 'Choose a publish source first.', sourceMissing: 'The selected source node no longer exists. Choose another.', sourceNotGenerate: 'The selected node is not a generation node.', sourcePromptEmpty: 'The selected generation node has no prompt yet.', sourceRunPending: 'The source Agent action has not finished yet.', legacySource: 'Source not recorded', legacySourceHint: 'This version predates source verification. Publish a new version with an explicit source to restore traceability.', productionLocalUnavailable: 'The local preview is not connected to production workflow services. Connect the workspace service to publish and run workflows.', versionRuns: (version: number, runs: number) => `Version ${version} · ${runs} ${runs === 1 ? 'run' : 'runs'}`, notRun: 'Not run', processing: 'Processing…', runCurrent: 'Run current version', downloadPackage: 'Download delivery package', packaging: 'Packaging…', packageEmpty: 'No approved results yet. Approve them to package the delivery.', batchTitle: 'Batch input', batchHint: 'Each row is one separate generation. Empty fields fall back to the workflow version defaults.', batchPasteCsv: 'Paste CSV', batchPastePlaceholder: 'sku,channel,language\nSKU-1,tmall,zh\nSKU-2,jd,en', batchImport: 'Import', batchAddRow: 'Add row', batchRemoveRow: 'Remove this row', batchRunCount: (count: number) => `Run ${count} item(s)`, batchEmpty: 'No batch items yet. Add a row or paste CSV.', batchColumn: (name: string) => `Column ${name}`, batchRow: (index: number) => `Row ${index}`, pause: 'Pause', resume: 'Resume', cancel: 'Cancel', retryFailed: 'Retry failed items', locateResult: 'Locate result', reviewDelivery: 'Review and deliver', noProduction: 'No production workflows yet', noProductionHint: 'Save a verified Agent or canvas generation flow as an immutable version for batch runs and recovery.', saveAsTemplate: 'Save as template', close: 'Close', templateName: 'Template name', saveScope: 'Save scope', projectOnly: 'This project only', projectOnlyHint: 'Keep current assets and all settings', teamShared: 'Share with team', teamSharedHint: 'Available to other projects', savedContent: 'Template contents', willSave: 'Will save', savedSummary: (nodes: number, edges: number, prompts: number) => `${nodes} ${nodes === 1 ? 'node' : 'nodes'} · ${edges} ${edges === 1 ? 'connection' : 'connections'} · ${prompts} ${prompts === 1 ? 'Prompt' : 'Prompts'}`, privateAssets: (count: number) => `${count} private project ${count === 1 ? 'asset is' : 'assets are'} excluded. Prompts and generation settings are kept.`, saveTemplate: 'Save template',
    runStatuses: { queued: 'Queued', running: 'Running', paused: 'Paused', succeeded: 'Complete', partial: 'Partially complete', partially_failed: 'Partially failed', failed: 'Failed', cancelled: 'Cancelled' },
  },
} as const

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
  const { locale } = useProductI18n()
  const t = templateCopy[locale]
  const [activeTab, setActiveTab] = useState<'shared' | 'project' | 'automation'>(sharedTemplates.length ? 'shared' : 'project')
  const [name, setName] = useState(`${currentName} · ${t.suffix}`)
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
  // 批量项按工作流分开存：切换工作流不该把上一个的表格带过去。
  const [batchItems, setBatchItems] = useState<Record<string, WorkflowBatchItem[]>>({})
  const [batchCsv, setBatchCsv] = useState<Record<string, string>>({})
  const [batchNotice, setBatchNotice] = useState<Record<string, string>>({})
  // 能力集合随项目读模型下发（Epic 10）。**隐藏不是鉴权** —— 服务端仍是唯一边界；
  // 这里只是不给用户看他点不动的入口。取不到时保守按只读处理。
  const capabilities = cachedProjectCapabilities(projectId)
  const canModifyWorkflow = canUseProjectEntry(capabilities, 'modifyWorkflow', serverPersistenceEnabled)
  const canSubmitGeneration = canUseProjectEntry(capabilities, 'submitGeneration', serverPersistenceEnabled)
  const [productionError, setProductionError] = useState('')
  const saveDialogPresence = useMotionPresence(saveOpen, 140)
  useRestoreFocus(saveOpen)
  const saveDialogRef = useDialogFocusTrap(saveOpen)
  const saveSummary = scope === 'shared' ? sharedSaveSummary : projectSaveSummary
  const visibleTemplates = activeTab === 'shared' ? sharedTemplates : templates
  const [productionSourceNodeId, setProductionSourceNodeId] = useState('')
  const productionSources = useMemo(() => eligibleProductionWorkflowSources(canvasDocument), [canvasDocument])
  // 来源由用户显式选择；不代为挑选画布上的第一个可用节点。所选节点从画布消失后
  // 回到未选择状态，让用户重新决定，而不是静默换成别的节点。
  const selectedProductionSource = productionSources.some((option) => option.nodeId === productionSourceNodeId)
    ? productionSourceNodeId
    : ''
  const productionDraftResult = useMemo(
    () => productionWorkflowDraftFromCanvas(canvasDocument, selectedProductionSource),
    [canvasDocument, selectedProductionSource],
  )
  const productionDraft = productionDraftResult.ok ? productionDraftResult.draft : undefined
  const productionSourceNotice = productionDraftResult.ok ? '' : ({
    source_not_selected: t.sourceNotSelected,
    node_not_found: t.sourceMissing,
    not_generate_node: t.sourceNotGenerate,
    prompt_empty: t.sourcePromptEmpty,
    run_not_terminal: t.sourceRunPending,
  })[productionDraftResult.reason]

  const refreshProductionWorkflows = async () => {
    if (!serverPersistenceEnabled) {
      setProductionWorkflows(canvasDocument.productionWorkflows ?? [])
      setProductionRuns(canvasDocument.productionWorkflowRuns ?? [])
      return
    }
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
      .catch(() => { if (active) setRefreshError(t.refreshError) })
      .finally(() => { if (active) setRefreshing(false) })
    return () => { active = false }
  }, [onRefresh])

  useEffect(() => {
    let active = true
    if (!serverPersistenceEnabled) return () => { active = false }
    void refreshProductionWorkflows().catch(() => {
      if (active) setProductionError(t.workflowSyncError)
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
    setName(`${currentName} · ${t.suffix}`)
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
    else setCreateError(t.createError)
  }
  const publishAutomation = async () => {
    if (!productionDraft || productionBusy) return
    if (!serverPersistenceEnabled) {
      setProductionError(t.productionLocalUnavailable)
      return
    }
    setProductionBusy('publish')
    setProductionError('')
    try {
      await publishProductionWorkflow({
        projectId,
        id: `production-${productionDraft.source.canvasNodeId}`,
        name: productionDraft.name,
        definition: productionDraft.definition,
        source: productionDraft.source,
      })
      await refreshProductionWorkflows()
      setActiveTab('automation')
    } catch (error) {
      setProductionError(localizeProductError(error, locale, { 'zh-CN': t.saveWorkflowError, en: t.saveWorkflowError }))
    } finally {
      setProductionBusy('')
    }
  }
  const startAutomation = async (workflow: ProductionWorkflow) => {
    if (productionBusy) return
    if (!serverPersistenceEnabled) {
      setProductionError(t.productionLocalUnavailable)
      return
    }
    // 批量项来自用户编辑的表格。一行都没有时退回单项运行 —— 那是「就跑一次当前版本」
    // 的常见意图，不该逼着用户先去填一行空表格。
    const items = batchItems[workflow.id]?.length ? batchItems[workflow.id] : [{}]
    if (!canSubmitWorkflowBatch(items)) {
      // 有重复标识或空行时不提交：提交之后再发现，钱已经花出去了。
      setProductionError(validateWorkflowBatchItems(items)[0]?.detail ?? t.startWorkflowError)
      return
    }
    setProductionBusy(workflow.id)
    setProductionError('')
    try {
      const runId = `run-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`
      await startProductionWorkflowRun({
        projectId,
        workflowId: workflow.id,
        workflowVersion: workflow.currentVersion,
        id: runId,
        // 不再是写死的 item-1：标识由服务端按业务身份派生（Epic 7）。
        items,
      })
      await refreshProductionWorkflows()
    } catch (error) {
      setProductionError(localizeProductError(error, locale, { 'zh-CN': t.startWorkflowError, en: t.startWorkflowError }))
    } finally {
      setProductionBusy('')
    }
  }
  const downloadPackage = async (run: ProductionWorkflowRun) => {
    if (productionBusy) return
    setProductionBusy(`package-${run.id}`)
    setProductionError('')
    try {
      await downloadProductionWorkflowRunPackage(projectId, run.id)
    } catch (error) {
      // 「一个都没批准」是最常见的失败，值得给一句能照做的话，而不是泛化的下载失败。
      const code = (error as { code?: string })?.code
      setProductionError(code === 'DELIVERY_PACKAGE_EMPTY'
        ? t.packageEmpty
        : localizeProductError(error, locale, { 'zh-CN': t.updateWorkflowError, en: t.updateWorkflowError }))
    } finally {
      setProductionBusy('')
    }
  }
  const updateAutomation = async (run: ProductionWorkflowRun, action: 'pause' | 'resume' | 'cancel' | 'retry-failed') => {
    if (productionBusy) return
    if (!serverPersistenceEnabled) {
      setProductionError(t.productionLocalUnavailable)
      return
    }
    setProductionBusy(run.id)
    setProductionError('')
    try {
      const updated = await updateProductionWorkflowRun(projectId, run.id, action)
      setProductionRuns((current) => current.map((item) => item.id === updated.id ? updated : item))
      await refreshProductionWorkflows()
    } catch (error) {
      setProductionError(localizeProductError(error, locale, { 'zh-CN': t.updateWorkflowError, en: t.updateWorkflowError }))
    } finally {
      setProductionBusy('')
    }
  }

  return (
    <aside className="workbench-panel template-panel" aria-label={t.templates}>
      <PanelHeader eyebrow={t.eyebrow} title={t.templates} onClose={onClose} />
      <button type="button" className="template-save-trigger" disabled={!projectSaveSummary.canSave} onClick={openSaveDialog}>
        <PlusSquareIcon />{t.saveCanvas}
      </button>
      {!projectSaveSummary.canSave ? <p className="panel-note">{t.saveHint}</p> : null}
      <div className="template-tabs" role="tablist" aria-label={t.scope}>
        <button type="button" role="tab" aria-selected={activeTab === 'shared'} className={activeTab === 'shared' ? 'is-active' : ''} onClick={() => setActiveTab('shared')}>{t.teamTemplates} <span>{sharedTemplates.length}</span></button>
        <button type="button" role="tab" aria-selected={activeTab === 'project'} className={activeTab === 'project' ? 'is-active' : ''} onClick={() => setActiveTab('project')}>{t.thisProject} <span>{templates.length}</span></button>
        <button type="button" role="tab" aria-selected={activeTab === 'automation'} className={activeTab === 'automation' ? 'is-active' : ''} onClick={() => setActiveTab('automation')}>{t.production} <span>{productionWorkflows.length}</span></button>
      </div>
      {refreshing && activeTab === 'shared' ? <p className="template-sync-state" role="status">{t.updating}</p> : null}
      {refreshError && activeTab === 'shared' ? <p className="template-sync-state is-error">{refreshError}</p> : null}
      {createError ? <p className="template-sync-state is-error" role="alert">{createError}</p> : null}
      {productionError ? <p className="template-sync-state is-error" role="alert">{productionError}</p> : null}
      {activeTab !== 'automation' ? <section className="template-section" aria-label={activeTab === 'shared' ? t.teamTemplates : t.projectTemplates}>
        <div className="template-list">
          {visibleTemplates.map((template) => {
            const summary = summarizeWorkflowTemplate(template.snapshot.nodes, template.snapshot.edges)
            const workflowKind = summary.videoWorkflowCount && summary.imageWorkflowCount
              ? t.mixedWorkflow
              : summary.videoWorkflowCount ? t.videoWorkflow : t.imageWorkflow
            return (
              <article className="template-card" key={template.id}>
                {template.image ? <img src={template.image} alt="" /> : <div className="template-card__placeholder" aria-hidden="true">{t.placeholder}</div>}
                <div>
                  <strong>{template.name}</strong>
                  <span>{workflowKind} · {t.summary(summary.nodeCount, summary.promptCount)}</span>
                  {summary.settings[0] ? <small>{summary.settings[0]}</small> : null}
                  <button type="button" onClick={() => void createFromTemplate(template.id)} disabled={Boolean(creatingTemplateId)}>{creatingTemplateId === template.id ? t.creating : t.createFromTemplate}</button>
                </div>
              </article>
            )
          })}
          {!visibleTemplates.length && !refreshing ? <div className="template-empty"><strong>{activeTab === 'shared' ? t.noTeam : t.noProject}</strong><span>{activeTab === 'shared' ? t.noTeamHint : t.noProjectHint}</span></div> : null}
        </div>
      </section> : (
        <section className="template-section production-workflow-section" aria-label={t.productionWorkflow}>
          {productionSources.length ? (
            <label className="production-workflow-source">
              <span>{t.sourceLabel}</span>
              <BotanicSelect
                value={selectedProductionSource}
                ariaLabel={t.chooseSource}
                placeholder={t.chooseSource}
                options={productionSources.map((option) => ({
                  value: option.nodeId,
                  label: `${option.label}${option.hasReferences ? '' : ` · ${t.sourceTextOnly}`} · ${option.resultCount ? t.sourceResults(option.resultCount) : t.sourceNoResults}`,
                }))}
                onChange={setProductionSourceNodeId}
              />
            </label>
          ) : null}
          {canModifyWorkflow ? <button type="button" className="production-workflow-publish" disabled={!productionDraft || Boolean(productionBusy)} onClick={() => void publishAutomation()}>
            <PlusSquareIcon />{productionBusy === 'publish' ? t.saving : productionDraft?.sourceAgentRunId ? t.saveAgent : t.saveFlow}
          </button> : null}
          {isReadOnlyProject(capabilities, serverPersistenceEnabled)
            ? <p className="panel-note is-readonly">{readOnlyProjectNotice(locale)}</p>
            : !productionSources.length
            ? <p className="panel-note">{t.productionHint}</p>
            : productionSourceNotice ? <p className="panel-note">{productionSourceNotice}</p> : null}
          <div className="production-workflow-list">
            {productionWorkflows.map((workflow) => {
              const runs = productionRuns.filter((run) => run.workflowId === workflow.id)
              const latestRun = runs[0]
              const resultNodeId = latestRun?.items.flatMap((item) => item.canvasNodeIds ?? [])[0]
              const hasFailed = latestRun?.items.some((item) => item.status === 'failed')
              return <article className="production-workflow-card" key={workflow.id}>
                <header><div><strong>{workflow.name}</strong><span>{t.versionRuns(workflow.currentVersion, runs.length)}</span>{workflow.versions.at(-1)?.provenance === 'legacy_unverified' ? <span className="production-workflow-legacy" title={t.legacySourceHint}>{t.legacySource}</span> : null}</div><em>{latestRun ? t.runStatuses[latestRun.status] : t.notRun}</em></header>
                <p>{workflow.versions.at(-1)?.definition.prompt}</p>
                <small>{workflow.versions.at(-1)?.definition.model} · {String(workflow.versions.at(-1)?.definition.output?.aspectRatio ?? '')} · {String(workflow.versions.at(-1)?.definition.output?.resolution ?? '')}</small>
                {(() => {
                  const items = batchItems[workflow.id] ?? []
                  const columns = workflowBatchColumns(items)
                  const issues = validateWorkflowBatchItems(items)
                  const issueByRow = new Map(issues.map((issue) => [issue.index, issue]))
                  const setItems = (next: WorkflowBatchItem[]) => setBatchItems((current) => ({ ...current, [workflow.id]: next }))
                  return <details className="production-batch">
                    <summary>{t.batchTitle}{items.length ? ` · ${items.length}` : ''}</summary>
                    <p className="production-batch__hint">{t.batchHint}</p>
                    <div className="production-batch__import">
                      <textarea
                        value={batchCsv[workflow.id] ?? ''}
                        placeholder={t.batchPastePlaceholder}
                        aria-label={t.batchPasteCsv}
                        onChange={(event) => setBatchCsv((current) => ({ ...current, [workflow.id]: event.target.value }))}
                      />
                      <button type="button" onClick={() => {
                        const parsed = parseWorkflowBatchCsv(batchCsv[workflow.id] ?? '')
                        setItems(parsed.items)
                        // 导入摘要必须与成功数并列展示：只报「导入了几行」会让用户
                        // 以为剩下的行也进去了。
                        setBatchNotice((current) => ({ ...current, [workflow.id]: workflowBatchImportSummary(parsed, locale) }))
                      }}>{t.batchImport}</button>
                    </div>
                    {batchNotice[workflow.id] ? <p className="production-batch__notice">{batchNotice[workflow.id]}</p> : null}
                    {items.length ? <div className="production-batch__table-wrap">
                      <table className="production-batch__table">
                        <thead><tr>
                          <th scope="col">#</th>
                          {columns.fields.map((field) => <th key={field} scope="col">{field}</th>)}
                          {columns.variables.map((name) => <th key={name} scope="col">{name}</th>)}
                          <th scope="col" aria-label={t.batchRemoveRow} />
                        </tr></thead>
                        <tbody>
                          {items.map((item, index) => <tr key={index} className={issueByRow.has(index) ? 'is-invalid' : ''}>
                            <th scope="row">{index + 1}</th>
                            {columns.fields.map((field) => <td key={field}>
                              <input
                                value={item[field] ?? ''}
                                aria-label={`${t.batchRow(index + 1)} ${t.batchColumn(field)}`}
                                onChange={(event) => setItems(updateWorkflowBatchCell(items, index, { kind: 'field', name: field as WorkflowBatchField }, event.target.value))}
                              />
                            </td>)}
                            {columns.variables.map((name) => <td key={name}>
                              <input
                                value={item.variables?.[name] ?? ''}
                                aria-label={`${t.batchRow(index + 1)} ${t.batchColumn(name)}`}
                                onChange={(event) => setItems(updateWorkflowBatchCell(items, index, { kind: 'variable', name }, event.target.value))}
                              />
                            </td>)}
                            <td><button type="button" aria-label={t.batchRemoveRow} onClick={() => setItems(removeWorkflowBatchRow(items, index))}>×</button></td>
                          </tr>)}
                        </tbody>
                      </table>
                    </div> : <p className="production-batch__empty">{t.batchEmpty}</p>}
                    {/* 逐行给出原因，而不是只在提交时弹一句「有错」—— 用户要知道是哪一行。 */}
                    {issues.map((issue) => <p key={issue.index} className="production-batch__issue">{t.batchRow(issue.index + 1)}：{issue.detail}</p>)}
                    <button type="button" onClick={() => setItems(addWorkflowBatchRow(items))}>{t.batchAddRow}</button>
                  </details>
                })()}
                <footer>
                  {canSubmitGeneration ? <button type="button" disabled={Boolean(productionBusy) || Boolean(batchItems[workflow.id]?.length && !canSubmitWorkflowBatch(batchItems[workflow.id]))} onClick={() => void startAutomation(workflow)}>{productionBusy === workflow.id
                    ? t.processing
                    : batchItems[workflow.id]?.length ? t.batchRunCount(batchItems[workflow.id].length) : t.runCurrent}</button> : null}
                  {latestRun?.status === 'running' ? <button type="button" onClick={() => void updateAutomation(latestRun, 'pause')}>{t.pause}</button> : null}
                  {latestRun?.status === 'paused' ? <button type="button" onClick={() => void updateAutomation(latestRun, 'resume')}>{t.resume}</button> : null}
                  {latestRun && ['queued', 'running', 'paused'].includes(latestRun.status) ? <button type="button" onClick={() => void updateAutomation(latestRun, 'cancel')}>{t.cancel}</button> : null}
                  {hasFailed && canSubmitGeneration ? <button type="button" onClick={() => void updateAutomation(latestRun, 'retry-failed')}>{t.retryFailed}</button> : null}
                  {resultNodeId ? <button type="button" onClick={() => onLocateWorkflowNode(resultNodeId)}>{t.locateResult}</button> : null}
                  {latestRun?.items.some((item) => item.artifactIds?.length) ? <button type="button" onClick={onOpenHistory}>{t.reviewDelivery}</button> : null}
                  {latestRun?.items.some((item) => item.artifactIds?.length) ? <button type="button" disabled={productionBusy === `package-${latestRun.id}`} onClick={() => void downloadPackage(latestRun)}>{productionBusy === `package-${latestRun.id}` ? t.packaging : t.downloadPackage}</button> : null}
                </footer>
              </article>
            })}
            {!productionWorkflows.length ? <div className="template-empty"><strong>{t.noProduction}</strong><span>{t.noProductionHint}</span></div> : null}
          </div>
        </section>
      )}
      {saveDialogPresence.present && typeof document !== 'undefined' ? createPortal(
        <div className={`template-dialog-backdrop motion-overlay is-${saveDialogPresence.phase}`} role="presentation" aria-hidden={saveDialogPresence.phase === 'exit' ? true : undefined} onMouseDown={() => !saving && setSaveOpen(false)}>
          <form ref={(element) => { saveDialogRef.current = element }} className="template-dialog" role="dialog" aria-modal="true" aria-labelledby="save-template-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void saveTemplate() }}>
            <header><div><span className="panel-eyebrow">{t.saveEyebrow}</span><h2 id="save-template-title">{t.saveAsTemplate}</h2></div><button type="button" onClick={() => setSaveOpen(false)} disabled={saving} aria-label={t.close}><CloseIcon /></button></header>
            <label htmlFor="template-name">{t.templateName}</label>
            <input id="template-name" autoFocus value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />
            <fieldset>
              <legend>{t.saveScope}</legend>
              <div className="template-dialog__scope">
                <button type="button" className={scope === 'project' ? 'is-active' : ''} aria-pressed={scope === 'project'} onClick={() => setScope('project')}><strong>{t.projectOnly}</strong><span>{t.projectOnlyHint}</span></button>
                <button type="button" className={scope === 'shared' ? 'is-active' : ''} aria-pressed={scope === 'shared'} onClick={() => setScope('shared')}><strong>{t.teamShared}</strong><span>{t.teamSharedHint}</span></button>
              </div>
            </fieldset>
            <section className="template-dialog__summary" aria-label={t.savedContent}>
              <strong>{t.willSave}</strong>
              <p>{t.savedSummary(saveSummary.nodeCount, saveSummary.edgeCount, saveSummary.promptCount)}</p>
              {saveSummary.settings.length ? <small>{saveSummary.settings.slice(0, 2).join(' / ')}</small> : null}
              {scope === 'shared' && sharedSaveSummary.privateAssetCount ? <em>{t.privateAssets(sharedSaveSummary.privateAssetCount)}</em> : null}
            </section>
            <footer><button type="button" onClick={() => setSaveOpen(false)} disabled={saving}>{t.cancel}</button><button type="submit" className="is-primary" disabled={saving || !name.trim() || !saveSummary.canSave}>{saving ? t.saving : t.saveTemplate}</button></footer>
          </form>
        </div>,
        document.body,
      ) : null}
    </aside>
  )
}

const historyCopy = {
  'zh-CN': { groups: { today: '今天', yesterday: '昨天', earlier: '更早', archive: '历史记录' }, history: '画布历史', filter: '筛选历史类型', all: '全部', images: '图片', videos: '视频', preview: (name: string) => `预览 ${name}`, latest: '最新', locate: (name: string) => `在画布定位 ${name}`, locateTitle: '在画布定位', locateShort: '定位', download: (name: string) => `下载 ${name}`, downloadTitle: '下载原媒体', savedLabel: (name: string) => `${name} 已入库`, saveLabel: (name: string) => `将 ${name} 入库`, saved: '已入库', saveTitle: '存入素材库', save: '入库', emptyFiltered: (video: boolean) => `暂无${video ? '视频' : '图片'}`, empty: '暂无生成内容', switchType: '切换类型查看其他历史内容。', emptyHint: '完成图片或视频生成后，结果会出现在这里。' },
  en: { groups: { today: 'Today', yesterday: 'Yesterday', earlier: 'Earlier', archive: 'Archive' }, history: 'Canvas history', filter: 'Filter history by type', all: 'All', images: 'Images', videos: 'Videos', preview: (name: string) => `Preview ${name}`, latest: 'Latest', locate: (name: string) => `Locate ${name} on canvas`, locateTitle: 'Locate on canvas', locateShort: 'Locate', download: (name: string) => `Download ${name}`, downloadTitle: 'Download original media', savedLabel: (name: string) => `${name} saved`, saveLabel: (name: string) => `Save ${name} to library`, saved: 'Saved', saveTitle: 'Save to asset library', save: 'Save', emptyFiltered: (video: boolean) => `No ${video ? 'videos' : 'images'}`, empty: 'No generated content', switchType: 'Switch type to view other history.', emptyHint: 'Generated images and videos will appear here.' },
} as const

function historyItemMeta(item: GeneratedHistoryItem, locale: 'zh-CN' | 'en') {
  return [
    item.aspectRatio,
    item.resolution,
    item.mediaKind === 'video' && item.duration ? canvasDurationLabel(item.duration, locale) : undefined,
  ].filter(Boolean).join(' · ')
}

function historyItemTime(createdAt: number, locale: 'zh-CN' | 'en') {
  if (!createdAt) return ''
  const date = new Date(createdAt)
  const today = new Date()
  if (date.toDateString() === today.toDateString()) {
    return formatProductDateTime(date, locale, { hour: '2-digit', minute: '2-digit', hour12: false })
  }
  return formatProductDateTime(date, locale, { month: 'numeric', day: 'numeric' })
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
  const { locale } = useProductI18n()
  const t = historyCopy[locale]
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
    <aside className="workbench-panel history-panel" aria-label={t.history}>
      <PanelHeader title={t.history} onClose={onClose} />
      <div className="history-filters" role="tablist" aria-label={t.filter}>
        <button type="button" role="tab" aria-selected={filter === 'all'} className={filter === 'all' ? 'is-active' : ''} onClick={() => setFilter('all')}>{t.all} <span>{results.length}</span></button>
        <button type="button" role="tab" aria-selected={filter === 'image'} className={filter === 'image' ? 'is-active' : ''} onClick={() => setFilter('image')}>{t.images} <span>{imageCount}</span></button>
        <button type="button" role="tab" aria-selected={filter === 'video'} className={filter === 'video' ? 'is-active' : ''} onClick={() => setFilter('video')}>{t.videos} <span>{videoCount}</span></button>
      </div>
      {visibleResults.length ? <div className="history-groups">
        {groupedResults.map(({ group, items }) => <section className="history-group" key={group} aria-labelledby={`history-group-${group}`}>
          <header><strong id={`history-group-${group}`}>{t.groups[group]}</strong><span>{items.length}</span></header>
          <div className="history-gallery">
        {items.map((item) => {
          const saved = isSaved(item)
          const metadata = historyItemMeta(item, locale)
          const timestamp = historyItemTime(item.createdAt, locale)
          return <article className={`history-gallery__item history-gallery__item--${item.mediaKind}`} key={item.id}>
            <button type="button" className="history-gallery__open" onClick={() => onPreview(item)} aria-label={t.preview(item.name)} title={t.preview(item.name)}>
              {item.mediaKind === 'video'
                ? <video src={item.image} aria-hidden="true" muted playsInline preload="metadata" />
                : <img src={item.image} alt="" />}
              {item.mediaKind === 'video' ? <><span className="history-gallery__type">{t.videos}</span><span className="history-gallery__play" aria-hidden="true">▶</span>{item.duration ? <span className="history-gallery__duration">{canvasDurationLabel(item.duration, locale)}</span> : null}</> : null}
              {item.id === latestVisibleId ? <span className={`history-gallery__latest${item.mediaKind === 'video' ? ' is-video' : ''}`}>{t.latest}</span> : null}
            </button>
            <div className="history-gallery__copy">
              <strong title={item.name}>{item.name}</strong>
              <span>{metadata || (item.mediaKind === 'video' ? t.videos : t.images)}{timestamp ? ` · ${timestamp}` : ''}</span>
            </div>
            <footer className="history-gallery__actions">
              {item.nodeId ? <button type="button" onClick={() => onLocate(item)} aria-label={t.locate(item.name)} title={t.locateTitle}><FocusIcon /><span>{t.locateShort}</span></button> : <span />}
              <button type="button" aria-label={t.download(item.name)} title={t.downloadTitle} onClick={() => void downloadMedia(item.image, item.name, item.mediaKind)}><DownloadIcon /></button>
              <button type="button" className={saved ? 'is-saved' : ''} disabled={saved} aria-label={saved ? t.savedLabel(item.name) : t.saveLabel(item.name)} title={saved ? t.saved : t.saveTitle} onClick={() => onSaveToLibrary(item)}>{saved ? t.saved : t.save}</button>
            </footer>
          </article>
        })}
          </div>
        </section>)}
      </div> : <div className="template-empty history-empty"><strong>{results.length ? t.emptyFiltered(filter === 'video') : t.empty}</strong><span>{results.length ? t.switchType : t.emptyHint}</span></div>}
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

const generationPanelCopy = {
  'zh-CN': {
    nodeInputsEyebrow: '节点输入', referenceInput: (name: string) => `${name}的参考输入`, referenceTitle: (name: string, count: number) => `${name} · ${count} 个参考`, referenceHint: '选择要连入当前节点的素材；主商品决定生成主体。', availableAssets: '可连接的画布素材', toggleReference: (connected: boolean, asset: string, node: string) => `${connected ? '断开' : '连接'} ${asset} 到 ${node}`, connected: '已连入节点', limit: (count: number) => `最多 ${count} 张`, connect: '连接到节点', primary: '主商品', setPrimary: '设为主商品', emptyReferences: '先把素材加入画布，才能连接到此节点',
    recovering: '正在确认任务，请勿重复提交', uploading: '正在上传画布参考素材', queued: '生成服务已接收任务，正在排队', running: '生成服务正在处理', candidatesAria: '生成结果', needsAttention: '生成需要处理', generationEyebrow: '生成结果', refinementEyebrow: '精修结果', candidateTitle: (refinement: boolean, count: string | number) => `${refinement ? '精修' : '首图'} · ${count}`, refinementHint: '结果会继承父版本参数；选择后写入同一条“素材/文本 → 生成 → 结果”图谱，并可在历史中一键回退。', selectedReferencesHint: (names: string) => `这次生成以已选参考「${names}」为依据，并固定主商品。`, selectKeyVisualHint: '选择一张首图会写入结果节点、生成版本分支，并进入素材库的“生成入库”。', recipe: '生成参数', primaryName: (name: string) => `主商品 · ${name}`, inheritParent: '继承父版本', referenceCount: (count: number) => `${count} 个参考`, generatingAria: (count: number) => `正在生成 ${count} 张`, targetCount: (count: number) => `目标 ${count} 张`, cancelGeneration: '取消生成', errorFallback: '生成失败，请重试。', retry: '重试', partial: (ready: number, missing: number) => `已有 ${ready} 张可用，缺少 ${missing} 张。`, fillMissing: (count: number) => `补生成 ${count} 张`, compare: '父版本与精修对比', parentVersion: '父版本', selectedKeyVisual: '已选首图', emptyCandidates: '先在下方输入描述并发起生成', refinedFrom: (name: string) => `精修自 ${name}`, unlocked: '未锁定',
  },
  en: {
    nodeInputsEyebrow: 'Node inputs', referenceInput: (name: string) => `Reference inputs for ${name}`, referenceTitle: (name: string, count: number) => `${name} · ${count} ${count === 1 ? 'reference' : 'references'}`, referenceHint: 'Choose assets to connect to this node. The primary product determines the generated subject.', availableAssets: 'Available canvas assets', toggleReference: (connected: boolean, asset: string, node: string) => `${connected ? 'Disconnect' : 'Connect'} ${asset} ${connected ? 'from' : 'to'} ${node}`, connected: 'Connected to node', limit: (count: number) => `${count} maximum`, connect: 'Connect to node', primary: 'Primary product', setPrimary: 'Set as primary product', emptyReferences: 'Add assets to the canvas before connecting them to this node.',
    recovering: 'Confirming task. Do not submit again.', uploading: 'Uploading canvas reference assets', queued: 'The generation service received the task and queued it', running: 'The generation service is processing', candidatesAria: 'Generation results', needsAttention: 'Generation needs attention', generationEyebrow: 'Generation', refinementEyebrow: 'Refinement', candidateTitle: (refinement: boolean, count: string | number) => `${refinement ? 'Refinement' : 'Key visual'} · ${count}`, refinementHint: 'Results inherit the parent settings. Selecting one writes it to the same asset/text → generation → result graph and keeps it available in history.', selectedReferencesHint: (names: string) => `The task uses the selected references ${names} and locks the primary product.`, selectKeyVisualHint: 'Selecting a key visual writes a result node and version branch, then saves it to generated assets.', recipe: 'Generation settings', primaryName: (name: string) => `Primary product · ${name}`, inheritParent: 'Inherited from parent', referenceCount: (count: number) => `${count} ${count === 1 ? 'reference' : 'references'}`, generatingAria: (count: number) => `Generating ${count} ${count === 1 ? 'image' : 'images'}`, targetCount: (count: number) => `Target: ${count}`, cancelGeneration: 'Cancel generation', errorFallback: 'Generation failed. Try again.', retry: 'Retry', partial: (ready: number, missing: number) => `${ready} available, ${missing} missing.`, fillMissing: (count: number) => `Generate ${count} missing`, compare: 'Compare parent and refinement', parentVersion: 'Parent version', selectedKeyVisual: 'Selected key visual', emptyCandidates: 'Enter a description below and start generation.', refinedFrom: (name: string) => `Refined from ${name}`, unlocked: 'Not locked',
  },
} as const


export function NodeReferencePanel({
  node,
  references,
  connectedNodeIds,
  maximumReferences,
  disabled,
  onToggle,
  onSetPrimary,
  onClose,
}: {
  node: { id: string; data: GenerateNodeData }
  references: CanvasReferenceControl[]
  connectedNodeIds: Set<string>
  maximumReferences?: number
  disabled: boolean
  onToggle: (assetNodeId: string, enabled: boolean) => void
  onSetPrimary: (assetNodeId: string) => void
  onClose: () => void
}) {
  const { locale } = useProductI18n()
  const t = useProductMessages(generationPanelCopy)
  const connectedReferences = references
    .filter((reference) => connectedNodeIds.has(reference.nodeId))
    .sort((left, right) => {
      const leftIndex = node.data.inputOrder?.indexOf(left.nodeId) ?? -1
      const rightIndex = node.data.inputOrder?.indexOf(right.nodeId) ?? -1
      return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex)
    })
  const primary = connectedReferences.find((reference) => reference.nodeId === node.data.primaryInputId)
  const referenceLimit = maximumReferencesForModel({ maximumReferences })
  const atLimit = connectedReferences.length >= referenceLimit
  const nodeLabel = canvasSystemLabel(node.data.label, locale)
  return (
    <aside className="workbench-panel reference-panel node-reference-panel" aria-label={t.referenceInput(nodeLabel)}>
      <PanelHeader eyebrow={t.nodeInputsEyebrow} title={t.referenceTitle(nodeLabel, connectedReferences.length)} onClose={onClose} />
      <p className="panel-note">{t.referenceHint}</p>

      <div className="reference-list" aria-label={t.availableAssets}>
        {references.length ? references.map((reference) => {
          const connected = connectedNodeIds.has(reference.nodeId)
          const isPrimary = connected && reference.nodeId === primary?.nodeId
          return (
            <article className={['reference-item', connected ? '' : 'is-off', isPrimary ? 'is-primary' : ''].filter(Boolean).join(' ')} key={reference.nodeId}>
              <img src={reference.image} alt={reference.name} />
              <div className="reference-item__copy">
                <span>{canvasAssetRoleLabel(reference.role, locale)}</span>
                <strong>{reference.name}</strong>
              </div>
              <div className="reference-item__actions">
                <label className="reference-toggle">
                  <input
                    type="checkbox"
                    checked={connected}
                    disabled={disabled || (!connected && atLimit)}
                    onChange={(event) => onToggle(reference.nodeId, event.target.checked)}
                    aria-label={t.toggleReference(connected, reference.name, nodeLabel)}
                  />
                  <span>{connected ? t.connected : atLimit ? t.limit(referenceLimit) : t.connect}</span>
                </label>
                {connected && reference.role === '商品' ? (
                  isPrimary
                    ? <span className="reference-role is-primary">{t.primary}</span>
                    : <button type="button" disabled={disabled} onClick={() => onSetPrimary(reference.nodeId)}>{t.setPrimary}</button>
                ) : null}
              </div>
            </article>
          )
        }) : <p className="asset-empty">{t.emptyReferences}</p>}
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
  const { locale } = useProductI18n()
  const t = useProductMessages(generationPanelCopy)
  const isInFlight = status === 'uploading' || status === 'queued' || status === 'running' || status === 'recovering'
  const statusMessage = status === 'recovering'
    ? t.recovering
    : status === 'uploading'
    ? t.uploading
    : status === 'queued'
      ? t.queued
      : t.running
  const isRefinement = kind === 'refinement' || candidates[0]?.kind === 'refinement'
  const parent = candidates.find((candidate) => candidate.kind === 'refinement' && candidate.parentImage)
  const sourceAssetNames = candidates[0]?.sourceAssetNames ?? []
  const recipe = candidates[0]?.recipe
  const primaryReference = primaryReferenceFromRecipe(recipe)
  const isPartial = status === 'idle' && pendingCount > candidates.length
  return (
    <aside className="workbench-panel generation-panel" aria-label={t.candidatesAria}>
      <PanelHeader eyebrow={isRefinement ? t.refinementEyebrow : t.generationEyebrow} title={isInFlight ? statusMessage : status === 'error' ? t.needsAttention : t.candidateTitle(isRefinement, isPartial ? `${candidates.length}/${pendingCount}` : candidates.length)} onClose={onClose} />
      <p className="panel-note">{isRefinement ? t.refinementHint : sourceAssetNames.length ? t.selectedReferencesHint(sourceAssetNames.join(locale === 'en' ? ', ' : '、')) : t.selectKeyVisualHint}</p>
      {recipe ? <div className="candidate-recipe" aria-label={t.recipe}><strong>{primaryReference ? t.primaryName(primaryReference.name) : t.inheritParent}</strong><span>{t.referenceCount(recipe.references.length)} · {recipe.settings.aspectRatio} / {recipe.settings.resolution}</span></div> : null}
      {isInFlight ? (
        <div className="generation-progress" role="status" aria-label={t.generatingAria(pendingCount)}>
          <div><span className="is-indeterminate" /></div>
          <span>{statusMessage} · {t.targetCount(pendingCount)}</span>
          <button onClick={onCancel}>{t.cancelGeneration}</button>
        </div>
      ) : null}
      {status === 'error' ? (
        <div className="generation-error" role="alert">
          <span>{error ? localizeProductError(new Error(error), locale, { 'zh-CN': error, en: t.errorFallback }) : t.errorFallback}</span>
          <button onClick={onRetry}>{t.retry}</button>
        </div>
      ) : null}
      {isPartial ? (
        <div className="generation-partial" role="status">
          <span>{t.partial(candidates.length, pendingCount - candidates.length)}</span>
          <button onClick={onRetry}>{t.fillMissing(pendingCount - candidates.length)}</button>
        </div>
      ) : null}
      {parent ? (
        <section className="version-compare" aria-label={t.compare}>
          <img src={parent.parentImage} alt={parent.parentLabel ?? t.parentVersion} />
          <div>
            <span>{t.parentVersion}</span>
            <strong>{parent.parentLabel ?? t.selectedKeyVisual}</strong>
            <p>{parent.refinementInstruction}</p>
          </div>
        </section>
      ) : null}
      <div className="candidate-grid">
        {isInFlight ? Array.from({ length: Math.max(1, pendingCount) }, (_, index) => <div className="candidate-skeleton" key={index} />) : null}
        {status === 'idle' && candidates.length === 0 ? <p className="asset-empty">{t.emptyCandidates}</p> : null}
        {status === 'idle' ? candidates.map((candidate) => (
          <article className={`${candidate.selected ? 'candidate-card is-selected' : 'candidate-card'} candidate-card--ratio-${candidate.settings.aspectRatio.replace(':', '-')}`} key={candidate.id}>
            {candidate.mediaKind === 'video'
              ? <video src={candidate.image} aria-label={candidate.name} controls playsInline preload="metadata" />
              : <img src={candidate.image} alt={candidate.name} />}
            <button type="button" className="candidate-card__select" onClick={() => onSelect(candidate.id)} aria-pressed={candidate.selected}>
              <span>{candidate.name}</span>
              <small>{candidate.kind === 'refinement' ? t.refinedFrom(candidate.parentLabel ?? t.selectedKeyVisual) : t.primaryName(primaryReferenceFromRecipe(candidate.recipe)?.name ?? t.unlocked)} · {t.referenceCount(candidate.recipe.references.length)}</small>
            </button>
          </article>
        )) : null}
      </div>
    </aside>
  )
}

const deliveryCopy = {
  'zh-CN': {
    title: '投放交付', eyebrow: '投放交付', removeAssetEyebrow: '移除素材', currentKeyVisual: '当前首图', savedVersion: '已保存的画布版本', currentCanvas: '来自当前画布', change: '更换', videoBlocked: '视频暂不支持图片投放交付', videoBlockedHint: '请选择一张生成图片，视频交付将在独立流程中处理。', chooseImage: '选择图片', emptyHint: '请选择一张生成图片开始投放交付。', chooseAsset: '选择交付素材', recentImages: '最近生成图片', imageCount: (count: number) => `${count} 张`, noImages: '暂无可用于交付的生成图片。', specs: '投放规格', livePreview: '实时预览', previewHint: '边调边看', previewChannels: '预览渠道', safeZone: '安全区', selectSpec: '至少选择一个投放规格。', copyLayout: '文案与版式', optional: '可选', mainTitle: '主标题', mainTitlePlaceholder: '输入投放主标题', subtitle: '副标题', subtitlePlaceholder: '输入补充卖点', showSafeZone: '显示安全区辅助线', safeZoneHint: '仅用于预览定位，导出文件不包含辅助线', packaging: '正在打包…', export: (count: number) => `导出 ${count || ''} 个规格`, localOnly: '本地裁切并打包，不会直接发布到平台。', downloaded: (count: number) => `已下载 ZIP：${count} 个文件（含 manifest）`, exportError: '导出失败，请重试。', closePanel: (title: string) => `关闭${title}`, deleteTitle: (name: string) => `删除「${name}」？`, deleteShared: '这会从共享品牌素材库下架，并同步移除所有项目画布、模板与历史配方中的引用。', deleteProject: '这会同步移除当前画布及模板中的引用；历史画布仍会保留为版本记录。', cancel: '取消', confirmDelete: '确认删除', undo: '撤销', channels: { taobao: '淘宝', xiaohongshu: '小红书', douyin: '抖音' },
  },
  en: {
    title: 'Delivery kit', eyebrow: 'Delivery', removeAssetEyebrow: 'Remove asset', currentKeyVisual: 'Current key visual', savedVersion: 'Saved canvas version', currentCanvas: 'From current canvas', change: 'Change', videoBlocked: 'Image delivery is not available for video', videoBlockedHint: 'Choose a generated image. Video delivery is handled in a separate workflow.', chooseImage: 'Choose image', emptyHint: 'Choose a generated image to start delivery.', chooseAsset: 'Choose delivery asset', recentImages: 'Recent generated images', imageCount: (count: number) => `${count} ${count === 1 ? 'image' : 'images'}`, noImages: 'No generated images are available for delivery.', specs: 'Delivery specs', livePreview: 'Live preview', previewHint: 'Updates as you edit', previewChannels: 'Preview channels', safeZone: 'Safe zone', selectSpec: 'Select at least one delivery spec.', copyLayout: 'Copy and layout', optional: 'Optional', mainTitle: 'Headline', mainTitlePlaceholder: 'Enter the campaign headline', subtitle: 'Subheadline', subtitlePlaceholder: 'Add a supporting benefit', showSafeZone: 'Show safe-zone guides', safeZoneHint: 'Guides are for preview only and are not included in exported files', packaging: 'Packaging…', export: (count: number) => `Export ${count || ''} ${count === 1 ? 'spec' : 'specs'}`, localOnly: 'Cropped and packaged locally. Nothing is published directly.', downloaded: (count: number) => `ZIP downloaded: ${count} ${count === 1 ? 'file' : 'files'} including manifest`, exportError: 'Export failed. Try again.', closePanel: (title: string) => `Close ${title}`, deleteTitle: (name: string) => `Delete “${name}”?`, deleteShared: 'This removes the asset from the shared brand library and all references in project canvases, templates, and historical recipes.', deleteProject: 'This removes references from the current canvas and templates. Historical canvas versions remain available.', cancel: 'Cancel', confirmDelete: 'Delete asset', undo: 'Undo', channels: { taobao: 'Taobao', xiaohongshu: 'Xiaohongshu', douyin: 'Douyin' },
  },
} as const

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
  const { locale } = useProductI18n()
  const t = deliveryCopy[locale]
  const [selectedPresets, setSelectedPresets] = useState<DeliveryPresetId[]>(() => deliveryPresets.map((preset) => preset.id))
  const [activePreviewPreset, setActivePreviewPreset] = useState<DeliveryPresetId>('taobao')
  const [title, setTitle] = useState('')
  const [subtitle, setSubtitle] = useState('')
  const [safeZone, setSafeZone] = useState(true)
  const [targetPickerOpen, setTargetPickerOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportFeedback, setExportFeedback] = useState<
    { kind: 'success'; fileCount: number } | { kind: 'error'; error: unknown } | null
  >(null)

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
    setExportFeedback(null)
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
    setExportFeedback(null)
  }

  const handleExport = async () => {
    if (!target || !previewArtifacts.length || exporting) return
    setExporting(true)
    setExportFeedback(null)
    try {
      const result = await downloadDeliveryPackage(previewArtifacts)
      onCreate({
        targetNodeId: target.nodeId,
        presets: selectedPresets,
        title,
        subtitle,
        safeZone,
      })
      setExportFeedback({ kind: 'success', fileCount: result.fileCount })
    } catch (error) {
      setExportFeedback({ kind: 'error', error })
    } finally {
      setExporting(false)
    }
  }

  return (
    <aside className="workbench-panel delivery-panel" aria-label={t.title}>
      <PanelHeader eyebrow={t.eyebrow} title={t.title} onClose={onClose} />
      {target ? (
        <div className="delivery-target">
          <img src={target.image} alt={target.label} />
          <div>
            <span>{t.currentKeyVisual}</span>
            <strong>{target.label}</strong>
            <small>{target.versionId ? t.savedVersion : t.currentCanvas}</small>
          </div>
          <button type="button" className="delivery-target__change" onClick={() => setTargetPickerOpen((open) => !open)}>{t.change}</button>
        </div>
      ) : blockedVideo ? (
        <div className="delivery-blocked">
          <strong>{t.videoBlocked}</strong>
          <span>{t.videoBlockedHint}</span>
          <button type="button" onClick={() => setTargetPickerOpen(true)}>{t.chooseImage}</button>
        </div>
      ) : (
        <div className="delivery-empty">
          <span>{t.emptyHint}</span>
          <button type="button" onClick={() => setTargetPickerOpen(true)}>{t.chooseImage}</button>
        </div>
      )}

      {targetPickerOpen ? (
        <section className="delivery-target-picker" aria-label={t.chooseAsset}>
          <div className="delivery-section__title"><strong>{t.recentImages}</strong><span>{t.imageCount(targets.length)}</span></div>
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
          ) : <p>{t.noImages}</p>}
        </section>
      ) : null}

      {target ? <>
      <section className="delivery-section" aria-label={t.specs}>
        <div className="delivery-section__title">
          <strong>{t.specs}</strong>
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
                <span><strong>{t.channels[preset.id]}</strong><small>{preset.ratio} · {preset.width}×{preset.height}</small></span>
                <i>{active ? '✓' : ''}</i>
              </button>
            )
          })}
        </div>
      </section>

      <section className="delivery-live-preview" aria-label={t.livePreview}>
          <div className="delivery-section__title"><strong>{t.livePreview}</strong><span>{t.previewHint}</span></div>
          {selectedPresets.length ? (
            <>
              <div className="delivery-preview-tabs" role="tablist" aria-label={t.previewChannels}>
                {selectedPresets.map((presetId) => {
                  const preset = deliveryPresets.find((item) => item.id === presetId)
                  if (!preset) return null
                  const active = activePreview?.presetId === presetId
                  return <button type="button" role="tab" aria-selected={active} className={active ? 'is-active' : ''} key={presetId} onClick={() => setActivePreviewPreset(presetId)}>{t.channels[preset.id]}</button>
                })}
              </div>
              {activePreview && activePreviewDefinition ? (
                <div className="delivery-live-preview__stage">
                  <div className={`delivery-preview delivery-preview--${activePreview.presetId}`}>
                    <img src={activePreview.image} alt={`${activePreview.targetLabel} · ${t.channels[activePreviewDefinition.id]}`} />
                    {activePreview.title || activePreview.subtitle ? (
                      <div className="delivery-preview__copy">
                        {activePreview.title ? <strong>{activePreview.title}</strong> : null}
                        {activePreview.subtitle ? <small>{activePreview.subtitle}</small> : null}
                      </div>
                    ) : null}
                    {activePreview.safeZone ? <span className="delivery-preview__safe">{t.safeZone}</span> : null}
                  </div>
                  <p><strong>{t.channels[activePreviewDefinition.id]}</strong><span>{activePreviewDefinition.ratio} · {activePreviewDefinition.width}×{activePreviewDefinition.height}</span></p>
                </div>
              ) : null}
            </>
          ) : <p className="delivery-live-preview__empty">{t.selectSpec}</p>}
      </section>

      <section className="delivery-copy" aria-label={t.copyLayout}>
        <div className="delivery-section__title"><strong>{t.copyLayout}</strong><span>{t.optional}</span></div>
        <label htmlFor="delivery-title">{t.mainTitle}</label>
        <input id="delivery-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t.mainTitlePlaceholder} />
        <label htmlFor="delivery-subtitle">{t.subtitle}</label>
        <input id="delivery-subtitle" value={subtitle} onChange={(event) => setSubtitle(event.target.value)} placeholder={t.subtitlePlaceholder} />
        <label className="delivery-safe-toggle">
          <input type="checkbox" checked={safeZone} onChange={(event) => setSafeZone(event.target.checked)} />
          <span><strong>{t.showSafeZone}</strong><small>{t.safeZoneHint}</small></span>
          <i aria-hidden="true" />
        </label>
      </section>

      <button className="delivery-export" onClick={() => void handleExport()} disabled={!target || !selectedPresets.length || exporting}>{exporting ? t.packaging : t.export(selectedPresets.length)}</button>
      <p className="delivery-note">{t.localOnly}</p>
      {exportFeedback ? <p className="delivery-export-message" role="status">{exportFeedback.kind === 'success'
        ? t.downloaded(exportFeedback.fileCount)
        : localizeProductError(exportFeedback.error, locale, { 'zh-CN': t.exportError, en: t.exportError })}</p> : null}
      </> : null}
    </aside>
  )
}

function PanelHeader({ eyebrow, title, onClose }: { eyebrow?: string; title: string; onClose: () => void }) {
  const { locale } = useProductI18n()
  const t = deliveryCopy[locale]
  return (
    <div className="panel-header">
      <div>
        {eyebrow ? <span className="panel-eyebrow">{eyebrow}</span> : null}
        <h2>{title}</h2>
      </div>
      <button className="close-panel" onClick={onClose} aria-label={t.closePanel(title)}><CloseIcon /></button>
    </div>
  )
}

export function ConfirmationDialog({ asset, phase, onConfirm, onCancel }: { asset: AssetRecord; phase: MotionPhase; onConfirm: () => void; onCancel: () => void }) {
  const { locale } = useProductI18n()
  const t = deliveryCopy[locale]
  const isSharedBrandAsset = asset.source === 'brand'
  const assetName = asset.source === 'generated' ? canvasSystemLabel(asset.name, locale) : asset.name
  const dialogRef = useDialogFocusTrap(phase !== 'exit')
  return (
    <div className={`confirm-backdrop motion-overlay is-${phase}`} aria-hidden={phase === 'exit' ? true : undefined}>
      <section ref={dialogRef} className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-asset-title">
        <span className="panel-eyebrow">{t.removeAssetEyebrow}</span>
        <h2 id="delete-asset-title">{t.deleteTitle(assetName)}</h2>
        <p>{isSharedBrandAsset
          ? t.deleteShared
          : t.deleteProject}</p>
        <div>
          <button className="secondary-button" onClick={onCancel}>{t.cancel}</button>
          <button className="danger-button" onClick={onConfirm}>{t.confirmDelete}</button>
        </div>
      </section>
    </div>
  )
}


export function UndoToast({ label, phase, onUndo }: { label: string; phase: MotionPhase; onUndo: () => void }) {
  const { locale } = useProductI18n()
  const t = deliveryCopy[locale]
  const displayLabel = locale === 'en'
    ? label
      .replace(/^已移除「(.+)」$/u, 'Removed “$1”')
      .replace(/^已删除「(.+)」$/u, 'Deleted “$1”')
    : label
  return (
    <div className={`undo-toast is-${phase}`} role="status" aria-hidden={phase === 'exit' ? true : undefined}>
      <span>{displayLabel}</span>
      <button onClick={onUndo}>{t.undo}</button>
    </div>
  )
}
