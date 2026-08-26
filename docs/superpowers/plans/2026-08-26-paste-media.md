# PR-1：粘贴图片进画布与对话框 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户可以把复制的图片（截图、网页右键复制、Finder 复制文件）粘贴进对话框或画布，落点与命名都可预期，且**文本粘贴绝不被劫持**。

**Architecture:** 判定逻辑做成纯函数放 `src/domain/`（`node:test` 里没有 `DataTransfer`/`ClipboardEvent`，只有 `File`/`Blob`），机制层薄到没有逻辑可测。两个监听器各管一块**互不重叠**的区域，用同一个判定式界定，因此不依赖事件触发顺序：对话框侧挂在 `<aside className="agent-workspace">` 上（与已有的 `onDrop` 同一元素），画布侧挂 window 监听并排除 `.agent-workspace` 内的事件。两侧都复用既有的上传管线，不新增上传路径。

**Tech Stack:** 原生 `node:test`；`.ts` 测试走 `--experimental-strip-types`。**不新增任何运行时依赖。**

**Spec:** `docs/superpowers/specs/2026-08-26-media-upload-paste-video-design.md`（本计划只实现其中的 PR-1；视频与直传上传明确不在范围内）

## Global Constraints

- **文本粘贴绝不被劫持。** 剪贴板里没有文件类图片时，事件原样放行，不 `preventDefault`。这是本功能最容易造成回归的地方。
- **读 `clipboardData.items`,不是 `.files`。** 截图、网页右键复制图片、图像编辑器复制都只在 `items` 里给 blob；只认 `files` 会漏掉最常见的截图场景。
- **不处理 `text/html` 与 `text/uri-list`。** 抓远端 URL 会引入 SSRF 面，且那是「粘贴链接」，是另一个功能。
- **不新增上传路径。** 对话框走既有 `importImageFiles`,画布走既有 `addDroppedFilesToCanvas`。
- 格式与体积判定一律复用 `validateUploadFiles`（`src/lib/uploadedAssets.ts`），**不在粘贴路径上另写一份**。
- `src/domain/` 不得导入 `server/`（`check:architecture` 强制）。
- 浏览器原语必须可注入或以普通描述对象为入参，否则 `src/domain/*.test.ts` 覆盖不到。
- 全量中英双语，`{ 'zh-CN', en }` 形状由 TypeScript 强制。
- 注释用中文，解释**为什么**而非做了什么。
- 每个任务结束时全量门禁必须绿：`npm test`、`npm run check:architecture`、`npm run check:security`、`npm run build`、`git diff --check`。

## 现状（不要重做）

| 能力 | 位置 | 现状 |
| --- | --- | --- |
| 桌面拖拽 → 对话框 | `AgentWorkspace.tsx:2397/2399` 的 `onDragOver`/`onDrop` → `:827` `importImageFiles` | 已实现 |
| 桌面拖拽 → 画布 | `useCanvasInteractionCoordinator.ts:207` `onCanvasDrop` → `:177` `addDroppedFilesToCanvas(files, position)` | 已实现 |
| 上传校验 | `src/lib/uploadedAssets.ts` `validateUploadFiles(files, locale)` | 已实现，返回 `{ accepted, message }` |
| 素材读取 | `src/lib/uploadedAssets.ts:37` `readUploadedAssetInput(file, role)` | 已实现，`name` 取 `file.name` 去扩展名 |
| 坐标映射 | `useCanvasInteractionCoordinator.ts` 的 `screenToFlowPositionRef` | 已实现，`onCanvasDrop` 用 `event.clientX/Y` |
| 粘贴 | —— | **完全不存在** |

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `src/domain/clipboardMedia.ts`（新建） | 纯判定：挑出媒体文件、决定落点、决定素材名 |
| `src/domain/clipboardMedia.test.ts`（新建） | 本计划**全部**自动化测试都在这里 |
| `src/lib/uploadedAssets.ts`（改） | 接线：把命名判定接进素材读取 |
| `src/features/agent/AgentWorkspace.tsx`（改） | `<aside>` 上加 `onPaste` |
| `src/features/canvas/useCanvasInteractionCoordinator.ts`（改） | 新增 `pasteFilesToCanvasCenter` |
| `src/features/canvas/CanvasWorkspace.tsx`（改） | 挂 window 粘贴监听器 |

