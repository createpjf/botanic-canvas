import assert from 'node:assert/strict'
import test from 'node:test'
import { persistentBotanicAgentMessageBody } from './agentMessagePersistence.ts'

test('独立 Message PUT DTO 携带 durable turnId 与跨刷新取消意图', () => {
  assert.deepEqual(persistentBotanicAgentMessageBody({
    id: 'message-turn', role: 'user', kind: 'text', content: '继续优化', createdAt: 2,
    turnId: 'turn-durable', turnCancellationRequestedAt: 123,
  }), {
    id: 'message-turn', role: 'user', kind: 'text', content: '继续优化', createdAt: 2,
    turnId: 'turn-durable', turnCancellationRequestedAt: 123,
  })
})

test('pending Message PUT 携带 pre-server Turn request snapshot', () => {
  const body = persistentBotanicAgentMessageBody({
    id: 'message-pending', role: 'user', kind: 'text', content: '换背景', createdAt: 2,
    status: 'pending',
    turnRequestSnapshot: {
      locale: 'zh-CN', plannerModel: 'planner-a', showRawReasoning: true, mountedSkillIds: ['skill-a'],
      contextNodeIds: ['result-b'], hasTarget: true,
      selectedResultNodeId: 'result-b', selectedResultLabel: '结果 B', executionMode: 'auto',
      generationModels: [{ id: 'image-a', label: '图像 A', mediaKind: 'image' }],
      maxOutputCount: 6,
    },
  })
  assert.equal(body.turnRequestSnapshot?.selectedResultNodeId, 'result-b')
  assert.equal(body.turnRequestSnapshot?.plannerModel, 'planner-a')
  assert.equal(body.turnRequestSnapshot?.showRawReasoning, true)
})

test('稳定助手消息的 entityReferences 不由客户端 PUT 回传，服务端从 Turn 覆盖', () => {
  const body = persistentBotanicAgentMessageBody({
    id: 'agent-turn-result-turn-refs', role: 'assistant', kind: 'text', content: '完成',
    createdAt: 2, turnId: 'turn-refs',
    entityReferences: [{ type: 'agent_run', id: 'run-1' }],
  })
  assert.equal('entityReferences' in body, false)
})
