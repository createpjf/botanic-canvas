import { crc32, deflateSync, inflateSync } from 'node:zlib'

/**
 * 局部重绘选区 → PNG 蒙版。
 * Worker 在拿到基准图字节后调用：先读像素尺寸，再按归一化矩形生成
 * 与基准图同尺寸的 RGBA PNG（选区透明=重绘，其余不透明=保持）。
 * 纯字节实现，服务端不依赖任何 DOM/Canvas。
 */

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 与 src/domain/regionMask.ts 的 minimumRegionSpan 保持一致：更小的选区视为误触。 */
export const minimumRegionSpan = 0.02

/** 归一化并夹取选区矩形；无效或过小时返回 null。与 src/domain/regionMask.ts 同语义。 */
export function normalizeRegionRect(rect) {
  if (!rect || typeof rect !== 'object') return null
  const values = [rect.x, rect.y, rect.width, rect.height].map(Number)
  if (!values.every(Number.isFinite)) return null
  const x = Math.min(Math.max(values[0], 0), 1)
  const y = Math.min(Math.max(values[1], 0), 1)
  const width = Math.min(Math.max(values[2], 0), 1 - x)
  const height = Math.min(Math.max(values[3], 0), 1 - y)
  if (width < minimumRegionSpan || height < minimumRegionSpan) return null
  return { x, y, width, height }
}

/** 从 PNG/JPEG/WebP 字节读像素尺寸；无法识别时返回 null。 */
export function imagePixelSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null
  if (buffer.subarray(0, 8).equals(pngSignature)) {
    if (buffer.length < 24) return null
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return jpegSize(buffer)
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return webpSize(buffer)
  }
  return null
}

function jpegSize(buffer) {
  let offset = 2
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) return null
    const marker = buffer[offset + 1]
    // SOF0–SOF15（跳过 DHT/DAC/RST 等非帧标记）携带尺寸。
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) }
    }
    offset += 2 + buffer.readUInt16BE(offset + 2)
  }
  return null
}

function webpSize(buffer) {
  const format = buffer.subarray(12, 16).toString('ascii')
  if (format === 'VP8X' && buffer.length >= 30) {
    return {
      width: 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)),
      height: 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)),
    }
  }
  if (format === 'VP8 ' && buffer.length >= 30) {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
  }
  if (format === 'VP8L' && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return null
}

function pngChunk(type, data) {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(data.length, 0)
  header.write(type, 4, 'ascii')
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])) >>> 0, 0)
  return Buffer.concat([header, data, checksum])
}

/** 生成与基准图同尺寸的 PNG 蒙版：rect（归一化 0–1）内 alpha=0（重绘），其余不透明。 */
export function buildRegionMaskPng({ width, height }, rect) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return null
  const left = Math.max(0, Math.floor(rect.x * width))
  const top = Math.max(0, Math.floor(rect.y * height))
  const right = Math.min(width, Math.ceil((rect.x + rect.width) * width))
  const bottom = Math.min(height, Math.ceil((rect.y + rect.height) * height))
  if (right <= left || bottom <= top) return null

  const stride = width * 4 + 1
  const raw = Buffer.alloc(stride * height)
  for (let row = 0; row < height; row += 1) {
    const rowStart = row * stride
    // 每行首字节是 PNG filter type 0；其余像素默认黑色不透明。
    for (let column = 0; column < width; column += 1) {
      const pixel = rowStart + 1 + column * 4
      raw[pixel + 3] = row >= top && row < bottom && column >= left && column < right ? 0 : 255
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    pngSignature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** 测试与诊断用：解出 PNG 蒙版指定像素的 alpha。仅支持本模块生成的无滤波 RGBA PNG。 */
export function regionMaskAlphaAt(png, x, y) {
  const width = png.readUInt32BE(16)
  const idatStart = 8 + 8 + 13 + 4 // signature + IHDR chunk
  const idatLength = png.readUInt32BE(idatStart)
  const raw = inflateSync(png.subarray(idatStart + 8, idatStart + 8 + idatLength))
  return raw[y * (width * 4 + 1) + 1 + x * 4 + 3]
}