---

### Task 1：剪贴板纯判定模块

**Files:**
- Create: `src/domain/clipboardMedia.ts`
- Test: `src/domain/clipboardMedia.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type ClipboardItemLike = { kind: string; type: string; getAsFile: () => File | null }`
  - `type PasteTarget = 'composer' | 'canvas' | 'ignore'`
  - `clipboardMediaFiles(items: readonly ClipboardItemLike[]): File[]`
  - `pasteTarget(input: { hasMediaFiles: boolean; insideAgentPanel: boolean; insideTextEntry: boolean }): PasteTarget`
  - `pastedAssetName(rawFileName: string, options?: { source?: 'drop' | 'paste'; now?: Date; locale?: ProductLocale }): string`

- [ ] **Step 1：写失败测试**

创建 `src/domain/clipboardMedia.test.ts`：

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { clipboardMediaFiles, pastedAssetName, pasteTarget } from './clipboardMedia.ts'

function item(kind: string, type: string, file: File | null) {
  return { kind, type, getAsFile: () => file }
}

const png = new File(['x'], 'shot.png', { type: 'image/png' })
const mp4 = new File(['x'], 'clip.mp4', { type: 'video/mp4' })

test('只挑出文件类的媒体条目', () => {
  const files = clipboardMediaFiles([
    item('string', 'text/html', null),
    item('string', 'text/uri-list', null),
    item('file', 'image/png', png),
  ])
  assert.deepEqual(files, [png])
})

test('网页复制的图片同时带 text/html，仍只取文件', () => {
  // 从网页右键复制图片时，剪贴板里同时有 text/html（一个 <img src>）。
  // 抓那个远端 URL 会引入 SSRF 面，且那是「粘贴链接」而非「粘贴图片」。
  const files = clipboardMediaFiles([
    item('string', 'text/html', null),
    item('file', 'image/png', png),
  ])
  assert.equal(files.length, 1)
})

test('视频文件同样通过 —— 不写图片专属过滤', () => {
  // 不加过滤比加过滤代码更少；从 Finder 复制视频粘贴会正常工作。
  assert.deepEqual(clipboardMediaFiles([item('file', 'video/mp4', mp4)]), [mp4])
})

test('getAsFile 返回 null 的条目被跳过而不是塞进 null', () => {
  assert.deepEqual(clipboardMediaFiles([item('file', 'image/png', null)]), [])
})

test('纯文本剪贴板得到空数组', () => {
  assert.deepEqual(clipboardMediaFiles([item('string', 'text/plain', null)]), [])
})

test('没有媒体文件时一律 ignore —— 文本粘贴绝不被劫持', () => {
  for (const insideAgentPanel of [true, false]) {
    for (const insideTextEntry of [true, false]) {
      assert.equal(
        pasteTarget({ hasMediaFiles: false, insideAgentPanel, insideTextEntry }),
        'ignore',
        `hasMediaFiles=false 时必须 ignore（panel=${insideAgentPanel} text=${insideTextEntry}）`,
      )
    }
  }
})

test('焦点在对话框内 → composer，即便那是个文本框', () => {
  // 对话框的文本区是唯一「在文本输入里粘贴图片」有明确意图的地方。
  assert.equal(pasteTarget({ hasMediaFiles: true, insideAgentPanel: true, insideTextEntry: true }), 'composer')
  assert.equal(pasteTarget({ hasMediaFiles: true, insideAgentPanel: true, insideTextEntry: false }), 'composer')
})

test('画布上的文本输入里粘贴图片 → ignore', () => {
  // 用户正在改节点标题时粘贴，凭空多出一个画布节点是惊吓不是惊喜。
  assert.equal(pasteTarget({ hasMediaFiles: true, insideAgentPanel: false, insideTextEntry: true }), 'ignore')
})

test('画布空白处粘贴图片 → canvas', () => {
  assert.equal(pasteTarget({ hasMediaFiles: true, insideAgentPanel: false, insideTextEntry: false }), 'canvas')
})

