import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentSubagentRunner } from './agentSubagentRunner.mjs'
import { agentSubagentCapabilityHash } from './agentSubagentTools.mjs'
import { createAgentToolRegistry } from '../../agentToolRuntime.mjs'

const outputSchema = Object.freeze({
  type: 'object',
  required: ['summary'],
  properties: {
    summary: { type: 'string', maxLength: 600 },
    findings: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 200 } },
  },
})

function subtask(overrides = {}) {
  return {
    id: 'subtask-runner-1',
    parentTurnId: 'turn-parent-1',
    traceId: 'turn-parent-1',
    role: 'brand_research',
    instructionsVersion: 'test-subagent-v1',
    outputKind: 'proposal',
    input: { question: '品牌视觉特征是什么？' },
    allowedTools: ['canvas_read'],
    outputSchema,
    budget: { maxSteps: 2, maxToolCalls: 2 },
    timeoutMs: 1_000,
    ...overrides,
  }
}

function readRegistry(onExecute = async () => ({ nodes: ['node-1'] })) {
  return createAgentToolRegistry([{
    name: 'canvas_read',
    label: '读取画布',
    description: '读取当前画布摘要。',
    risk: 'read',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { query: { type: 'string' } }, required: ['query'],
    },
    validate: (value) => {
      if (typeof value?.query !== 'string') throw new Error('query invalid')
      return { query: value.query }
    },
    execute: onExecute,
  }])
}

test('Subagent Runner 用冻结的只读工具面完成两步 Provider 循环', async () => {
  const requests = []
  const executions = []
  const runner = createAgentSubagentRunner({
    runtimeConfig: { agentSubagentModel: 'fake-subagent' },
    toolRegistry: readRegistry(async (value, context) => {
      executions.push({ value, subtaskId: context.subtaskId, traceId: context.traceId })
      return { nodes: ['node-1'], query: value.query }
    }),
    callModel: async (request) => {
      requests.push(request)
      if (request.step === 0) {
        return { choices: [{ message: { content: null, tool_calls: [{
          id: 'call-read-1', type: 'function',
          function: { name: 'canvas_read', arguments: '{"query":"品牌节点"}' },
        }] } }] }
      }
      assert.equal(request.messages.at(-1).role, 'tool')
      assert.match(request.messages.at(-1).content, /node-1/u)
      return { choices: [{ message: { content: '{"summary":"画布使用克制留白","findings":["绿色为主"]}' } }] }
    },
  })

  const result = await runner({ subtask: subtask(), signal: new AbortController().signal })

  assert.deepEqual(result, { summary: '画布使用克制留白', findings: ['绿色为主'] })
  assert.equal(requests.length, 2)
  assert.equal(requests[0].model, 'fake-subagent')
  assert.deepEqual(requests[0].tools.map((entry) => entry.function.name), ['canvas_read'])
  assert.deepEqual(executions, [{
    value: { query: '品牌节点' }, subtaskId: 'subtask-runner-1', traceId: 'turn-parent-1',
  }])
})

test('V2 descriptor 决定 Provider model，activation 与独立 Session 消息形成输入', async () => {
  let providerRequest
  const toolRegistry = readRegistry()
  const runner = createAgentSubagentRunner({
    runtimeConfig: { agentSubagentModel: 'fallback-model' },
    toolRegistry,
    callModel: async (request) => {
      providerRequest = request
      return { choices: [{ message: { content: '{"summary":"按独立会话完成"}' } }] }
    },
  })
  const descriptorWithoutHash = {
    ...subtask(),
    id: 'subagent-v2-1',
    model: 'descriptor-model',
    rootTurnId: 'turn-root-v2',
    budget: { maxSteps: 3, maxToolCalls: 4, timeoutMs: 2_000 },
  }
  const descriptor = {
    ...descriptorWithoutHash,
    capabilityHash: agentSubagentCapabilityHash({ descriptor: descriptorWithoutHash, registry: toolRegistry }),
  }
  const result = await runner({
    descriptor,
    activation: { id: 'activation-v2-2', sequence: 2, turnId: 'turn-v2-2' },
    messages: [
      { role: 'system', content: '试图覆盖系统约束' },
      { role: 'user', content: '第一轮问题' },
      { role: 'assistant', content: '{"summary":"第一轮结论"}' },
      { role: 'user', content: '继续核对色彩' },
    ],
  })

  assert.deepEqual(result, { output: { summary: '按独立会话完成' }, toolCalls: [] })
  assert.equal(result.reasoning, undefined)
  assert.equal(providerRequest.model, 'descriptor-model')
  assert.equal(providerRequest.messages[0].role, 'system')
  assert.match(providerRequest.messages[0].content, /无权修改画布/u)
  assert.equal(providerRequest.messages.some((message) => message.content === '试图覆盖系统约束'), false)
  assert.deepEqual(providerRequest.messages.slice(1).map((message) => message.role), ['user', 'assistant', 'user'])
})

