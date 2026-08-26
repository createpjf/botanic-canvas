# PR-A：媒体格式词表与像素守卫 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把散在 9 处的图片格式白名单和 4 份字节嗅探实现收成一份权威词表，给生成输入加上缺失的像素校验（生产 bug 的直接修复），并停止清扫日志的无限重复。

**Architecture:** 新建 `server/mediaFormats.mjs` 作为唯一权威，持有格式词表、上限常量、偏移感知的签名匹配器与像素尺寸读取。既有四份嗅探实现改为委托它。客户端在 `src/domain/mediaFormats.ts` 保留一份副本（架构门禁禁止 `src/` 导入 `server/`），由 `scripts/mediaFormatContract.test.mjs` 断言两边一致。

**Tech Stack:** 原生 `node:test`；`.ts` 测试走 `--experimental-strip-types`；服务端 JS 按文件 `// @ts-check` opt-in。不新增任何运行时依赖。

**Spec:** `docs/superpowers/specs/2026-08-25-media-and-document-ingestion-design.md`

## Global Constraints

- **PR-A 不放宽任何格式。** `UPLOAD_IMAGE_FORMATS` 在本 PR 内等于 `CANONICAL_IMAGE_FORMATS`（png/jpeg/webp）。PR-B 才同时加入新格式与归一化器 —— 先放宽 `accept=` 而归一化器没上，用户就能选中 HEIC 然后必然失败，那是引入回归。
- **但匹配器要认得出不接受的格式。** `detectImageFormat` 识别 avif/heic/heif/gif/bmp，好让错误说「不支持 HEIC」而不是「无法识别的文件」。**识别 ≠ 接受。**
- 服务端是唯一强制边界。客户端词表只用于生成 `accept=`。
- `src/domain/` 不得导入 `server/`（`check:architecture` 强制）。
- 收编嗅探实现时**不得降低能力**：`mediaSpec.mjs` 的 `jpegDimensions` 比 `regionMaskPng.mjs` 的 `jpegSize` 更健壮（跳过 SOI/EOI/RSTn/TEM 等无长度标记，遇非 `0xff` 字节继续而非返回 null）。**以 mediaSpec 那份为实现体。**
- `imagePixelSize` 保留既有名字与 **返回 `null`** 的契约（现有测试断言 `null`，不是 `undefined`）。
- 领域规则留在 `src/domain/` 与 `server/`；UI 只展示。
- 全量中英双语，文案对象 `{ 'zh-CN', en }` 形状由 TypeScript 强制。
- 每个任务结束时全量门禁必须绿：`npm test`、`npm run check:architecture`、`npm run check:security`、`npm run build`、`git diff --check`。

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `server/mediaFormats.mjs`（新建） | 词表、上限常量、偏移感知签名匹配器、`detectImageFormat`、`imagePixelSize` |
| `server/mediaFormats.test.mjs`（新建） | 词表锁定 + 检测/尺寸行为 |
| `src/domain/mediaFormats.ts`（新建） | 客户端副本，生成 `accept=` 字符串 |
| `src/domain/mediaFormats.test.ts`（新建） | `accept=` 生成 |
| `scripts/mediaFormatContract.test.mjs`（新建） | 两份词表一致 |
| `server/mediaSpec.mjs`（改） | 删掉三个 dimensions 函数，改委托；保留 mp4 与 declaredMimeType 逻辑 |
| `server/regionMaskPng.mjs`（改） | 删掉 `imagePixelSize`/`jpegSize`/`webpSize`，只留蒙版生成 |
| `server/mediaService.mjs`（改） | `matchesImageSignature`、`parseImageDataUrl` 改用词表 |
| `server/generationProvider.mjs`（改） | `mediaDataUrl` 正则、`providerImage` 嗅探、`resolveGenerationInputMedia` 校验改用词表；**新增像素守卫**；`providerError` 文案 |
| `server/botanicAgentExecution.mjs`（改） | `mediaInput` 的 data URL 正则改用词表 |
| `server/agentBranchRetrySweep.mjs`（改） | held 原因去重 |
| `src/lib/uploadedAssets.ts`（改） | `supportedUploadTypes` 改用词表 |
| `src/features/agent/AgentComposer.tsx`、`src/features/canvas/CanvasWorkspacePanels.tsx`、`src/features/canvas/CanvasWorkspace.tsx`（改） | `accept=` 由词表生成 |
| `server/regionMaskPng.test.mjs`、`server/generationProvider.test.mjs`（改） | `imagePixelSize` 的 import 来源 |

---

### Task 1：词表与嗅探模块

**Files:**
- Create: `server/mediaFormats.mjs`
- Test: `server/mediaFormats.test.mjs`

**Interfaces:**
- Consumes: 无（本 PR 的根）
- Produces:
  - `UPLOAD_IMAGE_FORMATS: readonly string[]`
  - `CANONICAL_IMAGE_FORMATS: readonly string[]`
  - `UPLOAD_DOCUMENT_FORMATS: readonly string[]`
  - `MEDIA_LIMITS: { maxCanonicalLongEdge: number, maxCanonicalPixels: number, maxUploadBytes: number, maxDecodePixels: number, maxDocumentPages: number, maxExtractedChars: number }`
  - `detectImageFormat(buffer: Buffer): string | undefined`
  - `imagePixelSize(buffer: Buffer): { width: number, height: number } | null`
  - `isCanonicalImageFormat(mimeType: unknown): boolean`
  - `isUploadImageFormat(mimeType: unknown): boolean`
  - `canonicalImageDataUrlPattern(): RegExp`
  - `imageFormatLabel(mimeType: string): string`

- [ ] **Step 1：写失败测试**

创建 `server/mediaFormats.test.mjs`：

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CANONICAL_IMAGE_FORMATS,
  MEDIA_LIMITS,
  UPLOAD_DOCUMENT_FORMATS,
  UPLOAD_IMAGE_FORMATS,
  canonicalImageDataUrlPattern,
  detectImageFormat,
  imageFormatLabel,
  imagePixelSize,
  isCanonicalImageFormat,
  isUploadImageFormat,
} from './mediaFormats.mjs'

function pngBytes(width, height) {
  const buffer = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'ascii')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

/** 带一个无长度标记（RST0）与一个非 0xff 填充字节，用来钉住健壮版实现。 */
function jpegBytes(width, height) {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xd0]),
    Buffer.from([0x00]),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]),
    (() => { const b = Buffer.alloc(4); b.writeUInt16BE(height, 0); b.writeUInt16BE(width, 2); return b })(),
    Buffer.alloc(9),
  ])
}

function webpVp8xBytes(width, height) {
  const buffer = Buffer.alloc(30)
  buffer.write('RIFF', 0, 'ascii')
  buffer.write('WEBP', 8, 'ascii')
  buffer.write('VP8X', 12, 'ascii')
  buffer.writeUIntLE(width - 1, 24, 3)
  buffer.writeUIntLE(height - 1, 27, 3)
  return buffer
}

