# 媒体格式归一化与文档库摄取

> 设计规格。本轮只定方案，不改运行时代码。实现拆成 PR-A（词表与像素守卫）、PR-B（图片归一化与去重）、PR-C（文档库与抽取）。

**Goal:** 上传与 Agent 读取支持 PNG/JPEG/WebP/AVIF/GIF/BMP/HEIC/SVG；Composer 支持 PDF/Word/PowerPoint/Excel/CSV/TXT/Markdown。用户交给我们的原始文件保留，存储总量不增加。供应商拒绝时，用户看到的是可执行的下一步，不是转述的英文。

**Architecture:** 新增一层**摄取归一化**。图片在客户端解码、降采样、重编码为 canonical 格式（浏览器已自带解码器，顺带把上传体积降下来）；服务端持有权威词表与上限，是唯一的强制边界。文档原始字节存对象存储，**文本抽取在服务端**（`getTextContent()` 与 zip+XML 都不需要原生依赖），抽取结果本身也存为一个媒体对象。扫描件兜底由客户端渲页、把页面图**回流到图片归一化管线**，因此系统里没有任何原生光栅化依赖。

**Tech Stack:** 现有媒体服务 `server/mediaService.mjs`、生成校验 `server/generationProvider.mjs`、上传路由 `server/promptMediaRoutes.mjs`、客户端读取 `src/lib/uploadedAssets.ts`。新依赖仅两个：`pdfjs-dist`（PDF 文本抽取与客户端渲页）、`fflate`（解 zip，约 8 KB 零依赖）。

## Global Constraints

- 服务端是唯一鉴权与强制边界。客户端归一化是快路径，不是信任边界；界面隐藏不等于鉴权（同 `src/domain/projectCapabilities.ts` 的原则）。
- 「接受什么」与「存储/提交什么」是两个集合，不得合并。合并它们就是把归一化层存在的理由藏起来。
- 不改幂等键、任务恢复、项目版本冲突、媒体授权、Artifact 级联删除。
- 生成链路（`resolveGenerationInputMedia`、Worker、Provider 调用）不需要知道原图存在。它拿到的仍然是一个 canonical media id。
- `src/domain/` 不得导入 `server/`（`check:architecture` 强制）。跨边界词表按契约测试模式处理。
- 领域规则留在 `src/domain/` 与 `server/`；`src/components/` 不直接访问 Store、网络或服务端。
- 浏览器原语必须可注入，否则 `src/lib/*.test.ts` 无法覆盖编排逻辑。
- 全量中英双语。文案对象的 `{ 'zh-CN', en }` 形状由 TypeScript 强制。
- 普通开发测试不得调用真实生成 Provider。
- 用户上传的原始文件不被静默改动或丢弃；发生转码时必须在界面上说出来。

---

## 起因：一次生产失败

测试同学在新项目里连续失败，界面只显示「Agent run not completed」。逐层查下来：

- 5 次 `PROVIDER_REJECTED`，全部是同一句 `Invalid image file or mode for image 1 ... contact us at help.openai.com`。
- 失败的参考图是 **4032×3024（12.2 MP）iPhone 原图**，2777 KB，`image/jpeg`。
- 排除法（生产库全量 41 个带参考图的任务）：**格式无关** —— 一张 1280×1707（2.2 MP）JPEG 成功；**体积无关** —— 一张 6086 KB PNG 成功，比失败的还大；**文件无损坏** —— baseline 8-bit YCbCr、3 通道、EOI 完整、声明大小等于存储大小。
- 只剩像素量一个变量。所有成功的参考图 ≤ 2.2 MP，失败的 12.2 MP。

四处缺陷：

1. `validateGenerationInput` 只卡字节（`maximumReferenceBytes` 8 MB），**完全没有像素校验**。手机原图轻松过关，死在供应商那里。
2. 前后端都没有降采样（`imagePixelSize` 只在生成蒙版时用过）。
3. `generationProvider.mjs:397` 把供应商英文原文当作给用户的话。真正的答案「你的照片像素太大」没人告诉他。
4. `agentBranchRetrySweep.mjs:58` 对永久失败的分支**每 90 秒重记一条** `retry.held`，实测连刷 40 分钟以上，每轮还把 run 与其所有分支的 job 重读一遍。

