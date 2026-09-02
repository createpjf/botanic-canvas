import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentCompatibilityIdempotencyKey,
  agentCompatibilityResult,
  createAgentCompatibilityRuntimeRequest,
  resolveBotanicAgentRuntimeRequest,
} from './agentRuntimeRequest.mjs'
import { resolveAgentModelContextPolicy } from './agentModelContextPolicy.mjs'
import { canonicalHash } from './canonicalHash.mjs'

const runtime = {
  flockApiKey: 'flock-test-key',
  flockTextModel: 'deepseek-v4-pro',
  flockAgentModels: ['deepseek-v4-pro'],
}

const document = {
  id: 'project-runtime',
  name: 'Runtime 测试项目',
  nodes: [],
  edges: [],
  assetGroups: [],
  agentMemory: [],
}

const planInput = {
  projectId: 'project-runtime',
  locale: 'zh-CN',
  plannerModel: 'deepseek-v4-pro',
  instruction: '保持人物不变，把场景替换成海边。',
  requestedIntent: 'replace_scene',
  selectedResult: { nodeId: 'result-1', label: '首图 01' },
  settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
  references: [],
  contextSnapshot: [],
  assetGroups: [],
  projectMemory: [],
}

const chatInput = {
  projectId: 'project-runtime',
  locale: 'zh-CN',
  plannerModel: 'deepseek-v4-pro',
  mode: 'conversation',
  messages: [{ role: 'user', content: '项目现在是什么状态？' }],
  contextNodeIds: [],
}

const intentInput = {
  projectId: 'project-runtime',
  locale: 'zh-CN',
  plannerModel: 'deepseek-v4-pro',
  messages: [{ role: 'user', content: '项目现在是什么状态？' }],
  contextNodeIds: [],
  hasTarget: false,
  generationModels: [],
}

function jsonResponse(message) {
  return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 })
}

function planToolResponse({ clarification = false, reasoning } = {}) {
  const functionCall = clarification
    ? {
        name: 'generation_ask_clarification',
        arguments: JSON.stringify({
          question: '请确认这次输出的比例。',
          fields: [{ id: 'aspect_ratio', label: '画面比例' }],
        }),
      }
    : {
        name: 'generation_create_plan',
        arguments: JSON.stringify({
          intent: 'replace_scene',
          prompt: '保持人物身份与服装不变，替换为柔和夕阳下的海边场景。',
          summary: '保持人物，替换海边场景。',
          constraints: [
            { dimension: 'person', mode: 'preserve' },
            { dimension: 'scene', mode: 'vary' },
          ],
        }),
      }
  return jsonResponse({
    content: null,
    ...(reasoning ? { reasoning_content: reasoning } : {}),
    tool_calls: [{
      id: clarification ? 'call-clarification' : 'call-plan',
      type: 'function',
      function: functionCall,
    }],
  })
}

test('兼容 operation envelope 固化输入快照且拒绝未知 operation', () => {
  const input = { projectId: 'project-runtime', nested: { value: 1 } }
  const request = createAgentCompatibilityRuntimeRequest('chat', input)

  input.nested.value = 2
  assert.deepEqual(request, {
    runtimeOperation: 'chat',
    input: { projectId: 'project-runtime', nested: { value: 1 } },
  })
  assert.throws(
    () => createAgentCompatibilityRuntimeRequest('unknown', input),
    /不支持的 Agent Runtime operation/,
  )
})

test('显式幂等键按 operation 命名空间稳定复用；缺失时拒绝执行', () => {
  const explicit = 'client-submit-key-0001'
  const explicitPlan = agentCompatibilityIdempotencyKey('plan', planInput, explicit, 'request-ignored')
  const explicitReplay = agentCompatibilityIdempotencyKey('plan', planInput, explicit, 'another-request')
  const explicitChat = agentCompatibilityIdempotencyKey('chat', chatInput, explicit, 'request-ignored')

  assert.equal(explicitPlan, explicitReplay)
  assert.notEqual(explicitPlan, explicitChat)
  assert.match(explicitPlan, /^agent-plan-[A-Za-z0-9_-]{43}$/)

  assert.throws(
    () => agentCompatibilityIdempotencyKey('chat', chatInput, undefined, 'request-1'),
    (error) => error?.code === 'INVALID_IDEMPOTENCY_KEY' && error?.statusCode === 400,
  )
})

test('intent dispatcher 进入统一 Turn 解析器并保留 Turn 结果形状', async () => {
  let providerCalls = 0
  const result = await resolveBotanicAgentRuntimeRequest(
    createAgentCompatibilityRuntimeRequest('intent', intentInput),
    runtime,
    {
      document,
      fetchImpl: async () => {
        providerCalls += 1
        return jsonResponse({ content: '项目尚未生成任何结果。' })
      },
    },
  )

  assert.equal(providerCalls, 1)
  assert.equal(result.kind, 'chat')
  assert.equal(result.answer, '项目尚未生成任何结果。')
  assert.deepEqual(agentCompatibilityResult('intent', result), { turn: result })
})