test('拖放来源的命名行为完全不变', () => {
  // 回归钉子：拖放的文件一定带真实文件名，覆盖它是错的。
  assert.equal(pastedAssetName('product-hero.png'), 'product-hero')
  assert.equal(pastedAssetName('product-hero.png', { source: 'drop' }), 'product-hero')
  // 即便名字是通用的，拖放来源也不回落 —— 用户确实有个叫 image.png 的文件。
  assert.equal(pastedAssetName('image.png', { source: 'drop' }), 'image')
})

test('粘贴来源且文件名无意义时用带时间戳的回落名', () => {
  // 截图进剪贴板时 name 常是空串或通用的 image，直接用会得到空素材名，
  // 或者一列无法区分的「image」—— 素材库很快就没法用了。
  const now = new Date(2026, 7, 26, 14, 30)
  assert.equal(pastedAssetName('', { source: 'paste', now }), '粘贴的图片 14:30')
  assert.equal(pastedAssetName('image.png', { source: 'paste', now }), '粘贴的图片 14:30')
  assert.equal(pastedAssetName('  ', { source: 'paste', now }), '粘贴的图片 14:30')
  assert.equal(pastedAssetName('Untitled.png', { source: 'paste', now }), '粘贴的图片 14:30')
})

test('回落名补零且双语', () => {
  const now = new Date(2026, 7, 26, 9, 5)
  assert.equal(pastedAssetName('', { source: 'paste', now }), '粘贴的图片 09:05')
  assert.equal(pastedAssetName('', { source: 'paste', now, locale: 'en' }), 'Pasted image 09:05')
})

test('粘贴来源但文件名有意义时保留原名', () => {
  // 从 Finder 复制的文件带真实文件名，不能被覆盖。
  assert.equal(pastedAssetName('brand-guide.png', { source: 'paste' }), 'brand-guide')
})
```

- [ ] **Step 2：跑测试确认失败**

Run: `node --experimental-strip-types --test src/domain/clipboardMedia.test.ts`
Expected: FAIL —— 找不到模块 `./clipboardMedia.ts`

- [ ] **Step 3：写实现**

创建 `src/domain/clipboardMedia.ts`：

```ts
/**
 * 粘贴的纯判定。
 *
 * 放在 domain 层是因为 `node:test` 里没有 `DataTransfer` 与 `ClipboardEvent`
 * （只有 `File`/`Blob`）—— 判定必须以普通描述对象为入参才可测，机制层则薄到
 * 没有逻辑可测。
 */

/** `DataTransferItem` 里我们真正用到的那几个成员。 */
export type ClipboardItemLike = {
  kind: string
  type: string
  getAsFile: () => File | null
}

export type PasteTarget = 'composer' | 'canvas' | 'ignore'

/**
 * 从剪贴板条目里挑出媒体文件。
 *
 * **读 items 而不是 files**：从 Finder 复制文件两边都有，但截图
 * （macOS 的 Cmd+Shift+Ctrl+4）、网页右键复制图片、图像编辑器复制，
 * 都只在 `items` 里给一个 blob。只认 `files` 会漏掉最常见的截图场景。
 *
 * 不筛具体格式：格式与体积由 `validateUploadFiles` 统一判定，在这里再写一遍
 * 就会出现两份词表。也不筛图片/视频 —— 不写过滤比写过滤代码更少。
 */
export function clipboardMediaFiles(items: readonly ClipboardItemLike[]): File[] {
  const files: File[] = []
  for (const item of items) {
    if (item.kind !== 'file') continue
    if (!item.type.startsWith('image/') && !item.type.startsWith('video/')) continue
    // 条目声明是文件但取不出来（跨进程复制时会发生），跳过而不是塞进一个 null。
    const file = item.getAsFile()
    if (file) files.push(file)
  }
  return files
}

/**
 * 这次粘贴该落到哪。
 *
 * 三条规则，顺序不能换：
 *
 * 1. 没有媒体文件 → `ignore`。**文本粘贴绝不被劫持**，这是最容易造成回归的地方。
 * 2. 焦点在对话框内 → `composer`。对话框的文本区是唯一「在文本输入里粘贴图片」
 *    有明确意图的地方，所以这条要排在文本输入判定之前。
 * 3. 画布上的文本输入里（节点标题、搜索框）→ `ignore`。用户正在改标题时粘贴，
 *    凭空多出一个画布节点是惊吓不是惊喜。
 */
