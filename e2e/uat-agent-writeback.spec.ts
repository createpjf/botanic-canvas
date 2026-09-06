import { expect, test, type WebSocketRoute } from '@playwright/test'

const projectId = process.env.UAT_SYNC_PROJECT_ID
test.skip(!process.env.UAT_ACCESS_TOKEN || !projectId || process.env.UAT_WRITEBACK_FIXTURE !== 'true', '需要隔离项目及已完成行动夹具；仅创建测试文本节点，不执行外部工具')

test('已完成行动等待同步后只补未回写产物，刷新不重放工具', async ({ page, baseURL }, info) => {
  page.setDefaultTimeout(8_000)
  expect(new URL(baseURL!).hostname).toMatch(/^(127\.0\.0\.1|localhost|\[::1\])$/)
  let currentSocket: WebSocketRoute
  let holdHandshake = false
  let releaseHandshake: (() => void) | undefined
  await page.routeWebSocket(url => url.pathname === '/api/realtime' && url.searchParams.get('projectId') === projectId, socket => {
    currentSocket = socket
    const server = socket.connectToServer()
    server.onMessage(message => {
      if (JSON.parse(String(message)).type === 'canvas.sync.ready.v2' && holdHandshake) {
        releaseHandshake = () => socket.send(message)
      } else socket.send(message)
    })
  })
  let executions = 0
  await page.route('**/api/agent-actions', route => {
    executions += 1
    return route.fulfill({ status: 500, json: { error: 'UAT forbids tool replay' } })
  })
  await page.goto('/#/projects')
  await page.getByRole('button', { name: '登录工作台' }).first().click()
  const legacy = page.getByRole('button', { name: /使用旧访问令牌/ })
  if (await legacy.isVisible()) await legacy.click()
  await page.getByPlaceholder(/粘贴访问令牌/).fill(process.env.UAT_ACCESS_TOKEN!)
  await page.getByRole('button', { name: /进入工作台|Enter workspace/ }).click()
  await page.goto(`/#/canvas/${projectId}`)
  await page.getByRole('button', { name: '打开 Bob', exact: true }).click()
  const agent = page.getByRole('complementary', { name: 'Botanic Agent' })
  const sync = agent.locator('.agent-workspace__realtime-status')
  await expect(sync).toHaveText('已保存')
  const fixture = await page.evaluate(async id => {
    const resource = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/src/store/canvasStore.ts')?.name
    const { useCanvasStore } = await import(resource || '/src/store/canvasStore.ts')
    const store = useCanvasStore.getState()
    if (store.document.id !== id) throw new Error('UAT project mismatch')
    const suffix = Date.now()
    const actionId = `uat-writeback-${suffix}`
    const firstNodeId = store.addTextNode({ x: 60, y: 60 }, { select: false })
    if (!firstNodeId) throw new Error('UAT canvas is not writable')
    store.updateTextNode(firstNodeId, 'UAT 已回写的第一份产物')
    const result = {
      message: 'UAT 工具已完成，两份产物待核对回写。', canvasWritebackPending: true,
      canvasNodeIds: [firstNodeId], canvasNodeId: firstNodeId,
      artifacts: ['a', 'b'].map((key, index) => ({
        id: `${actionId}-${key}`, kind: 'text', placement: 'canvas', label: `UAT 回写产物 ${key}`,
        content: `UAT 产物 ${key}`, provenance: { actionId, toolName: 'mcp_call', ...(index === 0 ? { sourceNodeIds: [firstNodeId] } : {}) },
      })),
      canvasCommands: ['a', 'b'].map(key => ({ id: `${actionId}-command-${key}`, type: 'create_text_node', artifactId: `${actionId}-${key}` })),
    }
    const action = { id: actionId, kind: 'mcp', toolName: 'mcp_call', label: `UAT 产物回写 ${suffix}`, summary: '已完成的两份测试产物', risk: 'external', arguments: { server: 'uat-local', tool: 'completed-output' }, status: 'running', result }
    const messageId = `${actionId}-message`
    store.appendAgentMessage(store.ensureAgentSession(), {
      id: messageId, role: 'assistant', kind: 'plan', status: 'pending', createdAt: suffix,
      content: 'UAT 已完成行动回写验证',
      plan: {
        instruction: 'UAT 产物回写', intent: 'replace_scene', summary: 'UAT 产物回写', prompt: 'UAT 不生成图片',
        settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' }, constraints: [], references: [],
        output: { mode: 'single', count: 1, candidatesPerItem: 1 }, actions: [action],
      },
    })
    return { action, result, messageId, firstNodeId, nodeCount: useCanvasStore.getState().document.nodes.length }
  }, projectId!)
  // ReactFlow 只渲染可视节点，不能用 DOM 数量断言完整图谱是否丢失。
  const nodeIds = () => page.evaluate(async () => {
    const resource = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/src/store/canvasStore.ts')?.name
    return (await import(resource || '/src/store/canvasStore.ts')).useCanvasStore.getState().document.nodes.map(node => node.id)
  })
  await expect(sync).toHaveText('已保存')
  const card = agent.locator('.agent-action-card').filter({ hasText: fixture.action.label })
  await expect(card).toContainText('结果已完成，等待回写')
  let observed = 0
  let releaseStatus!: () => void
  const pendingStatus = new Promise<void>(resolve => { releaseStatus = resolve })
  await page.route('**/api/agent-actions/status', async route => {
    if (route.request().postDataJSON().actionId !== fixture.action.id) return route.continue()
    observed += 1
    if (observed === 1) await pendingStatus
    await route.fulfill({ json: { status: { status: 'succeeded' }, execution: { output: fixture.result } } })
  })
  const composer = agent.getByRole('combobox', { name: '提示词' })
  await composer.fill('UAT 回写时保留的草稿')
  await card.getByRole('button', { name: '继续回写', exact: true }).click()
  await expect.poll(() => observed).toBe(1)
  holdHandshake = true
  await currentSocket!.close({ code: 1012, reason: 'UAT sync interruption' })
  await expect.poll(() => Boolean(releaseHandshake)).toBe(true)
  await expect(sync).toHaveText('正在同步…')
  releaseStatus()
  await expect(card).toContainText('结果已完成，等待画布同步')
  await expect(card.getByRole('button', { name: '继续回写', exact: true })).toBeDisabled()
  await expect.poll(async () => (await nodeIds()).length).toBe(fixture.nodeCount)
  await expect(composer).toHaveValue('UAT 回写时保留的草稿')
  await page.screenshot({ path: info.outputPath('writeback-awaiting-sync.png') })
  holdHandshake = false
  releaseHandshake!()
  await expect(sync).toHaveText('已保存')
  await card.getByRole('button', { name: '继续回写', exact: true }).click()
  await expect(card).toContainText('已执行')
  await expect.poll(async () => (await nodeIds()).length).toBe(fixture.nodeCount + 1)
  expect(await nodeIds()).toContain(fixture.firstNodeId)
  await expect(sync).toHaveText('已保存')
  await expect(composer).toHaveValue('UAT 回写时保留的草稿')
  expect(executions).toBe(0)
  expect(observed).toBe(2)
  await page.screenshot({ path: info.outputPath('writeback-recovered.png') })
  await page.reload()
  await page.getByRole('button', { name: '打开 Bob', exact: true }).click()
  await expect(card).toContainText('已执行')
  await expect.poll(async () => (await nodeIds()).length).toBe(fixture.nodeCount + 1)
  expect(executions).toBe(0)
  expect(observed).toBe(2)
})

