// @ts-check

/**
 * 媒体格式的唯一权威词表。
 *
 * 此前 `png|jpeg|webp` 硬编码在 9 处、字节嗅探有 4 份独立实现，改一次格式支持
 * 要同时动 9 个地方 —— 漂移只是时间问题。
 *
 * **三个集合不是一个，不得合并：**
 *
 * - `UPLOAD_*`：用户可以交给我们的。
 * - `CANONICAL_IMAGE_FORMATS`：我们存储、并交给供应商的。这是**供应商约束**，
 *   不是偏好 —— OpenAI images/edits 只吃这三个。
 *
 * 把两者合并，就是把归一化层存在的理由藏起来。生产上已经付过一次代价：白名单说
 * JPEG 没问题，供应商不同意，用户拿到一句「请联系 help.openai.com」。
 */

/** 我们存储并交给供应商的格式。 */
export const CANONICAL_IMAGE_FORMATS = Object.freeze(['image/png', 'image/jpeg', 'image/webp'])

/**
 * 用户可以上传的图片格式。
 *
 * **PR-A 内刻意等于 canonical。** 放宽它必须与客户端归一化器同一个 PR 落地 ——
 * 只放宽 `accept=` 而归一化器没上，用户就能在文件选择器里选中 HEIC，然后必然失败。
 * PR-B 会把 avif/gif/bmp/heic/heif/svg+xml 加进来。
 */
export const UPLOAD_IMAGE_FORMATS = Object.freeze(['image/png', 'image/jpeg', 'image/webp'])

/** 文档库接受的格式。pptx/xlsx 与 docx 同为 zip+XML，复用同一套解包。 */
export const UPLOAD_DOCUMENT_FORMATS = Object.freeze([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'text/plain',
  'text/markdown',
])

/**
 * 所有上限收成具名常量。
 *
 * `maxCanonicalPixels`：凡是我们自己能生成的尺寸，就必须能被重新接收——精修、
 * 局部重绘都会把上一次的生成结果原样传回来当 parent。接收预算按当前最大
 * 可生成输出（Nano Banana 4K 方图 4096×4096）计，不再绑死 gpt-image-2
 * 自定义像素窗（那是 OpenAI 自己的 8.29MP 限制）。
 */
export const MEDIA_LIMITS = Object.freeze({
  maxCanonicalPixels: 4096 * 4096,
  // 注意：这不是准入门槛的一部分。它只是后续 PR 里归一化器的下采样目标——
  // 超过 maxCanonicalPixels 但长边不超此值的图会被下采样，而不是被拒绝。
  // 曾经把它错当拒绝判据的一个连接词（"且长边 ≤ 2048"），直接把 App 自己生成
  // 的 2048×2048（2K + 1:1 预设，也是默认分辨率）挡在门外，导致对自己最常见
  // 输出的精修全部失败。不要在 assertImagePixelBudget 里再次引用这个字段。
  maxCanonicalLongEdge: 4096,
  maxUploadBytes: 8 * 1024 * 1024,
  // Provider 生成的 4K PNG 可能明显大于用户上传上限；只要 Botanic 接受并保存了
  // 输出，就必须能把它作为下一轮 parent/reference 重新接收。
  maxGeneratedImageBytes: 32 * 1024 * 1024,
  maxGenerationInputBytes: 48 * 1024 * 1024,
  // 生产存储里存在 96 MP（8488×11317）JPEG，解成 RGBA 约 384 MB。解压炸弹防线。
  maxDecodePixels: 80_000_000,
  maxDocumentPages: 200,
  maxExtractedChars: 200_000,
})

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** ftyp 品牌 → 格式。HEIF 家族的标识在 **offset 4**，不在文件头。 */
const FTYP_BRANDS = Object.freeze({
  heic: 'image/heic', heix: 'image/heic', hevc: 'image/heic', hevx: 'image/heic',
  mif1: 'image/heic', msf1: 'image/heic', heim: 'image/heic', heis: 'image/heic',
  avif: 'image/avif', avis: 'image/avif',
})

/** 导出供 `scripts/mediaFormatContract.test.mjs` 与 `src/domain/mediaFormats.ts` 的副本逐项比对。 */
export const FORMAT_LABELS = Object.freeze({
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/webp': 'WebP',
  'image/avif': 'AVIF',
  'image/gif': 'GIF',
  'image/bmp': 'BMP',
  'image/heic': 'HEIC',
  'image/heif': 'HEIF',
  'image/svg+xml': 'SVG',
})

/**
 * 从字节判断图片格式。
 *
 * **识别 ≠ 接受。** 这里认得出我们当前还不接受的格式，是为了让错误能说出
 * 「不支持 HEIC」而不是「无法识别的文件」—— 后者会让用户以为文件坏了。
 * 是否接受由 `isUploadImageFormat` 决定。
 *
 * @param {Buffer} buffer
 * @returns {string | undefined}
 */