`PROVIDER_REJECTED` 不在 `RETRYABLE_ERROR_CODES`（`agentBranchRetryPolicy.mjs:25`）里 —— **这是对的**，确定性输入错误重试只会再花一次钱。不要改。

顺带发现：**存储里存在大量逐字节重复。** 最大的 40 个对象只有 7 个唯一，235 MB → 44 MB（81% 冗余）。一张 PNG 存了 21 份。原因是 `persistBytes` 每次都生成新 `storage_key`，从不看内容。

---

## 现状（不要重做）

| 能力 | 现在在哪 | 现状 |
| --- | --- | --- |
| 格式白名单 | `generationProvider.mjs:34,268`、`mediaService.mjs:16`、`botanicAgentExecution.mjs:17`、4 处 `accept=`、`uploadedAssets.ts:6` | **9 处硬编码 `png\|jpeg\|webp`**，无权威词表 |
| 字节嗅探格式与尺寸 | `mediaSpec.mjs:122`、`regionMaskPng.mjs:29`、`mediaService.mjs:1`、`generationProvider.mjs:407` | **四份独立实现**。`imagePixelSize` 已覆盖 PNG/JPEG/WebP |
| 声明类型 vs 实际字节 | `mediaService.mjs:1` `matchesImageSignature`；`mediaSpec.mjs:118` 注释 | 已经以实际字节为准。但假设魔数在 offset 0 |
| 上传路由 | `promptMediaRoutes.mjs:47` | `POST /api/projects/:id/media`，JSON 里的 data URL，权限 `'edit'`，已限流 |
| 媒体读取 | `promptMediaRoutes.mjs:62` | 302 到签名 URL 或直接流回 |
| 上限 | `runtime.mjs:135-136` | 单文件 8 MB，请求体 32 MB |
| 客户端上传 | `uploadedAssets.ts:37` `readUploadedAssetInput` | 整个文件读成 data URL。**原图今天就在上传** |
| 摄取管线 | `AgentWorkspace.tsx:827` → 画布 asset 节点 → `contextNodeIds` → `botanicAgentVisionCandidates` | 唯一一条，假设「文件 == 图片 == 带 data URL 的节点」 |
| 浏览器 canvas 先例 | `src/lib/deliveryExport.ts` + `src/domain/deliveryPresentation.ts` | 机制/纯逻辑已经是拆开的 |
| 项目级 Agent 可读状态 | `canvas.ts:600` 的 `brandKit`；`agent_skills` 表 | 前者在画布文档 jsonb 里，后者独立表带 `active/archived` |
| 等着吃文本的消费者 | `brandKit.mjs:455` `proposeBrandRulesFromDocument` | 注释明写「入参是已抽取的文本，PDF 解包不在这里」 |
| 媒体删除 | —— | **不存在**。孤儿交给桶生命周期规则 |
| zip 能力 | `zipArchive.mjs` | 只导出 `writeZipArchive`，**只写且 store-only**，读不了 deflate |
| 跨边界词表 | `scripts/projectCapabilityContract.test.mjs` | 两处声明 + 契约测试读 TS 源码文本比对 |

---

## 问题 1：词表与契约

新建 `server/mediaFormats.mjs`，唯一权威。**三个集合，不是一个：**

```js
export const UPLOAD_IMAGE_FORMATS = Object.freeze([
  'image/png', 'image/jpeg', 'image/webp',
  'image/avif', 'image/gif', 'image/bmp',
  'image/heic', 'image/heif', 'image/svg+xml',
])

// 我们存储并交给供应商的。这是供应商约束，不是偏好。
export const CANONICAL_IMAGE_FORMATS = Object.freeze([
  'image/png', 'image/jpeg', 'image/webp',
])

export const UPLOAD_DOCUMENT_FORMATS = Object.freeze([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',   // docx
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // pptx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',         // xlsx
  'text/csv', 'text/plain', 'text/markdown',
])
```

不做 TIFF。`pptx`/`xlsx` 与 `docx` 同为 zip+XML，复用同一套解包，边际成本很低。

**上限，全部具名常量：**