/** ftyp box：品牌标识在 offset 4，不在文件头。 */
function ftypBytes(brand) {
  const buffer = Buffer.alloc(32)
  buffer.writeUInt32BE(32, 0)
  buffer.write('ftyp', 4, 'ascii')
  buffer.write(brand, 8, 'ascii')
  return buffer
}

test('词表内容与顺序被锁定', () => {
  assert.deepEqual(CANONICAL_IMAGE_FORMATS, ['image/png', 'image/jpeg', 'image/webp'])
  // PR-A 不放宽格式：放宽 accept= 而归一化器未上线会让用户选中后必然失败。
  assert.deepEqual(UPLOAD_IMAGE_FORMATS, ['image/png', 'image/jpeg', 'image/webp'])
  assert.deepEqual(UPLOAD_DOCUMENT_FORMATS, [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
    'text/plain',
    'text/markdown',
  ])
})

test('canonical 是 upload 的子集', () => {
  const extra = CANONICAL_IMAGE_FORMATS.filter((format) => !UPLOAD_IMAGE_FORMATS.includes(format))
  assert.deepEqual(extra, [], `canonical 里有 upload 不接受的格式：${extra.join('、')}`)
})

test('上限是具名常量', () => {
  assert.equal(MEDIA_LIMITS.maxCanonicalLongEdge, 2048)
  assert.equal(MEDIA_LIMITS.maxCanonicalPixels, 4_000_000)
  assert.equal(MEDIA_LIMITS.maxUploadBytes, 8 * 1024 * 1024)
  assert.equal(MEDIA_LIMITS.maxDecodePixels, 80_000_000)
  assert.equal(MEDIA_LIMITS.maxDocumentPages, 200)
  assert.equal(MEDIA_LIMITS.maxExtractedChars, 200_000)
})

test('检测三个 canonical 格式', () => {
  assert.equal(detectImageFormat(pngBytes(2, 2)), 'image/png')
  assert.equal(detectImageFormat(jpegBytes(2, 2)), 'image/jpeg')
  assert.equal(detectImageFormat(webpVp8xBytes(2, 2)), 'image/webp')
})

test('识别尚未接受的格式，好让错误说得出名字', () => {
  // 识别 ≠ 接受。认出来是为了报「不支持 HEIC」而不是「无法识别的文件」。
  assert.equal(detectImageFormat(ftypBytes('heic')), 'image/heic')
  assert.equal(detectImageFormat(ftypBytes('mif1')), 'image/heic')
  assert.equal(detectImageFormat(ftypBytes('avif')), 'image/avif')
  assert.equal(detectImageFormat(Buffer.from('GIF89a---------------')), 'image/gif')
  assert.equal(detectImageFormat(Buffer.concat([Buffer.from('BM'), Buffer.alloc(30)])), 'image/bmp')
  for (const format of ['image/heic', 'image/avif', 'image/gif', 'image/bmp']) {
    assert.equal(isUploadImageFormat(format), false, `${format} 在 PR-A 不应被接受`)
  }
})

test('认不出来时返回 undefined', () => {
  assert.equal(detectImageFormat(Buffer.from('not an image at all!')), undefined)
  assert.equal(detectImageFormat(Buffer.alloc(0)), undefined)
})

test('读像素尺寸，认不出返回 null', () => {
  assert.deepEqual(imagePixelSize(pngBytes(4032, 3024)), { width: 4032, height: 3024 })
  assert.deepEqual(imagePixelSize(jpegBytes(7, 5)), { width: 7, height: 5 })
  assert.deepEqual(imagePixelSize(webpVp8xBytes(4, 6)), { width: 4, height: 6 })
  assert.equal(imagePixelSize(Buffer.from('not an image, definitely')), null)
  assert.equal(imagePixelSize('not a buffer'), null)
})

test('谓词与标签', () => {
  assert.equal(isCanonicalImageFormat('image/PNG'), true)
  assert.equal(isCanonicalImageFormat('image/heic'), false)
  assert.equal(isCanonicalImageFormat(undefined), false)
  assert.equal(isUploadImageFormat('image/webp'), true)
  assert.equal(imageFormatLabel('image/jpeg'), 'JPEG')
  assert.equal(imageFormatLabel('image/svg+xml'), 'SVG')
  // 未知类型原样回显，不静默变空。
  assert.equal(imageFormatLabel('image/unknown'), 'image/unknown')
})

test('canonical data URL 正则只认三个格式', () => {
  const pattern = canonicalImageDataUrlPattern()
  assert.ok(pattern.test('data:image/png;base64,AAAA'))
  assert.ok(pattern.test('data:image/JPEG;base64,AAAA'))
  assert.equal(pattern.test('data:image/heic;base64,AAAA'), false)
  assert.equal(pattern.test('data:video/mp4;base64,AAAA'), false)
})
```

- [ ] **Step 2：跑测试确认失败**

Run: `node --test server/mediaFormats.test.mjs`
Expected: FAIL — `Cannot find module './mediaFormats.mjs'`

- [ ] **Step 3：写实现**

创建 `server/mediaFormats.mjs`：

```js
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
 * `maxCanonicalPixels` **是保守猜测，未钉死**：生产实测只知道 2.2 MP 能过、
 * 12.2 MP 被拒，真实阈值在两者之间，钉它需要一次真实供应商调用去二分。
 * 因此它是一处常量、一处修改，而不是散在校验逻辑里的魔法数字。
 */
