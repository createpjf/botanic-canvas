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

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** PNG 的尺寸固定在第一个 IHDR 块，位置确定，无需扫描。 */
function pngDimensions(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined
  if (buffer.subarray(12, 16).toString('latin1') !== 'IHDR') return undefined
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/** JPEG 要跳段找 SOF：段长自描述，因此按长度前进而不是逐字节扫。 */
function jpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined
  let offset = 2
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = buffer[offset + 1]
    // SOI/EOI/RSTn/TEM 没有长度字段。
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2
      continue
    }
    const length = buffer.readUInt16BE(offset + 2)
    // SOF0..SOF15，跳过 DHT(c4)/JPG(c8)/DAC(cc)：它们不是帧头。
    const isFrameHeader = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isFrameHeader) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
    }
    if (length < 2) return undefined
    offset += 2 + length
  }
  return undefined
}

/** WebP：VP8X 有显式画布尺寸；VP8（有损）与 VP8L（无损）各自的位布局不同。 */
function webpDimensions(buffer) {
  if (buffer.length < 30) return undefined
  if (buffer.subarray(0, 4).toString('latin1') !== 'RIFF') return undefined
  if (buffer.subarray(8, 12).toString('latin1') !== 'WEBP') return undefined
  const chunk = buffer.subarray(12, 16).toString('latin1')
  if (chunk === 'VP8X') {
    return {
      width: buffer.readUIntLE(24, 3) + 1,
      height: buffer.readUIntLE(27, 3) + 1,
    }
  }
  if (chunk === 'VP8 ') {
    // 关键帧起始码 0x9d012a 之后是 14 位宽高。
    const start = 20
    if (buffer[start + 3] !== 0x9d || buffer[start + 4] !== 0x01 || buffer[start + 5] !== 0x2a) return undefined
    return {
      width: buffer.readUInt16LE(start + 6) & 0x3fff,
      height: buffer.readUInt16LE(start + 8) & 0x3fff,
    }
  }
  if (chunk === 'VP8L') {
    const bits = buffer.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return undefined
}

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
  const png = pngDimensions(buffer)
  const jpeg = png ? undefined : jpegDimensions(buffer)
  const webp = png || jpeg ? undefined : webpDimensions(buffer)
  const detected = png ? 'image/png' : jpeg ? 'image/jpeg' : webp ? 'image/webp' : undefined
  const dimensions = png ?? jpeg ?? webp
  if (dimensions && detected) {
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
