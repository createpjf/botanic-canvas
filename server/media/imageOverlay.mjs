import { crc32, deflateSync, inflateSync } from 'node:zlib'
import jpeg from 'jpeg-js'
import { GenerationError } from '../generation/generationProvider.mjs'
import { compositionOverlayReferences, shouldPixelOverlayCompose } from '../generation/generationComposition.mjs'
import { detectImageFormat } from './mediaFormats.mjs'
import { normalizeRegionRect } from './regionMaskPng.mjs'

// 只用于 encodeRgbaPng 的写路径（构造输出字节）。读路径的格式判定改走权威的
// detectImageFormat——这是第六份手写 PNG 魔数比较，此前 4 份已收编进
// mediaFormats.mjs，读路径不该再单独维护一份。
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function pngChunk(type, data) {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(data.length, 0)
  header.write(type, 4, 'ascii')
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])) >>> 0, 0)
  return Buffer.concat([header, data, checksum])
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

function readPngChunks(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || detectImageFormat(buffer) !== 'image/png') return null
  const chunks = []
  let offset = 8
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii')
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (data.length !== length) return null
    chunks.push({ type, data })
    offset += 12 + length
    if (type === 'IEND') break
  }
  return chunks
}

function unfilter(raw, width, height, bpp) {
  const stride = width * bpp
  const out = Buffer.alloc(stride * height)
  let src = 0
  for (let row = 0; row < height; row += 1) {
    const filter = raw[src]
    src += 1
    const dest = row * stride
    for (let column = 0; column < stride; column += 1) {
      const value = raw[src]
      src += 1
      const left = column >= bpp ? out[dest + column - bpp] : 0
      const up = row > 0 ? out[dest - stride + column] : 0
      const upLeft = row > 0 && column >= bpp ? out[dest - stride + column - bpp] : 0
      const recon = filter === 0
        ? value
        : filter === 1
          ? (value + left) & 255
          : filter === 2
            ? (value + up) & 255
            : filter === 3
              ? (value + ((left + up) >> 1)) & 255
              : filter === 4
                ? (value + paeth(left, up, upLeft)) & 255
                : null
      if (recon === null) throw new GenerationError(422, 'INVALID_REFERENCE', '标识参考图的 PNG 滤波不受支持。')
      out[dest + column] = recon
    }
  }
  return out
}

function expandToRgba(samples, width, height, colorType, palette, transparency) {
  const rgba = Buffer.alloc(width * height * 4, 255)
  for (let index = 0; index < width * height; index += 1) {
    const dest = index * 4
    if (colorType === 6) {
      samples.copy(rgba, dest, index * 4, index * 4 + 4)
    } else if (colorType === 2) {
      samples.copy(rgba, dest, index * 3, index * 3 + 3)
      rgba[dest + 3] = 255
    } else if (colorType === 0) {
      const gray = samples[index]
      rgba[dest] = gray
      rgba[dest + 1] = gray
      rgba[dest + 2] = gray
    } else if (colorType === 4) {
      const gray = samples[index * 2]
      rgba[dest] = gray
      rgba[dest + 1] = gray
      rgba[dest + 2] = gray
      rgba[dest + 3] = samples[index * 2 + 1]
    } else if (colorType === 3 && palette) {
      const paletteIndex = samples[index]
      rgba[dest] = palette[paletteIndex * 3]
      rgba[dest + 1] = palette[paletteIndex * 3 + 1]
      rgba[dest + 2] = palette[paletteIndex * 3 + 2]
      rgba[dest + 3] = transparency?.[paletteIndex] ?? 255
    }
  }
  return { width, height, rgba }
}

