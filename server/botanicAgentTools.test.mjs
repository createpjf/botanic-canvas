import assert from 'node:assert/strict'
import test from 'node:test'
import { executeConfirmedAgentAction, runAgentToolLoop } from './agentToolRuntime.mjs'
import { createConfiguredMcpRuntime, parseMcpToolConfigurations } from './mcpClient.mjs'
import { createBotanicAgentReadToolDefinitions } from './botanicAgentContextTools.mjs'
import {
  botanicAgentMountedSkillBriefing,
  botanicAgentSearchableSkills,
  botanicAgentSystemSkills,
  createBotanicAgentActionToolRegistry,
  createBotanicAgentPlanningToolRegistry,
  freezeBotanicAgentSkillCatalog,
  pinnedBotanicAgentProjectSkills,
  resolveBotanicAgentMountedSkills,
} from './botanicAgentTools.mjs'

const input = {
  projectId: 'project-agent',
  instruction: '保持人物和服装，替换为海边场景。',
  selectedResult: { nodeId: 'result-v03', label: '首图候选 01' },
  settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
  references: [
    { id: 'asset-model', name: '模特 33', role: '模特', primary: false },
    { id: 'asset-product', name: '德国队球衣', role: '商品', primary: true },
  ],
  assetGroup: { id: 'group-scenes', name: '夏日海边', role: '场景', assetCount: 10 },
}

function mcpRuntime(handler = async () => ({ matches: 2 })) {
  return createConfiguredMcpRuntime(parseMcpToolConfigurations([{
    server: 'asset-catalog',
    tool: 'search',
    version: '2026-08-28',
    url: 'https://mcp.example/rpc',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { query: { type: 'string', maxLength: 120 } },
      required: ['query'],
    },
  }]), {
    idFactory: () => 'request-1',
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body)
      const result = await handler(request.params.arguments)
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'request-1', result }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })
}

test('系统 Skill 目录包含交付配方，Composer 挂载后能解析到正文', async () => {
  const systemSkills = botanicAgentSystemSkills()
  const ids = systemSkills.map((skill) => skill.id)
  assert.deepEqual(ids.includes('ecommerce_listing'), true)
  assert.deepEqual(ids.includes('platform_pack'), true)
  assert.deepEqual(ids.includes('video_storyboard'), true)
  assert.deepEqual(ids.includes('conversation_distill'), true)
  assert.ok(systemSkills.every((skill) => skill.version === 1 && typeof skill.contentHash === 'string'))
  // 未知 id 不再静默丢弃：fail closed，模型调用前收口。
  assert.throws(
    () => resolveBotanicAgentMountedSkills(
      ['ecommerce_listing', 'missing_skill', 'conversation_distill'],
      [{ id: 'skill-scene-campaign', name: '夏日场景系列', instructions: '只换场景。', status: 'active' }],
    ),
    (caught) => caught.code === 'AGENT_SKILL_BINDING_UNKNOWN' && /missing_skill/u.test(caught.message),
  )
  const mounted = resolveBotanicAgentMountedSkills(
    ['ecommerce_listing', 'conversation_distill'],
    [{ id: 'skill-scene-campaign', name: '夏日场景系列', instructions: '只换场景。', status: 'active' }],
  )
  assert.deepEqual(mounted.map((skill) => skill.id), ['ecommerce_listing', 'conversation_distill'])
  assert.match(mounted[0].instructions, /电商套图/)
  const briefing = botanicAgentMountedSkillBriefing(mounted)
  assert.match(briefing, /用户已在输入框挂载/)
  assert.match(briefing, /电商套图/)
  assert.match(briefing, /对话沉淀/)
  const searchable = botanicAgentSearchableSkills([{
    id: 'skill-scene-campaign', name: '夏日场景系列', instructions: '只换场景。', status: 'active',
  }])
  assert.ok(searchable.some((skill) => skill.id === 'platform_pack'))
  assert.ok(searchable.some((skill) => skill.id === 'skill-scene-campaign'))
  // 渐进式披露:searchable 目录仍带正文供服务端 skill_run/挂载消费,但 skill_search
  // 工具结果只暴露 metadata + 摘要,完整正文归第三级。见 botanicAgentContextTools。
  const searchExecute = createBotanicAgentReadToolDefinitions({
    ontology: { project: {}, nodes: [], edges: [], assetGroups: [], contextNodeIds: [] },
    memory: [],
    skills: botanicAgentSearchableSkills([]),
  }).find((tool) => tool.name === 'skill_search')
  const searchResult = await searchExecute.execute({ query: '套图' })
  assert.ok(searchResult.skills.length > 0)
  for (const entry of searchResult.skills) {
    assert.equal(entry.instructions, undefined, 'skill_search 不得回传完整正文')
    assert.equal(typeof entry.summary, 'string')
    assert.ok(entry.summary.length <= 160)
  }
  const systemSearch = searchable.find((skill) => skill.id === 'platform_pack')
  const systemCatalog = systemSkills.find((skill) => skill.id === 'platform_pack')
  assert.equal(systemSearch.version, systemCatalog.version)
  assert.equal(systemSearch.contentHash, systemCatalog.contentHash)
  assert.equal(resolveBotanicAgentMountedSkills(['platform_pack'])[0].contentHash, systemCatalog.contentHash)
})

