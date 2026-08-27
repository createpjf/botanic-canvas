import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentTurnSweep } from './agentTurnSweep.mjs'

const risks = { context_read: 'read', image_generate: 'costly' }
const toolRisk = (name) => risks[name]

function fakeStore(turns, eventsByTurn = {}) {
  const written = []
  const staleQueries = []
  const effectiveUpdatedAt = (turn) => Number(turn.updatedAt ?? turn.createdAt) || 0
  return {
    written,
    staleQueries,
    turns: () => turns,
    async listStaleAgentTurns({ after, limit = 25 } = {}) {
      staleQueries.push(after ? structuredClone(after) : undefined)
      return turns
        .toSorted((left, right) => effectiveUpdatedAt(left) - effectiveUpdatedAt(right)
          || String(left.id).localeCompare(String(right.id)))
        .filter((turn) => !after
          || effectiveUpdatedAt(turn) > after.updatedAt
          || (effectiveUpdatedAt(turn) === after.updatedAt && String(turn.id) > after.id))
        .slice(0, limit)
        .map((turn) => structuredClone(turn))
    },
    async listAgentTurnEvents(_ownerId, _projectId, turnId) {
      return (eventsByTurn[turnId] ?? []).map((event) => structuredClone(event))
    },
    async putAgentTurn(ownerId, turn) { written.push({ ownerId, turn: structuredClone(turn) }) },
  }
}

const staleTurn = (id, extra = {}) => ({
  id, ownerId: 'user-a', projectId: 'project-a', idempotencyKey: `key-${id}`,
  request: { instruction: `继续 ${id}` }, status: 'running', updatedAt: 0, ...extra,
})
const toolEvent = (toolName, status = 'succeeded') => ({ type: 'turn.tool', payload: { toolName, status } })

test('执行过 costly 工具的孤儿收敛为不可重放失败', async () => {
  const store = fakeStore([staleTurn('turn-1')], { 'turn-1': [toolEvent('image_generate')] })
  const summary = await createAgentTurnSweep({ productStore: store, toolRisk, now: () => 1_000_000 })()

  assert.deepEqual(summary, { scanned: 1, resumed: 0, failed: 1, cancelled: 0, skipped: 0 })
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

  assert.deepEqual(summary, { scanned: 1, resumed: 0, failed: 1, cancelled: 0, skipped: 0 })
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

  assert.deepEqual(summary, { scanned: 1, resumed: 1, failed: 0, cancelled: 0, skipped: 0 })
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
  assert.deepEqual(summary, { scanned: 2, resumed: 0, failed: 1, cancelled: 0, skipped: 1 })
  assert.equal(store.written.length, 1)
  assert.equal(store.written[0].turn.id, 'turn-good')
  assert.ok(observed.some((event) => event.event === 'agent.turn.reclaim.error' && event.code === 'BROKEN'))
})

