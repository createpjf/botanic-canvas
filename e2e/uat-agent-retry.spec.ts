import { test, expect } from '@playwright/test'

test('画布旧卡只补当前分支缺图，重复操作与补齐后刷新不新增生成', async ({ page, baseURL }, info) => {
  test.setTimeout(60_000)
  page.setDefaultTimeout(8000)
  const images = process.env.UAT_IMAGES_FAKE_ORIGIN
  test.skip(process.env.UAT_FAKE_GENERATION !== 'true' || !images, '仅允许隔离本地假图片服务')
  for (const origin of [baseURL, images]) expect(new URL(origin!).hostname).toBe('127.0.0.1')
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await fetch(`${images}/__reset`, { method: 'POST' })
  const imageCount = async () => (await (await fetch(`${images}/__requests`)).json()).imageCount
  await page.goto('/#/projects')
  await page.getByRole('button', { name: '登录工作台' }).first().click()
  const legacy = page.getByRole('button', { name: /使用旧访问令牌/ })
  if (await legacy.isVisible()) await legacy.click()
  await page.getByPlaceholder(/粘贴访问令牌/).fill(process.env.UAT_ACCESS_TOKEN!)
  await page.getByRole('button', { name: /进入工作台|Enter workspace/ }).click()
  await page.getByRole('button', { name: /新建项目/ }).click()
  await page.getByRole('button', { name: '描述目标', exact: true }).click()
  const agent = page.getByRole('complementary', { name: 'Botanic Agent' })
  await agent.getByRole('combobox', { name: '提示词' }).fill('UAT生图：生成两张白底植物插画，3:4、2K。')
  await agent.getByRole('button', { name: '发送给 Agent', exact: true }).click()
  const creation = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/agent-runs')
  await agent.locator('.agent-plan__confirm').click({ timeout: 25_000 })
  const run = (await (await creation).json()).run
  const results = agent.locator('.agent-run-message__results img')
  await expect(results).toHaveCount(1, { timeout: 25_000 })
  const originalImage = await results.first().getAttribute('src')
  const retry = page.locator('.result-node__partial button').filter({ hasText: '补 1 张' }).last()
  await expect(retry).toBeVisible()
  expect(await imageCount()).toBe(2)
  const requests: string[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/agent-runs/*/branches/*/retry', async route => {
    requests.push(new URL(route.request().url()).pathname)
    await gate
    await route.continue()
  })
  try {
    await retry.click()
    await expect.poll(() => requests.length).toBe(1)
    await expect(page.locator('.result-node__partial button').last()).toBeDisabled()
    await page.keyboard.press('Enter')
    expect(requests).toEqual([`/api/agent-runs/${run.id}/branches/${run.branches[0].id}/retry`])
    release()
    await expect(results).toHaveCount(2, { timeout: 25_000 })
    await expect(page.locator('.result-node__partial button')).toHaveCount(0)
    expect(await results.evaluateAll(nodes => nodes.map(node => node.getAttribute('src')))).toContain(originalImage)
    expect(await imageCount()).toBe(3)
    await page.reload()
    if (!await agent.isVisible()) await page.getByRole('button', { name: '打开 Bob', exact: true }).click()
    await expect(results).toHaveCount(2)
    await expect(page.locator('.result-node__partial button')).toHaveCount(0)
    expect(await imageCount()).toBe(3)
    expect(requests).toHaveLength(1)
    expect(errors).toEqual([])
    await page.screenshot({ path: info.outputPath('old-card-retry-settled.png') })
  } finally { release() }
})
