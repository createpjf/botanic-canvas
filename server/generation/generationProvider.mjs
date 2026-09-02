import { readMediaSpecFromDataUrl } from '../mediaSpec.mjs'
import { buildImageProviderPrompt, gptImage2EditQuality, orderCompositionReferences, providerInputImages } from './generationComposition.mjs'
import { runGenerationVariants } from './generationVariantRunner.mjs'
import {
  catalogAspectRatiosForModel,
  inferAspectRatioFromPixels,
  modelSupportsCustomSize,
  normalizeCustomGenerationSize,
  resolveGenerationOutputSize,
} from './generationOutputSize.mjs'
import { buildRegionMaskPng, normalizeRegionRect } from '../regionMaskPng.mjs'
import {
  CANONICAL_IMAGE_FORMATS,
  canonicalImageDataUrlPattern,
  detectImageFormat,
  imageFormatLabel,
  imagePixelSize,
  isCanonicalImageFormat,
  MEDIA_LIMITS,
} from '../mediaFormats.mjs'
import { maximumReferencesForModel } from './generationVocabulary.mjs'

const MAX_RESOLVED_INPUT_MEDIA_BYTES = MEDIA_LIMITS.maxUploadBytes
const MAX_RESOLVED_STORED_MEDIA_BYTES = MEDIA_LIMITS.maxGeneratedImageBytes
const MAX_RESOLVED_INPUT_TOTAL_BYTES = MEDIA_LIMITS.maxGenerationInputBytes

export class GenerationError extends Error {
  constructor(statusCode, code, message) {
    super(message)
    this.statusCode = statusCode
    this.code = code
    this.upstreamMessage = undefined
    this.providerResponseSummary = undefined
  }
}

function assertText(value, name, maximumLength = 6000) {
  if (typeof value !== 'string' || !value.trim()) throw new GenerationError(400, 'INVALID_REQUEST', `${name}不能为空。`)
  if (value.length > maximumLength) throw new GenerationError(400, 'INVALID_REQUEST', `${name}过长，请精简后重试。`)
  return value.trim()
}

function assertEnum(value, allowed, name) {
  if (!allowed.includes(value)) throw new GenerationError(400, 'INVALID_REQUEST', `${name}不支持。`)
  return value
}

function mediaDataUrl(value, maximumReferenceBytes, mediaKind = 'image') {
  if (typeof value !== 'string') throw new GenerationError(400, 'INVALID_REFERENCE', '参考素材格式无效。')
  // 图片分支委托给权威正则：自建的版本曾经漏掉 `[+]` 转义，image/svg+xml 成为
  // canonical 的那天会悄悄坏掉。视频不是 CANONICAL_IMAGE_FORMATS 的成员，
  // canonicalImageDataUrlPattern() 天然覆盖不到，只能保留内联构造。
  const pattern = mediaKind === 'video'
    ? /^data:(video\/mp4);base64,([A-Za-z0-9+/=\s]+)$/i
    : canonicalImageDataUrlPattern()
  const match = value.match(pattern)
  if (!match) {
    throw new GenerationError(400, 'INVALID_REFERENCE', mediaKind === 'video'
      ? '视频参考仅支持 MP4。'
      : `参考素材仅支持 ${CANONICAL_IMAGE_FORMATS.map(imageFormatLabel).join('、')}。`)
  }
  const buffer = Buffer.from(match[2], 'base64')
  if (!buffer.length || buffer.length > maximumReferenceBytes) {
    throw new GenerationError(413, 'REFERENCE_TOO_LARGE', `单张参考素材不能超过 ${Math.ceil(maximumReferenceBytes / 1024 / 1024)}MB。`)
  }
  return { mimeType: match[1].toLowerCase(), buffer }
}

function mediaReference(value, mediaKind) {
  if (typeof value !== 'string' || !/^media_[A-Za-z0-9_-]+$/.test(value)) {
    throw new GenerationError(400, 'INVALID_REFERENCE', '参考素材标识无效。')
  }
  return { mediaId: value, mediaKind }
}

function inputMedia(value, maximumReferenceBytes, mediaKind = 'image') {
  if (value?.mediaId) return mediaReference(value.mediaId, mediaKind)
  const { mimeType, buffer } = mediaDataUrl(value?.dataUrl, maximumReferenceBytes, mediaKind)
  return { mimeType, buffer, mediaKind }
}

