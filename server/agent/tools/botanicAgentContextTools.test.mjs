import assert from 'node:assert/strict'
import test from 'node:test'
import { chatWithBotanicAgent } from '../semantic/botanicAgentChat.mjs'
import { resolveBotanicAgentTurn } from '../turn/botanicAgentTurn.mjs'
import { validateAgentMemoryEntity } from '../semantic/botanicAgentPersistence.mjs'
import { botanicAgentContextBriefing, buildBotanicAgentOntology, safeBotanicAgentMemory } from '../semantic/botanicAgentOntology.mjs'
import { createBotanicAgentReadToolDefinitions } from './botanicAgentContextTools.mjs'
import { createAgentToolRegistry, runAgentToolLoop } from './agentToolRuntime.mjs'
import { estimateAgentContextTokens } from '../context/agentContextBudget.mjs'

const runtime = {
  flockApiKey: 'test-key', flockTextModel: 'deepseek-v4-pro', flockAgentModels: ['deepseek-v4-pro'],
}

test('真实 Tool Loop 交付结构化预算页，模型逐页读长名称不漏不重且累计输出有界', async () => {
  const document = {
    id: 'pagination', nodes: Array.from({ length: 70 }, (_, i) => ({
      id: `n${i}`, type: 'asset', data: { name: `素材${i}${'长名称'.repeat(45)}`, image: '/api/media/private' },
    })), edges: [], assetGroups: [],
  }
  const registry = createAgentToolRegistry(createBotanicAgentReadToolDefinitions({
    ontology: buildBotanicAgentOntology(document), memory: [], skills: [],
  }))
  const delivered = []
  let calls = 0
  await runAgentToolLoop({
    registry, messages: [], maximumSteps: 30,
    callModel: async ({ messages }) => {
      const results = messages.filter((message) => message.role === 'tool')
      assert.ok(results.every((message) => estimateAgentContextTokens(message.content) <= 2000))
      assert.ok(results.reduce((sum, message) => sum + estimateAgentContextTokens(message.content), 0) <= 6000)
      let args = {}
      if (results.length) {
        const last = results.at(-1)
        const page = JSON.parse(last.content)
        assert.ok(page.page, '模型实际收到的结果必须保留结构化分页，而不是头尾预览')
        assert.equal(page.page.blocked, undefined)
        assert.ok(!last.content.includes('/api/media/private'))
        delivered.push(...page.nodes.map((node) => node.id))
        if (!page.page.hasMore) return { choices: [{ message: { content: '完成' } }] }
        args = { cursor: page.page.nextCursor }
      }
      return { choices: [{ message: { tool_calls: [{ id: `page-${++calls}`, function: {
        name: 'ontology_read', arguments: JSON.stringify(args),
      } }] } }] }
    },
  })
  assert.deepEqual(delivered, document.nodes.map((node) => node.id))
  assert.ok(calls > 3, '覆盖累计输出压缩后的续读')
})

test('Turn 与兼容 Chat 的记忆检索保留激活、主体、冲突、时效和节点关联语义', async () => {
  const agentMemory = [
    { id: 'draft', status: 'proposed' },
    { id: 'deleted', status: 'deleted' },
    { id: 'superseded', status: 'superseded', supersededBy: 'brand' },
    { id: 'channel', subject: 'channel', subjectValue: '天猫' },
    { id: 'wrong-brand', subject: 'brand', subjectValue: 'other' },
    { id: 'brand', subject: 'brand', subjectValue: 'botanic' },
    { id: 'user', subject: 'user', subjectValue: 'user-1' },
    { id: 'a-old', updatedAt: 100, conflictsWith: ['z-new'] },
    { id: 'z-new', updatedAt: 200 },
    { id: 'context', source: 'review', sourceNodeIds: ['asset-1'], evidence: [{ kind: 'message', ref: 'message-1', confirmedAt: 100 }] },
  ].map((entry) => validateAgentMemoryEntity({
    kind: 'rule', content: `${entry.id}规则`, source: 'human', confidence: 'confirmed',
    status: 'active', createdAt: 100, updatedAt: 100, ...entry,
  }, { now: 200 }))
  const document = {
    id: 'project-1', brandId: 'botanic', nodes: [{ id: 'asset-1', type: 'asset', data: { name: '商品' } }],
    edges: [], assetGroups: [], agentMemory,
  }
  const input = {
    projectId: document.id, mode: 'research', messages: [{ role: 'user', content: '查看规则' }],
    contextNodeIds: ['asset-1'], hasTarget: false,
  }
  const runtimeIdentity = { userId: 'user-1', projectId: document.id, turnId: 'turn-1' }
  for (const resolve of [resolveBotanicAgentTurn, chatWithBotanicAgent]) {
    let result
    let checkpoint
    let calls = 0
    await resolve(input, runtime, {
      document, runtimeIdentity,
      saveCheckpoint: async (next) => { checkpoint = structuredClone(next) },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body)
        if (calls++ === 0) return new Response(JSON.stringify({ choices: [{ message: {
          content: null, tool_calls: [{ id: 'memory-search', type: 'function', function: {
            name: 'project_memory_search', arguments: JSON.stringify({ query: '本轮约束' }),
          } }],
        } }] }), { status: 200 })
        result = JSON.parse(body.messages.findLast((message) => message.role === 'tool').content)
        return new Response(JSON.stringify({ choices: [{ message: { content: '已读取适用规则。' } }] }), { status: 200 })
      },
    })
    assert.deepEqual(result.items.map((item) => item.id).sort(), ['brand', 'context', 'user', 'z-new'], resolve.name)
    assert.deepEqual(result.conflicts, [{ keptId: 'z-new', droppedId: 'a-old' }])
    assert.deepEqual(result.filtered.map((item) => [item.id, item.code]).sort(), [
      ['channel', 'context_missing'], ['wrong-brand', 'context_mismatch'],
    ])
    assert.equal(result.matchedQuery, true, '节点关联同样是匹配，不能仅按字面词判断')
    assert.ok(result.items.every((item) => item.status === 'active'))
    if (resolve === resolveBotanicAgentTurn) {
      // 空查询下冲突落选的规则仍可能被后续关键词选中，必须受目录快照约束。
      const changed = { ...document, agentMemory: agentMemory.map((item) => (
        item.id === 'a-old' ? { ...item, version: item.version + 1 } : item
      )) }
      await assert.rejects(resolve(input, runtime, {
        document: changed, runtimeIdentity, resumeCheckpoint: checkpoint,
        saveCheckpoint: async () => { throw new Error('目录漂移应在保存前拒绝') },
        fetchImpl: async () => { throw new Error('目录漂移应在 Provider 前拒绝') },
      }), { code: 'AGENT_TURN_CHECKPOINT_SNAPSHOT_MISMATCH' })
    }
  }
})