export const MEDIA_LIMITS = Object.freeze({
  maxCanonicalLongEdge: 2048,
  maxCanonicalPixels: 4_000_000,
  maxUploadBytes: 8 * 1024 * 1024,
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

const FORMAT_LABELS = Object.freeze({
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

/** canonical 图片 data URL 的正则。每次新建，避免共享 lastIndex。 */
export function canonicalImageDataUrlPattern() {
  const alternatives = CANONICAL_IMAGE_FORMATS
    .map((format) => format.replace('image/', '').replace(/[+]/g, '\\+'))
    .join('|')
  return new RegExp(`^data:(image\\/(?:${alternatives}));base64,([A-Za-z0-9+/=\\s]+)$`, 'i')
}
```

- [ ] **Step 4：跑测试确认通过**

Run: `node --test server/mediaFormats.test.mjs`
Expected: PASS，9 个测试全绿（模块导出 10 个符号，测试是 9 个 —— 别把两个数搞混）

- [ ] **Step 5：提交**

```bash
git add server/mediaFormats.mjs server/mediaFormats.test.mjs
git commit -m "feat(media): 建立图片格式权威词表与偏移感知嗅探器

png|jpeg|webp 此前硬编码在 9 处、字节嗅探有 4 份独立实现。收成一份权威词表。

三个集合刻意分开：UPLOAD 是用户能交给我们的，CANONICAL 是我们存储并交给
供应商的。合并它们就是把归一化层存在的理由藏起来 —— 生产上已经为此付过一次
代价（白名单说 JPEG 没问题，供应商不同意）。

detectImageFormat 认得出 heic/avif/gif/bmp 但 UPLOAD 暂不接受：识别不等于
接受，认出来是为了让错误说得出「不支持 HEIC」而不是「无法识别的文件」。
HEIF 家族的标识在 offset 4，所以匹配器必须带偏移。"
```

---

### Task 2：收编四份嗅探实现

**Files:**
- Modify: `server/mediaSpec.mjs:15-62`（删 `PNG_SIGNATURE` 与三个 dimensions 函数，改委托）
- Modify: `server/regionMaskPng.mjs:10,28-72`（删 `imagePixelSize`/`jpegSize`/`webpSize`）
- Modify: `server/mediaService.mjs:1-24`（`matchesImageSignature`、`parseImageDataUrl`）
- Modify: `server/generationProvider.mjs:11,34,268,400-412`
- Modify: `server/botanicAgentExecution.mjs:17`
- Modify: `server/regionMaskPng.test.mjs:5`、`server/generationProvider.test.mjs:447`（import 来源）
- Test: `server/mediaFormats.test.mjs`（追加一条回归）

**Interfaces:**
- Consumes: Task 1 的 `detectImageFormat`、`imagePixelSize`、`isCanonicalImageFormat`、`canonicalImageDataUrlPattern`、`CANONICAL_IMAGE_FORMATS`、`imageFormatLabel`
- Produces: 无新导出。`mediaSpec.mjs` 的 `readMediaSpec`、`regionMaskPng.mjs` 的 `buildRegionMaskPng`/`normalizeRegionRect`/`minimumRegionSpan` 签名不变

- [ ] **Step 1：写失败测试（钉住不得回退的那一份）**

在 `server/mediaFormats.test.mjs` 末尾追加：

```js
test('JPEG 尺寸读取保留健壮版实现', () => {
  // 原 regionMaskPng.mjs 的 jpegSize 遇到非 0xff 字节就返回 null，且不跳 RSTn。
  // 收编时若误用那一份，这条会红。
  const withPadding = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xd0]),          // RST0：无长度字段
    Buffer.from([0x00, 0x00, 0x00]),    // 非 0xff 填充
    Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]), // APP0，长度 4
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]),
    (() => { const b = Buffer.alloc(4); b.writeUInt16BE(11317, 0); b.writeUInt16BE(8488, 2); return b })(),
    Buffer.alloc(9),
  ])
  assert.deepEqual(imagePixelSize(withPadding), { width: 8488, height: 11317 })
})
```

- [ ] **Step 2：跑测试确认失败**

Run: `node --test server/mediaFormats.test.mjs`
Expected: FAIL —— 若 Task 1 的实现体正确，本条应当**已经通过**。若通过，直接进 Step 3（这是一条防回退的钉子，不是新行为）。若失败，说明 Task 1 用错了实现体，先修 Task 1。

- [ ] **Step 3：改 `server/mediaSpec.mjs`**

删除 `:15` 的 `PNG_SIGNATURE` 与 `:18-72` 的 `pngDimensions`/`jpegDimensions`/`webpDimensions`，在文件顶部加 import，并把 `readMediaSpec` 的图片分支改为委托：

```js
// @ts-check
import { detectImageFormat, imagePixelSize } from './mediaFormats.mjs'
```

`readMediaSpec` 的图片分支替换为：

```js
export function readMediaSpec(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { byteSize: 0, ...(mimeType ? { declaredMimeType: mimeType } : {}) }
  const detected = detectImageFormat(buffer)
  const dimensions = imagePixelSize(buffer)
  // 只有能同时读出格式与尺寸才算实测到规格；读不出就不猜。
  if (detected && dimensions) {
    return {
      mimeType: detected,
      ...(mimeType && mimeType !== detected ? { declaredMimeType: mimeType } : {}),
      byteSize: buffer.length,
      width: dimensions.width,
      height: dimensions.height,
    }
  }
  const durationSeconds = mp4DurationSeconds(buffer)
  if (durationSeconds !== undefined) {
    return {
      mimeType: 'video/mp4',
      ...(mimeType && mimeType !== 'video/mp4' ? { declaredMimeType: mimeType } : {}),
      byteSize: buffer.length,
      durationSeconds,
    }
  }
  return { byteSize: buffer.length, ...(mimeType ? { declaredMimeType: mimeType } : {}) }
}
```

- [ ] **Step 4：改 `server/regionMaskPng.mjs`**

删除 `:10` 的 `pngSignature`、`:28-40` 的 `imagePixelSize`、`:42-54` 的 `jpegSize`、`:56-72` 的 `webpSize`。文件顶部不需要新 import（蒙版生成用不到嗅探）。

在原 `imagePixelSize` 位置留一行注释：

```js
// 像素尺寸读取已收编到 server/mediaFormats.mjs —— 同一行为只保留一个权威实现。
```

- [ ] **Step 5：改两个测试文件的 import 来源**

`server/regionMaskPng.test.mjs:5` 把 `imagePixelSize` 从 import 列表移出，改为单独从词表导入：

```js
import { imagePixelSize } from './mediaFormats.mjs'
```

`server/generationProvider.test.mjs:447` 改为：

```js
  const { buildRegionMaskPng } = await import('./regionMaskPng.mjs')
  const { imagePixelSize } = await import('./mediaFormats.mjs')
```

- [ ] **Step 6：改 `server/mediaService.mjs`**

删除 `:1-6` 的 `matchesImageSignature`，文件顶部加 import，`parseImageDataUrl` 改为：

```js
import { canonicalImageDataUrlPattern, detectImageFormat, imageFormatLabel } from './mediaFormats.mjs'