function validateRecipeMetadata(recipe) {
  const dimensions = new Set(['person', 'garment', 'product', 'scene', 'style', 'pose', 'composition', 'lighting', 'aspect_ratio', 'copy_space'])
  const modes = new Set(['preserve', 'vary'])
  const constraints = recipe.constraints === undefined ? undefined : (() => {
    if (!Array.isArray(recipe.constraints) || recipe.constraints.length > 10) throw new GenerationError(400, 'INVALID_REQUEST', '生成参数创作约束无效。')
    const seen = new Set()
    return recipe.constraints.map((item) => {
      if (!dimensions.has(item?.dimension) || !modes.has(item?.mode) || seen.has(item.dimension)) {
        throw new GenerationError(400, 'INVALID_REQUEST', '生成参数创作约束无效或重复。')
      }
      seen.add(item.dimension)
      return {
        dimension: item.dimension,
        mode: item.mode,
        ...(typeof item.sourceAssetGroupId === 'string' && item.sourceAssetGroupId.trim() ? { sourceAssetGroupId: item.sourceAssetGroupId.trim().slice(0, 160) } : {}),
      }
    })
  })()
  const qualityPolicy = recipe.qualityPolicy === undefined ? undefined : (() => {
    if (!recipe.qualityPolicy || typeof recipe.qualityPolicy !== 'object' || !Array.isArray(recipe.qualityPolicy.requiredCriteria)) {
      throw new GenerationError(400, 'INVALID_REQUEST', '生成参数质量策略无效。')
    }
    return {
      version: Number.isInteger(recipe.qualityPolicy.version) ? recipe.qualityPolicy.version : 1,
      requiredCriteria: recipe.qualityPolicy.requiredCriteria.filter((value) => typeof value === 'string').slice(0, 20),
      humanDecisionRequired: recipe.qualityPolicy.humanDecisionRequired !== false,
    }
  })()
  const binding = (value, label) => {
    if (!Array.isArray(value)) throw new GenerationError(400, 'INVALID_REQUEST', `${label}绑定无效。`)
    return value.slice(0, 32).map((item) => ({
      id: assertText(item?.id, `${label}标识`, 160),
      ...(item?.version === undefined ? {} : (() => {
        const version = Number(item.version)
        if (!Number.isInteger(version) || version < 1) {
          throw new GenerationError(400, 'INVALID_REQUEST', `${label}版本无效。`)
        }
        return { version }
      })()),
      ...(item?.contentHash ? { contentHash: assertText(item.contentHash, `${label}摘要`, 200) } : {}),
      ...(item?.selectionReason ? { selectionReason: assertText(item.selectionReason, `${label}使用原因`, 240) } : {}),
    }))
  }
  return {
    ...(recipe.creativeIntent ? { creativeIntent: assertText(recipe.creativeIntent, '创作意图', 80) } : {}),
    ...(constraints ? { constraints } : {}),
    ...(qualityPolicy ? { qualityPolicy } : {}),
    ...(recipe.sourcePlanFingerprint ? { sourcePlanFingerprint: assertText(recipe.sourcePlanFingerprint, '计划指纹', 200) } : {}),
    ...(recipe.memoryBindings ? { memoryBindings: binding(recipe.memoryBindings, '项目记忆') } : {}),
    ...(recipe.skillBindings ? { skillBindings: binding(recipe.skillBindings, 'Skill') } : {}),
  }
}

