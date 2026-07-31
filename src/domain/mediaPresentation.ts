import type { GenerationMediaKind } from './canvas.ts'

export function reducedAspectRatio(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return undefined
  let left = width
  let right = height
  while (right) [left, right] = [right, left % right]
  return `${width / left}:${height / left}`
}

export function mediaFileExtension(mediaKind: GenerationMediaKind, mimeType = '') {
  if (mediaKind === 'video') return 'mp4'
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/webp') return 'webp'
  return 'png'
}
