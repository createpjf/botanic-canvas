import assert from 'node:assert/strict'
import test from 'node:test'
import { createGenerationQueue } from './generationQueue.mjs'

test('stalled recovery 只移除指定且已解锁的 active Job，不调用全局 clean', async () => {
  const calls = []
  const target = {
    async getState() { return 'active' },
    async remove() { calls.push(['remove', 'job-target']) },
  }
  class FakeQueue {
    async getJob(id) { calls.push(['getJob', id]); return id === 'job-target' ? target : undefined }
    async clean() { calls.push(['clean']); return ['job-other'] }
    async add(name, data, options) { calls.push(['add', name, data, options]) }
  }
  const queue = createGenerationQueue('redis://test', { QueueImpl: FakeQueue })

  assert.equal(await queue.reclaimStaleActive('job-target'), true)
  assert.equal(calls.some(([method]) => method === 'clean'), false, '不得扫描或删除其他 active Job')
  assert.deepEqual(calls, [
    ['getJob', 'job-target'],
    ['remove', 'job-target'],
    ['add', 'generate', { jobId: 'job-target' }, { jobId: 'job-target' }],
  ])
})

test('stalled recovery 遇到仍持有 BullMQ lock 的目标时安全放弃，不重复入队', async () => {
  const calls = []
  class FakeQueue {
    async getJob() {
      return {
        async getState() { return 'active' },
        async remove() { throw new Error('Job job-target could not be removed because it is locked by another worker') },
      }
    }
    async add() { calls.push('add') }
  }
  const queue = createGenerationQueue('redis://test', { QueueImpl: FakeQueue })

  assert.equal(await queue.reclaimStaleActive('job-target'), false)
  assert.deepEqual(calls, [])
})

test('stale-running 的 BullMQ 项已丢失或 failed 时按 jobId 精确重建', async () => {
  for (const state of ['missing', 'failed']) {
    const calls = []
    class FakeQueue {
      async getJob() {
        if (state === 'missing') return undefined
        return {
          async getState() { return 'failed' },
          async remove() { calls.push('remove') },
        }
      }
      async add(name, data, options) { calls.push(['add', name, data, options]) }
    }
    const queue = createGenerationQueue('redis://test', { QueueImpl: FakeQueue })
    assert.equal(await queue.reclaimStaleActive('job-target'), true, state)
    assert.deepEqual(calls.at(-1), ['add', 'generate', { jobId: 'job-target' }, { jobId: 'job-target' }])
  }
})
