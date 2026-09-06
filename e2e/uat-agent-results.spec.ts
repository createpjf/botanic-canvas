import { chromium, expect, test } from '@playwright/test'
import { agentArtifactDisplayName } from '../src/features/agent/agentDisplayNames'

// 复用本地 UAT 栈；项目需要已有双图结果。历史页用例另需 CP-E3-2 的 101 项夹具。
const projectId = process.env.UAT_RESULTS_PROJECT_ID
const fakeImages = process.env.UAT_IMAGES_FAKE_ORIGIN
test.skip(!process.env.UAT_ACCESS_TOKEN || !projectId, '需要隔离 UAT_ACCESS_TOKEN 与 UAT_RESULTS_PROJECT_ID')

async function openTestProject(page, id = projectId) {
  await page.goto('/#/projects')
  await page.getByRole('button', { name: '登录工作台' }).first().click()
  const legacy = page.getByRole('button', { name: /使用旧访问令牌/ })
  if (await legacy.isVisible()) await legacy.click()
  await page.getByPlaceholder(/粘贴访问令牌/).fill(process.env.UAT_ACCESS_TOKEN!)
  await page.getByRole('button', { name: /进入工作台|Enter workspace/ }).click()
  await page.goto(`/#/canvas/${id}`)
  await expect(page.locator('.react-flow')).toBeVisible()
  const agent = page.getByRole('complementary', { name: 'Botanic Agent' })
  if (!await agent.isVisible()) await page.getByRole('button', { name: '打开 Bob', exact: true }).click()
  return agent
}

test('双图引用经真实本地请求采用，刷新后仍还原逐项状态', async ({ page, baseURL }, info) => {
  test.skip(process.env.UAT_REFERENCE_FLOW !== 'true', '仅运行隔离本地引用流程，不调用真实 Provider')
  expect(new URL(baseURL!).hostname).toBe('127.0.0.1')
  page.setDefaultTimeout(8000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const headers = { Authorization: `Bearer ${process.env.UAT_ACCESS_TOKEN}` }
  const agent = await openTestProject(page)
  await expect(agent.getByText('已保存', { exact: true })).toBeVisible()
  await agent.getByTitle(/^对话历史/).click()
  await agent.getByRole('button', { name: '新对话', exact: true }).click()
  const composer = agent.getByRole('combobox', { name: '提示词' })
  const artifacts = await (await page.request.get(`/api/projects/${projectId}/agent-artifacts?limit=100`, { headers })).json()
  const mediaUrl = artifacts.artifacts.find(artifact => artifact.kind === 'image').url
  await composer.evaluate(async (input, url) => {
    const image = await (await fetch(url)).blob()
    const data = new DataTransfer()
    for (const name of ['UAT 引用甲.png', 'UAT 引用乙.png']) data.items.add(new File([image], name, { type: image.type }))
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: data })
    input.dispatchEvent(event)
  }, mediaUrl)
  await expect(agent.locator('.agent-composer__attach-chips .agent-attachment')).toHaveCount(2)
  await composer.fill('UAT引用验收：仅描述两张引用图，不要生成图片或修改画布。')
  const submitted = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/agent-turns/stream'))
  await agent.getByRole('button', { name: '发送给 Agent' }).click()
  const input = (await submitted).postDataJSON()
  await expect(agent.locator('.agent-reference-usage')).toHaveCount(1)
  const usage = agent.locator('.agent-reference-usage')
  await usage.locator('summary').click()
  await expect(usage.locator('li')).toHaveCount(2)
  await expect(usage.getByText(/请求含图片(?:描述)?/, { exact: true })).toHaveCount(2)
  await expect(agent.locator('.agent-message.is-assistant').filter({ hasText: 'UAT 回复' })).toBeVisible({ timeout: 20_000 })
  const messages = await (await page.request.get(`/api/projects/${projectId}/agent-sessions/${input.sessionId}/messages?limit=100`, { headers })).json()
  const turnId = messages.messages.find(message => message.id === input.inputMessage.id).turnId
  let observed
  await expect.poll(async () => {
    observed = await (await page.request.get(`/api/agent-turns/${turnId}?after=0&limit=200`, { headers })).json()
    return observed.turn.status
  }, { timeout: 15_000 }).toBe('completed')
  const references = observed.events.filter(event => event.type === 'turn.references').at(-1).payload
  expect(references.items).toHaveLength(2)
  expect(references.items.every(item => item.stage === 'submitted')).toBe(true)
  expect(JSON.stringify(references)).not.toMatch(/data:|\/api\/media\/|caption|description":|image_url/)
  await page.reload()
  if (!await agent.isVisible()) await page.getByRole('button', { name: '打开 Bob', exact: true }).click()
  await expect(usage).toHaveCount(1)
  await expect(usage).not.toHaveAttribute('open', '')
  await usage.locator('summary').press('Enter')
  await expect(usage.getByText(/请求含图片(?:描述)?/, { exact: true })).toHaveCount(2)
  await page.screenshot({ path: info.outputPath('references-restored.png') })
  await info.attach('reference-request-projection', { body: JSON.stringify({ turnId, references }), contentType: 'application/json' })

  // 只在历史读取响应中模拟一项失败；重新准备仍调用真实本地端点，不伪造其回执。
  await page.route(`**/api/agent-turns/${turnId}?*`, async route => {
    const response = await route.fetch()
    const data = await response.json()
    await route.fulfill({ response, json: { ...data, events: data.events.map(event => event.type !== 'turn.references' ? event : {
      ...event, payload: { ...event.payload, items: event.payload.items.map((item, index) => index !== 1 ? item
        : { nodeId: item.nodeId, stage: 'failed', mode: 'none', reason: 'network' }) },
    }) } })
  })
  await page.reload()
  if (!await agent.isVisible()) await page.getByRole('button', { name: '打开 Bob', exact: true }).click()
  await expect(usage.locator('summary')).toContainText('1 项未采用')
  await usage.locator('summary').click()
  const failed = usage.locator('li').nth(1)
  const writes: string[] = []
  page.on('request', request => { if (request.method() === 'POST') writes.push(new URL(request.url()).pathname) })
  const preparing = page.waitForRequest(request => request.url().endsWith('/agent-references/prepare'))
  await failed.getByRole('button', { name: /^重新准备/ }).click()
  expect((await preparing).postDataJSON().nodeIds).toEqual([references.items[1].nodeId])
  await expect(failed.getByText('已重新准备 · 未发送', { exact: true })).toBeVisible()
  await expect(usage.locator('li').first().getByText(/请求含图片(?:描述)?/, { exact: true })).toBeVisible()
  expect(writes.filter(path => /agent-turns|generation-jobs|agent-runs/.test(path))).toEqual([])
  expect(errors).toEqual([])
  await page.screenshot({ path: info.outputPath('reference-reprepared-not-sent.png') })
})

