import type { GenerationMediaKind } from '../domain/canvas'
import { mediaFileExtension } from '../domain/mediaPresentation'
import { fetchMediaBlob } from './mediaFetch'

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
  try {
    const blob = await fetchMediaBlob(image)
    const extension = mediaFileExtension(mediaKind, blob.type)
    const objectUrl = URL.createObjectURL(blob)
    triggerDownload(objectUrl, `${safeName}.${extension}`)
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000)
    return { fileName: `${safeName}.${extension}`, byteSize: blob.size }
  } catch (error) {
    window.alert(error instanceof Error ? error.message : '媒体下载失败，请重新登录后重试。')
    return null
  }
}
