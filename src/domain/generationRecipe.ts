import type { Edge } from '@xyflow/react'
import type {
  AssetNodeData,
  CanvasDocument,
  CanvasNode,
  GenerationAspectRatio,
  GenerationModelOption,
  GenerationRecipe,
  GenerationReference,
  GenerationResolution,
  GenerationSettings,
  GenerateNodeData,
  ResultNodeData,
  TextNodeData,
} from './canvas.ts'
import {
  GENERATION_ASPECT_RATIOS,
  GENERATION_RESOLUTIONS,
  NANO_BANANA_MODEL_ID,
} from './canvas.ts'
import { customGenerationSizeFields, modelSupportsCustomSize, withoutCustomGenerationSize } from './generationOutputSize.ts'

export function maximumReferencesForModel(model: Pick<GenerationModelOption, 'maximumReferences'> | undefined) {
  const value = Number(model?.maximumReferences)
  return Number.isInteger(value) && value > 0 ? value : 8
}

export function everydayResolutions(model: Pick<GenerationModelOption, 'resolutions'> | undefined): GenerationResolution[] {
  const resolutions = model?.resolutions?.length ? model.resolutions : ['1K', '2K'] as const
  return resolutions.filter((resolution) => resolution !== '4K')
}

/**
 * 自动补全时的默认比例。目录顺序不代表偏好——电商与人像是竖版主场景，所以优先 3:4，
 * 模型不支持时才退回目录第一项。自动模式的两条补全路径必须给同一个答案，
 * 否则同一句指令按走哪条路得到不同画幅。
 */
export function defaultAspectRatioForModel(
  model: { aspectRatios?: readonly GenerationAspectRatio[] } | undefined,
): GenerationAspectRatio | undefined {
  return model?.aspectRatios?.includes('3:4') ? '3:4' : model?.aspectRatios?.[0]
}

export function defaultImageGenerationModel<T extends Pick<GenerationModelOption, 'id' | 'provider' | 'mediaKind'>>(
  catalog: readonly T[] | undefined,
  mediaKind: GenerationModelOption['mediaKind'] = 'image',
): T | undefined {
  const matching = (catalog ?? []).filter((model) => (model.mediaKind ?? 'image') === mediaKind)
  if (mediaKind === 'image') {
    const flock = matching.find((model) => model.provider === 'flock' || model.id === NANO_BANANA_MODEL_ID)
    if (flock) return flock
  }
  return matching[0]
}

/**
 * 局部重绘必须落到明确支持蒙版的图片模型。
 *
 * 历史结果可能没有保存 settings；普通生图默认值此时会指向 Nano Banana，但它不接收
 * mask。这里按当前目录重新选一个可执行模型，并把旧比例 / 分辨率收敛到该模型能力内。
 */
export function settingsForRegionEdit(
  settings: GenerationSettings,
  catalog: readonly GenerationModelOption[] | undefined,
): GenerationSettings | undefined {
  const models = (catalog ?? []).filter((model) => (model.mediaKind ?? 'image') === 'image')
  const selected = models.find((model) => model.id === settings.model && model.supportsMask === true)
  const model = selected ?? models.find((item) => item.supportsMask === true)
  return model ? settingsForGenerationModel(settings, model) : undefined
}

export function clarityBoostModel(catalog: readonly GenerationModelOption[] | undefined) {
  return (catalog ?? []).find((model) => (
    (model.mediaKind ?? 'image') === 'image' && model.resolutions?.includes('4K')
  ))
}

export function applyClarityBoost(settings: GenerationSettings, catalog: readonly GenerationModelOption[] | undefined): GenerationSettings {
  const model = clarityBoostModel(catalog)
  if (!model) return settings
  return settingsForGenerationModel({
    ...withoutCustomGenerationSize(settings),
    model: model.id,
    resolution: '4K',
  }, model)
}

export function clearClarityBoost(settings: GenerationSettings, catalog: readonly GenerationModelOption[] | undefined): GenerationSettings {
  const model = catalog?.find((item) => item.id === settings.model)
  const everyday = everydayResolutions(model)
  const resolution = everyday.includes('2K') ? '2K' : everyday[0] ?? '2K'
  return { ...settings, resolution }
}

export function clampBatchCount(value: number) {
  return Math.max(1, Math.round(value) || 1)
}

