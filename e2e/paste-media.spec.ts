import { expect, test, type Page } from '@playwright/test'

/**
 * 粘贴图片的端到端验证。
 *
 * 这一套存在的理由：粘贴功能上线时，判定逻辑在 src/domain/clipboardMedia.ts 有穷举单测，
 * 但「合成 ClipboardEvent 能否真的触发 React onPaste」「落点是否真的出现在画布」这类问题
 * node:test 里答不出来（没有 DOM、没有 DataTransfer）。合并时把它记成了「只能人工验」——
 * 那是错的：仓库本来就有 Playwright 与 e2e 套件。
 *
 * 最重要的一条是「文本粘贴不被劫持」：它是唯一会破坏既有输入行为的失败模式，
 * 而且失败时表现为「凭空多出一个素材」，用户很难归因。
 */

/** 与 canvas-workspace.spec.ts:23-27 相同的只读运行时打桩。复制而非抽取，避免改动既有绿套件。 */
async function stubReadOnlyRuntime(page: Page) {
  await page.route('**/api/health', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
  })
}

/**
 * 一张真实的 40×30 PNG（base64）。
 *
 * 必须是真字节：readUploadedAssetInput 走 FileReader + new Image() 读尺寸
 * （src/lib/uploadedAssets.ts），尺寸读不出来会 reject，而画布侧读图失败是**完全静默**的
 * （useCanvasInteractionCoordinator 里 message 为空串时提示元素不渲染）。
 * 用假字节的话，测试会以「什么都没发生」的形式失败，看起来像功能坏了。
 */
const PNG_40x30 =
  'iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAYAAABe3VzdAAAAPUlEQVR4nO3OIQEAIBAAMYJ9/xR0'
  + 'gQjIQ0zMb+2Z87NVBwQF64CgYB0QFKwDgoJ1QFCwDggK1gFBwTrwcgEEquWnGxqq2wAAAABJRU5E'
  + 'rkJggg=='

type PasteSpec = { files?: { name: string; type: string; base64: string }[]; text?: string }

/**
 * 在指定元素上派发一次合成粘贴事件。
 *
 * `cancelable: true` 不能省 —— 否则 preventDefault() 无效、defaultPrevented 恒为 false，
 * 「不劫持文本」那条断言就成了假绿。
 */
async function pasteInto(page: Page, selector: string, spec: PasteSpec) {
  return page.evaluate(({ selector, spec }) => {
    const transfer = new DataTransfer()
    for (const file of spec.files ?? []) {
      const bytes = Uint8Array.from(atob(file.base64), (character) => character.charCodeAt(0))
      transfer.items.add(new File([bytes], file.name, { type: file.type }))
    }
    if (spec.text !== undefined) transfer.items.add(spec.text, 'text/plain')
    const target = document.querySelector(selector)
    if (!target) throw new Error(`粘贴目标不存在：${selector}`)
    const notPrevented = target.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true, composed: true }),
    )
    return { defaultPrevented: !notPrevented }
  }, { selector, spec })
}

