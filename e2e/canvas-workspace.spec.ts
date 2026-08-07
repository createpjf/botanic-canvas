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
    aspectRatios: ['1:1', '3:4', '4:5', '9:16'],
    resolutions: ['1K', '2K'],
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
  await page.getByRole('button', { name: '打开 Agent' }).click()
  await expect(page.getByRole('complementary', { name: 'Botanic Agent' })).toBeVisible()
  await expect(page.getByRole('complementary', { name: '素材库' })).toBeHidden()

  await page.getByRole('button', { name: '换场景' }).click()
  const composer = page.getByRole('textbox', { name: 'Agent 消息' })
  await expect(composer).toHaveValue('保持人物、服装和商品不变，只替换场景与环境光线。')

  await page.getByRole('button', { name: '手动确认' }).click()
  await expect(page.getByRole('group', { name: '执行模式' })).toBeVisible()
  await page.getByRole('group', { name: '执行模式' }).getByRole('button', { name: /自动执行/ }).click()
  await expect(page.getByRole('button', { name: '自动执行' })).toBeVisible()

  await composer.fill('@')
  await expect(page.getByRole('group', { name: '引用画布内容' })).toBeVisible()
  await expect(page.getByText('没有匹配的素材')).toBeVisible()

  await page.reload()
  await expect(page).toHaveURL(new RegExp(`${canvasHash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
  await expect(page.getByRole('button', { name: '打开 Agent' })).toBeVisible()
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
