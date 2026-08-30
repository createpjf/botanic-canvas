import type { DeliveryArtifact, DeliveryPresetId } from '../domain/canvas'
import { fetchMediaBlob } from './mediaFetch'

export type DeliveryPreset = {
  id: DeliveryPresetId
  label: string
  channel: string
  ratio: string
  width: number
  height: number
  filename: string
}

export const deliveryPresets: DeliveryPreset[] = [
  {
    id: 'taobao',
    label: '淘宝 / 天猫主图',
    channel: '淘宝',
    ratio: '1:1',
    width: 800,
    height: 800,
    filename: 'taobao-main-800x800.png',
  },
  {
    id: 'xiaohongshu',
    label: '小红书笔记',
    channel: '小红书',
    ratio: '3:4',
    width: 1242,
    height: 1660,
    filename: 'xiaohongshu-note-1242x1660.png',
  },
  {
    id: 'douyin',
    label: '抖音图文',
    channel: '抖音',
    ratio: '9:16',
    width: 1080,
    height: 1920,
    filename: 'douyin-post-1080x1920.png',
  },
]

export function getDeliveryPreset(id: DeliveryPresetId) {
  const preset = deliveryPresets.find((item) => item.id === id)
  if (!preset) throw new Error(`未知投放规格：${id}`)
  return preset
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('无法读取首图，导出已取消'))
    image.src = src
  })
}

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('无法生成投放图片'))
    }, 'image/png')
  })
}

function drawCover(context: CanvasRenderingContext2D, image: HTMLImageElement, width: number, height: number) {
  const imageWidth = image.naturalWidth || image.width
  const imageHeight = image.naturalHeight || image.height
  if (!imageWidth || !imageHeight) throw new Error('首图尺寸无效')

  const scale = Math.max(width / imageWidth, height / imageHeight)
  const drawWidth = imageWidth * scale
  const drawHeight = imageHeight * scale
  context.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight)
}

function wrapText(context: CanvasRenderingContext2D, value: string, maxWidth: number) {
  const lines: string[] = []
  let line = ''
  for (const character of value) {
    const next = line + character
    if (line && context.measureText(next).width > maxWidth) {
      lines.push(line)
      line = character
    } else {
      line = next
    }
  }
  if (line) lines.push(line)
  return lines
}

function drawCopy(context: CanvasRenderingContext2D, artifact: DeliveryArtifact, width: number, height: number) {
  if (!artifact.title && !artifact.subtitle) return

  const inset = Math.round(width * 0.08)
  const titleSize = Math.max(34, Math.round(width * 0.065))
  const subtitleSize = Math.max(20, Math.round(width * 0.034))
  const titleLineHeight = Math.round(titleSize * 1.2)
  const subtitleLineHeight = Math.round(subtitleSize * 1.45)
  const top = Math.round(height * 0.095)
  const maxWidth = width - inset * 2
  const gradient = context.createLinearGradient(0, 0, 0, height * 0.32)
  gradient.addColorStop(0, 'rgba(11, 21, 13, 0.66)')
  gradient.addColorStop(0.7, 'rgba(11, 21, 13, 0.18)')
  gradient.addColorStop(1, 'rgba(11, 21, 13, 0)')
  context.fillStyle = gradient
  context.fillRect(0, 0, width, Math.round(height * 0.36))

  let y = top
  context.textBaseline = 'top'
  context.fillStyle = '#ffffff'
  context.shadowColor = 'rgba(0, 0, 0, 0.28)'
  context.shadowBlur = 8

  if (artifact.title) {
    context.font = `700 ${titleSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`
    wrapText(context, artifact.title, maxWidth).slice(0, 2).forEach((line) => {
      context.fillText(line, inset, y)
      y += titleLineHeight
    })
  }
  if (artifact.subtitle) {
    y += Math.round(height * 0.012)
    context.font = `500 ${subtitleSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`
    context.fillStyle = 'rgba(255, 255, 255, 0.9)'
    wrapText(context, artifact.subtitle, maxWidth).slice(0, 2).forEach((line) => {
      context.fillText(line, inset, y)
      y += subtitleLineHeight
    })
  }
  context.shadowBlur = 0
}

async function renderArtifact(artifact: DeliveryArtifact) {
  const preset = getDeliveryPreset(artifact.presetId)
  const source = URL.createObjectURL(await fetchMediaBlob(artifact.image))
  const image = await loadImage(source).finally(() => URL.revokeObjectURL(source))
  const canvas = document.createElement('canvas')
  canvas.width = preset.width
  canvas.height = preset.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('浏览器不支持图片导出')
  drawCover(context, image, preset.width, preset.height)
  drawCopy(context, artifact, preset.width, preset.height)
  return canvasToBlob(canvas)
}