test('完整面板恢复执行用时与去重引用，键盘关闭弹层返回焦点', async ({ page, baseURL }, info) => {
  test.skip(process.env.UAT_ACTIVITY_FIXTURE !== 'true', '仅启用只读历史响应夹具，不伪造写入或模型调用')
  expect(new URL(baseURL!).hostname).toBe('127.0.0.1')
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const turnId = 'turn_uat_activity_history'
  const startedAt = Date.now() - 60_000
  let missingTime = false
  const sources = [
    { hostname: 'elements.ai-sdk.dev', url: 'https://elements.ai-sdk.dev/components/message', title: '消息组件' },
    { hostname: 'elements.ai-sdk.dev', url: 'https://elements.ai-sdk.dev/components/task?view=example', title: '任务组件' },
  ]
  await page.route(`**/api/projects/${projectId}/agent-sessions/*/messages?*`, async route => {
    const response = await route.fetch()
    const data = await response.json()
    const sessionId = new URL(route.request().url()).pathname.split('/')[5]
    await route.fulfill({ response, json: { ...data, messages: [...data.messages, {
      id: `agent-turn-result-${turnId}`, sessionId, turnId, role: 'assistant', kind: 'text', status: 'answered',
      content: 'UAT 执行记录验收（role: 商品）。', createdAt: startedAt, updatedAt: startedAt + 17_000,
    }] } })
  })
  await page.route(`**/api/agent-turns/${turnId}?*`, route => {
    const tool = (sequence: number, offset: number, status: string) => ({
      id: `uat-activity-event-${sequence}`, turnId, projectId, sequence, type: 'turn.tool',
      ...(missingTime ? {} : { createdAt: startedAt + offset }),
      payload: { step: 0, toolCallId: 'uat-web-tool', toolName: 'web_search', label: '核对组件资料', risk: 'read', status,
        inputPreview: { query: 'AI Elements' }, outputPreview: { pages: 2 }, recovery: 'reexecute',
        presentation: { kind: 'search', title: '核对组件资料', sources: [...sources, sources[0]] } },
    })
    return route.fulfill({ json: {
      turn: { id: turnId, projectId, status: 'completed', ...(missingTime ? {} : { createdAt: startedAt, updatedAt: startedAt + 17_000 }) },
      events: [tool(1, 1000, 'running'), tool(2, 6000, 'succeeded')], cursor: { after: 2, hasMore: false },
    } })
  })
  const agent = await openTestProject(page)
  const message = agent.locator('.agent-message.is-assistant').filter({ hasText: 'UAT 执行记录验收' })
  await expect(message).toHaveCount(1)
  const activity = message.locator('.agent-tool-accordion__chain-header')
  await expect(activity).toContainText('用时 17秒')
  await expect(activity).toHaveAttribute('aria-expanded', 'false')
  const citation = message.locator('.agent-message__sources .ai-inline-citation__trigger')
  await expect(citation).toHaveCount(1)
  await citation.press('Enter')
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('link')).toHaveCount(2)
  await expect(dialog.getByRole('link', { name: sources[1].url, exact: true })).toHaveAttribute('href', sources[1].url)
  await dialog.getByRole('link').first().focus()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(citation).toBeFocused()
  await activity.press('Enter')
  const step = message.locator('.agent-tool-accordion__tool-header')
  await expect(step).toHaveCount(1)
  await expect(step).toContainText('用时 5秒')
  await expect(step).toHaveAttribute('aria-expanded', 'false')
  await step.press('Enter')
  await expect(message.locator('.agent-tool-accordion__search-results')).toBeVisible()
  await expect(message.getByText('已恢复', { exact: true })).toHaveCount(0)
  await activity.press('Enter')
  await agent.getByRole('combobox', { name: '提示词' }).fill('保留手动折叠后的草稿')
  await expect(activity).toHaveAttribute('aria-expanded', 'false')
  await expect(message.getByText('UAT 执行记录验收（role: 商品）。', { exact: true })).toBeVisible()
  await page.screenshot({ path: info.outputPath('activity-and-citations.png') })
  missingTime = true
  await page.reload()
  if (!await agent.isVisible()) await page.getByRole('button', { name: '打开 Bob', exact: true }).click()
  await expect(activity).toContainText('执行记录')
  await expect(activity).not.toContainText('秒')
  await activity.press('Enter')
  await expect(step).toContainText('用时 —')
  expect(errors).toEqual([])
})