export function cloneGenerationSettings(settings: Partial<GenerationSettings> | undefined): GenerationSettings {
  const customSize = customGenerationSizeFields(settings)
  return {
    model: typeof settings?.model === 'string' && settings.model.trim() ? settings.model : 'gpt-image-2',
    aspectRatio: (GENERATION_ASPECT_RATIOS as readonly string[]).includes(settings?.aspectRatio ?? '')
      ? settings!.aspectRatio!
      : '3:4',
    resolution: (GENERATION_RESOLUTIONS as readonly string[]).includes(settings?.resolution ?? '')
      ? settings!.resolution!
      : '2K',
    ...(Number.isInteger(settings?.duration) && Number(settings?.duration) >= 4 && Number(settings?.duration) <= 15
      ? { duration: Number(settings?.duration) }
      : {}),
    ...(typeof settings?.searchGrounding === 'boolean' ? { searchGrounding: settings.searchGrounding } : {}),
    ...(settings?.thinkingLevel === 'minimal' || settings?.thinkingLevel === 'high'
      ? { thinkingLevel: settings.thinkingLevel }
      : {}),
    ...customSize,
  }
}

function flockImageSettings(model: GenerationModelOption | undefined, settings?: Partial<GenerationSettings>) {
  if (!model?.supportsSearchGrounding && !model?.thinkingLevels?.length) return {}
  return {
    ...(model.supportsSearchGrounding
      ? { searchGrounding: typeof settings?.searchGrounding === 'boolean' ? settings.searchGrounding : true }
      : {}),
    ...(model.thinkingLevels?.length
      ? {
        thinkingLevel: settings?.thinkingLevel && model.thinkingLevels.includes(settings.thinkingLevel)
          ? settings.thinkingLevel
          : 'high' as const,
      }
      : {}),
  }
}

export function defaultSettingsForModel(model: GenerationModelOption | undefined): GenerationSettings {
  const everyday = everydayResolutions(model)
  return {
    model: model?.id ?? 'gpt-image-2',
    aspectRatio: model?.aspectRatios?.includes('3:4') ? '3:4' : model?.aspectRatios?.[0] ?? '3:4',
    resolution: everyday.includes('2K') ? '2K' : everyday[0] ?? '2K',
    ...(model?.mediaKind === 'video'
      ? { duration: model.defaultDuration ?? model.durations?.[0] ?? 5 }
      : {}),
    ...flockImageSettings(model),
  }
}

export function settingsForGenerationModel(
  settings: GenerationSettings,
  model: GenerationModelOption,
): GenerationSettings {
  const aspectRatio = model.aspectRatios?.includes(settings.aspectRatio)
    ? settings.aspectRatio
    : model.aspectRatios?.[0] ?? settings.aspectRatio
  const everyday = everydayResolutions(model)
  const resolution = model.resolutions?.includes(settings.resolution)
    ? settings.resolution
    : everyday.includes('2K') ? '2K' : model.resolutions?.[0] ?? settings.resolution
  const duration = model.mediaKind === 'video'
    ? model.durations?.includes(settings.duration ?? -1)
      ? settings.duration
      : model.defaultDuration ?? model.durations?.[0] ?? 5
    : undefined
  const customSize = modelSupportsCustomSize(model) ? customGenerationSizeFields(settings) : undefined
  return {
    model: model.id,
    aspectRatio,
    resolution,
    ...(duration === undefined ? {} : { duration }),
    ...flockImageSettings(model, settings),
    ...customSize,
  }
}

export function cloneGenerationRecipe(recipe: GenerationRecipe): GenerationRecipe {
  return {
    ...recipe,
    settings: cloneGenerationSettings(recipe.settings),
    references: recipe.references.map((reference) => ({ ...reference })),
  }
}

function isGenerateInputNode(node: CanvasNode | undefined): node is CanvasNode {
  return Boolean(node && (node.type === 'asset' || node.type === 'text' || node.type === 'result'))
}

