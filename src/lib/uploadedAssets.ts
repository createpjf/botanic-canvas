import type { UploadedAssetInput } from '../domain/canvas'
import type { ProductLocale } from '../i18n/core'

export const maxUploadAssets = 12
const maximumUploadImageBytes = 8 * 1024 * 1024
const supportedUploadTypes = new Set(['image/png', 'image/jpeg', 'image/webp'])

export function validateUploadFiles(files: File[], locale: ProductLocale = 'zh-CN') {
  const accepted = files.filter((file) => supportedUploadTypes.has(file.type) && file.size > 0 && file.size <= maximumUploadImageBytes)
  const rejected = files.length - accepted.length
  const message = rejected
    ? locale === 'en'
      ? `Skipped ${rejected} ${rejected === 1 ? 'file' : 'files'}. Upload PNG, JPEG, or WebP images up to 8 MB each.`
      : `已跳过 ${rejected} 个文件：仅支持 PNG、JPEG、WebP，单张不超过 8MB。`
    : ''
  return { accepted, message }
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('读取图片失败'))
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

function readImageDimensions(source: string) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => reject(new Error('无法读取图片尺寸'))
    image.src = source
  })
}

export async function readUploadedAssetInput(
  file: File,
  role: UploadedAssetInput['role'],
): Promise<UploadedAssetInput> {
  const image = await readFileAsDataUrl(file)
  const { width: imageWidth, height: imageHeight } = await readImageDimensions(image)
  const pathSegments = file.webkitRelativePath.split('/').filter(Boolean)
  const folderName = pathSegments[0]
  const collection = pathSegments.length > 1 ? pathSegments.slice(0, -1).join(' / ') : undefined
  return {
    name: file.name.replace(/\.[^.]+$/, ''),
    image,
    imageWidth,
    imageHeight,
    role,
    mediaKind: 'image',
    collection,
    tags: folderName ? ['上传素材', folderName] : ['上传素材'],
  }
}
