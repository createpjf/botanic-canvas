import test from 'node:test'
import assert from 'node:assert/strict'
import { memoryBindingSnapshot, selectBotanicAgentMemory } from './botanicAgentMemory.mjs'

const memory = [
  { id: 'human-rule', kind: 'rule', content: '瓶身比例不可改变', sourceNodeIds: ['product'], source: 'human', confidence: 'confirmed', version: 2, contentHash: 'hash-1' },
  { id: 'old-avoid', kind: 'avoid', content: '不要使用过度饱和的背景', sourceNodeIds: [], source: 'conversation', confidence: 'provisional' },
  { id: 'scene-rule', kind: 'approved', content: '夏日海边自然光', sourceNodeIds: ['scene'], source: 'human', confidence: 'confirmed' },
]

test('Memory V2 选择器优先命中查询、上下文关联和已确认来源', () => {
  const result = selectBotanicAgentMemory(memory, { query: '比例', contextNodeIds: ['product'] })
  assert.equal(result.zeroHit, false)
  assert.equal(result.items[0].id, 'human-rule')
  assert.equal(result.items.length, 1)
})

test('Memory V2 无命中返回显式 zeroHit，并生成可复现绑定快照', () => {
  assert.deepEqual(selectBotanicAgentMemory(memory, { query: '不存在' }), { total: 0, items: [], zeroHit: true })
  assert.deepEqual(memoryBindingSnapshot(memory, { query: '比例' }), [{ id: 'human-rule', version: 2, contentHash: 'hash-1', selectionReason: '匹配本轮检索「比例」' }])
})

test('Memory V2 不把 provisional 候选直接暴露给 Planner', () => {
  const result = selectBotanicAgentMemory(memory)
  assert.deepEqual(result.items.map((item) => item.id), ['human-rule', 'scene-rule'])
  assert.equal(result.items.some((item) => item.confidence === 'provisional'), false)
})
