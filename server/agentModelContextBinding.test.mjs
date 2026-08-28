import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AgentModelContextBindingError,
  bindAgentModelContextOptions,
  projectAgentThreadContextSnapshotV2,
  resolveAgentModelContextBinding,
} from './agentModelContextBinding.mjs'
import { resolveAgentModelContextPolicy } from './agentModelContextPolicy.mjs'
import { canonicalHash } from './canonicalHash.mjs'

const policy = resolveAgentModelContextPolicy('model-a')
const runtime = {
  policy,
  prepare: async () => ({}),
  observe: async () => undefined,
}

test('Snapshot V2 只投影 checkpoint 与消息正文，并校验冻结策略', () => {
  const checkpoint = '早期摘要'
  const projected = projectAgentThreadContextSnapshotV2({
    version: 2,
    modelPolicy: policy,
    checkpoint: { role: 'user', content: checkpoint, contentHash: canonicalHash(checkpoint) },
    messages: [
      { id: 'm-1', revision: 'r-1', role: 'user', content: '当前问题' },
      { id: 'm-2', revision: 'r-2', role: 'assistant', content: '当前回答' },
    ],
  }, 'model-a')
  assert.equal(projected.contextPolicyHash, policy.hash)
  assert.deepEqual(projected.messages, [
    { role: 'user', content: '早期摘要' },
    { role: 'user', content: '当前问题' },
    { role: 'assistant', content: '当前回答' },
  ])
  assert.doesNotMatch(JSON.stringify(projected.messages), /m-1|r-1/u)
})

test('Snapshot V2 恢复遇到旧版未脱敏 checkpoint 时 fail closed', () => {
  const unsafeCheckpoint = 'api_key=legacy-secret https://private.example/internal'
  assert.throws(
    () => projectAgentThreadContextSnapshotV2({
      version: 2,
      modelPolicy: policy,
      checkpoint: {
        role: 'user',
        content: unsafeCheckpoint,
        contentHash: canonicalHash(unsafeCheckpoint),
      },
      messages: [{ id: 'm-current', revision: 'r-current', role: 'user', content: '当前问题' }],
    }, 'model-a'),
    (error) => error instanceof AgentModelContextBindingError
      && error.code === 'AGENT_CONTEXT_SNAPSHOT_UNSAFE'
      && !error.message.includes('legacy-secret')
      && !error.message.includes('private.example'),
  )
})

test('Model Context factory 按实际模型与 runtime identity 解析并绑定策略', () => {
  const calls = []
  const identity = { turnId: 'turn-1' }
  const binding = resolveAgentModelContextBinding({
    runtimeIdentity: identity,
    modelContextForModel: (model, runtimeIdentity) => {
      calls.push({ model, runtimeIdentity })
      return runtime
    },
  }, 'model-a', policy)
  assert.equal(binding.modelContext, runtime)
  assert.equal(binding.contextPolicyHash, policy.hash)
  assert.deepEqual(calls, [{ model: 'model-a', runtimeIdentity: identity }])
})

test('Snapshot V2 缺 runtime、策略漂移或模型漂移均 fail closed', () => {
  assert.throws(
    () => resolveAgentModelContextBinding({}, 'model-a', policy),
    (error) => error instanceof AgentModelContextBindingError
      && error.code === 'AGENT_CONTEXT_RUNTIME_REQUIRED',
  )
  assert.throws(
    () => resolveAgentModelContextBinding({ modelContext: runtime }, 'model-b'),
    (error) => error.code === 'AGENT_CONTEXT_POLICY_MISMATCH',
  )
  assert.throws(
    () => resolveAgentModelContextBinding({ modelContext: runtime }, 'model-a', {
      ...policy,
      hash: 'forged-policy-hash',
    }),
    (error) => ['AGENT_CONTEXT_POLICY_INVALID', 'AGENT_CONTEXT_POLICY_MISMATCH'].includes(error.code),
  )
})

test('Runtime Request v2 绑定主模型快照策略，并按模型缓存独立 runtime', async () => {
  const input = {
    projectId: 'project-1', sessionId: 'session-1', plannerModel: 'model-a', locale: 'zh-CN',
    threadContextSnapshot: { version: 2, modelPolicy: policy },
  }
  const identity = { projectId: 'project-1', sessionId: 'session-1', turnId: 'turn-1' }
  const anchors = []
  const options = {
    runtimeIdentity: identity,
    persistAgentContextUsageAnchor: async (anchor) => { anchors.push(anchor) },
  }
  const bound = bindAgentModelContextOptions(input, {
    flockTextModel: 'model-a',
    agentModelContextPolicies: {
      models: { 'vision-a': { contextWindowTokens: 24_000, outputReserveTokens: 2_000 } },
    },
  }, options)
  const primary = bound.modelContextForModel('model-a', identity)
  const primaryAgain = bound.modelContextForModel('model-a', identity)
  const secondary = bound.modelContextForModel('vision-a', identity)
  assert.equal(primary, primaryAgain)
  assert.equal(primary.policy.hash, policy.hash)
  assert.equal(secondary.policy.model, 'vision-a')
  assert.notEqual(secondary.policy.hash, primary.policy.hash)

  const prepared = await primary.prepare({
    messages: [{ role: 'user', content: '继续' }], tools: [], maxOutputTokens: 100,
  })
  await primary.observe({
    step: 0,
    prepared: prepared.prepared,
    responseUsage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
  })
  assert.equal(anchors.length, 1)
  assert.equal(anchors[0].turnId, 'turn-1')
})

test('Runtime Request v1 保留原 options 引用；v2 校验 project/session 身份', () => {
  const options = { runtimeIdentity: { projectId: 'project-1', sessionId: 'session-1' } }
  assert.equal(bindAgentModelContextOptions({ threadContextSnapshot: { version: 1 } }, {}, options), options)
  assert.throws(
    () => bindAgentModelContextOptions({
      projectId: 'project-1', sessionId: 'session-other', plannerModel: 'model-a',
      threadContextSnapshot: { version: 2, modelPolicy: policy },
    }, {}, options),
    (error) => error.code === 'AGENT_CONTEXT_RUNTIME_IDENTITY_MISMATCH',
  )
})
