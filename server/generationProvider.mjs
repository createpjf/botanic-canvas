import { mapWithConcurrency } from './concurrency.mjs'
import {
  catalogAspectRatiosForModel,
  inferAspectRatioFromPixels,
  modelSupportsCustomSize,
  normalizeCustomGenerationSize,
  resolveGenerationOutputSize,
} from './generationOutputSize.mjs'

export class GenerationError extends Error {
  constructor(statusCode, code, message) {
    super(message)
    this.statusCode = statusCode
    this.code = code
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
  const mimePattern = mediaKind === 'video' ? 'video\\/mp4' : 'image\\/(?:png|jpeg|webp)'
  const match = value.match(new RegExp(`^data:(${mimePattern});base64,([A-Za-z0-9+/=\\s]+)$`, 'i'))
  if (!match) {
    throw new GenerationError(400, 'INVALID_REFERENCE', mediaKind === 'video'
      ? '视频参考仅支持 MP4。'
      : '仅支持 PNG、JPEG 或 WebP 参考素材。')
  }
  const buffer = Buffer.from(match[2], 'base64')
  if (!buffer.length || buffer.length > maximumReferenceBytes) {
    throw new GenerationError(413, 'REFERENCE_TOO_LARGE', '单张参考素材不能超过 8MB。')
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
  const model = modelOptions.find((option) => option?.id === settings.model)
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
  if (recipe.references.length > 8) throw new GenerationError(400, 'INVALID_REFERENCE', '单次最多使用 8 张参考素材。')

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
    return {
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
        return { name: assertText(body.parent.name ?? '父版本', '父版本名称', 160), ...inputMedia(body.parent, maximumReferenceBytes, 'image') }
      })()
    : undefined

  if (!references.length && !parent) throw new GenerationError(400, 'INVALID_REFERENCE', '请至少传入一个画布参考素材或一张父版本图片。')
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
      ...customSize,
    },
    references,
    parent,
  }
}

/**
 * 任务请求可只保存私有媒体 ID；Worker 执行时才在已校验的用户上下文中读取图片字节。
 * 这样轮询与任务状态写入不会重复携带 Base64 原图。
 */