test('Agent 规划工具可以读取画布上下文、搜索素材并调用白名单 Skill', async () => {
  const registry = createBotanicAgentPlanningToolRegistry({
    input,
    finalizePlan: (raw) => ({ ...raw, trusted: true }),
    finalizeClarification: (raw) => raw,
  })

  assert.deepEqual(registry.openAITools().map((item) => item.function.name), [
    'canvas_read', 'asset_search', 'skill_run', 'skill_create_propose', 'canvas_edit_propose', 'generation_ask_clarification', 'generation_create_plan',
  ])
  const canvas = await registry.execute('canvas_read', {}, {})
  assert.deepEqual(canvas, {
    projectId: 'project-agent',
    selectedResult: input.selectedResult,
    settings: input.settings,
    references: input.references,
  })
  const search = await registry.execute('asset_search', { role: '场景', query: '海边' }, {})
  assert.deepEqual(search, { groups: [input.assetGroup], total: 1 })
  const skill = await registry.execute('skill_run', { skillId: 'controlled_edit' }, {})
  assert.equal(skill.skillId, 'controlled_edit')
  assert.match(skill.instructions, /只改变用户明确允许变化的维度/)
  assert.doesNotMatch(JSON.stringify({ canvas, search, skill }), /data:image|https?:\/\//)
})

test('规划器在提供搜索配置时暴露 web_search 与 web_fetch', () => {
  const registry = createBotanicAgentPlanningToolRegistry({
    input,
    finalizePlan: (raw) => raw,
    finalizeClarification: (raw) => raw,
    webResearch: { apiKey: 'test-search-key' },
  })
  assert.deepEqual(registry.openAITools().map((item) => item.function.name).slice(0, 4), [
    'canvas_read', 'asset_search', 'web_search', 'web_fetch',
  ])
})

test('Agent 规划工具可调用当前项目已审核 Skill，但不能跨项目猜测 Skill', async () => {
  const projectSkill = {
    id: 'skill-scene-campaign', name: '夏日场景系列',
    instructions: '锁定人物与服装，只替换场景与环境光线。', status: 'active',
  }
  const registry = createBotanicAgentPlanningToolRegistry({
    input: { ...input, projectSkills: [projectSkill] },
    finalizePlan: (raw) => raw,
    finalizeClarification: (raw) => raw,
  })

  const schema = registry.openAITools().find((tool) => tool.function.name === 'skill_run')?.function.parameters
  assert.ok(schema.properties.skillId.enum.includes('skill-scene-campaign'))
  const skill = await registry.execute('skill_run', { skillId: 'skill-scene-campaign' }, {})
  assert.deepEqual(skill, {
    skillId: 'skill-scene-campaign', label: '夏日场景系列',
    instructions: '锁定人物与服装，只替换场景与环境光线。', source: 'project',
    capabilities: ['read'],
  })
  await assert.rejects(registry.execute('skill_run', { skillId: 'skill-other-project' }, {}), /不在允许列表/)
})

test('Planner 调用 Skill 后立即生效，MCP 仍转为待确认行动', async () => {
  const proposals = []
  const runtime = mcpRuntime()
  const descriptor = runtime.catalog()[0]
  const registry = createBotanicAgentPlanningToolRegistry({
    input: {
      ...input,
      projectSkills: [{
        id: 'skill-scene-campaign', name: '夏日场景系列',
        instructions: '锁定人物与服装，只替换场景。', status: 'active',
      }],
      availableMcpTools: runtime.catalog(),
    },
    finalizePlan: (raw) => raw,
    finalizeClarification: (raw) => raw,
    onProposeAction: (proposal) => proposals.push(proposal),
  })

  assert.ok(registry.openAITools().some((tool) => tool.function.name === 'mcp_propose'))
  await registry.execute('skill_run', { skillId: 'skill-scene-campaign' }, { toolCallId: 'call-skill-1' })
  await registry.execute('mcp_propose', {
    server: 'asset-catalog', tool: 'search', arguments: { query: '海边场景' }, reason: '查找品牌已审核的海边场景。',
  }, { toolCallId: 'call-mcp-1' })

  assert.deepEqual(proposals, [
    {
      id: 'call-skill-1', kind: 'skill', toolName: 'skill_apply', label: 'Skill · 夏日场景系列',
      summary: '已按「夏日场景系列」约束本次创作。', risk: 'write',
      arguments: { skillId: 'skill-scene-campaign' }, status: 'succeeded',
    },
    {
      id: 'call-mcp-1', kind: 'mcp', toolName: 'mcp_call', label: '调用 MCP：asset-catalog.search',
      summary: '查找品牌已审核的海边场景。', risk: 'external',
      arguments: {
        server: 'asset-catalog', tool: 'search', arguments: { query: '海边场景' },
        version: descriptor.version, capabilityHash: descriptor.capabilityHash,
      },
      status: 'awaiting_confirmation',
    },
  ])
  await assert.rejects(
    registry.execute('mcp_propose', { server: 'unknown', tool: 'delete', arguments: {}, reason: '删除' }, { toolCallId: 'bad' }),
    /不在允许列表/,
  )
})

test('画布修改走提案-确认制：规划期只出提案，确认后经注册表执行编辑器', async () => {
  const proposals = []
  const planning = createBotanicAgentPlanningToolRegistry({
    input,
    finalizePlan: (raw) => raw,
    finalizeClarification: (raw) => raw,
    onProposeAction: (proposal) => proposals.push(proposal),
  })
  await planning.execute('canvas_edit_propose', {
    operation: 'update_text',
    arguments: { nodeId: 'text-1', content: '新提示词' },
    reason: '按用户要求改写生成描述。',
  }, { toolCallId: 'call-canvas-1' })
  assert.deepEqual(proposals, [{
    id: 'call-canvas-1', kind: 'canvas', toolName: 'canvas_update_text', label: '修改画布文字',
    summary: '按用户要求改写生成描述。', risk: 'write',
    arguments: { nodeId: 'text-1', content: '新提示词' },
    status: 'awaiting_confirmation',
  }])

  const executed = []
  const actions = createBotanicAgentActionToolRegistry({
    updateCanvasText: async (argumentsValue) => {
      executed.push(argumentsValue)
      return { message: '已更新。', canvasNodeIds: [argumentsValue.nodeId] }
    },
  })
  const result = await executeConfirmedAgentAction({
    registry: actions, name: 'canvas_update_text',
    arguments: { nodeId: 'text-1', content: '新提示词' },
    toolCallId: 'call-canvas-1', confirmed: true,
  })
  assert.deepEqual(executed, [{ nodeId: 'text-1', content: '新提示词' }])
  assert.deepEqual(result.output.canvasNodeIds, ['text-1'])
  // 空修改在参数校验层就被拒，不进执行器。
  await assert.rejects(
    executeConfirmedAgentAction({
      registry: actions, name: 'canvas_update_text',
      arguments: { nodeId: 'text-1' }, toolCallId: 'call-canvas-2', confirmed: true,
    }),
    /至少提供/,
  )
})

test('声明写入能力的项目 Skill 不会在规划阶段静默生效', async () => {
  const proposals = []
  const registry = createBotanicAgentPlanningToolRegistry({
    input: {
      ...input,
      projectSkills: [{
        id: 'skill-workflow-write', name: '工作流写入', instructions: '允许写入工作流。', status: 'active', capabilities: ['read', 'write'],
      }],
    },
    finalizePlan: (raw) => raw,
    finalizeClarification: (raw) => raw,
    onProposeAction: (proposal) => proposals.push(proposal),
  })
  const result = await registry.execute('skill_run', { skillId: 'skill-workflow-write' }, { toolCallId: 'call-skill-write' })
  assert.deepEqual(result, {
    skillId: 'skill-workflow-write', name: '工作流写入', source: 'project',
    capabilities: ['read', 'write'], requiresConfirmation: true, risk: 'write',
  })
  assert.equal(proposals[0].status, 'awaiting_confirmation')
  assert.equal(proposals[0].requiresConfirmation, true)
  assert.equal(proposals[0].risk, 'write')
})

test('Planner 可以提议创建可复用项目 Skill，但不会在规划阶段直接写入', async () => {
  const proposals = []
  const registry = createBotanicAgentPlanningToolRegistry({
    input,
    finalizePlan: (raw) => raw,
    finalizeClarification: (raw) => raw,
    onProposeAction: (proposal) => proposals.push(proposal),
  })

  assert.ok(registry.openAITools().some((tool) => tool.function.name === 'skill_create_propose'))
  const result = await registry.execute('skill_create_propose', {
    name: '商品锁定换景',
    instructions: '锁定人物、服装与商品，只允许场景和环境光线变化。',
    capabilities: ['read', 'write'],
    manifest: {
      kind: 'guidance',
      toolAllowlist: ['canvas_read', 'workflow_create'],
      dependencies: [{ skillId: 'controlled_edit', version: 1 }],
    },
    reason: '这套规则会在同一项目中重复使用。',
  }, { toolCallId: 'call-skill-create-1' })

  assert.deepEqual(result, { proposed: true, actionId: 'call-skill-create-1' })
  assert.deepEqual(proposals, [{
    id: 'call-skill-create-1', kind: 'skill', toolName: 'skill_create',
    label: '创建 Skill：商品锁定换景', summary: '这套规则会在同一项目中重复使用。', risk: 'write',
    arguments: {
      name: '商品锁定换景',
      instructions: '锁定人物、服装与商品，只允许场景和环境光线变化。',
      capabilities: ['read', 'write'],
      manifest: {
        version: 1,
        kind: 'guidance',
        toolAllowlist: ['canvas_read', 'workflow_create'],
        dependencies: [{ skillId: 'controlled_edit', version: 1 }],
      },
    },
    status: 'awaiting_confirmation',
  }])
})

test('Agent 行动工具默认要求确认，并且 MCP 只能调用服务端白名单', async () => {
  const calls = []
  const runtime = mcpRuntime(async (value) => { calls.push(['mcp', value]); return { matches: 2 } })
  const descriptor = runtime.catalog()[0]
  const registry = createBotanicAgentActionToolRegistry({
    createWorkflow: async (value) => { calls.push(['workflow', value]); return { workflowId: 'workflow-1' } },
    submitGeneration: async (value) => { calls.push(['generation', value]); return { runId: 'run-1' } },
    createSkill: async (value) => { calls.push(['skill', value]); return { skillId: 'skill-1' } },
    mcpRuntime: runtime,
  })
  const modelResponse = {
    choices: [{ message: { content: null, tool_calls: [{
      id: 'call-submit-1', type: 'function',
      function: { name: 'generation_submit', arguments: JSON.stringify({ planId: 'plan-1' }) },
    }] } }],
  }

  await assert.rejects(
    runAgentToolLoop({ registry, messages: [], maximumSteps: 1, callModel: async () => modelResponse }),
    /需要用户确认/,
  )
  assert.equal(calls.length, 0)
  const approved = await runAgentToolLoop({
    registry,
    messages: [],
    maximumSteps: 1,
    context: { approvedToolCallIds: new Set(['call-submit-1']) },
    callModel: async () => modelResponse,
  })
  assert.deepEqual(approved.output, { runId: 'run-1' })
  assert.deepEqual(approved.toolCalls[0], {
    id: 'call-submit-1', name: 'generation_submit', label: '提交生成任务',
    risk: 'costly', status: 'succeeded', requiresConfirmation: true,
  })
  await assert.rejects(
    registry.execute('mcp_call', {
      server: 'unknown', tool: 'delete', arguments: {}, version: '1', capabilityHash: 'x'.repeat(43),
    }, {}),
    /不在允许列表/,
  )
  await assert.rejects(
    registry.execute('mcp_call', {
      server: descriptor.server, tool: descriptor.tool, arguments: { query: '海边' },
    }, {}),
    /能力版本/u,
  )
  await assert.rejects(
    registry.execute('mcp_call', {
      server: descriptor.server, tool: descriptor.tool, arguments: { query: '海边' },
      version: descriptor.version, capabilityHash: 'x'.repeat(43),
    }, {}),
    (error) => error.code === 'MCP_CAPABILITY_STALE' && error.outcomeKnown === true,
  )
})

test('已确认的 Skill/MCP 行动返回统一 Artifact 与画布命令', async () => {
  const runtime = mcpRuntime(async () => ({
    content: [
      { type: 'text', text: '找到 3 个已审核海边场景。' },
      { type: 'resource_link', name: '海边场景 01', uri: '/api/media/scene-01', mimeType: 'image/webp' },
      { type: 'resource_link', name: '外部未授权场景', uri: 'https://assets.example.com/external.webp', mimeType: 'image/webp' },
    ],
  }))
  const descriptor = runtime.catalog()[0]
  const registry = createBotanicAgentActionToolRegistry({
    applySkill: async ({ skillId }) => ({
      skill: { id: skillId, name: '夏日场景系列', instructions: '锁定人物与服装，只替换场景。' },
    }),
    mcpRuntime: runtime,
  })

  const skill = await executeConfirmedAgentAction({
    registry, name: 'skill_apply', arguments: { skillId: 'skill-scene-campaign' },
    toolCallId: 'call-skill-apply-1', confirmed: true,
  })
  assert.deepEqual(skill.output, {
    message: '已应用 Skill「夏日场景系列」。',
    writeback: { kind: 'text', label: 'Skill · 夏日场景系列', content: '锁定人物与服装，只替换场景。' },
    artifacts: [{
      id: 'artifact-call-skill-apply-1-1', kind: 'workflow', label: 'Skill · 夏日场景系列',
      content: '锁定人物与服装，只替换场景。',
      placement: 'panel',
      provenance: { actionId: 'call-skill-apply-1', toolName: 'skill_apply' },
    }],
    // Skill 规则只进结果面板，不再无条件在画布上创建文字节点。
    canvasCommands: [],
  })

  const mcp = await executeConfirmedAgentAction({
    registry, name: 'mcp_call',
    arguments: {
      server: 'asset-catalog', tool: 'search', arguments: { query: '海边' },
      version: descriptor.version, capabilityHash: descriptor.capabilityHash,
    },
    toolCallId: 'call-mcp-apply-1', confirmed: true,
  })
  assert.deepEqual(mcp.output, {
    message: 'MCP 工具 asset-catalog.search 已执行。',
    writeback: { kind: 'text', label: 'MCP · asset-catalog.search', content: '找到 3 个已审核海边场景。' },
    artifacts: [
      {
        id: 'artifact-call-mcp-apply-1-1', kind: 'text', label: 'MCP · asset-catalog.search',
        content: '找到 3 个已审核海边场景。', placement: 'panel',
        provenance: { actionId: 'call-mcp-apply-1', toolName: 'mcp_call', externalTool: 'asset-catalog.search' },
      },
      {
        id: 'artifact-call-mcp-apply-1-2', kind: 'image', label: '海边场景 01', placement: 'canvas',
        url: '/api/media/scene-01', mimeType: 'image/webp',
        provenance: { actionId: 'call-mcp-apply-1', toolName: 'mcp_call', externalTool: 'asset-catalog.search' },
      },
    ],
    // MCP 文本留在结果面板，只有媒体产物写画布。
    canvasCommands: [
      { id: 'command-call-mcp-apply-1-2', type: 'create_media_node', artifactId: 'artifact-call-mcp-apply-1-2' },
    ],
  })
})

test('MCP 内联 image 与 structuredContent 收成可展示 Artifact', async () => {
  const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const runtime = mcpRuntime(async () => ({
    content: [
      { type: 'text', text: '缩略图已就绪。' },
      { type: 'image', mimeType: 'image/png', data: tinyPng },
    ],
    structuredContent: { scenes: 3, query: 'beach' },
  }))
  const descriptor = runtime.catalog()[0]
  const registry = createBotanicAgentActionToolRegistry({ mcpRuntime: runtime })
  const mcp = await executeConfirmedAgentAction({
    registry, name: 'mcp_call',
    arguments: {
      server: descriptor.server, tool: descriptor.tool, arguments: { query: '海边' },
      version: descriptor.version, capabilityHash: descriptor.capabilityHash,
    },
    toolCallId: 'call-mcp-rich-1', confirmed: true,
  })
  assert.equal(mcp.output.artifacts?.length, 3)
  assert.equal(mcp.output.artifacts?.[0].kind, 'text')
  assert.equal(mcp.output.artifacts?.[1].kind, 'text')
  assert.match(mcp.output.artifacts?.[1].content ?? '', /"scenes": 3/)
  assert.equal(mcp.output.artifacts?.[1].metadata?.mcpStructured, true)
  assert.equal(mcp.output.artifacts?.[2].kind, 'image')
  assert.match(mcp.output.artifacts?.[2].url ?? '', /^data:image\/png;base64,/)
  assert.equal(mcp.output.artifacts?.[2].placement, 'panel')

  // 提供媒体落库 seam 时内联图变成同源地址，Artifact Index 才收得进历史。
  const persisted = []
  const persistedRegistry = createBotanicAgentActionToolRegistry({
    mcpRuntime: runtime,
    persistMcpMedia: async (dataUrl) => {
      persisted.push(dataUrl)
      return '/api/media/media_mcp_1'
    },
  })
  const persistedCall = await executeConfirmedAgentAction({
    registry: persistedRegistry, name: 'mcp_call',
    arguments: {
      server: descriptor.server, tool: descriptor.tool, arguments: { query: '海边' },
      version: descriptor.version, capabilityHash: descriptor.capabilityHash,
    },
    toolCallId: 'call-mcp-rich-2', confirmed: true,
  })
  assert.equal(persistedCall.output.artifacts?.[2].url, '/api/media/media_mcp_1')
  assert.match(persisted[0] ?? '', /^data:image\/png;base64,/)
})

test('挂载 Skill fail-closed：坏依赖具名拒绝，好依赖完整注入且不截断', () => {
  // 静默丢掉会让用户以为自己挂的规则在生效；带 warning 照用会让 Agent 拿着少了
  // 半截的约束去创作。fail closed：任一依赖不可用就在 Provider 调用前具名失败。
  const projectSkills = [
    {
      id: 'top', name: '主规则', instructions: '主规则正文', status: 'active', capabilities: ['read'],
      manifest: { version: 1, toolAllowlist: [], dependencies: [{ skillId: 'gone' }] },
    },
    {
      id: 'fine', name: '完整规则', instructions: '完整规则正文', status: 'active', capabilities: ['read'],
      manifest: { version: 1, toolAllowlist: [], dependencies: [{ skillId: 'controlled_edit' }] },
    },
  ]
  assert.throws(
    () => resolveBotanicAgentMountedSkills(['top', 'fine'], projectSkills),
    (caught) => caught.code === 'AGENT_SKILL_BINDING_DEPENDENCY' && /gone/u.test(caught.message),
  )

  // 合法依赖（内置 Skill）：closure 以 dependency-first 顺序注入一次，roots 保序。
  const mounted = resolveBotanicAgentMountedSkills(['fine'], projectSkills.slice(1))
  assert.deepEqual(mounted.map((skill) => skill.id), ['controlled_edit', 'fine'])
  assert.equal(mounted[0].role, 'dependency')
  const briefing = botanicAgentMountedSkillBriefing(mounted)
  assert.match(briefing, /挂载 Skill 的依赖/u)
  assert.match(briefing, /完整规则正文/u)

  // 16 个短 Skill + 2000 字以上长正文 sentinel 全部完整注入，不再截断。
  const sixteen = Array.from({ length: 16 }, (_, index) => ({
    id: `ps-${index + 1}`, name: `技能${index + 1}`, status: 'active', capabilities: ['read'],
    instructions: index === 0 ? `${'规'.repeat(2000)}SENTINEL_AFTER_2000` : `规则${index + 1}`,
  }))
  const policy = { maxInputTokens: 16000 }
  const wide = resolveBotanicAgentMountedSkills(sixteen.map((skill) => skill.id), sixteen, { contextPolicy: policy })
  assert.equal(wide.length, 16)
  assert.match(botanicAgentMountedSkillBriefing(wide), /SENTINEL_AFTER_2000/u)

  const thirtyOne = Array.from({ length: 31 }, (_, index) => ({
    id: `catalog-${index + 1}`, name: `目录技能${index + 1}`, instructions: '规则', status: 'active', capabilities: ['read'],
  }))
  assert.equal(resolveBotanicAgentMountedSkills(['catalog-31'], thirtyOne)[0].id, 'catalog-31')

  const versionConflict = [
    {
      id: 'root-a', name: '主技能 A', instructions: 'A', status: 'active', version: 1, contentHash: 'hash-a', capabilities: ['read'],
      manifest: { version: 1, toolAllowlist: [], dependencies: [{ skillId: 'root-b', version: 1, contentHash: 'hash-b-v1' }] },
    },
    {
      id: 'root-b', name: '主技能 B', instructions: 'B v2', status: 'active', version: 2, contentHash: 'hash-b-v2', capabilities: ['read'],
      versions: [{ version: 1, name: '主技能 B', instructions: 'B v1', capabilities: ['read'], contentHash: 'hash-b-v1' }],
    },
  ]
  assert.throws(
    () => resolveBotanicAgentMountedSkills(['root-a', 'root-b'], versionConflict),
    (caught) => caught.code === 'AGENT_SKILL_DEPENDENCY_CONFLICT' && /root-b/u.test(caught.message),
  )

  // 超过聚合预算：具名失败而不是裁剪正文。
  assert.throws(
    () => resolveBotanicAgentMountedSkills(sixteen.map((skill) => skill.id), sixteen, { contextPolicy: { maxInputTokens: 2000 } }),
    (caught) => caught.code === 'AGENT_SKILL_CONTEXT_TOO_LARGE',
  )
  // 第 17 个:超出公开上限。
  assert.throws(
    () => resolveBotanicAgentMountedSkills([...sixteen.map((skill) => skill.id), 'controlled_edit'], sixteen),
    (caught) => caught.code === 'AGENT_SKILL_BINDING_LIMIT',
  )
})

test('没有 Manifest 的存量 Skill 挂载行为不变', () => {
  const mounted = resolveBotanicAgentMountedSkills(['legacy'], [
    { id: 'legacy', name: '存量', instructions: '正文', status: 'active', capabilities: ['read'] },
  ])
  assert.equal(mounted.length, 1)
  assert.equal(mounted[0].dependencyIssues, undefined)
  assert.equal(/>/u.test(botanicAgentMountedSkillBriefing(mounted)), false)
})

test('Skill Loader V2:冻结 catalog 恢复时命中原版本,历史缺失或 hash 漂移 fail closed', () => {
  const publishedV1 = {
    id: 'brand-rules', name: '品牌规则', instructions: 'V1 正文', status: 'active', capabilities: ['read'],
    version: 1, contentHash: 'hash-v1',
    versions: [{ version: 1, name: '品牌规则', instructions: 'V1 正文', capabilities: ['read'], contentHash: 'hash-v1' }],
  }
  // 主路径:Turn 创建时冻结;中断期间项目 Skill 发布 V2,恢复仍读原 V1 binding。
  const frozen = freezeBotanicAgentSkillCatalog([publishedV1])
  assert.equal(frozen.version, 1)
  assert.equal(frozen.project[0].contentHash, 'hash-v1')
  assert.ok(frozen.builtIn.controlled_edit.instructions.length > 0, '内置 Skill 冻结完整语义 snapshot')
  const publishedV2 = {
    ...publishedV1, version: 2, contentHash: 'hash-v2', instructions: 'V2 正文',
    versions: [
      ...publishedV1.versions,
      { version: 2, name: '品牌规则', instructions: 'V2 正文', capabilities: ['read'], contentHash: 'hash-v2' },
    ],
  }
  const pinned = pinnedBotanicAgentProjectSkills(frozen, [publishedV2])
  assert.equal(pinned[0].instructions, 'V1 正文')
  assert.equal(pinned[0].contentHash, 'hash-v1')
  const mounted = resolveBotanicAgentMountedSkills(['brand-rules'], pinned, { builtIn: frozen.builtIn })
  assert.equal(mounted[0].instructions, 'V1 正文')
  const deprecated = pinnedBotanicAgentProjectSkills(frozen, [{ ...publishedV1, status: 'deprecated' }])
  assert.equal(deprecated[0].status, 'active', '冻结回合仍可读取已下线 Skill 的历史版本')
  assert.equal(resolveBotanicAgentMountedSkills(['brand-rules'], deprecated)[0].instructions, 'V1 正文')
  // 旧 Turn 没有 V2 字段:保留旧 reader,当前目录原样通过。
  assert.deepEqual(pinnedBotanicAgentProjectSkills(undefined, [publishedV2]), [publishedV2])

  assert.throws(
    () => freezeBotanicAgentSkillCatalog([{ ...publishedV1, version: undefined, contentHash: undefined }]),
    (caught) => caught.code === 'AGENT_SKILL_SNAPSHOT_MISMATCH',
  )
  assert.throws(
    () => pinnedBotanicAgentProjectSkills({ version: 2, builtIn: {}, project: [] }, [publishedV2]),
    (caught) => caught.code === 'AGENT_SKILL_SNAPSHOT_MISMATCH',
  )

  // 失败路径:历史版本丢失(新对象只有 V2 历史)→ Provider 调用前具名失败。
  const lostHistory = { ...publishedV2, versions: [publishedV2.versions[1]] }
  assert.throws(
    () => pinnedBotanicAgentProjectSkills(frozen, [lostHistory]),
    (caught) => caught.code === 'AGENT_SKILL_SNAPSHOT_MISMATCH',
  )
  // hash 漂移同样拒绝。
  const drifted = {
    ...publishedV2,
    versions: [{ version: 1, name: '品牌规则', instructions: '被篡改', capabilities: ['read'], contentHash: 'hash-x' }, publishedV2.versions[1]],
  }
  assert.throws(
    () => pinnedBotanicAgentProjectSkills(frozen, [drifted]),
    (caught) => caught.code === 'AGENT_SKILL_SNAPSHOT_MISMATCH',
  )
})