export function validateGenerationInput(body, { models, maximumBatchCount, maximumReferenceBytes }) {
  if (!body || typeof body !== 'object') throw new GenerationError(400, 'INVALID_REQUEST', '生成任务不能为空。')
  const projectId = assertText(body.projectId, '项目', 160)
  const kind = assertEnum(body.kind, ['generation', 'refinement'], '任务类型')
  const refinementMode = body.refinementMode === undefined
    ? 'faithful'
    : assertEnum(body.refinementMode, ['faithful', 'explore'], '精修方式')
  const prompt = assertText(body.prompt, '创意描述')
  const batchCount = Number(body.batchCount)
  if (!Number.isInteger(batchCount) || batchCount < 1 || batchCount > maximumBatchCount) {
    throw new GenerationError(400, 'INVALID_BATCH_COUNT', `候选数量需在 1–${maximumBatchCount} 之间。`)
  }

  const settings = body.settings
  if (!settings || typeof settings !== 'object') throw new GenerationError(400, 'INVALID_REQUEST', '生成参数无效。')
  const modelOptions = models.map((model) => typeof model === 'string' ? { id: model } : model)
  const model = modelOptions.find((option) => option?.id === settings.model && option.available !== false)
  if (!model) throw new GenerationError(400, 'INVALID_REQUEST', '生成模型不支持。')
  if (model.maximumPromptLength && prompt.length > model.maximumPromptLength) {
    throw new GenerationError(400, 'INVALID_REQUEST', `该模型的创意描述不能超过 ${model.maximumPromptLength} 字符。`)
  }

  const hasCustomWidth = settings.outputWidth !== undefined
  const hasCustomHeight = settings.outputHeight !== undefined
  let customSize
  if (hasCustomWidth || hasCustomHeight) {
    if (!hasCustomWidth || !hasCustomHeight) {
      throw new GenerationError(400, 'INVALID_REQUEST', '自定义宽高必须同时提供。')
    }
    if (!modelSupportsCustomSize(model)) {
      throw new GenerationError(400, 'INVALID_REQUEST', '当前模型不支持自定义像素。')
    }
    const width = Number(settings.outputWidth)
    const height = Number(settings.outputHeight)
    const normalized = normalizeCustomGenerationSize(width, height)
    if (!normalized.ok) throw new GenerationError(400, 'INVALID_REQUEST', normalized.message)
    customSize = { outputWidth: normalized.width, outputHeight: normalized.height }
  }
  const aspectRatio = customSize
    ? inferAspectRatioFromPixels(customSize.outputWidth, customSize.outputHeight)
    : settings.aspectRatio
  assertEnum(aspectRatio, model.aspectRatios ?? catalogAspectRatiosForModel(model), '画面比例')
  assertEnum(settings.resolution, model.resolutions ?? ['1K', '2K'], '输出规格')
  const duration = model.durations
    ? Number(settings.duration)
    : undefined
  if (model.durations && (!Number.isInteger(duration) || !model.durations.includes(duration))) {
    throw new GenerationError(400, 'INVALID_REQUEST', '视频时长不支持。')
  }

  const recipe = body.recipe
  if (!recipe || typeof recipe !== 'object' || !Array.isArray(recipe.references)) {
    throw new GenerationError(400, 'INVALID_REQUEST', '请传入画布参考素材或父版本图片。')
  }
  const maximumReferences = maximumReferencesForModel(model)
  const inputImageCount = recipe.references.length + (body.parent ? 1 : 0)
  if (inputImageCount > maximumReferences) {
    throw new GenerationError(400, 'INVALID_REFERENCE', `单次最多使用 ${maximumReferences} 张参考素材（含父图）。`)
  }

  const references = recipe.references.map((reference, index) => {
    if (!reference || typeof reference !== 'object') throw new GenerationError(400, 'INVALID_REFERENCE', `第 ${index + 1} 张参考素材无效。`)
    const mediaKind = reference.mediaKind === 'video' ? 'video' : 'image'
    if (mediaKind === 'video' && model.mediaKind !== 'video') {
      throw new GenerationError(400, 'INVALID_REFERENCE', '视频素材只能连接到视频生成模型。')
    }
    const inputRole = reference.inputRole === undefined
      ? undefined
      : assertEnum(reference.inputRole, mediaKind === 'video'
        ? ['reference_video']
        : ['first_frame', 'last_frame', 'reference_image'], '视频输入角色')
    const media = inputMedia(reference, maximumReferenceBytes, mediaKind)
    // 提交时就能拦的（dataUrl 已解出 buffer）现在拦，不必等到 Worker 才发现超限。
    // mediaId 提交这里还没有字节，只能沿用 resolveGenerationInputMedia 里的 Worker 侧校验——
    // 这是预期的不对称，不是遗漏。
    if (mediaKind !== 'video' && media.buffer) assertImagePixelBudget(media.buffer)
    return {
      ...(reference.nodeId ? { nodeId: assertText(reference.nodeId, `第 ${index + 1} 张参考素材节点`, 160) } : {}),
      ...(reference.assetId ? { assetId: assertText(reference.assetId, `第 ${index + 1} 张参考素材标识`, 160) } : {}),
      ...(reference.artifactVersionId ? { artifactVersionId: assertText(reference.artifactVersionId, `第 ${index + 1} 张参考素材版本`, 200) } : {}),
      name: assertText(reference.name ?? `参考素材 ${index + 1}`, '参考素材名称', 160),
      role: typeof reference.role === 'string' ? reference.role : '参考',
      primary: Boolean(reference.primary),
      priority: Number.isFinite(Number(reference.priority)) ? Number(reference.priority) : index + 1,
      ...(inputRole ? { inputRole } : {}),
      ...media,
    }
  })

  const parent = body.parent
    ? (() => {
        const media = inputMedia(body.parent, maximumReferenceBytes, 'image')
        if (media.buffer) assertImagePixelBudget(media.buffer)
        return {
          ...(body.parent.nodeId ? { nodeId: assertText(body.parent.nodeId, '父版本节点', 160) } : {}),
          name: assertText(body.parent.name ?? '父版本', '父版本名称', 160),
          ...media,
        }
      })()
    : undefined

  // 局部重绘蒙版只对首个基准图生效；透明区域=重绘。能力由模型目录声明；
  // 旧字符串目录没有能力元数据，沿用 supportsCustomSize 的先例按 gpt-image-2 前缀识别。
  const supportsMask = model.supportsMask === true
    || (model.supportsMask === undefined && typeof model.id === 'string' && model.id.startsWith('gpt-image-2'))
  const mask = recipe.mask
    ? (() => {
        if (!supportsMask) throw new GenerationError(400, 'INVALID_MASK', '当前模型不支持局部重绘蒙版。')
        const media = inputMedia(recipe.mask, maximumReferenceBytes, 'image')
        if (media.buffer) assertImagePixelBudget(media.buffer)
        if (media.mimeType && media.mimeType !== 'image/png') {
          throw new GenerationError(400, 'INVALID_MASK', '局部重绘蒙版必须是带透明通道的 PNG。')
        }
        return media
      })()
    : undefined
  // 选区矩形是位图蒙版的纯数据替代：Worker 拿到基准图字节后才按真实像素生成 PNG。
  const maskRegion = !mask && recipe.maskRegion
    ? (() => {
        if (!supportsMask) throw new GenerationError(400, 'INVALID_MASK', '当前模型不支持局部重绘蒙版。')
        const normalized = normalizeRegionRect(recipe.maskRegion)
        if (!normalized) throw new GenerationError(400, 'INVALID_MASK', '局部重绘选区无效或过小。')
        return normalized
      })()
    : undefined

  if ((mask || maskRegion) && !references.length && !parent) {
    throw new GenerationError(400, 'INVALID_MASK', '局部重绘需要一张基准图片。')
  }
  if (!references.length && !parent && (kind !== 'generation' || model.mediaKind === 'video')) {
    throw new GenerationError(400, 'INVALID_REFERENCE', model.mediaKind === 'video'
      ? '视频生成需要至少传入一张图片作为首帧。'
      : '当前任务需要至少传入一个画布参考素材或一张父版本图片。')
  }
  if (kind === 'refinement' && !parent) throw new GenerationError(400, 'MISSING_PARENT', '定向精修需要一张已选首图。')

  return {
    projectId,
    kind,
    refinementMode,
    prompt,
    batchCount,
    settings: {
      model: settings.model,
      aspectRatio,
      resolution: settings.resolution,
      ...(duration === undefined ? {} : { duration }),
      ...(typeof settings.searchGrounding === 'boolean' && model.supportsSearchGrounding
        ? { searchGrounding: settings.searchGrounding }
        : {}),
      ...(model.thinkingLevels?.includes(settings.thinkingLevel)
        ? { thinkingLevel: settings.thinkingLevel }
        : {}),
      ...customSize,
    },
    references,
    parent,
    ...validateRecipeMetadata(recipe),
    ...(mask ? { mask } : {}),
    ...(maskRegion ? { maskRegion } : {}),
  }
}

