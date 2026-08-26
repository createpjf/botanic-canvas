#!/usr/bin/env node
/**
 * 生成 README 用的产品截图。
 *
 * 为什么用脚本而不是手工截图：手工截的图在 UI 改动后就和产品不一致了，而且没人
 * 记得该重截哪几张。这个脚本跑一次重生成全部，过期的图会自己被覆盖。
 *
 * 用法：node scripts/captureDocShots.mjs
 *
 * 它自己拉起 dev server（本地持久化模式，不连数据库、不打生成 Provider），
 * 用仓库里已有的示例素材填充画布，截完自己关掉。
 *
 * 注意：画布上呈现的是**导入的素材**，不是模型输出——真实生成要花额度，
 * 不该由文档脚本触发。
 */
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT_DIR = path.join(ROOT, 'docs/images')
const BASE_URL = 'http://127.0.0.1:4173'

/** 视口按常见笔记本尺寸；scale 2 出 Retina 图，README 里缩放显示才不糊。 */
const VIEWPORT = { width: 1440, height: 900 }
const SCALE = 2

/**
 * 素材及其落位。
 *
 * 必须显式指定落位：粘贴一律落在视口中心（这是产品的正确行为），连续粘三张就会
 * 叠在一起，截出来只看得到最后一张压着前一张。所以每粘一张就把它拖到算好的位置。
 *
 * 坐标是拖拽**抓取点**的落点，不是节点中心（抓取点取自节点左上偏内，见
 * dragNewestNode），所以这三个 x 值是照着成图对出来的，不是算术居中。
 */
const SAMPLES = [
  { file: 'src/assets/figma/ref-product.png', to: { x: 369, y: 400 } },
  { file: 'src/assets/figma/ref-scene.png', to: { x: 665, y: 400 } },
  { file: 'src/assets/figma/ref-model.png', to: { x: 961, y: 400 } },
]

async function waitForServer(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // dev server 还没起来，继续等
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  throw new Error(`dev server 在 ${timeoutMs}ms 内没有就绪：${url}`)
}

async function startDevServer() {
  const child = spawn('npm', ['run', 'dev', '--', '--port', '4173', '--strictPort'], {
    cwd: ROOT,
    env: { ...process.env, VITE_PERSISTENCE_MODE: 'local' },
    stdio: 'ignore',
  })
  await waitForServer(BASE_URL)
  return child
}

/** 把本地文件当作剪贴板图片粘进指定元素。复用产品自己的粘贴通道，不走后门 API。 */
async function pasteImage(page, selector, filePath) {
  const base64 = (await readFile(path.join(ROOT, filePath))).toString('base64')
  const name = path.basename(filePath)
  await page.evaluate(({ selector, base64, name }) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], name, { type: 'image/png' }))
    const target = document.querySelector(selector)
    if (!target) throw new Error(`粘贴目标不存在：${selector}`)
    target.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: transfer, bubbles: true, cancelable: true, composed: true,
    }))
  }, { selector, base64, name })
  // 读图走 FileReader + Image，是异步的；等一会儿再继续。
  await page.waitForTimeout(900)
}

/**
 * 把刚粘进来的节点拖到指定位置。
 *
 * 认「刚粘进来的那个」用 .selected —— 新增节点会被自动选中。不用 last()，
 * 因为 react-flow 的 DOM 顺序不保证等于新增顺序。
 * 拖拽起点取节点左侧偏上：右上角是「从画布移除」按钮，从那儿按下会触发删除。
 */
async function dragNewestNode(page, to) {
  const node = page.locator('.react-flow__node-asset.selected').first()
  const box = await node.boundingBox()
  if (!box) throw new Error('拖拽失败：找不到刚粘入的节点')
  const from = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.25 }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  // 分步移动：一步到位时 react-flow 可能收不到中间的 drag 事件。
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(250)
}

/**
 * 清掉瞬态 UI 再截图。
 *
 * 粘贴会同时弹出画布提示条和 undo toast，两者都会出现在成图里，看起来像是产品
 * 常驻的界面元素。先点空白处取消选中（否则节点带绿色选中框），再等提示自然消失，
 * 最后兜底点掉仍然留着的关闭钮。
 */
async function settleForShot(page) {
  await page.mouse.click(200, 760)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(2500)
  // 三种提示都要隐藏，它们各自是独立元素（.canvas-upload-message 甚至没有关闭钮，
  // 也没有自动清除——useCanvasInteractionCoordinator 里只会被设值、不会被设回空串，
  // 所以等不掉）。它们确认的是本脚本自己的注入动作，不属于产品静置状态；
  // 隐藏是为了让截图反映用户看到的画布，不是为了掩盖什么。
  await page.addStyleTag({
    content: '.canvas-upload-message, .undo-toast, .canvas-assistant-notice { display: none !important; }',
  })
  await page.waitForTimeout(400)
}

async function shoot(page, name) {
  const file = path.join(OUT_DIR, `${name}.png`)
  await page.screenshot({ path: file })
  const bytes = (await readFile(file)).length
  console.log(`  ✓ docs/images/${name}.png  ${(bytes / 1024).toFixed(0)} KB`)
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  console.log('拉起 dev server（本地持久化模式）…')
  const server = await startDevServer()
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE, locale: 'zh-CN' })
    const page = await context.newPage()
    // 只读运行时：健康接口打桩，避免界面上出现「后端不可用」的告警条。
    await page.route('**/api/health', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }))

    console.log('截图…')
    // 顺序是刻意的：先把画布填出内容，最后才回项目列表——否则列表是「0 个项目」
    // 的空状态，一个虚线占位框加三分之二空白，放进 README 没有任何信息量。
    await page.goto(`${BASE_URL}/#/projects`)
    await page.getByRole('heading', { name: '创意项目', exact: true }).waitFor()
    await page.getByRole('button', { name: '新建项目' }).click()
    await page.locator('.react-flow.botanic-flow').waitFor()
    await page.waitForTimeout(800)

    for (const sample of SAMPLES) {
      await pasteImage(page, '.react-flow', sample.file)
      await dragNewestNode(page, sample.to)
    }
    await settleForShot(page)
    await shoot(page, 'canvas')

    await page.getByRole('button', { name: '打开素材库' }).click()
    await page.locator('.asset-library').first().waitFor()
    await page.waitForTimeout(1200)
    await shoot(page, 'library')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)

    await page.getByRole('button', { name: '打开 Bob' }).click()
    await page.getByRole('complementary', { name: 'Botanic Agent' }).waitFor()
    await page.waitForTimeout(1200)
    await shoot(page, 'agent')

    // 不截项目列表：项目卡封面来自生成结果，而本脚本不打 Provider，
    // 卡片上永远是「尚未生成封面」的空绿块，放进 README 只会占位不传达信息。

    await writeFile(path.join(OUT_DIR, 'README.md'),
      '# docs/images\n\n由 `node scripts/captureDocShots.mjs` 生成，不要手工编辑。\n'
      + 'UI 改动后重跑该脚本即可重新生成，避免截图与产品不一致。\n')
  } finally {
    await browser.close()
    server.kill('SIGTERM')
  }
  console.log('完成。')
}

await main()