function parseImageDataUrl(dataUrl, maximumUploadBytes) {
  if (typeof dataUrl !== 'string') return undefined
  const match = dataUrl.match(canonicalImageDataUrlPattern())
  if (!match) return undefined
  const bytes = Buffer.from(match[2], 'base64')
  if (!bytes.length) return undefined
  if (bytes.length > maximumUploadBytes) throw mediaValidationError(`单个素材不能超过 ${Math.ceil(maximumUploadBytes / 1024 / 1024)}MB。`)
  const contentType = match[1].toLowerCase()
  // 以实际字节为准：声明 PNG 实际是别的东西，本身就是要抓的完整性问题。
  const detected = detectImageFormat(bytes)
  if (detected !== contentType) {
    throw mediaValidationError(detected
      ? `图片内容是 ${imageFormatLabel(detected)}，与声明的 ${imageFormatLabel(contentType)} 不一致。`
      : '图片内容无法识别，文件可能已损坏。')
  }
  return { contentType, bytes }
}
```

- [ ] **Step 7：改 `server/generationProvider.mjs`**

`:11` 的 import 改为：

```js
import { buildRegionMaskPng, normalizeRegionRect } from './regionMaskPng.mjs'
import {
  CANONICAL_IMAGE_FORMATS,
  MEDIA_LIMITS,
  detectImageFormat,
  imageFormatLabel,
  imagePixelSize,
  isCanonicalImageFormat,
} from './mediaFormats.mjs'
```

`:32-46` 的 `mediaDataUrl` 改为：

```js
function mediaDataUrl(value, maximumReferenceBytes, mediaKind = 'image') {
  if (typeof value !== 'string') throw new GenerationError(400, 'INVALID_REFERENCE', '参考素材格式无效。')
  const alternatives = CANONICAL_IMAGE_FORMATS.map((format) => format.replace('image/', '')).join('|')
  const mimePattern = mediaKind === 'video' ? 'video\\/mp4' : `image\\/(?:${alternatives})`
  const match = value.match(new RegExp(`^data:(${mimePattern});base64,([A-Za-z0-9+/=\\s]+)$`, 'i'))
  if (!match) {
    throw new GenerationError(400, 'INVALID_REFERENCE', mediaKind === 'video'
      ? '视频参考仅支持 MP4。'
      : `参考素材仅支持 ${CANONICAL_IMAGE_FORMATS.map(imageFormatLabel).join('、')}。`)
  }
  const buffer = Buffer.from(match[2], 'base64')
  if (!buffer.length || buffer.length > maximumReferenceBytes) {
    throw new GenerationError(413, 'REFERENCE_TOO_LARGE', `单张参考素材不能超过 ${Math.ceil(maximumReferenceBytes / 1024 / 1024)}MB。`)
  }
  return { mimeType: match[1].toLowerCase(), buffer }
}
```

`:268` 的 mime 校验改为：

```js
    if (reference.mediaKind !== 'video' && !isCanonicalImageFormat(resolved.mimeType)) {
      throw new GenerationError(400, 'INVALID_REFERENCE',
        `参考素材格式为 ${imageFormatLabel(resolved.mimeType)}，仅支持 ${CANONICAL_IMAGE_FORMATS.map(imageFormatLabel).join('、')}。`)
    }
```

`:400-413` 的 `providerImage` 嗅探段改为：

```js
function providerImage(value) {
  if (typeof value !== 'string' || !value.trim()) throw new GenerationError(502, 'INVALID_PROVIDER_RESPONSE', '图像服务没有返回可用的图片数据。')
  const base64 = (value.trim().startsWith('data:image/') ? value.trim().slice(value.indexOf(',') + 1) : value.trim()).replace(/\s/g, '')
  if (!base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 === 1) {
    throw new GenerationError(502, 'INVALID_PROVIDER_RESPONSE', '图像服务返回了无效的图片编码。')
  }
  const bytes = Buffer.from(base64, 'base64')
  const mimeType = detectImageFormat(bytes)
  if (!mimeType || !isCanonicalImageFormat(mimeType)) {
    throw new GenerationError(502, 'INVALID_PROVIDER_RESPONSE', '图像服务返回的文件格式无法显示。')
  }
  return { mimeType, dataUrl: `data:${mimeType};base64,${base64}` }
}
```

- [ ] **Step 8：改 `server/botanicAgentExecution.mjs`**

文件顶部加 import，`:17` 改为：

```js
import { canonicalImageDataUrlPattern } from './mediaFormats.mjs'

// mediaInput 内：
  if (canonicalImageDataUrlPattern().test(image)) return { dataUrl: image }
```

- [ ] **Step 9：跑全量测试确认无回退**

Run: `npm test`
Expected: PASS。这是**行为保持**的重构，既有测试全部应当仍绿。若 `mediaSpec.test.mjs` 或 `regionMaskPng.test.mjs` 变红，说明收编时能力回退了，回到 Step 3/4 检查。

Run: `npm run check:architecture && npm run build`
Expected: PASS

- [ ] **Step 10：提交**

```bash
git add server/mediaFormats.test.mjs server/mediaSpec.mjs server/regionMaskPng.mjs \
        server/mediaService.mjs server/generationProvider.mjs server/botanicAgentExecution.mjs \
        server/regionMaskPng.test.mjs server/generationProvider.test.mjs
git commit -m "refactor(media): 四份字节嗅探实现收编到权威词表

mediaSpec.mjs、regionMaskPng.mjs、mediaService.mjs、generationProvider.mjs
各有一份「从字节判断格式与尺寸」的实现。收成一份。

实现体取 mediaSpec 那一份：它比 regionMaskPng 的 jpegSize 更健壮，会跳过
SOI/EOI/RSTn 这些无长度标记、遇非 0xff 填充字节继续而不是直接返回 null。
追加一条回归测试钉住这一点，用错另一份会红。

顺带把「声明类型与实际字节不符」的报错说清是哪两种格式，而不是一句
「图片内容与文件类型不匹配」。"
```

---

### Task 3：生成输入的像素守卫（生产 bug 直接修复）

**Files:**
- Modify: `server/generationProvider.mjs`（`resolveGenerationInputMedia` 内新增守卫）
- Test: `server/generationProvider.test.mjs`（追加）

**Interfaces:**
- Consumes: Task 1 的 `MEDIA_LIMITS`、`imagePixelSize`；Task 2 已加好的 import
- Produces: 新错误码 `IMAGE_TOO_LARGE_PIXELS`（`GenerationError` 400）

- [ ] **Step 1：写失败测试**

在 `server/generationProvider.test.mjs` 末尾追加：

```js
test('参考图像素超上限时被拒，并说清怎么办', async () => {
  const { resolveGenerationInputMedia, GenerationError } = await import('./generationProvider.mjs')
  const { imagePixelSize } = await import('./mediaFormats.mjs')

  // 4032×3024 = 12.2 MP，正是生产上被供应商拒掉的那张 iPhone 原图的尺寸。
  function pngOfSize(width, height) {
    const buffer = Buffer.alloc(33)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
    buffer.writeUInt32BE(13, 8)
    buffer.write('IHDR', 12, 'ascii')
    buffer.writeUInt32BE(width, 16)
    buffer.writeUInt32BE(height, 20)
    return buffer
  }
  const oversized = pngOfSize(4032, 3024)
  assert.deepEqual(imagePixelSize(oversized), { width: 4032, height: 3024 })

  const input = {
    references: [{ mediaId: 'media_oversized', mediaKind: 'image' }],
    parent: undefined,
    mask: undefined,
  }
  const resolveMedia = async () => ({ mimeType: 'image/png', buffer: oversized })

  await assert.rejects(
    () => resolveGenerationInputMedia(input, resolveMedia),
    (error) => {
      assert.ok(error instanceof GenerationError)
      assert.equal(error.code, 'IMAGE_TOO_LARGE_PIXELS')
      // 必须报出实际尺寸和可执行的下一步，而不是转述供应商英文。
      assert.match(error.message, /4032×3024/)
      assert.match(error.message, /2048/)
      return true
    },
  )
})

