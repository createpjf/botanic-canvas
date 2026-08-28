// @ts-check

import { request as httpsRequest } from 'node:https'
import { readMediaSpec } from './mediaSpec.mjs'
import { GenerationError, providerRejectionError } from './generationProvider.mjs'
import { runGenerationVariants } from './generationVariantRunner.mjs'
import { detectImageFormat, isCanonicalImageFormat, MEDIA_LIMITS } from './mediaFormats.mjs'
import { assertPublicHttpsUrl, createPinnedLookup } from './webEgressGuard.mjs'

const MAX_FLOCK_IMAGE_BYTES = MEDIA_LIMITS.maxGeneratedImageBytes
const MAX_FLOCK_PROVIDER_RESPONSE_BYTES = Math.ceil(MAX_FLOCK_IMAGE_BYTES * 4 / 3) + 1024 * 1024
const BASE64_STREAM_CHUNK_BYTES = 48 * 1024
let flockProviderRequestTail = Promise.resolve()

async function withFlockProviderRequest(task) {
  const previous = flockProviderRequestTail
  /** @type {() => void} */
  let release = () => undefined
  flockProviderRequestTail = new Promise((resolve) => { release = resolve })
  await previous
  try {
    return await task()
  } finally {
    release()
  }
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
  if (Math.floor(base64.length * 3 / 4) > MAX_FLOCK_IMAGE_BYTES) return undefined
  const bytes = Buffer.from(base64, 'base64')
  return bytes.length <= MAX_FLOCK_IMAGE_BYTES ? bytes : undefined
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

async function readBoundedResponseBytes(response, maximumBytes) {
  const declaredHeader = response.headers.get('content-length')
  const declaredLength = declaredHeader === null ? undefined : Number(declaredHeader)
  if (typeof declaredLength === 'number' && Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel?.().catch(() => undefined)
    return undefined
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const bytes = Buffer.from(await response.arrayBuffer())
    return bytes.length <= maximumBytes ? bytes : undefined
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        return undefined
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

async function readFlockProviderJson(response) {
  const bytes = await readBoundedResponseBytes(response, MAX_FLOCK_PROVIDER_RESPONSE_BYTES)
  if (!bytes) {
    throw new GenerationError(502, 'INVALID_PROVIDER_RESPONSE', 'Flock 图像服务返回的数据过大，已停止处理。')
  }
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    return null
  }
}

function readPinnedHttpsImage(classified, { signal, requestImpl }) {
  return new Promise((resolve, reject) => {
    const address = classified.addresses[0]
    let settled = false
    const finish = (error, bytes) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve(bytes)
    }
    let request
    try {
      request = requestImpl(classified.href, {
        method: 'GET',
        headers: { Accept: 'image/png,image/jpeg,image/webp' },
        lookup: createPinnedLookup(address),
        signal,
      }, (response) => {
        const status = Number(response.statusCode ?? 0)
        if (status < 200 || status >= 300) {
          // 失败响应不需要正文；直接断开，不能在任务已经释放全局许可后留下
          // 一个仍持续收包的 socket。
          response.destroy()
          finish(undefined, undefined)
          return
        }
        const declaredLength = Number(response.headers['content-length'])
        if (Number.isFinite(declaredLength) && declaredLength > MAX_FLOCK_IMAGE_BYTES) {
          response.destroy()
          finish(undefined, undefined)
          return
        }
        const chunks = []
        let total = 0
        response.on('data', (chunk) => {
          if (settled) return
          const bytes = Buffer.from(chunk)
          total += bytes.length
          if (total > MAX_FLOCK_IMAGE_BYTES) {
            response.destroy()
            finish(undefined, undefined)
            return
          }
          chunks.push(bytes)
        })
        response.on('end', () => finish(undefined, Buffer.concat(chunks, total)))
        response.on('error', (error) => finish(error))
      })
      request.on('error', (error) => finish(error))
      request.end()
    } catch (error) {
      finish(error)
    }
  })
}

async function resolveImageCandidate(candidate, { signal, lookup, imageRequestImpl }) {
  if (candidate.kind === 'b64') {
    const bytes = decodeBase64Image(candidate.value)
    return bytes ? imageMediaFromBytes(bytes) : undefined
  }
  const classified = await assertPublicHttpsUrl(candidate.value, { lookup })
  if (!classified.ok || !('href' in classified) || !('addresses' in classified) || !classified.addresses.length) return undefined
  // URL 保持原 hostname（TLS SNI / 证书校验），DNS lookup 则固定为刚刚通过
  // global-unicast 校验的地址，消除“预检一次、连接时再解析一次”的 rebinding 窗口。
  const bytes = await readPinnedHttpsImage(classified, { signal, requestImpl: imageRequestImpl })
  return bytes ? imageMediaFromBytes(bytes) : undefined
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
  const fields = /** @type {Record<string, unknown>} */ ({
    aspect_ratio: settings.aspectRatio,
    image_size: settings.resolution,
    ...(settings.thinkingLevel === 'minimal' || settings.thinkingLevel === 'high'
      ? { thinking_level: settings.thinkingLevel }
      : {}),
  })
  if (settings.searchGrounding === true) {
    fields.tools = [{ type: 'google_search', search_types: ['web_search', 'image_search'] }]
  }
  return fields
}

function *streamedBase64(buffer) {
  for (let offset = 0; offset < buffer.length; offset += BASE64_STREAM_CHUNK_BYTES) {
    yield buffer.subarray(offset, Math.min(buffer.length, offset + BASE64_STREAM_CHUNK_BYTES)).toString('base64')
  }
}

function streamedFlockChatBody(job, references, fields) {
  const chunks = (function *serialize() {
    yield `{"model":${JSON.stringify(job.settings.model)},"messages":[{"role":"user","content":[${JSON.stringify({ type: 'text', text: flockImagePrompt(job) })}`
    for (const reference of references) {
      yield ',{"type":"image_url","image_url":{"url":'
      const dataUrlPrefix = JSON.stringify(`data:${reference.mimeType};base64,`)
      yield dataUrlPrefix.slice(0, -1)
      yield *streamedBase64(reference.buffer)
      yield '"}}'
    }
    yield ']}]'
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) yield `,${JSON.stringify(key)}:${JSON.stringify(value)}`
    }
    yield '}'
  })()
  return new ReadableStream({
    pull(controller) {
      const next = chunks.next()
      if (next.done) controller.close()
      else controller.enqueue(Buffer.from(next.value))
    },
  })
}

