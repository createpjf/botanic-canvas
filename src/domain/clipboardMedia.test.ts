import assert from 'node:assert/strict'
import test from 'node:test'
import { clipboardHasPlainText, clipboardMediaFiles, pastedAssetName, pasteTarget } from './clipboardMedia.ts'

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
  // 视频通过这一层，但被下游 validateUploadFiles 拒绝，因为 video 不在
  // UPLOAD_IMAGE_FORMATS 里。这个行为是本任务的预期 —— 视频上传超出范围。
  assert.deepEqual(clipboardMediaFiles([item('file', 'video/mp4', mp4)]), [mp4])
})

test('非媒体文件类型被过滤', () => {
  // PDF 等非媒体类型被这里默认拒绝，不产生错误消息噪音。
  // 一个用户可能没有打算上传的内容不会变成「仅支持 PNG、JPEG、WebP」的错误。
  const pdf = new File(['x'], 'doc.pdf', { type: 'application/pdf' })
  assert.deepEqual(clipboardMediaFiles([item('file', 'application/pdf', pdf)]), [])
})

test('getAsFile 返回 null 的条目被跳过而不是塞进 null', () => {
  assert.deepEqual(clipboardMediaFiles([item('file', 'image/png', null)]), [])
})

test('纯文本剪贴板得到空数组', () => {
  assert.deepEqual(clipboardMediaFiles([item('string', 'text/plain', null)]), [])
})

test('剪贴板里同时有图片和纯文本时能识别出文本', () => {
  // 表格单元格复制：一个 image 条目 + 一个 text/plain 条目。
  assert.equal(
    clipboardHasPlainText([item('file', 'image/png', png), item('string', 'text/plain', null)]),
    true,
  )
})

test('只有图片、没有纯文本时识别为没有文本', () => {
  // 截图场景：剪贴板里只有一个 file 条目，没有 text/plain。
  assert.equal(clipboardHasPlainText([item('file', 'image/png', png)]), false)
})

test('text/html 不算纯文本 —— 只认 text/plain', () => {
  // 网页复制图片时常带 text/html，但那不是用户能看到、期望原样粘贴的文字。
  assert.equal(
    clipboardHasPlainText([item('file', 'image/png', png), item('string', 'text/html', null)]),
    false,
  )
})

test('空剪贴板没有纯文本', () => {
  assert.equal(clipboardHasPlainText([]), false)
})

test('没有媒体文件时一律 ignore —— 文本粘贴绝不被劫持', () => {
  for (const insideAgentPanel of [true, false]) {
    for (const insideTextEntry of [true, false]) {
      for (const modalOpen of [true, false]) {
        assert.equal(
          pasteTarget({ hasMediaFiles: false, insideAgentPanel, insideTextEntry, modalOpen }),
          'ignore',
          `hasMediaFiles=false 时必须 ignore（panel=${insideAgentPanel} text=${insideTextEntry} modal=${modalOpen}）`,
        )
      }
    }
  }
})

test('焦点在对话框内 → composer，即便那是个文本框，也不受模态弹层影响', () => {
  // 对话框的文本区是唯一「在文本输入里粘贴图片」有明确意图的地方。
  assert.equal(pasteTarget({ hasMediaFiles: true, insideAgentPanel: true, insideTextEntry: true, modalOpen: false }), 'composer')
  assert.equal(pasteTarget({ hasMediaFiles: true, insideAgentPanel: true, insideTextEntry: false, modalOpen: false }), 'composer')
  // Agent 面板本身不是模态弹层：别处开着弹层（如账户设置）不该连累到 composer 粘贴。
  assert.equal(pasteTarget({ hasMediaFiles: true, insideAgentPanel: true, insideTextEntry: true, modalOpen: true }), 'composer')
  assert.equal(pasteTarget({ hasMediaFiles: true, insideAgentPanel: true, insideTextEntry: false, modalOpen: true }), 'composer')
})

test('画布上的文本输入里粘贴图片 → ignore', () => {
  // 用户正在改节点标题时粘贴，凭空多出一个画布节点是惊吓不是惊喜。
  assert.equal(pasteTarget({ hasMediaFiles: true, insideAgentPanel: false, insideTextEntry: true, modalOpen: false }), 'ignore')
})

test('画布空白处粘贴图片 → canvas（模态弹层关闭时，判定与之前完全一致）', () => {
  assert.equal(pasteTarget({ hasMediaFiles: true, insideAgentPanel: false, insideTextEntry: false, modalOpen: false }), 'canvas')
})

test('模态弹层打开时，画布空白处粘贴 → ignore，避免素材落在弹层背后无人可见', () => {
  // 账户设置、确认框、模板/项目对话框等打开时，视口中心被弹层盖住；
  // 素材静默落地在看不见的地方，是这整个功能一直在避免的那类问题。
  assert.equal(pasteTarget({ hasMediaFiles: true, insideAgentPanel: false, insideTextEntry: false, modalOpen: true }), 'ignore')
})

test('模态弹层打开且焦点在画布文本输入里 → 仍是 ignore（原因不同，结果不变）', () => {
  assert.equal(pasteTarget({ hasMediaFiles: true, insideAgentPanel: false, insideTextEntry: true, modalOpen: true }), 'ignore')
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

test('回落名检测规范化大小写和空白', () => {
  // 'IMAGE' 和前导尾随空白的 'image' 也是通用名，应该回落。
  const now = new Date(2026, 7, 26, 14, 30)
  assert.equal(pastedAssetName('IMAGE.PNG', { source: 'paste', now }), '粘贴的图片 14:30')
  assert.equal(pastedAssetName('  image.png  ', { source: 'paste', now }), '粘贴的图片 14:30')
})

test('粘贴来源且 now 选项缺省时用当前时间', () => {
  // options.now ?? new Date() 的默认路径：检查形状而不是具体时间。
  const result = pastedAssetName('', { source: 'paste' })
  assert.match(result, /^粘贴的图片 \d{2}:\d{2}$/)
})