test('像素在上限内的参考图正常通过', async () => {
  const { resolveGenerationInputMedia } = await import('./generationProvider.mjs')
  function pngOfSize(width, height) {
    const buffer = Buffer.alloc(33)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
    buffer.writeUInt32BE(13, 8)
    buffer.write('IHDR', 12, 'ascii')
    buffer.writeUInt32BE(width, 16)
    buffer.writeUInt32BE(height, 20)
    return buffer
  }
  // 1280×1707 = 2.2 MP，生产上实测通过的那张。
  const ok = pngOfSize(1280, 1707)
  const resolved = await resolveGenerationInputMedia(
    { references: [{ mediaId: 'media_ok', mediaKind: 'image' }] },
    async () => ({ mimeType: 'image/png', buffer: ok }),
  )
  assert.equal(resolved.references.length, 1)
  assert.equal(resolved.references[0].mimeType, 'image/png')
})

test('读不出尺寸时不拦', async () => {
  // 尺寸读不出来不代表超限。拦住它会把一类正常输入误杀。
  const { resolveGenerationInputMedia } = await import('./generationProvider.mjs')
  const opaque = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(40)])
  const resolved = await resolveGenerationInputMedia(
    { references: [{ mediaId: 'media_opaque', mediaKind: 'image' }] },
    async () => ({ mimeType: 'image/jpeg', buffer: opaque }),
  )
  assert.equal(resolved.references.length, 1)
})
```

- [ ] **Step 2：跑测试确认失败**

Run: `node --test server/generationProvider.test.mjs`
Expected: FAIL —— 第一条报「Missing expected rejection」，因为当前完全没有像素校验

- [ ] **Step 3：写实现**

在 `server/generationProvider.mjs` 的 `resolveGenerationInputMedia` 里，`resolve` 函数末尾（`return { ...reference, mimeType: resolved.mimeType, buffer: resolved.buffer }` 之前）插入守卫：

```js
    // 像素守卫。此前只卡字节（8MB），一张 2.8MB 的 12.2MP 手机原图轻松过关，
    // 然后被供应商以 "Invalid image file or mode for image 1" 拒掉 —— 而那句话
    // 会原样转述给用户，让他去 email 供应商。手机照片是最常见的参考素材来源，
    // 所以这条路径上的每个用户都会撞到。
    if (reference.mediaKind !== 'video') {
      assertImagePixelBudget(resolved.buffer)
    }
    return { ...reference, mimeType: resolved.mimeType, buffer: resolved.buffer }
```

在文件内 `resolveGenerationInputMedia` 之前加辅助函数：

```js
/**
 * 参考图像素量是否在供应商能接受的范围内。
 *
 * `maxCanonicalPixels` 是**保守猜测**：生产实测只知道 2.2 MP 能过、12.2 MP 被拒，
 * 真实阈值在两者之间。钉死它需要一次真实供应商调用去二分，因此这里只引用
 * `MEDIA_LIMITS` 的常量，不写死数字。
 *
 * 读不出尺寸时**不拦**：读不出不等于超限，拦住会误杀一类正常输入。
 */
function assertImagePixelBudget(buffer) {
  const size = imagePixelSize(buffer)
  if (!size) return
  const { maxCanonicalPixels, maxCanonicalLongEdge } = MEDIA_LIMITS
  const pixels = size.width * size.height
  const longEdge = Math.max(size.width, size.height)
  if (pixels <= maxCanonicalPixels && longEdge <= maxCanonicalLongEdge) return
  throw new GenerationError(400, 'IMAGE_TOO_LARGE_PIXELS',
    `参考图 ${size.width}×${size.height} 超过 ${Math.round(maxCanonicalPixels / 10_000)} 万像素上限。`
    + `请缩小到长边 ${maxCanonicalLongEdge} 以内后重试。`)
}
```

- [ ] **Step 4：跑测试确认通过**

Run: `node --test server/generationProvider.test.mjs`
Expected: PASS

Run: `npm test`
Expected: PASS。若既有测试里有用大尺寸图做夹具的，会在这里变红 —— 那些夹具需要改小，**不要**放宽上限来迁就测试。

- [ ] **Step 5：提交**

```bash
git add server/generationProvider.mjs server/generationProvider.test.mjs
git commit -m "fix(generation): 参考图加像素上限校验

生产 bug 的直接修复。validateGenerationInput 只卡字节（8MB），从不看像素，
于是一张 2.8MB / 4032×3024（12.2MP）的 iPhone 原图轻松过关，然后被供应商拒掉。
手机照片是最常见的参考素材来源，这条路径上每个用户都会撞到。

排除法坐实与格式和体积都无关：一张 2.2MP 的 JPEG 成功、一张 6MB 的 PNG 成功，
失败的那张 baseline 8-bit YCbCr、EOI 完整、声明大小等于存储大小。只剩像素量。

上限取自 MEDIA_LIMITS 常量而非写死数字：真实阈值在 2.2 与 12.2 MP 之间，
钉死它需要一次真实供应商调用。读不出尺寸时不拦 —— 读不出不等于超限。"
```

---

### Task 4：供应商拒绝的错误文案

**Files:**
- Modify: `server/generationProvider.mjs:390-398`（`providerError`）
- Test: `server/generationProvider.test.mjs`（追加）

**Interfaces:**
- Consumes: 无新增
- Produces: `providerError` 行为变化 —— 供应商原文不再进用户可见消息

- [ ] **Step 1：写失败测试**

追加到 `server/generationProvider.test.mjs`：

```js
test('供应商拒绝时不把英文原文转述给用户，但日志留得住', async () => {
  const { providerRejectionError } = await import('./generationProvider.mjs')
  const upstream = 'Invalid image file or mode for image 1, please check your image file. '
    + 'If you believe this is an error, contact us at help.openai.com and include the request ID req_abc'
  const error = providerRejectionError(upstream, 'req_abc123')

  assert.equal(error.code, 'PROVIDER_REJECTED')
  // 用户不该被指去联系供应商 —— 他既不是客户，也无从判断该说什么。
  assert.doesNotMatch(error.message, /help\.openai\.com/)
  assert.doesNotMatch(error.message, /contact us/i)
  // 但要给可执行的下一步，和一个能对上日志的请求号。
  assert.match(error.message, /req_abc123/)
  assert.match(error.message, /提示词|参考素材|输出规格/)
  // 原文必须留在结构化字段里，运维要靠它诊断。
  assert.equal(error.upstreamMessage, upstream)
})

