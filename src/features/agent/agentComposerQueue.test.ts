import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AGENT_COMPOSER_QUEUE_LIMIT,
  agentInstructionQueueSettlement,
  agentQueuedInstructionPreview,
  enqueueAgentInstruction,
  removeAgentQueuedInstruction,
  resolveAgentInstructionExecutionContext,
  shiftAgentQueuedInstruction,
  type AgentInstructionExecutionSnapshot,
  type AgentQueuedInstruction,
} from './agentComposerQueue.ts'

const snapshot: AgentInstructionExecutionSnapshot = {
  plannerModel: 'model-a', executionMode: 'manual', mountedSkillIds: ['skill-a'],
  sessionContextNodeIds: ['node-a'], contextItems: [{ id: 'node-a', label: '参考图', kind: '素材' }],
  targetNodeId: 'target-a', groupId: 'group-a', intent: 'generate', generationOverrides: { aspectRatio: '1:1' },
}
const item = (index: number): AgentQueuedInstruction => ({
  id: `queue-${index}`, instruction: `指令 ${index}`, content: `指令 ${index}`,
  mentions: [], queuedAt: index, snapshot,
})

test('queue 最多3条且 FIFO/删除/预览稳定,不提前创建消息', () => {
  let queue: AgentQueuedInstruction[] = []
  for (let index = 0; index < AGENT_COMPOSER_QUEUE_LIMIT; index += 1) {
    const result = enqueueAgentInstruction(queue, item(index))
    assert.equal(result.accepted, true)
    queue = result.queue
  }
  assert.equal(enqueueAgentInstruction(queue, item(99)).accepted, false)
  const shifted = shiftAgentQueuedInstruction(queue)
  assert.equal(shifted.item?.id, 'queue-0')
  assert.deepEqual(removeAgentQueuedInstruction(shifted.queue, 'queue-1').map((entry) => entry.id), ['queue-2'])
  assert.equal(agentQueuedInstructionPreview({ ...item(0), content: 'x'.repeat(100) }).endsWith('…'), true)
})

test('settlement 只在 completed 执行,failed/idle空输入弹回;快照覆盖flush时UI且target fail closed', () => {
  assert.equal(agentInstructionQueueSettlement({ queueLength: 1, planning: true, runtimePhase: 'completed', instruction: '' }), 'wait')
  assert.equal(agentInstructionQueueSettlement({ queueLength: 1, planning: false, runtimePhase: 'completed', instruction: '' }), 'execute')
  assert.equal(agentInstructionQueueSettlement({ queueLength: 1, planning: false, runtimePhase: 'failed', instruction: '' }), 'restore')
  assert.equal(agentInstructionQueueSettlement({ queueLength: 1, planning: false, runtimePhase: 'failed', instruction: '新草稿' }), 'wait')
  const resolved = resolveAgentInstructionExecutionContext({
    snapshot,
    current: { ...snapshot, plannerModel: 'model-new', mountedSkillIds: ['skill-new'] },
    currentTarget: undefined,
    explicitTargetProvided: false,
    resolveTarget: () => undefined,
  })
  assert.equal(resolved.plannerModel, 'model-a')
  assert.deepEqual(resolved.mountedSkillIds, ['skill-a'])
  assert.equal(resolved.target, undefined)
  assert.equal(resolved.targetNodeId, null)
})