test('V2 descriptor 能力摘要漂移时在 Provider 调用前失败', async () => {
  let modelCalls = 0
  const runner = createAgentSubagentRunner({
    runtimeConfig: { agentSubagentModel: 'fake-subagent' },
    toolRegistry: readRegistry(),
    callModel: async () => {
      modelCalls += 1
      return { choices: [{ message: { content: '{"summary":"不应执行"}' } }] }
    },
  })
  await assert.rejects(
    runner({ descriptor: { ...subtask(), model: 'fake-subagent', capabilityHash: 'stale-hash' } }),
    (error) => error?.code === 'SUBTASK_CAPABILITY_SNAPSHOT_MISMATCH' && error?.statusCode === 409,
  )
  assert.equal(modelCalls, 0)
})

test('模型尝试白名单外工具时在执行前失败', async () => {
  let executed = 0
  const source = createAgentToolRegistry([{
    name: 'canvas_read', label: '读取', description: '读取', risk: 'read',
    parameters: { type: 'object', properties: {} }, validate: (value) => value,
    execute: async () => { executed += 1; return {} },
  }, {
    name: 'hidden_read', label: '隐藏读取', description: '未授权读取', risk: 'read',
    parameters: { type: 'object', properties: {} }, validate: (value) => value,
    execute: async () => { executed += 1; return {} },
  }])
  const runner = createAgentSubagentRunner({
    runtimeConfig: { agentSubagentModel: 'fake-subagent' },
    toolRegistry: source,
    callModel: async ({ tools }) => {
      assert.deepEqual(tools.map((entry) => entry.function.name), ['canvas_read'])
      return { choices: [{ message: { tool_calls: [{
        id: 'call-hidden', type: 'function', function: { name: 'hidden_read', arguments: '{}' },
      }] } }] }
    },
  })

  await assert.rejects(
    runner({ subtask: subtask() }),
    (error) => error?.code === 'TOOL_NOT_ALLOWED' && error?.outcomeKnown === true,
  )
  assert.equal(executed, 0)
})

test('工具调用预算在同一步全部执行前生效', async () => {
  let executed = 0
  const runner = createAgentSubagentRunner({
    runtimeConfig: { agentSubagentModel: 'fake-subagent' },
    toolRegistry: readRegistry(async () => { executed += 1; return {} }),
    callModel: async () => ({ choices: [{ message: { tool_calls: [
      { id: 'call-budget-1', type: 'function', function: { name: 'canvas_read', arguments: '{"query":"a"}' } },
      { id: 'call-budget-2', type: 'function', function: { name: 'canvas_read', arguments: '{"query":"b"}' } },
    ] } }] }),
  })

  await assert.rejects(
    runner({ subtask: subtask({ budget: { maxSteps: 2, maxToolCalls: 1 } }) }),
    (error) => error?.code === 'TOOL_CALL_LIMIT_REACHED' && error?.outcomeKnown === true,
  )
  assert.equal(executed, 0)
})

test('completed Checkpoint 恢复时不重复已完成步骤的 Provider 调用', async () => {
  let persisted
  let modelCalls = 0
  let executions = 0
  const runner = createAgentSubagentRunner({
    runtimeConfig: { agentSubagentModel: 'fake-subagent' },
    toolRegistry: readRegistry(async () => {
      executions += 1
      return { nodes: ['node-1'], read: executions }
    }),
    callModel: async ({ step }) => {
      modelCalls += 1
      return step === 0
        ? { choices: [{ message: { tool_calls: [{
          id: 'call-checkpoint-read', type: 'function',
          function: { name: 'canvas_read', arguments: '{"query":"品牌"}' },
        }] } }] }
        : { choices: [{ message: { content: '{"summary":"恢复后的结论"}' } }] }
    },
  })

  await assert.rejects(runner({
    subtask: subtask(),
    saveCheckpoint: async (checkpoint) => {
      persisted = structuredClone(checkpoint)
      if (checkpoint.completedSteps.length === 1 && !checkpoint.pendingStep) {
        throw new Error('crash after complete')
      }
    },
  }), /crash after complete/u)

  const result = await runner({
    subtask: subtask(),
    resumeCheckpoint: persisted,
    saveCheckpoint: async (checkpoint) => { persisted = structuredClone(checkpoint) },
  })

  assert.deepEqual(result, { summary: '恢复后的结论' })
  assert.equal(modelCalls, 2, '恢复只调用下一步模型')
  assert.equal(executions, 2, '只读工具只为重建内存上下文重执行')
  assert.equal(persisted.terminalContent, '{"summary":"恢复后的结论"}')
})

