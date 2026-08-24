import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createProductStore } from './productStore.mjs'
import {
  assertProductStoreContract,
  productStoreCoreMethods,
  productStoreSupports,
  nonTerminalAgentTurnStatuses,
  normalizeStaleTurnQuery,
  normalizeTurnEventPage,
} from './productStoreContract.mjs'

function coreStore() {
  return Object.fromEntries(productStoreCoreMethods.map((method) => [method, () => undefined]))
}

test('ProductStore 契约明确报告缺失的核心能力', () => {
  const store = coreStore()
  delete store.readProject

  assert.throws(
    () => assertProductStoreContract(store, { adapter: 'BrokenStore' }),
    /BrokenStore 缺少 ProductStore 核心方法：readProject/,
  )
})

test('ProductStore 可选能力必须完整实现后才会暴露', () => {
  const store = coreStore()
  store.createMediaObject = () => undefined
  assert.equal(productStoreSupports(store, 'mediaObjects'), false)

  store.readMediaObject = () => undefined
  assert.equal(productStoreSupports(store, 'mediaObjects'), true)
})

test('本地 ProductStore 满足核心契约和成员管理能力', () => {
  const directory = mkdtempSync(join(tmpdir(), 'botanic-product-contract-'))
  try {
    const store = createProductStore({
      dataPath: join(directory, 'product.json'),
      bootstrapAccessToken: 'contract-test',
    })
    assert.equal(assertProductStoreContract(store, { adapter: 'LocalProductStore' }), store)
    assert.equal(productStoreSupports(store, 'workspaceMembers'), true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Turn 事件分页参数三个 Adapter 共用同一份规格化', () => {
  // 缺省从头读，上限 200。
  assert.deepEqual(normalizeTurnEventPage(), { after: null, limit: 200 })
  assert.deepEqual(normalizeTurnEventPage({}), { after: null, limit: 200 })
  assert.deepEqual(normalizeTurnEventPage({ after: 7, limit: 50 }), { after: 7, limit: 50 })
  // after: 0 是合法游标（表示只要序号 > 0），不能被当成缺省。
  assert.deepEqual(normalizeTurnEventPage({ after: 0 }).after, 0)
  // 非整数与负数一律视为无游标，不能悄悄变成 NaN 比较。
  for (const after of [-1, 1.5, '3', null, undefined, Number.NaN]) {
    assert.equal(normalizeTurnEventPage({ after }).after, null, `after=${String(after)} 应视为无游标`)
  }
  assert.equal(normalizeTurnEventPage({ limit: 9999 }).limit, 500, 'limit 有硬上限')
  assert.equal(normalizeTurnEventPage({ limit: 0 }).limit, 200)
  assert.equal(normalizeTurnEventPage({ limit: -5 }).limit, 1)
})

test('陈旧 Turn 扫描的租约有下限，避免抢走仍在推进的 Turn', () => {
  // 30 秒下限：一次慢的模型调用就可能几秒不更新 updated_at。
  assert.equal(normalizeStaleTurnQuery({ now: 1_000_000, leaseMs: 1 }).olderThan, 1_000_000 - 30_000)
  assert.equal(normalizeStaleTurnQuery({ now: 1_000_000 }).olderThan, 1_000_000 - 120_000, '默认租约 2 分钟')
  assert.equal(normalizeStaleTurnQuery({ now: 1_000_000, leaseMs: 300_000 }).olderThan, 700_000)
  // 显式 olderThan 优先于租约推导。
  assert.equal(normalizeStaleTurnQuery({ now: 1_000_000, olderThan: 42 }).olderThan, 42)
  assert.equal(normalizeStaleTurnQuery({}).limit, 25, '一次只取一小批')
  assert.equal(normalizeStaleTurnQuery({ limit: 9999 }).limit, 200)
})

test('非终态集合只含尚可推进的状态，终态不得混入', () => {
  assert.deepEqual([...nonTerminalAgentTurnStatuses], ['queued', 'running', 'waiting_user', 'cancelling'])
  for (const terminal of ['completed', 'failed', 'cancelled']) {
    assert.equal(nonTerminalAgentTurnStatuses.includes(terminal), false, `${terminal} 是终态，不该被回收`)
  }
})
