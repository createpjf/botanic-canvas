import { expect, test } from '@playwright/test'

const projectId = process.env.UAT_SYNC_PROJECT_ID
test.skip(!process.env.UAT_ACCESS_TOKEN || !projectId || process.env.UAT_SYNC_MUTATION !== 'true', '需要隔离本地项目、UAT_ACCESS_TOKEN 与 UAT_SYNC_MUTATION=true；仅新增空白节点，不生成或删除')

test('Agent 同步状态跟随真实握手和待确认增量，不因点击重试假成功', async ({ page, baseURL }, info) => {
  page.setDefaultTimeout(8_000)
  expect(new URL(baseURL!).hostname).toMatch(/^(127\.0\.0\.1|localhost|\[::1\])$/)
  const received: string[] = []
  let holdHandshake = true
  let handshakes = 0
  let rejectMutation = false
  let holdAcknowledgement = false
  let rejected = 0
  const mutationIds: string[] = []
  const acknowledgements: Array<() => void> = []
  await page.clock.install()
  await page.routeWebSocket(url => url.pathname === '/api/realtime' && url.searchParams.get('projectId') === projectId, socket => {
    const server = socket.connectToServer()
    socket.onMessage(message => {
      const event = JSON.parse(String(message))
      if (event.type === 'canvas.crdt.update') {
        mutationIds.push(event.mutationId)
        if (rejectMutation) {
          // 故障仅在测试代理：真实服务端拒绝无效更新，浏览器 Outbox 保留原有效增量。
          server.send(JSON.stringify({ ...event, update: '!' }))
          return
        }
      }
      server.send(message)
    })
    server.onMessage(message => {
      const event = JSON.parse(String(message))
      received.push(event.type)
      if (event.type === 'canvas.sync.ready.v2') {
        handshakes += 1
        if (holdHandshake) return
      }
      if (event.type === 'canvas.graph.nack.v2' && event.code === 'INVALID_UPDATE') rejected += 1
      if (event.type === 'canvas.crdt.committed' && holdAcknowledgement) {
        acknowledgements.push(() => socket.send(message))
        return
      }
      socket.send(message)
    })
  })
  await page.goto('/#/projects')
  await page.getByRole('button', { name: '登录工作台' }).first().click()
  const legacy = page.getByRole('button', { name: /使用旧访问令牌/ })
  if (await legacy.isVisible()) await legacy.click()
  await page.getByPlaceholder(/粘贴访问令牌/).fill(process.env.UAT_ACCESS_TOKEN!)
  await page.getByRole('button', { name: /进入工作台|Enter workspace/ }).click()
  await expect(page.getByRole('button', { name: '新建项目' })).toBeVisible()
  await page.goto(`/#/canvas/${projectId}`)
  await page.getByRole('button', { name: /^(描述目标|打开 Bob)$/ }).click()
  const agent = page.getByRole('complementary', { name: 'Botanic Agent' })
  await expect(agent).toBeVisible()
  const status = agent.locator('.agent-workspace__realtime-status')
  const composer = agent.getByRole('combobox', { name: '提示词' })
  await composer.fill('UAT 同步恢复期间保留的草稿')
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await expect.poll(() => handshakes).toBe(attempt)
    await expect(status).not.toHaveText('已保存')
    await page.clock.fastForward(30_001)
    if (attempt < 3) await page.clock.fastForward(1_001)
  }
  await expect(status).toContainText('同步受阻 · 重试')
  await expect(status).toHaveAttribute('title', '协作连接超时，请重试。')
  await expect(status).toBeEnabled()
  await expect(composer).toHaveValue('UAT 同步恢复期间保留的草稿')
  holdHandshake = false
  await status.click()
  await expect.poll(() => handshakes).toBe(4)
  await expect(status).toHaveText('已保存')
  await expect(composer).toHaveValue('UAT 同步恢复期间保留的草稿')
  await expect(page.locator('.canvas-realtime-status')).toHaveCount(0)

  const pendingEntries = () => page.evaluate(id => new Promise<Array<{ mutationId: string; blocked?: { code: string } }>>((resolve, reject) => {
    const open = indexedDB.open('botanic-canvas-ui')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const read = db.transaction('canvasGraphOutbox').objectStore('canvasGraphOutbox').getAll()
      read.onsuccess = () => { resolve(read.result.filter(item => item.projectId === id).map(({ mutationId, blocked }) => ({ mutationId, blocked }))); db.close() }
      read.onerror = () => { reject(read.error); db.close() }
    }
  }), projectId!)
  const pending = async () => (await pendingEntries()).length
  const nodes = page.locator('.react-flow__node')
  const beforeIds = await nodes.evaluateAll(items => items.map(item => item.getAttribute('data-id')))
  rejectMutation = true
  await page.getByRole('button', { name: '新增节点', exact: true }).click()
  await page.getByRole('dialog', { name: '添加画布节点' }).getByRole('button', { name: /图片生成/ }).click()
  await page.getByRole('button', { name: '打开 Bob', exact: true }).click()
  await expect.poll(() => rejected).toBeGreaterThan(0)
  await expect(status).toContainText('同步受阻 · 重试')
  await expect(status).toHaveAttribute('title', '修改未被接受，本地修改仍保留。请重新打开项目。')
  await expect.poll(pending).toBeGreaterThan(0)
  const retryMutationId = (await pendingEntries())[0].mutationId
  const firstRejected = rejected
  await status.click()
  await expect.poll(() => rejected).toBeGreaterThan(firstRejected)
  await expect(status).toContainText('同步受阻 · 重试')
  await expect(composer).toHaveValue('UAT 同步恢复期间保留的草稿')
  const afterIds = await nodes.evaluateAll(items => items.map(item => item.getAttribute('data-id')))
  const addedIds = afterIds.filter(id => !beforeIds.includes(id))
  expect(addedIds).toHaveLength(1)

  rejectMutation = false
  holdAcknowledgement = true
  await status.click()
  await expect.poll(() => acknowledgements.length).toBeGreaterThan(0)
  // 新增节点可能产生多条增量。未恢复的失败项仍应阻塞，不把首条 ACK 冒充整批成功。
  const remainingBlocked = (await pendingEntries()).filter(entry => entry.blocked).length
  for (let index = 0; index < remainingBlocked; index += 1) {
    await expect(status).toContainText('同步受阻 · 重试')
    await expect(status).toHaveAttribute('title', '修改未被接受，本地修改仍保留。请重新打开项目。')
    await page.locator('.canvas-realtime-status').getByRole('button', { name: '重试', exact: true }).click()
    await expect.poll(async () => (await pendingEntries()).filter(entry => entry.blocked).length).toBe(remainingBlocked - index - 1)
  }
  await expect(status).toHaveText('保存中…')
  await expect.poll(pending).toBeGreaterThan(0)
  const response = await page.request.get(`/api/projects/${projectId}/document`, {
    headers: { Authorization: `Bearer ${process.env.UAT_ACCESS_TOKEN}` },
  })
  expect(response.ok()).toBe(true)
  expect((await response.json()).document.nodes.some(node => node.id === addedIds[0])).toBe(true)
  await page.screenshot({ path: info.outputPath('sync-awaiting-ack.png') })
  holdAcknowledgement = false
  acknowledgements.splice(0).forEach(release => release())
  await expect.poll(pending).toBe(0)
  await expect(status).toHaveText('已保存')
  await expect(composer).toHaveValue('UAT 同步恢复期间保留的草稿')
  expect(mutationIds.filter(id => id === retryMutationId).length).toBeGreaterThanOrEqual(3)
  await page.screenshot({ path: info.outputPath('sync-recovered.png') })
  await info.attach('sync-events', { body: JSON.stringify({ received, mutationIds, addedIds }), contentType: 'application/json' })
})