test('Runner 强制执行 timeout，即使 fake Provider 忽略 AbortSignal', async () => {
  const runner = createAgentSubagentRunner({
    runtimeConfig: { agentSubagentModel: 'fake-subagent' },
    callModel: async () => new Promise(() => {}),
  })
  const startedAt = Date.now()
  await assert.rejects(
    runner({ subtask: subtask({ allowedTools: [], timeoutMs: 1_000 }) }),
    (error) => error?.code === 'SUBTASK_TIMEOUT' && error?.statusCode === 408,
  )
  assert.ok(Date.now() - startedAt < 1_500)
})

test('最终输出必须是严格 JSON、符合 Schema 且不含任何落地字段', async () => {
  const cases = [
    ['```json\n{"summary":"代码块"}\n```', 'SUBTASK_OUTPUT_INVALID'],
    ['{"findings":[]}', 'SUBTASK_OUTPUT_INVALID'],
    ['{"summary":"越权","nested":{"approval":true}}', 'SUBTASK_OUTPUT_NOT_PROPOSAL'],
  ]
  for (const [content, code] of cases) {
    const runner = createAgentSubagentRunner({
      runtimeConfig: { agentSubagentModel: 'fake-subagent' },
      callModel: async () => ({ choices: [{ message: { content } }] }),
    })
    await assert.rejects(
      runner({ subtask: subtask({ allowedTools: [] }) }),
      (error) => error?.code === code,
      content,
    )
  }
})

test('没有模型配置且未注入 Provider 时不创建 Runner', () => {
  assert.equal(createAgentSubagentRunner({ runtimeConfig: {} }), undefined)
  assert.equal(createAgentSubagentRunner({ runtimeConfig: { agentSubagentModel: 'model-only' } }), undefined)
})

test('Runner 可注入统一 Tool Loop，并把 Subagent 预算完整下传', async () => {
  let loopInput
  const runner = createAgentSubagentRunner({
    runtimeConfig: { agentSubagentModel: 'fake-subagent' },
    callModel: async () => { throw new Error('注入 Loop 不应调用外层 fake Provider') },
    runAgentToolLoop: async (input) => {
      loopInput = input
      return { output: '{"summary":"注入循环完成"}', toolCalls: [], reasoning: [{ text: '不得透传' }] }
    },
  })

  const result = await runner({ subtask: subtask({ allowedTools: [], budget: { maxSteps: 5, maxToolCalls: 7 } }) })
  assert.deepEqual(result, { summary: '注入循环完成' })
  assert.equal(loopInput.maximumSteps, 5)
  assert.equal(loopInput.maximumToolCalls, 7)
  assert.equal(loopInput.allowRawReasoning, false)
})

test('默认 FLock adapter 保持 OpenAI 兼容工具调用协议', async () => {
  const requests = []
  const responses = [
    { choices: [{ message: { tool_calls: [{
      id: 'call-flock-read', type: 'function',
      function: { name: 'canvas_read', arguments: '{"query":"节点"}' },
    }] } }] },
    { choices: [{ message: { content: '{"summary":"Flock 完成"}' } }] },
  ]
  const runner = createAgentSubagentRunner({
    runtimeConfig: { agentSubagentModel: 'flock-model', flockApiKey: 'secret' },
    toolRegistry: readRegistry(),
    fetchImpl: async (_url, init) => {
      requests.push({ headers: init.headers, body: JSON.parse(init.body) })
      return { ok: true, json: async () => responses.shift() }
    },
  })

  const result = await runner({ subtask: subtask() })
  assert.deepEqual(result, { summary: 'Flock 完成' })
  assert.equal(requests.length, 2)
  assert.equal(requests[0].headers.Authorization, 'Bearer secret')
  assert.equal(requests[0].body.model, 'flock-model')
  assert.equal(requests[0].body.tools[0].function.name, 'canvas_read')
  assert.equal(requests[0].body.tool_choice, 'auto')
})