| 常量 | 值 | 依据 |
| --- | --- | --- |
| `MAX_CANONICAL_LONG_EDGE` | 2048 | 归一化目标 |
| `MAX_CANONICAL_PIXELS` | 4_000_000 | **未钉死。** 实测只知道 2.2 MP 成功、12.2 MP 被拒 |
| `MAX_UPLOAD_BYTES` | 8 MB | 沿用 `maximumReferenceBytes` |
| `MAX_DECODE_PIXELS` | 80_000_000 | 生产里存在 96 MP JPEG，解 RGBA 要约 384 MB |
| `MAX_DOCUMENT_PAGES` | 200 | |
| `MAX_EXTRACTED_CHARS` | 200_000 | |
| `AGENT_DOC_CHARS_PER_DOC` | 30_000 | 注入预算 |
| `AGENT_DOC_CHARS_PER_TURN` | 60_000 | |

`MAX_CANONICAL_PIXELS` 必须在注释里标明是保守猜测、真实阈值需要一次真实调用去二分。它是一处常量、一处修改，不是散落的魔法数字。

### 嗅探器收编

把 `mediaSpec.mjs:122`、`regionMaskPng.mjs:29`、`mediaService.mjs:1`、`generationProvider.mjs:407` 四份实现收成 `mediaFormats.mjs` 里一份**偏移感知**的匹配器表，原处改为导入。

两个会打破现有校验的点：

- **HEIC 的标识在 offset 4**（`ftyp` box：`ftypheic` / `heix` / `mif1` / `msf1`），不在文件头。匹配器必须带偏移。
- **SVG 没有魔数**，它是 XML 文本。签名校验对它无效，走独立路径：解析 XML → 确认根元素是 `<svg>` → 消毒 → 才允许光栅化。

### 跨边界

```
server/mediaFormats.mjs              权威
src/domain/mediaFormats.ts           客户端副本，生成 accept= 属性
scripts/mediaFormatContract.test.mjs 断言两边逐项一致
```

照 `scripts/projectCapabilityContract.test.mjs` 的形状：把 TS 源码当文本读、正则抽词表、比对。不这么做的下场很具体：服务端加了 AVIF、`accept=` 忘了改，用户在文件选择器里根本选不到。

现有 9 处硬编码全部改为从词表导入；`accept=` 由词表生成，不再手写。

---

## 问题 2：图片归一化

### 纯逻辑 / 机制 拆分

仓库没有 React 测试渲染器，UI 逻辑必须住在可测的 `src/domain/`；但 `createImageBitmap`/`OffscreenCanvas` 在 `node:test` 里不存在。照 `deliveryPresentation.ts` + `deliveryExport.ts` 的既有先例拆。

**`src/domain/imageNormalization.ts` —— 纯函数**

```ts
normalizationPlan({ sourceFormat, width, height, byteSize, hasAlpha })
  → { action: 'accept_as_is' | 'transcode' | 'reject',
      targetFormat?, targetWidth?, targetHeight?,
      decodeWidth?, decodeHeight?,   // 交给 createImageBitmap 的降采样参数
      reason? }
```

| 输入 | 判定 | 理由 |
| --- | --- | --- |
| 格式不在 `UPLOAD_IMAGE_FORMATS` | `reject` | 说清支持哪些 |
| 已是 canonical 且在上限内 | **`accept_as_is`** | 不重编码。把好的 JPEG 再编一遍是白掉画质 |
| 有 alpha | `transcode` → png | JPEG 没有 alpha，转过去变黑底 |
| 无 alpha | `transcode` → jpeg | 照片体积小得多 |
| 超上限 | 等比缩到长边 ≤ 2048 且总像素 ≤ 4 MP | **绝不放大** |
| 任何需要降采样的情形 | 一并给出 `decodeWidth/Height` | 让浏览器在**解码期**就降采样，全尺寸位图从不落地 |
| 声明像素 > `MAX_DECODE_PIXELS` | `reject` | 解压炸弹防线。文件头声称的尺寸本身就荒谬，连解码都不试 |