test('原生200%浏览器缩放后，输入与双附件可操作且无溢出', async ({ baseURL }, info) => {
  const extension = process.env.UAT_ZOOM_EXTENSION
  test.skip(!extension, '需要隔离的只读本机缩放扩展')
  expect(new URL(baseURL!).hostname).toBe('127.0.0.1')
  const context = await chromium.launchPersistentContext(info.outputPath('profile'), {
    channel: 'chromium', headless: true, viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, baseURL,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--window-size=1440,1000'],
  })
  const page = context.pages()[0]
  page.setDefaultTimeout(8_000)
  try {
    const agent = await openTestProject(page)
    const composer = agent.getByRole('combobox', { name: '提示词' })
    await composer.fill('200% 缩放下保留的草稿')
    const before = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio }))
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
    const zoom = await worker.evaluate(async (origin) => {
      const api = (globalThis as any).chrome.tabs
      const tabs = await api.query({ url: 'http://127.0.0.1/*' })
      const tab = tabs.find(tab => new URL(tab.url).origin === origin)
      if (!tab) throw new Error('找不到隔离测试标签页')
      await api.setZoomSettings(tab.id, { mode: 'automatic', scope: 'per-tab' })
      await api.setZoom(tab.id, 2)
      return api.getZoom(tab.id)
    }, new URL(baseURL!).origin)
    expect(zoom).toBe(2)
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(Math.round(before.width / 2))
    await expect.poll(() => page.evaluate(() => devicePixelRatio)).toBe(before.dpr * 2)
    const mediaResponse = await page.request.get(`/api/projects/${projectId}/agent-artifacts?limit=100`, { headers: { Authorization: `Bearer ${process.env.UAT_ACCESS_TOKEN}` } })
    const mediaUrl = (await mediaResponse.json()).artifacts.find(artifact => artifact.kind === 'image').url
    await composer.evaluate(async (input, url) => {
      const image = await (await fetch(url)).blob()
      const data = new DataTransfer()
      for (const name of ['UAT 缩放甲.png', 'UAT 缩放乙.png']) data.items.add(new File([image], name, { type: image.type }))
      const event = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', { value: data })
      input.dispatchEvent(event)
    }, mediaUrl)
    const chips = agent.locator('.agent-composer__attach-chips .agent-attachment')
    await expect(chips).toHaveCount(2)
    await agent.locator('.agent-composer__attachments > summary').click()
    await expect(async () => {
      const layout = await agent.evaluate(panel => {
        const box = panel.getBoundingClientRect()
        const buttons = [...panel.querySelectorAll<HTMLElement>('.agent-composer__toolbar button, .agent-attachment__remove')]
        return {
          overflow: document.documentElement.scrollWidth > innerWidth || panel.scrollWidth > panel.clientWidth,
          fits: buttons.every(button => { const b = button.getBoundingClientRect(); return b.width >= 24 && b.height >= 24 && b.left >= box.left && b.right <= box.right && b.top >= box.top && b.bottom <= box.bottom }),
          font: parseFloat(getComputedStyle(panel.querySelector('textarea')!).fontSize),
        }
      })
      expect(layout.overflow).toBe(false)
      expect(layout.fits).toBe(true)
      expect(layout.font).toBeGreaterThanOrEqual(16)
    }).toPass({ timeout: 3_000 })
    await page.screenshot({ path: info.outputPath('browser-zoom-200.png') })
    await chips.first().getByRole('button').press('Enter')
    await expect(chips).toHaveCount(1)
    await expect(chips.getByRole('button')).toBeFocused()
    await chips.getByRole('button').press('Enter')
    await expect(chips).toHaveCount(0)
    await expect(agent.getByRole('button', { name: '添加图像素材', exact: true })).toBeFocused()
    await expect(composer).toHaveValue('200% 缩放下保留的草稿')
    await info.attach('native-zoom', { body: JSON.stringify({ zoom, before, after: await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })) }), contentType: 'application/json' })
  } finally { await context.close() }
})

