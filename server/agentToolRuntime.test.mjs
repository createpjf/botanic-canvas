import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AgentToolRuntimeError,
  createAgentToolRegistry,
  executeConfirmedAgentAction,
  runAgentToolLoop,
} from './agentToolRuntime.mjs'

test('Tool Registry 以 OpenAI 兼容函数协议暴露受控工具并执行参数校验', async () => {
  const registry = createAgentToolRegistry([
    {
      name: 'canvas_read_selection',
      label: '读取画布选择',
      description: '读取当前画布已选节点的结构化信息。',
      risk: 'read',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { projectId: { type: 'string' } },
        required: ['projectId'],
      },
      validate: (input) => {
        if (!input || typeof input.projectId !== 'string' || !input.projectId.trim()) {
          throw new AgentToolRuntimeError('INVALID_TOOL_ARGUMENTS', '项目不能为空。')
        }
        return { projectId: input.projectId.trim() }
      },
      execute: async (input) => ({ projectId: input.projectId, nodes: ['result-1'] }),
    },
  ])

  // 每个工具都额外暴露 why：模型自述的一句话调用目的，用于展示，不进入工具校验器。
  assert.deepEqual(registry.openAITools(), [{
    type: 'function',
    function: {
      name: 'canvas_read_selection',
      description: '读取当前画布已选节点的结构化信息。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          projectId: { type: 'string' },
          why: {
            type: 'string',
            maxLength: 120,
            description: '用一句话说明你为什么要进行这次调用；这句话会直接展示给用户，不要包含隐藏推理。',
          },
        },
        required: ['projectId'],
      },
    },
  }])
  assert.deepEqual(await registry.execute('canvas_read_selection', { projectId: ' project-a ' }), {
    projectId: 'project-a', nodes: ['result-1'],
  })
  assert.deepEqual(await registry.execute('canvas_read_selection', { projectId: 'project-a', why: '看看选了什么' }), {
    projectId: 'project-a', nodes: ['result-1'],
  })
  await assert.rejects(
    registry.execute('unknown_tool', {}),
    (error) => error instanceof AgentToolRuntimeError && error.code === 'TOOL_NOT_ALLOWED',
  )
})

test('Agent Tool Loop 执行模型函数调用并保留可展示的工具轨迹', async () => {
  const registry = createAgentToolRegistry([
    {
      name: 'generation_create_plan',
      label: '生成执行计划',
      description: '创建受约束的生图计划。',
      risk: 'read',
      terminal: true,
      parameters: { type: 'object', additionalProperties: false, properties: { prompt: { type: 'string' } }, required: ['prompt'] },
      validate: (input) => input,
      execute: async (input) => ({ prompt: input.prompt, output: 1 }),
    },
  ])
  const requests = []
  const result = await runAgentToolLoop({
    registry,
    messages: [{ role: 'user', content: '换场景' }],
    callModel: async (request) => {
      requests.push(request)
      return {
        choices: [{ message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call-plan-1', type: 'function', function: { name: 'generation_create_plan', arguments: '{"prompt":"海边场景"}' } }],
        } }],
      }
    },
  })

  assert.equal(requests.length, 1)
  assert.equal(requests[0].tools[0].function.name, 'generation_create_plan')
  assert.deepEqual(result.output, { prompt: '海边场景', output: 1 })
  assert.deepEqual(result.toolCalls, [{
    id: 'call-plan-1', name: 'generation_create_plan', label: '生成执行计划', risk: 'read', status: 'succeeded', requiresConfirmation: false,
  }])
})

test('Agent Tool Loop 拒绝未知工具、损坏参数与无休止调用', async () => {
  const registry = createAgentToolRegistry([])
  await assert.rejects(
    runAgentToolLoop({
      registry,
      messages: [],
      callModel: async () => ({ choices: [{ message: { tool_calls: [{ id: 'bad', type: 'function', function: { name: 'shell_exec', arguments: '{}' } }] } }] }),
    }),
    (error) => error instanceof AgentToolRuntimeError && error.code === 'TOOL_NOT_ALLOWED',
  )
})