`decodeWidth/Height` 与 `targetWidth/Height` 是两回事：前者交给 `createImageBitmap`，决定解码时分配多大内存；后者是最终输出尺寸。生产里存在 96 MP（8488×11317）JPEG，解成 RGBA 要约 384 MB —— 靠 `decodeWidth/Height` 避开，不是靠拒绝。`MAX_DECODE_PIXELS` 只挡比它更荒谬的输入。

SVG：无固有像素尺寸，按 `viewBox` 比例光栅化到长边 2048；无 `viewBox` 退到 1024×1024。GIF 只取首帧，并在界面说明。

**`src/lib/imageNormalizer.ts` —— 薄机制层，原语可注入**

- canonical + avif + gif + bmp → `createImageBitmap(file, { resizeWidth, resizeHeight, resizeQuality: 'high' })`，浏览器原生
- heic/heif → **只在真的拖进 HEIC 时才 `await import()` 解码器**，其他人一个字节都不下载
- svg → 读文本 → `svgSanitize` → `<img>` + `drawImage`。**Chrome 的 `createImageBitmap` 对 SVG blob 不可靠，必须走 `<img>`**
- 输出 → `OffscreenCanvas.convertToBlob({ type })`，无 `OffscreenCanvas` 时退到 `<canvas>`

**`src/domain/svgSanitize.ts` —— 纯函数，安全关键**

剥 `<script>`、`<foreignObject>`、`on*` 事件属性、外部 `href`/`xlink:href`、`javascript:` URL，限制实体展开。

### 接入点

今天有 4 个入口（`AgentWorkspace.tsx:827` 的 `importImageFiles`、`CanvasWorkspacePanels.tsx:522,535`、`CanvasWorkspace.tsx:2618`），全部收敛到 `readUploadedAssetInput` 内部。`UploadedAssetInput` 形状不变（`image`/`imageWidth`/`imageHeight`），值变成归一化后的 —— **改动半径极小**。

### 保留原图 + 内容寻址

原图今天就在上传，所以保留它**不是退步**；归一化件才是新增的那一小部分。8 MB 原图 base64 约 10.7 MB，加归一化件约 0.4 MB，共约 11 MB，在 32 MB 请求上限内 —— **不用改任何上限**。

```sql
-- media_objects 增量、可空、不回填
+ content_sha256 text          -- 老行 NULL，永不参与去重
+ derived_from_id text         -- 派生件指回原图；原图自己为 null
+ variant text                 -- 'original' | 'canonical'
- unique(storage_key)          -- 放开，允许多行指向同一对象
+ index (owner_id, content_sha256)
```

`persistBytes` 写入前算 `sha256`：命中 `(owner_id, sha256)` 就复用 `storage_key`、只插一行；未见过就正常写。

**`accept_as_is` 时只写一行。** 一份本来就是 canonical 且在上限内的文件，它同时既是原图也是归一化件：写一行 `variant='canonical'`、`derived_from_id=null`。**只有真的发生了转码才有两行。** 否则每张合规上传都会凭空多出一份逐字节相同的记录，去重虽然不会多存字节，但行数与界面上的「原图 / 归一化件」区分会变得毫无意义。

抽取出的文档正文走 `persistBytes` 直接落 `text/plain`，**不经 `persistDataUrl`** —— 后者只认图片词表，会把它拒掉。

**按 owner 分域，不做全局去重。** 全局去重有跨租户侧信道：上传一个文件、观察是否被去重，即可推断他人是否持有同一文件。分域消掉这条，且实测到的 21 份重复本就是同一个人在自己各项目里反复上传。

放开 unique 用 `alter table ... drop constraint if exists`，仓库已有先例（`agent_turns_status_check`）。

**画布节点指向归一化件**，不指原图。生成链路完全不需要知道原图存在。原图通过 `derived_from_id` 反查，只在下载、全分辨率交付、以及**将来钉死真实像素阈值后重新归一化**时用到 —— 这正是保留原图的主要理由：让 4 MP 这个猜测可回退。

**一次请求，两个 blob，共存亡。** 不做后台补传。说自己留了原图却其实没留，比直接失败更糟。

**给未来留的约束，必须写进注释：** 一旦有人加媒体删除，就不能再直接删对象，必须先确认没有其他行引用同一 `storage_key`。今天没有删除路径所以安全，但这个前提要显式记下，否则将来加删除的人会删掉别人还在用的字节。

