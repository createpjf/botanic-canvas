import assert from 'node:assert/strict'
import test from 'node:test'
import { createUploadedAssetId, normalizeAssetCollection, normalizeAssetRecord } from './assets.ts'

test('同一毫秒的连续上传仍生成不同素材 ID', () => {
  assert.notEqual(createUploadedAssetId(42, 0), createUploadedAssetId(42, 0))
})

test('旧素材缺少媒体类型时按图片兼容', () => {
  const asset = normalizeAssetRecord({
    id: 'legacy', role: '商品', name: '旧素材', image: '/legacy.webp', source: 'upload', tags: [],
  })
  assert.equal(asset.mediaKind, 'image')
})

test('历史视频可由已完成结果推断并保留合集路径', () => {
  const asset = normalizeAssetRecord({
    id: 'video', role: '首图', name: '成片', image: '/video.mp4', source: 'generated', collection: ' 夏季\\模特 / ', tags: ['视频'],
  }, 'video')
  assert.equal(asset.mediaKind, 'video')
  assert.equal(asset.collection, '夏季 / 模特')
})

test('空合集不会产生伪分组', () => {
  assert.equal(normalizeAssetCollection(' /  / '), undefined)
})