test('无陈旧 Turn 时返回空汇总且不写任何东西', async () => {
  const store = fakeStore([])
  assert.deepEqual(
    await createAgentTurnSweep({ productStore: store, toolRisk })(),
    { scanned: 0, resumed: 0, failed: 0, cancelled: 0, skipped: 0 },
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

test('cancelling Turn 只交给取消收敛，绝不重新调用 resolver', async () => {
  const store = fakeStore([staleTurn('turn-cancelling', { status: 'cancelling' })])
  const cancelled = []
  const resumed = []
  const summary = await createAgentTurnSweep({
    productStore: store,
    now: () => 1_000_000,
    cancelTurn: async (turn) => { cancelled.push(turn.id); return { status: 'cancelled' } },
    resumeTurn: async (turn) => { resumed.push(turn.id) },
  })()
  assert.deepEqual(summary, { scanned: 1, resumed: 0, failed: 0, cancelled: 1, skipped: 0 })
  assert.deepEqual(cancelled, ['turn-cancelling'])
  assert.deepEqual(resumed, [])
})

test('取消编排仍停在 cancelling 时不误计 cancelled 终态', async () => {
  const store = fakeStore([staleTurn('turn-cancelling-pending', { status: 'cancelling' })])
  const summary = await createAgentTurnSweep({
    productStore: store,
    now: () => 1_000_000,
    cancelTurn: async () => ({ kind: 'cancelling', status: 'cancelling' }),
  })()

  assert.deepEqual(summary, { scanned: 1, resumed: 0, failed: 0, cancelled: 0, skipped: 1 })
})

test('跨轮 cursor 越过满页 poison Turn，并在短尾页后 wrap', async () => {
  const store = fakeStore([
    staleTurn('turn-poison-a', { updatedAt: 1 }),
    staleTurn('turn-poison-b', { updatedAt: 1 }),
    staleTurn('turn-tail', { updatedAt: 2 }),
  ], {
    'turn-tail': [toolEvent('image_generate')],
  })
  const originalList = store.listAgentTurnEvents
  store.listAgentTurnEvents = async (ownerId, projectId, turnId) => {
    if (turnId.startsWith('turn-poison')) throw Object.assign(new Error('poison'), { code: 'BROKEN' })
    return originalList(ownerId, projectId, turnId)
  }
  const sweep = createAgentTurnSweep({
    productStore: store,
    toolRisk,
    limit: 2,
    now: () => 1_000_000,
  })

  const first = await sweep()
  const second = await sweep()
  const third = await sweep()

  assert.deepEqual(first, { scanned: 2, resumed: 0, failed: 0, cancelled: 0, skipped: 2 })
  assert.deepEqual(second, { scanned: 1, resumed: 0, failed: 1, cancelled: 0, skipped: 0 })
  assert.equal(store.written.some(({ turn }) => turn.id === 'turn-tail'), true,
    '满页 poison 数据不能让尾部 Turn 永久饥饿')
  assert.deepEqual(store.staleQueries, [
    undefined,
    { updatedAt: 1, id: 'turn-poison-b' },
    undefined,
  ])
  assert.deepEqual(third, { scanned: 2, resumed: 0, failed: 0, cancelled: 0, skipped: 2 },
    '短尾页处理完后，下一轮应从头 wrap')
})

test('legacy Turn 缺 updatedAt 时 cursor 使用 Store 同源 createdAt', async () => {
  const store = fakeStore([
    staleTurn('legacy-a', { updatedAt: undefined, createdAt: 7 }),
    staleTurn('legacy-b', { updatedAt: undefined, createdAt: 7 }),
    staleTurn('legacy-tail', { updatedAt: undefined, createdAt: 8 }),
  ], {
    'legacy-a': [toolEvent('image_generate')],
    'legacy-b': [toolEvent('image_generate')],
    'legacy-tail': [toolEvent('image_generate')],
  })
  const sweep = createAgentTurnSweep({ productStore: store, toolRisk, limit: 2, now: () => 1_000_000 })

  await sweep()
  await sweep()

  assert.deepEqual(store.staleQueries, [undefined, { updatedAt: 7, id: 'legacy-b' }])
  assert.equal(store.written.some(({ turn }) => turn.id === 'legacy-tail'), true)
})

test('缺 request 是永久恢复错误，同一次 sweep 必须交给 durable fail 收口', async () => {
  const missingRequest = staleTurn('turn-request-missing', {
    idempotencyKey: 'legacy-key',
    request: undefined,
    execution: { generation: 1, leaseToken: 'expired', leaseExpiresAt: 1 },
  })
  const store = fakeStore([missingRequest])
  const resumed = []
  const settled = []
  const summary = await createAgentTurnSweep({
    productStore: store,
    now: () => 1_000_000,
    resumeTurn: async (turn) => { resumed.push(turn.id) },
    settleTurn: async (turn, error) => {
      settled.push({ turnId: turn.id, error })
      return { ...turn, status: 'failed', error }
    },
  })()

  assert.deepEqual(resumed, [], '缺少 immutable request 时不得进入恢复器')
  assert.equal(settled.length, 1)
  assert.equal(settled[0].error.code, 'AGENT_TURN_REQUEST_MISSING')
  assert.deepEqual(summary, { scanned: 1, resumed: 0, failed: 1, cancelled: 0, skipped: 0 })
})

test('takeover race 未得到 failed 终态时 fail closed，汇总不得误计 failed', async () => {
  const source = staleTurn('turn-takeover-race', {
    idempotencyKey: 'same',
    request: { instruction: '继续' },
    execution: { generation: 1, leaseToken: 'expired', leaseExpiresAt: 1 },
  })
  const store = fakeStore([source], { [source.id]: [toolEvent('image_generate')] })
  const summary = await createAgentTurnSweep({
    productStore: store,
    toolRisk,
    now: () => 1_000_000,
    settleTurn: async () => ({
      ...source,
      status: 'running',
      execution: { generation: 2, leaseToken: 'takeover-winner', leaseExpiresAt: 2_000_000 },
    }),
  })()

  assert.deepEqual(summary, { scanned: 1, resumed: 0, failed: 0, cancelled: 0, skipped: 1 })
})

test('缺少 ProductStore 时立即拒绝构造', () => {
  assert.throws(() => createAgentTurnSweep({}), /缺少 ProductStore/u)
})
