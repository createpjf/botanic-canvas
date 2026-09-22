import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectAgentTurnRelease } from './agentTurnReleaseGate.mjs'

function database(rows = [], name = 'test-release') {
  const queries = []
  const sql = async (parts) => {
    const query = parts.join('?').replace(/\s+/gu, ' ').trim()
    queries.push(query)
    assert.match(query, /^select /u)
    if (query.includes('current_database()')) return [{ database: name, checkedAt: '2026-09-22T00:00:00Z' }]
    if (query.includes('set_config')) return []
    assert.match(query, /public\.agent_turns/u)
    assert.doesNotMatch(query, /\blimit\b|\bowner_id\b|\bproject_id\b/u)
    assert.match(query, /is distinct from/u)
    return rows
  }
  sql.begin = async (mode, run) => {
    assert.equal(mode, 'isolation level repeatable read read only')
    return run(sql)
  }
  return { sql, queries }
}

test('发布检查仅在全局终态清点、目标匹配和停写声明齐全时通过；只读且关闭 RLS 静默过滤', async () => {
  const db = database([{ status: 'completed', count: '201', inconsistent: '0' }])
  const args = { sql: db.sql, expectedDatabase: 'test-release', quiesced: true }
  assert.equal((await inspectAgentTurnRelease(args)).eligible, true)
  assert.ok(db.queries.some((q) => q.includes("set_config('row_security', 'off', true)")))
  assert.equal((await inspectAgentTurnRelease({ ...args, quiesced: false })).eligible, false)
  assert.equal((await inspectAgentTurnRelease({ ...args, expectedDatabase: 'wrong-target' })).eligible, false)
  assert.equal((await inspectAgentTurnRelease({ ...args, sql: database().sql })).eligible, true)
})

test('活动、等待用户、取消中、未知状态和不一致记录均阻断；查询失败不变成零记录', async () => {
  for (const row of [
    ...['queued', 'running', 'waiting_user', 'cancelling', 'unknown'].map((status) => ({ status, count: '1', inconsistent: '0' })),
    { status: 'completed', count: '1', inconsistent: '1' },
    { status: 'completed', count: '-1', inconsistent: '0' },
    { status: 'completed', count: '1' },
    { status: 'completed', count: '9007199254740992', inconsistent: '0' },
  ]) {
    assert.equal((await inspectAgentTurnRelease({ sql: database([row]).sql, expectedDatabase: 'test-release', quiesced: true })).eligible, false)
  }
  await assert.rejects(inspectAgentTurnRelease({
    sql: { begin: async () => { throw new Error('RLS denied') } },
    expectedDatabase: 'test-release', quiesced: true,
  }), /RLS denied/u)
})
