import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentSubagentCapabilityHash,
  agentSubagentCapabilitySnapshot,
  createAgentSubagentToolRegistry,
} from './agentSubagentTools.mjs'
import { createAgentToolRegistry } from '../tools/agentToolRuntime.mjs'

function definition(name, overrides = {}) {
  return {
    name,
    label: name,
    description: `${name} description`,
    risk: 'read',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
    validate: (value) => value,
    execute: async (value) => ({ name, ...value }),
    ...overrides,
  }
}

test('Subagent 工具面只取服务端 Registry 与显式 allowedTools 的交集并冻结', async () => {
  const source = createAgentToolRegistry([
    definition('canvas_read'),
    definition('web_search', { risk: 'external', recovery: 'never' }),
  ])
  const allowedTools = ['canvas_read']
  const executions = []
  const registry = createAgentSubagentToolRegistry({
    registry: source,
    allowedTools,
    executeTool: async (name, value) => {
      executions.push({ name, value })
      return { ok: true }
    },
  })

  allowedTools.push('web_search')
  assert.deepEqual(registry.names(), ['canvas_read'])
  assert.deepEqual(registry.openAITools().map((entry) => entry.function.name), ['canvas_read'])
  assert.equal(Object.isFrozen(registry.capabilitySnapshot()), true)
  assert.deepEqual(await registry.get('canvas_read').execute({ query: '节点' }, {}), { ok: true })
  assert.deepEqual(executions, [{ name: 'canvas_read', value: { query: '节点' } }])
})

test('Subagent Registry 拒绝确认、终态、写入、费用与未知工具', () => {
  const source = createAgentToolRegistry([
    definition('safe_read'),
    definition('confirmed_read', { requiresConfirmation: true }),
    definition('terminal_read', { terminal: true }),
    definition('write_tool', { risk: 'write' }),
    definition('costly_tool', { risk: 'costly' }),
  ])

  for (const name of ['confirmed_read', 'terminal_read', 'write_tool', 'costly_tool']) {
    assert.throws(
      () => createAgentSubagentToolRegistry({ registry: source, allowedTools: [name] }),
      (error) => error?.code === 'SUBTASK_TOOL_FORBIDDEN',
      `${name} 不得进入子 Agent 能力面`,
    )
  }
  assert.throws(
    () => createAgentSubagentToolRegistry({ registry: source, allowedTools: ['missing_tool'] }),
    (error) => error?.code === 'SUBTASK_TOOL_UNKNOWN',
  )
})

test('Start service 与 Runner 可共享确定性的 capability snapshot/hash', () => {
  const registry = createAgentToolRegistry([definition('canvas_read'), definition('web_search')])
  const descriptor = {
    role: 'brand_research', model: 'subagent-model', instructionsVersion: 'v1',
    outputKind: 'proposal', allowedTools: ['canvas_read'],
    outputSchema: { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } },
  }
  const snapshot = agentSubagentCapabilitySnapshot({ descriptor, registry })
  const hash = agentSubagentCapabilityHash({ descriptor, registry })

  assert.equal(snapshot.model, 'subagent-model')
  assert.deepEqual(snapshot.toolNames, ['canvas_read'])
  assert.equal(typeof hash, 'string')
  assert.equal(hash, agentSubagentCapabilityHash({ descriptor: structuredClone(descriptor), registry }))
  assert.notEqual(hash, agentSubagentCapabilityHash({
    descriptor: { ...descriptor, allowedTools: ['web_search'] }, registry,
  }))
  assert.notEqual(hash, agentSubagentCapabilityHash({
    descriptor: { ...descriptor, instructionsVersion: 'v2' }, registry,
  }))
  assert.notEqual(hash, agentSubagentCapabilityHash({
    descriptor: {
      ...descriptor,
      outputSchema: { type: 'object', required: ['summary', 'confidence'], properties: descriptor.outputSchema.properties },
    },
    registry,
  }))
})