type ZipEntry = {
  name: string
  data: Uint8Array
}

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array) {
  let value = 0xffffffff
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function writeUint16(bytes: Uint8Array, offset: number, value: number) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(offset, value, true)
}

function writeUint32(bytes: Uint8Array, offset: number, value: number) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true)
}

function createZip(entries: ZipEntry[]) {
  const encoder = new TextEncoder()
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let localOffset = 0
  let centralSize = 0

  entries.forEach((entry) => {
    const filename = encoder.encode(entry.name)
    const checksum = crc32(entry.data)
    const local = new Uint8Array(30 + filename.length + entry.data.length)
    writeUint32(local, 0, 0x04034b50)
    writeUint16(local, 4, 20)
    writeUint16(local, 6, 0x0800)
    writeUint16(local, 8, 0)
    writeUint16(local, 10, 0)
    writeUint16(local, 12, 0)
    writeUint32(local, 14, checksum)
    writeUint32(local, 18, entry.data.length)
    writeUint32(local, 22, entry.data.length)
    writeUint16(local, 26, filename.length)
    writeUint16(local, 28, 0)
    local.set(filename, 30)
    local.set(entry.data, 30 + filename.length)
    localParts.push(local)

    const central = new Uint8Array(46 + filename.length)
    writeUint32(central, 0, 0x02014b50)
    writeUint16(central, 4, 20)
    writeUint16(central, 6, 20)
    writeUint16(central, 8, 0x0800)
    writeUint16(central, 10, 0)
    writeUint16(central, 12, 0)
    writeUint16(central, 14, 0)
    writeUint32(central, 16, checksum)
    writeUint32(central, 20, entry.data.length)
    writeUint32(central, 24, entry.data.length)
    writeUint16(central, 28, filename.length)
    writeUint16(central, 30, 0)
    writeUint16(central, 32, 0)
    writeUint16(central, 34, 0)
    writeUint16(central, 36, 0)
    writeUint32(central, 38, 0)
    writeUint32(central, 42, localOffset)
    central.set(filename, 46)
    centralParts.push(central)

    localOffset += local.length
    centralSize += central.length
  })

  const end = new Uint8Array(22)
  writeUint32(end, 0, 0x06054b50)
  writeUint16(end, 4, 0)
  writeUint16(end, 6, 0)
  writeUint16(end, 8, entries.length)
  writeUint16(end, 10, entries.length)
  writeUint32(end, 12, centralSize)
  writeUint32(end, 16, localOffset)
  writeUint16(end, 20, 0)
  const toArrayBuffer = (bytes: Uint8Array) => {
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    return copy.buffer
  }
  return new Blob([...localParts, ...centralParts, end].map(toArrayBuffer), { type: 'application/zip' })
}

export async function downloadDeliveryPackage(artifacts: DeliveryArtifact[]) {
  if (!artifacts.length) throw new Error('请先生成至少一个投放预览')

  const files = await Promise.all(artifacts.map(async (artifact) => {
    const preset = getDeliveryPreset(artifact.presetId)
    const blob = await renderArtifact(artifact)
    return {
      name: preset.filename,
      data: new Uint8Array(await blob.arrayBuffer()),
    }
  }))
  const manifest = {
    product: 'Botanic',
    kind: 'local-delivery-package',
    exportedAt: new Date().toISOString(),
    notice: '图片为本地比例派生；尚未调用真实投放平台 API。',
    artifacts: artifacts.map((artifact) => {
      const preset = getDeliveryPreset(artifact.presetId)
      return {
        channel: preset.channel,
        preset: preset.label,
        ratio: preset.ratio,
        size: `${preset.width}x${preset.height}`,
        file: preset.filename,
        source: artifact.targetLabel,
        title: artifact.title,
        subtitle: artifact.subtitle,
        safeZone: artifact.safeZone,
      }
    }),
  }
  const encoder = new TextEncoder()
  const zip = createZip([
    ...files,
    { name: 'manifest.json', data: encoder.encode(JSON.stringify(manifest, null, 2)) },
  ])
  const href = URL.createObjectURL(zip)
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = `botanic-delivery-${new Date().toISOString().slice(0, 10)}.zip`
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(href), 1_000)
  return { fileCount: files.length + 1 }
}
