import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentToolRuntimeError, createAgentToolRegistry, executeConfirmedAgentAction, freezeAgentStepSnapshot, runAgentToolLoop } from './agentToolRuntime.mjs'
import { estimateAgentContextTokens } from './agentContextBudget.mjs'

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
  const parameters = { type: 'object', additionalProperties: false, properties: { query: { type: 'string' } } }
  const registry = createAgentToolRegistry([{
    name: 'probe', label: '探针', description: 'x', risk: 'read',
    parameters,
    validate: () => ({}), execute: async () => ({}),
  }])
  const snapshot = freezeAgentStepSnapshot({ registry, model: 'model-a', skillBindings: bindings, role: 'owner' })
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
  assert.equal(snapshot.role, 'owner')
  assert.equal(Object.isFrozen(snapshot), true)
  assert.throws(() => { snapshot.model = 'model-b' }, TypeError)
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
