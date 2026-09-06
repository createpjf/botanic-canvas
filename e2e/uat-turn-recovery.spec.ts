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

/** 登录:先清持久会话(避免上次运行留下的本地预览态),再用访问令牌登录。 */
async function signIn(page, token) {
  await page.goto('/#/projects')
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear() })
  await page.reload()
  const newProject = page.getByRole('button', { name: '新建项目' })
  const signInButton = page.getByRole('button', { name: '登录工作台' }).first()
  await expect(signInButton).toBeVisible({ timeout: 20_000 })
  await signInButton.click()
  const legacyToggle = page.getByRole('button', { name: /使用旧访问令牌/ })
  if (await legacyToggle.isVisible().catch(() => false)) await legacyToggle.click()
  await page.getByPlaceholder(/粘贴访问令牌/).fill(token)
  await page.getByRole('button', { name: /进入工作台|Enter workspace/ }).click()
  await expect(newProject).toBeVisible({ timeout: 20_000 })
}

test('新项目首条消息等项目保存，不返回404或重复发送', async ({ page }, info) => {
  test.setTimeout(30_000)
  await signIn(page, process.env.UAT_ACCESS_TOKEN)
  await page.route('**/api/projects/*/document', async route => {
    if (route.request().method() === 'PUT') await new Promise(resolve => setTimeout(resolve, 1000))
    await route.continue()
  })
  const writes: number[] = []
  page.on('response', response => {
    if (response.request().method() === 'PUT' && /\/messages\//.test(new URL(response.url()).pathname)) writes.push(response.status())
  })
  await page.getByRole('button', { name: '新建项目' }).click()
  await page.getByRole('button', { name: '描述目标', exact: true }).click()
  const agent = page.getByRole('complementary', { name: 'Botanic Agent' })
  await agent.getByRole('combobox', { name: '提示词' }).fill('UAT:请介绍这个项目')
  const delivered = page.waitForResponse(response => response.request().method() === 'PUT' && /\/messages\//.test(new URL(response.url()).pathname))
  await agent.getByRole('button', { name: '发送给 Agent' }).click()
  const response = await delivered
  expect(response.ok(), JSON.stringify(await response.json())).toBeTruthy()
  await expect(agent.getByText(/UAT 回复/).first()).toBeVisible({ timeout: 15_000 })
  await expect(agent.getByRole('log').getByText('UAT:请介绍这个项目', { exact: true })).toHaveCount(1)
  expect(writes).not.toContain(404)
  await page.screenshot({ path: info.outputPath('new-project-first-message.png') })
})

test('首次项目保存失败后保留消息，原位重试可恢复', async ({ page }, info) => {
  test.setTimeout(30_000)
  await signIn(page, process.env.UAT_ACCESS_TOKEN)
  let blocked = true
  await page.route('**/api/projects/*/document', async route => {
    if (blocked && route.request().method() === 'PUT') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UAT_SAVE_FAILED', message: '保存失败' } }) })
    await route.continue()
  })
  const writes: number[] = []
  page.on('response', response => {
    if (response.request().method() === 'PUT' && /\/messages\//.test(new URL(response.url()).pathname)) writes.push(response.status())
  })
  await page.getByRole('button', { name: '新建项目' }).click()
  await page.getByRole('button', { name: '描述目标', exact: true }).click()
  const agent = page.getByRole('complementary', { name: 'Botanic Agent' })
  await agent.getByRole('combobox', { name: '提示词' }).fill('UAT:请介绍这个项目')
  await agent.getByRole('button', { name: '发送给 Agent' }).click()
  await expect(agent.getByText('项目尚未保存，请重试。', { exact: true }).first()).toBeVisible()
  expect(writes).toEqual([])
  await expect(agent.getByRole('log').getByText('UAT:请介绍这个项目', { exact: true })).toBeVisible()
  await expect(agent.getByRole('form', { name: 'Agent 输入' }).getByRole('button', { name: '重试', exact: true })).toBeEnabled()
  blocked = false
  await agent.getByRole('log').getByRole('button', { name: '重试', exact: true }).click()
  await expect(agent.getByText(/UAT 回复/).first()).toBeVisible({ timeout: 15_000 })
  await expect(agent.getByRole('log').getByText('UAT:请介绍这个项目', { exact: true })).toHaveCount(1)
  expect(writes).not.toContain(404)
  await page.screenshot({ path: info.outputPath('new-project-save-recovered.png') })
})

test('Agent 回合 accepted 后刷新,回答从 durable Turn 恢复且模型只调一次', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  const token = process.env.UAT_ACCESS_TOKEN ?? ''
  expect(token, '需要 UAT_ACCESS_TOKEN').toBeTruthy()
  await (await fetch(FAKE + '/__reset', { method: 'POST' })).text()

  await signIn(page, token)

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
  expect(before.count, '本轮只应调用一次 Provider').toBe(1)
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
  await page.screenshot({ path: testInfo.outputPath('turn-restored.png') })
})

test('执行中 Stop:回合收口取消,不产出最终回答', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  const token = process.env.UAT_ACCESS_TOKEN ?? ''
  await (await fetch(FAKE + '/__reset', { method: 'POST' })).text()

  await signIn(page, token)
  await page.getByRole('button', { name: '新建项目' }).click()
  await page.waitForTimeout(3_000)
  await expect(async () => {
    await page.getByRole('button', { name: '描述目标', exact: true }).click()
    await expect(page.locator('aside[aria-label="Botanic Agent"]')).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 30_000 })

  await page.getByRole('combobox', { name: '提示词' }).fill('UAT:这次会被停止')
  await page.getByRole('button', { name: '发送给 Agent' }).click()
  // fake provider 3s 延迟:趁执行中点 Stop(发送按钮会切换为停止)。
  const stopButton = page.getByRole('form', { name: 'Agent 输入' }).getByRole('button', { name: '停止', exact: true })
  await expect(stopButton).toBeVisible({ timeout: 10_000 })
  await stopButton.click()
  // 断言:不出现最终回答;出现取消/停止态文案。
  await page.waitForTimeout(6_000)
  await expect(page.getByText(/UAT 回复/)).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('turn-stopped.png') })
})

