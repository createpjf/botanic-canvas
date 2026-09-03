import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentToolRuntimeError, createAgentToolRegistry, executeConfirmedAgentAction, freezeAgentStepSnapshot, runAgentToolLoop, toolEventPresentation } from './agentToolRuntime.mjs'
import { estimateAgentContextTokens } from '../context/agentContextBudget.mjs'

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

test('未提供 Model Context 时保持 legacy callModel 请求形状', async () => {
  const registry = createAgentToolRegistry([])
  let request
  const result = await runAgentToolLoop({
    registry,
    messages: [{ role: 'user', content: '你好' }],
    callModel: async (input) => {
      request = input
      return { choices: [{ message: { role: 'assistant', content: '你好' } }] }
    },
  })

  assert.equal(result.output, '你好')
  assert.deepEqual(Object.keys(request), ['messages', 'tools', 'tool_choice', 'step'])
  assert.deepEqual(request, {
    messages: [{ role: 'user', content: '你好' }],
    tools: [],
    tool_choice: 'auto',
    step: 0,
  })
})

test('无工具终态在写 Checkpoint 前拒绝空白或超长 Provider 回答', async () => {
  const registry = createAgentToolRegistry([])
  for (const content of ['   ', 'x'.repeat(12_001)]) {
    const checkpoints = []
    await assert.rejects(runAgentToolLoop({
      registry,
      messages: [{ role: 'user', content: '继续' }],
      attempt: { id: 'attempt-invalid-output', model: 'model-a', snapshotHash: 'hash-invalid-output' },
      saveCheckpoint: async (checkpoint) => { checkpoints.push(checkpoint) },
      callModel: async () => ({ choices: [{ message: { content } }] }),
    }), (caught) => caught?.code === 'INVALID_PROVIDER_RESPONSE' && caught?.statusCode === 502)
    assert.equal(checkpoints.length, 0)
  }
})

test('Model Context 每步 prepare，模型响应后 observe 归一化 usage', async () => {
  const registry = createAgentToolRegistry([{
    name: 'probe', label: '探针', description: '读取探针。', risk: 'read',
    parameters: { type: 'object', properties: {} },
    validate: (value) => value,
    execute: async () => ({ ok: true }),
  }])
  const attempt = { id: 'attempt-context-1' }
  const order = []
  const prepareInputs = []
  const modelRequests = []
  const observations = []
  const preparedValues = [{ key: 'prepared-0' }, { key: 'prepared-1' }]
  const modelContext = {
    prepare: async (input) => {
      order.push(`prepare:${input.step}`)
      prepareInputs.push(input)
      if (input.step === 0) {
        return {
          messages: [...input.messages, { role: 'system', content: 'prepared-step-0' }],
          tools: input.tools.map((tool) => ({ ...tool, preparedForStep: 0 })),
          prepared: preparedValues[0],
        }
      }
      return { prepared: preparedValues[1] }
    },
    observe: async (input) => {
      order.push(`observe:${input.step}`)
      observations.push(input)
    },
  }
  let modelCall = 0
  const result = await runAgentToolLoop({
    registry,
    messages: [{ role: 'user', content: '检查' }],
    attempt,
    maxOutputTokens: 512,
    modelContext,
    callModel: async (request) => {
      order.push(`model:${request.step}`)
      modelRequests.push(request)
      modelCall += 1
      return modelCall === 1
        ? {
            choices: [{ message: { tool_calls: [{
              id: 'call-context-probe', type: 'function', function: { name: 'probe', arguments: '{}' },
            }] } }],
            usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, raw: '不透传' },
          }
        : {
            choices: [{ message: { content: '完成' } }],
            usage: { input_tokens: 20, output_tokens: 4 },
          }
    },
  })

  assert.equal(result.output, '完成')
  assert.deepEqual(order, [
    'prepare:0', 'model:0', 'observe:0',
    'prepare:1', 'model:1', 'observe:1',
  ])
  assert.equal(prepareInputs[0].attempt, attempt)
  assert.equal(prepareInputs[0].maxOutputTokens, 512)
  assert.equal(prepareInputs[0].trigger, 'pre_step')
  assert.equal(modelRequests[0].messages.at(-1).content, 'prepared-step-0')
  assert.equal(modelRequests[0].tools[0].preparedForStep, 0)
  assert.equal(modelRequests[1].messages, prepareInputs[1].messages)
  assert.equal(modelRequests[1].tools, prepareInputs[1].tools)
  assert.equal(observations[0].prepared, preparedValues[0])
  assert.equal(observations[1].prepared, preparedValues[1])
  assert.deepEqual(observations.map((entry) => entry.responseUsage), [
    { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
    { inputTokens: 20, outputTokens: 4, totalTokens: 24 },
  ])
  assert.equal('response' in observations[0], false)
})

test('Model Context 在明确 overflow 后强制 prepare，并只重试同一步一次', async () => {
  const registry = createAgentToolRegistry([])
  const preparations = []
  const requests = []
  const observations = []
  const overflow = new Error('context overflow')
  overflow.code = 'AGENT_CONTEXT_OVERFLOW'
  const result = await runAgentToolLoop({
    registry,
    messages: [{ role: 'user', content: '很长的请求' }],
    maxOutputTokens: 3000,
    modelContext: {
      prepare: async (input) => {
        preparations.push(input)
        if (input.force === true) {
          return {
            changed: true,
            messages: [{ role: 'user', content: '强制压缩后的请求' }],
            prepared: 'overflow-prepared',
          }
        }
        return { prepared: 'initial-prepared' }
      },
      observe: async (input) => { observations.push(input) },
    },
    callModel: async (request) => {
      requests.push(request)
      if (requests.length === 1) throw overflow
      return {
        choices: [{ message: { content: '完成' } }],
        usage: { prompt_tokens: 8, completion_tokens: 2 },
      }
    },
  })

  assert.equal(result.output, '完成')
  assert.equal(requests.length, 2)
  assert.deepEqual(requests.map((request) => request.step), [0, 0])
  assert.equal(requests[1].messages[0].content, '强制压缩后的请求')
  assert.equal(preparations[0].trigger, 'pre_step')
  assert.equal(Object.hasOwn(preparations[0], 'force'), false)
  assert.equal(preparations[1].trigger, 'overflow')
  assert.equal(preparations[1].force, true)
  assert.equal(preparations[1].maxOutputTokens, 3000)
  assert.deepEqual(observations, [{
    attempt: undefined,
    step: 0,
    prepared: 'overflow-prepared',
    responseUsage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
  }])
})

