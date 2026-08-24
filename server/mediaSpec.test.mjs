import assert from 'node:assert/strict'
import test from 'node:test'
import { aspectRatioLabel, readMediaSpec, readMediaSpecFromDataUrl } from './mediaSpec.mjs'
import { encodeRgbaPng } from './imageOverlay.mjs'

function pngOf(width, height) {
  return encodeRgbaPng({ width, height, rgba: Buffer.alloc(width * height * 4, 200) })
}

/** 最小可解析 JPEG：SOI + APP0 + SOF0 + EOI。只需要帧头能被找到。 */
function jpegOf(width, height) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00])
  const sof0 = Buffer.alloc(11)
  sof0[0] = 0xff
  sof0[1] = 0xc0
  sof0.writeUInt16BE(9, 2)
  sof0[4] = 8
  sof0.writeUInt16BE(height, 5)
  sof0.writeUInt16BE(width, 7)
  sof0[9] = 1
  sof0[10] = 0
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0, Buffer.from([0xff, 0xd9])])
}

/** 最小 MP4：ftyp + moov(mvhd)，mvhd 版本 0。 */
function mp4Of(durationSeconds, timescale = 600) {
  const mvhdBody = Buffer.alloc(100)
  mvhdBody.writeUInt32BE(timescale, 12)
  mvhdBody.writeUInt32BE(Math.round(durationSeconds * timescale), 16)
  const mvhd = Buffer.concat([Buffer.alloc(8), mvhdBody])
  mvhd.writeUInt32BE(mvhd.length, 0)
  mvhd.write('mvhd', 4, 'latin1')
  const moov = Buffer.concat([Buffer.alloc(8), mvhd])
  moov.writeUInt32BE(moov.length, 0)
  moov.write('moov', 4, 'latin1')
  const ftyp = Buffer.concat([Buffer.alloc(8), Buffer.from('isom')])
  ftyp.writeUInt32BE(ftyp.length, 0)
  ftyp.write('ftyp', 4, 'latin1')
  return Buffer.concat([ftyp, moov])
}

test('PNG 尺寸只读文件头，不解码像素', () => {
  const spec = readMediaSpec(pngOf(1024, 768), 'image/png')
  assert.deepEqual(spec, { mimeType: 'image/png', byteSize: spec.byteSize, width: 1024, height: 768 })
  assert.ok(spec.byteSize > 0)
})

test('JPEG 跳段找到帧头后读出宽高', () => {
  const spec = readMediaSpec(jpegOf(1280, 720), 'image/jpeg')
  assert.equal(spec.mimeType, 'image/jpeg')
  assert.equal(spec.width, 1280)
  assert.equal(spec.height, 720)
})

test('MP4 时长来自 mvhd 的 timescale 与 duration', () => {
  const spec = readMediaSpec(mp4Of(5), 'video/mp4')
  assert.equal(spec.mimeType, 'video/mp4')
  assert.equal(spec.durationSeconds, 5)
  assert.equal(spec.width, undefined)
})

test('声明类型与文件头不一致时以文件头为准并标记出来', () => {
  // 「声明 PNG 实际是别的东西」本身就是第 1 层要抓的完整性问题。
  const spec = readMediaSpec(pngOf(8, 8), 'video/mp4')
  assert.equal(spec.mimeType, 'image/png')
  assert.equal(spec.declaredMimeType, 'video/mp4')
})

test('认不出来的字节只报字节数与声明类型，不猜尺寸', () => {
  // 缺字段在评审里判「无法验证」，不是默认通过。
  const spec = readMediaSpec(Buffer.from('not a media file'), 'image/png')
  assert.equal(spec.width, undefined)
  assert.equal(spec.height, undefined)
  assert.equal(spec.mimeType, undefined)
  assert.equal(spec.declaredMimeType, 'image/png')
  assert.equal(spec.byteSize, 16)
  assert.deepEqual(readMediaSpec(Buffer.alloc(0), 'image/png'), { byteSize: 0, declaredMimeType: 'image/png' })
  assert.deepEqual(readMediaSpec(undefined), { byteSize: 0 })
})

test('data URL 走同一条读取路径', () => {
  const dataUrl = `data:image/png;base64,${pngOf(32, 16).toString('base64')}`
  const spec = readMediaSpecFromDataUrl(dataUrl)
  assert.equal(spec.width, 32)
  assert.equal(spec.height, 16)
  assert.deepEqual(readMediaSpecFromDataUrl('不是 data URL'), { byteSize: 0 })
})

test('比例归一化到最简整数比，不用浮点近似值当身份', () => {
  assert.equal(aspectRatioLabel(1024, 768), '4:3')
  assert.equal(aspectRatioLabel(1080, 1920), '9:16')
  assert.equal(aspectRatioLabel(1000, 1000), '1:1')
  assert.equal(aspectRatioLabel(0, 100), undefined)
  assert.equal(aspectRatioLabel(1.5, 3), undefined)
})