export function pasteTarget({
  hasMediaFiles,
  insideAgentPanel,
  insideTextEntry,
}: {
  hasMediaFiles: boolean
  insideAgentPanel: boolean
  insideTextEntry: boolean
}): PasteTarget {
  if (!hasMediaFiles) return 'ignore'
  if (insideAgentPanel) return 'composer'
  if (insideTextEntry) return 'ignore'
  return 'canvas'
}

/** 截图进剪贴板时常见的无意义文件名。 */
const genericPastedNames = new Set(['', 'image', 'untitled', '未命名'])

/**
 * 素材显示名。
 *
 * 判定放在纯函数里，是因为它的宿主 `readUploadedAssetInput` 依赖 `FileReader`
 * 与 `Image`,这两个在 `node:test` 里不存在（实测 `ReferenceError`）——
 * 判定留在那边就等于不可测。
 *
 * **只有粘贴来源才可能落到回落名。** 拖放的文件一定带真实文件名，覆盖它是错的；
 * 而截图的 `name` 常是空串或通用的 `image`,直接用会得到空素材名，或者一列
 * 无法区分的「image」,素材库很快就没法用了。
 */
export function pastedAssetName(
  rawFileName: string,
  options: { source?: 'drop' | 'paste'; now?: Date; locale?: ProductLocale } = {},
): string {
  const baseName = rawFileName.replace(/\.[^.]+$/, '')
  if (options.source !== 'paste') return baseName
  if (!genericPastedNames.has(baseName.trim().toLowerCase())) return baseName
  const now = options.now ?? new Date()
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  return options.locale === 'en' ? `Pasted image ${time}` : `粘贴的图片 ${time}`
}
```

文件顶部需要类型引入（`import type` 会被 strip-types 抹除，无需扩展名）：

```ts
import type { ProductLocale } from '../i18n/core'
```

- [ ] **Step 4：跑测试确认通过**

Run: `node --experimental-strip-types --test src/domain/clipboardMedia.test.ts`
Expected: PASS，13 个测试全绿

- [ ] **Step 5：提交**

```bash
git add src/domain/clipboardMedia.ts src/domain/clipboardMedia.test.ts
git commit -m "feat(paste): 剪贴板判定纯函数

三件判定都放在这里：挑出媒体文件、决定落点、决定素材名。原因是 node:test 里
没有 DataTransfer/ClipboardEvent，而命名判定的宿主 readUploadedAssetInput
依赖 FileReader 与 Image —— 二者同样不存在。判定留在机制层就等于不可测。

读 items 而不是 files：截图、网页右键复制、图像编辑器复制都只在 items 里给 blob，
只认 files 会漏掉最常见的截图场景。

落点判定里「没有媒体文件一律 ignore」排第一 —— 文本粘贴绝不被劫持是本功能
最容易造成回归的地方，用穷举测试钉住。"
```

---

### Task 2：把命名判定接进素材读取

**Files:**
- Modify: `src/lib/uploadedAssets.ts:37-56`（`readUploadedAssetInput`）
- Test: 无新增单元测试（见下）

**Interfaces:**
- Consumes: Task 1 的 `pastedAssetName`
- Produces: `readUploadedAssetInput(file, role, options?: { source?: 'drop' | 'paste'; now?: Date; locale?: ProductLocale })` —— 第三参可选，**不传时行为与今天逐字节相同**

**关于测试：这一步不新增单元测试，这是刻意的。** `readUploadedAssetInput` 内部依赖 `FileReader` 与 `Image`,二者在 `node:test` 里都不存在——我实测过，直接调用抛 `ReferenceError: FileReader is not defined`。所以**判定已经在 Task 1 以纯函数全量覆盖**，这里只剩一行接线，没有可测的逻辑。

不要为了「补测试」去给 `FileReader`/`Image` 做注入改造：那是在改一个本任务不需要改的既有函数，收益是零（逻辑已在别处测过），风险是动了两个既有调用点。

- [ ] **Step 1：改实现**

`src/lib/uploadedAssets.ts` 顶部加 import：

```ts
import { pastedAssetName } from '../domain/clipboardMedia.ts'
```

**注意 `.ts` 后缀是必需的**：本文件被 `uploadedAssets.test.ts` 用 `node --experimental-strip-types` 直接加载执行（不经 Vite 打包），而这是**值导入**不是类型导入，必须能被 Node 的 ESM 解析器解析。仓库既有先例见 `src/domain/agentPlanContract.ts` 对 `./agent.ts` 的导入。

`readUploadedAssetInput` 改为：

```ts
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
```

原先的 `name: file.name.replace(/\.[^.]+$/, '')` 被 `pastedAssetName` 取代；不传 `options` 时 `source` 为 `undefined`,`pastedAssetName` 走 `options.source !== 'paste'` 分支直接返回去扩展名的原名——与今天完全一致。

- [ ] **Step 2：确认既有调用点未受影响**

Run: `npm test`
Expected: PASS。既有两个调用点（`AgentWorkspace.tsx:833`、`useCanvasInteractionCoordinator.ts:185`）不传第三参。

Run: `npx tsc -b`
Expected: PASS

Run: `grep -rn "readUploadedAssetInput" src/ | grep -v test`
Expected: 只有定义处与那两个既有调用点，共三条。若多出别的调用点，先看清它是否也该传 `source`。

- [ ] **Step 3：提交**

```bash
git add src/lib/uploadedAssets.ts
git commit -m "feat(paste): 素材命名改用纯判定函数

