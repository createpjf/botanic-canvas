import assert from 'node:assert/strict'
import test from 'node:test'
import { createLocalCancelRegistry } from './localCancelRegistry.mjs'

const handle = () => {
  const calls = { aborted: 0 }
  return { calls, abort: () => { calls.aborted += 1 } }
}

test('登记后可就地中止，并报告该 Turn 属于本实例', () => {
  const registry = createLocalCancelRegistry()
  const first = handle()
  assert.equal(registry.register('turn-1', first), true)
  assert.equal(registry.has('turn-1'), true)
  assert.equal(registry.abort('turn-1'), true)
  assert.equal(first.calls.aborted, 1)
})

test('不属于本实例的 Turn 报告 false，供调用方判断是否需要跨实例广播', () => {
  const registry = createLocalCancelRegistry()
  assert.equal(registry.abort('turn-elsewhere'), false)
  assert.equal(registry.has('turn-elsewhere'), false)
})

test('并发幂等重放复用首个句柄，后来者不得覆盖', () => {
  // 覆盖会导致明确取消只中断一个无效的重复控制器。
  const registry = createLocalCancelRegistry()
  const first = handle()
  const second = handle()
  assert.equal(registry.register('turn-1', first), true)
  assert.equal(registry.register('turn-1', second), false, '后来者不应成为活动句柄')
  registry.abort('turn-1')
  assert.equal(first.calls.aborted, 1)
  assert.equal(second.calls.aborted, 0)
})

test('注销只在句柄仍是自己登记的那个时生效', () => {
  const registry = createLocalCancelRegistry()
  const first = handle()
  const other = handle()
  registry.register('turn-1', first)
  assert.equal(registry.release('turn-1', other), false, '不得误删别人的句柄')
  assert.equal(registry.has('turn-1'), true)
  assert.equal(registry.release('turn-1', first), true)
  assert.equal(registry.has('turn-1'), false)
})

test('句柄抛错不改变归属判定', () => {
  const registry = createLocalCancelRegistry()
  registry.register('turn-1', { abort: () => { throw new Error('控制器已失效') } })
  // 它确实曾属于本实例，调用方不应因此再去广播一次。
  assert.equal(registry.abort('turn-1'), true)
})

test('拒绝无效登记', () => {
  const registry = createLocalCancelRegistry()
  assert.equal(registry.register('', handle()), false)
  assert.equal(registry.register('turn-1', {}), false)
  assert.equal(registry.register('turn-1', undefined), false)
  assert.equal(registry.size, 0)
})
