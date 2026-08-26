import type { UploadedAssetInput } from '../domain/canvas'
import type { ProductLocale } from '../i18n/core'
// 显式 .ts 后缀：本文件被 uploadedAssets.test.ts 用 node --experimental-strip-types
// 直接加载执行（不经 Vite 打包），Node 的 ESM 解析不会像 Vite 那样补全省略的扩展名。
import { MEDIA_LIMITS, UPLOAD_IMAGE_FORMATS, unsupportedUploadMessage } from '../domain/mediaFormats.ts'
import { pastedAssetName } from '../domain/clipboardMedia.ts'

export const maxUploadAssets = 12
const supportedUploadTypes = new Set<string>(UPLOAD_IMAGE_FORMATS)

export function validateUploadFiles(files: File[], locale: ProductLocale = 'zh-CN') {
  const accepted = files.filter((file) => (
    supportedUploadTypes.has(file.type) && file.size > 0 && file.size <= MEDIA_LIMITS.maxUploadBytes
  ))
  const rejected = files.length - accepted.length
  return { accepted, message: rejected ? unsupportedUploadMessage(rejected, locale) : '' }
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
  options: { source?: 'drop' | 'paste'; now?: Date; locale?: ProductLocale } = {},
): Promise<UploadedAssetInput> {
  const image = await readFileAsDataUrl(file)
  const { width: imageWidth, height: imageHeight } = await readImageDimensions(image)
  const pathSegments = file.webkitRelativePath.split('/').filter(Boolean)
  const folderName = pathSegments[0]
  const collection = pathSegments.length > 1 ? pathSegments.slice(0, -1).join(' / ') : undefined
  return {
    name: pastedAssetName(file.name, options),
    image,
    imageWidth,
    imageHeight,
    role,
    mediaKind: 'image',
    collection,
    tags: folderName ? ['上传素材', folderName] : ['上传素材'],
  }
}