export function buildFlockImageRequest(job) {
  const references = referenceImages(job)
  const fields = flockImageRequestFields(job.settings)
  if (!references.length) {
    return {
      path: '/images/generations',
      body: JSON.stringify({
        model: job.settings.model,
        prompt: flockImagePrompt(job),
        n: 1,
        ...fields,
      }),
    }
  }
  return {
    path: '/chat/completions',
    body: streamedFlockChatBody(job, references, fields),
    duplex: 'half',
  }
}

async function generateOneFlockImage(job, {
  apiBaseUrl,
  apiKey,
  signal,
  fetchImpl,
  lookup,
  imageRequestImpl,
}) {
  const request = buildFlockImageRequest(job)
  const requestInit = {
    method: 'POST',
    headers: flockHeaders(apiKey),
    body: request.body,
    signal,
    // undici 在跨域 30x 时会移除 Authorization，但会保留自定义
    // x-litellm-api-key；禁止自动跳转，避免密钥泄露与 Provider 侧 blind SSRF。
    redirect: 'error',
    ...(request.duplex ? { duplex: request.duplex } : {}),
  }
  let response
  try {
    response = await fetchImpl(`${apiBaseUrl}${request.path}`, requestInit)
  } catch (caught) {
    if (signal?.aborted) throw caught
    // 网络中断与 redirect:'error' 都是批次级上游故障。归一化后 runner 会立即
    // 停止剩余候选，避免同一次断线最多重复发起 batchCount 次计费请求。
    throw new GenerationError(502, 'PROVIDER_UNAVAILABLE', 'Flock 图像服务暂时不可用，请稍后重试。')
  }
  let body
  try {
    body = await readFlockProviderJson(response)
  } catch (caught) {
    if (signal?.aborted || caught instanceof GenerationError) throw caught
    throw new GenerationError(502, 'PROVIDER_UNAVAILABLE', 'Flock 图像服务响应中断，请稍后重试。')
  }
  if (!response.ok) throw flockError(response, body)
  const candidates = collectImageCandidates(body)
  for (const candidate of candidates) {
    const media = await resolveImageCandidate(candidate, { signal, lookup, imageRequestImpl }).catch(() => undefined)
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
  lookup,
  imageRequestImpl = httpsRequest,
  onVariant,
  completedVariants = [],
}) {
  if (!apiKey) throw new GenerationError(503, 'PROVIDER_NOT_CONFIGURED', 'Flock 图像服务尚未配置：请设置 FLOCK_API_KEY。')
  if (typeof jobId !== 'string' || !jobId) throw new GenerationError(500, 'INVALID_JOB_ID', '生成任务缺少唯一标识。')

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

  return runGenerationVariants({
    batchCount: job.batchCount,
    completedVariants,
    concurrency: 1,
    onVariant,
    generateVariant: async (index) => withFlockProviderRequest(async () => {
      const variationJob = index === 0
        ? job
        : { ...job, prompt: `${job.prompt}\n同批候选 ${index + 1}：保持主体一致，形成可见差异。` }
      const media = await generateOneFlockImage(variationJob, {
        apiBaseUrl, apiKey, signal, fetchImpl, lookup, imageRequestImpl,
      })
      return {
        id: `${jobId}-output-${index + 1}`,
        image: await persist(media),
        mediaKind: 'image',
        spec: readMediaSpec(media.buffer, media.mimeType),
      }
    }),
    // 致命鉴权、限流和服务故障一旦出现就停止本批后续请求；runner 仍会把此前
    // 已恢复 / 已成功的输出作为部分成功返回，不需要继续放大上游故障。
    shouldAbortBatch: (error) => (
      !(error instanceof GenerationError)
      || [401, 403, 429, 502, 503].includes(error.statusCode)
    ),
    emptyError: () => new GenerationError(502, 'EMPTY_PROVIDER_RESPONSE', 'Flock 图像服务没有返回候选图，请重试。'),
    partialError: ({ outputCount, batchCount, missingOutputCount }) => (
      `Flock 图像服务仅返回 ${outputCount}/${batchCount} 张候选，可补生成缺少的 ${missingOutputCount} 张。`
    ),
  })
}
