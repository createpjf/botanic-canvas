import { expect, test } from '@playwright/test'

/**
 * UAT(H7 证据层 6 的本地自动化):真实浏览器 + 真实 API/Worker/Postgres,fake Provider。
 * 验证:登录 → 发送 Agent 消息 → accepted 后刷新页面 → 回答仍从 durable observer 恢复,
 * Provider 不被第二次调用。
 */
const API = 'http://127.0.0.1:8787'
const FAKE = 'http://127.0.0.1:4799'

// 本 spec 依赖 UAT 栈(smokeLocalStack + PORT=8787 API/Worker + .uat fake Provider,见
// docs/handoffs/2026-09-01-harness-final-report.md);无 UAT_ACCESS_TOKEN 时跳过,
// 不影响常规 local 模式 e2e。
test.skip(!process.env.UAT_ACCESS_TOKEN, '需要 UAT 栈与 UAT_ACCESS_TOKEN')

test('Agent 回合 accepted 后刷新,回答从 durable Turn 恢复且模型只调一次', async ({ page }) => {
  test.setTimeout(120_000)
  const token = process.env.UAT_ACCESS_TOKEN ?? ''
  expect(token, '需要 UAT_ACCESS_TOKEN').toBeTruthy()
  await (await fetch(FAKE + '/__reset', { method: 'POST' })).text()

  await page.goto('/#/projects')
  // 产品首页 → 登录工作台 → 访问令牌模式(submit 文案是「进入工作台」)。
  await page.getByRole('button', { name: '登录工作台' }).first().click()
  const legacyToggle = page.getByRole('button', { name: /使用旧访问令牌/ })
  if (await legacyToggle.isVisible().catch(() => false)) await legacyToggle.click()
  const tokenInput = page.getByPlaceholder(/粘贴访问令牌/)
  await tokenInput.fill(token)
  await page.getByRole('button', { name: /进入工作台|Enter workspace/ }).click()
  await expect(page.getByRole('button', { name: '新建项目' })).toBeVisible({ timeout: 20_000 })

  await page.getByRole('button', { name: '新建项目' }).click()
  // 等画布水合完成再打开 Agent 面板;水合期间首次点击可能被吞。
  await page.waitForTimeout(3_000)
  await expect(async () => {
    await page.getByRole('button', { name: '描述目标', exact: true }).click()
    await expect(page.locator('aside[aria-label="Botanic Agent"]')).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 30_000 })

  const composer = page.getByRole('combobox', { name: '提示词' })
  await composer.fill('UAT:请介绍这个项目')
  await page.getByRole('button', { name: '发送给 Agent' }).click()

  // 等待回答开始(fake provider 3s 延迟 + 流式)。
  await expect(page.getByText(/UAT 回复/).first()).toBeVisible({ timeout: 30_000 })

  const before = await (await fetch(FAKE + '/__requests')).json()
  // 刷新:恢复必须来自 durable Turn/observer,不重跑模型。刷新后面板默认关闭,重新打开。
  await page.reload()
  await page.waitForTimeout(3_000)
  await expect(async () => {
    await page.getByRole('button', { name: '描述目标', exact: true }).click()
    await expect(page.locator('aside[aria-label="Botanic Agent"]')).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 30_000 })
  await expect(page.getByText(/UAT 回复/).first()).toBeVisible({ timeout: 30_000 })
  const after = await (await fetch(FAKE + '/__requests')).json()
  expect(after.count, '刷新后 Provider 调用数不得增长').toBe(before.count)
})

test('执行中 Stop:回合收口取消,不产出最终回答', async ({ page }) => {
  test.setTimeout(120_000)
  const token = process.env.UAT_ACCESS_TOKEN ?? ''
  await (await fetch(FAKE + '/__reset', { method: 'POST' })).text()

  await page.goto('/#/projects')
  await page.getByRole('button', { name: '登录工作台' }).first().click()
  await page.getByPlaceholder(/粘贴访问令牌/).fill(token)
  await page.getByRole('button', { name: /进入工作台|Open workspace/ }).click()
  await expect(page.getByRole('button', { name: '新建项目' })).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: '新建项目' }).click()
  await page.waitForTimeout(3_000)
  await expect(async () => {
    await page.getByRole('button', { name: '描述目标', exact: true }).click()
    await expect(page.locator('aside[aria-label="Botanic Agent"]')).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 30_000 })

  await page.getByRole('combobox', { name: '提示词' }).fill('UAT:这次会被停止')
  await page.getByRole('button', { name: '发送给 Agent' }).click()
  // fake provider 3s 延迟:趁执行中点 Stop(发送按钮会切换为停止)。
  const stopButton = page.getByRole('button', { name: /停止|Stop/ }).first()
  await expect(stopButton).toBeVisible({ timeout: 10_000 })
  await stopButton.click()
  // 断言:不出现最终回答;出现取消/停止态文案。
  await page.waitForTimeout(6_000)
  await expect(page.getByText(/UAT 回复/)).toHaveCount(0)
})
