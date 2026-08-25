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

// `as const` 元组的字面量联合类型让 `Array.includes` 拒绝原始 string 入参
// （blob.type / file.type 都是 string）。转成 Set<string> 一次性抹平这个类型摩擦，
// 与 `src/lib/uploadedAssets.ts` 里 `supportedUploadTypes` 的写法同一手法。
const uploadImageFormatSet = new Set<string>(UPLOAD_IMAGE_FORMATS)

/**
 * 判断某个 MIME 类型是否在用户可上传的词表内。
 *
 * 仅供客户端早筛（比如拒绝一个刚 fetch 回来的 blob）；真正的校验边界仍在服务端
 * 的 `isUploadImageFormat`（`server/mediaFormats.mjs`），两者从各自词表派生，
 * 不共享实现——架构门禁不允许 `src/` 导入 `server/`。
 */
export function isUploadImageFormat(mimeType: unknown) {
  return typeof mimeType === 'string' && uploadImageFormatSet.has(mimeType.trim().toLowerCase())
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

/** 支持格式的人话短名，如 `['PNG', 'JPEG', 'WebP']`。给需要自己拼句子的调用方用。 */
export function supportedImageFormatLabels() {
  return UPLOAD_IMAGE_FORMATS.map((format) => FORMAT_LABELS[format] ?? format)
}

/** 字节上限，换算成整数 MB。上传提示与限制文案共用，不各自写一遍换算。 */
function maxUploadMegabytes() {
  return Math.floor(MEDIA_LIMITS.maxUploadBytes / 1024 / 1024)
}

/**
 * 素材选择器 / 拖放区这类简短场景用的格式提示，如 `PNG / JPEG / WebP`。
 *
 * 格式缩写本身不分语言，所以不需要 locale 参数。
 */
export function imageFormatShortList() {
  return supportedImageFormatLabels().join(' / ')
}

/**
 * 完整句子里嵌入的格式枚举，如「PNG、JPEG 或 WebP」/ `PNG, JPEG or WebP`。
 *
 * 与 `unsupportedUploadMessage` 内部的顿号连写是两种场合：那里是「仅支持 A、B、C」
 * 的清单式收尾，这里是需要语法完整的从句，写死任一种都会在另一种场合读起来别扭。
 */
export function imageFormatSentenceList(locale: ProductLocale = 'zh-CN') {
  const labels = supportedImageFormatLabels()
  if (labels.length <= 1) return labels.join('')
  return locale === 'en'
    ? `${labels.slice(0, -1).join(', ')} or ${labels.at(-1)}`
    : `${labels.slice(0, -1).join('、')} 或 ${labels.at(-1)}`
}

/**
 * 上传限制提示，如「PNG / JPEG / WebP，单张不超过 8MB」。
 *
 * 格式与体积上限都从词表 / `MEDIA_LIMITS` 派生 —— 两者任一改变，这句话都不用改。
 */
export function uploadLimitsLabel(locale: ProductLocale = 'zh-CN') {
  const megabytes = maxUploadMegabytes()
  return locale === 'en'
    ? `${imageFormatShortList()}, up to ${megabytes} MB each`
    : `${imageFormatShortList()}，单张不超过 ${megabytes}MB`
}

/**
 * 文件被跳过时的提示。
 *
 * 必须列出**实际支持的格式**而不是写死一串字面量 —— 否则放宽词表后这句话就在说谎。
 */
export function unsupportedUploadMessage(count: number, locale: ProductLocale = 'zh-CN') {
  const megabytes = maxUploadMegabytes()
  if (locale === 'en') {
    const labels = supportedImageFormatLabels()
    const listed = labels.length > 1
      ? `${labels.slice(0, -1).join(', ')} or ${labels.at(-1)}`
      : labels.join('')
    return `Skipped ${count} ${count === 1 ? 'file' : 'files'}. Upload ${listed} images up to ${megabytes} MB each.`
  }
  return `已跳过 ${count} 个文件：仅支持 ${supportedImageFormatLabels().join('、')}，单张不超过 ${megabytes}MB。`
}
