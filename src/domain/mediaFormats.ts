import type { ProductLocale } from '../i18n/core'

/**
 * 图片格式词表的**客户端副本**。
 *
 * 权威在 `server/mediaFormats.mjs`。架构门禁禁止 `src/` 导入 `server/`，
 * 所以只能有两份；`scripts/mediaFormatContract.test.mjs` 断言两边一致。
 * 这与 `src/domain/projectCapabilities.ts` 对服务端权限表的处理是同一手法。
 *
 * 客户端只需要「用户能选什么」与「单文件多大」——**校验仍在服务端**。
 * `accept=` 是提示，不是边界：拖放和粘贴都能绕过它。
 */
export const UPLOAD_IMAGE_FORMATS = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const

export const MEDIA_LIMITS = {
  maxUploadBytes: 8 * 1024 * 1024,
} as const

/** `<input type="file">` 的 accept 属性。手写它必然与词表漂移。 */
export function imageUploadAccept() {
  return UPLOAD_IMAGE_FORMATS.join(',')
}

const FORMAT_LABELS: Record<string, string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/webp': 'WebP',
  'image/avif': 'AVIF',
  'image/gif': 'GIF',
  'image/bmp': 'BMP',
  'image/heic': 'HEIC',
  'image/heif': 'HEIF',
  'image/svg+xml': 'SVG',
}

function supportedLabels() {
  return UPLOAD_IMAGE_FORMATS.map((format) => FORMAT_LABELS[format] ?? format)
}

/**
 * 文件被跳过时的提示。
 *
 * 必须列出**实际支持的格式**而不是写死一串字面量 —— 否则放宽词表后这句话就在说谎。
 */
export function unsupportedUploadMessage(count: number, locale: ProductLocale = 'zh-CN') {
  const megabytes = Math.floor(MEDIA_LIMITS.maxUploadBytes / 1024 / 1024)
  if (locale === 'en') {
    const labels = supportedLabels()
    const listed = labels.length > 1
      ? `${labels.slice(0, -1).join(', ')} or ${labels.at(-1)}`
      : labels.join('')
    return `Skipped ${count} ${count === 1 ? 'file' : 'files'}. Upload ${listed} images up to ${megabytes} MB each.`
  }
  return `已跳过 ${count} 个文件：仅支持 ${supportedLabels().join('、')}，单张不超过 ${megabytes}MB。`
}
