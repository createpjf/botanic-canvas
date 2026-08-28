import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AgentModelContextPolicyError,
  parseAgentModelContextPolicies,
  resolveAgentModelContextPolicy,
  validateAgentModelContextPolicySnapshot,
} from './agentModelContextPolicy.mjs'

test('Model Context Policy 精确命中模型并派生稳定预算', () => {
  const catalog = parseAgentModelContextPolicies({
    default: {
      contextWindowTokens: 32_000,
      outputReserveTokens: 2_000,
      safetyMarginTokens: 1_000,
    },
    models: {
      'planner-a': {
        id: 'planner-a-v1',
        contextWindowTokens: 64_000,
        autoCompactRatio: 0.75,
        retainRecentRatio: 0.1,
        toolResultPrune: { thresholdCodePoints: 10_000 },
      },
    },
  })
  const policy = resolveAgentModelContextPolicy('planner-a', catalog)
  assert.deepEqual({
    id: policy.id,
    source: policy.source,
    model: policy.model,
    contextWindowTokens: policy.contextWindowTokens,
    maxInputTokens: policy.maxInputTokens,
    autoCompactAtTokens: policy.autoCompactAtTokens,
    retainRecentTokens: policy.retainRecentTokens,
  }, {
    id: 'planner-a-v1',
    source: 'model',
    model: 'planner-a',
    contextWindowTokens: 64_000,
    maxInputTokens: 61_000,
    autoCompactAtTokens: 48_000,
    retainRecentTokens: 6_400,
  })
  assert.deepEqual(policy.toolResultPrune, {
    thresholdCodePoints: 10_000,
    headCodePoints: 4_096,
    tailCodePoints: 1_024,
  })
  assert.equal(Object.isFrozen(policy), true)
  assert.equal(Object.isFrozen(policy.toolResultPrune), true)
})

test('Model Context Policy 未配置时保留 legacy 8k input 安全语义', () => {
  const policy = resolveAgentModelContextPolicy('unknown-model')
  assert.equal(policy.source, 'legacy')
  assert.equal(policy.contextWindowTokens, 12_000)
  assert.equal(policy.outputReserveTokens, 3_000)
  assert.equal(policy.safetyMarginTokens, 1_000)
  assert.equal(policy.maxInputTokens, 8_000)
})

test('Model Context Policy default 可复用但仍绑定实际模型身份', () => {
  const catalog = parseAgentModelContextPolicies(JSON.stringify({
    default: { id: 'workspace-default-v2', contextWindowTokens: 20_000 },
  }))
  const left = resolveAgentModelContextPolicy('model-left', catalog)
  const right = resolveAgentModelContextPolicy('model-right', catalog)
  assert.equal(left.source, 'default')
  assert.equal(left.id, 'workspace-default-v2')
  assert.notEqual(left.hash, right.hash)
  assert.equal(left.model, 'model-left')
  assert.equal(right.model, 'model-right')
})

test('Model Context Policy 哈希不受配置键顺序影响', () => {
  const first = resolveAgentModelContextPolicy('planner', {
    models: { planner: { contextWindowTokens: 24_000, outputReserveTokens: 2_000 } },
  })
  const second = resolveAgentModelContextPolicy('planner', {
    models: { planner: { outputReserveTokens: 2_000, contextWindowTokens: 24_000 } },
  })
  assert.equal(first.hash, second.hash)
})

test('Model Context Policy 拒绝未知字段、错误比例与无输入空间配置', () => {
  const invalidInputs = [
    '{bad json',
    { extra: true },
    { models: { planner: { unknown: 1 } } },
    { models: { planner: { autoCompactRatio: 0.4 } } },
    { models: { planner: { retainRecentRatio: 0.5, autoCompactRatio: 0.5 } } },
    { models: { planner: { contextWindowTokens: 2_048, outputReserveTokens: 1_500, safetyMarginTokens: 100 } } },
    { models: { planner: { toolResultPrune: { thresholdCodePoints: 512, headCodePoints: 400, tailCodePoints: 112 } } } },
  ]
  for (const input of invalidInputs) {
    assert.throws(
      () => resolveAgentModelContextPolicy('planner', input),
      (error) => error instanceof AgentModelContextPolicyError
        && error.code === 'AGENT_MODEL_CONTEXT_POLICY_INVALID',
      JSON.stringify(input),
    )
  }
})

test('Model Context Policy 配置目录受大小与对象原型边界约束', () => {
  assert.throws(
    () => parseAgentModelContextPolicies('x'.repeat(64 * 1024 + 1)),
    AgentModelContextPolicyError,
  )
  assert.throws(
    () => parseAgentModelContextPolicies(Object.create({ models: {} })),
    AgentModelContextPolicyError,
  )
  assert.throws(
    () => parseAgentModelContextPolicies({
      models: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`model-${index}`, {}])),
    }),
    AgentModelContextPolicyError,
  )
})

test('Model Context Policy 快照可验证且拒绝恢复时的派生预算漂移', () => {
  const policy = resolveAgentModelContextPolicy('planner-a', {
    models: { 'planner-a': { contextWindowTokens: 24_000, outputReserveTokens: 2_000 } },
  })
  assert.deepEqual(validateAgentModelContextPolicySnapshot(structuredClone(policy), {
    model: 'planner-a',
  }), policy)
  assert.throws(
    () => validateAgentModelContextPolicySnapshot({ ...policy, maxInputTokens: policy.maxInputTokens - 1 }),
    AgentModelContextPolicyError,
  )
  assert.throws(
    () => validateAgentModelContextPolicySnapshot(policy, { model: 'planner-b' }),
    AgentModelContextPolicyError,
  )
})
