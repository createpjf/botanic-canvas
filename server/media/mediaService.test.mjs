import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createMediaService } from './mediaService.mjs'

const pngDataUrl = 'data:image/png;base64,iVBORw0KGgo='

test('对象存储媒体只在元数据授权成功后以同源 URL 写入画布', async () => {
  const metadata = new Map()
  let writes = 0
  const productStore = {
    async createMediaObject(ownerId, projectId, object) {
      metadata.set(object.id, { ownerId, projectId, ...object })
    },
    async readMediaObject(userId, id) {
      const media = metadata.get(id)
      return media?.ownerId === userId ? media : undefined
    },
  }
  const objectStore = {
    async putImage({ projectId, bytes, contentType }) {
      writes += 1
      return { id: `media_${writes}`, storageKey: `${projectId}/${writes}`, contentType, byteSize: bytes.byteLength }
    },
    async get(storageKey) {
      return { body: Buffer.from(storageKey), contentType: 'image/png' }
    },
  }
  const media = createMediaService({ productStore, objectStore })
  const document = await media.normalizeDocument({
    image: pngDataUrl,
    nested: [pngDataUrl],
  }, { ownerId: 'owner', projectId: 'project-a' })

  assert.equal(writes, 1)
  assert.equal(document.image, '/api/media/media_1')
  assert.equal(document.nested[0], '/api/media/media_1')
  assert.equal((await media.read('owner', 'media_1'))?.contentType, 'image/png')
  assert.equal(await media.read('other-user', 'media_1'), undefined)
  assert.deepEqual(await media.readGenerationInput('owner', 'media_1', 'project-a'), {
    mimeType: 'image/png',
    buffer: Buffer.from('project-a/1'),
  })
  assert.equal(await media.readGenerationInput('owner', 'media_1', 'project-b'), undefined)
})

test('媒体元数据短暂超时时复用同一对象并重试', async () => {
  const metadata = new Map()
  let writes = 0
  let metadataAttempts = 0
  const media = createMediaService({
    productStore: {
      async createMediaObject(ownerId, projectId, object) {
        metadataAttempts += 1
        if (metadataAttempts === 1) {
          const error = new Error('temporary timeout')
          error.code = 'ETIMEDOUT'
          throw error
        }
        metadata.set(object.id, { ownerId, projectId, ...object })
      },
      async readMediaObject(userId, id) {
        const item = metadata.get(id)
        return item?.ownerId === userId ? item : undefined
      },
    },
    objectStore: {
      async putImage({ projectId, bytes, contentType }) {
        writes += 1
        return { id: 'media_retry', storageKey: `${projectId}/retry`, contentType, byteSize: bytes.byteLength }
      },
    },
  })

  const url = await media.persistDataUrl({ ownerId: 'owner', projectId: 'project-a', dataUrl: pngDataUrl })
  assert.equal(url, '/api/media/media_retry')
  assert.equal(writes, 1)
  assert.equal(metadataAttempts, 2)
})

test('参考图片读取超时时重试，不会让生成任务无限等待', async () => {
  let reads = 0
  const media = createMediaService({
    productStore: {
      async readMediaObject() {
        return { projectId: 'project-a', storageKey: 'project-a/source', contentType: 'image/png' }
      },
    },
    objectStore: {
      async get(_storageKey, { signal } = {}) {
        reads += 1
        if (reads === 1) {
          const error = new Error('temporary reset')
          error.code = 'ECONNRESET'
          throw error
        }
        assert.equal(signal?.aborted, false)
        return { body: Buffer.from('image') }
      },
    },
  })

  assert.deepEqual(await media.readGenerationInput('owner', 'media_source', 'project-a'), {
    mimeType: 'image/png',
    buffer: Buffer.from('image'),
  })
  assert.equal(reads, 2)
})

