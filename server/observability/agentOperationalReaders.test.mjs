import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createProductStore } from '../store/productStore.mjs'
import { createBotanicAgentOperationalToolDefinitions } from '../agent/tools/botanicAgentOperationalTools.mjs'
import { createAgentOperationalReaders } from './agentOperationalReaders.mjs'
import { createAgentToolRegistry, runAgentToolLoop } from '../agent/tools/agentToolRuntime.mjs'
import { estimateAgentContextTokens } from '../agent/context/agentContextBudget.mjs'
import { setTimeout as delay } from 'node:timers/promises'

function artifactSearch(t, count, matches, suffix = '') {
  const directory = mkdtempSync(join(tmpdir(), 'botanic-artifact-search-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = createProductStore({ dataPath: join(directory, 'product.json'), bootstrapAccessToken: 'test-owner' })
  const owner = store.authenticate('test-owner')
  store.writeProject(owner.id, { id: 'project-search', name: '检索测试', nodes: [], edges: [], updatedAt: 100 })
  store.putAgentActionReceipt(owner.id, {
    id: 'receipt-search', projectId: 'project-search', toolCallId: 'call-search', createdAt: 100,
    output: { artifacts: Array.from({ length: count }, (_, i) => ({
      id: `artifact-${String(i).padStart(4, '0')}`, kind: i === 70 ? 'text' : 'image',
      label: (matches.includes(i) || i === 70 ? '春季主视觉' : `普通结果${i}`) + suffix, url: '/api/media/private',
      provenance: { actionId: 'call-search', toolName: 'skill_apply' },
    })) },
  })
  const tools = createBotanicAgentOperationalToolDefinitions(createAgentOperationalReaders({
    productStore: store, userId: owner.id, projectId: 'project-search',
  }))
  const tool = tools.find((entry) => entry.name === 'artifact_search')
  assert.deepEqual(tool.parameters.properties.before.required, ['createdAt', 'id'])
  return Object.assign((args) => tool.execute(tool.validate(args)), { tool })
}

test('Artifact 的模型可见预算页使用最后实际交付结果续查，不跳过大页中间记录', async (t) => {
  const search = artifactSearch(t, 40, [], '长标题'.repeat(45))
  const delivered = []
  let calls = 0
  await runAgentToolLoop({
    registry: createAgentToolRegistry([search.tool]), messages: [], maximumSteps: 30,
    callModel: async ({ messages }) => {
      const results = messages.filter((message) => message.role === 'tool')
      assert.ok(results.every((message) => estimateAgentContextTokens(message.content) <= 2000))
      assert.ok(results.reduce((sum, message) => sum + estimateAgentContextTokens(message.content), 0) <= 6000)
      const previous = results.at(-1)
      let before
      if (previous) {
        const output = JSON.parse(previous.content)
        assert.ok(Array.isArray(output.artifacts), '必须交付结构化结果而不是预算预览')
        assert.equal(output.page.blocked, undefined)
        assert.equal(previous.content.includes('/api/media/private'), false)
        delivered.push(...output.artifacts.map((item) => item.id))
        if (!output.page.hasMore) return { choices: [{ message: { content: '完成' } }] }
        before = output.page.before
        assert.equal(before.id, delivered.at(-1))
      }
      return { choices: [{ message: { tool_calls: [{ id: `artifacts-${++calls}`, function: {
        name: 'artifact_search', arguments: JSON.stringify({ limit: 50, before }),
      } }] } }] }
    },
  })
  assert.deepEqual(delivered, Array.from({ length: 40 }, (_, i) => `artifact-${String(i).padStart(4, '0')}`))
})

test('Artifact 检索找到第 81/241 个历史结果，同时间戳分页不遗漏、不重复且不泄露媒体', async (t) => {
  const search = artifactSearch(t, 241, [80, 240])
  const first = await search({ query: '春季', kind: 'image', limit: 1 })
  assert.deepEqual(first.artifacts.map((item) => item.id), ['artifact-0080'])
  assert.equal(first.page.hasMore, true)
  const next = await search({ query: '春季', kind: 'image', limit: 1, before: first.page.before })
  assert.deepEqual(next.artifacts.map((item) => item.id), ['artifact-0240'])
  assert.equal(next.page.hasMore, false)
  const empty = await search({ query: '不存在', limit: 20 })
  assert.equal(empty.total, 0)
  assert.equal(empty.page.hasMore, false)
  assert.equal(JSON.stringify([first, next]).includes('/api/media/'), false)
})

test('Artifact 检索达到扫描预算时返回可继续的游标，不将未扫描历史报告为零命中', async (t) => {
  const search = artifactSearch(t, 1001, [1000])
  const first = await search({ query: '春季', kind: 'image' })
  assert.equal(first.total, 0)
  assert.equal(first.page.hasMore, true)
  assert.equal(first.page.searchTruncated, true)
  assert.equal(first.page.scannedCount, 1000)
  const next = await search({ query: '春季', kind: 'image', before: first.page.before })
  assert.deepEqual(next.artifacts.map((item) => item.id), ['artifact-1000'])
  assert.equal(next.page.hasMore, false)
  await assert.rejects(async () => search({ before: { createdAt: -1, id: 'artifact-0' } }), /游标/)
  await assert.rejects(async () => search({ before: { createdAt: 1e100, id: 'artifact-0' } }), /游标/)
  await assert.rejects(async () => search({ before: { createdAt: 100 } }), /标识/)
})

test('Artifact 读取失败或分页不前进时报错，不返回伪造的空结果', async () => {
  const unreadable = createAgentOperationalReaders({
    productStore: { listAgentArtifacts: async () => undefined }, userId: 'viewer', projectId: 'inaccessible',
  })
  await assert.rejects(unreadable.searchArtifacts({ query: '', kind: '', limit: 20 }), { code: 'ARTIFACT_SEARCH_UNAVAILABLE' })
  const stalled = createAgentOperationalReaders({
    productStore: { listAgentArtifacts: async () => [{ id: 'a', label: '无关', createdAt: 100 }] },
    userId: 'owner', projectId: 'project-1',
  })
  await assert.rejects(stalled.searchArtifacts({ query: '春季', kind: '', before: { id: 'a', createdAt: 100 } }), {
    code: 'ARTIFACT_SEARCH_CURSOR_INVALID',
  })
})

test('canvas_query 将调用方取消贯穿权威 Reader 与 embedding HTTP，不返回降级成功', async (t) => {
  const controller = new AbortController()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    calls++
    controller.abort()
    await delay(5, undefined, { signal: init.signal })
    throw new Error('不可到达')
  })
  const definitions = createBotanicAgentOperationalToolDefinitions(createAgentOperationalReaders({
    productStore: { readProject: async () => ({ document: { nodes: [{ id: 'cancel-node', type: 'text', data: { label: '植物' } }], edges: [] } }) },
    userId: 'owner', projectId: 'cancel-project', semanticSearch: {
      enabled: true, apiBaseUrl: 'https://synthetic.invalid', apiKey: 'synthetic', model: 'reader-cancel',
    },
  }))
  await assert.rejects(definitions.find((tool) => tool.name === 'canvas_query').execute(
    { mode: 'semantic', query: '植物' }, { signal: controller.signal },
  ), { code: 'REQUEST_CANCELLED' })
  assert.equal(calls, 1)
})