命名判定放在 domain 的纯函数里，因为宿主 readUploadedAssetInput 依赖
FileReader 与 Image，二者在 node:test 里都不存在（实测 ReferenceError），
判定留在这边就等于不可测。

不传第三参时行为与改动前逐字节相同，既有两个调用点不受影响。"
```

---

### Task 3：对话框粘贴

**Files:**
- Modify: `src/features/agent/AgentWorkspace.tsx:827-845`（`importImageFiles` 增加来源参数）、`:2393-2400`（`<aside>` 加 `onPaste`）
- Test: 无新增自动化测试（见下方说明）

**Interfaces:**
- Consumes: Task 1 的 `clipboardMediaFiles`；Task 2 的 `readUploadedAssetInput` 第三参
- Produces: 无对外导出

**关于测试：** 这一步没有可测的逻辑——判定在 Task 1 已全测，命名在 Task 2 已全测，这里只是把 `event.clipboardData.items` 读出来交给它们。仓库没有 React 测试渲染器，为此引入一个是不成比例的。**这一条要写进 PR 描述的「未被自动化覆盖」清单。**

- [ ] **Step 1：让 `importImageFiles` 知道来源**

`AgentWorkspace.tsx:827` 签名改为：

```tsx
  const importImageFiles = async (files: File[], source: 'drop' | 'paste' = 'drop') => {
```

`:833` 的 `readUploadedAssetInput` 调用改为：

```tsx
    const loaded = await Promise.allSettled(imageFiles.map((file) => readUploadedAssetInput(file, '场景', { source, locale })))
```

其余不动。缺省 `'drop'` 保证既有调用点行为不变。

- [ ] **Step 2：加粘贴处理器**

在 `handleImageDrop` 附近（`:866` 之后）新增：

```tsx
  const handlePaste = (event: ClipboardEvent<HTMLElement>) => {
    const items = Array.from(event.clipboardData?.items ?? [])
    const files = clipboardMediaFiles(items)
    // 没有媒体文件就原样放行 —— 用户可能正在往文本区粘贴文字。
    if (!files.length) return
    event.preventDefault()
    void importImageFiles(files, 'paste')
  }
```

文件顶部加 import：

```tsx
import { clipboardMediaFiles } from '../../domain/clipboardMedia'
```

`ClipboardEvent` 需要从 react 的类型里引入，与该文件既有的 `DragEvent`/`ChangeEvent` 同一处。

- [ ] **Step 3：挂到已有的 `<aside>` 上**

`:2393` 的 `<aside>` 已经有 `onDragOver={handleImageDragOver}` 与 `onDrop={handleImageDrop}`,在同一处加：

```tsx
      onPaste={handlePaste}
```

挂在这个元素上而非 window,是因为 React 的粘贴事件从聚焦元素冒泡上来，所以它天然只捕获对话框内部的粘贴；而错误提示（`setError`）本来就在这个组件里，用户会在他操作的地方看到反馈。

- [ ] **Step 4：门禁**

```bash
npm test
npx tsc -b
npm run build
```
Expected: 全部 PASS

- [ ] **Step 5：提交**

```bash
git add src/features/agent/AgentWorkspace.tsx
git commit -m "feat(paste): 对话框支持粘贴图片

onPaste 挂在已有 onDrop/onDragOver 的同一个 <aside> 上：React 的粘贴事件从
聚焦元素冒泡上来，所以它天然只捕获对话框内部的粘贴，不需要 window 监听；
而错误提示本来就在这个组件里，用户会在他操作的地方看到反馈。

剪贴板里没有媒体文件时直接 return，不 preventDefault —— 文本粘贴照常。"
```

---

### Task 4：画布粘贴

**Files:**
- Modify: `src/features/canvas/useCanvasInteractionCoordinator.ts`（新增 `pasteFilesToCanvasCenter`,并加入返回值）
- Modify: `src/features/canvas/CanvasWorkspace.tsx`（挂 window 监听器）
- Test: 无新增自动化测试（同 Task 3，判定已在 Task 1 全测）

**Interfaces:**
- Consumes: Task 1 的 `clipboardMediaFiles` 与 `pasteTarget`；既有的 `addDroppedFilesToCanvas(files, position)`
- Produces: `pasteFilesToCanvasCenter(files: File[]): void`（由协调器返回值导出）

- [ ] **Step 1：协调器新增视口中心落点**

在 `useCanvasInteractionCoordinator.ts` 的 `addDroppedFilesToCanvas`（`:177`）之后新增：

```ts
  /**
   * 把文件加到当前视口中心。
   *
   * 粘贴不是指针事件，没有 `clientX/Y` 可用 —— `onCanvasDrop` 正是靠它。
   * 记录最后指针位置需要新增状态，且指针从未进过画布时仍要回落；视口中心
   * 可预测、无新状态：用户粘贴后，东西出现在他正在看的地方。
   */
  const pasteFilesToCanvasCenter = useCallback((files: File[]) => {
    const mapper = screenToFlowPositionRef.current
    if (!mapper) return
    const surface = window.document.querySelector('.react-flow')
    if (!surface) return
    const rect = surface.getBoundingClientRect()
    const position = mapper({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
    void addDroppedFilesToCanvas(files, position)
  }, [addDroppedFilesToCanvas, screenToFlowPositionRef])
```

`.react-flow` 是既有 `isFlowDropTarget`（`:222`）用的同一个选择器，不新造。

把 `pasteFilesToCanvasCenter` 加进协调器的返回对象（`:415` 附近，`addDroppedFilesToCanvas` 旁边）。

- [ ] **Step 2：CanvasWorkspace 挂 window 监听器**

在 `CanvasWorkspace.tsx` 里，从协调器取出 `pasteFilesToCanvasCenter`,并新增：

```tsx
  useEffect(() => {
    const onPaste = (event: globalThis.ClipboardEvent) => {
      const target = event.target
      const element = target instanceof Element ? target : null
      // 对话框内部的粘贴由 AgentWorkspace 的 onPaste 处理。两个监听器各管一块
      // 互不重叠的区域、用同一个判定式界定，因此不依赖事件触发顺序。
      const insideAgentPanel = Boolean(element?.closest('.agent-workspace'))
      const insideTextEntry = Boolean(
        element?.closest('input, textarea, [contenteditable="true"]'),
      )
      const files = clipboardMediaFiles(Array.from(event.clipboardData?.items ?? []))
      if (pasteTarget({ hasMediaFiles: files.length > 0, insideAgentPanel, insideTextEntry }) !== 'canvas') return
      event.preventDefault()
      pasteFilesToCanvasCenter(files)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [pasteFilesToCanvasCenter])
```

文件顶部加 import：

```tsx
import { clipboardMediaFiles, pasteTarget } from '../../domain/clipboardMedia'
```

- [ ] **Step 3：门禁**

```bash
npm test
npm run check:architecture
npx tsc -b
npm run build
```
Expected: 全部 PASS

- [ ] **Step 4：提交**

```bash
git add src/features/canvas/useCanvasInteractionCoordinator.ts src/features/canvas/CanvasWorkspace.tsx
git commit -m "feat(paste): 画布支持粘贴图片，落在视口中心

粘贴不是指针事件，没有 clientX/Y —— onCanvasDrop 正是靠它。记录最后指针位置
要新增状态且指针没进过画布时仍需回落；视口中心可预测、无新状态。

window 监听器排除 .agent-workspace 内的事件，与 AgentWorkspace 的 onPaste
各管一块互不重叠的区域、用同一个判定式界定，因此不依赖事件触发顺序。
画布上的文本输入（节点标题、搜索框）里粘贴图片一律放行不处理。"
```

---

### Task 5：全量门禁与人工验证

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

- [ ] **Step 2：浏览器人工验证（自动化覆盖不到，必做）**

`node:test` 里没有 DOM,粘贴事件与剪贴板行为只能人工验。逐条走：

1. 截图（`Cmd+Shift+Ctrl+4`）后在**对话框文本区**里 `Cmd+V` → 成为上下文 chip，且名称是「粘贴的图片 HH:MM」而非空。
2. 截图后点一下**画布空白处**再 `Cmd+V` → 素材出现在视口中心。
3. **在节点标题输入框里粘贴一段文字** → 文字正常粘贴，不产生任何素材。**这条是最重要的回归验证。**
4. 在对话框文本区里粘贴一段文字 → 文字正常粘进文本区。
5. 从 Finder 复制一个 `.png` 文件 → 粘进画布 → 素材名是真实文件名，不是回落名。
6. 从网页右键复制一张图片 → 粘进对话框 → 成功，且没有发起任何对远端 URL 的请求（网络面板确认）。
7. 复制一个 `.gif`（不在词表内）→ 粘贴 → 被 `validateUploadFiles` 跳过并给出提示，不静默失败。
8. 关闭对话框后在画布上粘贴 → 仍落到画布（`.agent-workspace` 不存在时判定自然落到 canvas）。

- [ ] **Step 3：PR 描述必须写明未被自动化覆盖的部分**

```
未被自动化测试覆盖，需人工确认：
- 粘贴事件与剪贴板读取（node:test 无 DOM，无 DataTransfer/ClipboardEvent）
- 两个监听器的区域划分在真实事件流下确实互不重叠
- 跨浏览器/操作系统的剪贴板差异（截图来源、网页复制来源）
判定逻辑本身已在 src/domain/clipboardMedia.test.ts 全量覆盖，包括
「没有媒体文件一律 ignore」的穷举。
```

---

## 自查

**规格覆盖：** spec 的 PR-1 要求四件事——读 `items` 而非 `files`（Task 1）、按焦点路由且不劫持文本（Task 1 判定 + Task 3/4 接线）、画布落在视口中心（Task 4）、粘贴内容的命名回落（Task 2）。「不处理 `text/html`/`text/uri-list`」由 Task 1 的 `kind !== 'file'` 过滤天然满足，并有专门测试。视频粘贴「顺带工作」由 Task 1 不写图片专属过滤实现，有测试。

**类型一致性：** `clipboardMediaFiles` 在 Task 1 定义为收 `readonly ClipboardItemLike[]` 返回 `File[]`,Task 3 与 Task 4 都传 `Array.from(event.clipboardData?.items ?? [])`。`pasteTarget` 的三个布尔入参在 Task 4 逐一构造。`readUploadedAssetInput` 第三参在 Task 2 定义、Task 3 使用，两处字段名一致（`source`/`now`/`locale`）。

**起草时踩到并已修正的一处：** 初稿把命名判定留在 `readUploadedAssetInput` 里、在 `uploadedAssets.test.ts` 直接调它来测。实测发现该函数在 `node:test` 里**根本调不动**——它依赖 `FileReader` 与 `Image`,二者均为 `undefined`,调用抛 `ReferenceError`。那四条测试会全部因报错而非断言失败，是坏测试设计。已改为把判定抽成 `pastedAssetName` 纯函数放进 Task 1 的 domain 模块，`uploadedAssets.ts` 只剩一行接线。

**因此本计划的自动化测试全部集中在 `src/domain/clipboardMedia.test.ts`。** Task 2/3/4 都是接线，没有可测的逻辑——这不是偷懒，是仓库既有的纯逻辑/薄机制分层的直接结果（无 React 测试渲染器、`node:test` 无 DOM）。相应地，Task 5 的人工验证清单就是这三个任务唯一的验证手段，不能跳。
