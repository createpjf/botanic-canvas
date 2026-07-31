function parseImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return undefined
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/i)
  if (!match) return undefined
  const bytes = Buffer.from(match[2], 'base64')
  return bytes.length ? { contentType: match[1].toLowerCase(), bytes } : undefined
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isRetryableMediaError(error) {
  if (!error) return false
  const status = error?.$metadata?.httpStatusCode ?? error?.status
  if (status === 429 || (typeof status === 'number' && status >= 500)) return true
  if (['AbortError', 'TimeoutError', 'FetchError'].includes(error.name)) return true
  return ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', '57P01', '57P03', '53300'].includes(error.code)
}

async function retryMediaOperation(operation, attempts = 3) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation()
    } catch (caught) {
      lastError = caught
      if (!isRetryableMediaError(caught) || attempt === attempts) throw caught
      await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** (attempt - 1))))
    }
  }
  throw lastError
}

function mediaTimeoutError() {
  const error = new Error('参考图片读取超时。')
  error.name = 'TimeoutError'
  error.code = 'ETIMEDOUT'
  return error
}

async function withMediaTimeout(operation, timeoutMs = 30_000) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(mediaTimeoutError()), timeoutMs)
  try {
    return await operation(controller.signal)
  } finally {
    clearTimeout(timeoutId)
  }
}

async function readObjectBuffer(objectStore, storageKey) {
  return withMediaTimeout(async (signal) => {
    const media = await objectStore.get(storageKey, { signal })
    if (Buffer.isBuffer(media.body) || media.body instanceof Uint8Array) return Buffer.from(media.body)
    if (!media.body || !(Symbol.asyncIterator in Object(media.body))) return undefined
    const chunks = []
    try {
      for await (const chunk of media.body) {
        if (signal.aborted) throw signal.reason ?? mediaTimeoutError()
        chunks.push(Buffer.from(chunk))
      }
    } catch (caught) {
      media.body.destroy?.(caught)
      throw caught
    }
    return Buffer.concat(chunks)
  })
}

/**
 * 媒体服务将二进制存 S3、元数据及授权关系存 ProductStore；文档只保存同源媒体 URL。
 * 无对象存储时明确退回 data URL，供本地原型运行，不作为 production 路径。
 */
export function createMediaService({ productStore, objectStore }) {
  const enabled = Boolean(objectStore)

  async function persistDataUrl({ ownerId, projectId, dataUrl }) {
    if (!enabled) return dataUrl
    const image = parseImageDataUrl(dataUrl)
    if (!image) throw new Error('仅支持 PNG、JPEG 或 WebP 图片存入对象存储。')
    const object = await retryMediaOperation(() => objectStore.putImage({ projectId, ...image }))
    try {
      // 先复用同一个对象 ID 重试元数据写入。避免网络在数据库已成功提交后中断，
      // 又生成第二个媒体对象，进而把真实生图结果误判为失败。
      await retryMediaOperation(() => productStore.createMediaObject(ownerId, projectId, object))
    } catch (caught) {
      const existing = await productStore.readMediaObject(ownerId, object.id).catch(() => undefined)
      if (existing) return `/api/media/${encodeURIComponent(object.id)}`
      // 避免在无元数据授权关系时对外暴露对象；对象生命周期规则会处理少量孤儿文件。
      throw caught
    }
    return `/api/media/${encodeURIComponent(object.id)}`
  }

  async function persistProviderImage({ ownerId, projectId, image }) {
    return persistDataUrl({ ownerId, projectId, dataUrl: image.dataUrl })
  }

  async function normalizeDocument(document, { ownerId, projectId }) {
    if (!enabled) return document
    const cache = new Map()
    async function visit(value) {
      if (typeof value === 'string' && value.startsWith('data:image/')) {
        if (!cache.has(value)) cache.set(value, persistDataUrl({ ownerId, projectId, dataUrl: value }))
        return cache.get(value)
      }
      if (Array.isArray(value)) return Promise.all(value.map(visit))
      if (!isRecord(value)) return value
      const next = {}
      for (const [key, child] of Object.entries(value)) next[key] = await visit(child)
      return next
    }
    return visit(document)
  }

  async function read(userId, mediaId) {
    if (!enabled) return undefined
    const media = await productStore.readMediaObject(userId, mediaId)
    if (!media) return undefined
    const object = await objectStore.get(media.storageKey)
    return { ...object, contentType: media.contentType }
  }

  async function readGenerationInput(userId, mediaId, projectId) {
    if (!enabled) return undefined
    const record = await productStore.readMediaObject(userId, mediaId)
    if (!record || record.projectId !== projectId) return undefined
    const buffer = await retryMediaOperation(() => readObjectBuffer(objectStore, record.storageKey))
    return buffer?.length ? { mimeType: record.contentType, buffer } : undefined
  }

  async function signedUrl(userId, mediaId, expiresIn = 600) {
    if (!enabled || typeof objectStore.createSignedUrl !== 'function') return undefined
    const media = await productStore.readMediaObject(userId, mediaId)
    if (!media) return undefined
    return objectStore.createSignedUrl(media.storageKey, expiresIn)
  }

  return { enabled, persistDataUrl, persistProviderImage, normalizeDocument, read, readGenerationInput, signedUrl, close: () => objectStore?.close() }
}
