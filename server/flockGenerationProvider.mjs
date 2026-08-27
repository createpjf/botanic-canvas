// @ts-check

import { readMediaSpec } from './mediaSpec.mjs'
import { GenerationError, providerRejectionError } from './generationProvider.mjs'
import { detectImageFormat, isCanonicalImageFormat } from './mediaFormats.mjs'

function dataUrl(media) {
  return `data:${media.mimeType};base64,${media.buffer.toString('base64')}`
}

function flockHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'x-litellm-api-key': apiKey,
    'Content-Type': 'application/json',
  }
}

function flockError(response, body) {
  if (response.status === 401 || response.status === 403) {
    return new GenerationError(502, 'PROVIDER_AUTH_FAILED', 'Flock 图像服务鉴权失败，请检查 FLOCK_API_KEY。')
  }
  if (response.status === 429) {
    return new GenerationError(429, 'PROVIDER_RATE_LIMITED', 'Flock 图像服务当前限流，请稍后重试。')
  }
  if (response.status >= 500) {
    return new GenerationError(502, 'PROVIDER_UNAVAILABLE', 'Flock 图像服务暂时不可用，请稍后重试。')
  }
  const upstreamMessage = typeof body?.error?.message === 'string'
    ? body.error.message
    : typeof body?.message === 'string'
      ? body.message
      : undefined
  return providerRejectionError(upstreamMessage, response.headers.get('x-request-id'), 'Flock 图像')
}

function imageMediaFromBytes(bytes) {
  if (!bytes?.length) {
    throw new GenerationError(502, 'INVALID_PROVIDER_RESPONSE', 'Flock 图像服务没有返回可用的图片数据。')
  }
  const mimeType = detectImageFormat(bytes)
  if (!mimeType || !isCanonicalImageFormat(mimeType)) {
    throw new GenerationError(502, 'INVALID_PROVIDER_RESPONSE', 'Flock 图像服务返回的文件格式无法显示。')
  }
  return { mediaKind: 'image', mimeType, buffer: bytes }
}

function decodeBase64Image(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const raw = value.trim().startsWith('data:image/')
    ? value.trim().slice(value.indexOf(',') + 1)
    : value.trim()
  const base64 = raw.replace(/\s/g, '')
  if (!base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 === 1) return undefined
  return Buffer.from(base64, 'base64')
}

function collectImageCandidates(payload) {
  const values = []
  for (const item of Array.isArray(payload?.data) ? payload.data : []) {
    if (typeof item?.b64_json === 'string') values.push({ kind: 'b64', value: item.b64_json })
    if (typeof item?.url === 'string') values.push({ kind: 'url', value: item.url })
  }
  const message = payload?.choices?.[0]?.message
  const content = message?.content
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part?.image_url?.url === 'string') {
        values.push(part.image_url.url.startsWith('data:')
          ? { kind: 'b64', value: part.image_url.url }
          : { kind: 'url', value: part.image_url.url })
      }
      if (typeof part?.inline_data?.data === 'string') values.push({ kind: 'b64', value: part.inline_data.data })
      if (typeof part?.inlineData?.data === 'string') values.push({ kind: 'b64', value: part.inlineData.data })
    }
  }
  for (const image of Array.isArray(message?.images) ? message.images : []) {
    if (typeof image?.image_url?.url === 'string') {
      values.push(image.image_url.url.startsWith('data:')
        ? { kind: 'b64', value: image.image_url.url }
        : { kind: 'url', value: image.image_url.url })
    }
    if (typeof image?.b64_json === 'string') values.push({ kind: 'b64', value: image.b64_json })
  }
  return values
}

async function resolveImageCandidate(candidate, { fetchImpl, signal }) {
  if (candidate.kind === 'b64') {
    const bytes = decodeBase64Image(candidate.value)
    return bytes ? imageMediaFromBytes(bytes) : undefined
  }
  if (typeof candidate.value !== 'string' || !/^https?:\/\//i.test(candidate.value)) return undefined
  const response = await fetchImpl(candidate.value, { signal })
  if (!response.ok) return undefined
  const bytes = Buffer.from(await response.arrayBuffer())
  return imageMediaFromBytes(bytes)
}

function referenceImages(job) {
  const images = []
  if (job.parent?.buffer) images.push(job.parent)
  for (const reference of job.references ?? []) {
    if (!reference?.buffer) continue
    if ((reference.mediaKind ?? 'image') !== 'image') continue
    if (job.parent?.buffer && reference.buffer.equals?.(job.parent.buffer)) continue
    images.push(reference)
  }
  return images.slice(0, 14)
}

function flockImagePrompt(job) {
  const roles = (job.references ?? [])
    .map((reference) => reference?.role && reference?.name ? `${reference.role}：${reference.name}` : '')
    .filter(Boolean)
    .join('；')
  return [
    job.prompt,
    roles ? `画布参考语义：${roles}。` : '',
    job.parent ? '保持父图主体、构图与识别特征，只按描述提高清晰度或做指定改动。' : '',
  ].filter(Boolean).join('\n')
}

export function flockImageRequestFields(settings = {}) {
  const fields = {
    aspect_ratio: settings.aspectRatio,
    image_size: settings.resolution,
    thinking_level: settings.thinkingLevel === 'minimal' ? 'minimal' : 'high',
  }
  if (settings.searchGrounding !== false) {
    fields.tools = [{ type: 'google_search', search_types: ['web_search', 'image_search'] }]
  }
  return fields
}

export function buildFlockImageRequest(job) {
  const references = referenceImages(job)
  const fields = flockImageRequestFields(job.settings)
  if (!references.length) {
    return {
      path: '/images/generations',
      body: {
        model: job.settings.model,
        prompt: flockImagePrompt(job),
        n: 1,
        ...fields,
      },
    }
  }
  return {
    path: '/chat/completions',
    body: {
      model: job.settings.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: flockImagePrompt(job) },
          ...references.map((reference) => ({ type: 'image_url', image_url: { url: dataUrl(reference) } })),
        ],
      }],
      ...fields,
    },
  }
}