export async function resolveGenerationInputMedia(input, resolveMedia) {
  const resolve = async (reference) => {
    if (reference.buffer) return reference
    if (!reference.mediaId) throw new GenerationError(400, 'INVALID_REFERENCE', '参考素材缺少图片数据。')
    const resolved = await resolveMedia(reference.mediaId)
    if (!resolved?.buffer?.length || typeof resolved.mimeType !== 'string') {
      throw new GenerationError(404, 'MEDIA_NOT_FOUND', '生成参考素材已不存在或没有访问权限。')
    }
    if (reference.mediaKind === 'video' && resolved.mimeType !== 'video/mp4') {
      throw new GenerationError(400, 'INVALID_REFERENCE', '视频参考素材必须是 MP4。')
    }
    if (reference.mediaKind !== 'video' && !/^image\/(?:png|jpeg|webp)$/i.test(resolved.mimeType)) {
      throw new GenerationError(400, 'INVALID_REFERENCE', '图片参考素材格式无效。')
    }
    return { ...reference, mimeType: resolved.mimeType, buffer: resolved.buffer }
  }
  return {
    ...input,
    references: await Promise.all(input.references.map(resolve)),
    parent: input.parent ? await resolve(input.parent) : undefined,
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
    missingOutputCount: job.missingOutputCount ?? 0,
    partialError: job.partialError,
    outputs: job.outputs ?? [],
    variants: job.variants ?? [],
    // 仅向任务提交者返回，用于网络状态未知时确认同一次逻辑提交。
    ...(includeIdempotencyKey ? { idempotencyKey: job.idempotencyKey } : {}),
    projectWritebackPending: Boolean(job.projectWritebackPending),
    agentRun: job.agentRun,
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
    variants: job.variants ?? [],
    error: job.error,
    missingOutputCount: job.missingOutputCount ?? 0,
    partialError: job.partialError,
    settings: job.settings,
    provider: job.provider,
    rawInput: job.rawInput,
    idempotencyKey: job.idempotencyKey,
    projectWritebackPending: job.projectWritebackPending,
    projectWritebackAttempts: job.projectWritebackAttempts,
    projectWritebackError: job.projectWritebackError,
    projectWritebackUpdatedAt: job.projectWritebackUpdatedAt,
    agentRun: job.agentRun,
    usage: job.usage,
    budgetWarning: job.budgetWarning,
    effectiveModel: job.effectiveModel,
    providerAttempts: job.providerAttempts,
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

function buildProviderPrompt(job, variationIndex) {
  const primary = job.references.find((reference) => reference.primary)
  const roles = job.references.map((reference) => `${reference.role}：${reference.name}`).join('；')
  const intent = job.kind === 'refinement' && job.refinementMode === 'explore'
    ? '基于首图父版本生成探索型视觉变体；保持商品主体、人物身份与产品识别度，但主动探索不同构图、机位、光影或环境，不要只输出近似复制图。'
    : job.kind === 'refinement'
      ? '基于首图父版本进行忠实精修；保留构图、主体和产品识别度，仅按本次要求调整。'
    : '生成电商品牌首图；产品主体必须清晰、可识别、适合作为投放视觉。'
  return [
    intent,
    primary ? `主商品参考：${primary.name}。商品外观、材质、标识应保持可信。` : '',
    roles ? `画布参考顺序：${roles}。` : '输入：当前选中的父版本图片。',
    `画面比例：${job.settings.aspectRatio}；输出规格：${job.settings.resolution}。`,
    `创意目标：${job.prompt}`,
    variationIndex === undefined ? '' : `本张为同批候选 ${variationIndex + 1}；请与同批其他候选形成可见差异，同时保持主体一致。`,
    '不要添加未被要求的品牌标识、价格、二维码或水印。',
  ].filter(Boolean).join('\n')
}

function providerError(response, body) {
  const requestId = response.headers.get('x-request-id')
  if (response.status === 401 || response.status === 403) return new GenerationError(502, 'PROVIDER_AUTH_FAILED', '图像服务鉴权失败，请检查 OPENAI_API_KEY 与组织验证。')
  if (response.status === 429) return new GenerationError(429, 'PROVIDER_RATE_LIMITED', '图像服务当前限流，请稍后重试。')
  if (response.status >= 500) return new GenerationError(502, 'PROVIDER_UNAVAILABLE', '图像服务暂时不可用，请稍后重试。')
  const suffix = requestId ? `（请求 ${requestId}）` : ''
  const upstream = typeof body?.error?.message === 'string' ? body.error.message.slice(0, 180) : '请检查提示词、参考素材与输出规格。'
  return new GenerationError(422, 'PROVIDER_REJECTED', `图像服务拒绝了本次任务：${upstream}${suffix}`)
}

function providerImage(value) {
  if (typeof value !== 'string' || !value.trim()) throw new GenerationError(502, 'INVALID_PROVIDER_RESPONSE', '图像服务没有返回可用的图片数据。')
  const base64 = (value.trim().startsWith('data:image/') ? value.trim().slice(value.indexOf(',') + 1) : value.trim()).replace(/\s/g, '')
  if (!base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 === 1) {
    throw new GenerationError(502, 'INVALID_PROVIDER_RESPONSE', '图像服务返回了无效的图片编码。')
  }
  const bytes = Buffer.from(base64, 'base64')
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  const webp = bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  const mimeType = png ? 'image/png' : jpeg ? 'image/jpeg' : webp ? 'image/webp' : null
  if (!mimeType) throw new GenerationError(502, 'INVALID_PROVIDER_RESPONSE', '图像服务返回的文件格式无法显示。')
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
  if (!apiKey) throw new GenerationError(503, 'PROVIDER_NOT_CONFIGURED', '真实生图尚未配置：请设置 OPENAI_API_KEY。')
  if (typeof jobId !== 'string' || !jobId) throw new GenerationError(500, 'INVALID_JOB_ID', '生成任务缺少唯一标识。')
  const inputImages = job.parent ? [job.parent, ...job.references.filter((reference) => !reference.buffer.equals(job.parent.buffer))] : job.references
  const submit = async (count, variationIndex) => {
    const form = new FormData()
    form.set('model', job.settings.model)
    form.set('prompt', buildProviderPrompt(job, variationIndex))
    form.set('n', String(count))
    form.set('size', resolveGenerationOutputSize(job.settings))
    form.set('quality', job.settings.resolution === '1K' ? 'low' : 'medium')
    form.set('output_format', 'png')
    form.set('moderation', 'auto')
    inputImages.forEach((reference, index) => {
      form.append('image[]', new Blob([reference.buffer], { type: reference.mimeType }), `reference-${index + 1}.${fileExtension(reference.mimeType)}`)
    })
    let response
    try {
      response = await fetch(`${apiBaseUrl}/v1/images/edits`, {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal,
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
  // 因此保留 n=1，但由父任务以受控并发的方式调度子候选。
  const priorOutputs = new Map(
    completedVariants
      .filter((variant) => variant?.status === 'succeeded' && variant.output)
      .map((variant) => [Number(variant.index), variant.output]),
  )
  const indexes = Array.from({ length: job.batchCount }, (_, index) => index)
  const settled = await mapWithConcurrency(indexes, variantConcurrency, async (index) => {
    const previous = priorOutputs.get(index)
    if (previous) return { status: 'fulfilled', value: previous }
    await onVariant?.({ index, status: 'running' })
    try {
      const providerItems = await submit(1, index)
      const item = providerItems[0]
      if (!item) throw new GenerationError(502, 'EMPTY_PROVIDER_RESPONSE', `第 ${index + 1} 张候选没有返回图片。`)
      const image = providerImage(item.b64_json)
      const output = {
        id: `${jobId}-output-${index + 1}`,
        image: await persistImage(image),
        mediaKind: 'image',
        revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined,
      }
      await onVariant?.({ index, status: 'succeeded', output })
      return { status: 'fulfilled', value: output }
    } catch (error) {
      await onVariant?.({ index, status: 'failed', error: error instanceof Error ? error.message : String(error) })
      return { status: 'rejected', reason: error }
    }
  })
  const outputs = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
  const failedRequests = settled.filter((result) => result.status === 'rejected')
  if (!outputs.length) {
    const firstFailure = failedRequests[0]
    if (firstFailure?.status === 'rejected') throw firstFailure.reason
    throw new GenerationError(502, 'EMPTY_PROVIDER_RESPONSE', '图像服务没有返回候选图，请重试。')
  }
  const missingOutputCount = Math.max(0, job.batchCount - outputs.length)
  return {
    outputs,
    missingOutputCount,
    partialError: missingOutputCount
      ? `图像服务仅返回 ${outputs.length}/${job.batchCount} 张候选，可补生成缺少的 ${missingOutputCount} 张。`
      : undefined,
  }
}