/**
 * 参考图像素量是否在供应商能接受的范围内。
 *
 * 拒绝判据**只看像素总数**，不看长边。此前的实现是
 * `pixels <= maxCanonicalPixels && longEdge <= maxCanonicalLongEdge`——那个
 * `&&` 把一个归一化目标（`maxCanonicalLongEdge`，供后续 PR 的下采样器用作
 * 下采样"到"的尺寸）当成了拒绝阈值。2048×2048（2K + 1:1 目录预设，也是默认
 * 分辨率）是 4.19 MP、长边正好 2048，就被这条规则拒了——而长边已经是 2048，
 * 用户没有任何能做的下一步。生成结果又会被原样传回来当精修 / 局部重绘的
 * parent，于是 App 对自己最常见输出的精修全部失败。
 *
 * 凡是我们自己能生成的尺寸，就必须能被重新接收：`MEDIA_LIMITS.maxCanonicalPixels`
 * 按当前最大可生成输出（Nano Banana 4K 方图）计，不再绑死 gpt-image-2 自定义窗。
 *
 * 读不出尺寸时**不拦**：读不出不等于超限，拦住会误杀一类正常输入。
 */
function assertImagePixelBudget(buffer) {
  const size = imagePixelSize(buffer)
  if (!size) return
  const { maxCanonicalPixels } = MEDIA_LIMITS
  const pixels = size.width * size.height
  if (pixels <= maxCanonicalPixels) return
  throw new GenerationError(400, 'IMAGE_TOO_LARGE_PIXELS',
    `参考图 ${size.width}×${size.height}（约 ${Math.round(pixels / 10_000)} 万像素）`
    + `超过 ${Math.round(maxCanonicalPixels / 10_000)} 万像素上限，请压缩后重试。`)
}

