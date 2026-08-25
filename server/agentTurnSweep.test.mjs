import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentTurnSweep } from './agentTurnSweep.mjs'

const risks = { context_read: 'read', image_generate: 'costly' }
const toolRisk = (name) => risks[name]

function fakeStore(turns, eventsByTurn = {}) {
  const written = []
  return {
    written,
    turns: () => turns,
    async listStaleAgentTurns() { return turns.map((turn) => structuredClone(turn)) },
    async listAgentTurnEvents(_ownerId, _projectId, turnId) {
      return (eventsByTurn[turnId] ?? []).map((event) => structuredClone(event))
    },
    async putAgentTurn(ownerId, turn) { written.push({ ownerId, turn: structuredClone(turn) }) },
  }
}

const staleTurn = (id, extra = {}) => ({
  id, ownerId: 'user-a', projectId: 'project-a', status: 'running', updatedAt: 0, ...extra,
})
const toolEvent = (toolName, status = 'succeeded') => ({ type: 'turn.tool', payload: { toolName, status } })

test('执行过 costly 工具的孤儿收敛为不可重放失败', async () => {
  const store = fakeStore([staleTurn('turn-1')], { 'turn-1': [toolEvent('image_generate')] })
  const summary = await createAgentTurnSweep({ productStore: store, toolRisk, now: () => 1_000_000 })()

  assert.deepEqual(summary, { scanned: 1, resumed: 0, failed: 1, skipped: 0 })
  assert.equal(store.written.length, 1)
  assert.equal(store.written[0].ownerId, 'user-a')
  assert.equal(store.written[0].turn.status, 'failed')
  assert.equal(store.written[0].turn.error.code, 'AGENT_TURN_NOT_REPLAYABLE')
  assert.equal(store.written[0].turn.error.stage, 'turn')
})

test('可恢复但未配置恢复能力时，用 ABANDONED 与不可重放区分开', async () => {
  // 只执行过只读工具 → 判定可恢复；但没有注入 resumeTurn。
  const store = fakeStore([staleTurn('turn-2')], { 'turn-2': [toolEvent('context_read')] })
  const summary = await createAgentTurnSweep({ productStore: store, toolRisk, now: () => 1_000_000 })()

  assert.deepEqual(summary, { scanned: 1, resumed: 0, failed: 1, skipped: 0 })
  assert.equal(store.written[0].turn.error.code, 'AGENT_TURN_ABANDONED')
  assert.equal(store.written[0].turn.error.recoverable, true, '标记为本可恢复，便于后续接上恢复能力时排查')
})

test('注入恢复能力后，可恢复的孤儿交给它而不落失败', async () => {
  const resumed = []
  const store = fakeStore([staleTurn('turn-3')], { 'turn-3': [toolEvent('context_read')] })
  const summary = await createAgentTurnSweep({
    productStore: store, toolRisk, now: () => 1_000_000,
    resumeTurn: async (turn) => { resumed.push(turn.id) },
  })()

  assert.deepEqual(summary, { scanned: 1, resumed: 1, failed: 0, skipped: 0 })
  assert.deepEqual(resumed, ['turn-3'])
  assert.equal(store.written.length, 0, '交给恢复能力后不应再写失败')
})

test('没有工具风险查找时一律按最高风险处理，不乐观恢复', async () => {
  const store = fakeStore([staleTurn('turn-4')], { 'turn-4': [toolEvent('context_read')] })
  const resumed = []
  const summary = await createAgentTurnSweep({
    productStore: store, now: () => 1_000_000,
    resumeTurn: async (turn) => { resumed.push(turn.id) },
  })()

  assert.equal(summary.failed, 1)
  assert.deepEqual(resumed, [], '查不到能力时不得当成只读而恢复')
  assert.equal(store.written[0].turn.error.code, 'AGENT_TURN_NOT_REPLAYABLE')
})

test('单个 Turn 出错不中断整批清扫', async () => {
  const store = fakeStore(
    [staleTurn('turn-bad'), staleTurn('turn-good')],
    { 'turn-good': [toolEvent('image_generate')] },
  )
  // 第一个 Turn 取事件时抛错。
  const originalList = store.listAgentTurnEvents
  store.listAgentTurnEvents = async (ownerId, projectId, turnId) => {
    if (turnId === 'turn-bad') throw Object.assign(new Error('数据损坏'), { code: 'BROKEN' })
    return originalList(ownerId, projectId, turnId)
  }
  const observed = []
  const summary = await createAgentTurnSweep({
    productStore: store, toolRisk, now: () => 1_000_000, observe: (event) => observed.push(event),
  })()

  // 一条坏数据不能让其余孤儿永远得不到回收。
  assert.deepEqual(summary, { scanned: 2, resumed: 0, failed: 1, skipped: 1 })
  assert.equal(store.written.length, 1)
  assert.equal(store.written[0].turn.id, 'turn-good')
  assert.ok(observed.some((event) => event.event === 'agent.turn.reclaim.error' && event.code === 'BROKEN'))
})

test('无陈旧 Turn 时返回空汇总且不写任何东西', async () => {
  const store = fakeStore([])
  assert.deepEqual(
    await createAgentTurnSweep({ productStore: store, toolRisk })(),
    { scanned: 0, resumed: 0, failed: 0, skipped: 0 },
  )
  assert.equal(store.written.length, 0)
})

test('观测回调抛错不影响清扫结果', async () => {
  const store = fakeStore([staleTurn('turn-5')], { 'turn-5': [toolEvent('image_generate')] })
  const summary = await createAgentTurnSweep({
    productStore: store, toolRisk, now: () => 1_000_000,
    observe: () => { throw new Error('日志后端挂了') },
  })()
  assert.equal(summary.failed, 1)
  assert.equal(store.written[0].turn.status, 'failed')
})

test('缺少 ProductStore 时立即拒绝构造', () => {
  assert.throws(() => createAgentTurnSweep({}), /缺少 ProductStore/u)
})
