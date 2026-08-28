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

test('queued/running 可恢复，waiting_user 等用户，cancelling 只走取消收敛', () => {
  for (const status of ['queued', 'running']) {
    const decision = turnReclaimDecision({ turn: { id: 'turn-1', status, updatedAt: 0 }, now: 10_000_000, toolRisk })
    assert.equal(decision.action, 'resume', `${status} 应参与回收`)
  }
  assert.deepEqual(turnReclaimDecision({ turn: { id: 'turn-1', status: 'waiting_user', updatedAt: 0 }, now: 10_000_000, toolRisk }), { action: 'skip', reason: 'waiting_user' })
  assert.deepEqual(turnReclaimDecision({ turn: { id: 'turn-1', status: 'cancelling', updatedAt: 0 }, now: 10_000_000, toolRisk }), { action: 'cancel' })
})

test('只执行过只读工具的 Turn 可以恢复，read 工具重放不计费', () => {
  const decision = turnReclaimDecision({
    turn: stale, now: 10_000_000, toolRisk,
    events: [toolEvent('context_read'), toolEvent('web_search')],
  })
  assert.deepEqual(decision, { action: 'resume', replayedToolCount: 2 })
})

test('有 checkpoint 时按 recovery 而非 risk：costly 规划工具声明 reexecute 仍可恢复', () => {
  const checkpoint = {
    version: 1,
    attempt: { id: 'text', model: 'model-a', snapshotHash: 'snapshot-a' },
    completedSteps: [{
      step: 0,
      calls: [{
        id: 'call-generate', name: 'generate_images', risk: 'costly', recovery: 'reexecute', terminal: true,
        arguments: { prompt: '海边品牌首图', count: 2 },
      }],
    }],
  }
  const decision = turnReclaimDecision({
    turn: { ...stale, checkpoint },
    now: 10_000_000,
    // 即使遗留事件按 costly 记录，也必须以 checkpoint recovery 为准。
    events: [toolEvent('generate_images')],
    toolRisk,
  })
  assert.deepEqual(decision, { action: 'resume', replayedToolCount: 1 })
})

test('checkpoint 中 receipt 交给持久化回执恢复，web never 仍阻止恢复，损坏 checkpoint 明确失败', () => {
  const base = {
    version: 1,
    attempt: { id: 'text', model: 'model-a', snapshotHash: 'snapshot-a' },
    completedSteps: [],
  }
  const decisionFor = (call) => turnReclaimDecision({
    turn: { ...stale, checkpoint: { ...base, pendingStep: { step: 0, calls: [call] } } },
    now: 10_000_000,
  })
  const web = decisionFor({
    id: 'call-web', name: 'web_search', risk: 'read', recovery: 'never', terminal: false,
  })
  assert.equal(web.action, 'fail')
  assert.equal(web.code, 'AGENT_TURN_NOT_REPLAYABLE')
  assert.match(web.message, /web_search/u)

  const receipt = decisionFor({
    id: 'call-submit', name: 'generation_submit', risk: 'costly', recovery: 'receipt', terminal: true,
    receiptId: 'receipt-1', intentHash: 'intent-1',
  })
  assert.deepEqual(receipt, { action: 'resume', replayedToolCount: 0 })

  const damaged = turnReclaimDecision({
    turn: { ...stale, checkpoint: { version: 999, secret: '不得回显' } },
    now: 10_000_000,
  })
  assert.equal(damaged.action, 'fail')
  assert.equal(damaged.code, 'AGENT_TURN_CHECKPOINT_INVALID')
  assert.doesNotMatch(JSON.stringify(damaged), /不得回显/u)
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

test('running 的非读工具按结果未知阻止重放，明确 failed 才不构成成功副作用', () => {
  const decision = turnReclaimDecision({
    turn: stale, now: 10_000_000, toolRisk,
    events: [toolEvent('image_generate', 'running'), toolEvent('workflow_publish', 'failed'), toolEvent('context_read')],
  })
  assert.equal(decision.action, 'fail')
  assert.equal(decision.code, 'AGENT_TURN_NOT_REPLAYABLE')
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

test('事件自带的 risk 优先于按工具名查找，历史风险不被后来的改动改写', () => {
  const stale = { id: 'turn-1', status: 'running', updatedAt: 0 }
  const event = (toolName, risk) => ({ type: 'turn.tool', payload: { toolName, status: 'succeeded', risk } })

  // 事件说 read，即使当前注册表把这个名字标成了 costly，也按事件为准 ——
  // 该次调用当时确实是只读的。
  assert.equal(
    turnReclaimDecision({ turn: stale, now: 10_000_000, toolRisk: () => 'costly', events: [event('renamed_tool', 'read')] }).action,
    'resume',
  )
  // 反向同理：事件说 costly 就不可重放，哪怕现在查出来是 read。
  assert.equal(
    turnReclaimDecision({ turn: stale, now: 10_000_000, toolRisk: () => 'read', events: [event('renamed_tool', 'costly')] }).action,
    'fail',
  )
})

test('事件没有 risk 时回落到工具名查找，仍查不到则按未知处理', () => {
  const stale = { id: 'turn-1', status: 'running', updatedAt: 0 }
  const legacy = { type: 'turn.tool', payload: { toolName: 'context_read', status: 'succeeded' } }

  // 早于 risk 字段落地的历史事件靠查找兜底。
  assert.equal(
    turnReclaimDecision({ turn: stale, now: 10_000_000, toolRisk: () => 'read', events: [legacy] }).action,
    'resume',
  )
  // 两边都没有 → 未知 → 不可重放，不乐观放行。
  assert.equal(turnReclaimDecision({ turn: stale, now: 10_000_000, events: [legacy] }).action, 'fail')
})