**净账：** 最大 40 个对象 235 MB → 约 44 MB + 归一化件约 4 MB ≈ **48 MB**，降到约五分之一，同时保留原图。

### SVG 原图回传是 XSS 面

原图按 `UPLOAD_IMAGE_FORMATS` 存，所以 SVG 原文会留在存储里。`promptMediaRoutes.mjs:62` 的 GET 路由若带 `Content-Type: image/svg+xml` 从我们源站返回，就是可执行文档在同源下运行。**SVG 原图必须以 `application/octet-stream` + `Content-Disposition: attachment` 返回，永不内联。** 归一化件是 PNG，正常返回。

### 服务端守卫

`persistDataUrl` 按 `variant` 分流：`canonical` 只接受 `CANONICAL_IMAGE_FORMATS` 且用收编后的嗅探器验像素与字节；`original` 按 `UPLOAD_IMAGE_FORMATS` 校验。越界返回可执行的话，不是转述供应商英文。

同时给 `validateGenerationInput` 加像素校验 —— 这是起因那个 bug 的直接修复，且**不需要任何新依赖**，`imagePixelSize` 已覆盖三个 canonical 格式。

### 用户看到什么

静默改掉用户的素材不可接受。发生转码时，上下文 chip 上标一行事实，例如 `4032×3024 HEIC → 2048×1536 PNG`。`accept_as_is` 时什么都不标（因为什么都没变）。GIF 额外标「仅首帧」。

**代价摆明：** 非浏览器调用方（MCP/API）只能传已归一化的图。服务端把合约说清楚，这是诚实的取舍。

---

## 问题 3：文档库与抽取

### 归属

新建 `project_documents` 表。排除两个看起来更省事的选项：

- **不放画布文档 jsonb**（`brandKit` 在那儿）。抽出的正文会跟着 Yjs 同步给**每个打开项目的客户端** —— 5 份文档 × 200k 字符 = 每人 1 MB。元数据可以放，正文不行。
- **不复用 `agent_artifacts`**。其 `source_kind` 限定 `'agent_action' | 'generation_output'`，用户上传两个都不是。硬塞是把「系统产出的」和「用户给的」混成一类。

```sql
create table project_documents (
  project_id text not null references projects(id) on delete cascade,
  id text not null,
  owner_id text not null references app_users(id) on delete cascade,
  status text not null check (status in
    ('extracting','ready','needs_render','failed','archived')),
  format text not null,
  source_media_id text not null,  -- 原始字节，走去重
  text_media_id text,             -- 抽取结果，也是一个媒体对象
  page_count integer,
  char_count integer,
  updated_at bigint not null,
  payload jsonb not null,         -- 文件名、抽取错误、渲染页引用
  primary key (project_id, id)
);
```

**抽取结果存对象存储，不存 jsonb。** 这是上一轮调试换来的教训 —— 几 MB 的 jsonb 写入正是在不稳链路上断掉的那一环。存成 `text/plain` 媒体对象还顺带吃到去重：同一份品牌手册传两次，正文只存一份。

### 管线

```
POST /api/projects/:id/documents    权限 'edit'，复用 media 限流
  → 魔数校验 → persistBytes（去重）→ 建行 status='extracting' → 入 BullMQ
Worker 抽取
  → 有文字 → text_media_id + status='ready'
  → 无文字 → status='needs_render'（扫描件）
  → 出错   → status='failed'，payload 记原因
```

| 格式 | 手段 | 依赖 |
| --- | --- | --- |
| txt / md / csv | 解 UTF-8 | 无 |
| pdf | `pdfjs-dist` 的 `getTextContent()`，**不需要 canvas** | pdfjs-dist |
| docx / pptx / xlsx | 解 zip + 取 XML 文本节点 | fflate |

`zipArchive.mjs` 是只写且 store-only，读不了 deflate 压缩的 docx，复用不了。引入 `fflate`（约 8 KB 零依赖）而不是手写 deflate + ZIP64 读取器 —— 那东西写对不容易，出错方式还很安静。

**一个待实测的前提：** pdfjs 在 Node 下只做文本抽取应该不需要 canvas，但这一点**必须在实现时实测确认，不当成已知事实**。如果它确实拖出原生依赖，整体方案的前提要重估。