test('没有上游原文时也给得出可执行的话', async () => {
  const { providerRejectionError } = await import('./generationProvider.mjs')
  const error = providerRejectionError(undefined, undefined)
  assert.equal(error.code, 'PROVIDER_REJECTED')
  assert.match(error.message, /提示词|参考素材|输出规格/)
  assert.equal(error.upstreamMessage, undefined)
})
```

- [ ] **Step 2：跑测试确认失败**

Run: `node --test server/generationProvider.test.mjs`
Expected: FAIL —— `providerRejectionError` 未导出

- [ ] **Step 3：写实现**

在 `server/generationProvider.mjs` 里新增导出函数，并让 `providerError` 调用它：

```js
/**
 * 供应商拒绝本次任务时的错误。
 *
 * **供应商原文不进用户可见消息。** 生产上它长这样：「Invalid image file or mode
 * for image 1 ... contact us at help.openai.com」—— 用户既不是供应商的客户，
 * 也无从判断该向他们说什么；而真正的答案（照片像素太大）没人告诉他。
 *
 * 原文留在 `upstreamMessage` 字段里给日志和运维，不丢。
 */
export function providerRejectionError(upstreamMessage, requestId) {
  const suffix = requestId ? `（请求 ${requestId}）` : ''
  const error = new GenerationError(422, 'PROVIDER_REJECTED',
    `图像服务拒绝了本次任务，请检查提示词、参考素材与输出规格。${suffix}`)
  if (typeof upstreamMessage === 'string' && upstreamMessage.trim()) {
    error.upstreamMessage = upstreamMessage
  }
  return error
}
```

`providerError` 的最后两行替换为：

```js
function providerError(response, body) {
  const requestId = response.headers.get('x-request-id')
  if (response.status === 401 || response.status === 403) return new GenerationError(502, 'PROVIDER_AUTH_FAILED', '图像服务鉴权失败，请检查 OPENAI_API_KEY 与组织验证。')
  if (response.status === 429) return new GenerationError(429, 'PROVIDER_RATE_LIMITED', '图像服务当前限流，请稍后重试。')
  if (response.status >= 500) return new GenerationError(502, 'PROVIDER_UNAVAILABLE', '图像服务暂时不可用，请稍后重试。')
  return providerRejectionError(typeof body?.error?.message === 'string' ? body.error.message : undefined, requestId)
}
```

在 `server/generationProcessor.mjs` 的失败日志处，把 `upstreamMessage` 一并打出来（找到现有 `failed (${code})` 那行日志），改为在有 `upstreamMessage` 时追加：

```js
      const upstream = error?.upstreamMessage ? ` 上游原文：${error.upstreamMessage}` : ''
      console.error(`[generation] ${jobId} failed (${code}): ${error}${upstream}`)
```

- [ ] **Step 4：跑测试确认通过**

Run: `node --test server/generationProvider.test.mjs`
Expected: PASS

Run: `npm test`
Expected: PASS。既有断言若匹配了旧的英文原文消息，改断言 `upstreamMessage`。

- [ ] **Step 5：提交**

```bash
git add server/generationProvider.mjs server/generationProcessor.mjs server/generationProvider.test.mjs
git commit -m "fix(generation): 供应商拒绝原文不再转述给用户

生产上用户看到的是「Invalid image file or mode for image 1 ... contact us at
help.openai.com」。他既不是供应商的客户，也无从判断该向他们说什么；而真正的
答案（照片像素太大）没人告诉他。

原文移到 upstreamMessage 字段，进 Worker 日志给运维诊断用，不丢。"
```

---

### Task 5：客户端词表与跨边界契约

**Files:**
- Create: `src/domain/mediaFormats.ts`
- Create: `src/domain/mediaFormats.test.ts`
- Create: `scripts/mediaFormatContract.test.mjs`
- Modify: `src/lib/uploadedAssets.ts:5-17`
- Modify: `src/features/agent/AgentComposer.tsx:247`
- Modify: `src/features/canvas/CanvasWorkspacePanels.tsx:522,535`
- Modify: `src/features/canvas/CanvasWorkspace.tsx:2618`

**Interfaces:**
- Consumes: Task 1 的 `server/mediaFormats.mjs`（仅由契约测试读取，`src/` 不导入）
- Produces:
  - `UPLOAD_IMAGE_FORMATS: readonly string[]`（客户端副本）
  - `MEDIA_LIMITS: { maxUploadBytes: number }`（客户端只需要这一项）
  - `imageUploadAccept(): string`
  - `unsupportedUploadMessage(count: number, locale: ProductLocale): string`

- [ ] **Step 1：写失败测试**

创建 `src/domain/mediaFormats.test.ts`：

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { MEDIA_LIMITS, UPLOAD_IMAGE_FORMATS, imageUploadAccept, unsupportedUploadMessage } from './mediaFormats.ts'

test('accept 属性由词表生成', () => {
  assert.equal(imageUploadAccept(), 'image/png,image/jpeg,image/webp')
  // 手写 accept= 会与词表漂移：服务端加了格式而选择器选不到，或反之。
  assert.equal(imageUploadAccept(), UPLOAD_IMAGE_FORMATS.join(','))
})

test('上限与服务端一致', () => {
  assert.equal(MEDIA_LIMITS.maxUploadBytes, 8 * 1024 * 1024)
})

test('跳过文件的提示列出实际支持的格式与双语', () => {
  assert.equal(unsupportedUploadMessage(1, 'zh-CN'), '已跳过 1 个文件：仅支持 PNG、JPEG、WebP，单张不超过 8MB。')
  assert.equal(unsupportedUploadMessage(3, 'zh-CN'), '已跳过 3 个文件：仅支持 PNG、JPEG、WebP，单张不超过 8MB。')
  assert.equal(unsupportedUploadMessage(1, 'en'), 'Skipped 1 file. Upload PNG, JPEG or WebP images up to 8 MB each.')
  assert.equal(unsupportedUploadMessage(2, 'en'), 'Skipped 2 files. Upload PNG, JPEG or WebP images up to 8 MB each.')
})
```

创建 `scripts/mediaFormatContract.test.mjs`：