test('生成任务取消会中止当前媒体读取且不继续重试', async () => {
  let reads = 0
  const controller = new AbortController()
  const media = createMediaService({
    productStore: {
      async readMediaObject() {
        return { projectId: 'project-a', storageKey: 'project-a/cancelled', contentType: 'image/png' }
      },
    },
    objectStore: {
      async get(_storageKey, { signal } = {}) {
        reads += 1
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    },
  })

  const reading = media.readGenerationInput('owner', 'media_source', 'project-a', {
    signal: controller.signal,
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(reads, 1)
  controller.abort(new Error('cancelled by user'))
  await assert.rejects(reading, /cancelled by user/u)
  assert.equal(reads, 1)
})

test('Provider 图片使用 32MB 输出上限，不受 8MB 用户上传上限误伤', async () => {
  let persistedBytes = 0
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const providerImage = Buffer.concat([pngHeader, Buffer.alloc(9 * 1024 * 1024)])
  const media = createMediaService({
    productStore: {
      async createMediaObject() {},
      async readMediaObject() { return { id: 'media_4k' } },
    },
    objectStore: {
      async putMedia({ bytes }) {
        persistedBytes = bytes.length
        return { id: 'media_4k', storageKey: 'project-a/media_4k.png', contentType: 'image/png', byteSize: bytes.length }
      },
    },
  })

  const url = await media.persistProviderImage({
    ownerId: 'owner', projectId: 'project-a',
    image: { dataUrl: `data:image/png;base64,${providerImage.toString('base64')}` },
  })
  assert.equal(url, '/api/media/media_4k')
  assert.equal(persistedBytes, providerImage.length)
})

test('已存生成输入按元数据与读取流双重限流，不会先完整缓冲超大对象', async () => {
  let objectReads = 0
  const metadataBlocked = createMediaService({
    productStore: {
      async readMediaObject() {
        return {
          projectId: 'project-a', storageKey: 'too-large', contentType: 'image/png',
          byteSize: 9,
        }
      },
    },
    objectStore: { async get() { objectReads += 1; return { body: Buffer.alloc(0) } } },
    maximumGeneratedImageBytes: 8,
  })
  await assert.rejects(
    metadataBlocked.readGenerationInput('owner', 'media_large', 'project-a'),
    /超过可重新接收/u,
  )
  assert.equal(objectReads, 0)

  const streamBlocked = createMediaService({
    productStore: {
      async readMediaObject() {
        return { projectId: 'project-a', storageKey: 'legacy-large', contentType: 'image/png' }
      },
    },
    objectStore: {
      async get() {
        objectReads += 1
        return { body: Readable.from([Buffer.alloc(5), Buffer.alloc(4)]) }
      },
    },
    maximumGeneratedImageBytes: 8,
  })
  await assert.rejects(
    streamBlocked.readGenerationInput('owner', 'media_legacy_large', 'project-a'),
    /超过可重新接收/u,
  )
  assert.equal(objectReads, 1)
})

test('H3 的 MP4 输出通过同一媒体授权契约持久化', async () => {
  let written
  const media = createMediaService({
    productStore: {
      async createMediaObject(ownerId, projectId, object) {
        written = { ownerId, projectId, ...object }
      },
      async readMediaObject() {
        return written
      },
    },
    objectStore: {
      async putMedia(input) {
        assert.equal(input.contentType, 'video/mp4')
        assert.equal(input.bytes.toString(), 'video-bytes')
        return {
          id: 'media_video',
          storageKey: 'project-a/media/media_video.mp4',
          contentType: input.contentType,
          byteSize: input.bytes.byteLength,
        }
      },
    },
  })

  const url = await media.persistProviderMedia({
    ownerId: 'owner',
    projectId: 'project-a',
    media: { mediaKind: 'video', mimeType: 'video/mp4', buffer: Buffer.from('video-bytes') },
  })

  assert.equal(url, '/api/media/media_video')
  assert.equal(written.contentType, 'video/mp4')
})

test('上传图片必须同时通过 MIME 与真实文件签名校验', async () => {
  const media = createMediaService({
    productStore: {},
    objectStore: { async putMedia() { throw new Error('不应写入伪装文件') } },
  })
  // 声明 PNG，字节签名其实是 JPEG：报错要点名这两个格式，不能只说一句「不匹配」。
  const disguised = `data:image/png;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64')}`

  await assert.rejects(
    media.normalizeDocument({ image: disguised }, { ownerId: 'owner', projectId: 'project-a' }),
    /图片内容是 JPEG，与声明的 PNG 不一致/,
  )
})

test('上传图片字节完全无法识别时报「可能已损坏」，不误报成某个具体格式', async () => {
  const media = createMediaService({
    productStore: {},
    objectStore: { async putMedia() { throw new Error('不应写入伪装文件') } },
  })
  const garbage = `data:image/png;base64,${Buffer.from('<script>alert(1)</script>').toString('base64')}`

  await assert.rejects(
    media.normalizeDocument({ image: garbage }, { ownerId: 'owner', projectId: 'project-a' }),
    /图片内容无法识别，文件可能已损坏/,
  )
})

test('单个上传素材超过配置上限时在对象存储写入前拒绝', async () => {
  const media = createMediaService({
    productStore: {},
    objectStore: { async putMedia() { throw new Error('不应写入超限文件') } },
    maximumUploadBytes: 8,
  })
  const oversizedPng = `data:image/png;base64,${Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(1),
  ]).toString('base64')}`

  await assert.rejects(
    media.normalizeDocument({ image: oversizedPng }, { ownerId: 'owner', projectId: 'project-a' }),
    /单个素材不能超过/,
  )
})