/**
 * 任务请求可只保存私有媒体 ID；Worker 执行时才在已校验的用户上下文中读取图片字节。
 * 这样轮询与任务状态写入不会重复携带 Base64 原图。
 */
export async function resolveGenerationInputMedia(input, resolveMedia) {
  let totalResolvedBytes = 0
  const accountResolvedBytes = (buffer, maximumBytes = MAX_RESOLVED_INPUT_MEDIA_BYTES) => {
    if (!buffer?.length || buffer.length > maximumBytes) {
      throw new GenerationError(413, 'REFERENCE_TOO_LARGE',
        `单张参考素材不能超过 ${Math.ceil(maximumBytes / 1024 / 1024)}MB。`)
    }
    totalResolvedBytes += buffer.length
    if (totalResolvedBytes > MAX_RESOLVED_INPUT_TOTAL_BYTES) {
      throw new GenerationError(413, 'GENERATION_INPUT_TOO_LARGE',
        `生成任务的参考素材、父图与蒙版合计不能超过 ${Math.ceil(MAX_RESOLVED_INPUT_TOTAL_BYTES / 1024 / 1024)}MB。`)
    }
  }
  const resolve = async (reference) => {
    let resolved
    if (reference.buffer) {
      // dataUrl 路径：buffer 已在 validateGenerationInput 时由 mediaDataUrl 提前填充。
      resolved = reference
    } else {
      // mediaId 路径：需要通过 resolveMedia 取出字节。
      if (!reference.mediaId) throw new GenerationError(400, 'INVALID_REFERENCE', '参考素材缺少图片数据。')
      const fetched = await resolveMedia(reference.mediaId)
      if (!fetched?.buffer?.length || typeof fetched.mimeType !== 'string') {
        throw new GenerationError(404, 'MEDIA_NOT_FOUND', '生成参考素材已不存在或没有访问权限。')
      }
      if (reference.mediaKind === 'video' && fetched.mimeType !== 'video/mp4') {
        throw new GenerationError(400, 'INVALID_REFERENCE', '视频参考素材必须是 MP4。')
      }
      if (reference.mediaKind !== 'video' && !isCanonicalImageFormat(fetched.mimeType)) {
        throw new GenerationError(400, 'INVALID_REFERENCE',
          `参考素材格式为 ${imageFormatLabel(fetched.mimeType)}，仅支持 ${CANONICAL_IMAGE_FORMATS.map(imageFormatLabel).join('、')}。`)
      }
      resolved = fetched
    }
    // 用户内联 dataUrl 仍受 8MB 上传边界；已授权媒体 ID 可能指向 Botanic 自己
    // 保存的 4K Provider 输出，允许到输出契约的 32MB，且仍受 48MB 总预算。
    accountResolvedBytes(resolved.buffer, reference.buffer
      ? MAX_RESOLVED_INPUT_MEDIA_BYTES
      : reference.mediaKind === 'video'
        ? MAX_RESOLVED_INPUT_TOTAL_BYTES
        : MAX_RESOLVED_STORED_MEDIA_BYTES)
    // 像素守卫。此前只卡字节（8MB），一张 2.8MB 的 12.2MP 手机原图轻松过关，
    // 然后被供应商以 "Invalid image file or mode for image 1" 拒掉 —— 而那句话
    // 会原样转述给用户，让他去 email 供应商。手机照片是最常见的参考素材来源，
    // 所以这条路径上的每个用户都会撞到。dataUrl 与 mediaId 都须通过此处。
    if (reference.mediaKind !== 'video') {
      assertImagePixelBudget(resolved.buffer)
    }
    return { ...reference, mimeType: resolved.mimeType, buffer: resolved.buffer }
  }
  const resolveMask = async (mask) => {
    const resolved = await resolve(mask)
    // mediaId 蒙版要到这里才知道字节格式；透明通道只有 PNG 能携带。
    if (!/^image\/png$/i.test(resolved.mimeType)) {
      throw new GenerationError(400, 'INVALID_MASK', '局部重绘蒙版必须是带透明通道的 PNG。')
    }
    return resolved
  }
  // 顺序物化，避免最多 14 张参考图同时进入内存；累计预算也能在越界点立即停止。
  const references = []
  for (const reference of input.references) references.push(await resolve(reference))
  const parent = input.parent ? await resolve(input.parent) : undefined
  let mask = input.mask ? await resolveMask(input.mask) : undefined
  if (!mask && input.maskRegion) {
    // 选区矩形在这里落成位图：蒙版必须与供应商实际收到的第一张图同像素尺寸。
    // providerInputImages 计算这个值（parent 优先，否则排序后的 references），
    // 与 generateImages 使用同一份源，保证两者在参考再排序时不会错配。
    const inputImages = providerInputImages({ parent, references })
    const base = inputImages[0]
    const size = base ? imagePixelSize(base.buffer) : null
    const png = size ? buildRegionMaskPng(size, input.maskRegion) : null
    if (!png) throw new GenerationError(400, 'INVALID_MASK', '无法按基准图生成局部重绘蒙版。')
    accountResolvedBytes(png)
    mask = { mimeType: 'image/png', buffer: png }
  }
  return {
    ...input,
    references,
    parent,
    ...(mask ? { mask } : {}),
  }
}

