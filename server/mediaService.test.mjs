import assert from 'node:assert/strict'
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
})