### 扫描件兜底不引入光栅化器

`needs_render` 的文档被引用时，界面提示可渲染；客户端拉原始字节、用 pdfjs + canvas 渲页、**把页面图当普通图片走问题 2 的归一化管线上传**。页面图直接成为可用参考素材，服务端一个原生依赖都不需要。

### Agent 怎么读

`@` 提及列出文档（**只传元数据**）。被引用的文档，服务端取正文注入上下文，按 `AGENT_DOC_CHARS_PER_DOC` / `_PER_TURN` 截断，并**显式标注**：`本文档共 N 页，已读第 1–M 页`。

静默截断一份品牌手册、让模型基于一半内容推理，最后表现成「模型答错了」，是最难查的一类问题。

暂不加检索工具（YAGNI），预算不够用了再说。

### Brand Kit 打通

`proposeBrandRulesFromDocument(text, { sourceRef: documentId })` 终于有上游。产出仍是 `status: 'proposed'` + `source: 'document_import'`，必须人工确认才生效 —— 这条约束 `normalizeBrandKit` 已经在守，不放松。

### 归档，不删除

删除会撞上去重留下的引用计数约束。`status='archived'` 从提及列表隐藏、字节保留 —— `agent_skills` 已是这个模式，照抄。

### 权限不新增

上传 `'edit'`，列出/读 `'read'`，`PROJECT_ENTRY_CAPABILITY` 不动。

---

## 问题 4：错误与测试

### 错误信息

本次工作的起因就是一句不可用的报错。新错误一律说清**阶段、原因、下一步**：

| 码 | 用户看到 |
| --- | --- |
| `IMAGE_FORMAT_UNSUPPORTED` | 不支持 `.tiff`。可用格式：PNG、JPEG、WebP、AVIF、GIF、BMP、HEIC、SVG |
| `IMAGE_DECODE_FAILED` | 这张 HEIC 无法在当前浏览器解码。换 Safari，或在手机上改用「最大兼容性」拍摄 |
| `IMAGE_TOO_LARGE_PIXELS` | 参考图 4032×3024 超过 400 万像素上限。请缩到长边 2048 以内 |
| `IMAGE_NOT_CANONICAL` | 接口只接受 PNG/JPEG/WebP。其他格式请先转换（浏览器上传会自动转） |
| `SVG_UNSAFE` | 这个 SVG 含有脚本或外部引用，已拒绝。请导出为不含脚本的纯图形 SVG |
| `DOCUMENT_FORMAT_UNSUPPORTED` | 不支持 `.pages`。可用：PDF、Word、PowerPoint、Excel、CSV、TXT、Markdown |
| `DOCUMENT_TOO_MANY_PAGES` | 这份 PDF 有 640 页，超过 200 页上限。请拆分后分别上传 |
| `DOCUMENT_EXTRACTION_FAILED` | 无法从这份文件读出文字，它可能已损坏或加密 |

同时修 `generationProvider.mjs:397`：供应商原文**留在日志里**做诊断，不再当作给用户看的那句话。像素守卫上线后这个具体拒绝不会再发生，但别的拒绝还会来。

### 顺带修：清扫日志无限刷

起因诊断里的第 4 处缺陷。`agentBranchRetrySweep.mjs:58` 每轮都无条件 `observe` 一条 `retry.held`，而 `reason='error_not_retryable'` 这类原因**永远不会变**，于是同一个死分支每 90 秒重记一条，实测连刷 40 分钟以上；每轮还把 run 与其所有分支的 job 重读一遍。

修法：在分支上记一个 `heldReason` + `heldAt`，**原因未变则不再重记、也不再重读**。判定 `wait_for_user` 是对的，落定它不改变行为，只是停止重复。原因变化（例如从 `job_missing` 变成 `error_not_retryable`）仍要记一条 —— 那是真的状态迁移。

测试：同一原因连续两轮清扫 → 只产生一条事件；原因变化 → 产生两条。

### 测试

