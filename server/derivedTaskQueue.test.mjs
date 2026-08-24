import assert from 'node:assert/strict'
import test from 'node:test'
import { DERIVED_TASK_KINDS, createDerivedTaskQueue, derivedSweepKey } from './derivedTaskQueue.mjs'

test('未配置 Redis 时不构造队列，与生成队列行为一致', () => {
  assert.equal(createDerivedTaskQueue(undefined), undefined)
  assert.equal(createDerivedTaskQueue(''), undefined)
})

test('种类必须声明，未声明的种类抛错而不是入队一个没人消费的任务', () => {
  assert.throws(() => derivedSweepKey('review.run'), /未声明的派生任务种类/u)
  assert.throws(() => derivedSweepKey('turn.reclaimed'), /未声明的派生任务种类/u)
  assert.equal(derivedSweepKey('turn.reclaim'), 'sweep:turn.reclaim')
})

test('当前只声明有真实消费者的种类', () => {
  // 没有消费者的种类只是猜测；新种类要和它的消费者一起加。
  assert.deepEqual([...DERIVED_TASK_KINDS], ['turn.reclaim'])
  assert.equal(new Set(DERIVED_TASK_KINDS).size, DERIVED_TASK_KINDS.length)
})
