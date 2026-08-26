import type { ProductLocale } from '../i18n/core'

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
 * **不筛具体格式，但过滤非媒体类型**：具体的格式与体积由 `validateUploadFiles`
 * 统一判定，在这里再写一遍就会出现两份词表。但 PDF 等非媒体类型会被默认拒绝，
 * 这避免将用户可能无意的内容变成「仅支持 PNG、JPEG、WebP」的错误提示。
 * 过滤使用宽泛的类别前缀（image/、video/）而不是具体的 MIME 列表，保持检查轻量。
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
 * 四条规则，顺序不能换：
 *
 * 1. 没有媒体文件 → `ignore`。**文本粘贴绝不被劫持**，这是最容易造成回归的地方。
 * 2. 焦点在对话框内 → `composer`。对话框的文本区是唯一「在文本输入里粘贴图片」
 *    有明确意图的地方，所以这条要排在文本输入判定和弹层判定之前——Agent 面板
 *    本身不是模态弹层，别处开着弹层不该连累到 composer 粘贴。
 * 3. 画布上的文本输入里（节点标题、搜索框）→ `ignore`。用户正在改标题时粘贴，
 *    凭空多出一个画布节点是惊吓不是惊喜。
 * 4. 有模态弹层打开（账户设置、确认框、模板/项目对话框等）→ `ignore`。这些弹层
 *    盖住整个画布，落在视口中心的素材会藏在弹层后面，用户看不到任何反馈，
 *    过后发现一个来源不明的节点——静默失败正是这个功能一直在避免的那类问题。
 */
export function pasteTarget({
  hasMediaFiles,
  insideAgentPanel,
  insideTextEntry,
  modalOpen,
}: {
  hasMediaFiles: boolean
  insideAgentPanel: boolean
  insideTextEntry: boolean
  modalOpen: boolean
}): PasteTarget {
  if (!hasMediaFiles) return 'ignore'
  if (insideAgentPanel) return 'composer'
  if (insideTextEntry) return 'ignore'
  if (modalOpen) return 'ignore'
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
