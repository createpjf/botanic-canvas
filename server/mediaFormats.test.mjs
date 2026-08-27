import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CANONICAL_IMAGE_FORMATS,
  MEDIA_LIMITS,
  UPLOAD_DOCUMENT_FORMATS,
  UPLOAD_IMAGE_FORMATS,
  canonicalImageDataUrlPattern,
  detectImageFormat,
  imageFormatLabel,
  imagePixelSize,
  isCanonicalImageFormat,
  isUploadImageFormat,
} from './mediaFormats.mjs'
import { gptImage2CustomSizeLimits } from './generationOutputSize.mjs'

function pngBytes(width, height) {
  const buffer = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'ascii')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

/** 带一个无长度标记（RST0）与一个非 0xff 填充字节，用来钉住健壮版实现。 */
function jpegBytes(width, height) {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xd0]),
    Buffer.from([0x00]),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]),
    (() => { const b = Buffer.alloc(4); b.writeUInt16BE(height, 0); b.writeUInt16BE(width, 2); return b })(),
    Buffer.alloc(9),
  ])
}

function webpVp8xBytes(width, height) {
  const buffer = Buffer.alloc(30)
  buffer.write('RIFF', 0, 'ascii')
  buffer.write('WEBP', 8, 'ascii')
  buffer.write('VP8X', 12, 'ascii')
  buffer.writeUIntLE(width - 1, 24, 3)
  buffer.writeUIntLE(height - 1, 27, 3)
  return buffer
}

/** VP8（有损）chunk：起始码 0x9d012a 在偏移 23-25，之后是 14 位宽高。 */
function webpVp8Bytes(width, height, { corruptStartCode = false } = {}) {
  const buffer = Buffer.alloc(30)
  buffer.write('RIFF', 0, 'ascii')
  buffer.write('WEBP', 8, 'ascii')
  buffer.write('VP8 ', 12, 'ascii')
  buffer[23] = corruptStartCode ? 0x00 : 0x9d
  buffer[24] = 0x01
  buffer[25] = 0x2a
  buffer.writeUInt16LE(width, 26)
  buffer.writeUInt16LE(height, 28)
  return buffer
}

/** ftyp box：品牌标识在 offset 4，不在文件头。 */
function ftypBytes(brand) {
  const buffer = Buffer.alloc(32)
  buffer.writeUInt32BE(32, 0)
  buffer.write('ftyp', 4, 'ascii')
  buffer.write(brand, 8, 'ascii')
  return buffer
}

test('词表内容与顺序被锁定', () => {
  assert.deepEqual(CANONICAL_IMAGE_FORMATS, ['image/png', 'image/jpeg', 'image/webp'])
  // PR-A 不放宽格式：放宽 accept= 而归一化器未上线会让用户选中后必然失败。
  assert.deepEqual(UPLOAD_IMAGE_FORMATS, ['image/png', 'image/jpeg', 'image/webp'])
  assert.deepEqual(UPLOAD_DOCUMENT_FORMATS, [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
    'text/plain',
    'text/markdown',
  ])
})

test('canonical 是 upload 的子集', () => {
  const extra = CANONICAL_IMAGE_FORMATS.filter((format) => !UPLOAD_IMAGE_FORMATS.includes(format))
  assert.deepEqual(extra, [], `canonical 里有 upload 不接受的格式：${extra.join('、')}`)
})

test('上限是具名常量', () => {
  assert.equal(MEDIA_LIMITS.maxCanonicalLongEdge, 4096)
  // 接收预算按当前最大可生成输出（Nano Banana 4K 方图），不再绑死 gpt-image-2 自定义窗。
  assert.equal(MEDIA_LIMITS.maxCanonicalPixels, 4096 * 4096)
  assert.equal(gptImage2CustomSizeLimits.maxPixels, 8_294_400)
  assert.ok(MEDIA_LIMITS.maxCanonicalPixels > gptImage2CustomSizeLimits.maxPixels)
  assert.equal(MEDIA_LIMITS.maxUploadBytes, 8 * 1024 * 1024)
  assert.equal(MEDIA_LIMITS.maxDecodePixels, 80_000_000)
  assert.equal(MEDIA_LIMITS.maxDocumentPages, 200)
  assert.equal(MEDIA_LIMITS.maxExtractedChars, 200_000)
})

test('检测三个 canonical 格式', () => {
  assert.equal(detectImageFormat(pngBytes(2, 2)), 'image/png')
  assert.equal(detectImageFormat(jpegBytes(2, 2)), 'image/jpeg')
  assert.equal(detectImageFormat(webpVp8xBytes(2, 2)), 'image/webp')
})

