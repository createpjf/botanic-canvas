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

async function injectAssistantMessage(page: Page, message: { id: string; content: string; kind?: 'text' | 'notice' | 'run' }) {
  await page.evaluate(async ({ id, content, kind }) => {
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
      id,
      role: 'assistant',
      kind: kind ?? 'text',
      status: 'pending',
      createdAt: Date.now(),
      content,
    })
  }, message)
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
  await expect(page.getByRole('heading', { name: 'Turn brand visual production into a system that keeps growing.' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page).toHaveTitle('Botanic · Creative workspace')
  await expect(page.getByRole('img', { name: 'Botanic workspace with visual nodes on the canvas and the Botanic Agent panel open' })).toBeVisible()

  await page.locator('.product-landing__login').click()
  await expect(page.getByRole('heading', { name: 'Creative projects', exact: true })).toBeVisible()
  await expect(page).toHaveURL(/#\/projects$/)
  await page.getByRole('button', { name: 'New project' }).click()
  await expect(page.getByRole('region', { name: 'Empty canvas guide' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Describe the goal' })).toBeVisible()
  await page.getByRole('button', { name: 'Image generation', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Remove Image generation 01 from canvas' })).toBeVisible()
  await page.getByRole('button', { name: 'Open asset library' }).click()
  await expect(page.getByRole('complementary', { name: 'Asset library' })).toBeVisible()
  await page.getByRole('button', { name: 'Open Bob' }).click()
  await expect(page.getByRole('complementary', { name: 'Botanic Agent' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'New chat' })).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Asset library' })).toBeHidden()
  await page.getByRole('button', { name: 'Close Agent' }).click()
  await page.getByRole('button', { name: 'Open account settings' }).click()
  await expect(page.getByRole('menu')).toContainText('Account & workspace')
  await expect(page.getByRole('menuitem', { name: /Language/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('link', { name: 'Product home', exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Status', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Back to projects' }).click()
  await page.getByRole('link', { name: 'Botanic Product home', exact: true }).click()

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Turn brand visual production into a system that keeps growing.' })).toBeVisible()
  await page.getByRole('button', { name: 'Switch to Chinese' }).click()
  await expect(page.getByRole('heading', { name: '让品牌视觉生产，成为持续生长的创作系统。' })).toBeVisible()
})

test('项目库可返回产品首页，画布不出现产品首页和状态', async ({ page }) => {
  await stubReadOnlyRuntime(page)
  await page.goto('/#/projects')

  await page.getByRole('button', { name: '新建项目' }).click()
  await expect(page).toHaveURL(/#\/canvas\/project-\d+$/)
  await expect(page.getByRole('link', { name: '产品首页', exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: '状态', exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: '返回项目' }).click()
  await expect(page).toHaveURL(/#\/projects$/)
  await page.getByRole('link', { name: 'Botanic 产品首页', exact: true }).click()
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
  await expect(page.getByRole('region', { name: '空画布引导' })).toBeVisible()
  await expect(page.getByRole('button', { name: '描述目标', exact: true })).toBeVisible()
  const canvasHash = await page.evaluate(() => window.location.hash)
  expect(canvasHash).toMatch(/^#\/canvas\/project-\d+$/)

  await page.getByRole('button', { name: '图片生成', exact: true }).click()
  await expect(page.getByRole('region', { name: '生成器：图像生成' })).toHaveCount(0)
  const generateNode = page.locator('.generate-node.is-editing')
  await expect(generateNode).toBeVisible()
  await expect(generateNode.getByRole('textbox', { name: /描述$/ })).toBeVisible()
  await expect(generateNode.getByRole('button', { name: '生成', exact: true })).toBeVisible()
  await expect(generateNode.locator('.generate-node__dock')).toBeVisible()
  await expect(generateNode.locator('.generate-node__placeholder')).toBeVisible()
  await expect(generateNode.locator('.generate-node__preview')).toHaveCount(0)
  await expect(generateNode.getByRole('button', { name: '添加参考后即可生成' })).toBeVisible()

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
  const composer = page.getByRole('combobox', { name: '提示词' })
  await expect(composer).toHaveValue('替换场景和光线。人物、服装、商品保持。')

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
  await expect(page.getByRole('listbox', { name: '引用画布节点或图片视频' })).toBeVisible()
  await expect(page.getByText('没有匹配项，按 Esc 关闭')).toBeVisible()

  await page.reload()
  await expect(page).toHaveURL(new RegExp(`${canvasHash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
  await expect(page.getByRole('button', { name: '打开 Bob' })).toBeVisible()
  await expect(page.getByRole('button', { name: '从画布移除 图像生成' })).toBeVisible()

  expect(pageErrors).toEqual([])
  expect(consoleErrors).toEqual([])
})

test('Agent Session 被刷新清掉后，模式切换与发送会自动恢复', async ({ page }) => {
  await stubReadOnlyRuntime(page)
  await page.goto('/#/projects')
  await page.getByRole('button', { name: '新建项目' }).click()
  await page.getByRole('button', { name: '描述目标', exact: true }).click()
  await expect(page.getByRole('complementary', { name: 'Botanic Agent' })).toBeVisible()

  await page.evaluate(async () => {
    const loadStore = new Function('return import("/src/store/canvasStore.ts")') as () => Promise<{
      useCanvasStore: {
        getState: () => { document: Record<string, unknown> }
        setState: (state: { document: Record<string, unknown> }) => void
      }
    }>
    const { useCanvasStore } = await loadStore()
    const document = useCanvasStore.getState().document
    useCanvasStore.setState({
      document: { ...document, agentSessions: [], activeAgentSessionId: undefined },
    })
  })

  const composer = page.getByRole('combobox', { name: '提示词' })
  await composer.fill('你好')
  await page.getByRole('button', { name: '执行模式：计划模式' }).click()
  await page.getByRole('group', { name: '执行模式' }).getByRole('button', { name: '自动模式' }).click()

  await expect.soft(page.getByRole('button', { name: '执行模式：自动模式' })).toBeVisible()
  await expect.soft(page.getByRole('button', { name: '发送给 Agent' })).toBeEnabled()
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
      sessionId: 'session-e2e',
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
  await page.getByRole('button', { name: '描述目标', exact: true }).click()

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

  const guide = page.getByRole('region', { name: '空画布引导' })
  await expect(guide.getByRole('button', { name: '描述目标', exact: true })).toBeVisible()
  await expect(guide.getByRole('button', { name: '添加素材' })).toBeVisible()
  await expect(page.getByRole('button', { name: '打开 Bob' })).toBeHidden()

  await guide.getByRole('button', { name: '描述目标', exact: true }).click()
  await expect(page.getByRole('complementary', { name: 'Botanic Agent' })).toBeVisible()
  await expect(page.getByRole('button', { name: '关闭 Agent' })).toBeVisible()
  await expect(page.getByRole('button', { name: '新对话' })).toBeVisible()
  await expect(guide.getByRole('button', { name: '描述目标', exact: true })).toBeHidden()
  await expect(guide.getByRole('button', { name: '图片生成' })).toBeVisible()

  const composer = page.getByRole('combobox', { name: '提示词' })
  await composer.fill('你好')
  await page.getByRole('button', { name: '发送给 Agent' }).click()
  await expect(page.getByText('本地预览模式未连接 Agent 服务')).toBeVisible()
  await expect(page.getByRole('button', { name: '关闭 Agent' })).toBeVisible()
  expect(consoleErrors).toEqual([])

  await page.getByRole('button', { name: '关闭 Agent' }).click()
  await expect(page.getByRole('button', { name: '打开 Bob' })).toBeVisible()
  await expect(guide.getByRole('button', { name: '描述目标', exact: true })).toBeHidden()
  await expect(guide.getByRole('button', { name: '视频生成' })).toBeVisible()
  await page.getByRole('button', { name: '视频生成', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '视频模型尚未配置' })).toBeVisible()
})

test('折叠 Bob 可拖可点，欢迎页是大号问号 Bob', async ({ page }) => {
  await stubReadOnlyRuntime(page)
  await page.goto('/#/projects')
  await page.getByRole('button', { name: '新建项目' }).click()

  // 开屏英雄 Bob 在场时隐藏浮动 launcher；先走引导打开再关闭，再测拖拽。
  await page.getByRole('button', { name: '描述目标', exact: true }).click()
  await page.getByRole('button', { name: '关闭 Agent' }).click()

  const launcher = page.getByRole('button', { name: '打开 Bob' })
  await expect(launcher).toBeVisible()
  const beforeX = Number(await launcher.getAttribute('data-bob-x'))
  const beforeY = Number(await launcher.getAttribute('data-bob-y'))
  expect(beforeX).toBeGreaterThan(0)
  expect(beforeY).toBeGreaterThan(0)

  await launcher.hover()
  const box = await launcher.boundingBox()
  expect(box, '折叠 Bob 应有命中盒').toBeTruthy()
  await page.mouse.down()
  await page.mouse.move(box!.x - 160, box!.y + 110, { steps: 16 })
  await page.mouse.up()

  await expect.poll(async () => Number(await launcher.getAttribute('data-bob-x'))).toBeLessThan(beforeX - 80)
  const afterX = Number(await launcher.getAttribute('data-bob-x'))
  const afterY = Number(await launcher.getAttribute('data-bob-y'))
  expect(afterY).toBeGreaterThan(beforeY + 40)

  await launcher.click()
  const agent = page.getByRole('complementary', { name: 'Botanic Agent' })
  await expect(agent).toBeVisible()
  await expect(agent.getByRole('heading', { name: '今天一起创作什么？' })).toBeVisible()
  const mark = agent.locator('.agent-workspace__mark')
  await expect(mark.locator('svg')).toBeVisible()
  await expect(mark).toHaveAttribute('data-bob-says', 'hmm')
  await expect(mark).toHaveAttribute('data-bob-mood', 'thinking')
  await expect(mark).toHaveAttribute('data-bob-says', 'question', { timeout: 12_000 })
  await expect(mark).toHaveAttribute('data-bob-mood', 'confused')
  const markBox = await mark.boundingBox()
  expect(markBox, '欢迎页 Bob 应比旧方标大').toBeTruthy()
  expect(markBox!.height).toBeGreaterThan(80)
  const markChrome = await mark.evaluate((element) => {
    const style = getComputedStyle(element)
    return { background: style.backgroundColor, borderWidth: style.borderWidth }
  })
  expect(markChrome.background).toMatch(/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)|transparent/)
  expect(Number.parseFloat(markChrome.borderWidth)).toBe(0)

  await page.getByRole('button', { name: '关闭 Agent' }).click()
  await expect(launcher).toBeVisible()
  await expect.poll(async () => Number(await launcher.getAttribute('data-bob-x'))).toBe(afterX)
  await expect.poll(async () => Number(await launcher.getAttribute('data-bob-y'))).toBe(afterY)
  await expect(agent).toBeHidden()
})

test('最新短消息只 mood，大回复限次 wow 且 28px 不出字', async ({ page }) => {
  await stubReadOnlyRuntime(page)
  await page.goto('/#/projects')
  await page.getByRole('button', { name: '新建项目' }).click()
  await page.getByRole('button', { name: '描述目标', exact: true }).click()

  const agent = page.getByRole('complementary', { name: 'Botanic Agent' })
  await expect(agent.getByRole('heading', { name: '今天一起创作什么？' })).toBeVisible()

  await injectAssistantMessage(page, { id: 'bob-short-reply', content: '先从构图开始。' })
  const shortRole = agent.locator('[data-agent-message-id="bob-short-reply"] .agent-message__role')
  await expect(shortRole).toHaveAttribute('data-bob-mood', 'listening')
  await expect(shortRole).toHaveAttribute('data-bob-says', 'none')
  await expect(agent.locator('[data-agent-message-id="bob-short-reply"] .agent-message')).not.toHaveClass(/is-bob-large/)
  const shortBox = await shortRole.boundingBox()
  expect(shortBox, '短消息头像应保持 28px').toBeTruthy()
  expect(shortBox!.width).toBeLessThan(40)

  const longReply = `${'这是一段足够长的助手回复，用来触发大回复 Bob。'.repeat(8)}`
  await injectAssistantMessage(page, { id: 'bob-large-reply', content: longReply })
  const largeAnchor = agent.locator('[data-agent-message-id="bob-large-reply"]')
  const largeRole = largeAnchor.locator('.agent-message__role')
  await expect(largeAnchor.locator('.agent-message')).toHaveClass(/is-bob-large/)
  await expect(largeRole).toHaveAttribute('data-bob-says', 'wow')
  await expect(largeRole).toHaveAttribute('data-bob-mood', 'excited')
  const largeBox = await largeRole.boundingBox()
  expect(largeBox, '大回复头像应放大').toBeTruthy()
  expect(largeBox!.height).toBeGreaterThan(70)

  await expect(shortRole).toHaveAttribute('data-bob-mood', 'idle')
  await expect(shortRole).toHaveAttribute('data-bob-says', 'none')

  await expect(largeRole).toHaveAttribute('data-bob-says', 'none', { timeout: 12_000 })
  await expect(largeRole).toHaveAttribute('data-bob-mood', 'listening')
})

/** 真 PNG：假字节会导致上传静默失败（见 e2e/paste-media.spec.ts）。 */
const PNG_40x30 =
  'iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAYAAABe3VzdAAAAPUlEQVR4nO3OIQEAIBAAMYJ9/xR0'
  + 'gQjIQ0zMb+2Z87NVBwQF64CgYB0QFKwDgoJ1QFCwDggK1gFBwTrwcgEEquWnGxqq2wAAAABJRU5E'
  + 'rkJggg=='

async function addPngAsset(page: Page, name: string) {
  await page.evaluate(async ({ image, fileName }) => {
    const loadStore = new Function('return import("/src/store/canvasStore.ts")') as () => Promise<{
      useCanvasStore: { getState: () => { addUploadedAssetsToCanvas: (assets: unknown[]) => void } }
    }>
    const { useCanvasStore } = await loadStore()
    useCanvasStore.getState().addUploadedAssetsToCanvas([{
      name: fileName,
      image,
      imageWidth: 40,
      imageHeight: 30,
      role: '商品',
      tags: ['e2e'],
    }])
  }, { image: `data:image/png;base64,${PNG_40x30}`, fileName: name })
}

test('素材边 + 打开引用菜单并连上生成节点', async ({ page }) => {
  await stubReadOnlyRuntime(page)
  await page.goto('/#/projects')
  await expect(page.getByRole('heading', { name: '创意项目', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '新建项目' }).click()
  await expect(page.locator('.react-flow.botanic-flow')).toBeVisible()

  await addPngAsset(page, 'ref.png')

  const asset = page.locator('.react-flow__node-asset').first()
  await expect(asset).toBeVisible()
  await asset.click()
  await expect(asset.locator('.generate-node__dock')).toHaveCount(0)
  await expect(page.locator('.react-flow__node-generate:visible')).toHaveCount(0)
  await asset.getByLabel('引用该节点生成').click()

  const palette = page.getByRole('dialog', { name: '添加画布节点' })
  await expect(palette).toBeVisible()
  await expect(palette.getByText('引用该节点生成', { exact: true })).toBeVisible()
  await palette.getByRole('button', { name: /图片生成/ }).click()

  await expect(asset.locator('.generate-node__dock')).toBeVisible()
  await expect(page.locator('.react-flow__node-generate:visible')).toHaveCount(0)
})

test('空白画布新建的生成节点连上旧图后仍留在画布上', async ({ page }) => {
  await stubReadOnlyRuntime(page)
  await page.goto('/#/projects')
  await expect(page.getByRole('heading', { name: '创意项目', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '新建项目' }).click()
  await expect(page.locator('.react-flow.botanic-flow')).toBeVisible()

  await page.getByRole('button', { name: '图片生成', exact: true }).click()
  const generateNode = page.locator('.react-flow__node-generate:visible')
  await expect(generateNode).toBeVisible()

  await addPngAsset(page, 'old.png')

  const asset = page.locator('.react-flow__node-asset').first()
  await expect(asset).toBeVisible()
  await asset.getByLabel('引用该节点生成').dragTo(generateNode.getByLabel(/输入端$/), { force: true })

  await expect(page.locator('.react-flow__node-generate:visible')).toHaveCount(1)
  await generateNode.click()
  await expect(generateNode.locator('.generate-node__references img')).toHaveCount(1)
  await expect(page.locator('.react-flow__edge:visible')).not.toHaveCount(0)
})

test('重连期间画布写入与批量恢复保持暂停且不返回 phantom ID', async ({ page }) => {
  await stubReadOnlyRuntime(page)
  await page.goto('/#/projects')
  await expect(page.getByRole('heading', { name: '创意项目', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '新建项目' }).click()
  await page.getByRole('button', { name: '图片生成', exact: true }).click()
  await expect(page.locator('.react-flow__node-generate:visible')).toHaveCount(1)

  const result = await page.evaluate(async () => {
    const loadStore = new Function('return import("/src/store/canvasStore.ts")') as () => Promise<{
      useCanvasStore: {
        getState: () => {
          document: { nodes: { id: string }[]; batchVariationRuns: unknown[] }
          sharedTemplates: unknown[]
          addTextNode: () => string | null
          addGenerateNode: () => string | null
          createAssetGroup: (name: string, role: '商品') => string | null
          removeNodeFromCanvas: (nodeId: string) => void
          resumeBatchVariations: () => void
          saveCurrentAsSharedTemplate: (name: string) => Promise<boolean>
        }
        setState: (patch: unknown) => void
      }
    }>
    const { useCanvasStore } = await loadStore()
    const before = useCanvasStore.getState().document
    const nodeIds = before.nodes.map((node) => node.id)
    useCanvasStore.setState({
      collaborationStatus: 'reconnecting',
      document: {
        ...before,
        batchVariationRuns: [{
          id: 'batch-reconnect', sourceResultNodeId: 'missing-result', groupId: 'missing-group', groupName: '商品组', variableRole: '商品',
          prompt: '保持主体，替换商品。', candidatesPerAsset: 1,
          settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
          status: 'queued', items: [{ id: 'item-a', assetId: 'missing-asset', assetName: '商品 A', status: 'queued' }],
          createdAt: 1, updatedAt: 1,
        }],
      },
    })
    const store = useCanvasStore.getState()
    const textId = store.addTextNode()
    const generateId = store.addGenerateNode()
    const groupId = store.createAssetGroup('重连中的素材组', '商品')
    const sharedTemplateCount = store.sharedTemplates.length
    const sharedSaved = await store.saveCurrentAsSharedTemplate('重连中的模板')
    store.removeNodeFromCanvas(nodeIds[0])
    store.resumeBatchVariations()
    await new Promise((resolve) => window.setTimeout(resolve, 50))
    const after = useCanvasStore.getState().document
    const run = after.batchVariationRuns[0] as { status?: string; items?: Array<{ status?: string }> }
    return {
      textId,
      generateId,
      groupId,
      sharedSaved,
      sharedTemplateCount: useCanvasStore.getState().sharedTemplates.length - sharedTemplateCount,
      nodeIds: after.nodes.map((node) => node.id),
      runStatus: run?.status,
      itemStatus: run?.items?.[0]?.status,
    }
  })

  expect(result).toEqual({
    textId: null,
    generateId: null,
    groupId: null,
    sharedSaved: false,
    sharedTemplateCount: 0,
    nodeIds: expect.any(Array),
    runStatus: 'queued',
    itemStatus: 'queued',
  })
  expect(result.nodeIds).toHaveLength(1)
})

test('素材连上显式生成节点后，不在素材上重复挂 composer', async ({ page }) => {
  await stubReadOnlyRuntime(page)
  await page.goto('/#/projects')
  await expect(page.getByRole('heading', { name: '创意项目', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '新建项目' }).click()
  await expect(page.locator('.react-flow.botanic-flow')).toBeVisible()

  await addPngAsset(page, 'summer.png')

  const asset = page.locator('.react-flow__node-asset').first()
  await expect(asset).toBeVisible()
  await asset.click()
  await expect(asset.locator('.generate-node__dock')).toHaveCount(0)

  await page.locator('.react-flow__pane').click({ position: { x: 16, y: 16 } })
  await page.getByRole('button', { name: '新增节点' }).click()
  const palette = page.getByRole('dialog', { name: '添加画布节点' })
  await expect(palette).toBeVisible()
  await expect(palette.getByText('添加节点', { exact: true })).toBeVisible()
  await palette.getByRole('button', { name: /图片生成/ }).click()

  const generateNode = page.locator('.react-flow__node-generate:visible')
  await expect(generateNode).toBeVisible()
  await asset.getByLabel('引用该节点生成').dragTo(generateNode.getByLabel(/输入端$/), { force: true })
  await expect(page.locator('.react-flow__node-generate:visible')).toHaveCount(1)

  await generateNode.click()
  await expect(generateNode.locator('.generate-node__dock')).toBeVisible()
  await expect(asset.locator('.generate-node__dock')).toHaveCount(0)

  await asset.click()
  await expect(asset.locator('.generate-node__dock')).toHaveCount(0)
  await expect(page.locator('.react-flow__node-generate:visible')).toHaveCount(1)
})

test('两张图可从右侧引用拖到左侧上下文', async ({ page }) => {
  await stubReadOnlyRuntime(page)
  await page.goto('/#/projects')
  await expect(page.getByRole('heading', { name: '创意项目', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '新建项目' }).click()
  await expect(page.locator('.react-flow.botanic-flow')).toBeVisible()

  await addPngAsset(page, 'left.png')
  const sourceNode = page.locator('.react-flow__node-asset').filter({ has: page.getByRole('img', { name: 'left' }) })
  await expect(sourceNode).toBeVisible()
  await addPngAsset(page, 'right.png')
  const targetNode = page.locator('.react-flow__node-asset').filter({ has: page.getByRole('img', { name: 'right' }) })
  await expect(targetNode).toBeVisible()

  const targetId = await targetNode.getByLabel('添加上下文').getAttribute('data-nodeid')
  if (!targetId) throw new Error('右图节点不存在')
  await page.evaluate(async (nodeId) => {
    const loadStore = new Function('return import("/src/store/canvasStore.ts")') as () => Promise<{
      useCanvasStore: { getState: () => { document: { nodes: { id: string; position: { x: number; y: number } }[] }; setNodes: (nodes: unknown[]) => void } }
    }>
    const { useCanvasStore } = await loadStore()
    const store = useCanvasStore.getState()
    store.setNodes(store.document.nodes.map((node) => node.id === nodeId
      ? { ...node, position: { ...node.position, x: node.position.x + 320 } }
      : node))
  }, targetId)

  const sourcePort = sourceNode.getByLabel('引用该节点生成')
  const targetPort = targetNode.getByLabel('添加上下文')
  const sourceHandle = await sourcePort.boundingBox()
  const targetHandle = await targetPort.boundingBox()
  if (!sourceHandle || !targetHandle) throw new Error('连接端点不可见')
  await sourcePort.dispatchEvent('mousedown', {
    button: 0,
    buttons: 1,
    clientX: sourceHandle.x + sourceHandle.width / 2,
    clientY: sourceHandle.y + sourceHandle.height / 2,
  })
  await page.mouse.move(targetHandle.x + targetHandle.width / 2, targetHandle.y + targetHandle.height / 2, { steps: 12 })
  await expect(targetPort).toHaveClass(/valid/)
  await targetPort.dispatchEvent('mouseup', {
    button: 0,
    buttons: 0,
    clientX: targetHandle.x + targetHandle.width / 2,
    clientY: targetHandle.y + targetHandle.height / 2,
  })
  await expect(page.locator('.react-flow__edge:visible')).not.toHaveCount(0)
})

test('入画布不重叠，自动整理把两张图并排', async ({ page }) => {
  await stubReadOnlyRuntime(page)
  await page.goto('/#/projects')
  await expect(page.getByRole('heading', { name: '创意项目', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '新建项目' }).click()
  await expect(page.locator('.react-flow.botanic-flow')).toBeVisible()

  await addPngAsset(page, 'left.png')
  await addPngAsset(page, 'right.png')
  const left = page.locator('.react-flow__node-asset').filter({ has: page.getByRole('img', { name: 'left' }) })
  const right = page.locator('.react-flow__node-asset').filter({ has: page.getByRole('img', { name: 'right' }) })
  await expect(left).toBeVisible()
  await expect(right).toBeVisible()

  const beforeLeft = await left.boundingBox()
  const beforeRight = await right.boundingBox()
  expect(beforeLeft && beforeRight).toBeTruthy()
  expect(beforeLeft!.x + beforeLeft!.width <= beforeRight!.x + 1 || beforeRight!.x + beforeRight!.width <= beforeLeft!.x + 1
    || beforeLeft!.y + beforeLeft!.height <= beforeRight!.y + 1 || beforeRight!.y + beforeRight!.height <= beforeLeft!.y + 1).toBeTruthy()

  await page.getByLabel('更多画布工具').click()
  await page.getByRole('menuitem', { name: '自动整理' }).click()

  const afterLeft = await left.boundingBox()
  const afterRight = await right.boundingBox()
  expect(afterLeft && afterRight).toBeTruthy()
  expect(Math.abs(afterLeft!.y - afterRight!.y)).toBeLessThan(80)
  expect(afterLeft!.x + afterLeft!.width <= afterRight!.x + 1 || afterRight!.x + afterRight!.width <= afterLeft!.x + 1).toBeTruthy()
})