test('Runtime Request 用 Snapshot V2 创建主模型 Context Runtime 并持久化 usage anchor', async () => {
  const policy = resolveAgentModelContextPolicy('deepseek-v4-pro')
  const anchors = []
  const requests = []
  const checkpoint = '早期对话摘要'
  const v2Input = {
    ...intentInput,
    sessionId: 'session-runtime-v2',
    messages: [{ role: 'user', content: '不应使用的 legacy 窗口' }],
    threadContextSnapshot: {
      version: 2,
      modelPolicy: policy,
      checkpoint: { role: 'user', content: checkpoint, contentHash: canonicalHash(checkpoint) },
      messages: [{ id: 'm-current', revision: 'r-current', role: 'user', content: '继续当前任务' }],
    },
  }
  const result = await resolveBotanicAgentRuntimeRequest(v2Input, runtime, {
    runtimeIdentity: {
      userId: 'user-1', projectId: 'project-runtime', sessionId: 'session-runtime-v2', turnId: 'turn-v2',
    },
    document,
    persistAgentContextUsageAnchor: async (anchor) => { anchors.push(anchor) },
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body))
      return new Response(JSON.stringify({
        choices: [{ message: { content: '已继续。' } }],
        usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 },
      }), { status: 200 })
    },
  })

  assert.equal(result.answer, '已继续。')
  assert.match(JSON.stringify(requests[0].messages), /早期对话摘要|继续当前任务/u)
  assert.doesNotMatch(JSON.stringify(requests[0].messages), /不应使用的 legacy 窗口/u)
  assert.equal(anchors.length, 1)
  assert.equal(anchors[0].turnId, 'turn-v2')
  assert.equal(anchors[0].inputTokens, 20)
})

test('chat dispatcher 把 reasoning 提升到 Runtime 顶层，再恢复旧 chat 响应形状', async () => {
  const result = await resolveBotanicAgentRuntimeRequest(
    createAgentCompatibilityRuntimeRequest('chat', { ...chatInput, showRawReasoning: true }),
    { ...runtime, agentRawReasoning: true },
    {
      document,
      fetchImpl: async () => jsonResponse({
        content: '项目尚未生成任何结果。',
        reasoning_content: '先读取用户问题。',
      }),
    },
  )

  assert.equal(result.kind, 'chat')
  assert.equal(result.runtimeOperation, 'chat')
  assert.equal(result.response.answer, '项目尚未生成任何结果。')
  assert.equal(result.response.reasoning, undefined)
  assert.deepEqual(result.reasoning, [{ step: 0, source: 'raw', text: '先读取用户问题。' }])
  assert.deepEqual(agentCompatibilityResult('chat', result), {
    response: {
      ...result.response,
      reasoning: result.reasoning,
    },
  })
})

test('plan dispatcher 把 reasoning 提升到 Runtime 顶层，再恢复旧 plan 响应形状', async () => {
  const result = await resolveBotanicAgentRuntimeRequest(
    createAgentCompatibilityRuntimeRequest('plan', { ...planInput, showRawReasoning: true }),
    { ...runtime, agentRawReasoning: true },
    {
      fetchImpl: async () => planToolResponse({ reasoning: '先锁定人物，再替换场景。' }),
    },
  )

  assert.equal(result.kind, 'plan')
  assert.equal(result.runtimeOperation, 'plan')
  assert.equal(result.plan.intent, 'replace_scene')
  assert.equal(result.plan.reasoning, undefined)
  assert.deepEqual(result.reasoning, [{ step: 0, source: 'raw', text: '先锁定人物，再替换场景。' }])
  assert.deepEqual(agentCompatibilityResult('plan', result), {
    plan: result.plan,
    reasoning: result.reasoning,
  })
})

test('plan clarification 保持受控追问形状并可还原兼容结果', async () => {
  const result = await resolveBotanicAgentRuntimeRequest(
    createAgentCompatibilityRuntimeRequest('plan', planInput),
    { ...runtime, agentRawReasoning: true },
    {
      fetchImpl: async () => planToolResponse({
        clarification: true,
        reasoning: '还缺画面比例。',
      }),
    },
  )

  assert.equal(result.kind, 'clarification')
  assert.equal(result.runtimeOperation, 'plan')
  assert.equal(result.clarification.question, '请确认这次输出的比例。')
  assert.equal(result.clarification.reasoning, undefined)
  assert.equal(result.reasoning, undefined)
  assert.deepEqual(agentCompatibilityResult('plan', result), {
    clarification: result.clarification,
  })
})

test('未知 dispatcher operation 与无效 envelope 在调用 Provider 前失败', async () => {
  let providerCalls = 0
  const options = {
    fetchImpl: async () => {
      providerCalls += 1
      throw new Error('不应调用 Provider')
    },
  }

  await assert.rejects(
    resolveBotanicAgentRuntimeRequest({ runtimeOperation: 'unknown', input: {} }, runtime, options),
    (error) => error?.code === 'AGENT_RUNTIME_OPERATION_INVALID' && error?.statusCode === 409,
  )
  await assert.rejects(
    resolveBotanicAgentRuntimeRequest({ runtimeOperation: 'chat' }, runtime, options),
    (error) => error?.code === 'AGENT_RUNTIME_REQUEST_INVALID' && error?.statusCode === 409,
  )
  assert.equal(providerCalls, 0)
})
