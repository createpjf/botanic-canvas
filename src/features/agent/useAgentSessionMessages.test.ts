import assert from 'node:assert/strict'
import test from 'node:test'
import type { BotanicAgentMessage, BotanicAgentRun } from '../../domain/agent.ts'
import { mergeAgentMessages } from '../../domain/agentMessageReadModel.ts'
import { botanicAgentBranchId, botanicAgentSubmissionKey } from '../../domain/agentRuntimeFeed.ts'

test('计划回包丢失后按原提交身份关联Run，不复活失败确认或串到其他任务', () => {
  const message = { id: 'plan-original', role: 'assistant', kind: 'plan', status: 'failed', createdAt: 10,
    plan: { instruction: '白色植物', prompt: '白色植物', settings: { model: 'gpt-image-2' }, output: { count: 1 } },
  } as BotanicAgentMessage
  const branchId = botanicAgentBranchId(botanicAgentSubmissionKey(message.id, message.plan!), 0)
  const run = { id: 'accepted-run', status: 'completed', branches: [{ id: branchId }] } as BotanicAgentRun
  const [projected] = mergeAgentMessages([message], [], [run])
  assert.equal(projected.runId, run.id)
  assert.equal(projected.status, 'submitted')
  assert.equal(message.runId, undefined, '读取投影不修改已存Message或创建结果')
  assert.equal(mergeAgentMessages([message], [], [run, { ...run, id: 'ambiguous-run' }])[0], message)
  assert.equal(mergeAgentMessages([{ ...message, runId: 'other-run' }], [], [run])[0].runId, 'other-run')
  assert.equal(mergeAgentMessages([{ ...message, id: 'other-plan' }], [], [run])[0].runId, undefined)
  const restored = { ...message, turnId: 'original-turn', plan: { ...message.plan!, turnId: 'original-turn' } }
  const linked = { ...run, branches: [], plan: restored.plan }
  assert.equal(mergeAgentMessages([restored], [], [linked])[0].runId, linked.id, '序列化后的计划仅凭唯一权威Turn关联恢复，不重算或更改幂等键')
  assert.equal(mergeAgentMessages([restored], [], [linked, { ...linked, id: 'second-run' }])[0].runId, undefined)
  assert.equal(mergeAgentMessages([{ ...restored, turnId: 'other-turn' }], [], [linked])[0].runId, undefined)
})

test('确认答案按原操作排在结果前，不改变真实时间或移动无关消息', () => {
  const reply: BotanicAgentMessage = { id: 'reply', role: 'assistant', kind: 'text', content: '最终 Prompt', prompt: '香水', sourceMessageId: 'input', createdAt: 2 }
  const answer: BotanicAgentMessage = { id: 'agent-answer-local', role: 'user', kind: 'text', content: '商业广告', sourceMessageId: 'input', createdAt: 3 }
  assert.deepEqual(mergeAgentMessages([reply], [answer]).map((item) => item.id), [answer.id, reply.id])
  assert.equal(reply.createdAt, 2)
  assert.deepEqual(mergeAgentMessages([reply], [{ ...answer, sourceMessageId: 'other-input' }]).map((item) => item.id), [reply.id, answer.id])
  assert.deepEqual(mergeAgentMessages([{ ...reply, turnId: 'original-turn' }], [{ ...answer, sourceMessageId: undefined, turnId: 'original-turn' }]).map((item) => item.id), [answer.id, reply.id])
})

test('full local upsert 用更新 updatedAt 立即压过 API 旧正文', () => {
  const apiMessage: BotanicAgentMessage = {
    id: 'stable-projection', role: 'assistant', kind: 'notice', content: 'API 旧投影',
    createdAt: 10, updatedAt: 500, status: 'answered', turnId: 'turn-stable',
  }
  const staleStoreMessage: BotanicAgentMessage = {
    ...apiMessage, content: 'Store 更旧副本', updatedAt: 100,
  }
  assert.equal(mergeAgentMessages([apiMessage], [staleStoreMessage])[0].content, 'API 旧投影')

  const locallyUpserted: BotanicAgentMessage = {
    ...apiMessage, content: '本地权威终态', updatedAt: 501, status: 'failed',
  }
  const merged = mergeAgentMessages([apiMessage], [locallyUpserted])[0]
  assert.equal(merged.content, '本地权威终态')
  assert.equal(merged.status, 'failed')
  assert.equal(merged.updatedAt, 501)
})

test('同一问题的已确认答案不被时钟领先的本地 pending 重新打开', () => {
  const pending: BotanicAgentMessage = {
    id: 'question', role: 'assistant', kind: 'question', status: 'pending', content: '', createdAt: 1, updatedAt: 200,
    question: { id: 'clarification', question: '设置', originalInstruction: '生成图片', fields: [] },
  }
  const answered: BotanicAgentMessage = { ...pending, status: 'answered', updatedAt: 100 }
  assert.equal(mergeAgentMessages([answered], [pending])[0].status, 'answered')
  assert.equal(mergeAgentMessages([pending], [answered])[0].status, 'answered')
  const conflicting = { ...answered, content: '另一设备的旧答案', updatedAt: 300 }
  assert.equal(mergeAgentMessages([answered], [conflicting])[0].content, answered.content)
  const nextQuestion = { ...pending, question: { ...pending.question!, id: 'next-question' } }
  assert.equal(mergeAgentMessages([nextQuestion], [conflicting])[0].question?.id, 'next-question')
  const question = { ...answered, id: 'agent-turn-result-turn-q', turnId: 'turn-q' }
  const plan: BotanicAgentMessage = { ...question, kind: 'plan', question: undefined, plan: { turnId: 'turn-q' } as BotanicAgentMessage['plan'] }
  assert.equal(mergeAgentMessages([plan], [{ ...question, updatedAt: 900 }])[0].kind, 'plan')
  assert.equal(mergeAgentMessages([{ ...question, updatedAt: 900 }], [plan])[0].kind, 'plan')
  const prompt: BotanicAgentMessage = { ...answered, kind: 'text', question: undefined, prompt: '香水广告' }
  assert.equal(mergeAgentMessages([pending], [prompt])[0].prompt, prompt.prompt)
  assert.equal(mergeAgentMessages([prompt], [pending])[0].kind, 'text')
})