test('Model Context overflow 未产生变化或重试仍失败时不继续请求', async () => {
  const overflow = () => Object.assign(new Error('context overflow'), { code: 'AGENT_CONTEXT_OVERFLOW' })
  for (const scenario of ['unchanged', 'retry_failed']) {
    let modelCalls = 0
    let observes = 0
    const forcedPreparations = []
    await assert.rejects(runAgentToolLoop({
      registry: createAgentToolRegistry([]),
      messages: [{ role: 'user', content: scenario }],
      modelContext: {
        prepare: async (input) => {
          if (input.force) forcedPreparations.push(input)
          return input.force
            ? { changed: scenario === 'retry_failed', prepared: 'forced' }
            : { prepared: 'initial' }
        },
        observe: async () => { observes += 1 },
      },
      callModel: async () => {
        modelCalls += 1
        throw overflow()
      },
    }), (error) => error?.code === 'AGENT_CONTEXT_OVERFLOW')

    assert.equal(modelCalls, scenario === 'unchanged' ? 1 : 2, scenario)
    assert.equal(forcedPreparations.length, 1, scenario)
    assert.equal(observes, 0, scenario)
  }
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
    (caught) => /需要用户确认/u.test(caught?.message) && caught?.outcomeKnown === true,
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

test('确认后的 terminal/write 工具只返回 allowlist 固定路径上的业务引用', async () => {
  const registry = createAgentToolRegistry([{
    name: 'generation_submit', label: '提交生成任务', description: '提交生成任务。',
    risk: 'costly', requiresConfirmation: true, terminal: true,
    parameters: { type: 'object', properties: {} },
    validate: (value) => value,
    execute: async () => ({
      run: { id: 'run-submit' },
      jobIds: ['job-submit-1', 'job-submit-2'],
      rawOutput: { artifactId: 'artifact-forged-raw' },
    }),
  }])
  const action = await executeConfirmedAgentAction({
    registry, name: 'generation_submit', arguments: {},
    toolCallId: 'call-generation-submit', confirmed: true,
  })
  const expected = [
    { type: 'agent_run', id: 'run-submit' },
    { type: 'generation_job', id: 'job-submit-1' },
    { type: 'generation_job', id: 'job-submit-2' },
  ]
  assert.deepEqual(action.entityReferences, expected)
  assert.deepEqual(action.toolCall.entityReferences, expected)
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
  const result = await runAgentToolLoop({
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

  let quotaModelCalls = 0
  const quotaRegistry = createAgentToolRegistry([{
    name: 'web_search', label: '网页搜索', description: '搜索公开网页。', risk: 'external',
    parameters: { type: 'object', properties: {} }, validate: (value) => value,
    execute: async () => { throw new AgentToolRuntimeError('WEB_QUOTA_EXCEEDED', '联网额度已用完。', 429) },
  }])
  await assert.rejects(runAgentToolLoop({
    registry: quotaRegistry,
    messages: [],
    callModel: async () => {
      quotaModelCalls += 1
      return { choices: [{ message: { tool_calls: [{
        id: 'call-quota', type: 'function', function: { name: 'web_search', arguments: '{}' },
      }] } }] }
    },
  }), (caught) => caught.code === 'WEB_QUOTA_EXCEEDED')
  assert.equal(quotaModelCalls, 1, '配额错误不得回给模型继续重试')
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
    execute: async (_value, context) => {
      context.reportProgress({ summary: '已读取 2 个节点', presentation: { kind: 'read', title: '读取画布上下文', count: 2 } })
      return { nodes: 2 }
    },
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

  assert.deepEqual(events.map((event) => [event.toolCall.status, event.presentation?.title, event.toolCall.summary]), [
    ['running', '读取画布上下文', undefined],
    ['running', '读取画布上下文', '已读取 2 个节点'],
    ['succeeded', '读取画布上下文', undefined],
    ['running', '起草生成计划', undefined],
    ['succeeded', '起草生成计划', undefined],
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

test('执行快照被深冻结，并绑定 Model Context Policy 哈希', () => {
  const bindings = [{ id: 'skill-1', version: 1, contentHash: 'h1' }]
  const parameters = { type: 'object', additionalProperties: false, properties: { query: { type: 'string' } } }
  const registry = createAgentToolRegistry([{
    name: 'probe', label: '探针', description: 'x', risk: 'read',
    parameters,
    validate: () => ({}), execute: async () => ({}),
  }])
  const snapshot = freezeAgentStepSnapshot({
    registry,
    model: 'model-a',
    skillBindings: bindings,
    contextPolicyHash: 'policy-hash-1',
    role: 'owner',
  })
  bindings[0].version = 99
  bindings.push({ id: 'skill-2' })
  parameters.properties.query.type = 'number'

  assert.deepEqual(snapshot.toolNames, ['probe'])
  assert.equal(snapshot.toolBindings.length, 1)
  assert.equal(snapshot.toolBindings[0].name, 'probe')
  assert.equal(snapshot.toolBindings[0].recovery, 'reexecute')
  assert.equal(Object.isFrozen(snapshot.toolBindings), true)
  assert.equal(Object.isFrozen(snapshot.toolBindings[0]), true)
  assert.equal(registry.openAITools()[0].function.parameters.properties.query.type, 'string')
  assert.equal(snapshot.skillBindings.length, 1)
  assert.equal(snapshot.skillBindings[0].version, 1)
  assert.equal(snapshot.contextPolicyHash, 'policy-hash-1')
  assert.equal(snapshot.role, 'owner')
  assert.equal(Object.isFrozen(snapshot), true)
  assert.throws(() => { snapshot.model = 'model-b' }, TypeError)
  assert.equal(Object.hasOwn(freezeAgentStepSnapshot({ registry }), 'contextPolicyHash'), false)
})

test('能力快照绑定工具 schema 与治理声明，而不只记录工具名', () => {
  const registryFor = (type, recovery = 'reexecute') => createAgentToolRegistry([{
    name: 'probe', label: '探针', description: '读取探针。', risk: 'read', recovery,
    parameters: { type: 'object', properties: { query: { type } } },
    validate: () => ({}), execute: async () => ({}),
  }])
  const original = freezeAgentStepSnapshot({ registry: registryFor('string'), model: 'model-a' })
  const schemaChanged = freezeAgentStepSnapshot({ registry: registryFor('number'), model: 'model-a' })
  const recoveryChanged = freezeAgentStepSnapshot({ registry: registryFor('string', 'never'), model: 'model-a' })

  assert.notEqual(original.toolBindings[0].contentHash, schemaChanged.toolBindings[0].contentHash)
  assert.notEqual(original.toolBindings[0].contentHash, recoveryChanged.toolBindings[0].contentHash)
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

test('单个工具长输出受 token 上限约束，仅保留稳定回读指针与内容哈希', async () => {
  const registry = createAgentToolRegistry([{
    name: 'artifact_lookup', label: '读取产出', description: '读取稳定产出。', risk: 'read',
    parameters: { type: 'object', properties: { artifactId: { type: 'string' } } },
    validate: (value) => value,
    execute: async () => ({
      artifactId: 'artifact-stable-1', runId: 'run-stable-1',
      payload: '长'.repeat(12_000),
    }),
  }])
  let modelCall = 0
  let projected

  const result = await runAgentToolLoop({
    registry, messages: [{ role: 'user', content: '回读产出' }], maximumSteps: 2,
    callModel: async ({ messages }) => {
      modelCall += 1
      if (modelCall === 1) {
        return { choices: [{ message: { tool_calls: [{
          id: 'call-artifact-1', type: 'function', function: {
            name: 'artifact_lookup', arguments: '{"artifactId":"artifact-stable-1"}',
          },
        }] } }] }
      }
      projected = structuredClone(messages)
      return { choices: [{ message: { content: '完成' } }] }
    },
  })

  const assistant = projected.at(-2)
  const tool = projected.at(-1)
  assert.equal(assistant.tool_calls[0].id, 'call-artifact-1')
  assert.equal(tool.role, 'tool')
  assert.equal(tool.tool_call_id, 'call-artifact-1')
  assert.ok(estimateAgentContextTokens(tool.content) <= 2_000)
  const envelope = JSON.parse(tool.content)
  assert.equal(envelope._botanicTruncation.truncated, true)
  assert.equal(envelope._botanicTruncation.reread.tool, 'artifact_lookup')
  assert.equal(envelope._botanicTruncation.reread.source, 'preceding_assistant_tool_call')
  assert.match(envelope._botanicTruncation.contentHash, /^[A-Za-z0-9_-]{43}$/u)
  assert.equal('references' in envelope._botanicTruncation, false, '未经工具+路径 allowlist 不派生业务引用')
  assert.ok(envelope._botanicTruncation.omittedCharacters > 0)
  assert.deepEqual(result.entityReferences, [])
  assert.equal('entityReferences' in result.toolCalls[0], false)
})

test('显式工具引用进入 completed Checkpoint 与 Turn 聚合，terminal 恢复不重执行也不漂移', async () => {
  let persisted
  let modelCalls = 0
  let executions = 0
  const registry = createAgentToolRegistry([{
    name: 'artifact_search', label: '检索历史结果', description: '检索结果。', risk: 'read',
    parameters: { type: 'object', properties: {} },
    validate: (value) => value,
    execute: async () => {
      executions += 1
      return {
        artifacts: Array.from({ length: 12 }, (_, index) => ({
          id: `artifact-${index + 1}`,
          ...(index === 0 ? {
            provenance: { runId: 'run-1' },
            prompt: { artifactId: 'artifact-forged-prompt' },
          } : {}),
        })),
        rawOutput: { jobId: 'job-forged-raw' },
      }
    },
  }])
  const first = await runAgentToolLoop({
    registry,
    messages: [{ role: 'user', content: '查历史结果' }],
    attempt: checkpointAttempt,
    saveCheckpoint: async (checkpoint) => { persisted = structuredClone(checkpoint) },
    callModel: async () => {
      modelCalls += 1
      return modelCalls === 1
        ? { choices: [{ message: { tool_calls: [{
          id: 'call-artifact-search', type: 'function', function: {
            name: 'artifact_search', arguments: '{}',
          },
        }] } }] }
        : { choices: [{ message: { content: '已找到历史结果。' } }] }
    },
  })

  const expected = Array.from({ length: 8 }, (_, index) => ({
    type: 'artifact', id: `artifact-${index + 1}`,
  }))
  assert.deepEqual(first.entityReferences, expected)
  assert.deepEqual(first.toolCalls[0].entityReferences, expected)
  assert.deepEqual(persisted.completedSteps[0].calls[0].entityReferences, expected)
  assert.equal(persisted.terminalContent, '已找到历史结果。')

  const resumed = await runAgentToolLoop({
    registry,
    messages: [{ role: 'user', content: '查历史结果' }],
    attempt: checkpointAttempt,
    resumeCheckpoint: persisted,
    saveCheckpoint: async () => { throw new Error('terminal 恢复不应再写 checkpoint') },
    callModel: async () => { throw new Error('terminal 恢复不应再调模型') },
  })
  assert.deepEqual(resumed.entityReferences, expected)
  assert.equal(executions, 1)
  assert.equal(modelCalls, 2)
})

test('多个工具输出共享累计预算，每个 assistant tool_call 仍有唯一配对 tool message', async () => {
  const registry = createAgentToolRegistry([{
    name: 'bulk_lookup', label: '批量读取', description: '读取记录。', risk: 'read',
    parameters: { type: 'object', properties: { index: { type: 'number' } } },
    validate: (value) => value,
    execute: async ({ index }) => ({
      artifactId: `artifact-${index}`,
      payload: `${index}:${'数'.repeat(7_000)}`,
    }),
  }])
  let modelCall = 0
  let projected

  await runAgentToolLoop({
    registry, messages: [], maximumSteps: 2,
    callModel: async ({ messages }) => {
      modelCall += 1
      if (modelCall === 1) {
        return { choices: [{ message: { tool_calls: Array.from({ length: 6 }, (_, index) => ({
          id: `call-bulk-${index + 1}`, type: 'function', function: {
            name: 'bulk_lookup', arguments: JSON.stringify({ index: index + 1 }),
          },
        })) } }] }
      }
      projected = structuredClone(messages)
      return { choices: [{ message: { content: '完成' } }] }
    },
  })

  const assistant = projected.find((entry) => entry.role === 'assistant' && entry.tool_calls)
  const toolMessages = projected.filter((entry) => entry.role === 'tool')
  assert.equal(toolMessages.length, assistant.tool_calls.length)
  assert.deepEqual(
    toolMessages.map((entry) => entry.tool_call_id),
    assistant.tool_calls.map((entry) => entry.id),
  )
  assert.ok(toolMessages.every((entry) => estimateAgentContextTokens(entry.content) <= 2_000))
  assert.ok(toolMessages.reduce((sum, entry) => sum + estimateAgentContextTokens(entry.content), 0) <= 6_000)
  assert.ok(toolMessages.some((entry) => JSON.parse(entry.content)._botanicTruncation.reason === 'cumulative_budget'))
})

const checkpointAttempt = Object.freeze({
  id: 'turn-attempt-1',
  model: 'planner-model',
  snapshotHash: 'snapshot-hash-1',
})

test('Registry 按工具能力推导 recovery，并拒绝未知恢复模式', () => {
  const registry = createAgentToolRegistry([{
    name: 'read_default', label: '默认只读', description: '读取', risk: 'read',
    parameters: { type: 'object', properties: {} }, validate: (value) => value, execute: async () => ({}),
  }, {
    name: 'write_default', label: '默认写入', description: '写入', risk: 'write',
    parameters: { type: 'object', properties: {} }, validate: (value) => value, execute: async () => ({}),
  }, {
    name: 'receipt_action', label: '回执行动', description: '写入', risk: 'external', recovery: 'receipt',
    receipt: ({ id }) => ({ receiptId: `receipt-${id}`, intentHash: `intent-${id}` }),
    parameters: { type: 'object', properties: {} }, validate: (value) => value, execute: async () => ({}),
  }])

  assert.equal(registry.get('read_default').recovery, 'reexecute')
  assert.equal(registry.get('write_default').recovery, 'never')
  assert.equal(registry.get('receipt_action').recovery, 'receipt')
  assert.throws(() => createAgentToolRegistry([{
    name: 'bad_recovery', label: '无效', description: '无效', risk: 'read', recovery: 'sometimes',
    parameters: { type: 'object', properties: {} }, validate: (value) => value, execute: async () => ({}),
  }]), /recovery/u)
})

test('prepared Checkpoint 持久化失败时一个工具也不执行', async () => {
  let executed = 0
  let prepared
  const registry = createAgentToolRegistry([{
    name: 'read_before_effect', label: '读取', description: '读取', risk: 'read',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
    validate: (value) => value,
    execute: async () => { executed += 1; return { ok: true } },
  }])

  await assert.rejects(runAgentToolLoop({
    registry,
    messages: [],
    attempt: checkpointAttempt,
    saveCheckpoint: async (checkpoint) => {
      prepared = structuredClone(checkpoint)
      throw new Error('checkpoint store unavailable')
    },
    callModel: async () => ({ choices: [{ message: { tool_calls: [{
      id: 'call-before-effect', type: 'function', function: {
        name: 'read_before_effect', arguments: '{"query":"context"}',
      },
    }] } }] }),
  }), /checkpoint store unavailable/u)

  assert.equal(executed, 0)
  assert.equal(prepared.pendingStep.calls[0].recovery, 'reexecute')
  assert.deepEqual(prepared.pendingStep.calls[0].arguments, { query: 'context' })
})

test('同一步全部 call 校验通过前不执行前面的工具', async () => {
  let firstExecuted = 0
  let checkpointWrites = 0
  const registry = createAgentToolRegistry([{
    name: 'valid_first', label: '第一个工具', description: '只读', risk: 'read',
    parameters: { type: 'object', properties: {} }, validate: (value) => value,
    execute: async () => { firstExecuted += 1; return { ok: true } },
  }, {
    name: 'invalid_second', label: '第二个工具', description: '只读', risk: 'read',
    parameters: { type: 'object', properties: {} },
    validate: () => { throw new AgentToolRuntimeError('INVALID_TOOL_ARGUMENTS', '第二个调用无效。') },
    execute: async () => ({ ok: true }),
  }])

  await assert.rejects(runAgentToolLoop({
    registry,
    messages: [],
    attempt: checkpointAttempt,
    saveCheckpoint: async () => { checkpointWrites += 1 },
    callModel: async () => ({ choices: [{ message: { tool_calls: [{
      id: 'call-valid-first', type: 'function', function: { name: 'valid_first', arguments: '{}' },
    }, {
      id: 'call-invalid-second', type: 'function', function: { name: 'invalid_second', arguments: '{}' },
    }] } }] }),
  }), (caught) => caught?.code === 'INVALID_TOOL_ARGUMENTS' && caught?.outcomeKnown === true)

  assert.equal(firstExecuted, 0)
  assert.equal(checkpointWrites, 0, '坏 call 不得进入 prepared checkpoint')
})

test('completed Checkpoint 恢复时不重复调用已完成步骤的模型', async () => {
  let persisted
  let modelCalls = 0
  let executions = 0
  const firstEvents = []
  const registry = createAgentToolRegistry([{
    name: 'resume_read', label: '恢复读取', description: '读取', risk: 'read',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
    validate: (value) => value,
    execute: async ({ query }) => { executions += 1; return { query, version: executions } },
  }])

  await assert.rejects(runAgentToolLoop({
    registry,
    messages: [{ role: 'user', content: '继续' }],
    attempt: checkpointAttempt,
    onEvent: (event) => firstEvents.push(event),
    saveCheckpoint: async (checkpoint) => {
      persisted = structuredClone(checkpoint)
      if (checkpoint.completedSteps.length === 1 && !checkpoint.pendingStep) {
        throw new Error('process crashed after durable complete')
      }
    },
    callModel: async ({ step }) => {
      modelCalls += 1
      assert.equal(step, 0)
      return { choices: [{ message: { tool_calls: [{
        id: 'call-resume-read', type: 'function', function: {
          name: 'resume_read', arguments: '{"query":"canvas"}',
        },
      }] } }] }
    },
  }), /process crashed/u)

  const resumedEvents = []
  const result = await runAgentToolLoop({
    registry,
    messages: [{ role: 'user', content: '继续' }],
    attempt: checkpointAttempt,
    resumeCheckpoint: persisted,
    saveCheckpoint: async (checkpoint) => { persisted = structuredClone(checkpoint) },
    onEvent: (event) => resumedEvents.push(event),
    callModel: async ({ step, messages }) => {
      modelCalls += 1
      assert.equal(step, 1)
      assert.equal(messages.at(-1).role, 'tool')
      assert.match(messages.at(-1).content, /canvas/u)
      return { choices: [{ message: { content: '恢复完成。' } }] }
    },
  })

  assert.equal(result.output, '恢复完成。')
  assert.equal(modelCalls, 2, '恢复时只调用下一步模型')
  assert.equal(executions, 2, '只读工具为重建内存对话可重执行')
  assert.deepEqual(firstEvents.map((event) => event.toolCall.status), ['running', 'succeeded'])
  assert.deepEqual(resumedEvents, [], '重建已完成步骤不重复推送工具事件')
  assert.equal(persisted.terminalContent, '恢复完成。')
})

test('工具调用预算包含 completed Checkpoint 已消费的调用', async () => {
  let executions = 0
  let modelCalls = 0
  const registry = createAgentToolRegistry([{
    name: 'budgeted_resume_read', label: '预算内恢复读取', description: '读取', risk: 'read',
    parameters: { type: 'object', properties: {} }, validate: (value) => value,
    execute: async () => { executions += 1; return { ok: true } },
  }])
  const checkpoint = {
    version: 1,
    attempt: checkpointAttempt,
    completedSteps: [{
      step: 0,
      calls: [{
        id: 'call-already-spent', name: 'budgeted_resume_read', risk: 'read',
        recovery: 'reexecute', terminal: false, arguments: {},
      }],
    }],
  }

  await assert.rejects(runAgentToolLoop({
    registry,
    messages: [],
    maximumSteps: 3,
    maximumToolCalls: 1,
    attempt: checkpointAttempt,
    resumeCheckpoint: checkpoint,
    saveCheckpoint: async () => {},
    callModel: async () => {
      modelCalls += 1
      return { choices: [{ message: { tool_calls: [{
        id: 'call-over-budget', type: 'function',
        function: { name: 'budgeted_resume_read', arguments: '{}' },
      }] } }] }
    },
  }), (error) => error?.code === 'TOOL_CALL_LIMIT_REACHED' && error?.outcomeKnown === true)

  assert.equal(executions, 1, '已完成只读步骤只为上下文重建执行一次')
  assert.equal(modelCalls, 1)
})

test('terminal Checkpoint 恢复时直接返回最终回答，不再调用模型', async () => {
  let persisted
  let modelCalls = 0
  const registry = createAgentToolRegistry([])
  const first = await runAgentToolLoop({
    registry,
    messages: [{ role: 'user', content: '你好' }],
    attempt: checkpointAttempt,
    saveCheckpoint: async (checkpoint) => { persisted = structuredClone(checkpoint) },
    callModel: async () => {
      modelCalls += 1
      return { choices: [{ message: { content: '已经完成。' } }] }
    },
  })
  const resumed = await runAgentToolLoop({
    registry,
    messages: [{ role: 'user', content: '你好' }],
    attempt: checkpointAttempt,
    resumeCheckpoint: persisted,
    saveCheckpoint: async () => { throw new Error('终态恢复不应再写 checkpoint') },
    callModel: async () => { throw new Error('终态恢复不应再调模型') },
  })

  assert.equal(first.output, '已经完成。')
  assert.equal(resumed.output, '已经完成。')
  assert.equal(modelCalls, 1)
})

test('receipt 步骤恢复只读持久化回执，绝不调用原工具 executor', async () => {
  let persisted
  let originalExecutions = 0
  let recoveryCalls = 0
  let modelCalls = 0
  const registry = createAgentToolRegistry([{
    name: 'receipt_write', label: '外部写入', description: '外部写入', risk: 'external',
    recovery: 'receipt', terminal: true,
    receipt: ({ id, arguments: argumentsValue }) => ({
      receiptId: `receipt-${id}`,
      intentHash: `intent-${argumentsValue.target}`,
    }),
    parameters: { type: 'object', properties: { target: { type: 'string' } } },
    validate: (value) => value,
    execute: async () => { originalExecutions += 1; return { externalId: 'should-not-run' } },
  }])

  await assert.rejects(runAgentToolLoop({
    registry,
    messages: [],
    attempt: checkpointAttempt,
    saveCheckpoint: async (checkpoint) => {
      persisted = structuredClone(checkpoint)
      if (checkpoint.pendingStep) throw new Error('crash after prepared')
    },
    callModel: async () => {
      modelCalls += 1
      return { choices: [{ message: { tool_calls: [{
        id: 'call-receipt', type: 'function', function: {
          name: 'receipt_write', arguments: '{"target":"page-1"}',
        },
      }] } }] }
    },
  }), /crash after prepared/u)

  const result = await runAgentToolLoop({
    registry,
    messages: [],
    attempt: checkpointAttempt,
    resumeCheckpoint: persisted,
    saveCheckpoint: async (checkpoint) => { persisted = structuredClone(checkpoint) },
    recoverToolCall: async ({ toolCall }) => {
      recoveryCalls += 1
      assert.equal(toolCall.receiptId, 'receipt-call-receipt')
      assert.equal(toolCall.intentHash, 'intent-page-1')
      return { externalId: 'persisted-page-1' }
    },
    callModel: async () => { throw new Error('pending prepared 恢复不应重复调模型') },
  })

  assert.deepEqual(result.output, { externalId: 'persisted-page-1' })
  assert.equal(modelCalls, 1)
  assert.equal(originalExecutions, 0)
  assert.equal(recoveryCalls, 1)
  assert.equal(JSON.stringify(persisted).includes('persisted-page-1'), false, 'checkpoint 不保存工具输出')
})

test('receipt 无法在执行前解析可信身份时拒绝执行', async () => {
  let executed = 0
  const registry = createAgentToolRegistry([{
    name: 'receipt_missing', label: '缺少回执', description: '外部行动', risk: 'external', recovery: 'receipt',
    parameters: { type: 'object', properties: {} }, validate: (value) => value,
    execute: async () => { executed += 1; return { ok: true } },
  }])

  await assert.rejects(runAgentToolLoop({
    registry,
    messages: [],
    attempt: checkpointAttempt,
    saveCheckpoint: async () => {},
    callModel: async () => ({ choices: [{ message: { tool_calls: [{
      id: 'call-missing-receipt', type: 'function', function: { name: 'receipt_missing', arguments: '{}' },
    }] } }] }),
  }), (caught) => caught?.code === 'AGENT_TURN_CHECKPOINT_RECEIPT_REQUIRED')

  assert.equal(executed, 0)
})

test('receipt 身份解析器必须是无 I/O 的同步函数', async () => {
  let executed = 0
  const registry = createAgentToolRegistry([{
    name: 'receipt_async', label: '异步回执', description: '外部行动', risk: 'external', recovery: 'receipt',
    receipt: async () => ({ receiptId: 'receipt-async', intentHash: 'intent-async' }),
    parameters: { type: 'object', properties: {} }, validate: (value) => value,
    execute: async () => { executed += 1; return { ok: true } },
  }])

  await assert.rejects(runAgentToolLoop({
    registry,
    messages: [],
    attempt: checkpointAttempt,
    saveCheckpoint: async () => {},
    callModel: async () => ({ choices: [{ message: { tool_calls: [{
      id: 'call-async-receipt', type: 'function', function: { name: 'receipt_async', arguments: '{}' },
    }] } }] }),
  }), (caught) => caught?.code === 'AGENT_TURN_CHECKPOINT_RECEIPT_REQUIRED' && caught?.outcomeKnown === true)

  assert.equal(executed, 0)
})

test('never 步骤可以首次执行，但 prepared 恢复必须明确拒绝重放', async () => {
  let persisted
  let executed = 0
  let modelCalls = 0
  const registry = createAgentToolRegistry([{
    name: 'never_write', label: '不可重放写入', description: '写入', risk: 'write',
    parameters: { type: 'object', properties: {} }, validate: (value) => value,
    execute: async () => { executed += 1; return { ok: true } },
  }])

  await assert.rejects(runAgentToolLoop({
    registry,
    messages: [],
    attempt: checkpointAttempt,
    saveCheckpoint: async (checkpoint) => {
      persisted = structuredClone(checkpoint)
      if (checkpoint.pendingStep) throw new Error('crash before never executor')
    },
    callModel: async () => {
      modelCalls += 1
      return { choices: [{ message: { tool_calls: [{
        id: 'call-never', type: 'function', function: { name: 'never_write', arguments: '{}' },
      }] } }] }
    },
  }), /crash before never executor/u)
  assert.equal(executed, 0)

  await assert.rejects(runAgentToolLoop({
    registry,
    messages: [],
    attempt: checkpointAttempt,
    resumeCheckpoint: persisted,
    saveCheckpoint: async () => {},
    callModel: async () => { throw new Error('never 恢复不应调模型') },
  }), (caught) => caught?.code === 'AGENT_TURN_NOT_REPLAYABLE')

  assert.equal(modelCalls, 1)
  assert.equal(executed, 0)
})

test('同一工具同参数同输出连续 5 次以 TOOL_NO_PROGRESS 终止，第 3 次发警告', async () => {
  const registry = createAgentToolRegistry([{
    name: 'ontology_read',
    label: '读取本体',
    description: '读取项目本体。',
    risk: 'read',
    parameters: { type: 'object', additionalProperties: false, properties: { query: { type: 'string' } }, required: ['query'] },
    validate: (input) => ({ query: input.query }),
    execute: async () => ({ nodes: ['result-1'] }),
  }])
  const events = []
  let step = 0
  await assert.rejects(runAgentToolLoop({
    registry,
    messages: [],
    maximumSteps: 8,
    onEvent: (event) => events.push(event),
    callModel: async () => {
      step += 1
      return {
        choices: [{ message: {
          tool_calls: [{
            id: `call-same-${step}`,
            type: 'function',
            function: {
              name: 'ontology_read',
              // why 每次不同，不得绕过无进展签名。
              arguments: JSON.stringify({ query: '最近结果', why: `第 ${step} 次查看` }),
            },
          }],
        } }],
      }
    },
  }), (caught) => caught instanceof AgentToolRuntimeError && caught.code === 'TOOL_NO_PROGRESS')

  const warnings = events.filter((event) => event.presentation?.kind === 'no_progress')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0].toolCall.summary, /连续 3 次/)
  assert.equal(events.filter((event) => (
    event.toolCall?.status === 'succeeded' && event.presentation?.kind !== 'no_progress'
  )).length, 5)
})

test('无进展计数在参数变化后重置', async () => {
  const registry = createAgentToolRegistry([{
    name: 'ontology_read',
    label: '读取本体',
    description: '读取项目本体。',
    risk: 'read',
    parameters: { type: 'object', additionalProperties: false, properties: { query: { type: 'string' } }, required: ['query'] },
    validate: (input) => ({ query: input.query }),
    execute: async (input) => ({ nodes: [input.query] }),
  }])
  const events = []
  const queries = ['a', 'a', 'a', 'b', 'b', 'b']
  let step = 0
  const result = await runAgentToolLoop({
    registry,
    messages: [],
    maximumSteps: 8,
    onEvent: (event) => events.push(event),
    callModel: async () => {
      if (step >= queries.length) return { choices: [{ message: { content: '完成' } }] }
      const query = queries[step]
      step += 1
      return {
        choices: [{ message: {
          tool_calls: [{
            id: `call-${step}`,
            type: 'function',
            function: { name: 'ontology_read', arguments: JSON.stringify({ query }) },
          }],
        } }],
      }
    },
  })

  assert.equal(result.output, '完成')
  assert.equal(events.filter((event) => event.presentation?.kind === 'no_progress').length, 2)
  assert.equal(result.toolCalls.filter((call) => call.status === 'succeeded').length, 6)
})

test('根 signal 贯穿:hanging tool 收到取消后有界退出且第二个 call 不启动', async () => {
  const controller = new AbortController()
  let hangingSawAbort = false
  let secondStarted = false
  const registry = createAgentToolRegistry([
    {
      name: 'hanging_read', label: '挂起读取', risk: 'read',
      description: '测试用挂起工具。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      validate: () => ({}),
      execute: (_input, context) => new Promise((_resolve, reject) => {
        // 协作式消费根 signal:这就是 H2 的验收边界。
        assert.equal(typeof context.signal?.addEventListener, 'function')
        context.signal.addEventListener('abort', () => {
          hangingSawAbort = true
          reject(new Error('tool aborted'))
        }, { once: true })
      }),
    },
    {
      name: 'second_read', label: '第二读取', risk: 'read',
      description: '测试用第二工具。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      validate: () => ({}),
      execute: async () => { secondStarted = true; return { ok: true } },
    },
  ])
  const loop = runAgentToolLoop({
    registry,
    messages: [],
    maximumSteps: 3,
    signal: controller.signal,
    callModel: async () => ({
      choices: [{ message: { tool_calls: [
        { id: 'call-hang', type: 'function', function: { name: 'hanging_read', arguments: '{}' } },
        { id: 'call-second', type: 'function', function: { name: 'second_read', arguments: '{}' } },
      ] } }],
    }),
  })
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(loop, (caught) => caught.code === 'REQUEST_CANCELLED' && caught.statusCode === 499)
  assert.equal(hangingSawAbort, true, 'hanging tool 必须收到根 signal')
  assert.equal(secondStarted, false, '取消后第二个 call 不得启动')

  let modelSawDeadline = false
  await assert.rejects(runAgentToolLoop({
    registry,
    messages: [],
    deadlineAt: Date.now() + 20,
    callModel: (_input, runtime) => new Promise((_resolve, reject) => {
      runtime.signal.addEventListener('abort', () => {
        modelSawDeadline = true
        reject(new Error('model aborted'))
      }, { once: true })
    }),
  }), (caught) => caught.code === 'AGENT_TURN_DEADLINE_EXCEEDED' && caught.statusCode === 504)
  assert.equal(modelSawDeadline, true, 'deadline 必须主动中止 Provider')

  let toolSawDeadline = false
  const deadlineRegistry = createAgentToolRegistry([{
    name: 'deadline_read', label: '期限读取', risk: 'read', description: '测试期限工具。',
    parameters: { type: 'object', properties: {}, additionalProperties: false }, validate: () => ({}),
    execute: (_input, runtime) => new Promise((_resolve, reject) => {
      runtime.signal.addEventListener('abort', () => {
        toolSawDeadline = true
        reject(new Error('tool deadline'))
      }, { once: true })
    }),
  }])
  await assert.rejects(runAgentToolLoop({
    registry: deadlineRegistry,
    messages: [],
    deadlineAt: Date.now() + 20,
    callModel: async () => ({ choices: [{ message: { tool_calls: [{
      id: 'call-deadline', type: 'function', function: { name: 'deadline_read', arguments: '{}' },
    }] } }] }),
  }), (caught) => caught.code === 'AGENT_TURN_DEADLINE_EXCEEDED')
  assert.equal(toolSawDeadline, true, 'deadline 必须主动中止工具')
})

test('取消发生在模型调用前:归因为取消而非 Provider 错,模型不再被调用', async () => {
  const controller = new AbortController()
  controller.abort()
  let modelCalls = 0
  const registry = createAgentToolRegistry([{
    name: 'noop_read', label: '空读取', risk: 'read',
    description: '测试工具。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    validate: () => ({}), execute: async () => ({ ok: true }),
  }])
  await assert.rejects(
    runAgentToolLoop({
      registry, messages: [], signal: controller.signal,
      callModel: async () => { modelCalls += 1; return { choices: [{ message: { content: 'x' } }] } },
    }),
    (caught) => caught.code === 'REQUEST_CANCELLED' && caught.outcomeKnown === true,
  )
  assert.equal(modelCalls, 0)
})

test('第 N 个 action round 执行工具后仍有一次无工具最终综合,工具只执行一次且 checkpoint 可恢复', async () => {
  const registry = createAgentToolRegistry([{
    name: 'page_read', label: '分页读取', risk: 'read', recovery: 'reexecute',
    description: '测试读取。',
    parameters: { type: 'object', additionalProperties: false, properties: { page: { type: 'number' } }, required: ['page'] },
    validate: (input) => ({ page: input.page }),
    execute: async (input) => ({ page: input.page, rows: ['row-' + input.page] }),
  }])
  let toolRuns = 0
  const checkpoints = []
  const attempt = { id: 'attempt-h4', model: 'model-a', snapshotHash: 'hash-h4' }
  let synthesisRequest
  const result = await runAgentToolLoop({
    registry,
    messages: [],
    maximumSteps: 2,
    attempt,
    saveCheckpoint: async (checkpoint) => { checkpoints.push(structuredClone(checkpoint)) },
    callModel: async ({ tools: requestTools, tool_choice, step }) => {
      if (step < 2) {
        toolRuns += 1
        return { choices: [{ message: { tool_calls: [{
          id: 'call-' + step, type: 'function',
          function: { name: 'page_read', arguments: JSON.stringify({ page: step }) },
        }] } }] }
      }
      // budget 耗尽后的最终综合:无工具、tool_choice none。
      synthesisRequest = { tools: requestTools, tool_choice, step }
      return { choices: [{ message: { content: '综合:已读取 2 页。' } }] }
    },
  })
  assert.equal(result.output, '综合:已读取 2 页。')
  assert.deepEqual(synthesisRequest, { tools: [], tool_choice: 'none', step: 2 })
  assert.equal(result.toolCalls.filter((call) => call.status === 'succeeded').length, 2)
  const terminal = checkpoints.at(-1)
  assert.equal(terminal.terminalContent, '综合:已读取 2 页。')
  assert.equal(terminal.completedSteps.length, 2)
  // terminal checkpoint 可直接恢复,不再调模型、不重跑工具。
  const recovered = await runAgentToolLoop({
    registry,
    messages: [],
    maximumSteps: 2,
    attempt,
    resumeCheckpoint: terminal,
    saveCheckpoint: async () => { throw new Error('恢复 terminal 不应再写 checkpoint') },
    callModel: async () => { throw new Error('恢复 terminal 不应再调模型') },
  })
  assert.equal(recovered.output, '综合:已读取 2 页。')
})

test('preflight repair 一次配对结果,同签名第二次与 A/B 环都有界终止', async () => {
  const registry = createAgentToolRegistry([{
    name: 'flip_read', label: '翻转读取', risk: 'read',
    description: '测试。',
    parameters: { type: 'object', additionalProperties: false, properties: { key: { type: 'string' } }, required: ['key'] },
    validate: (input) => {
      if (typeof input.key !== 'string') throw new AgentToolRuntimeError('INVALID_TOOL_ARGUMENTS', 'key 无效。')
      return { key: input.key }
    },
    // volatile 字段(timestamp)不参与签名;A→B→A→B 输出构成环。
    execute: async (input) => ({ key: input.key, timestamp: Date.now() + Math.random() }),
  }])
  // 失败一:同一无效批第一次得到配对修复结果,第二次同签名直接终止。
  let invalidRounds = 0
  await assert.rejects(
    runAgentToolLoop({
      registry, messages: [], maximumSteps: 6,
      callModel: async () => {
        invalidRounds += 1
        return { choices: [{ message: { tool_calls: [
          { id: 'bad-' + invalidRounds, type: 'function', function: { name: 'flip_read', arguments: JSON.stringify({ key: 7 }) } },
          { id: 'ok-' + invalidRounds, type: 'function', function: { name: 'flip_read', arguments: JSON.stringify({ key: 'a' }) } },
        ] } }] }
      },
    }),
    (caught) => caught.code === 'INVALID_TOOL_ARGUMENTS',
  )
  assert.equal(invalidRounds, 2, '同签名批次只允许一次 repair round')

  // 失败二:A→B→A→B 双签名环在窗口内有界终止,不烧完步数。
  let cycleRounds = 0
  await assert.rejects(
    runAgentToolLoop({
      registry, messages: [], maximumSteps: 8,
      callModel: async () => {
        cycleRounds += 1
        const key = cycleRounds % 2 === 1 ? 'a' : 'b'
        return { choices: [{ message: { tool_calls: [{
          id: 'cycle-' + cycleRounds, type: 'function',
          function: { name: 'flip_read', arguments: JSON.stringify({ key }) },
        }] } }] }
      },
    }),
    (caught) => caught.code === 'TOOL_NO_PROGRESS',
  )
  assert.equal(cycleRounds, 4, 'A→B→A→B 在第 4 个重复签名处终止')
})

test('journal 恢复:post-result 崩溃后复用 durable envelope,fetch 只发生一次', async () => {
  let fetches = 0
  const registry = createAgentToolRegistry([{
    name: 'web_probe_read', label: '外部读取', risk: 'external', recovery: 'journal',
    description: '测试外部读取。',
    parameters: { type: 'object', additionalProperties: false, properties: { url: { type: 'string' } }, required: ['url'] },
    validate: (input) => ({ url: input.url }),
    execute: async (input) => { fetches += 1; return { url: input.url, text: '正文内容' } },
  }])
  const attempt = { id: 'attempt-j', model: 'model-a', snapshotHash: 'hash-j' }
  const checkpoints = []
  const call = { id: 'call-journal-1', type: 'function', function: { name: 'web_probe_read', arguments: JSON.stringify({ url: 'https://example.com/a' }) } }
  // 第一次执行:completed envelope durable 后、下一次模型调用前进程"崩溃"(模型抛错模拟)。
  await assert.rejects(runAgentToolLoop({
    registry, messages: [], maximumSteps: 2, attempt,
    saveCheckpoint: async (checkpoint) => { checkpoints.push(structuredClone(checkpoint)) },
    callModel: async ({ step }) => {
      if (step === 0) return { choices: [{ message: { tool_calls: [call] } }] }
      throw new Error('CRASH_BEFORE_NEXT_MODEL')
    },
  }))
  assert.equal(fetches, 1)
  const durable = checkpoints.at(-1)
  assert.equal(durable.version, 2)
  const journaled = durable.completedSteps[0].calls[0]
  assert.equal(journaled.phase, 'completed')
  const envelope = journaled.resultEnvelope
  assert.ok(envelope.includes('正文内容'), '同一 envelope 字符串进 checkpoint')
  // 恢复:复用 durable result,不再联网;模型看到与 checkpoint 完全相同的字符串。
  let modelSawEnvelope
  const recovered = await runAgentToolLoop({
    registry, messages: [], maximumSteps: 2, attempt,
    resumeCheckpoint: durable,
    checkpointUrlLookup: async () => ['93.184.216.34'],
    saveCheckpoint: async (checkpoint) => { checkpoints.push(structuredClone(checkpoint)) },
    callModel: async ({ messages }) => {
      modelSawEnvelope = messages.find((message) => message.role === 'tool')?.content
      return { choices: [{ message: { content: '综合完成' } }] }
    },
  })
  assert.equal(recovered.output, '综合完成')
  assert.equal(fetches, 1, '恢复不得第二次 fetch')
  assert.equal(modelSawEnvelope, envelope, '模型 history 与 checkpoint 使用同一字符串')

  await assert.rejects(runAgentToolLoop({
    registry, messages: [], maximumSteps: 2, attempt,
    resumeCheckpoint: durable,
    checkpointUrlLookup: async () => ['10.0.0.8'],
    saveCheckpoint: async () => {},
    callModel: async () => { throw new Error('私网结果不得进入模型') },
  }), (caught) => caught.code === 'AGENT_TURN_CHECKPOINT_INVALID')
  assert.equal(fetches, 1, '私网解析失败时也不得重放工具')

  let recoveredRef
  const refAttempt = { id: 'attempt-ref', model: 'model-a', snapshotHash: 'hash-ref' }
  const refResult = await runAgentToolLoop({
    registry, messages: [], maximumSteps: 2, attempt: refAttempt,
    resumeCheckpoint: {
      version: 2, attempt: refAttempt,
      completedSteps: [{ step: 0, calls: [{
        id: 'call-ref', name: 'web_probe_read', risk: 'external', recovery: 'journal', terminal: false,
        phase: 'completed', arguments: { url: 'https://example.com/ref' }, resultRef: { kind: 'artifact', id: 'artifact-1' },
      }] }],
    },
    recoverJournalResult: async ({ resultRef }) => ({ artifactId: resultRef.id, kind: resultRef.kind }),
    saveCheckpoint: async () => {},
    callModel: async ({ messages }) => {
      recoveredRef = JSON.parse(messages.find((message) => message.role === 'tool').content)
      return { choices: [{ message: { content: '引用恢复完成' } }] }
    },
  })
  assert.equal(refResult.output, '引用恢复完成')
  assert.deepEqual(recoveredRef, { artifactId: 'artifact-1', kind: 'artifact' })
  assert.equal(fetches, 1, 'resultRef 恢复不得执行原工具')
})

test('journal 恢复:pre-dispatch 可重执行,post-dispatch 无结果收口 outcome-unknown 且不再 fetch', async () => {
  let fetches = 0
  const registry = createAgentToolRegistry([{
    name: 'web_probe_read', label: '外部读取', risk: 'external', recovery: 'journal',
    description: '测试外部读取。',
    parameters: { type: 'object', additionalProperties: false, properties: { url: { type: 'string' } }, required: ['url'] },
    validate: (input) => ({ url: input.url }),
    execute: async (input) => { fetches += 1; return { url: input.url, text: '正文' } },
  }])
  const attempt = { id: 'attempt-j2', model: 'model-a', snapshotHash: 'hash-j2' }
  const journalCall = (phase) => ({
    version: 2, attempt,
    completedSteps: [],
    pendingStep: {
      step: 0,
      calls: [{
        id: 'call-j', name: 'web_probe_read', risk: 'external', recovery: 'journal', terminal: false,
        arguments: { url: 'https://example.com/x' },
        ...(phase ? { phase } : {}),
      }],
    },
  })
  // pre-dispatch(prepared):有证据未派发,按策略重执行。
  const resumed = await runAgentToolLoop({
    registry, messages: [], maximumSteps: 2, attempt,
    resumeCheckpoint: journalCall('prepared'),
    saveCheckpoint: async () => {},
    callModel: async () => ({ choices: [{ message: { content: '完成' } }] }),
  })
  assert.equal(resumed.output, '完成')
  assert.equal(fetches, 1)
  const recoveredEvents = []
  const recovered = await runAgentToolLoop({
    registry, messages: [], maximumSteps: 2, attempt,
    resumeCheckpoint: {
      ...journalCall('completed'),
      pendingStep: {
        ...journalCall('completed').pendingStep,
        calls: [{
          ...journalCall('completed').pendingStep.calls[0],
          resultEnvelope: '{"url":"https://example.com/x","text":"正文"}',
        }],
      },
    },
    checkpointUrlLookup: async () => ['93.184.216.34'],
    saveCheckpoint: async () => {},
    onEvent: (event) => recoveredEvents.push(event),
    callModel: async () => ({ choices: [{ message: { content: '恢复完成' } }] }),
  })
  assert.equal(recovered.output, '恢复完成')
  assert.deepEqual(recoveredEvents.map((event) => event.toolCall.status), ['running', 'succeeded'])
  assert.equal(fetches, 1, 'completed journal 只恢复结果，不得再次 fetch')
  // post-dispatch(dispatched):禁止自动重放,收口 AGENT_TOOL_OUTCOME_UNKNOWN。
  await assert.rejects(
    runAgentToolLoop({
      registry, messages: [], maximumSteps: 2, attempt,
      resumeCheckpoint: journalCall('dispatched'),
      saveCheckpoint: async () => {},
      callModel: async () => { throw new Error('不应再调模型') },
    }),
    (caught) => caught.code === 'AGENT_TOOL_OUTCOME_UNKNOWN',
  )
  assert.equal(fetches, 1, 'dispatched 恢复不得再次 fetch')
})

test('journal call 在同一执行内二次到达派发边界:emit duplicate_dispatch 并具名失败,不二次外呼', async () => {
  let fetches = 0
  const registry = createAgentToolRegistry([{
    name: 'dup_external_read', label: '重复派发探针', risk: 'external', recovery: 'journal',
    description: '测试。',
    parameters: { type: 'object', additionalProperties: false, properties: { url: { type: 'string' } }, required: ['url'] },
    validate: (input) => ({ url: input.url }),
    execute: async () => { fetches += 1; return { ok: true } },
  }])
  const events = []
  const originalLog = console.log
  console.log = (line) => {
    try {
      const parsed = JSON.parse(String(line))
      if (parsed?.event === 'botanic.agent.harness.lifecycle' && parsed.outcome === 'duplicate_dispatch') events.push(parsed)
    } catch { /* 忽略非 JSON */ }
  }
  try {
    // 有 checkpoint 时重复 id 已被 checkpoint 校验拦截;guard 是无 checkpoint
    // 兼容路径(Chat 直调等)的最后防线。模型两步返回同一 call id:第二步在
    // 派发边界被拦截,不产生第二次外呼。
    await assert.rejects(runAgentToolLoop({
      registry, messages: [], maximumSteps: 3,
      callModel: async ({ step }) => ({ choices: [{ message: { tool_calls: [{
        id: 'dup-call-1', type: 'function',
        function: { name: 'dup_external_read', arguments: JSON.stringify({ url: 'https://example.com/' + step }) },
      }] } }] }),
    }), (caught) => caught.code === 'AGENT_TOOL_DUPLICATE_DISPATCH')
    assert.equal(fetches, 1, '第二次派发必须被拦截')
    assert.equal(events.length, 1)
    assert.equal(events[0].reason, 'AGENT_TOOL_DUPLICATE_DISPATCH')
  } finally {
    console.log = originalLog
  }
})

test('journal envelope 写入前脱敏:页面正文含 http 链接与端口 URL 时仍 durable completed', async () => {
  const registry = createAgentToolRegistry([{
    name: 'web_probe_read', label: '外部读取', risk: 'external', recovery: 'journal',
    description: '测试外部读取。',
    parameters: { type: 'object', additionalProperties: false, properties: { url: { type: 'string' } }, required: ['url'] },
    validate: (input) => ({ url: input.url }),
    execute: async (input) => ({
      url: input.url,
      text: '参见 http://finance.yahoo.com/legacy 与 https://api.example.com:8443/v1 及 data:application/json 格式',
    }),
  }])
  const attempt = { id: 'attempt-sanitize', model: 'model-a', snapshotHash: 'hash-sanitize' }
  const checkpoints = []
  let modelSawEnvelope
  const result = await runAgentToolLoop({
    registry, messages: [], maximumSteps: 2, attempt,
    saveCheckpoint: async (checkpoint) => { checkpoints.push(structuredClone(checkpoint)) },
    callModel: async ({ step, messages }) => {
      if (step === 0) {
        return { choices: [{ message: { tool_calls: [{
          id: 'call-sanitize-1', type: 'function',
          function: { name: 'web_probe_read', arguments: JSON.stringify({ url: 'https://finance.yahoo.com/quote' }) },
        }] } }] }
      }
      modelSawEnvelope = messages.find((message) => message.role === 'tool')?.content
      return { choices: [{ message: { content: '调研完成' } }] }
    },
  })
  assert.equal(result.output, '调研完成')
  const journaled = checkpoints.findLast((item) => item.completedSteps.length || item.pendingStep)
  const call = (journaled.completedSteps[0] ?? journaled.pendingStep).calls[0]
  assert.equal(call.phase, 'completed')
  assert.ok(call.resultEnvelope.includes('https://finance.yahoo.com/quote'), '合规来源 URL 保留')
  assert.ok(call.resultEnvelope.includes('[removed:non-public-url]'), '非公开 URL 被占位符替换')
  assert.doesNotMatch(call.resultEnvelope, /http:\/\/finance|:8443|data:application\//u)
  assert.equal(modelSawEnvelope, call.resultEnvelope, '模型 history 与 checkpoint 使用同一脱敏字符串')
})

test('journal envelope 仍被 backstop 拒绝时降级 durable failed,不滞留 dispatched', async () => {
  const registry = createAgentToolRegistry([{
    name: 'web_probe_read', label: '外部读取', risk: 'external', recovery: 'journal',
    description: '测试外部读取。',
    parameters: { type: 'object', additionalProperties: false, properties: { url: { type: 'string' } }, required: ['url'] },
    validate: (input) => ({ url: input.url }),
    // 脱敏无法修复的内容:输出顶层 reasoning 字段触发 backstop 拒绝。
    execute: async (input) => ({ url: input.url, reasoning: 'chain' }),
  }])
  const attempt = { id: 'attempt-degrade', model: 'model-a', snapshotHash: 'hash-degrade' }
  const checkpoints = []
  let modelSawEnvelope
  const result = await runAgentToolLoop({
    registry, messages: [], maximumSteps: 2, attempt,
    saveCheckpoint: async (checkpoint) => { checkpoints.push(structuredClone(checkpoint)) },
    callModel: async ({ step, messages }) => {
      if (step === 0) {
        return { choices: [{ message: { tool_calls: [{
          id: 'call-degrade-1', type: 'function',
          function: { name: 'web_probe_read', arguments: JSON.stringify({ url: 'https://example.com/a' }) },
        }] } }] }
      }
      modelSawEnvelope = messages.find((message) => message.role === 'tool')?.content
      return { choices: [{ message: { content: '已换来源' } }] }
    },
  })
  assert.equal(result.output, '已换来源', '拒绝结果回给模型继续,不终止整轮')
  const failedCall = result.toolCalls.find((call) => call.id === 'call-degrade-1')
  assert.equal(failedCall.status, 'failed')
  const journaled = checkpoints.findLast((item) => (
    [...item.completedSteps, ...(item.pendingStep ? [item.pendingStep] : [])]
      .some((step) => step.calls.some((call) => call.phase && call.phase !== 'prepared'))
  ))
  const call = [...journaled.completedSteps, ...(journaled.pendingStep ? [journaled.pendingStep] : [])]
    .flatMap((step) => step.calls).find((entry) => entry.id === 'call-degrade-1')
  assert.equal(call.phase, 'failed', 'durable 落 failed,不滞留 dispatched')
  assert.equal(call.resultEnvelope, undefined)
  assert.match(modelSawEnvelope, /AGENT_TOOL_RESULT_REJECTED/u)
})

test('journal completed 复用只对结构化来源 URL 做 DNS 复检,正文死链不阻塞恢复', async () => {
  let fetches = 0
  const registry = createAgentToolRegistry([{
    name: 'web_probe_read', label: '外部读取', risk: 'external', recovery: 'journal',
    description: '测试外部读取。',
    parameters: { type: 'object', additionalProperties: false, properties: { url: { type: 'string' } }, required: ['url'] },
    validate: (input) => ({ url: input.url }),
    execute: async () => { fetches += 1; return { ok: true } },
  }])
  const attempt = { id: 'attempt-reuse', model: 'model-a', snapshotHash: 'hash-reuse' }
  const looked = []
  const durable = {
    version: 2, attempt,
    completedSteps: [{ step: 0, calls: [{
      id: 'call-reuse-1', name: 'web_probe_read', risk: 'external', recovery: 'journal', terminal: false,
      phase: 'completed', arguments: { url: 'https://example.com/a' },
      resultEnvelope: JSON.stringify({
        url: 'https://example.com/a',
        text: '正文提及 https://dead-link.example.net/gone 死链',
      }),
    }] }],
  }
  const recovered = await runAgentToolLoop({
    registry, messages: [], maximumSteps: 2, attempt,
    resumeCheckpoint: durable,
    checkpointUrlLookup: async (hostname) => {
      looked.push(hostname)
      if (hostname === 'dead-link.example.net') throw new Error('NXDOMAIN')
      return ['93.184.216.34']
    },
    saveCheckpoint: async () => {},
    callModel: async () => ({ choices: [{ message: { content: '恢复完成' } }] }),
  })
  assert.equal(recovered.output, '恢复完成')
  assert.equal(fetches, 0, '复用不得重新执行工具')
  assert.deepEqual(looked, ['example.com'], '只复检结构化 url 字段,不复检正文链接')
  // 结构化来源 URL 解析到私网仍必须 fail closed。
  await assert.rejects(runAgentToolLoop({
    registry, messages: [], maximumSteps: 2, attempt,
    resumeCheckpoint: durable,
    checkpointUrlLookup: async () => ['10.0.0.8'],
    saveCheckpoint: async () => {},
    callModel: async () => { throw new Error('私网结果不得进入模型') },
  }), (caught) => caught.code === 'AGENT_TURN_CHECKPOINT_INVALID')
})