test('记忆先选择再限制数量，保留历史无 status 规则且不泄露额外字段', async () => {
  const memory = safeBotanicAgentMemory({ agentMemory: [
    ...Array.from({ length: 30 }, (_, i) => ({ id: `draft-${i}`, kind: 'rule', content: '待审核', status: 'proposed' })),
    { id: 'legacy', kind: 'rule', content: '保留包装', privateUrl: '/api/media/private' },
  ] })
  const tool = createBotanicAgentReadToolDefinitions({ ontology: { contextNodeIds: [] }, memory, skills: [] })
    .find((entry) => entry.name === 'project_memory_search')
  const result = await tool.execute({ query: '' })
  assert.deepEqual(result.items.map((item) => item.id), ['legacy'])
  assert.equal(JSON.stringify(result).includes('/api/media/private'), false)
})

test('大画布引用与检索查完整安全集合，概览分页明确而不误报不存在', async () => {
  const document = {
    id: 'project-large', nodes: Array.from({ length: 241 }, (_, i) => ({
      id: `n${i}`, type: 'asset', data: { name: `素材${i}`, image: '/api/media/private' },
    })),
    edges: Array.from({ length: 401 }, (_, i) => ({ id: `e${i}`, source: 'n0', target: 'n240' })),
    assetGroups: Array.from({ length: 81 }, (_, i) => ({ id: `g${i}`, name: `素材组${i}${'长名称'.repeat(30)}`, assetIds: [] })),
  }
  const ontology = buildBotanicAgentOntology(document, ['n240'])
  const briefing = botanicAgentContextBriefing(ontology, { requestedContextNodeIds: ['n240', 'missing'] })
  assert.deepEqual(ontology.contextNodeIds, ['n240'])
  assert.match(briefing, /素材240（asset；节点 ID n240）/)
  assert.match(briefing, /已引用素材（节点 ID missing）/)
  assert.doesNotMatch(briefing, /已引用素材（节点 ID n240）/)
  const tools = new Map(createBotanicAgentReadToolDefinitions({ ontology, memory: [], skills: [] }).map((tool) => [tool.name, tool]))
  const read = (args) => tools.get('ontology_read').execute(tools.get('ontology_read').validate(args))
  const first = await read({})
  assert.deepEqual(first.counts, { nodes: 241, edges: 401, assetGroups: 81 })
  assert.equal(first.page.hasMore, true)
  assert.equal(first.nodes[0].id, 'n240', '显式引用优先进入有界概览')
  const pages = [first]
  while (pages.at(-1).page.hasMore) {
    assert.ok(pages.length < 50, '游标必须持续前进')
    pages.push(await read({ cursor: pages.at(-1).page.nextCursor }))
  }
  assert.equal(new Set(pages.flatMap((page) => page.nodes.map((node) => node.id))).size, 241)
  assert.equal(pages.reduce((sum, page) => sum + page.nodes.length, 0), 241)
  assert.equal(pages.reduce((sum, page) => sum + page.edges.length, 0), 401)
  assert.equal(pages.reduce((sum, page) => sum + page.assetGroups.length, 0), 81)
  assert.ok(pages.every((page) => estimateAgentContextTokens(JSON.stringify(page)) <= 2000))
  assert.deepEqual((await read({ query: '素材240' })).nodes.map((node) => node.id), ['n240'])
  const groups = tools.get('asset_group_search')
  assert.deepEqual((await groups.execute(groups.validate({ query: '素材组80' }))).groups.map((group) => group.id), ['g80'])
  assert.equal((await groups.execute(groups.validate({}))).page.hasMore, true)
  const groupIds = []
  let cursor = 0
  do {
    const page = await groups.execute(groups.validate({ cursor }))
    groupIds.push(...page.groups.map((group) => group.id))
    cursor = page.page.nextCursor
  } while (cursor !== undefined && groupIds.length <= 81)
  assert.deepEqual(groupIds, document.assetGroups.map((group) => group.id))
  assert.throws(() => tools.get('ontology_read').validate({ cursor: -1 }), /游标/)
  assert.throws(() => groups.validate({ cursor: 0.5 }), /游标/)
  assert.equal(JSON.stringify(pages).includes('/api/media/private'), false)
})