export function publicGenerationJob(job, { includeIdempotencyKey = false } = {}) {
  return {
    id: job.id,
    status: job.status,
    kind: job.kind,
    refinementMode: job.refinementMode,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    batchCount: job.batchCount,
    outputCount: job.outputs?.length ?? 0,
    provider: job.provider ?? 'openai-images',
    model: job.settings?.model,
    error: job.error,
    errorCode: job.errorCode,
    missingOutputCount: job.missingOutputCount ?? 0,
    partialError: job.partialError,
    outputs: job.outputs ?? [],
    lateOutputCount: job.lateOutputs?.length ?? 0,
    variants: job.variants ?? [],
    // 仅向任务提交者返回，用于网络状态未知时确认同一次逻辑提交。
    ...(includeIdempotencyKey ? { idempotencyKey: job.idempotencyKey } : {}),
    projectWritebackPending: Boolean(job.projectWritebackPending),
    // 取消回执随任务一起返回：刷新页面后界面仍要说清费用是否可能已产生。
    cancel: job.cancel,
    agentRun: job.agentRun,
    // 编译计划指纹：任一结果都能反查所属的那一次用户确认与那一支。
    planFingerprint: job.planFingerprint,
    branchFingerprint: job.branchFingerprint,
    usage: job.usage,
    budgetWarning: job.budgetWarning,
    effectiveModel: job.effectiveModel,
    providerAttempts: job.providerAttempts ?? [],
    generateNodeId: job.generateNodeId,
    promptNodeId: job.promptNodeId,
    resultNodeId: job.resultNodeId,
    parentNodeId: job.parentNodeId,
  }
}