/** 进到一个已就绪的空画布。等 .react-flow 是必须的：它缺席时粘贴会静默无事。 */
async function openBlankCanvas(page: Page) {
  await stubReadOnlyRuntime(page)
  await page.goto('/#/projects')
  await expect(page.getByRole('heading', { name: '创意项目', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '新建项目' }).click()
  await expect(page.locator('.react-flow.botanic-flow')).toBeVisible()
}

const screenshotPaste: PasteSpec = { files: [{ name: 'image.png', type: 'image/png', base64: PNG_40x30 }] }

test('截图粘进画布，落在视口中心并成为素材节点', async ({ page }) => {
  await openBlankCanvas(page)
  await expect(page.locator('.react-flow__node-asset')).toHaveCount(0)

  const result = await pasteInto(page, '.react-flow', screenshotPaste)
  expect(result.defaultPrevented).toBe(true)

  await expect(page.locator('.react-flow__node-asset')).toHaveCount(1)
})

test('截图粘进对话框，成为上下文 chip 且名称不是空的', async ({ page }) => {
  await openBlankCanvas(page)
  await page.getByRole('button', { name: '描述目标', exact: true }).click()
  await expect(page.getByRole('complementary', { name: 'Botanic Agent' })).toBeVisible()

  // 必须派发到 textarea，不能派发到 aside.agent-workspace。
  // handlePaste 挂在 aside 上（AgentWorkspace.tsx:2437），但实测以 aside 自身为 target
  // 派发合成事件时 React 不会触发它（defaultPrevented 恒为 false、chip 不出现）。
  // 派发到 textarea 才走通，而这也正是真实操作的形态：用户在输入框里按 ⌘V。
  const composer = page.locator('aside.agent-workspace textarea').first()
  await expect(composer).toBeVisible()
  await pasteInto(page, 'aside.agent-workspace textarea', screenshotPaste)

  // chip 不渲染名字文本（内容只有 <img> 与 ×），名字只进 aria-label，所以只能读无障碍名。
  // 断言时间戳形状，同时守住 pastedAssetName 的回落语义 —— 截图的 name 是 image.png，
  // 直接用会得到一列无法区分的「image」。
  const chip = page.locator('.agent-composer__chip.is-media')
  await expect(chip).toHaveCount(1)
  await expect(chip).toHaveAttribute('aria-label', /^移除 粘贴的图片 \d{2}:\d{2}$/)
})

test('在节点标题输入框里粘贴文字，文字照常粘贴且不产生素材', async ({ page }) => {
  // 钉住 pasteTarget 的规则 1（无媒体文件一律 ignore）：文本粘贴被劫持是本功能
  // 唯一会破坏既有输入行为的失败模式。
  // 注意它**不**钉住规则 3（insideTextEntry）—— 纯文字在规则 1 就返回了，走不到规则 3。
  // 规则 3 由下一条「标题输入框里粘图片」覆盖，两条缺一不可。
  await openBlankCanvas(page)
  await pasteInto(page, '.react-flow', screenshotPaste)
  await expect(page.locator('.react-flow__node-asset')).toHaveCount(1)

  const title = page.locator('.image-node__title input')
  await expect(title).toBeVisible()
  // 用 focus() 而非 click()：节点的「从画布移除」按钮悬在标题上方，
  // click() 会被它的命中盒截走而超时。这里只需要焦点在输入框里。
  await title.focus()

  const result = await pasteInto(page, '.image-node__title input', { text: '一段说明文字' })

  // 不 preventDefault 才意味着浏览器的默认粘贴仍然发生。
  expect(result.defaultPrevented).toBe(false)
  // 而且不能凭空多出素材 —— 劫持发生时正是这个现象。
  await expect(page.locator('.react-flow__node-asset')).toHaveCount(1)
})

test('在节点标题输入框里粘贴图片，不会凭空多出素材节点', async ({ page }) => {
  // 钉住 pasteTarget 的规则 3（insideTextEntry → ignore）。这是规则 3 唯一能被观察到的
  // 场景：用户先复制了截图，再点进节点标题改名，然后按 ⌘V —— 意图是改标题，
  // 此时画布中央冒出一个新节点是惊吓。上一条用纯文字测不到这里（规则 1 先命中）。
  await openBlankCanvas(page)
  await pasteInto(page, '.react-flow', screenshotPaste)
  await expect(page.locator('.react-flow__node-asset')).toHaveCount(1)

  const title = page.locator('.image-node__title input')
  await expect(title).toBeVisible()
  await title.focus()

  const result = await pasteInto(page, '.image-node__title input', screenshotPaste)

  expect(result.defaultPrevented).toBe(false)
  await expect(page.locator('.react-flow__node-asset')).toHaveCount(1)
})

test('粘贴非媒体文件时什么都不发生，且不拦截默认行为', async ({ page }) => {
  await openBlankCanvas(page)

  const result = await pasteInto(page, '.react-flow', {
    files: [{ name: 'brief.pdf', type: 'application/pdf', base64: 'JVBERi0xLjQK' }],
  })

  expect(result.defaultPrevented).toBe(false)
  await expect(page.locator('.react-flow__node-asset')).toHaveCount(0)
})

test('模态弹层打开时画布粘贴被忽略，不会把素材放到看不见的地方', async ({ page }) => {
  await openBlankCanvas(page)
  await pasteInto(page, '.react-flow', screenshotPaste)
  await expect(page.locator('.react-flow__node-asset')).toHaveCount(1)

  await page.locator('.react-flow__node-asset').dblclick()
  await expect(page.locator('[aria-modal="true"]')).toHaveCount(1)

  const result = await pasteInto(page, '.react-flow', screenshotPaste)

  expect(result.defaultPrevented).toBe(false)
  // 仍然是 1 个 —— 弹层遮住视口中心时新增节点用户看不见，那正是要避免的静默失败。
  await expect(page.locator('.react-flow__node-asset')).toHaveCount(1)
})