test('Run已接受但回包未到时停止，取消回执丢失后刷新仍接续原任务', async ({ page, baseURL }, info) => {
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  const projectId = process.env.UAT_STOP_PROJECT_ID
  const images = process.env.UAT_IMAGES_FAKE_ORIGIN
  test.skip(!projectId || !images || process.env.UAT_FAKE_GENERATION !== 'true', '仅允许显式隔离项目与本地假图片服务')
  for (const origin of [baseURL, images]) expect(new URL(origin!).hostname).toBe('127.0.0.1')
  const headers = { Authorization: `Bearer ${process.env.UAT_ACCESS_TOKEN}` }
  const readDocument = async () => (await (await page.request.get(`/api/projects/${projectId}/document`, { headers })).json()).document
  const imageCount = async () => (await (await fetch(`${images}/__requests`)).json()).imageCount
  await signIn(page, process.env.UAT_ACCESS_TOKEN)
  await page.goto(`/#/canvas/${projectId}`)
  await expect(page.locator('.react-flow')).toBeVisible()
  const agent = page.getByRole('complementary', { name: 'Botanic Agent' })
  if (!await agent.isVisible()) await page.getByRole('button', { name: '打开 Bob', exact: true }).click()
  await expect(agent.getByText('已保存', { exact: true })).toBeVisible({ timeout: 20_000 })
  const before = await readDocument()
  let sessionId: string
  const readMessages = async () => {
    const response = await page.request.get(`/api/projects/${projectId}/agent-sessions/${sessionId}/messages?limit=100`, { headers })
    expect(response.ok()).toBe(true)
    return (await response.json()).messages
  }
  const oldRuns = before.agentRuns.map(run => run.id)
  const oldImages = before.nodes.filter(node => node.type === 'result' && node.data.image).map(node => ({ id: node.id, image: node.data.image }))
  let createdRun: { id: string; status: string } | undefined
  let createCount = 0
  let releaseCreate!: () => void
  const createGate = new Promise<void>(resolve => { releaseCreate = resolve })
  const cancelledIds: string[] = []
  let loseCancelReceipt = true
  let hiddenAcknowledgements = process.env.UAT_LATE_CANCEL_ACK === 'true' ? 3 : 0
  await page.route('**/api/generation-jobs/*', async route => {
    if (route.request().method() !== 'GET' || !hiddenAcknowledgements) return route.continue()
    const response = await route.fetch()
    const job = await response.json()
    if (job.agentRun?.runId !== createdRun?.id || !job.cancel?.signalAcknowledgedAt) return route.fulfill({ response })
    hiddenAcknowledgements--
    await route.fulfill({ response, json: { ...job, cancel: { ...job.cancel, workerReleased: false, signalAcknowledgedAt: undefined } } })
  })
  await page.route('**/api/agent-runs', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    createCount += 1
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    createdRun = (await response.json()).run
    await createGate // 已真实创建 Run/Job，仅延迟浏览器收到身份，不伪造成功快照。
    await route.fulfill({ response })
  })
  await page.route('**/api/agent-runs/*/cancel', async route => {
    cancelledIds.push(new URL(route.request().url()).pathname.split('/').at(-2)!)
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    if (loseCancelReceipt) {
      // 服务端已处理取消，客户端及其自动重试均收不到回执；刷新只能接续同一个取消。
      return route.fulfill({ status: 503, json: { error: { code: 'UAT_CANCEL_RECEIPT_LOST', message: '取消回执未收到' } } })
    }
    await route.fulfill({ response })
  })
  try {
    await agent.getByRole('combobox', { name: '提示词' }).fill('UAT生图：停止交接验证，生成一张白色植物图片。')
    const submitted = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/agent-turns/stream'))
    await agent.getByRole('button', { name: '发送给 Agent', exact: true }).click()
    const input = (await submitted).postDataJSON()
    sessionId = input.sessionId
    const inputId = input.inputMessage.id
    let planId: string | undefined
    await expect.poll(async () => {
      const turnId = (await readMessages()).find(message => message.id === inputId)?.turnId
      planId = turnId ? `agent-turn-result-${turnId}` : undefined
      return Boolean(planId)
    }, { timeout: 20_000 }).toBe(true)
    const plan = agent.locator(`[data-agent-message-id="${planId}"] .agent-message__plan:not(.is-submitted)`)
    await expect(plan.locator('.agent-plan__confirm')).toBeVisible({ timeout: 20_000 })
    await plan.getByRole('button', { name: '选择出图张数', exact: true }).click()
    await page.getByRole('option', { name: '1 张', exact: true }).click()
    await expect(plan.getByRole('button', { name: '选择出图张数', exact: true })).toContainText('1 张')
    expect(planId).toBeTruthy()
    const countBefore = await imageCount()
    await plan.locator('.agent-plan__confirm').click()
    await expect.poll(() => createdRun?.id, { intervals: [10, 20, 50] }).toBeTruthy()
    expect(['completed', 'partial', 'failed', 'cancelled']).not.toContain(createdRun!.status)
    await expect.poll(imageCount, { intervals: [10, 20, 50] }).toBeGreaterThan(countBefore)
    await agent.getByRole('form', { name: 'Agent 输入' }).getByRole('button', { name: '停止', exact: true }).click()
    await expect.poll(async () => (await readMessages())
      .find(message => message.id === planId)?.turnCancellationRequestedAt, { intervals: [10, 20, 50] }).toBeGreaterThan(0)
    releaseCreate()
    await expect.poll(() => cancelledIds.length).toBeGreaterThan(0)
    // 回包丢失后只读确认原任务，不要求第二次点击或刷新才能消除错误。
    await expect.poll(async () => (await readDocument()).agentRuns.find(run => run.id === createdRun!.id)?.status).toBe('cancelled')
    await expect(agent.getByText(/取消未完成|停止状态尚未确认|停止状态待确认|取消回执未收到/)).toHaveCount(0, { timeout: 15_000 })
    expect(cancelledIds).toEqual([createdRun!.id])
    loseCancelReceipt = false
    await page.reload()
    await expect(page.locator('.react-flow')).toBeVisible()
    if (!await agent.isVisible()) await page.getByRole('button', { name: '打开 Bob', exact: true }).click()
    await expect.poll(async () => (await readMessages())
      .some(message => message.id.startsWith('agent-run-stop-') && message.runId === createdRun!.id && message.status === 'answered')).toBe(true)
    await expect.poll(async () => {
      const document = await readDocument()
      const run = document.agentRuns.find(run => run.id === createdRun!.id)
      const jobIds = [...new Set(run.branches.flatMap(branch => branch.jobIds))]
      const jobs = await Promise.all(jobIds.map(async id => {
        const response = await page.request.get(`/api/generation-jobs/${id}`, { headers })
        expect(response.ok()).toBe(true)
        return response.json()
      }))
      return run.status === 'cancelled' && jobs.length === 1 && jobs.every(job => job.status === 'cancelled'
        && job.cancel?.requestedAt > 0 && job.cancel.signalRequired && job.cancel.workerReleased && job.cancel.signalAcknowledgedAt > 0)
    }).toBe(true)
    const after = await readDocument()
    expect(after.agentRuns.filter(run => !oldRuns.includes(run.id)).map(run => run.id)).toEqual([createdRun!.id])
    expect(after.nodes.filter(node => oldImages.some(old => old.id === node.id)).map(node => ({ id: node.id, image: node.data.image }))).toEqual(oldImages)
    expect(new Set(cancelledIds)).toEqual(new Set([createdRun!.id]))
    expect(cancelledIds.length).toBe(1)
    expect(createCount).toBe(1)
    const count = await imageCount()
    await page.reload()
    await expect(page.locator('.react-flow')).toBeVisible()
    if (!await agent.isVisible()) await page.getByRole('button', { name: '打开 Bob', exact: true }).click()
    expect(await imageCount()).toBe(count)
    expect(createCount).toBe(1)
    const stoppedSteps = agent.locator('.agent-timeline__step.is-aborted').filter({ hasText: '已停止' })
    await expect(stoppedSteps.last()).toBeVisible()
    await expect(agent.locator('.agent-timeline__step.is-failed').filter({ hasText: '出图失败' })).toHaveCount(0)
    expect(pageErrors).toEqual([])
    await info.attach('stop-handoff', { body: JSON.stringify({ runId: createdRun!.id, cancelledIds, createCount, imageCount: count }), contentType: 'application/json' })
    await page.screenshot({ path: info.outputPath('run-handoff-stopped.png') })
  } finally {
    releaseCreate()
  }
})

