import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalHash } from './canonicalHash.mjs'
import { actionArgumentsHash } from './agentActionGovernance.mjs'
import { creativePlanHash } from './botanicCreativePlanCompiler.mjs'

test('键序不影响哈希', () => {
  // 否则「重试是否漂移」会被字段书写顺序这种无意义差异触发。
  assert.equal(
    canonicalHash({ b: 1, a: { y: 2, x: 3 } }),
    canonicalHash({ a: { x: 3, y: 2 }, b: 1 }),
  )
  // 数组是有序的，顺序变化必须改变哈希。
  assert.notEqual(canonicalHash([1, 2]), canonicalHash([2, 1]))
})

test('抽取前后逐字节一致', () => {
  // 这三个常量取自抽取**之前**的两份副本实测输出。审批 Token 绑定参数摘要，
  // 计划指纹绑定重试判定 —— 哈希只要变了一个字节，在途审批全部失效、
  // 历史 Run 全部被判成「已漂移」，而且不会有任何报错提示发生了什么。
  const sample = { b: 1, a: [3, { z: 1, y: 2 }] }
  assert.equal(canonicalHash({}), 'RBNvo1WzZ4oRRq0W9-hknpT7T8If536DEMBg9hyq_4o')
  assert.equal(canonicalHash(sample), 'lbb9iJKk_FNFXezEv9To5n0gr6pQyMTf3vDxcVtvflw')
  assert.equal(creativePlanHash(sample), 'lbb9iJKk_FNFXezEv9To5n0gr6pQyMTf3vDxcVtvflw')
  assert.equal(actionArgumentsHash(sample), 'lbb9iJKk_FNFXezEv9To5n0gr6pQyMTf3vDxcVtvflw')
})

test('缺省参数与空对象在审批摘要里是同一件事', () => {
  // 「没带参数」与「带了空对象」若得到两个摘要，同一次确认重放时会对不上。
  assert.equal(actionArgumentsHash(undefined), actionArgumentsHash({}))
  assert.equal(actionArgumentsHash(null), canonicalHash({}))
})