test('受控行动必须携带明确确认，执行结果包含可持久化工具轨迹', async () => {
  const registry = createAgentToolRegistry([{
    name: 'skill_create', label: '创建项目 Skill', description: '创建规则',
    risk: 'write', requiresConfirmation: true, terminal: true,
    parameters: { type: 'object', properties: { name: { type: 'string' } } },
    validate: (value) => value,
    execute: async (value) => ({ skillId: `skill-${value.name}` }),
  }])

  await assert.rejects(
    executeConfirmedAgentAction({ registry, name: 'skill_create', arguments: { name: '夏日' }, toolCallId: 'call-1', confirmed: false }),
    /需要用户确认/,
  )
  const action = await executeConfirmedAgentAction({
    registry, name: 'skill_create', arguments: { name: '夏日' }, toolCallId: 'call-1', confirmed: true,
  })
  assert.deepEqual(action, {
    output: { skillId: 'skill-夏日' },
    toolCall: {
      id: 'call-1', name: 'skill_create', label: '创建项目 Skill', risk: 'write',
      status: 'succeeded', requiresConfirmation: true,
    },
  })
})

test('规划工具执行时收到稳定的模型调用标识，供行动提议与确认关联', async () => {
  const registry = createAgentToolRegistry([{
    name: 'action_propose', label: '提议行动', description: '创建待确认行动',
    risk: 'read', parameters: { type: 'object', properties: {} },
    validate: (value) => value,
    execute: async (_value, context) => ({ proposalId: context.toolCallId }),
  }])
  let step = 0
  const result = await runAgentToolLoop({
    registry, messages: [], maximumSteps: 2,
    callModel: async () => {
      step += 1
      return step === 1
        ? { choices: [{ message: { content: null, tool_calls: [{ id: 'call-proposal-1', type: 'function', function: { name: 'action_propose', arguments: '{}' } }] } }] }
        : { choices: [{ message: { content: '完成' } }] }
    },
  })
  assert.equal(result.output, '完成')
  assert.equal(result.toolCalls[0].id, 'call-proposal-1')
})

test('工具事件用可选 presentation 暴露安全的人话标题和结果计数', async () => {
  const definitions = [
    {
      name: 'web_search', label: '网页搜索', output: { hitCount: 25, sources: Array.from({ length: 25 }, (_, index) => `source-${index}`) },
    },
    { name: 'skill_read', label: '读取 Skill', output: { skillName: '浏览器' } },
    { name: 'browser_connect', label: '连接浏览器', output: { connected: true } },
  ].map(({ name, label, output }) => ({
    name, label, description: label, risk: 'read',
    parameters: { type: 'object', properties: {} },
    validate: (value) => value,
    execute: async () => output,
  }))
  const registry = createAgentToolRegistry(definitions)
  const events = []
  let modelCall = 0
  await runAgentToolLoop({
    registry, messages: [], onEvent: (event) => events.push(event),
    callModel: async () => {
      modelCall += 1
      return modelCall === 1
        ? { choices: [{ message: { content: '我先核对页面。', tool_calls: definitions.map((tool, index) => ({
          id: `call-${index + 1}`, type: 'function', function: { name: tool.name, arguments: '{}' },
        })) } }] }
        : { choices: [{ message: { content: '核对完成。' } }] }
    },
  })

  assert.deepEqual(events.map((event) => ({
    type: event.type,
    id: event.toolCall.id,
    status: event.toolCall.status,
    presentation: event.presentation,
  })), [
    { type: 'tool', id: 'call-1', status: 'running', presentation: { kind: 'search', title: '正在搜索网站' } },
    { type: 'tool', id: 'call-1', status: 'succeeded', presentation: { kind: 'search', title: '已搜索 25 个网站', count: 25 } },
    { type: 'tool', id: 'call-2', status: 'running', presentation: { kind: 'read_skill', title: '读取技能指南' } },
    { type: 'tool', id: 'call-2', status: 'succeeded', presentation: { kind: 'read_skill', title: '读取浏览器技能指南' } },
    { type: 'tool', id: 'call-3', status: 'running', presentation: { kind: 'connect_runtime', title: '连接浏览器 runtime' } },
    { type: 'tool', id: 'call-3', status: 'succeeded', presentation: { kind: 'connect_runtime', title: '连接浏览器 runtime' } },
  ])
})

