import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CANONICAL_IMAGE_FORMATS,
  MEDIA_LIMITS,
  UPLOAD_IMAGE_FORMATS,
  canonicalImageFormatSentenceList,
  imageFormatSentenceList,
  imageFormatShortList,
  imageUploadAccept,
  isCanonicalImageFormat,
  isUploadImageFormat,
  supportedImageFormatLabels,
  unsupportedUploadMessage,
  uploadLimitsLabel,
} from './mediaFormats.ts'

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

test('格式短名列表由词表生成', () => {
  assert.deepEqual(supportedImageFormatLabels(), ['PNG', 'JPEG', 'WebP'])
})

test('简短场景的格式提示用斜杠分隔，不分语言', () => {
  assert.equal(imageFormatShortList(), 'PNG / JPEG / WebP')
})

test('句子里嵌入的格式枚举按语言选连接词', () => {
  assert.equal(imageFormatSentenceList('zh-CN'), 'PNG、JPEG 或 WebP')
  assert.equal(imageFormatSentenceList('en'), 'PNG, JPEG, or WebP')
})

test('上传限制提示的格式与体积都随词表 / MEDIA_LIMITS 派生', () => {
  assert.equal(uploadLimitsLabel('zh-CN'), 'PNG / JPEG / WebP，单张不超过 8MB')
  assert.equal(uploadLimitsLabel('en'), 'PNG / JPEG / WebP, up to 8 MB each')
  // 换算不写死：真的从 MEDIA_LIMITS.maxUploadBytes 算出来。
  assert.ok(uploadLimitsLabel('en').includes(`${Math.floor(MEDIA_LIMITS.maxUploadBytes / 1024 / 1024)} MB`))
})

test('isUploadImageFormat 判断词表内外的 MIME 类型', () => {
  assert.equal(isUploadImageFormat('image/png'), true)
  assert.equal(isUploadImageFormat('image/jpeg'), true)
  // 大小写与首尾空白不应影响判定：浏览器给出的 blob.type 理应规范，但不能假设上游总是规范。
  assert.equal(isUploadImageFormat('IMAGE/PNG'), true)
  assert.equal(isUploadImageFormat('  image/webp  '), true)
  assert.equal(isUploadImageFormat('image/heic'), false)
  assert.equal(isUploadImageFormat(''), false)
  assert.equal(isUploadImageFormat(undefined), false)
})

test('isCanonicalImageFormat 判断词表内外的 MIME 类型', () => {
  assert.equal(isCanonicalImageFormat('image/png'), true)
  assert.equal(isCanonicalImageFormat('image/jpeg'), true)
  assert.equal(isCanonicalImageFormat('image/webp'), true)
  // 与 isUploadImageFormat 同样不应受大小写/空白影响——字节最终去往生成接口，
  // 判定必须和上传早筛一样稳健。
  assert.equal(isCanonicalImageFormat('IMAGE/PNG'), true)
  assert.equal(isCanonicalImageFormat('  image/webp  '), true)
  assert.equal(isCanonicalImageFormat('image/heic'), false)
  assert.equal(isCanonicalImageFormat(''), false)
  assert.equal(isCanonicalImageFormat(undefined), false)
})

test('canonical 词表句子式枚举按语言选连接词', () => {
  // 当前 CANONICAL 与 UPLOAD 逐项相同，所以文案也恰好一致；这条测试独立校验
  // canonical 自己的函数，不是在验证两者相等——分叉那天这里会先炸。
  assert.equal(canonicalImageFormatSentenceList('zh-CN'), 'PNG、JPEG 或 WebP')
  assert.equal(canonicalImageFormatSentenceList('en'), 'PNG, JPEG, or WebP')
})

test('CANONICAL_IMAGE_FORMATS 词表内容', () => {
  assert.deepEqual([...CANONICAL_IMAGE_FORMATS], ['image/png', 'image/jpeg', 'image/webp'])
})
