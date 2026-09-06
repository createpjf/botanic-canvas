import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveBotanicAgentResultSelection, type BotanicAgentArtifact } from './agent.ts'
import { agentArtifactTargetNodeIds } from './agentArtifactTargets.ts'

test('编辑产物只定位和引用新结果；父图与辅助图继续保留在血缘中', () => {
  const artifact: BotanicAgentArtifact = {
    id: 'edited', kind: 'image', label: '蓝底银杏', url: '/new.png',
    metadata: { source: 'generation', parentNodeId: 'second', inputProvenance: { references: [{ nodeId: 'reference' }], parent: { nodeId: 'second' } } },
    provenance: { actionId: 'generation:job', toolName: 'image_generation', sourceNodeIds: ['reference', 'second', 'new'] },
  }
  assert.deepEqual(resolveBotanicAgentResultSelection([artifact], ['edited']).sourceNodeIds, ['new'])
  assert.deepEqual(agentArtifactTargetNodeIds(artifact), ['new'])
  assert.deepEqual(artifact.provenance.sourceNodeIds, ['reference', 'second', 'new'])
  assert.deepEqual(agentArtifactTargetNodeIds({ ...artifact, provenance: { ...artifact.provenance, sourceNodeIds: ['second'] } }), [])
  const action = { ...artifact, metadata: { source: 'action' } }
  assert.deepEqual(agentArtifactTargetNodeIds(action), ['reference', 'second', 'new'])
})