| 层 | 文件 | 锁什么 |
| --- | --- | --- |
| 词表 | `server/mediaFormats.test.mjs` | 内容与顺序；`CANONICAL ⊆ UPLOAD`；每个非 SVG 格式都有匹配器；**HEIC 在 offset 4 命中** |
| 跨边界 | `scripts/mediaFormatContract.test.mjs` | 两份词表逐项一致 |
| 归一化策略 | `src/domain/imageNormalization.test.ts` | 整张决策表；canonical 且合规 → **不重编码**；有 alpha → png；绝不放大；96 MP → 解码期降采样参数 |
| SVG 消毒 | `src/domain/svgSanitize.test.ts` | **对抗性用例**：`<script>`、`onload=`、外部 `xlink:href`、`<foreignObject>`、`javascript:`、实体膨胀。没有对抗测试的消毒器不算消毒器 |
| 机制层 | `src/lib/imageNormalizer.test.ts` | 注入假原语测编排；**断言非 HEIC 时解码器不被 import** |
| 服务端守卫 | `server/mediaService.test.mjs` | 非 canonical 被拒；超像素被拒且消息可执行；声明与实际不符以实际为准；**SVG 原图以 attachment 返回** |
| 去重 | 同上 | 同 owner 同字节 → 一次写两行；不同 owner → 两次写；`content_sha256` 为 NULL 的老行不参与 |
| 像素守卫 | `server/generationProvider.test.mjs` | 12.2 MP 输入被拒且带 `IMAGE_TOO_LARGE_PIXELS`；2.2 MP 通过 |
| 文档抽取 | `server/documentExtraction.test.mjs` | 各格式；空文字 PDF → `needs_render`；页数上限；**截断输出显式页码范围** |
| Brand Kit | `server/brandKit.test.mjs` | 抽取文本 → `proposed` + `document_import`，`normalizeBrandKit` 仍拒绝直接激活 |
| 清扫落定 | `server/agentBranchRetrySweep.test.mjs` | 同一原因连续两轮 → 一条事件；原因变化 → 两条 |

`src/lib/*.test.ts` 在测试 glob 里，所以机制层必须把浏览器原语做成可注入的。

### 明确未被测试覆盖

一片绿不等于都验过了。以下三项必须在 PR 描述里写明：

- **真实浏览器 API 调用**（`createImageBitmap`、`OffscreenCanvas.convertToBlob`、pdfjs 渲页）。`node:test` 里没有 DOM，只能人工在浏览器验。
- **供应商真实像素阈值。** 4 MP 是保守猜测，钉它需要一次付费调用。
- **pdfjs 在 Node 下是否真的不需要 canvas。** 实现时实测。

---

## 推荐落地顺序

**PR-A：词表 + 像素守卫（先修生产 bug）**
`mediaFormats.mjs`、嗅探器收编、9 处硬编码改导入、契约测试、`validateGenerationInput` 加像素校验、`generationProvider.mjs:397` 文案修复、`agentBranchRetrySweep` 永久态落定。
不含新格式、不含新依赖。**独立可发，直接止血。**

**PR-B：图片归一化 + 原图 + 去重**
`imageNormalization.ts`、`svgSanitize.ts`、`imageNormalizer.ts`、HEIC 懒加载、`media_objects` 增列与去重、SVG attachment 回传、chip 转码提示。

**PR-C：文档库与抽取**
`project_documents` 表、上传路由、Worker 抽取、`fflate` + `pdfjs-dist`、`@` 提及与注入预算、扫描件渲页回流、Brand Kit 打通。

---

## 明确不做

- **TIFF。** 无浏览器原生解码，目标用户不是印刷供应链。
- **内嵌图片提取**（品牌手册里的 logo/色卡单独提出来）。YAGNI，未被选中。
- **文档检索工具。** 先用注入预算，不够再说。
- **媒体删除与引用计数。** 今天没有删除路径；文档用归档。
- **后台补传原图。** 一次请求共存亡。
- **服务端图片解码依赖**（sharp / libheif）。方案 C 的前提就是不引入。
- **服务端 PDF 光栅化。** 扫描件兜底由客户端渲页回流。
- **全局去重。** 跨租户侧信道。
- **改 `PROVIDER_REJECTED` 的可重试性。** 它不可重试是对的。
- **动 `id: production-${nodeId}` 等既有标识方案。**

---

## 验证