export function normalizeGenerateNodeInputs(nodes: CanvasNode[], edges: Edge[]): CanvasNode[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  return nodes.map((node) => {
    if (node.type !== 'generate') return node
    const data = node.data as GenerateNodeData
    const connectedIds = [...new Set(edges
      .filter((edge) => edge.target === node.id)
      .map((edge) => edge.source)
      .filter((sourceId) => isGenerateInputNode(nodeById.get(sourceId))))]
    const previousOrder = data.inputOrder ?? []
    const inputOrder = [
      ...previousOrder.filter((inputId) => connectedIds.includes(inputId)),
      ...connectedIds.filter((inputId) => !previousOrder.includes(inputId)),
    ]
    const connectedAssets = inputOrder
      .map((inputId) => nodeById.get(inputId))
      .filter((input): input is CanvasNode => input?.type === 'asset')
    const currentPrimary = connectedAssets.find((input) => input.id === data.primaryInputId)
    const legacyPrimary = connectedAssets.find((input) => Boolean((input.data as AssetNodeData).primary))
    const primaryInputId = (currentPrimary ?? legacyPrimary ?? connectedAssets[0])?.id
    return { ...node, data: { ...data, inputOrder, primaryInputId } }
  }) as CanvasNode[]
}

export function connectedGenerateInputs(document: CanvasDocument, generateNodeId: string) {
  const generateNode = document.nodes.find((node) => node.id === generateNodeId && node.type === 'generate')
  if (!generateNode || generateNode.type !== 'generate') return []
  const data = generateNode.data as GenerateNodeData
  const nodeById = new Map(document.nodes.map((node) => [node.id, node]))
  const connectedIds = [...new Set(document.edges
    .filter((edge) => edge.target === generateNodeId)
    .map((edge) => edge.source)
    .filter((sourceId) => isGenerateInputNode(nodeById.get(sourceId))))]
  const inputOrder = [
    ...(data.inputOrder ?? []).filter((inputId) => connectedIds.includes(inputId)),
    ...connectedIds.filter((inputId) => !(data.inputOrder ?? []).includes(inputId)),
  ]
  return inputOrder.map((inputId) => nodeById.get(inputId)).filter((node): node is CanvasNode => Boolean(node))
}

export type CanvasGenerationReference = GenerationReference & {
  enabled: boolean
  primary: boolean
  priority: number
}

export function canvasGenerationReferences(document: CanvasDocument): CanvasGenerationReference[] {
  const references = document.nodes
    .flatMap((node, index): CanvasGenerationReference[] => {
      if (node.type !== 'asset') return []
      const asset = node.data as AssetNodeData
      const enabled = asset.referenceEnabled !== false
      return [{
        nodeId: node.id,
        assetId: asset.assetId,
        name: asset.name,
        image: asset.image,
        role: asset.role,
        source: asset.source,
        mediaKind: asset.mediaKind ?? 'image',
        enabled,
        primary: enabled && asset.role === '商品' && Boolean(asset.primary),
        priority: Number.isInteger(asset.referencePriority) && asset.referencePriority! > 0 ? asset.referencePriority! : index + 1,
      }]
    })
    .sort((left, right) => {
      if (left.primary !== right.primary) return left.primary ? -1 : 1
      if (left.priority !== right.priority) return left.priority - right.priority
      if (left.role === right.role) return left.name.localeCompare(right.name, 'zh-Hans-CN')
      if (left.role === '商品') return -1
      if (right.role === '商品') return 1
      return left.role.localeCompare(right.role, 'zh-Hans-CN')
    })
  return references.map((reference, index) => ({ ...reference, priority: index + 1 }))
}

export function buildGenerationRecipe(
  document: CanvasDocument,
  prompt: string,
  batchCount: number,
  settings: GenerationSettings,
): GenerationRecipe {
  const references = canvasGenerationReferences(document).filter((reference) => reference.enabled)
  const primary = references.find((reference) => reference.primary && reference.role === '商品')
    ?? references.find((reference) => reference.role === '商品')
  return {
    primaryReferenceNodeId: primary?.nodeId,
    references: references.map((reference) => ({
      nodeId: reference.nodeId,
      assetId: reference.assetId,
      name: reference.name,
      image: reference.image,
      role: reference.role,
      source: reference.source,
      mediaKind: reference.mediaKind ?? 'image',
      primary: reference.nodeId === primary?.nodeId,
      priority: reference.priority,
    })),
    prompt,
    batchCount,
    settings: cloneGenerationSettings(settings),
  }
}

