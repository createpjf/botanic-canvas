// @ts-check

/**
 * 媒体实测规格：只读文件头，不解码像素。
 *
 * 存在的理由是评审第 1 层（ADR 0006）：格式、尺寸、比例、时长、文件完整性必须
 * **确定性**验证，不能交给模型 —— 这些能被证明，用模型判断既贵又不可靠。而在此之前
 * `GenerationOutput` 只记 `{id, image, mediaKind}`，没有任何实测规格，第 1 层根本
 * 无从下手。
 *
 * 读不出来时返回 `undefined` 字段而不是猜：缺字段在评审里判为「无法验证」，
 * 不是默认通过。
 */

import { detectImageFormat, imagePixelSize } from './mediaFormats.mjs'

/**
 * MP4 时长：`moov` → `mvhd` 里的 timescale 与 duration。
 *
 * 只在顶层 box 里找 `moov`，再在其内部找 `mvhd`，不做完整 box 树解析 —— 我们要的
 * 只有时长，多解析一层都是额外的出错面。
 */
function mp4DurationSeconds(buffer) {
  const findBox = (start, end, type) => {
    let offset = start
    while (offset + 8 <= end) {
      const size = buffer.readUInt32BE(offset)
      const boxType = buffer.subarray(offset + 4, offset + 8).toString('latin1')
      // size 为 0 表示延伸到文件尾；为 1 表示 64 位长度（这里不支持，直接放弃）。
      if (size === 0) return boxType === type ? { start: offset + 8, end } : undefined
      if (size < 8) return undefined
      if (boxType === type) return { start: offset + 8, end: Math.min(offset + size, end) }
      offset += size
    }
    return undefined
  }
  const moov = findBox(0, buffer.length, 'moov')
  if (!moov) return undefined
  const mvhd = findBox(moov.start, moov.end, 'mvhd')
  if (!mvhd || mvhd.start + 20 > buffer.length) return undefined
  const version = buffer[mvhd.start]
  const timescale = version === 1
    ? (mvhd.start + 28 <= buffer.length ? buffer.readUInt32BE(mvhd.start + 20) : 0)
    : buffer.readUInt32BE(mvhd.start + 12)
  const duration = version === 1
    ? (mvhd.start + 36 <= buffer.length ? Number(buffer.readBigUInt64BE(mvhd.start + 24)) : 0)
    : buffer.readUInt32BE(mvhd.start + 16)
  if (!timescale || !duration) return undefined
  return duration / timescale
}

/**
 * 读取一份媒体字节的实测规格。
 *
 * @param {Buffer} buffer
 * @param {string} [mimeType] 声明的类型。与文件头不一致时以文件头为准并标记出来 ——
 *   「声明 PNG 实际是别的东西」本身就是第 1 层要抓的完整性问题。
 * @returns {{ mimeType?: string, declaredMimeType?: string, byteSize: number, width?: number, height?: number, durationSeconds?: number }}
 */
export function readMediaSpec(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { byteSize: 0, ...(mimeType ? { declaredMimeType: mimeType } : {}) }
  const detected = detectImageFormat(buffer)
  const dimensions = imagePixelSize(buffer)
  // 只有能同时读出格式与尺寸才算实测到规格；读不出就不猜。
  if (detected && dimensions) {
    return {
      mimeType: detected,
      ...(mimeType && mimeType !== detected ? { declaredMimeType: mimeType } : {}),
      byteSize: buffer.length,
      width: dimensions.width,
      height: dimensions.height,
    }
  }
  const durationSeconds = mp4DurationSeconds(buffer)
  if (durationSeconds !== undefined) {
    return {
      mimeType: 'video/mp4',
      ...(mimeType && mimeType !== 'video/mp4' ? { declaredMimeType: mimeType } : {}),
      byteSize: buffer.length,
      durationSeconds,
    }
  }
  // 认不出来只报字节数与声明类型；缺字段在评审里判「无法验证」，不是默认通过。
  return { byteSize: buffer.length, ...(mimeType ? { declaredMimeType: mimeType } : {}) }
}

/** 从 data URL 读规格。Provider 直接回 base64 时用它，避免调用方各自解一遍。 */
export function readMediaSpecFromDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return { byteSize: 0 }
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/s)
  if (!match) return { byteSize: 0 }
  return readMediaSpec(Buffer.from(match[2], 'base64'), match[1])
}

/** 归一化到 `w:h` 最简比。评审第 1 层要比对声明比例，不能用浮点近似值当身份。 */
export function aspectRatioLabel(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return undefined
  const gcd = (left, right) => (right === 0 ? left : gcd(right, left % right))
  const divisor = gcd(width, height)
  return `${width / divisor}:${height / divisor}`
}