async function generateOneFlockImage(job, {
  apiBaseUrl,
  apiKey,
  signal,
  fetchImpl,
}) {
  const request = buildFlockImageRequest(job)
  const response = await fetchImpl(`${apiBaseUrl}${request.path}`, {
    method: 'POST',
    headers: flockHeaders(apiKey),
    body: JSON.stringify(request.body),
    signal,
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw flockError(response, body)
  const candidates = collectImageCandidates(body)
  for (const candidate of candidates) {
    const media = await resolveImageCandidate(candidate, { fetchImpl, signal }).catch(() => undefined)
    if (media) return media
  }
  throw new GenerationError(502, 'EMPTY_PROVIDER_RESPONSE', 'Flock 图像服务没有返回可用的图片。')
}

/** Flock / Nano Banana 生图 Adapter。文生图走 images/generations，有参考走 chat/completions。 */
export async function generateFlockImages(job, {
  apiBaseUrl,
  apiKey,
  signal,
  persistMedia,
  persistImage,
  jobId,
  fetchImpl = fetch,
  onVariant,
  completedVariants = [],
}) {
  if (!apiKey) throw new GenerationError(503, 'PROVIDER_NOT_CONFIGURED', 'Flock 图像服务尚未配置：请设置 FLOCK_API_KEY。')
  if (typeof jobId !== 'string' || !jobId) throw new GenerationError(500, 'INVALID_JOB_ID', '生成任务缺少唯一标识。')
  const previousOutputs = new Map(
    completedVariants
      .filter((variant) => variant?.status === 'succeeded' && variant.output)
      .map((variant) => [Number(variant.index), variant.output]),
  )
  const pendingIndexes = Array.from({ length: job.batchCount }, (_, index) => index)
    .filter((index) => !previousOutputs.has(index))
  if (!pendingIndexes.length) {
    return {
      outputs: [...previousOutputs.entries()].sort(([left], [right]) => left - right).map(([, output]) => output),
      missingOutputCount: 0,
    }
  }

  const persist = async (media) => {
    if (typeof persistMedia === 'function') return persistMedia(media)
    if (typeof persistImage === 'function') {
      return persistImage({
        mimeType: media.mimeType,
        dataUrl: `data:${media.mimeType};base64,${media.buffer.toString('base64')}`,
      })
    }
    throw new GenerationError(500, 'INVALID_JOB_ID', '生成任务缺少媒体持久化入口。')
  }

  const outputs = new Map(previousOutputs)
  const failures = []
  for (const index of pendingIndexes) {
    await onVariant?.({ index, status: 'running' })
    try {
      const variationJob = index === 0
        ? job
        : { ...job, prompt: `${job.prompt}\n同批候选 ${index + 1}：保持主体一致，形成可见差异。` }
      const media = await generateOneFlockImage(variationJob, { apiBaseUrl, apiKey, signal, fetchImpl })
      const output = {
        id: `${jobId}-output-${index + 1}`,
        image: await persist(media),
        mediaKind: 'image',
        spec: readMediaSpec(media.buffer, media.mimeType),
      }
      outputs.set(index, output)
      await onVariant?.({ index, status: 'succeeded', output })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push(error)
      await onVariant?.({ index, status: 'failed', error: message })
      if (error instanceof GenerationError && [401, 403, 429, 502, 503].includes(error.statusCode) && !outputs.size) {
        throw error
      }
    }
  }

  const orderedOutputs = [...outputs.entries()].sort(([left], [right]) => left - right).map(([, output]) => output)
  if (!orderedOutputs.length) {
    const failure = failures[0]
    if (failure instanceof Error) throw failure
    throw new GenerationError(502, 'EMPTY_PROVIDER_RESPONSE', 'Flock 图像服务没有返回候选图，请重试。')
  }
  const missingOutputCount = Math.max(0, job.batchCount - orderedOutputs.length)
  return {
    outputs: orderedOutputs,
    missingOutputCount,
    partialError: missingOutputCount
      ? `Flock 图像服务仅返回 ${orderedOutputs.length}/${job.batchCount} 张候选，可补生成缺少的 ${missingOutputCount} 张。`
      : undefined,
  }
}