```bash
# 聚焦
node --test server/mediaFormats.test.mjs server/mediaService.test.mjs \
             server/documentExtraction.test.mjs server/generationProvider.test.mjs
node --test scripts/mediaFormatContract.test.mjs
node --experimental-strip-types --test \
     src/domain/imageNormalization.test.ts src/domain/svgSanitize.test.ts \
     src/lib/imageNormalizer.test.ts

# 全量门禁
npm test
npm run check:architecture
npm run check:security
npm run check:evals
npm run build
git diff --check
```

**浏览器手验（自动化覆盖不到，必做）：**

1. 上传一张 iPhone 原图（12 MP JPEG）→ 确认 chip 显示转码事实 → 提交生成 → **成功**（这是起因那个 bug 的回归）。
2. 上传 HEIC → Safari 成功；Chrome 走 wasm 解码器成功；确认非 HEIC 上传时该解码器不出现在网络面板。
3. 上传 SVG → 消毒后光栅化成功；直接访问原图 URL → 返回 attachment 而非内联渲染。
4. 上传同一张图两次 → 确认存储只多一行、不多一个对象。
5. 上传带文字层 PDF → `ready`，`@` 提及可用，注入带页码范围。
6. 上传扫描件 PDF → `needs_render`，渲页后页面图成为可用素材。
7. 上传 docx / pptx / xlsx / csv → 各自抽出文本。
8. 用品牌手册 PDF 触发 `proposeBrandRulesFromDocument` → 产出为 `proposed`，未经确认不生效。

---

## 文件地图（实现时）

**新增**

| 文件 | 职责 |
| --- | --- |
| `server/mediaFormats.mjs` | 权威词表、上限常量、偏移感知嗅探器 |
| `server/mediaFormats.test.mjs` | 词表锁定 |
| `server/documentExtraction.mjs` | 逐格式文本抽取 |
| `server/documentExtraction.test.mjs` | |
| `server/projectDocumentRoutes.mjs` | 上传/列出/归档 |
| `src/domain/mediaFormats.ts` | 客户端副本 |
| `src/domain/imageNormalization.ts` | 纯归一化策略 |
| `src/domain/imageNormalization.test.ts` | |
| `src/domain/svgSanitize.ts` | 纯消毒 |
| `src/domain/svgSanitize.test.ts` | 对抗性用例 |
| `src/lib/imageNormalizer.ts` | 薄浏览器机制，原语可注入 |
| `src/lib/imageNormalizer.test.ts` | |
| `src/lib/projectDocumentApi.ts` | |
| `scripts/mediaFormatContract.test.mjs` | 跨边界契约 |

**修改**

| 文件 | 改动 |
| --- | --- |
| `server/mediaService.mjs` | 嗅探器改导入；`persistBytes` 加 sha256 去重；`persistDataUrl` 按 variant 分流 |
| `server/generationProvider.mjs` | `:34`/`:268` 改导入；`validateGenerationInput` 加像素校验；`:397` 文案；`:407` 嗅探改导入 |
| `server/mediaSpec.mjs`、`server/regionMaskPng.mjs` | 嗅探实现收编后改导入 |
| `server/botanicAgentExecution.mjs` | `:17` 改导入 |
| `server/promptMediaRoutes.mjs` | SVG 原图 attachment 回传 |
| `server/postgresProductStore.mjs` | `media_objects` 增列、放开 unique、加索引；新建 `project_documents` |
| `server/brandKit.mjs` | 接上文档抽取（仅调用方，纯函数不动） |
| `server/agentBranchRetrySweep.mjs` | 永久态落定，停止每 90 秒重记 |
| `src/lib/uploadedAssets.ts` | 词表改导入；`readUploadedAssetInput` 内做归一化 |
| `src/features/agent/AgentComposer.tsx` | `accept=` 由词表生成；文档拖放 |
| `src/features/canvas/CanvasWorkspacePanels.tsx`、`CanvasWorkspace.tsx` | `accept=` 由词表生成 |
| `src/features/agent/AgentWorkspace.tsx` | `importImageFiles` 走归一化；文档 `@` 提及 |
| `src/domain/canvas.ts` | `UploadedAssetInput` 增可选来源规格字段 |
