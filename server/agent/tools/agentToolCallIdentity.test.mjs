import assert from 'node:assert/strict'
import test from 'node:test'
import { AGENT_TOOL_CALL_ID_MAX_LENGTH, normalizeAgentToolCallId } from './agentToolCallIdentity.mjs'

test('短 Tool Call ID 保持原值并清理首尾空白', () => {
  assert.equal(normalizeAgentToolCallId(' call-1 '), 'call-1')
  assert.equal(normalizeAgentToolCallId(undefined), '')
})

test('超长 Tool Call ID 以稳定摘要限长且不会因相同前缀碰撞', () => {
  const shared = `call-${'g'.repeat(200)}`
  const first = normalizeAgentToolCallId(`${shared}-first`)
  const second = normalizeAgentToolCallId(`${shared}-second`)

  assert.equal(first.length, AGENT_TOOL_CALL_ID_MAX_LENGTH)
  assert.equal(first, normalizeAgentToolCallId(`${shared}-first`))
  assert.notEqual(first, second)
  assert.equal(first.startsWith('call-'), true)
})
