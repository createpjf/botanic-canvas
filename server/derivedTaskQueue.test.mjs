import assert from 'node:assert/strict'
import test from 'node:test'
import { DERIVED_TASK_KINDS, createDerivedTaskQueue, derivedSweepKey } from './derivedTaskQueue.mjs'

test('未配置 Redis 时不构造队列，与生成队列行为一致', () => {
  assert.equal(createDerivedTaskQueue(undefined), undefined)
  assert.equal(createDerivedTaskQueue(''), undefined)
})

test('种类必须声明，未声明的种类抛错而不是入队一个没人消费的任务', () => {
  assert.throws(() => derivedSweepKey('workflow.advance'), /未声明的派生任务种类/u)
  assert.throws(() => derivedSweepKey('turn.reclaimed'), /未声明的派生任务种类/u)
  assert.equal(derivedSweepKey('turn.reclaim'), 'sweep__turn.reclaim')
  assert.equal(derivedSweepKey('review.run'), 'sweep__review.run')
})

test('复合标识不含冒号，BullMQ 拒绝含冒号的自定义 jobId', () => {
  // 这条约束只有对着真实 Redis 才会暴露（Custom Id cannot contain :），
  // 因此在这里钉住，避免以后有人改回冒号分隔。
  assert.doesNotMatch(derivedSweepKey('turn.reclaim'), /:/u)
})

test('当前只声明有真实消费者的种类', () => {
  // 没有消费者的种类只是猜测；新种类要和它的消费者一起加。
  assert.deepEqual([...DERIVED_TASK_KINDS], ['turn.reclaim', 'review.run'])
  assert.equal(new Set(DERIVED_TASK_KINDS).size, DERIVED_TASK_KINDS.length)
})
