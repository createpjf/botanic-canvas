import type { GenerationMediaKind } from '../domain/canvas'
import { mediaFileExtension } from '../domain/mediaPresentation'

function triggerDownload(source: string, filename: string) {
  const anchor = document.createElement('a')
  anchor.href = source
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

export async function downloadMedia(image: string, name: string, mediaKind: GenerationMediaKind = 'image') {
  const safeName = name.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-').slice(0, 80) || `botanic-${mediaKind}`
  if (mediaKind === 'video') {
    // 视频直接交给浏览器流式下载，避免先把完整 MP4 读入内存后丢失用户手势。
    triggerDownload(image, `${safeName}.${mediaFileExtension(mediaKind)}`)
    return
  }
  try {
    const response = await fetch(image)
    if (!response.ok) throw new Error('图片下载失败')
    const blob = await response.blob()
    const extension = mediaFileExtension(mediaKind, blob.type)
    const objectUrl = URL.createObjectURL(blob)
    triggerDownload(objectUrl, `${safeName}.${extension}`)
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000)
  } catch {
    const anchor = document.createElement('a')
    anchor.href = image
    anchor.download = `${safeName}.png`
    anchor.target = '_blank'
    anchor.rel = 'noreferrer'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  }
}