export function persistedGenerationJob(job) {
  return {
    id: job.id,
    ownerId: job.ownerId,
    projectId: job.projectId,
    status: job.status,
    kind: job.kind,
    refinementMode: job.refinementMode,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    batchCount: job.batchCount,
    outputs: job.outputs ?? [],
    lateOutputs: job.lateOutputs ?? [],
    variants: job.variants ?? [],
    error: job.error,
    // 失败的错误码：服务端重试策略按码分类，只存消息就永远判不出可否重试。
    errorCode: job.errorCode,
    // 只保存经过 Provider Adapter 脱敏、限长后的结构摘要，不下发原始回包。
    providerResponseSummary: job.providerResponseSummary,
    // 取消回执是计费归因唯一的持久记录，必须随任务落库。
    cancel: job.cancel,
    missingOutputCount: job.missingOutputCount ?? 0,
    partialError: job.partialError,
    settings: job.settings,
    provider: job.provider,
    rawInput: job.rawInput,
    idempotencyKey: job.idempotencyKey,
    // 服务端私有：同一确定性 Job ID 只能重放完全相同的 endpoint/project/request。
    idempotencyBinding: job.idempotencyBinding,
    projectWritebackPending: job.projectWritebackPending,
    projectWritebackAttempts: job.projectWritebackAttempts,
    projectWritebackError: job.projectWritebackError,
    projectWritebackUpdatedAt: job.projectWritebackUpdatedAt,
    agentRun: job.agentRun,
    targetBinding: job.targetBinding,
    referenceBindings: job.referenceBindings,
    inputProvenance: job.inputProvenance,
    planFingerprint: job.planFingerprint,
    branchFingerprint: job.branchFingerprint,
    usage: job.usage,
    budgetWarning: job.budgetWarning,
    effectiveModel: job.effectiveModel,
    providerAttempts: job.providerAttempts,
    // Worker 私有 fencing token。只进 Store payload，不得进入 publicGenerationJob。
    executionVersion: job.executionVersion,
    execution: job.execution,
    generateNodeId: job.generateNodeId,
    promptNodeId: job.promptNodeId,
    resultNodeId: job.resultNodeId,
    parentNodeId: job.parentNodeId,
    generateNodePosition: job.generateNodePosition,
    resultNodePosition: job.resultNodePosition,
    generationRecipe: job.generationRecipe,
  }
}

function fileExtension(mimeType) {
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/webp') return 'webp'
  return 'png'
}

/**
 * 供应商拒绝本次任务时的错误。
 *
 * **供应商原文不进用户可见消息。** 生产上它长这样：「Invalid image file or mode
 * for image 1 ... contact us at help.openai.com」—— 用户既不是供应商的客户，
 * 也无从判断该向他们说什么；而真正的答案（照片像素太大）没人告诉他。
 *
 * 原文留在 `upstreamMessage` 字段里给日志和运维，不丢。
 *
 * `subject` 只影响用户可见前缀（如 OpenAI 的「图像」、MiniMax 的「MiniMax 图像」/
 * 「MiniMax 视频」）——供应商名字对用户有用，供应商的英文原文没用。这两者是本函数
 * 存在的唯一理由，所有供应商适配器都必须走这一处，而不是各自转述一份。
 */
export function providerRejectionError(upstreamMessage, requestId, subject = '图像') {
  const suffix = requestId ? `（请求 ${requestId}）` : ''
  const error = new GenerationError(422, 'PROVIDER_REJECTED',
    `${subject}服务拒绝了本次任务，请检查提示词、参考素材与输出规格。${suffix}`)
  if (typeof upstreamMessage === 'string' && upstreamMessage.trim()) {
    error.upstreamMessage = upstreamMessage
  }
  return error
}

function providerError(response, body) {
  const requestId = response.headers.get('x-request-id')
  if (response.status === 401 || response.status === 403) return new GenerationError(502, 'PROVIDER_AUTH_FAILED', '图像服务鉴权失败，请检查 OPENAI_API_KEY 与组织验证。')
  if (response.status === 429) return new GenerationError(429, 'PROVIDER_RATE_LIMITED', '图像服务当前限流，请稍后重试。')
  if (response.status >= 500) return new GenerationError(502, 'PROVIDER_UNAVAILABLE', '图像服务暂时不可用，请稍后重试。')
  return providerRejectionError(typeof body?.error?.message === 'string' ? body.error.message : undefined, requestId)
}

function providerImage(value) {
  if (typeof value !== 'string' || !value.trim()) throw new GenerationError(502, 'INVALID_PROVIDER_RESPONSE', '图像服务没有返回可用的图片数据。')
  const base64 = (value.trim().startsWith('data:image/') ? value.trim().slice(value.indexOf(',') + 1) : value.trim()).replace(/\s/g, '')
  if (!base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 === 1) {
    throw new GenerationError(502, 'INVALID_PROVIDER_RESPONSE', '图像服务返回了无效的图片编码。')
  }
  const bytes = Buffer.from(base64, 'base64')
  const mimeType = detectImageFormat(bytes)
  if (!mimeType || !isCanonicalImageFormat(mimeType)) {
    throw new GenerationError(502, 'INVALID_PROVIDER_RESPONSE', '图像服务返回的文件格式无法显示。')
  }
  return { mimeType, dataUrl: `data:${mimeType};base64,${base64}` }
}

