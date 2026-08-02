import assert from 'node:assert/strict'
import test from 'node:test'
import { executeConfirmedAgentAction, runAgentToolLoop } from './agentToolRuntime.mjs'
import {
  createBotanicAgentActionToolRegistry,
  createBotanicAgentPlanningToolRegistry,
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

test('Agent 规划工具可以读取画布上下文、搜索素材并调用白名单 Skill', async () => {
  const registry = createBotanicAgentPlanningToolRegistry({
    input,
    finalizePlan: (raw) => ({ ...raw, trusted: true }),
  })

  assert.deepEqual(registry.openAITools().map((item) => item.function.name), [
    'canvas_read', 'asset_search', 'skill_run', 'skill_create_propose', 'generation_create_plan',
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

test('Agent 规划工具可调用当前项目已审核 Skill，但不能跨项目猜测 Skill', async () => {
  const projectSkill = {
    id: 'skill-scene-campaign', name: '夏日场景系列',
    instructions: '锁定人物与服装，只替换场景与环境光线。', status: 'active',
  }
  const registry = createBotanicAgentPlanningToolRegistry({
    input: { ...input, projectSkills: [projectSkill] },
    finalizePlan: (raw) => raw,
  })

  const schema = registry.openAITools().find((tool) => tool.function.name === 'skill_run')?.function.parameters
  assert.ok(schema.properties.skillId.enum.includes('skill-scene-campaign'))
  const skill = await registry.execute('skill_run', { skillId: 'skill-scene-campaign' }, {})
  assert.deepEqual(skill, {
    skillId: 'skill-scene-campaign', label: '夏日场景系列',
    instructions: '锁定人物与服装，只替换场景与环境光线。', source: 'project',
  })
  await assert.rejects(registry.execute('skill_run', { skillId: 'skill-other-project' }, {}), /不在允许列表/)
})

test('Planner 把 Skill 与 MCP 转换为待确认行动提议，不在规划阶段执行外部工具', async () => {
  const proposals = []
  const registry = createBotanicAgentPlanningToolRegistry({
    input: {
      ...input,
      projectSkills: [{
        id: 'skill-scene-campaign', name: '夏日场景系列',
        instructions: '锁定人物与服装，只替换场景。', status: 'active',
      }],
      availableMcpTools: [{ server: 'asset-catalog', tool: 'search' }],
    },
    finalizePlan: (raw) => raw,
    onProposeAction: (proposal) => proposals.push(proposal),
  })

  assert.ok(registry.openAITools().some((tool) => tool.function.name === 'mcp_propose'))
  await registry.execute('skill_run', { skillId: 'skill-scene-campaign' }, { toolCallId: 'call-skill-1' })
  await registry.execute('mcp_propose', {
    server: 'asset-catalog', tool: 'search', arguments: { query: '海边场景' }, reason: '查找品牌已审核的海边场景。',
  }, { toolCallId: 'call-mcp-1' })

  assert.deepEqual(proposals, [
    {
      id: 'call-skill-1', kind: 'skill', toolName: 'skill_apply', label: '应用 Skill：夏日场景系列',
      summary: '按「夏日场景系列」约束本次创作，并把规则写回画布。', risk: 'write',
      arguments: { skillId: 'skill-scene-campaign' }, status: 'awaiting_confirmation',
    },
    {
      id: 'call-mcp-1', kind: 'mcp', toolName: 'mcp_call', label: '调用 MCP：asset-catalog.search',
      summary: '查找品牌已审核的海边场景。', risk: 'external',
      arguments: { server: 'asset-catalog', tool: 'search', arguments: { query: '海边场景' } },
      status: 'awaiting_confirmation',
    },
  ])
  await assert.rejects(
    registry.execute('mcp_propose', { server: 'unknown', tool: 'delete', arguments: {}, reason: '删除' }, { toolCallId: 'bad' }),
    /不在允许列表/,
  )
})

test('Planner 可以提议创建可复用项目 Skill，但不会在规划阶段直接写入', async () => {
  const proposals = []
  const registry = createBotanicAgentPlanningToolRegistry({
    input,
    finalizePlan: (raw) => raw,
    onProposeAction: (proposal) => proposals.push(proposal),
  })

  assert.ok(registry.openAITools().some((tool) => tool.function.name === 'skill_create_propose'))
  const result = await registry.execute('skill_create_propose', {
    name: '商品锁定换景',
    instructions: '锁定人物、服装与商品，只允许场景和环境光线变化。',
    reason: '这套规则会在同一项目中重复使用。',
  }, { toolCallId: 'call-skill-create-1' })

  assert.deepEqual(result, { proposed: true, actionId: 'call-skill-create-1' })
  assert.deepEqual(proposals, [{
    id: 'call-skill-create-1', kind: 'skill', toolName: 'skill_create',
    label: '创建 Skill：商品锁定换景', summary: '这套规则会在同一项目中重复使用。', risk: 'write',
    arguments: { name: '商品锁定换景', instructions: '锁定人物、服装与商品，只允许场景和环境光线变化。' },
    status: 'awaiting_confirmation',
  }])
})

test('Agent 行动工具默认要求确认，并且 MCP 只能调用服务端白名单', async () => {
  const calls = []
  const registry = createBotanicAgentActionToolRegistry({
    createWorkflow: async (value) => { calls.push(['workflow', value]); return { workflowId: 'workflow-1' } },
    submitGeneration: async (value) => { calls.push(['generation', value]); return { runId: 'run-1' } },
    createSkill: async (value) => { calls.push(['skill', value]); return { skillId: 'skill-1' } },
    mcpTools: {
      'asset-catalog.search': async (value) => { calls.push(['mcp', value]); return { matches: 2 } },
    },
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
    registry.execute('mcp_call', { server: 'unknown', tool: 'delete', arguments: {} }, {}),
    /不在允许列表/,
  )
})

test('已确认的 Skill/MCP 行动返回统一 Artifact 与画布命令', async () => {
  const registry = createBotanicAgentActionToolRegistry({
    applySkill: async ({ skillId }) => ({
      skill: { id: skillId, name: '夏日场景系列', instructions: '锁定人物与服装，只替换场景。' },
    }),
    mcpTools: {
      'asset-catalog.search': async () => ({
        content: [
          { type: 'text', text: '找到 3 个已审核海边场景。' },
          { type: 'resource_link', name: '海边场景 01', uri: 'https://assets.example.com/scene-01.webp', mimeType: 'image/webp' },
        ],
      }),
    },
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
      provenance: { actionId: 'call-skill-apply-1', toolName: 'skill_apply' },
    }],
    canvasCommands: [{
      id: 'command-call-skill-apply-1-1', type: 'create_text_node',
      artifactId: 'artifact-call-skill-apply-1-1',
    }],
  })

  const mcp = await executeConfirmedAgentAction({
    registry, name: 'mcp_call',
    arguments: { server: 'asset-catalog', tool: 'search', arguments: { query: '海边' } },
    toolCallId: 'call-mcp-apply-1', confirmed: true,
  })
  assert.deepEqual(mcp.output, {
    message: 'MCP 工具 asset-catalog.search 已执行。',
    writeback: { kind: 'text', label: 'MCP · asset-catalog.search', content: '找到 3 个已审核海边场景。' },
    artifacts: [
      {
        id: 'artifact-call-mcp-apply-1-1', kind: 'text', label: 'MCP · asset-catalog.search',
        content: '找到 3 个已审核海边场景。',
        provenance: { actionId: 'call-mcp-apply-1', toolName: 'mcp_call', externalTool: 'asset-catalog.search' },
      },
      {
        id: 'artifact-call-mcp-apply-1-2', kind: 'image', label: '海边场景 01',
        url: 'https://assets.example.com/scene-01.webp', mimeType: 'image/webp',
        provenance: { actionId: 'call-mcp-apply-1', toolName: 'mcp_call', externalTool: 'asset-catalog.search' },
      },
    ],
    canvasCommands: [
      { id: 'command-call-mcp-apply-1-1', type: 'create_text_node', artifactId: 'artifact-call-mcp-apply-1-1' },
      { id: 'command-call-mcp-apply-1-2', type: 'create_media_node', artifactId: 'artifact-call-mcp-apply-1-2' },
    ],
  })
})
