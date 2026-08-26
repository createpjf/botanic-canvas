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

/**
 * 我们存储、并交给供应商的格式——这是供应商约束，不是偏好。
 *
 * PR-A 内刻意等于 `UPLOAD_IMAGE_FORMATS`（两者当前逐项相同），但含义不同，
 * 不能合并成一份：`UPLOAD_*` 回答「用户能交给我们什么」，这里回答「我们能
 * 转交给供应商什么」。任何只吃字节、并把字节送往生成接口的路径都该按这份
 * 词表校验——按 UPLOAD 词表校验只是巧合地等价，放宽 UPLOAD 词表那天就会
 * 悄悄跟着放宽本不该放宽的供应商准入。
 */
export const CANONICAL_IMAGE_FORMATS = [
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
const canonicalImageFormatSet = new Set<string>(CANONICAL_IMAGE_FORMATS)

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

/**
 * 判断某个 MIME 类型是否在 canonical 词表内。
 *
 * 给「字节最终会被发去生成接口」的路径用——例如 Agent 参考图在客户端读完
 * blob 之后、上传前的早筛。不要在这类路径上误用 `isUploadImageFormat`：
 * 两个词表当前恰好相同，但含义不同，PR-B 放宽 UPLOAD 词表时两者会分叉。
 */
export function isCanonicalImageFormat(mimeType: unknown) {
  return typeof mimeType === 'string' && canonicalImageFormatSet.has(mimeType.trim().toLowerCase())
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

/** 把一组格式短名拼成从句，英文按串列逗号（Oxford comma），中文按顿号+或。 */
function joinFormatSentence(labels: string[], locale: ProductLocale) {
  if (labels.length <= 1) return labels.join('')
  // 英文用串列逗号：多于两项时最后一个连接词前也要有逗号，否则
  // "PNG, JPEG or WebP" 在语法上会被读成两项并列，与中文的顿号+或不对称。
  return locale === 'en'
    ? labels.length > 2
      ? `${labels.slice(0, -1).join(', ')}, or ${labels.at(-1)}`
      : `${labels.slice(0, -1).join(', ')} or ${labels.at(-1)}`
    : `${labels.slice(0, -1).join('、')} 或 ${labels.at(-1)}`
}

/**
 * 完整句子里嵌入的格式枚举，如「PNG、JPEG 或 WebP」/ `PNG, JPEG, or WebP`。
 *
 * 与 `unsupportedUploadMessage` 内部的顿号连写是两种场合：那里是「仅支持 A、B、C」
 * 的清单式收尾，这里是需要语法完整的从句，写死任一种都会在另一种场合读起来别扭。
 *
 * 列的是 **upload** 词表——给「提示用户能上传什么」的场合用。字节最终要被
 * 转交给生成接口的场合请用 `canonicalImageFormatSentenceList`。
 */
export function imageFormatSentenceList(locale: ProductLocale = 'zh-CN') {
  return joinFormatSentence(supportedImageFormatLabels(), locale)
}

/** canonical 词表的人话短名，供需要自己拼句子的调用方用。 */
function canonicalImageFormatLabels() {
  return CANONICAL_IMAGE_FORMATS.map((format) => FORMAT_LABELS[format] ?? format)
}

/**
 * canonical 词表的句子式枚举，如「PNG、JPEG 或 WebP」/ `PNG, JPEG, or WebP`。
 *
 * 给「字节最终会被发去生成接口」的提示用——目前是 Agent 参考图上传前的早筛
 * 报错。与 `imageFormatSentenceList` 是同一句式，仅词表来源不同；当前两份
 * 词表逐项相同所以文案恰好一致，但含义各自独立，不应合并成一个函数。
 */
export function canonicalImageFormatSentenceList(locale: ProductLocale = 'zh-CN') {
  return joinFormatSentence(canonicalImageFormatLabels(), locale)
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
