import assert from 'node:assert/strict'
import test from 'node:test'
import { createRolloutFlags, resolveAgentFeatureFlags } from './featureFlags.mjs'
import { agentContextRolloutHealth, resolveAgentContextRollout } from './agentContextRollout.mjs'

test('Context rollout 决策优先级为 kill > active > shadow > control', () => {
  const both = createRolloutFlags({
    AGENT_CONTEXT_COMPACTION_V2: 'true',
    AGENT_CONTEXT_COMPACTION_V2_SHADOW: 'true',
  })
  assert.deepEqual(resolveAgentContextRollout({
    featureFlags: resolveAgentFeatureFlags({ AGENT_CONTEXT_COMPACTION_V2_ENABLED: 'false' }),
    rolloutFlags: both,
  }), { mode: 'killed', servedVariant: 'legacy', rolloutMode: 'off' })
  assert.deepEqual(resolveAgentContextRollout({
    featureFlags: resolveAgentFeatureFlags({}), rolloutFlags: both,
  }), { mode: 'active', servedVariant: 'v2', rolloutMode: 'all' })
  assert.deepEqual(resolveAgentContextRollout({
    featureFlags: resolveAgentFeatureFlags({}),
    rolloutFlags: createRolloutFlags({ AGENT_CONTEXT_COMPACTION_V2_SHADOW: 'true' }),
  }), { mode: 'shadow', servedVariant: 'legacy', evaluatedVariant: 'v2', rolloutMode: 'all' })
  assert.deepEqual(resolveAgentContextRollout({
    featureFlags: resolveAgentFeatureFlags({}), rolloutFlags: createRolloutFlags({}),
  }), { mode: 'control', servedVariant: 'legacy', rolloutMode: 'off' })
})

test('Context rollout 支持项目灰度且健康摘要不泄漏 selector', () => {
  const rolloutFlags = createRolloutFlags({
    AGENT_CONTEXT_COMPACTION_V2_SHADOW: 'project:private-project',
  })
  assert.equal(resolveAgentContextRollout({
    featureFlags: resolveAgentFeatureFlags({}), rolloutFlags, projectId: 'private-project',
  }).mode, 'shadow')
  const health = agentContextRolloutHealth(resolveAgentFeatureFlags({}), rolloutFlags)
  assert.deepEqual(health.shadow, { mode: 'scoped', invalidSelectorCount: 0 })
  assert.doesNotMatch(JSON.stringify(health), /private-project/u)
})

test('runtime 总闸门也会关闭 Context V2', () => {
  const decision = resolveAgentContextRollout({
    featureFlags: resolveAgentFeatureFlags({ AGENT_RUNTIME_V2: 'false' }),
    rolloutFlags: createRolloutFlags({ AGENT_CONTEXT_COMPACTION_V2: 'true' }),
  })
  assert.equal(decision.mode, 'killed')
})