test('同ID结果更新可见，旧分页不回退，首页刷新保留已载入历史', async ({ page, baseURL }, info) => {
  test.skip(process.env.UAT_ARTIFACT_UPDATE_FIXTURE !== 'true', '需要显式启用只读索引响应夹具')
  expect(new URL(baseURL!).hostname).toMatch(/^(127\.0\.0\.1|localhost|\[::1\])$/)
  page.setDefaultTimeout(8_000)
  const response = await page.request.get(`/api/projects/${projectId}/agent-artifacts?limit=100`, {
    headers: { Authorization: `Bearer ${process.env.UAT_ACCESS_TOKEN}` },
  })
  expect(response.ok()).toBe(true)
  const pageData = await response.json()
  const original = pageData.artifacts.find(artifact => artifact.kind === 'image')
  const alternate = pageData.artifacts.find(artifact => artifact.kind === 'image' && artifact.url !== original.url)
  expect(alternate, '需要两张本地真实媒体，索引修改只存在测试响应中').toBeTruthy()
  const old = { ...original, label: 'UAT 索引旧版' }
  const updated = { ...old, label: 'UAT 索引新版', url: alternate.url, updatedAt: old.updatedAt + 1 }
  const histories = ['甲', '乙'].map((suffix, index) => ({ ...old, id: `${old.id}:uat-history-${index}`, label: `UAT 历史${suffix}` }))
  let refreshed = false
  const requestedCursors: (string | null)[] = []
  await page.route(`**/api/projects/${projectId}/agent-artifacts*`, route => {
    const cursor = new URL(route.request().url()).searchParams.get('before')
    requestedCursors.push(cursor)
    if (cursor === 'uat-new-page') return route.fulfill({ json: { artifacts: [updated, histories[0]], nextBefore: 'uat-old-page' } })
    if (cursor === 'uat-old-page') return route.fulfill({ json: { artifacts: [old, histories[1]] } })
    return route.fulfill({ json: refreshed
      ? { artifacts: [updated], nextBefore: 'uat-new-page' }
      : { artifacts: pageData.artifacts.map(artifact => artifact.id === old.id ? old : artifact), nextBefore: 'uat-new-page' } })
  })
  const agent = await openTestProject(page)
  const openResults = async () => {
    await agent.getByRole('button', { name: 'Agent 工具', exact: true }).click()
    await agent.getByRole('button', { name: '结果与文件', exact: true }).click()
  }
  await openResults()
  const panel = agent.locator('.agent-result-panel')
  await expect(panel.getByTitle(old.label, { exact: true })).toHaveCount(1)
  await panel.getByRole('button', { name: '加载更早结果', exact: true }).click()
  await expect(panel.getByTitle(updated.label, { exact: true })).toHaveCount(1)
  await expect(panel.getByTitle(old.label, { exact: true })).toHaveCount(0)
  await panel.getByRole('button', { name: '加载更早结果', exact: true }).click()
  await expect(panel.getByRole('button', { name: '加载更早结果', exact: true })).toHaveCount(0)
  await expect(panel.getByTitle(updated.label, { exact: true })).toHaveCount(1)
  for (const artifact of histories) await expect(panel.getByTitle(artifact.label, { exact: true })).toHaveCount(1)
  await panel.getByTitle(updated.label, { exact: true }).getByRole('button', { name: /^查看 / }).click()
  await expect(panel.locator('.agent-result-panel__hero img')).toHaveAttribute('src', updated.url)
  await expect.poll(() => panel.locator('.agent-result-panel__hero img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
  refreshed = true
  await agent.getByRole('button', { name: '关闭 Agent', exact: true }).click()
  await page.getByRole('button', { name: '打开 Bob', exact: true }).click()
  await expect.poll(() => requestedCursors.at(-1)).toBeNull()
  await openResults()
  await expect(panel.getByTitle(updated.label, { exact: true })).toHaveCount(1)
  await expect(panel.getByTitle(old.label, { exact: true })).toHaveCount(0)
  for (const artifact of histories) await expect(panel.getByTitle(artifact.label, { exact: true })).toHaveCount(1)
  expect(requestedCursors).toContain('uat-new-page')
  expect(requestedCursors).toContain('uat-old-page')
  await page.screenshot({ path: info.outputPath('artifact-version-retained.png') })
})

test('指定第二张结果提交新版本，原图与历史结果保持不变', async ({ page, baseURL }, info) => {
  test.skip(process.env.UAT_FAKE_GENERATION !== 'true' || !fakeImages, '仅允许显式本地假图片服务')
  for (const origin of [baseURL, fakeImages]) expect(new URL(origin!).hostname).toMatch(/^(127\.0\.0\.1|localhost|\[::1\])$/)
  page.setDefaultTimeout(8_000)
  const headers = { Authorization: `Bearer ${process.env.UAT_ACCESS_TOKEN}` }
  const readDocument = async () => (await (await page.request.get(`/api/projects/${projectId}/document`, { headers })).json()).document
  const imageCount = async () => (await (await fetch(`${fakeImages}/__requests`)).json()).imageCount
  const agent = await openTestProject(page)
  const before = await readDocument()
  const previousRunIds = before.agentRuns.map(run => run.id)
  const originalImages = before.nodes.filter(node => node.type === 'result').map(node => ({ id: node.id, image: node.data.image }))
  await expect(agent.locator('.agent-run-message__results img')).toHaveCount(originalImages.length)
  const countBefore = await imageCount()
  const selectedUrl = await agent.locator('.agent-run-message__results').first().locator('img').nth(1).getAttribute('src')
  expect(selectedUrl).toBeTruthy()
  const selectedNode = before.nodes.find(node => node.type === 'result' && node.data.image === selectedUrl)
  expect(selectedNode, '所选缩略图必须对应真实结果节点').toBeTruthy()
  await agent.getByRole('button', { name: '选择要修改的结果' }).first().click()
  await page.getByRole('option').nth(1).click()
  const references = agent.locator('details').filter({ hasText: '已引用' })
  if (await references.getAttribute('open') === null) await references.locator('summary').click()
  await expect(agent.getByRole('form', { name: 'Agent 输入' }).locator('img.agent-attachment__preview')).toHaveAttribute('src', selectedUrl!)
  await agent.getByRole('combobox', { name: '提示词' }).fill('UAT生图：只基于选中的这张结果生成一个新版本，保持主体不变。')
  await agent.getByRole('button', { name: '发送给 Agent', exact: true }).click()
  const plan = agent.locator('.agent-message__plan:not(.is-submitted)').last()
  await expect(plan.locator('.agent-plan__confirm')).toBeVisible({ timeout: 20_000 })
  await plan.getByRole('button', { name: '选择出图张数', exact: true }).click()
  await page.getByRole('option', { name: '1 张', exact: true }).click()
  await expect(plan.getByRole('button', { name: '选择出图张数', exact: true })).toContainText('1 张')
  await plan.locator('.agent-plan__confirm').click()
  await expect.poll(async () => (await readDocument()).agentRuns.find(run => !previousRunIds.includes(run.id))?.status, { timeout: 20_000 }).toBe('completed')
  const after = await readDocument()
  const run = after.agentRuns.find(run => !previousRunIds.includes(run.id))
  const jobs = after.generationJobs.filter(job => run.branches.some(branch => branch.jobIds?.includes(job.id) || branch.activeJobId === job.id))
  expect(jobs).toHaveLength(1)
  const result = after.nodes.find(node => node.id === jobs[0].resultNodeId)
  expect(result.data.generationRecipe.references.map(reference => reference.image)).toEqual([selectedUrl])
  expect(result.data.generationRecipe.referenceBindings.map(binding => binding.mediaId)).toEqual([selectedUrl!.split('/').at(-1)])
  expect(run.plan.contextSnapshot.map(item => item.nodeId)).toContain(selectedNode.id)
  expect(after.nodes.filter(node => originalImages.some(original => original.id === node.id)).map(node => ({ id: node.id, image: node.data.image }))).toEqual(originalImages)
  expect(await imageCount()).toBe(countBefore + 1)
  await page.reload()
  await page.getByRole('button', { name: '打开 Bob', exact: true }).click()
  await expect(agent.locator('.agent-run-message__results img')).toHaveCount(originalImages.length + 1)
  for (const image of await agent.locator('.agent-run-message__results img').all()) await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0)
  expect(await imageCount()).toBe(countBefore + 1)
  await agent.locator('.agent-run-message__results img').last().scrollIntoViewIfNeeded()
  await page.screenshot({ path: info.outputPath('selected-result-submitted.png') })
  await info.attach('selected-result-identity', { body: JSON.stringify({ projectId, selectedNodeId: selectedNode.id, selectedUrl, runId: run.id, jobId: jobs[0].id }), contentType: 'application/json' })
})

test('切换项目后，已取得但迟到的旧索引不会覆盖新项目', async ({ page }, info) => {
  const otherProjectId = process.env.UAT_OTHER_PROJECT_ID
  test.skip(!otherProjectId, '需要另一个已保存且没有Artifact的隔离测试项目')
  let release: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  let arrived: () => void
  const captured = new Promise<void>(resolve => { arrived = resolve })
  let ended: () => void
  const released = new Promise<void>(resolve => { ended = resolve })
  await page.route(`**/api/projects/${projectId}/agent-artifacts*`, async route => {
    const response = await route.fetch()
    expect((await response.json()).artifacts.length).toBeGreaterThan(0)
    arrived()
    await hold
    try { await route.fulfill({ response }) } finally { ended() }
  })
  const agent = await openTestProject(page)
  await captured
  try {
    await page.goto(`/#/canvas/${otherProjectId}`)
    await expect(page.locator('.react-flow')).toBeVisible()
    if (!await agent.isVisible()) await page.getByRole('button', { name: '打开 Bob', exact: true }).click()
    await agent.getByRole('combobox', { name: '提示词' }).fill('另一个项目的未提交草稿')
    await agent.getByRole('button', { name: 'Agent 工具', exact: true }).click()
    await agent.getByRole('button', { name: '结果与文件', exact: true }).click()
    await expect(agent.locator('.agent-panel__empty')).toBeVisible()
  } finally { release!() }
  await released
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await expect(agent.locator('.agent-result-panel__item')).toHaveCount(0)
  await expect(agent.locator('.agent-result-panel__index-status[role="alert"]')).toHaveCount(0)
  await agent.getByRole('button', { name: /返回对话|返回聊天/ }).click()
  await expect(agent.getByRole('combobox', { name: '提示词' })).toHaveValue('另一个项目的未提交草稿')
  await page.screenshot({ path: info.outputPath('late-index-isolated.png') })
})

test('实际删除生成节点并刷新：Artifact保留、下载成功、继续修改不重新生成', async ({ page, baseURL }, info) => {
  const api = process.env.UAT_API_ORIGIN
  test.skip(!api || !fakeImages || process.env.UAT_DELETE_RESULT_NODE !== 'true', '需要明确允许删除隔离测试生成节点')
  for (const origin of [api, fakeImages, baseURL]) expect(new URL(origin!).hostname, '删除UAT仅允许本机隔离服务').toMatch(/^(127\.0\.0\.1|localhost|\[::1\])$/)
  test.setTimeout(40_000)
  const agent = await openTestProject(page)
  const headers = { Authorization: `Bearer ${process.env.UAT_ACCESS_TOKEN}` }
  const readDocument = async () => (await (await page.request.get(`${api}/api/projects/${projectId}/document`, { headers })).json()).document
  const document = await readDocument()
  const artifacts: any[] = []
  let before = ''
  for (let i = 0; i < 3; i++) {
    const response = await page.request.get(`${api}/api/projects/${projectId}/agent-artifacts?limit=100${before ? `&before=${encodeURIComponent(before)}` : ''}`, { headers })
    expect(response.ok()).toBe(true)
    const data = await response.json()
    artifacts.push(...data.artifacts)
    if (!data.nextBefore) break
    before = data.nextBefore
  }
  const target = artifacts.toReversed().find(artifact => artifact.origin.type === 'generation_output' && artifact.kind === 'image'
    && artifact.provenance.sourceNodeIds?.some(id => document.nodes.some(node => node.id === id && node.type === 'result' && node.data.status === 'ready')))
  expect(target, '需要尚在画布上的真实测试生成结果').toBeTruthy()
  const nodeId = target.provenance.sourceNodeIds.find(id => document.nodes.some(node => node.id === id))
  const mediaPath = new URL(target.url, api).pathname
  const countBefore = (await (await fetch(`${fakeImages}/__requests`)).json()).imageCount
  await agent.getByRole('button', { name: 'Agent 工具', exact: true }).click()
  await agent.getByRole('button', { name: '结果与文件', exact: true }).click()
  const panel = agent.locator('.agent-result-panel')
  // 同一图片内容可被多个输出复用，URL 不是 Artifact 身份。
  const targetName = agentArtifactDisplayName(target, document.agentRuns.find(run => run.id === target.provenance.runId))
  const mediaCard = panel.getByRole('button', { name: `查看 ${targetName}`, exact: true })
  await mediaCard.click()
  await panel.getByRole('button', { name: '定位画布', exact: true }).click()
  await agent.getByRole('button', { name: '关闭 Agent', exact: true }).click()
  const node = page.locator(`.react-flow__node[data-id="${nodeId}"]`)
  await node.click()
  await page.getByRole('button', { name: '聚焦选中节点', exact: true }).click()
  await node.locator('.result-node__header').hover()
  await node.locator('.result-node__header-remove').click()
  await expect(node).toHaveCount(0)
  await expect.poll(async () => (await readDocument()).nodes.some(item => item.id === nodeId), { timeout: 15_000 }).toBe(false)
  await page.reload()
  await expect(page.locator('.react-flow')).toBeVisible()
  if (!await agent.isVisible()) await page.getByRole('button', { name: '打开 Bob', exact: true }).click()
  await expect(node).toHaveCount(0)
  await agent.getByRole('button', { name: 'Agent 工具', exact: true }).click()
  await agent.getByRole('button', { name: '结果与文件', exact: true }).click()
  const older = panel.getByRole('button', { name: '加载更早结果', exact: true })
  if (await older.isVisible()) await older.click()
  await mediaCard.click()
  await expect(panel.getByRole('button', { name: '定位画布', exact: true })).toHaveCount(0)
  const downloadReady = page.waitForEvent('download')
  await panel.getByRole('button', { name: '下载', exact: true }).click()
  const download = await downloadReady
  await download.saveAs(info.outputPath('deleted-node-artifact.png'))
  expect(await download.failure()).toBeNull()
  await panel.getByRole('button', { name: '继续改', exact: true }).click()
  const references = agent.locator('details').filter({ hasText: '已引用' })
  if (await references.getAttribute('open') === null) await references.locator('summary').click()
  await expect(agent.getByRole('form', { name: 'Agent 输入' }).locator(`img.agent-attachment__preview[src$="${mediaPath}"]`)).toHaveCount(1)
  expect((await (await fetch(`${fakeImages}/__requests`)).json()).imageCount).toBe(countBefore)
  await page.screenshot({ path: info.outputPath('deleted-result-recovered.png') })
})

test('第101项历史结果：分页失败原位重试、节点缺失可预览并继续修改', async ({ page }, info) => {
  test.skip(!fakeImages || process.env.UAT_HISTORY_FIXTURE !== 'true', '需要假图片 Provider 计数与历史分页夹具')
  test.setTimeout(30_000)
  const countBefore = (await (await fetch(`${fakeImages}/__requests`)).json()).imageCount
  await page.goto('/#/projects')
  await page.getByRole('button', { name: '登录工作台' }).first().click()
  const legacy = page.getByRole('button', { name: /使用旧访问令牌/ })
  if (await legacy.isVisible()) await legacy.click()
  await page.getByPlaceholder(/粘贴访问令牌/).fill(process.env.UAT_ACCESS_TOKEN!)
  await page.getByRole('button', { name: /进入工作台|Enter workspace/ }).click()
  let failMore = true
  const cursors: string[] = []
  await page.route('**/api/projects/*/agent-artifacts*', route => {
    const before = new URL(route.request().url()).searchParams.get('before')
    if (before) {
      cursors.push(before)
      if (failMore) return route.fulfill({ status: 503, json: { error: 'UAT earlier page unavailable' } })
    }
    return route.continue()
  })
  await page.goto(`/#/canvas/${projectId}`)
  await expect(page.locator('.react-flow')).toBeVisible()
  const agent = page.getByRole('complementary', { name: 'Botanic Agent' })
  if (!await agent.isVisible()) await page.getByRole('button', { name: '打开 Bob', exact: true }).click()
  await agent.getByRole('button', { name: 'Agent 工具', exact: true }).click()
  await agent.getByRole('button', { name: '结果与文件', exact: true }).click()
  const panel = agent.locator('.agent-result-panel')
  const historical = panel.getByTitle('UAT 历史图片 101', { exact: true })
  await expect(historical).toHaveCount(0)
  const existing = await panel.locator('.agent-result-panel__item').count()
  await panel.getByRole('button', { name: '加载更早结果', exact: true }).click()
  const failure = panel.getByRole('alert')
  await expect(failure).toContainText('更早结果读取失败')
  await expect(panel.locator('.agent-result-panel__item')).toHaveCount(existing)
  const failedCursor = cursors.at(-1)
  failMore = false
  await failure.getByRole('button', { name: '重试', exact: true }).click()
  await expect(failure).toHaveCount(0)
  expect(cursors.at(-1)).toBe(failedCursor)
  await historical.getByRole('button', { name: /^查看 / }).click()
  const hero = panel.locator('.agent-result-panel__hero img')
  await expect.poll(() => hero.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
  const selectedMedia = await hero.getAttribute('src')
  await expect(panel.getByRole('button', { name: '定位画布', exact: true })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: '下载', exact: true })).toBeEnabled()
  await page.screenshot({ path: info.outputPath('historical-result-preview.png') })
  await panel.getByRole('button', { name: '继续改', exact: true }).click()
  await expect(agent.getByRole('combobox', { name: '提示词' })).toHaveValue(/UAT 历史图片 101/)
  const references = agent.locator('details').filter({ hasText: '已引用' })
  if (!await references.getAttribute('open').then(value => value !== null)) await references.locator('summary').click()
  await expect(agent.getByRole('form', { name: 'Agent 输入' }).locator('img.agent-attachment__preview')).toHaveAttribute('src', selectedMedia!)
  expect((await (await fetch(`${fakeImages}/__requests`)).json()).imageCount).toBe(countBefore)
  await page.screenshot({ path: info.outputPath('historical-result-continue.png') })
})

