// @ts-check
import jpeg from 'jpeg-js'
import { decodeRgbaImage } from './imageOverlay.mjs'
import { detectImageFormat, imagePixelSize } from './mediaFormats.mjs'

/** 看图专用传输副本；绝不回写媒体或代替生图配方中的原始参考。 */
export function agentVisionImageDataUrl(dataUrl) {
  if (!dataUrl.startsWith('data:image/png;base64,')) return dataUrl
  const buffer = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
  if (buffer.length <= 512 * 1024 || detectImageFormat(buffer) !== 'image/png') return dataUrl
  const size = imagePixelSize(buffer)
  // ponytail: 复用现有 8-bit PNG/JPEG codec；大于 4MP、交错或透明图保持原样，
  // 待这些输入也出现已复现的性能问题时再接通通用缩图 codec。
  if (!size?.width || !size.height || size.width * size.height > 4 * 1024 * 1024
    || buffer[24] !== 8 || ![2, 6].includes(buffer[25]) || buffer[28] !== 0) return dataUrl
  for (let offset = 8; offset + 12 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset)
    if (offset + 12 + length > buffer.length) return dataUrl
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    if (type === 'tRNS' || type === 'acTL') return dataUrl
    offset += length + 12
  }
  try {
    const { width, height, rgba } = decodeRgbaImage(buffer)
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) return dataUrl
    const encoded = jpeg.encode({ width, height, data: rgba }, 80).data
    return encoded.length < buffer.length
      ? `data:image/jpeg;base64,${Buffer.from(encoded).toString('base64')}`
      : dataUrl
  } catch {
    // 优化失败保留原引用，不能把另一张图或空图交给模型。
    return dataUrl
  }
}