test('工具执行失败时用同一调用标识收束 running 事件', async () => {
  const registry = createAgentToolRegistry([{
    name: 'web_search',
    label: '网页搜索',
    description: '搜索网页。',
    risk: 'external',
    parameters: { type: 'object', properties: {} },
    validate: (value) => value,
    execute: async () => { throw new Error('搜索服务不可用') },
  }])
  const events = []

  await assert.rejects(runAgentToolLoop({
    registry,
    messages: [],
    onEvent: (event) => events.push(event),
    callModel: async () => ({ choices: [{ message: { tool_calls: [{
      id: 'call-failed-search', type: 'function', function: { name: 'web_search', arguments: '{}' },
    }] } }] }),
  }), /\u641c索服务不可用/u)

  assert.deepEqual(events.map((event) => ({
    id: event.toolCall.id,
    status: event.toolCall.status,
    error: event.toolCall.error,
  })), [
    { id: 'call-failed-search', status: 'running', error: undefined },
    { id: 'call-failed-search', status: 'failed', error: '搜索服务不可用' },
  ])
})

test('WEB_ 工具失败回传给模型，不中断整轮对话', async () => {
  const registry = createAgentToolRegistry([{
    name: 'web_fetch',
    label: '网页获取',
    description: '读取公开网页。',
    risk: 'external',
    parameters: { type: 'object', properties: { url: { type: 'string' } } },
    validate: (value) => value,
    execute: async () => {
      throw new AgentToolRuntimeError('WEB_URL_NOT_ALLOWED', '不能抓取内网或本机地址。', 400)
    },
  }])
  const events = []
  let modelCall = 0
  const result = await runAgentToolLoop({
    registry,
    messages: [],
    onEvent: (event) => events.push(event),
    callModel: async ({ messages }) => {
      modelCall += 1
      if (modelCall === 1) {
        return { choices: [{ message: { tool_calls: [{
          id: 'call-blocked-fetch', type: 'function', function: {
            name: 'web_fetch', arguments: '{"url":"https://[::1]/"}',
          },
        }] } }] }
      }
      const toolMessage = messages.at(-1)
      assert.equal(toolMessage.role, 'tool')
      assert.match(toolMessage.content, /WEB_URL_NOT_ALLOWED/)
      return { choices: [{ message: { content: '这个地址打不开。' } }] }
    },
  })

  assert.equal(result.output, '这个地址打不开。')
  assert.equal(result.toolCalls[0].status, 'failed')
  assert.equal(result.toolCalls[0].error, '不能抓取内网或本机地址。')
  assert.deepEqual(events.map((event) => event.toolCall.status), ['running', 'failed'])
})

test('搜索结果数为 0 时保留真实计数', async () => {
  const registry = createAgentToolRegistry([{
    name: 'web_search', label: '网页搜索', description: '搜索网页。', risk: 'external',
    parameters: { type: 'object', properties: {} }, validate: (value) => value,
    execute: async () => ({ hitCount: 0, sources: [] }),
  }])
  const events = []
  let modelCall = 0
  await runAgentToolLoop({
    registry, messages: [], onEvent: (event) => events.push(event),
    callModel: async () => {
      modelCall += 1
      return modelCall === 1
        ? { choices: [{ message: { tool_calls: [{ id: 'call-empty', type: 'function', function: { name: 'web_search', arguments: '{}' } }] } }] }
        : { choices: [{ message: { content: '没有命中。' } }] }
    },
  })

  assert.deepEqual(events[1].presentation, { kind: 'search', title: '已搜索 0 个网站', count: 0 })
})
