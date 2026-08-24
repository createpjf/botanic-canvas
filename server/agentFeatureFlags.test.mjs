import test from 'node:test'
import assert from 'node:assert/strict'
import { agentFeatureEnabled, resolveAgentFeatureFlags } from './agentFeatureFlags.mjs'

test('Agent V2 flags默认启用，便于完整升级后直接生效', () => {
  assert.deepEqual(resolveAgentFeatureFlags({}), {
    runtimeV2: true,
    qualityV2: true,
    memoryV2: true,
    skillGovernanceV2: true,
    forkCompareV2: true,
  })
})

test('Agent V2 flags accept common truthy values and expose stable lookups', () => {
  const flags = resolveAgentFeatureFlags({
    AGENT_RUNTIME_V2: 'true',
    AGENT_QUALITY_V2: '1',
    AGENT_MEMORY_V2: 'on',
    AGENT_SKILL_GOVERNANCE_V2: 'yes',
    AGENT_FORK_COMPARE_V2: 'false',
  })
  assert.equal(agentFeatureEnabled(flags, 'runtimeV2'), true)
  assert.equal(agentFeatureEnabled(flags, 'qualityV2'), true)
  assert.equal(agentFeatureEnabled(flags, 'memoryV2'), true)
  assert.equal(agentFeatureEnabled(flags, 'skillGovernanceV2'), true)
  assert.equal(agentFeatureEnabled(flags, 'forkCompareV2'), false)
})