export function detectImageFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return undefined
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.length >= 12
    && buffer.subarray(0, 4).toString('latin1') === 'RIFF'
    && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('latin1') === 'ftyp') {
    // 品牌在 offset 8。按偏移取，不能假设魔数在文件头。
    return FTYP_BRANDS[buffer.subarray(8, 12).toString('latin1').toLowerCase()]
  }
  const head = buffer.subarray(0, 6).toString('latin1')
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif'
  if (buffer.length >= 14 && head.startsWith('BM')) return 'image/bmp'
  return undefined
}

/**
 * 从文件头读像素尺寸；认不出返回 `null`。
 *
 * 返回 `null`（而非 `undefined`）是既有契约，`regionMaskPng.test.mjs` 与
 * `generationProvider.test.mjs` 都断言它。
 *
 * @param {Buffer} buffer
 * @returns {{ width: number, height: number } | null}
 */
export function imagePixelSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null
  return pngPixelSize(buffer) ?? jpegPixelSize(buffer) ?? webpPixelSize(buffer) ?? null
}

function pngPixelSize(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined
  if (buffer.subarray(12, 16).toString('latin1') !== 'IHDR') return undefined
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/**
 * JPEG 要跳段找 SOF。
 *
 * 这是原 `mediaSpec.mjs` 的实现，比原 `regionMaskPng.mjs` 的更健壮：跳过
 * SOI/EOI/RSTn/TEM 这些没有长度字段的标记，且遇到非 `0xff` 填充字节继续前进
 * 而不是直接放弃。收编时必须保留这一份，用另一份是能力回退。
 */
function jpegPixelSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined
  let offset = 2
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = buffer[offset + 1]
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2
      continue
    }
    const length = buffer.readUInt16BE(offset + 2)
    // SOF0..SOF15，跳过 DHT(c4)/JPG(c8)/DAC(cc)：它们不是帧头。
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
    }
    if (length < 2) return undefined
    offset += 2 + length
  }
  return undefined
}

/** WebP：VP8X 有显式画布尺寸；VP8（有损）与 VP8L（无损）位布局不同。 */
function webpPixelSize(buffer) {
  if (buffer.length < 25) return undefined
  if (buffer.subarray(0, 4).toString('latin1') !== 'RIFF') return undefined
  if (buffer.subarray(8, 12).toString('latin1') !== 'WEBP') return undefined
  const chunk = buffer.subarray(12, 16).toString('latin1')
  if (chunk === 'VP8X' && buffer.length >= 30) {
    return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 }
  }
  if (chunk === 'VP8 ' && buffer.length >= 30) {
    // 关键帧起始码 0x9d012a（偏移 23-25）不校验就直接读宽高，会在损坏的有损
    // WebP 上编造出一对看似合法的数字，而不是老实说"读不出"——这两者的下游
    // 后果不同：前者喂给评审第 1 层是自信的错判，后者是 unverifiable。
    if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) return undefined
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
  }
  if (chunk === 'VP8L' && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return undefined
}

function normalized(mimeType) {
  return typeof mimeType === 'string' ? mimeType.trim().toLowerCase() : ''
}

/** @param {unknown} mimeType */
export function isCanonicalImageFormat(mimeType) {
  return CANONICAL_IMAGE_FORMATS.includes(normalized(mimeType))
}

/** @param {unknown} mimeType */
export function isUploadImageFormat(mimeType) {
  return UPLOAD_IMAGE_FORMATS.includes(normalized(mimeType))
}

/** 人话格式名。未知类型原样回显 —— 静默变空会让错误信息读起来像坏了。 */
export function imageFormatLabel(mimeType) {
  return FORMAT_LABELS[normalized(mimeType)] ?? String(mimeType)
}

/**
 * canonical 格式的句子式枚举，如「PNG、JPEG 或 WebP」。
 *
 * 服务端错误文案目前只有中文，故不带 locale 参数 —— 客户端双语版在
 * `src/domain/mediaFormats.ts` 的 `imageFormatSentenceList`。两处从各自的
 * 词表派生，靠 `scripts/mediaFormatContract.test.mjs` 保证词表本身一致。
 */
export function canonicalImageFormatSentenceList() {
  const labels = CANONICAL_IMAGE_FORMATS.map((format) => FORMAT_LABELS[format] ?? format)
  return labels.length > 1 ? `${labels.slice(0, -1).join('、')} 或 ${labels.at(-1)}` : labels.join('')
}

/** canonical 图片 data URL 的正则。每次新建，避免共享 lastIndex。 */
export function canonicalImageDataUrlPattern() {
  const alternatives = CANONICAL_IMAGE_FORMATS
    .map((format) => format.replace('image/', '').replace(/[+]/g, '\\+'))
    .join('|')
  return new RegExp(`^data:(image\\/(?:${alternatives}));base64,([A-Za-z0-9+/=\\s]+)$`, 'i')
}
