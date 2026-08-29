import { expect, test, type Page } from '@playwright/test'

const fixture = {
  loadState: 'ready',
  fetchedAt: '2026-08-29T12:00:00.000Z',
  updatedAt: '2026-08-29T11:00:00.000Z',
  overall: 'operational',
  subscribeUrl: null,
  components: [
    {
      id: 'web',
      name: 'web',
      level: 'operational',
      hours24: [],
      days30: [],
      uptime24h: 100,
      uptime30d: 100,
    },
  ],
  incidents: [
    {
      id: 'inc-1',
      title: 'API 短暂中断',
      level: 'outage',
      startedAt: '2026-08-28T10:00:00.000Z',
      resolvedAt: '2026-08-28T10:10:00.000Z',
      updates: [],
    },
  ],
}

async function stubStatus(page: Page) {
  const health = { hits: 0 }
  await page.route('**/status.json', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) })
  })
  await page.route('**/api/health', async (route) => {
    health.hits++
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"ok"}' })
  })
  return health
}

test('Landing 状态导航进入 /status 并展示夹具组件', async ({ page }) => {
  const health = await stubStatus(page)
  await page.goto('/')
  await page.getByRole('link', { name: '状态' }).click()
  await expect(page).toHaveURL(/\/status\/?$/)
  await expect(page.getByRole('heading', { name: '系统状态' })).toBeVisible()
  await expect(page.getByRole('status')).toContainText('全部正常')
  await expect(page.getByText('工作台', { exact: true })).toBeVisible()
  await expect(page.getByText('API 短暂中断')).toBeVisible()
  await expect(page.getByRole('link', { name: '订阅通知' })).toHaveCount(0)
  expect(health.hits).toBe(0)
})

test('/status#/projects 仍是状态页，不打开项目库', async ({ page }) => {
  const health = await stubStatus(page)
  await page.goto('/status#/projects')
  await expect(page.getByRole('heading', { name: '系统状态' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '创意项目', exact: true })).toHaveCount(0)
  expect(health.hits).toBe(0)
})
