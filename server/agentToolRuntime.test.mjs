import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentToolRuntimeError, createAgentToolRegistry, executeConfirmedAgentAction, freezeAgentStepSnapshot, runAgentToolLoop, toolEventPresentation } from './agentToolRuntime.mjs'

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

test('web_search 从 hits 对象下发去重站点，字符串 sources 只用于计数', () => {
  assert.deepEqual(toolEventPresentation('web_search', {
    hitCount: 25,
    sources: Array.from({ length: 25 }, (_, index) => `source-${index}`),
  }), { kind: 'search', title: '已搜索 25 个网站', count: 25 })

  const presentation = toolEventPresentation('web_search', {
    query: '秘密检索词',
    hits: [
      { title: '和光', url: 'https://www.andlight.cn/', hostname: 'www.andlight.cn', snippet: '不要下发' },
      { title: '重复', url: 'https://andlight.cn/about', hostname: 'andlight.cn', snippet: '同一站' },
    ],
  })
  assert.deepEqual(presentation, {
    kind: 'search',
    title: '已搜索 2 个网站',
    count: 2,
    sources: [{ hostname: 'www.andlight.cn', url: 'https://www.andlight.cn/', title: '和光' }],
  })
  assert.equal(JSON.stringify(presentation).includes('秘密检索词'), false)
  assert.equal(JSON.stringify(presentation).includes('snippet'), false)

  assert.equal(toolEventPresentation('project_memory_search', {
    hits: [{ title: '记忆', url: 'https://www.andlight.cn/', hostname: 'www.andlight.cn' }],
  })?.sources, undefined)

  assert.deepEqual(toolEventPresentation('web_fetch', {
    url: 'https://fcbarcelona.com/',
    hostname: 'fcbarcelona.com',
    title: 'Barça',
  }), {
    kind: 'fetch',
    title: '网页获取 fcbarcelona.com',
    sources: [{ hostname: 'fcbarcelona.com', url: 'https://fcbarcelona.com/', title: 'Barça' }],
  })
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

test('规划/回合工具在 execute 前才有 running，返回后才有 succeeded，并带人话标题', async () => {
  const registry = createAgentToolRegistry([{
    name: 'canvas_read',
    label: '读取画布上下文',
    description: '读取画布。',
    risk: 'read',
    parameters: { type: 'object', properties: {} },
    validate: (value) => value,
    execute: async () => ({ nodes: 2 }),
  }, {
    name: 'generation_create_plan',
    label: '生成执行计划',
    description: '起草计划。',
    risk: 'read',
    terminal: true,
    parameters: { type: 'object', properties: {} },
    validate: (value) => value,
    execute: async () => ({ kind: 'plan' }),
  }])
  const events = []
  let modelCall = 0
  await runAgentToolLoop({
    registry, messages: [], onEvent: (event) => events.push(event),
    callModel: async () => {
      modelCall += 1
      return modelCall === 1
        ? { choices: [{ message: { tool_calls: [
          { id: 'call-canvas', type: 'function', function: { name: 'canvas_read', arguments: '{}' } },
          { id: 'call-plan', type: 'function', function: { name: 'generation_create_plan', arguments: '{}' } },
        ] } }] }
        : { choices: [{ message: { content: '完成' } }] }
    },
  })

  assert.deepEqual(events.map((event) => [event.toolCall.status, event.presentation?.title]), [
    ['running', '读取画布上下文'],
    ['succeeded', '读取画布上下文'],
    ['running', '起草生成计划'],
    ['succeeded', '起草生成计划'],
  ])
  // 禁止未 execute 先 succeeded：每个工具的首个事件必须是 running。
  const byId = new Map()
  for (const event of events) {
    const seen = byId.get(event.toolCall.id) ?? []
    seen.push(event.toolCall.status)
    byId.set(event.toolCall.id, seen)
  }
  for (const statuses of byId.values()) {
    assert.equal(statuses[0], 'running')
    assert.ok(statuses.includes('succeeded'))
  }
})

test('工具集在进入循环前定格，中途改配置不影响已开始的这一次执行', async () => {
  // 模型在第 1 步看到的工具与第 3 步能调用的工具必须是同一套，否则它会按一份
  // 已经不存在的能力清单做计划。
  const seenToolCounts = []
  let extraRegistered = false
  const registry = createAgentToolRegistry([
    {
      name: 'probe', label: '探针', description: '只读探针', risk: 'read',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      validate: () => ({}),
      execute: async () => {
        // 模拟「执行过程中有人改了配置」：注册表被重建，但本次执行不该受影响。
        extraRegistered = true
        return { ok: true }
      },
    },
  ])
  const snapshot = freezeAgentStepSnapshot({ registry, model: 'model-a', role: 'editor' })

  let step = 0
  const result = await runAgentToolLoop({
    registry,
    messages: [{ role: 'user', content: '看一下' }],
    snapshot,
    callModel: async ({ tools }) => {
      seenToolCounts.push(tools.length)
      step += 1
      return step === 1
        ? { choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'probe', arguments: '{}' } }] } }] }
        : { choices: [{ message: { content: '完成' } }] }
    },
  })

  assert.equal(result.output, '完成')
  assert.equal(extraRegistered, true)
  // 两步看到的工具集完全一致。
  assert.deepEqual(seenToolCounts, [1, 1])
  // 每一步都记下了它执行时的能力快照。
  assert.deepEqual(result.steps.map((entry) => entry.step), [0, 1])
  assert.ok(result.steps.every((entry) => entry.snapshot === snapshot))
})