test('计划确认回包丢失后刷新：恢复原Run结果，不重建任务或重开确认', async ({ page, baseURL }, info) => {
  const projectId = process.env.UAT_STOP_PROJECT_ID
  const images = process.env.UAT_IMAGES_FAKE_ORIGIN
  test.skip(!projectId || !images || process.env.UAT_FAKE_GENERATION !== 'true', '仅允许隔离项目和本地假图片服务')
  for (const origin of [baseURL, images]) expect(new URL(origin!).hostname).toBe('127.0.0.1')
  const headers = { Authorization: `Bearer ${process.env.UAT_ACCESS_TOKEN}` }
  const readDocument = async () => (await (await page.request.get(`/api/projects/${projectId}/document`, { headers })).json()).document
  const imageCount = async () => (await (await fetch(`${images}/__requests`)).json()).imageCount
  await signIn(page, process.env.UAT_ACCESS_TOKEN)
  await page.goto(`/#/canvas/${projectId}`)
  await expect(page.locator('.react-flow')).toBeVisible()
  const agent = page.getByRole('complementary', { name: 'Botanic Agent' })
  if (!await agent.isVisible()) await page.getByRole('button', { name: '打开 Bob', exact: true }).click()
  await expect(agent.getByText('已保存', { exact: true })).toBeVisible({ timeout: 20_000 })
  const before = await readDocument()
  let sessionId: string
  const readMessages = async () => {
    const response = await page.request.get(`/api/projects/${projectId}/agent-sessions/${sessionId}/messages?limit=100`, { headers })
    expect(response.ok()).toBe(true)
    return (await response.json()).messages
  }
  const oldRuns = before.agentRuns.map(run => run.id)
  const oldImages = before.nodes.filter(node => node.type === 'result' && node.data.image).map(node => ({ id: node.id, image: node.data.image }))
  const receivedRunIds: string[] = []
  const submissions: unknown[] = []
  let loseReceipt = true
  await page.route('**/api/agent-runs', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    submissions.push(route.request().postDataJSON())
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    receivedRunIds.push((await response.json()).run.id)
    if (loseReceipt) return route.fulfill({ status: 503, json: { error: { code: 'UAT_PLAN_RECEIPT_LOST', message: '确认回执不可达' } } })
    await route.fulfill({ response })
  })
  await agent.getByRole('combobox', { name: '提示词' }).fill('UAT生图：确认刷新验证，生成一张白色植物图片。')
  const submitted = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/agent-turns/stream'))
  await agent.getByRole('button', { name: '发送给 Agent', exact: true }).click()
  const input = (await submitted).postDataJSON()
  sessionId = input.sessionId
  const inputId = input.inputMessage.id
  let planId: string | undefined
  await expect.poll(async () => {
    const turnId = (await readMessages()).find(message => message.id === inputId)?.turnId
    planId = turnId ? `agent-turn-result-${turnId}` : undefined
    return Boolean(planId)
  }, { timeout: 20_000 }).toBe(true)
  const plan = agent.locator(`[data-agent-message-id="${planId}"] .agent-message__plan:not(.is-submitted)`)
  await plan.getByRole('button', { name: '选择出图张数', exact: true }).click()
  await page.getByRole('option', { name: '1 张', exact: true }).click()
  await expect(plan.getByRole('button', { name: '选择出图张数', exact: true })).toContainText('1 张')
  const countBefore = await imageCount()
  await plan.locator('.agent-plan__confirm').click()
  await expect.poll(() => receivedRunIds.length).toBeGreaterThan(0)
  await expect.poll(async () => (await readDocument()).agentRuns.find(run => run.id === receivedRunIds[0])?.status).toBe('completed')
  loseReceipt = false
  await page.reload()
  await expect(page.locator('.react-flow')).toBeVisible()
  if (!await agent.isVisible()) await page.getByRole('button', { name: '打开 Bob', exact: true }).click()
  await expect(agent.locator(`[data-agent-message-id="${planId}"] .agent-plan__confirm`)).toHaveCount(0)
  const after = await readDocument()
  const newImages = after.nodes.filter(node => node.type === 'result' && node.data.image && !oldImages.some(old => old.id === node.id))
  expect(newImages).toHaveLength(1)
  const resultImage = agent.locator(`.agent-run-message__results img[src="${newImages[0].data.image}"]`)
  await expect(resultImage).toHaveCount(1)
  expect(after.agentRuns.filter(run => !oldRuns.includes(run.id)).map(run => run.id)).toEqual([receivedRunIds[0]])
  expect(new Set(receivedRunIds).size).toBe(1)
  expect(submissions.every(submission => JSON.stringify(submission) === JSON.stringify(submissions[0]))).toBe(true)
  expect(await imageCount()).toBe(countBefore + 1)
  expect(after.nodes.filter(node => oldImages.some(old => old.id === node.id)).map(node => ({ id: node.id, image: node.data.image }))).toEqual(oldImages)
  for (const image of await agent.locator('.agent-run-message__results img').all()) await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0)
  await resultImage.scrollIntoViewIfNeeded()
  await page.screenshot({ path: info.outputPath('plan-receipt-restored.png') })
  await info.attach('plan-recovery', { body: JSON.stringify({ runId: receivedRunIds[0], submissionCount: submissions.length, imageCount: await imageCount() }), contentType: 'application/json' })
})