```js
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { MEDIA_LIMITS, UPLOAD_IMAGE_FORMATS } from '../server/mediaFormats.mjs'

/**
 * 客户端格式词表必须与服务端一致。
 *
 * 架构门禁禁止 `src/` 导入 `server/`，所以词表只能有两份。两份分别维护是这类
 * 模型最常见的坏法：服务端加了 AVIF、`accept=` 忘了改，用户在文件选择器里
 * 根本选不到；或者反过来，选得到、传上去被拒。
 *
 * 与 scripts/projectCapabilityContract.test.mjs 同一手法：把 TS 源码当文本读。
 */
const domain = readFileSync(new URL('../src/domain/mediaFormats.ts', import.meta.url), 'utf8')

function domainList(name) {
  const start = domain.indexOf(`export const ${name} = [`)
  assert.notEqual(start, -1, `找不到 ${name}`)
  const end = domain.indexOf('] as const', start)
  assert.notEqual(end, -1, `${name} 缺少 as const`)
  return [...domain.slice(start, end).matchAll(/'([^']+)'/g)].map((match) => match[1])
}

test('两份上传格式词表逐项一致（含顺序）', () => {
  // 顺序也要一致：accept= 的顺序决定文件选择器里的分组顺序。
  assert.deepEqual(domainList('UPLOAD_IMAGE_FORMATS'), [...UPLOAD_IMAGE_FORMATS])
})

test('客户端字节上限与服务端一致', () => {
  const match = domain.match(/maxUploadBytes:\s*([\d*\s]+),/)
  assert.ok(match, '找不到 maxUploadBytes')
  // eslint-disable-next-line no-eval -- 只求值一个由数字与 * 组成的字面量
  assert.equal(eval(match[1]), MEDIA_LIMITS.maxUploadBytes)
})
```

- [ ] **Step 2：跑测试确认失败**

Run: `node --experimental-strip-types --test src/domain/mediaFormats.test.ts`
Expected: FAIL — 找不到模块

Run: `node --test scripts/mediaFormatContract.test.mjs`
Expected: FAIL — 找不到 `src/domain/mediaFormats.ts`

- [ ] **Step 3：写实现**

创建 `src/domain/mediaFormats.ts`：

```ts
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
```

- [ ] **Step 4：跑测试确认通过**

Run: `node --experimental-strip-types --test src/domain/mediaFormats.test.ts`
Expected: PASS

Run: `node --test scripts/mediaFormatContract.test.mjs`
Expected: PASS

- [ ] **Step 5：接上 `src/lib/uploadedAssets.ts`**

`:5-17` 替换为：

```ts
import { MEDIA_LIMITS, UPLOAD_IMAGE_FORMATS, unsupportedUploadMessage } from '../domain/mediaFormats'

export const maxUploadAssets = 12
const supportedUploadTypes = new Set<string>(UPLOAD_IMAGE_FORMATS)

export function validateUploadFiles(files: File[], locale: ProductLocale = 'zh-CN') {
  const accepted = files.filter((file) => (
    supportedUploadTypes.has(file.type) && file.size > 0 && file.size <= MEDIA_LIMITS.maxUploadBytes
  ))
  const rejected = files.length - accepted.length
  return { accepted, message: rejected ? unsupportedUploadMessage(rejected, locale) : '' }
}
```

删除文件顶部原来的 `maximumUploadImageBytes` 常量。

- [ ] **Step 6：接上四个 `accept=` 站点**

`src/features/agent/AgentComposer.tsx` 顶部加 import，`:247` 的 `accept="image/png,image/jpeg,image/webp"` 改为 `accept={imageUploadAccept()}`：

```tsx
import { imageUploadAccept } from '../../domain/mediaFormats'
```

`src/features/canvas/CanvasWorkspacePanels.tsx` 同样加 import，`:522` 与 `:535` 两处 `accept="image/png,image/jpeg,image/webp"` 均改为 `accept={imageUploadAccept()}`。

`src/features/canvas/CanvasWorkspace.tsx` 同样加 import，`:2618` 改为 `accept={imageUploadAccept()}`。

导入路径按各文件相对深度调整（`src/features/*/` → `../../domain/mediaFormats`）。

- [ ] **Step 7：跑全量门禁**

Run: `npm test`
Expected: PASS，**`src/lib/uploadedAssets.test.ts` 不需要改**。它 `:13-14` 用的是
`assert.match(result.message, /已跳过 2 个文件/)` 与 `/Skipped 2 files/`（正则匹配，
不是全等），新文案两条都仍然命中。不要因为「改了文案」就去动它。

Run: `npm run check:architecture`
Expected: PASS —— 确认 `src/domain/mediaFormats.ts` 没有导入 `server/`

Run: `npm run build`
Expected: PASS

Run: `grep -rn "image/png,image/jpeg,image/webp" src/`
Expected: 无输出（所有手写 accept 已消除）

- [ ] **Step 8：提交**

```bash
git add src/domain/mediaFormats.ts src/domain/mediaFormats.test.ts \
        scripts/mediaFormatContract.test.mjs src/lib/uploadedAssets.ts \
        src/features/agent/AgentComposer.tsx \
        src/features/canvas/CanvasWorkspacePanels.tsx \
        src/features/canvas/CanvasWorkspace.tsx
git commit -m "refactor(media): accept= 与客户端校验改由词表生成

四处手写的 accept=\"image/png,image/jpeg,image/webp\" 和 uploadedAssets 里的
一份 Set 全部改为从词表导出。架构门禁禁止 src/ 导入 server/，所以词表有两份，
由 scripts/mediaFormatContract.test.mjs 断言一致 —— 同 projectCapabilities
对服务端权限表的处理。

跳过文件的提示改为列出实际支持的格式，而不是写死字面量：放宽词表后写死的
那句话就在说谎。"
```

---

### Task 6：清扫日志停止无限重复

**Files:**
- Modify: `server/agentBranchRetrySweep.mjs:35-59`
- Test: `server/agentBranchRetrySweep.test.mjs`（追加）

**Interfaces:**
- Consumes: 无新增
- Produces: `createAgentBranchRetrySweep` 行为变化 —— 同一分支同一原因只记一次

**范围说明：** 本任务只做**日志去重**。规格里提到的「不再重读 run 与 job」需要
`listRunsWithFailedBranches` 返回版本号才能安全跳过，属于 store 查询层改动，**不在 PR-A**。
去重已经消掉了可观测性噪音这个实际危害。

- [ ] **Step 1：写失败测试**

追加到 `server/agentBranchRetrySweep.test.mjs`：

```js
test('同一分支同一 held 原因只记一次', async () => {
  const { createAgentBranchRetrySweep } = await import('./agentBranchRetrySweep.mjs')
  const run = {
    id: 'run-1',
    ownerId: 'user-1',
    branches: [{ id: 'branch-1', status: 'failed', attempt: 0, activeJobId: 'job-1' }],
  }
  // errorCode 不在可重试白名单里 → 原因恒为 error_not_retryable，永远不会变。
  const job = { id: 'job-1', rawInput: {}, errorCode: 'PROVIDER_REJECTED', batchCount: 1, updatedAt: 0 }
  const events = []
  const sweep = createAgentBranchRetrySweep({
    productStore: {
      listRunsWithFailedBranches: async () => [{ runId: run.id, ownerId: run.ownerId }],
      readAgentRunForWorker: async () => run,
      readGenerationJobForWorker: async () => job,
    },
    retryAgentBranch: async () => ({ kind: 'ok' }),
    observe: (event) => events.push(event),
    now: () => 10 * 60_000,
  })

  await sweep()
  await sweep()
  await sweep()

  const held = events.filter((event) => event.event === 'agent.branch.retry.held')
  assert.equal(held.length, 1, '同一原因连刷三轮只应记一条')
  assert.equal(held[0].reason, 'error_not_retryable')
})

test('held 原因变化时记新的一条', async () => {
  const { createAgentBranchRetrySweep } = await import('./agentBranchRetrySweep.mjs')
  const run = {
    id: 'run-2',
    ownerId: 'user-1',
    branches: [{ id: 'branch-2', status: 'failed', attempt: 0, activeJobId: 'job-2' }],
  }
  let job
  const events = []
  const sweep = createAgentBranchRetrySweep({
    productStore: {
      listRunsWithFailedBranches: async () => [{ runId: run.id, ownerId: run.ownerId }],
      readAgentRunForWorker: async () => run,
      readGenerationJobForWorker: async () => job,
    },
    retryAgentBranch: async () => ({ kind: 'ok' }),
    observe: (event) => events.push(event),
    now: () => 10 * 60_000,
  })

  job = undefined                                   // → job_missing
  await sweep()
  job = { id: 'job-2', rawInput: {}, errorCode: 'PROVIDER_REJECTED', batchCount: 1, updatedAt: 0 }
  await sweep()                                     // → error_not_retryable
  await sweep()                                     // 同上，不再记

  const reasons = events.filter((event) => event.event === 'agent.branch.retry.held').map((event) => event.reason)
  assert.deepEqual(reasons, ['job_missing', 'error_not_retryable'])
})
```

- [ ] **Step 2：跑测试确认失败**

Run: `node --test server/agentBranchRetrySweep.test.mjs`
Expected: FAIL —— 第一条报 `held.length` 是 3 而非 1

- [ ] **Step 3：写实现**

`server/agentBranchRetrySweep.mjs` 的 `createAgentBranchRetrySweep` 里，在 `return async function sweepFailedBranches` 之前加状态表：

```js
  /**
   * 已记录过的 held 原因：`${runId}:${branchId}` → reason。
   *
   * 清扫每 90 秒跑一次，而 `error_not_retryable` 这类原因**永远不会变** ——
   * 生产上同一个死分支连刷了 40 分钟以上，每 90 秒一条。原因未变就不再重记。
   *
   * 只在进程内存里：Worker 重启后会再记一次当前状态，这是想要的行为
   * （新进程该把它看到的状态说一次），不是缺陷。
   */
  const loggedHeldReasons = new Map()
```

`:55-59` 的 held 循环改为：

```js
        for (const entryHeld of outcome.held) {
          held += 1
          const key = `${run.id}:${entryHeld.branchId}`
          if (loggedHeldReasons.get(key) === entryHeld.reason) continue
          loggedHeldReasons.set(key, entryHeld.reason)
          // 停下的原因进日志：用户与运维都要能回答「为什么它没自动重试」。
          // 但只在原因**变化**时记 —— 重复同一条不增加任何信息。
          observe({ event: 'agent.branch.retry.held', runId: run.id, branchId: entryHeld.branchId, reason: entryHeld.reason })
        }
```

在 `for (const candidate of outcome.eligible)` 循环体开头加一行，让重试成功的分支不留下过期记录：

```js
        for (const candidate of outcome.eligible) {
          // 这一支要重跑了，之前的 held 记录作废；下次再停下要重新记一条。
          loggedHeldReasons.delete(`${run.id}:${candidate.branchId}`)
```

- [ ] **Step 4：跑测试确认通过**

Run: `node --test server/agentBranchRetrySweep.test.mjs`
Expected: PASS

Run: `npm test`
Expected: PASS

- [ ] **Step 5：提交**

```bash
git add server/agentBranchRetrySweep.mjs server/agentBranchRetrySweep.test.mjs
git commit -m "fix(agent): held 分支的原因只在变化时记日志

生产上同一个永久失败的分支每 90 秒记一条 agent.branch.retry.held
reason=error_not_retryable，连刷 40 分钟以上。那个原因永远不会变，重复记录
不增加任何信息，只是把真正的事件淹掉。

判定 wait_for_user 是对的，不改；只是停止重复。原因真的迁移
（job_missing → error_not_retryable）仍记一条。重试成功时清掉记录，
下次再停下会重新记。

只在进程内存里：Worker 重启后再记一次当前状态，这是想要的行为。"
```

---

### Task 7：全量门禁与人工验证

**Files:** 无改动

- [ ] **Step 1：全量门禁**

```bash
npm test
npm run check:architecture
npm run check:security
npm run check:evals
npm run build
git diff --check
```

Expected: 全部 PASS

- [ ] **Step 2：确认硬编码已清零**

```bash
grep -rn "png|jpeg|webp" server/ src/ --include='*.mjs' --include='*.ts' --include='*.tsx' | grep -v '\.test\.' | grep -v mediaFormats
grep -rn "image/png,image/jpeg,image/webp" src/
```

Expected: 两条命令都无输出

- [ ] **Step 3：浏览器人工验证（自动化覆盖不到）**

1. 上传一张 12 MP 手机原图 → 提交生成 → 确认收到 **`IMAGE_TOO_LARGE_PIXELS`** 且提示写着「请缩小到长边 2048 以内」，**不再**出现 `help.openai.com`。这是生产 bug 的回归验证。
2. 上传一张 2 MP 以内的图 → 生成正常成功。
3. 文件选择器里确认只能选 PNG/JPEG/WebP（PR-A 不放宽格式）。
4. 上传一个把 `.jpg` 改名成 `.png` 的文件 → 提示「图片内容是 JPEG，与声明的 PNG 不一致」。

- [ ] **Step 4：PR 描述必须写明未被覆盖的部分**

```
未被自动化测试覆盖，需人工/后续确认：
- 真实浏览器文件选择与上传路径（node:test 无 DOM）
- MEDIA_LIMITS.maxCanonicalPixels = 4_000_000 是保守猜测。实测只知道
  2.2 MP 能过、12.2 MP 被拒，真实阈值需要一次真实供应商调用二分。
- 清扫的「不再重读 run 与 job」未做，需 listRunsWithFailedBranches 返回
  版本号，属 store 查询层改动。
```

---

## 自查

**规格覆盖：** PR-A 在规格里的范围是「词表与契约 + 嗅探器收编 + 像素守卫 + 错误文案 + 清扫落定」。Task 1 覆盖词表与上限常量与偏移感知匹配器；Task 2 覆盖四份嗅探收编与 9 处硬编码中的服务端部分；Task 3 覆盖像素守卫；Task 4 覆盖错误文案；Task 5 覆盖跨边界契约与客户端 4 处 `accept=` 加 `uploadedAssets`；Task 6 覆盖清扫落定（重读优化显式排除并说明原因）。规格里 PR-B/PR-C 的内容不在本计划。

**类型一致性：** `imagePixelSize` 在 Task 1 定义为返回 `{width,height} | null`，Task 2 的 `readMediaSpec` 与 Task 3 的 `assertImagePixelBudget` 都按 `null` 判空。`detectImageFormat` 返回 `string | undefined`，Task 2 的 `parseImageDataUrl` 与 `providerImage` 都按 `undefined` 判空。`MEDIA_LIMITS` 服务端六个字段、客户端只含 `maxUploadBytes`，契约测试只比对后者。

**已知偏离规格之处（有意）：** 规格的清扫修法写了「原因未变则不再重记、也不再重读」，本计划只做前半。后半需要 store 查询层返回版本号，放大了 PR-A 的风险面，而噪音这个实际危害已被前半消掉。
