import { expect, test, type Page } from '@playwright/test'

const fixture = {
  data: {
    type: 'status_page',
    attributes: {
      aggregate_state: 'operational',
      updated_at: '2026-08-29T11:00:00.000Z',
    },
    relationships: { sections: { data: [{ id: '1', type: 'status_page_section' }] } },
  },
  included: [
    {
      id: 'web',
      type: 'status_page_resource',
      attributes: {
        status_page_section_id: 1,
        public_name: '工作台',
        position: 0,
        status: 'operational',
        status_history: [
          { day: '2026-08-29', status: 'operational', downtime_duration: 0, maintenance_duration: 0 },
        ],
      },
    },
    {
      id: 'inc-1',
      type: 'status_report',
      attributes: {
        title: 'API 短暂中断',
        report_type: 'manual',
        starts_at: '2026-08-28T10:00:00.000Z',
        ends_at: '2026-08-28T10:10:00.000Z',
        aggregate_state: 'downtime',
        affected_resources: [],
      },
      relationships: { status_updates: { data: [] } },
    },
  ],
}

async function stubStatus(page: Page) {
  const health = { hits: 0 }
  await page.route('https://status.example.test/index.json', async (route) => {
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
  await expect(page.getByRole('link', { name: '订阅通知' })).toHaveAttribute('href', 'https://status.example.test')
  expect(health.hits).toBe(0)
})

test('/status#/projects 仍是状态页，不打开项目库', async ({ page }) => {
  const health = await stubStatus(page)
  await page.goto('/status#/projects')
  await expect(page.getByRole('heading', { name: '系统状态' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '创意项目', exact: true })).toHaveCount(0)
  expect(health.hits).toBe(0)
})