test('结果面板返回保持草稿、引用、阅读位置与焦点', async ({ page }, info) => {
  test.setTimeout(30_000)
  await page.setViewportSize({ width: 1440, height: 600 })
  await page.goto('/#/projects')
  await page.getByRole('button', { name: '登录工作台' }).first().click()
  const legacy = page.getByRole('button', { name: /使用旧访问令牌/ })
  if (await legacy.isVisible()) await legacy.click()
  await page.getByPlaceholder(/粘贴访问令牌/).fill(process.env.UAT_ACCESS_TOKEN!)
  await page.getByRole('button', { name: /进入工作台|Enter workspace/ }).click()
  await page.goto(`/#/canvas/${projectId}`)
  await expect(page.locator('.react-flow')).toBeVisible()
  const agent = page.getByRole('complementary', { name: 'Botanic Agent' })
  if (!await agent.isVisible()) await page.getByRole('button', { name: '打开 Bob', exact: true }).click()
  await expect(agent.locator('.agent-run-message__results img').first()).toBeVisible()
  if (process.env.UAT_HISTORY_FIXTURE === 'true') await expect(agent.getByRole('button', { name: '查看更多结果', exact: true }).last()).toBeVisible()
  const picker = agent.getByRole('button', { name: '选择要修改的结果' }).last()
  if (await picker.isVisible()) {
    await picker.click()
    await page.getByRole('option').nth(1).click()
  } else await agent.getByRole('button', { name: '继续修改', exact: true }).last().click()
  const composer = agent.getByRole('combobox', { name: '提示词' })
  await composer.fill('保留这段尚未提交的修改要求')
  await agent.locator('summary').filter({ hasText: '已引用' }).click()
  const preview = agent.getByRole('form', { name: 'Agent 输入' }).locator('img.agent-attachment__preview')
  const media = await preview.getAttribute('src')
  await expect(preview).toBeVisible()
  const viewport = agent.locator('.agent-workspace__messages')
  await viewport.hover()
  await page.mouse.wheel(0, -120)
  await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(100)
  const before = await viewport.evaluate(element => element.scrollTop)
  expect(before).toBeGreaterThan(20)
  await agent.getByRole('button', { name: 'Agent 工具', exact: true }).click()
  await agent.getByRole('button', { name: '结果与文件', exact: true }).click()
  await expect(agent.locator('.agent-result-panel')).toBeVisible()
  await viewport.hover()
  await page.mouse.wheel(0, 600)
  // 短结果列表可能无需滚动；仍确保切换后位置已变化，随后验证恢复到原阅读位置。
  await expect.poll(() => viewport.evaluate(element => element.scrollTop)).not.toBe(before)
  await agent.getByRole('button', { name: /返回对话|返回聊天/ }).click()
  await expect(composer).toHaveValue('保留这段尚未提交的修改要求')
  await expect(composer).toBeFocused()
  await expect(preview).toHaveAttribute('src', media!)
  await expect.poll(async () => Math.abs(await viewport.evaluate(element => element.scrollTop) - before)).toBeLessThan(2)
  await page.screenshot({ path: info.outputPath('result-return.png') })
})