export function decodeRgbaImage(buffer, mimeType = '') {
  const type = String(mimeType).toLowerCase()
  const isJpeg = type.includes('jpeg') || type.includes('jpg')
    || (Buffer.isBuffer(buffer) && buffer[0] === 0xff && buffer[1] === 0xd8)
  if (isJpeg) {
    const decoded = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true })
    return { width: decoded.width, height: decoded.height, rgba: Buffer.from(decoded.data) }
  }
  const chunks = readPngChunks(buffer)
  if (!chunks) throw new GenerationError(422, 'INVALID_REFERENCE', '贴标识无法读取该图片，请使用 PNG。')
  const ihdr = chunks.find((chunk) => chunk.type === 'IHDR')?.data
  if (!ihdr || ihdr.length < 13) throw new GenerationError(422, 'INVALID_REFERENCE', '贴标识无法读取该 PNG。')
  const width = ihdr.readUInt32BE(0)
  const height = ihdr.readUInt32BE(4)
  const bitDepth = ihdr[8]
  const colorType = ihdr[9]
  const interlace = ihdr[12]
  if (bitDepth !== 8 || interlace !== 0) {
    throw new GenerationError(422, 'INVALID_REFERENCE', '贴标识只支持 8 位非交错 PNG。')
  }
  const bytesPerPixel = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1
  const idat = Buffer.concat(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data))
  const raw = inflateSync(idat)
  const samples = unfilter(raw, width, height, bytesPerPixel)
  const palette = chunks.find((chunk) => chunk.type === 'PLTE')?.data
  const transparency = chunks.find((chunk) => chunk.type === 'tRNS')?.data
  return expandToRgba(samples, width, height, colorType, palette, transparency)
}

