import assert from 'node:assert/strict'
import test from 'node:test'
import { MEDIA_LIMITS, UPLOAD_IMAGE_FORMATS, imageUploadAccept, unsupportedUploadMessage } from './mediaFormats.ts'

test('accept 属性由词表生成', () => {
  assert.equal(imageUploadAccept(), 'image/png,image/jpeg,image/webp')
  // 手写 accept= 会与词表漂移：服务端加了格式而选择器选不到，或反之。
  assert.equal(imageUploadAccept(), UPLOAD_IMAGE_FORMATS.join(','))
})

test('上限与服务端一致', () => {
  assert.equal(MEDIA_LIMITS.maxUploadBytes, 8 * 1024 * 1024)
})

test('跳过文件的提示列出实际支持的格式与双语', () => {
  assert.equal(unsupportedUploadMessage(1, 'zh-CN'), '已跳过 1 个文件：仅支持 PNG、JPEG、WebP，单张不超过 8MB。')
  assert.equal(unsupportedUploadMessage(3, 'zh-CN'), '已跳过 3 个文件：仅支持 PNG、JPEG、WebP，单张不超过 8MB。')
  assert.equal(unsupportedUploadMessage(1, 'en'), 'Skipped 1 file. Upload PNG, JPEG or WebP images up to 8 MB each.')
  assert.equal(unsupportedUploadMessage(2, 'en'), 'Skipped 2 files. Upload PNG, JPEG or WebP images up to 8 MB each.')
})
