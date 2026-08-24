import assert from 'node:assert/strict'
import test from 'node:test'
import { turnReclaimDecision } from './turnReclaim.mjs'

const risks = { context_read: 'read', web_search: 'read', image_generate: 'costly', workflow_publish: 'write', notify_slack: 'external' }
const toolRisk = (name) => risks[name]
const toolEvent = (toolName, status = 'succeeded') => ({ type: 'turn.tool', payload: { toolName, status } })
const stale = { id: 'turn-1', status: 'running', updatedAt: 0 }

test('终态 Turn 与租约内的 Turn 都不回收', () => {
  for (const status of ['completed', 'failed', 'cancelled']) {
    assert.deepEqual(
      turnReclaimDecision({ turn: { id: 'turn-1', status, updatedAt: 0 }, now: 10_000_000 }),
      { action: 'skip', reason: 'terminal' },
    )
  }
  // 还在租约内说明可能仍有实例在推进，不抢。
  assert.deepEqual(
    turnReclaimDecision({ turn: { id: 'turn-1', status: 'running', updatedAt: 9_950_000 }, now: 10_000_000, leaseMs: 120_000 }),
    { action: 'skip', reason: 'within_lease' },
  )
  assert.deepEqual(turnReclaimDecision({}), { action: 'skip', reason: 'missing_turn' })
})

test('四个非终态都参与回收，包括一出生就是 running 的孤儿', () => {
  for (const status of ['queued', 'running', 'waiting_user', 'cancelling']) {
    const decision = turnReclaimDecision({ turn: { id: 'turn-1', status, updatedAt: 0 }, now: 10_000_000, toolRisk })
    assert.equal(decision.action, 'resume', `${status} 应参与回收`)
  }
})

test('只执行过只读工具的 Turn 可以恢复，read 工具重放不计费', () => {
  const decision = turnReclaimDecision({
    turn: stale, now: 10_000_000, toolRisk,
    events: [toolEvent('context_read'), toolEvent('web_search')],
  })
  assert.deepEqual(decision, { action: 'resume', replayedToolCount: 2 })
})

test('执行过 costly / write / external 的 Turn 不可恢复，避免重复计费与重复副作用', () => {
  for (const name of ['image_generate', 'workflow_publish', 'notify_slack']) {
    const decision = turnReclaimDecision({ turn: stale, now: 10_000_000, toolRisk, events: [toolEvent(name)] })
    assert.equal(decision.action, 'fail', `${name} 应阻止恢复`)
    assert.equal(decision.stage, 'turn')
    assert.equal(decision.code, 'AGENT_TURN_NOT_REPLAYABLE')
    assert.equal(decision.recoverable, false)
    assert.match(decision.message, new RegExp(name, 'u'))
  }
})

test('能力查不到的工具按最高风险处理，不乐观当成只读', () => {
  const decision = turnReclaimDecision({ turn: stale, now: 10_000_000, toolRisk, events: [toolEvent('mystery_tool')] })
  assert.equal(decision.action, 'fail')
  // 没有传 toolRisk 时同理：全部工具都判不出能力，一律不可重放。
  const withoutLookup = turnReclaimDecision({ turn: stale, now: 10_000_000, events: [toolEvent('context_read')] })
  assert.equal(withoutLookup.action, 'fail')
})

test('未完成的工具不构成重放障碍', () => {
  // running 没有副作用保证，failed 没有成功副作用；两者都不该阻止恢复。
  const decision = turnReclaimDecision({
    turn: stale, now: 10_000_000, toolRisk,
    events: [toolEvent('image_generate', 'running'), toolEvent('workflow_publish', 'failed'), toolEvent('context_read')],
  })
  assert.deepEqual(decision, { action: 'resume', replayedToolCount: 1 })
})

test('失败原因只含工具名，不泄漏参数或输出', () => {
  const decision = turnReclaimDecision({
    turn: stale, now: 10_000_000, toolRisk,
    events: [{ type: 'turn.tool', payload: { toolName: 'image_generate', status: 'succeeded', prompt: '机密提示词', url: 'https://cdn.example.com/x.png' } }],
  })
  assert.equal(decision.action, 'fail')
  assert.doesNotMatch(JSON.stringify(decision), /机密提示词|cdn\.example\.com/u)
})

test('同一工具多次执行在原因里只出现一次', () => {
  const decision = turnReclaimDecision({
    turn: stale, now: 10_000_000, toolRisk,
    events: [toolEvent('image_generate'), toolEvent('image_generate'), toolEvent('image_generate')],
  })
  assert.equal(decision.action, 'fail')
  assert.equal(decision.message.match(/image_generate/gu)?.length, 1)
})

test('非工具事件被忽略，不误判成已执行的工具', () => {
  const decision = turnReclaimDecision({
    turn: stale, now: 10_000_000, toolRisk,
    events: [{ type: 'turn.started' }, { type: 'turn.completed' }, { type: 'turn.tool' }],
  })
  assert.deepEqual(decision, { action: 'resume', replayedToolCount: 0 })
})
