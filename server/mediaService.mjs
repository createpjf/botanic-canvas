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
    const object = await objectStore.putImage({ projectId, ...image })
    try {
      await productStore.createMediaObject(ownerId, projectId, object)
    } catch (caught) {
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

  return { enabled, persistDataUrl, persistProviderImage, normalizeDocument, read, close: () => objectStore?.close() }
}
