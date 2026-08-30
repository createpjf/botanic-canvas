import assert from 'node:assert/strict'
import test from 'node:test'
import { assertAgentTargetBinding, createAgentTargetBinding } from './agentTargetBinding.mjs'

function document(image, overrides = {}) {
  return {
    id: 'project-target-binding', edges: [],
    nodes: [{
      id: 'result-1', type: 'result',
      data: { image, jobId: 'job-1', candidateId: 'candidate-1', versionId: 'version-1', ...overrides },
    }],
  }
}

test('TargetBinding 只允许 Turn 创建时冻结的媒体与结果版本', async () => {
  const input = { hasTarget: true, selectedResultNodeId: 'result-1' }
  const binding = await createAgentTargetBinding(document('data:image/png;base64,AQ=='), input, {
    projectRevision: 7,
    now: () => 100,
  })
  assert.equal(binding.artifactId, 'generation:job-1:candidate-1')
  await assert.doesNotReject(assertAgentTargetBinding(
    document('data:image/png;base64,AQ=='), { ...input, targetBinding: binding }, { projectRevision: 7 },
  ))
  await assert.rejects(
    assertAgentTargetBinding(document('data:image/png;base64,Ag=='), { ...input, targetBinding: binding }),
    (caught) => caught?.code === 'AGENT_TARGET_STALE',
  )
  await assert.rejects(
    assertAgentTargetBinding(
      document('data:image/png;base64,AQ==', { candidateId: 'candidate-recreated' }),
      { ...input, targetBinding: binding },
    ),
    (caught) => caught?.code === 'AGENT_TARGET_STALE',
  )
  await assert.doesNotReject(
    assertAgentTargetBinding(
      document('data:image/png;base64,AQ=='),
      { ...input, targetBinding: binding },
      { projectRevision: 8 },
    ),
  )
})
