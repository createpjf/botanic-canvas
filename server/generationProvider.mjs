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

function imageDataUrl(value, maximumReferenceBytes) {
  if (typeof value !== 'string') throw new GenerationError(400, 'INVALID_REFERENCE', '参考素材必须是图片。')
  const match = value.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/i)
  if (!match) throw new GenerationError(400, 'INVALID_REFERENCE', '仅支持 PNG、JPEG 或 WebP 参考素材。')
  const buffer = Buffer.from(match[2], 'base64')
  if (!buffer.length || buffer.length > maximumReferenceBytes) {
    throw new GenerationError(413, 'REFERENCE_TOO_LARGE', '单张参考素材不能超过 8MB。')
  }
  return { mimeType: match[1].toLowerCase(), buffer }
}

export function validateGenerationInput(body, { models, maximumBatchCount, maximumReferenceBytes }) {
  if (!body || typeof body !== 'object') throw new GenerationError(400, 'INVALID_REQUEST', '生成任务不能为空。')
  const projectId = assertText(body.projectId, '项目', 160)
  const kind = assertEnum(body.kind, ['generation', 'refinement'], '任务类型')
  const prompt = assertText(body.prompt, '创意描述')
  const batchCount = Number(body.batchCount)
  if (!Number.isInteger(batchCount) || batchCount < 1 || batchCount > maximumBatchCount) {
    throw new GenerationError(400, 'INVALID_BATCH_COUNT', `候选数量需在 1–${maximumBatchCount} 之间。`)
  }

  const settings = body.settings
  if (!settings || typeof settings !== 'object') throw new GenerationError(400, 'INVALID_REQUEST', '生成参数无效。')
  assertEnum(settings.model, models, '图像模型')
  assertEnum(settings.aspectRatio, ['1:1', '3:4', '4:5', '9:16'], '画面比例')
  assertEnum(settings.resolution, ['1K', '2K'], '输出规格')

  const recipe = body.recipe
  if (!recipe || typeof recipe !== 'object' || !Array.isArray(recipe.references)) {
    throw new GenerationError(400, 'INVALID_REQUEST', '请传入画布参考素材或父版本图片。')
  }
  if (recipe.references.length > 8) throw new GenerationError(400, 'INVALID_REFERENCE', '单次最多使用 8 张参考素材。')

  const references = recipe.references.map((reference, index) => {
    if (!reference || typeof reference !== 'object') throw new GenerationError(400, 'INVALID_REFERENCE', `第 ${index + 1} 张参考素材无效。`)
    const { mimeType, buffer } = imageDataUrl(reference.dataUrl, maximumReferenceBytes)
    return {
      name: assertText(reference.name ?? `参考素材 ${index + 1}`, '参考素材名称', 160),
      role: typeof reference.role === 'string' ? reference.role : '参考',
      primary: Boolean(reference.primary),
      priority: Number.isFinite(Number(reference.priority)) ? Number(reference.priority) : index + 1,
      mimeType,
      buffer,
    }
  })

  const parent = body.parent
    ? (() => {
        const { mimeType, buffer } = imageDataUrl(body.parent.dataUrl, maximumReferenceBytes)
        return { name: assertText(body.parent.name ?? '父版本', '父版本名称', 160), mimeType, buffer }
      })()
    : undefined

  if (!references.length && !parent) throw new GenerationError(400, 'INVALID_REFERENCE', '请至少传入一个画布参考素材或一张父版本图片。')
  if (kind === 'refinement' && !parent) throw new GenerationError(400, 'MISSING_PARENT', '定向精修需要一张已选首图。')

  return {
    projectId,
    kind,
    prompt,
    batchCount,
    settings: { model: settings.model, aspectRatio: settings.aspectRatio, resolution: settings.resolution },
    references,
    parent,
  }
}

export function publicGenerationJob(job) {
  return {
    id: job.id,
    status: job.status,
    kind: job.kind,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    batchCount: job.batchCount,
    outputCount: job.outputs?.length ?? 0,
    provider: 'openai-images',
    model: job.settings?.model,
    error: job.error,
    outputs: job.outputs ?? [],
  }
}

export function persistedGenerationJob(job) {
  return {
    id: job.id,
    ownerId: job.ownerId,
    projectId: job.projectId,
    status: job.status,
    kind: job.kind,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    batchCount: job.batchCount,
    outputs: job.outputs ?? [],
    error: job.error,
    settings: job.settings,
    rawInput: job.rawInput,
  }
}

function outputSize({ aspectRatio, resolution }) {
  return {
    '1K': { '1:1': '1024x1024', '3:4': '960x1280', '4:5': '1024x1280', '9:16': '720x1280' },
    '2K': { '1:1': '2048x2048', '3:4': '1536x2048', '4:5': '1600x2000', '9:16': '1152x2048' },
  }[resolution][aspectRatio]
}

function fileExtension(mimeType) {
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/webp') return 'webp'
  return 'png'
}

function buildProviderPrompt(job) {
  const primary = job.references.find((reference) => reference.primary)
  const roles = job.references.map((reference) => `${reference.role}：${reference.name}`).join('；')
  const intent = job.kind === 'refinement'
    ? '基于首图父版本进行定向精修；保留产品识别度，按本次要求调整。'
    : '生成电商品牌首图；产品主体必须清晰、可识别、适合作为投放视觉。'
  return [
    intent,
    primary ? `主商品参考：${primary.name}。商品外观、材质、标识应保持可信。` : '',
    roles ? `画布参考顺序：${roles}。` : '输入：当前选中的父版本图片。',
    `画面比例：${job.settings.aspectRatio}；输出规格：${job.settings.resolution}。`,
    `创意目标：${job.prompt}`,
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
export async function generateImages(job, { apiBaseUrl, apiKey, signal, persistImage }) {
  if (!apiKey) throw new GenerationError(503, 'PROVIDER_NOT_CONFIGURED', '真实生图尚未配置：请设置 OPENAI_API_KEY。')
  const form = new FormData()
  form.set('model', job.settings.model)
  form.set('prompt', buildProviderPrompt(job))
  form.set('n', String(job.batchCount))
  form.set('size', outputSize(job.settings))
  form.set('quality', job.settings.resolution === '1K' ? 'low' : 'medium')
  form.set('output_format', 'png')
  form.set('moderation', 'auto')
  const inputImages = job.parent ? [job.parent, ...job.references.filter((reference) => !reference.buffer.equals(job.parent.buffer))] : job.references
  inputImages.forEach((reference, index) => {
    form.append('image[]', new Blob([reference.buffer], { type: reference.mimeType }), `reference-${index + 1}.${fileExtension(reference.mimeType)}`)
  })
  const response = await fetch(`${apiBaseUrl}/v1/images/edits`, {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal,
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw providerError(response, body)
  const data = Array.isArray(body?.data) ? body.data : []
  const outputs = await Promise.all(data.map(async (item, index) => {
    const image = providerImage(item?.b64_json)
    return {
      id: `${job.id}-output-${index + 1}`,
      image: await persistImage(image),
      revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined,
    }
  }))
  if (!outputs.length) throw new GenerationError(502, 'EMPTY_PROVIDER_RESPONSE', '图像服务没有返回候选图，请重试。')
  return outputs
}