export function encodeRgbaPng({ width, height, rgba }) {
  const stride = width * 4 + 1
  const raw = Buffer.alloc(stride * height)
  for (let row = 0; row < height; row += 1) {
    const rowStart = row * stride
    rgba.copy(raw, rowStart + 1, row * width * 4, (row + 1) * width * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    pngSignature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function samplePixel(rgba, width, x, y) {
  const offset = (y * width + x) * 4
  return [rgba[offset], rgba[offset + 1], rgba[offset + 2], rgba[offset + 3]]
}

function colorDistance(left, right) {
  return Math.abs(left[0] - right[0]) + Math.abs(left[1] - right[1]) + Math.abs(left[2] - right[2])
}

/** 白底/黑底 logo 去掉衬底，保留图形本身。已有透明通道则不动。 */
export function knockoutMarkBackground({ width, height, rgba }) {
  let opaque = 0
  for (let index = 3; index < rgba.length; index += 4) {
    if (rgba[index] > 16) opaque += 1
  }
  if (opaque / (width * height) < 0.92) return { width, height, rgba: Buffer.from(rgba) }

  const corners = [
    samplePixel(rgba, width, 0, 0),
    samplePixel(rgba, width, width - 1, 0),
    samplePixel(rgba, width, 0, height - 1),
    samplePixel(rgba, width, width - 1, height - 1),
  ]
  const key = corners[0]
  if (corners.some((corner) => colorDistance(corner, key) > 36)) return { width, height, rgba: Buffer.from(rgba) }
  const next = Buffer.from(rgba)
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4
    if (colorDistance([next[offset], next[offset + 1], next[offset + 2]], key) <= 48) next[offset + 3] = 0
  }
  return { width, height, rgba: next }
}

function sampleNearest(rgba, width, height, x, y) {
  const column = Math.min(width - 1, Math.max(0, Math.round(x)))
  const row = Math.min(height - 1, Math.max(0, Math.round(y)))
  const offset = (row * width + column) * 4
  return [rgba[offset], rgba[offset + 1], rgba[offset + 2], rgba[offset + 3]]
}

export function overlayMarkOnBase({ base, mark, rect, inset = 0.08 }) {
  const dest = normalizeRegionRect(rect)
  if (!dest) throw new GenerationError(400, 'INVALID_MASK', '贴标识请先框选要放上去的位置。')
  const left = Math.max(0, Math.floor(dest.x * base.width))
  const top = Math.max(0, Math.floor(dest.y * base.height))
  const right = Math.min(base.width, Math.ceil((dest.x + dest.width) * base.width))
  const bottom = Math.min(base.height, Math.ceil((dest.y + dest.height) * base.height))
  const boxWidth = Math.max(1, right - left)
  const boxHeight = Math.max(1, bottom - top)
  const innerWidth = Math.max(1, Math.round(boxWidth * (1 - inset * 2)))
  const innerHeight = Math.max(1, Math.round(boxHeight * (1 - inset * 2)))
  const scale = Math.min(innerWidth / mark.width, innerHeight / mark.height)
  const drawWidth = Math.max(1, Math.round(mark.width * scale))
  const drawHeight = Math.max(1, Math.round(mark.height * scale))
  const originX = left + Math.floor((boxWidth - drawWidth) / 2)
  const originY = top + Math.floor((boxHeight - drawHeight) / 2)
  const out = Buffer.from(base.rgba)
  for (let row = 0; row < drawHeight; row += 1) {
    for (let column = 0; column < drawWidth; column += 1) {
      const destX = originX + column
      const destY = originY + row
      if (destX < 0 || destY < 0 || destX >= base.width || destY >= base.height) continue
      const source = sampleNearest(
        mark.rgba,
        mark.width,
        mark.height,
        (column + 0.5) * mark.width / drawWidth - 0.5,
        (row + 0.5) * mark.height / drawHeight - 0.5,
      )
      const srcA = source[3] / 255
      if (srcA <= 0) continue
      const destOffset = (destY * base.width + destX) * 4
      const dstA = out[destOffset + 3] / 255
      const outA = srcA + dstA * (1 - srcA)
      for (let channel = 0; channel < 3; channel += 1) {
        const srcC = source[channel]
        const dstC = out[destOffset + channel]
        out[destOffset + channel] = Math.round((srcC * srcA + dstC * dstA * (1 - srcA)) / (outA || 1))
      }
      out[destOffset + 3] = Math.round(outA * 255)
    }
  }
  return { width: base.width, height: base.height, rgba: out }
}

export function composeMarkOverlayPng({ baseBuffer, baseMimeType, markBuffer, markMimeType, rect }) {
  const base = decodeRgbaImage(baseBuffer, baseMimeType)
  const mark = knockoutMarkBackground(decodeRgbaImage(markBuffer, markMimeType))
  return encodeRgbaPng(overlayMarkOnBase({ base, mark, rect }))
}

export async function composeOverlayImages(job, { persistImage, jobId, onVariant, completedVariants = [] }) {
  const prior = completedVariants.find((variant) => variant?.status === 'succeeded' && variant.output)
  if (prior?.output) return { outputs: [prior.output], missingOutputCount: Math.max(0, (job.batchCount ?? 1) - 1) }
  const base = job.parent ?? job.references?.[0]
  const mark = compositionOverlayReferences(job.references).at(-1)
    ?? (job.parent ? job.references?.[0] : job.references?.[1])
  if (!base?.buffer || !mark?.buffer) {
    throw new GenerationError(400, 'INVALID_REFERENCE', '贴标识需要一张底图和一张标识参考图。')
  }
  if (!job.maskRegion) {
    throw new GenerationError(400, 'INVALID_MASK', '贴标识请先框选要放上去的位置。')
  }
  await onVariant?.({ index: 0, status: 'running' })
  const png = composeMarkOverlayPng({
    baseBuffer: base.buffer,
    baseMimeType: base.mimeType,
    markBuffer: mark.buffer,
    markMimeType: mark.mimeType,
    rect: job.maskRegion,
  })
  const output = {
    id: `${jobId}-output-1`,
    image: await persistImage({ mimeType: 'image/png', dataUrl: `data:image/png;base64,${png.toString('base64')}` }),
    mediaKind: 'image',
  }
  await onVariant?.({ index: 0, status: 'succeeded', output })
  return {
    outputs: [output],
    missingOutputCount: Math.max(0, (job.batchCount ?? 1) - 1),
  }
}

export function jobRequestsPixelOverlay(job) {
  return shouldPixelOverlayCompose({
    prompt: job.prompt,
    maskRegion: job.maskRegion,
    references: job.references,
    composeMode: job.composeMode ?? job.recipe?.composeMode,
  })
}
