import { expect, test, type Page } from '@playwright/test'

const healthResponse = {
  status: 'ok',
  provider: 'test',
  configured: false,
  maxBatchCount: 4,
  modelOptions: [{
    id: 'gpt-image-2',
    label: 'GPT Image 2',
    mediaKind: 'image',
    aspectRatios: ['1:1', '16:9', '4:3', '3:4', '4:5', '9:16'],
    resolutions: ['1K', '2K'],
    supportsCustomSize: true,
  }],
  agentPlanner: {
    provider: 'flock-api',
    configured: false,
    models: ['deepseek-v4-pro'],
  },
}

async function stubReadOnlyRuntime(page: Page) {
  await page.route('**/api/health', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(healthResponse) })
  })
}

test('公开产品首页进入项目库，旧经营驾驶舱地址自动兼容', async ({ page }) => {
  await stubReadOnlyRuntime(page)

  await page.goto('/')
  await expect(page.getByRole('heading', { name: '让品牌视觉生产，成为持续生长的创作系统。' })).toBeVisible()
  await expect(page.locator('.product-landing__login')).toContainText('登录工作台')
  await page.locator('.product-landing__login').click()
  await expect(page).toHaveURL(/#\/projects$/)
  await expect(page.getByRole('heading', { name: '创意项目', exact: true })).toBeVisible()

  await page.goto('/#/dashboard')
  await expect(page).toHaveURL(/#\/projects$/)
  await expect(page.getByRole('heading', { name: '创意项目', exact: true })).toBeVisible()
  await expect(page.getByText('经营驾驶舱')).toHaveCount(0)
  await expect(page.getByText('返回经营驾驶舱')).toHaveCount(0)
})

test('产品首页支持中英文切换并展示真实工作台截图', async ({ page }) => {
  await stubReadOnlyRuntime(page)
  await page.goto('/')

  const productScreenshot = page.getByRole('img', { name: 'Botanic 工作台截图，左侧为视觉节点画布，右侧打开 Botanic Agent 面板' })
  await expect(productScreenshot).toBeVisible()
  expect(await productScreenshot.evaluate((image: HTMLImageElement) => image.naturalWidth > 0 && image.naturalHeight > 0)).toBe(true)

  await page.getByRole('button', { name: '切换为英文' }).click()
  await expect(page.getByRole('heading', { name: 'Turn brand visual production into a creative system that keeps growing.' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page).toHaveTitle('Botanic · Creative workspace')
  await expect(page.getByRole('img', { name: 'Botanic workspace with visual nodes on the canvas and the Botanic Agent panel open' })).toBeVisible()

  await page.locator('.product-landing__login').click()
  await expect(page.getByRole('heading', { name: 'Creative projects', exact: true })).toBeVisible()
  await expect(page).toHaveURL(/#\/projects$/)
  await page.getByRole('button', { name: 'New project' }).click()
  await expect(page.getByRole('heading', { name: 'Start with a creative direction' })).toBeVisible()
  await page.getByRole('button', { name: 'Image generation', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Remove Image generation 01 from canvas' })).toBeVisible()
  await page.getByRole('button', { name: 'Close generator' }).click()
  await page.getByRole('button', { name: 'Open asset library' }).click()
  await expect(page.getByRole('complementary', { name: 'Asset library' })).toBeVisible()
  await page.getByRole('button', { name: 'Open Bob' }).click()
  await expect(page.getByRole('complementary', { name: 'Botanic Agent' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'New conversation' })).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Asset library' })).toBeHidden()
  await page.getByRole('button', { name: 'Open account settings' }).click()
  await expect(page.getByRole('menu')).toContainText('Account & workspace')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Product home' }).click()

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Turn brand visual production into a creative system that keeps growing.' })).toBeVisible()
  await page.getByRole('button', { name: 'Switch to Chinese' }).click()
  await expect(page.getByRole('heading', { name: '让品牌视觉生产，成为持续生长的创作系统。' })).toBeVisible()
})

test('项目库和画布都可返回产品首页', async ({ page }) => {
  await stubReadOnlyRuntime(page)
  await page.goto('/#/projects')

  await page.getByRole('button', { name: '新建项目' }).click()
  await expect(page).toHaveURL(/#\/canvas\/project-\d+$/)
  await page.getByRole('button', { name: '产品首页', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('heading', { name: '让品牌视觉生产，成为持续生长的创作系统。' })).toBeVisible()

  await page.goto('/#/projects')
  await page.reload()
  await page.getByRole('button', { name: '产品首页', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('heading', { name: '让品牌视觉生产，成为持续生长的创作系统。' })).toBeVisible()
})

test('产品首页在窄屏下无横向溢出且各区块可访问', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await stubReadOnlyRuntime(page)
  await page.goto('/')

  const landing = page.locator('.product-landing')
  expect(await landing.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  for (const heading of [
    '让品牌视觉生产，成为持续生长的创作系统。',
    '从一次生成，走向完整的视觉生产。',
    '每一步都可确认，每个结果都有来路。',
    '把下一次创作，放进一个能继续生长的工作流。',
  ]) {
    const sectionHeading = page.getByRole('heading', { name: heading })
    await sectionHeading.scrollIntoViewIfNeeded()
    await expect(sectionHeading).toBeVisible()
  }
})

test('project to canvas and Agent surfaces stay ordered across reload', async ({ page }) => {
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await stubReadOnlyRuntime(page)

  await page.goto('/#/projects')
  await expect(page.getByRole('heading', { name: '创意项目', exact: true })).toBeVisible()

  await page.getByRole('button', { name: '新建项目' }).click()
  await expect(page.getByRole('heading', { name: '从一个创意目标开始' })).toBeVisible()
  const canvasHash = await page.evaluate(() => window.location.hash)
  expect(canvasHash).toMatch(/^#\/canvas\/project-\d+$/)

  await page.getByRole('button', { name: '图片生成', exact: true }).click()
  await expect(page.getByRole('region', { name: '生成器：图像生成' })).toBeVisible()
  await page.getByRole('button', { name: '关闭生成器' }).click()

  await page.getByRole('button', { name: '打开素材库' }).click()
  await expect(page.getByRole('complementary', { name: '素材库' })).toBeVisible()
  await page.getByRole('button', { name: '打开 Bob' }).click()
  await expect(page.getByRole('complementary', { name: 'Botanic Agent' })).toBeVisible()
  await expect(page.getByRole('complementary', { name: '素材库' })).toBeHidden()
  const tabBarBox = await page.locator('.tab-bar').boundingBox()
  const agentBox = await page.getByRole('complementary', { name: 'Botanic Agent' }).boundingBox()
  expect(tabBarBox, '项目顶栏应可见').toBeTruthy()
  expect(agentBox, 'Agent 面板应可见').toBeTruthy()
  expect(agentBox!.y).toBeGreaterThanOrEqual(tabBarBox!.y + tabBarBox!.height)
  await expect(page.getByRole('button', { name: '返回项目' })).toBeEnabled()

  await page.getByRole('button', { name: '换场景' }).click()
  const composer = page.getByRole('textbox', { name: '提示词' })
  await expect(composer).toHaveValue('保持人物、服装和商品不变，只替换场景与环境光线。')

  await page.getByRole('button', { name: '执行模式：计划模式' }).click()
  const modeMenu = page.getByRole('group', { name: '执行模式' })
  await expect(modeMenu).toBeVisible()

  // 菜单必须整体落在 Agent 面板内，且说明文字不被裁切——面板有 overflow: hidden，
  // 菜单一旦溢出，说明文案就会被切掉半句。
  const menuBox = await modeMenu.boundingBox()
  const panelBox = await page.getByRole('complementary', { name: 'Botanic Agent' }).boundingBox()
  expect(menuBox!.x).toBeGreaterThanOrEqual(panelBox!.x - 1)
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width + 1)
  for (const modeName of ['计划模式', '自动模式']) {
    const clipped = await modeMenu.getByRole('button', { name: modeName }).locator('small')
      .evaluate((element) => element.scrollWidth > element.clientWidth + 1)
    expect(clipped, `${modeName} 的说明文字被裁切`).toBe(false)
  }

  await modeMenu.getByRole('button', { name: '自动模式' }).click()
  await expect(page.getByRole('button', { name: '执行模式：自动模式' })).toBeVisible()

  await composer.fill('@')
  await expect(page.getByRole('group', { name: '引用画布节点或图片视频' })).toBeVisible()
  await expect(page.getByText('没有匹配项，按 Esc 关闭')).toBeVisible()

  await page.reload()
  await expect(page).toHaveURL(new RegExp(`${canvasHash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
  await expect(page.getByRole('button', { name: '打开 Bob' })).toBeVisible()
  await expect(page.getByRole('button', { name: '从画布移除 图像生成' })).toBeVisible()

  expect(pageErrors).toEqual([])
  expect(consoleErrors).toEqual([])
})

test('Agent 离线消息跨页面实例恢复，联网后只按原幂等键提交一次', async ({ page, context }) => {
  await stubReadOnlyRuntime(page)
  await page.goto('/#/projects')
  await page.evaluate(async () => {
    const loadModule = new Function('return import("/src/lib/agentMessageQueue.ts")') as () => Promise<unknown>
    ;(window as Window & { __agentQueueModule?: unknown }).__agentQueueModule = await loadModule()
    localStorage.removeItem('botanic:agent-message-queue:v1:e2e-offline-recovery')
    localStorage.removeItem('botanic:e2e-agent-deliveries')
  })

  await context.setOffline(true)
  const offline = await page.evaluate(async () => {
    const module = (window as Window & { __agentQueueModule?: {
      createAgentMessageQueue: (options: unknown) => {
        enqueue: (input: unknown) => void
        flush: () => Promise<{ delivered: string[]; pending: string[] }>
        list: () => Array<{ message: { id: string } }>
      }
      createLocalStorageAgentMessageQueueStorage: (namespace: string) => unknown
    } }).__agentQueueModule!
    const storage = module.createLocalStorageAgentMessageQueueStorage('e2e-offline-recovery')
    const queue = module.createAgentMessageQueue({
      storage,
      deliver: async () => { throw Object.assign(new Error('offline'), { status: 0 }) },
    })
    queue.enqueue({
      projectId: 'project-e2e',
      session: { id: 'session-e2e', title: '离线恢复', executionMode: 'manual', contextNodeIds: [], messages: [], createdAt: 1, updatedAt: 1 },
      message: { id: 'message-e2e', role: 'user', kind: 'text', content: '离线消息', createdAt: 2 },
      idempotencyKey: 'agent-message-message-e2e',
    })
    const result = await queue.flush()
    return { delivered: result.delivered, pending: result.pending, restored: queue.list().map((item) => item.message.id) }
  })
  expect(offline).toEqual({ delivered: [], pending: ['message-e2e'], restored: ['message-e2e'] })

  await context.setOffline(false)
  const recovered = await page.evaluate(async () => {
    const module = (window as Window & { __agentQueueModule?: {
      createAgentMessageQueue: (options: unknown) => {
        flush: () => Promise<{ delivered: string[]; pending: string[] }>
        list: () => Array<{ message: { id: string } }>
      }
      createLocalStorageAgentMessageQueueStorage: (namespace: string) => unknown
    } }).__agentQueueModule!
    const storage = module.createLocalStorageAgentMessageQueueStorage('e2e-offline-recovery')
    const queue = module.createAgentMessageQueue({
      storage,
      deliver: async (item: { idempotencyKey: string }) => {
        const deliveries = JSON.parse(localStorage.getItem('botanic:e2e-agent-deliveries') || '[]') as string[]
        deliveries.push(item.idempotencyKey)
        localStorage.setItem('botanic:e2e-agent-deliveries', JSON.stringify(deliveries))
      },
    })
    const first = await queue.flush()
    const second = await queue.flush()
    return {
      first,
      second,
      remaining: queue.list().length,
      deliveries: JSON.parse(localStorage.getItem('botanic:e2e-agent-deliveries') || '[]') as string[],
    }
  })
  expect(recovered).toEqual({
    first: { delivered: ['message-e2e'], failed: [], pending: [] },
    second: { delivered: [], failed: [], pending: [] },
    remaining: 0,
    deliveries: ['agent-message-message-e2e'],
  })
})

test('Agent 生成卡片默认收起已完成步骤与提示词差异，主内容保持清晰', async ({ page }) => {
  await stubReadOnlyRuntime(page)
  await page.goto('/#/projects')
  await page.getByRole('button', { name: '新建项目' }).click()
  await page.getByRole('button', { name: '打开 Bob' }).click()

  await page.evaluate(async () => {
    const loadStore = new Function('return import("/src/store/canvasStore.ts")') as () => Promise<{
      useCanvasStore: { getState: () => {
        ensureAgentSession: () => string
        appendAgentMessage: (sessionId: string, message: unknown) => void
      } }
    }>
    const { useCanvasStore } = await loadStore()
    const store = useCanvasStore.getState()
    const sessionId = store.ensureAgentSession()
    store.appendAgentMessage(sessionId, {
      id: 'message-ui-card', role: 'assistant', kind: 'plan', status: 'pending', createdAt: Date.now(),
      content: '已整理生成方案。',
      plan: {
        intent: 'replace_scene',
        instruction: '人物不变，背景换成海边。',
        summary: '海边场景替换',
        prompt: '保持人物、五官、服装与姿态不变，仅将背景替换为晴朗海边。',
        settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
        constraints: [{ dimension: 'scene', mode: 'vary' }],
        references: [],
        output: { mode: 'single', count: 1, candidatesPerItem: 1 },
        toolCalls: [
          { id: 'read', name: 'canvas_read', label: '读取画布上下文', status: 'succeeded', risk: 'read', requiresConfirmation: false },
          { id: 'skill', name: 'skill_apply', label: '应用受控局部编辑', status: 'succeeded', risk: 'write', requiresConfirmation: true },
        ],
      },
    })
  })

  await expect(page.getByText('提示词')).toBeVisible()
  const toolSteps = page.locator('details.agent-message__tools')
  const promptDiff = page.locator('details.agent-prompt-review__compare')
  await expect(toolSteps).toBeVisible()
  await expect(promptDiff).toBeVisible()
  expect(await toolSteps.evaluate((element: HTMLDetailsElement) => element.open)).toBe(false)
  expect(await promptDiff.evaluate((element: HTMLDetailsElement) => element.open)).toBe(false)
  await expect(page.getByText('保持人物、五官、服装与姿态不变，仅将背景替换为晴朗海边。')).toBeVisible()
})

test('空画布优先提供目标入口，本地能力边界可见且不请求云端 Agent', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  await stubReadOnlyRuntime(page)
  await page.goto('/#/projects')
  await page.getByRole('button', { name: '新建项目' }).click()

  await expect(page.getByRole('button', { name: '先描述目标' })).toBeVisible()
  await page.getByRole('button', { name: '先描述目标' }).click()
  await expect(page.getByRole('complementary', { name: 'Botanic Agent' })).toBeVisible()
  await expect(page.getByRole('button', { name: '关闭 Agent' })).toBeVisible()
  await expect(page.getByRole('button', { name: '新建对话' })).toBeVisible()

  const composer = page.getByRole('textbox', { name: '提示词' })
  await composer.fill('你好')
  await page.getByRole('button', { name: '发送给 Agent' }).click()
  await expect(page.getByText('本地预览模式未连接 Agent 服务')).toBeVisible()
  await expect(page.getByRole('button', { name: '关闭 Agent' })).toBeVisible()
  expect(consoleErrors).toEqual([])

  await page.getByRole('button', { name: '关闭 Agent' }).click()
  await expect(page.getByRole('button', { name: '打开 Bob' })).toBeVisible()
  await page.getByRole('button', { name: '视频生成', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '视频模型尚未配置' })).toBeVisible()
})