export function buildGraphGenerationRecipe(document: CanvasDocument, generateNodeId: string) {
  const generateNode = document.nodes.find((node) => node.id === generateNodeId && node.type === 'generate')
  if (!generateNode || generateNode.type !== 'generate') return null

  const generate = generateNode.data as GenerateNodeData
  const isVideoGeneration = generate.settings.duration !== undefined
  const connectedNodes = connectedGenerateInputs(document, generateNodeId)
  const directReferences = connectedNodes.flatMap((node, index): GenerationReference[] => {
    if (node.type !== 'asset') return []
    const asset = node.data as AssetNodeData
    return [{
      nodeId: node.id,
      assetId: asset.assetId,
      name: asset.name,
      image: asset.image,
      role: asset.role,
      source: asset.source,
      mediaKind: asset.mediaKind ?? 'image',
      primary: false,
      priority: index + 1,
    }]
  })
  const promptParts = connectedNodes
    .flatMap((node) => node.type === 'text' ? [(node.data as TextNodeData).content.trim()] : [])
    .filter(Boolean)
  const directPrompt = generate.prompt.trim()
  // Agent 工作流会把同一份描述同时保留在生成节点与文字节点中；
  // 两者完全相同时只保留一份，避免用户从该节点再次生成时重复提交 Prompt。
  if (directPrompt && !promptParts.includes(directPrompt)) promptParts.push(directPrompt)

  const resultInputs = connectedNodes.filter((node) => node.type === 'result') as CanvasNode[]
  const parentResult = isVideoGeneration ? undefined : resultInputs.find((node) => {
    const data = node.data as ResultNodeData
    return Boolean(data.image) && (data.mediaKind ?? 'image') === 'image'
  })
  const parentData = parentResult?.type === 'result' ? parentResult.data as ResultNodeData : undefined
  const inheritedReferences = parentData?.generationRecipe?.references ?? []
  const imageResultReferences = isVideoGeneration ? resultInputs.flatMap((node, index): GenerationReference[] => {
    const data = node.data as ResultNodeData
    if (!data.image || data.mediaKind === 'video') return []
    return [{
      nodeId: node.id,
      assetId: `result:${node.id}`,
      name: data.label ?? '上游画面',
      image: data.image,
      role: '首图',
      source: 'generated',
      mediaKind: 'image',
      primary: false,
      priority: directReferences.length + index + 1,
    }]
  }) : []
  const videoReferences = resultInputs.flatMap((node, index): GenerationReference[] => {
    const data = node.data as ResultNodeData
    if (!data.image || data.mediaKind !== 'video') return []
    return [{
      nodeId: node.id,
      assetId: `result:${node.id}`,
      name: data.label ?? '上游视频',
      image: data.image,
      role: '调性',
      source: 'generated',
      mediaKind: 'video',
      primary: false,
      priority: directReferences.length + index + 1,
    }]
  })
  const references = [
    ...directReferences,
    ...imageResultReferences,
    ...videoReferences,
    ...(isVideoGeneration ? [] : inheritedReferences.filter((reference) => !directReferences.some((direct) => direct.assetId === reference.assetId))),
  ]
  const primary = references.find((reference) => reference.nodeId === generate.primaryInputId)
    ?? references.find((reference) => reference.primary)
    ?? references[0]
  const prompt = promptParts.join('\n')
  return {
    prompt,
    hasUnselectedResultInput: Boolean(resultInputs.some((node) => !(node.data as ResultNodeData).image)),
    parent: parentResult && parentData?.image
      ? { nodeId: parentResult.id, image: parentData.image, label: parentData.label ?? '上游首图' }
      : undefined,
    recipe: {
      primaryReferenceNodeId: primary?.nodeId,
      references: references.map((reference, index) => ({
        ...reference,
        primary: reference.nodeId === primary?.nodeId,
        priority: index + 1,
      })),
      prompt,
      batchCount: clampBatchCount(generate.batchCount),
      settings: cloneGenerationSettings(generate.settings),
      videoInputMode: generate.videoInputMode,
    } satisfies GenerationRecipe,
  }
}

export function primaryGenerationReference(recipe: GenerationRecipe) {
  return recipe.references.find((reference) => reference.nodeId === recipe.primaryReferenceNodeId)
    ?? recipe.references.find((reference) => reference.primary)
    ?? recipe.references[0]
}