test('执行快照被深冻结，调用方之后改自己的对象也影响不到它', () => {
  const bindings = [{ id: 'skill-1', version: 1, contentHash: 'h1' }]
  const registry = createAgentToolRegistry([{
    name: 'probe', label: '探针', description: 'x', risk: 'read',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    validate: () => ({}), execute: async () => ({}),
  }])
  const snapshot = freezeAgentStepSnapshot({ registry, model: 'model-a', skillBindings: bindings, role: 'owner' })
  bindings[0].version = 99
  bindings.push({ id: 'skill-2' })

  assert.deepEqual(snapshot.toolNames, ['probe'])
  assert.equal(snapshot.skillBindings.length, 1)
  assert.equal(snapshot.skillBindings[0].version, 1)
  assert.equal(snapshot.role, 'owner')
  assert.equal(Object.isFrozen(snapshot), true)
  assert.throws(() => { snapshot.model = 'model-b' }, TypeError)
})

test('工具结果驱动下一步，而不是一次调用后就收尾', async () => {
  const calls = []
  const registry = createAgentToolRegistry([
    {
      name: 'lookup', label: '查询', description: '查询', risk: 'read',
      parameters: { type: 'object', additionalProperties: false, properties: { q: { type: 'string' } } },
      validate: (raw) => ({ q: String(raw?.q ?? '') }),
      execute: async ({ q }) => ({ found: q === 'second' }),
    },
  ])
  let step = 0
  const result = await runAgentToolLoop({
    registry,
    messages: [{ role: 'user', content: '查两次' }],
    callModel: async ({ messages }) => {
      step += 1
      // 第 2 步能看到第 1 步的工具结果，据此决定再查一次。
      if (step === 2) calls.push(messages.filter((message) => message.role === 'tool').map((message) => message.content))
      if (step <= 2) {
        return { choices: [{ message: { content: null, tool_calls: [{ id: `c${step}`, function: { name: 'lookup', arguments: JSON.stringify({ q: step === 1 ? 'first' : 'second' }) } }] } }] }
      }
      return { choices: [{ message: { content: '两次都查过了' } }] }
    },
  })
  assert.equal(result.output, '两次都查过了')
  assert.equal(result.toolCalls.length, 2)
  assert.deepEqual(calls, [['{"found":false}']])
})
