import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
  AGENT_PROTOCOL_VERSION,
  AGENT_PUBLIC_ERROR_CODES,
  AGENT_STREAM_EVENT_TYPES,
  AGENT_TOOL_CALL_PUBLIC_STATUSES,
  AGENT_TURN_PUBLIC_STATUSES,
  agentProtocolCatalog,
  isAgentPublicErrorCode,
  isAgentStreamEventType,
  isAgentToolCallPublicStatus,
  isAgentTurnPublicStatus,
} from './agentProtocol.mjs'

test('协议 catalog 与生成物一致:服务端 guard、前端类型、JSON Schema 共用同一枚举', () => {
  const catalog = agentProtocolCatalog()
  assert.equal(catalog.protocolVersion, AGENT_PROTOCOL_VERSION)
  // 生成的前端类型必须携带同一批值(round-trip:任何一侧漂移都会在这里或 --check 红灯)。
  const generated = readFileSync(new URL('../src/domain/agentProtocol.generated.ts', import.meta.url), 'utf8')
  for (const status of AGENT_TURN_PUBLIC_STATUSES) assert.ok(generated.includes(`'${status}'`), status)
  for (const type of AGENT_STREAM_EVENT_TYPES) assert.ok(generated.includes(`'${type}'`), type)
  for (const status of AGENT_TOOL_CALL_PUBLIC_STATUSES) assert.ok(generated.includes(`'${status}'`), status)
  const schema = JSON.parse(readFileSync(new URL('../docs/reference/agent-protocol-v1.schema.json', import.meta.url), 'utf8'))
  assert.equal(schema.protocolVersion, AGENT_PROTOCOL_VERSION)
  assert.deepEqual(schema.$defs.AgentTurnPublicStatus.enum, [...AGENT_TURN_PUBLIC_STATUSES])
  assert.deepEqual(schema.$defs.AgentPublicErrorCode.enum, [...AGENT_PUBLIC_ERROR_CODES])
  // guard 主路径。
  assert.equal(isAgentTurnPublicStatus('cancelling'), true)
  assert.equal(isAgentStreamEventType('handoff'), true)
  assert.equal(isAgentToolCallPublicStatus('aborted'), true)
  assert.equal(isAgentPublicErrorCode('AGENT_TOOL_OUTCOME_UNKNOWN'), true)
  assert.equal(isAgentPublicErrorCode('AGENT_PROTOCOL_VERSION_UNSUPPORTED'), true)
  assert.equal(isAgentPublicErrorCode('PROVIDER_STREAM_CLOSED'), true)
  assert.equal(isAgentPublicErrorCode('PROVIDER_STREAM_MALFORMED'), true)
})

test('未知值具名拒绝:guard 不放行未登记的状态/事件/错误码', () => {
  assert.equal(isAgentTurnPublicStatus('paused'), false)
  assert.equal(isAgentStreamEventType('steering'), false)
  assert.equal(isAgentToolCallPublicStatus('unknown'), false)
  assert.equal(isAgentPublicErrorCode('SOME_NEW_CODE'), false)
  assert.equal(isAgentTurnPublicStatus(42), false)
})