test('同步未恢复时生成任务仍保留结果，重连与刷新不再次生图', async ({ page, baseURL }, info) => {
  const fakeImages = process.env.UAT_IMAGES_FAKE_ORIGIN
  test.skip(process.env.UAT_FAKE_GENERATION !== 'true' || !fakeImages, '只允许已隔离的本机假生成服务')
  page.setDefaultTimeout(8_000)
  for (const origin of [baseURL!, fakeImages!]) expect(new URL(origin).hostname).toMatch(/^(127\.0\.0\.1|localhost|\[::1\])$/)
  const imageCount = async () => (await (await page.request.get(`${fakeImages}/__requests`)).json()).imageCount as number
  const beforeCount = await imageCount()
  let currentSocket: WebSocketRoute
  let holdHandshake = false
  let releaseHandshake: (() => void) | undefined
  await page.routeWebSocket(url => url.pathname === '/api/realtime', socket => {
    currentSocket = socket
    const server = socket.connectToServer()
    server.onMessage(message => {
      if (JSON.parse(String(message)).type === 'canvas.sync.ready.v2' && holdHandshake) releaseHandshake = () => socket.send(message)
      else socket.send(message)
    })
  })
  await page.goto('/#/projects')
  await page.getByRole('button', { name: '登录工作台' }).first().click()
  const legacy = page.getByRole('button', { name: /使用旧访问令牌/ })
  if (await legacy.isVisible()) await legacy.click()
  await page.getByPlaceholder(/粘贴访问令牌/).fill(process.env.UAT_ACCESS_TOKEN!)
  await page.getByRole('button', { name: /进入工作台|Enter workspace/ }).click()
  await page.getByRole('button', { name: '新建项目' }).click()
  await expect(page).toHaveURL(/#\/canvas\/project-/)
  const generationProjectId = new URL(page.url()).hash.split('/').at(-1)!
  await page.getByRole('button', { name: '描述目标', exact: true }).click()
  const agent = page.getByRole('complementary', { name: 'Botanic Agent' })
  const composer = agent.getByRole('combobox', { name: '提示词' })
  const sync = agent.locator('.agent-workspace__realtime-status')
  await composer.fill('UAT生图：生成两张白底植物插画，3:4、2K。')
  await agent.getByRole('button', { name: '发送给 Agent', exact: true }).click()
  await expect(agent.locator('.agent-plan__confirm')).toBeVisible({ timeout: 20_000 })
  await expect(sync).toHaveText('已保存')
  let releaseExecution!: () => void
  const executionGate = new Promise<void>(resolve => { releaseExecution = resolve })
  let executionRequested = false
  let runId = ''
  await page.route('**/api/agent-runs', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    executionRequested = true
    await executionGate
    const response = await route.fetch()
    runId = (await response.json()).run.id
    await route.fulfill({ response })
  })
  await agent.locator('.agent-plan__confirm').click()
  await expect.poll(() => executionRequested).toBe(true)
  holdHandshake = true
  await currentSocket!.close({ code: 1012, reason: 'UAT generation writeback interruption' })
  await expect.poll(() => Boolean(releaseHandshake)).toBe(true)
  await expect(sync).toHaveText('正在同步…')
  releaseExecution()
  await expect.poll(() => Boolean(runId)).toBe(true)
  const headers = { Authorization: `Bearer ${process.env.UAT_ACCESS_TOKEN}` }
  await expect.poll(async () => {
    const response = await page.request.get(`/api/projects/${generationProjectId}/document`, { headers })
    return (await response.json()).document.agentRuns.find(run => run.id === runId)?.status
  }, { timeout: 20_000 }).toBe('completed')
  expect(await imageCount()).toBe(beforeCount + 2)
  const completedDocument = (await (await page.request.get(`/api/projects/${generationProjectId}/document`, { headers })).json()).document
  const resultNodeIds = completedDocument.nodes.filter(node => node.type === 'result').map(node => node.id).sort()
  expect(resultNodeIds.length).toBeGreaterThan(0)
  const index = await page.request.get(`/api/projects/${generationProjectId}/agent-artifacts?limit=100`, { headers })
  const artifacts = (await index.json()).artifacts.filter(artifact => artifact.provenance.runId === runId)
  expect(artifacts).toHaveLength(2)
  await expect(sync).toHaveText('正在同步…')
  await composer.fill('UAT 恢复后继续编辑')
  await page.screenshot({ path: info.outputPath('generation-completed-during-sync.png') })
  holdHandshake = false
  releaseHandshake!()
  await expect(sync).toHaveText('已保存')
  const images = agent.locator('.agent-run-message__results img')
  await expect(images).toHaveCount(2)
  for (const image of await images.all()) await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0)
  await expect(composer).toHaveValue('UAT 恢复后继续编辑')
  await page.reload()
  await page.getByRole('button', { name: '打开 Bob', exact: true }).click()
  await expect(images).toHaveCount(2)
  for (const image of await images.all()) await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0)
  const reloadedDocument = (await (await page.request.get(`/api/projects/${generationProjectId}/document`, { headers })).json()).document
  expect(reloadedDocument.nodes.filter(node => node.type === 'result').map(node => node.id).sort()).toEqual(resultNodeIds)
  expect(await imageCount()).toBe(beforeCount + 2)
  await page.screenshot({ path: info.outputPath('generation-after-sync-reload.png') })
  await info.attach('run-identity', { body: JSON.stringify({ generationProjectId, runId, artifactIds: artifacts.map(artifact => artifact.id), beforeCount, afterCount: await imageCount() }), contentType: 'application/json' })
})