/** 在 Worker 中调用图像供应商；所有图片字节都由调用方决定如何持久化。 */
export async function generateImages(job, {
  apiBaseUrl,
  apiKey,
  signal,
  persistImage,
  jobId,
  variantConcurrency = 3,
  onVariant,
  completedVariants = [],
}) {
  if (!apiKey) throw new GenerationError(503, 'PROVIDER_NOT_CONFIGURED', '生成尚未配置：请设置 OPENAI_API_KEY。')
  if (typeof jobId !== 'string' || !jobId) throw new GenerationError(500, 'INVALID_JOB_ID', '生成任务缺少唯一标识。')
  const inputImages = providerInputImages(job)
  const submit = async (count, variationIndex) => {
    const prompt = buildImageProviderPrompt(job, variationIndex)
    const outputSize = resolveGenerationOutputSize(job.settings)
    const hasInputImages = inputImages.length > 0
    let request
    if (hasInputImages) {
      const form = new FormData()
      form.set('model', job.settings.model)
      form.set('prompt', prompt)
      form.set('n', String(count))
      form.set('size', outputSize)
      form.set('quality', gptImage2EditQuality(job))
      form.set('output_format', 'png')
      form.set('moderation', 'auto')
      inputImages.forEach((reference, index) => {
        form.append('image[]', new Blob([reference.buffer], { type: reference.mimeType }), `reference-${index + 1}.${fileExtension(reference.mimeType)}`)
      })
      if (job.mask?.buffer) {
        // OpenAI edits：mask 应用于第一张 image；透明区域被重绘，不透明区域保持原样。
        form.set('mask', new Blob([job.mask.buffer], { type: job.mask.mimeType }), 'mask.png')
      }
      request = { path: '/v1/images/edits', body: form, headers: {} }
    } else {
      // 没有参考图时走标准文生图入口；edits 端点要求至少一张输入图片。
      request = {
        path: '/v1/images/generations',
        body: JSON.stringify({
          model: job.settings.model,
          prompt,
          n: count,
          size: outputSize,
          quality: gptImage2EditQuality(job),
          output_format: 'png',
          moderation: 'auto',
        }),
        headers: { 'Content-Type': 'application/json' },
      }
    }
    let response
    try {
      response = await fetch(`${apiBaseUrl}${request.path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, ...request.headers },
        body: request.body,
        signal,
      })
    } catch (error) {
      if (signal?.aborted) throw error
      throw new GenerationError(502, 'PROVIDER_UNAVAILABLE', '图像服务连接中断，请稍后重试。')
    }
    const body = await response.json().catch(() => null)
    if (!response.ok) throw providerError(response, body)
    return Array.isArray(body?.data) ? body.data : []
  }

  // 每张候选各占一个供应商请求。部分兼容 OpenAI Images 的网关会忽略 n>1，
  // 因此保留 n=1；恢复跳过、受控并发与部分成功统一交给候选 runner。
  return runGenerationVariants({
    batchCount: job.batchCount,
    completedVariants,
    concurrency: variantConcurrency,
    onVariant,
    generateVariant: async (index) => {
      const providerItems = await submit(1, index)
      const item = providerItems[0]
      if (!item) throw new GenerationError(502, 'EMPTY_PROVIDER_RESPONSE', `第 ${index + 1} 张候选没有返回图片。`)
      const image = providerImage(item.b64_json)
      return {
        id: `${jobId}-output-${index + 1}`,
        image: await persistImage(image),
        mediaKind: 'image',
        // 实测规格随输出落库：评审第 1 层（比例、分辨率、完整性）必须确定性验证，
        // 没有它就只能判「无法验证」（ADR 0006）。在这里读是因为只有此处握有字节。
        spec: readMediaSpecFromDataUrl(image.dataUrl),
        revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined,
      }
    },
    emptyError: () => new GenerationError(502, 'EMPTY_PROVIDER_RESPONSE', '图像服务没有返回候选图，请重试。'),
    partialError: ({ outputCount, batchCount, missingOutputCount }) => (
      `图像服务仅返回 ${outputCount}/${batchCount} 张候选，可补生成缺少的 ${missingOutputCount} 张。`
    ),
  })
}