test('识别尚未接受的格式，好让错误说得出名字', () => {
  // 识别 ≠ 接受。认出来是为了报「不支持 HEIC」而不是「无法识别的文件」。
  assert.equal(detectImageFormat(ftypBytes('heic')), 'image/heic')
  assert.equal(detectImageFormat(ftypBytes('mif1')), 'image/heic')
  assert.equal(detectImageFormat(ftypBytes('avif')), 'image/avif')
  assert.equal(detectImageFormat(Buffer.from('GIF89a---------------')), 'image/gif')
  assert.equal(detectImageFormat(Buffer.concat([Buffer.from('BM'), Buffer.alloc(30)])), 'image/bmp')
  for (const format of ['image/heic', 'image/avif', 'image/gif', 'image/bmp']) {
    assert.equal(isUploadImageFormat(format), false, `${format} 在 PR-A 不应被接受`)
  }
})

test('认不出来时返回 undefined', () => {
  assert.equal(detectImageFormat(Buffer.from('not an image at all!')), undefined)
  assert.equal(detectImageFormat(Buffer.alloc(0)), undefined)
})

test('读像素尺寸，认不出返回 null', () => {
  assert.deepEqual(imagePixelSize(pngBytes(4032, 3024)), { width: 4032, height: 3024 })
  assert.deepEqual(imagePixelSize(jpegBytes(7, 5)), { width: 7, height: 5 })
  assert.deepEqual(imagePixelSize(webpVp8xBytes(4, 6)), { width: 4, height: 6 })
  assert.equal(imagePixelSize(Buffer.from('not an image, definitely')), null)
  assert.equal(imagePixelSize('not a buffer'), null)
})

test('VP8 有损 WebP 校验关键帧起始码，损坏时不编造尺寸', () => {
  // 收编字节嗅探时保留了 JPEG 更健壮的实现，却换成了 WebP 更弱的实现——
  // 旧 mediaSpec.mjs 的 webpDimensions 在读宽高前会校验 0x9d012a 起始码，
  // 这份没有校验就直接读，会在损坏的有损 WebP 上产出一对看似合法的假尺寸。
  const valid = webpVp8Bytes(12, 8)
  assert.deepEqual(imagePixelSize(valid), { width: 12, height: 8 })

  const corrupt = webpVp8Bytes(12, 8, { corruptStartCode: true })
  // 读不出必须老实返回 null，而不是编造宽高——下游评审第 1 层靠这个区分
  // 「确定性验证失败」与「unverifiable」。
  assert.equal(imagePixelSize(corrupt), null)
})

test('谓词与标签', () => {
  assert.equal(isCanonicalImageFormat('image/PNG'), true)
  assert.equal(isCanonicalImageFormat('image/heic'), false)
  assert.equal(isCanonicalImageFormat(undefined), false)
  assert.equal(isUploadImageFormat('image/webp'), true)
  assert.equal(imageFormatLabel('image/jpeg'), 'JPEG')
  assert.equal(imageFormatLabel('image/svg+xml'), 'SVG')
  // 未知类型原样回显，不静默变空。
  assert.equal(imageFormatLabel('image/unknown'), 'image/unknown')
})

test('canonical data URL 正则只认三个格式', () => {
  const pattern = canonicalImageDataUrlPattern()
  assert.ok(pattern.test('data:image/png;base64,AAAA'))
  assert.ok(pattern.test('data:image/JPEG;base64,AAAA'))
  assert.equal(pattern.test('data:image/heic;base64,AAAA'), false)
  assert.equal(pattern.test('data:video/mp4;base64,AAAA'), false)
})

test('JPEG 尺寸读取保留健壮版实现', () => {
  // 原 regionMaskPng.mjs 的 jpegSize 遇到非 0xff 字节就返回 null，且不跳 RSTn。
  // 收编时若误用那一份，这条会红。
  const withPadding = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xd0]),          // RST0：无长度字段
    Buffer.from([0x00, 0x00, 0x00]),    // 非 0xff 填充
    Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]), // APP0，长度 4
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]),
    (() => { const b = Buffer.alloc(4); b.writeUInt16BE(11317, 0); b.writeUInt16BE(8488, 2); return b })(),
    Buffer.alloc(9),
  ])
  assert.deepEqual(imagePixelSize(withPadding), { width: 8488, height: 11317 })
})
