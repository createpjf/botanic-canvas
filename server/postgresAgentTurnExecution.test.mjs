import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./store/postgresProductStore.mjs', import.meta.url), 'utf8')

function methodSource(name, nextName) {
  const start = source.indexOf(`async ${name}`)
  const end = source.indexOf(`\n    async ${nextName}`, start)
  assert.notEqual(start, -1, `缺少 ${name}`)
  assert.notEqual(end, -1, `无法定位 ${name} 结束边界`)
  return source.slice(start, end)
}

test('PostgreSQL Turn claim 使用数据库时钟和同一事务锁裁决执行权', () => {
  assert.match(source, /claimAgentTurnExecution[\s\S]*pg_advisory_xact_lock\(hashtextextended\(\$\{claim\.turn\.id\}, 3\)\)/u)
  assert.match(source, /claimAgentTurnExecution[\s\S]*from project_members[\s\S]*for share[\s\S]*clock_timestamp/u)
  assert.match(source, /agentTurnExecutionClaimDecision\(existingTurn,[\s\S]*observedAt/u)
})

test('PostgreSQL Turn commit 同时校验 generation/token、分配事件序号并写入终态', () => {
  assert.match(source, /commitAgentTurnExecution[\s\S]*for update[\s\S]*committedAgentTurnExecution/u)
  assert.match(source, /commitAgentTurnExecution[\s\S]*clock_timestamp/u)
  assert.match(source, /commitAgentTurnExecution[\s\S]*coalesce\(max\(sequence\), 0\)[\s\S]*lastSequence \+ 1/u)
  assert.match(source, /commitAgentTurnExecution[\s\S]*insert into agent_turn_events[\s\S]*update agent_turns set[\s\S]*status/u)
  assert.match(source, /commitAgentTurnExecution[\s\S]*AGENT_TURN_EVENT_CONFLICT/u)
})

test('PostgreSQL Turn commit 持久化所有 changed 取消结果，但 heartbeat/ack 不造事件或终态 Audit', () => {
  const commit = methodSource('commitAgentTurnExecution', 'requestAgentTurnCancellation')
  assert.match(commit, /if \(decision\.changed\) \{[\s\S]*update agent_turns set/u)
  assert.match(commit, /\['committed', 'replay'\]\.includes\(decision\.kind\) && command\.event/u)
  assert.match(commit, /else if \(decision\.kind === 'committed'\)[\s\S]*insert into agent_turn_events/u)
  assert.match(commit, /if \(decision\.kind === 'committed'\s*&& \['completed', 'failed', 'cancelled'\]\.includes\(decision\.turn\.status\)\) \{[\s\S]*insertAudit/u)
})

test('PostgreSQL 兼容 put 不得覆盖已经进入 fenced execution 的 Turn', () => {
  assert.match(source, /putAgentTurn[\s\S]*existingTurn\?\.execution[\s\S]*return clone\(existingTurn\)/u)
})

test('PostgreSQL Turn 取消在同一锁与事务内写 cancelling 和顺序事件', () => {
  assert.match(source, /requestAgentTurnCancellation[\s\S]*pg_advisory_xact_lock\(hashtextextended\(\$\{request\.id\}, 3\)\)/u)
  assert.match(source, /requestAgentTurnCancellation[\s\S]*for update[\s\S]*clock_timestamp[\s\S]*requestedAgentTurnCancellation/u)
  assert.match(source, /requestAgentTurnCancellation[\s\S]*coalesce\(max\(sequence\), 0\)[\s\S]*lastSequence \+ 1/u)
  assert.match(source, /requestAgentTurnCancellation[\s\S]*insert into agent_turn_events[\s\S]*update agent_turns set[\s\S]*status/u)
  assert.match(source, /requestAgentTurnCancellation[\s\S]*turn\.cancelling/u)
})

test('PostgreSQL Turn 取消收口原子写 cancelled、顺序事件与安全 Audit', () => {
  assert.match(source, /finalizeAgentTurnCancellation[\s\S]*pg_advisory_xact_lock\(hashtextextended\(\$\{command\.id\}, 3\)\)/u)
  assert.match(source, /finalizeAgentTurnCancellation[\s\S]*for update[\s\S]*clock_timestamp[\s\S]*finalizedAgentTurnCancellation/u)
  assert.match(source, /finalizeAgentTurnCancellation[\s\S]*lastSequence \+ 1[\s\S]*insert into agent_turn_events/u)
  assert.match(source, /finalizeAgentTurnCancellation[\s\S]*update agent_turns set[\s\S]*agent-turn\.cancelled/u)
})
