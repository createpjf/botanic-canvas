import assert from 'node:assert/strict'
import test from 'node:test'
import { createGenerationRecoverySweep } from './generationRecoverySweep.mjs'

function jobs(count = 5) {
  return Array.from({ length: count }, (_, index) => ({
    id: `job-${index + 1}`,
    ownerId: 'user-1',
    projectId: 'project-1',
    status: 'queued',
    updatedAt: (index + 1) * 10,
  }))
}

function keysetPage(all, { after, limit }) {
  return all
    .filter((job) => !after || job.updatedAt > after.updatedAt
      || (job.updatedAt === after.updatedAt && job.id.localeCompare(after.id) > 0))
    .slice(0, limit)
    .map((job) => structuredClone(job))
}

test('Generation recovery 跨 sweep 越过 poison 前缀访问后页，并在尾页后 wrap', async () => {
  const all = jobs()
  const listedAfter = []
  const enqueued = []
  const events = []
  const sweep = createGenerationRecoverySweep({
    productStore: {
      listRecoverableGenerationJobs: async (input) => {
        listedAfter.push(input.after ? structuredClone(input.after) : null)
        return keysetPage(all, input)
      },
    },
    enqueue: async (jobId) => {
      if (jobId === 'job-1') throw new Error('poison enqueue')
      enqueued.push(jobId)
    },
    maxPages: 1,
    observe: (event) => events.push(event),
  })

  await sweep({ limit: 2 })
  await sweep({ limit: 2 })
  await sweep({ limit: 2 })
  await sweep({ limit: 2 })

  assert.deepEqual(listedAfter, [
    null,
    { updatedAt: 20, id: 'job-2' },
    { updatedAt: 40, id: 'job-4' },
    null,
  ])
  assert.deepEqual(enqueued.slice(0, 4), ['job-2', 'job-3', 'job-4', 'job-5'])
  assert.ok(events.some((event) => event.event === 'generation.recovery.enqueue.failed' && event.jobId === 'job-1'))
})

test('Generation recovery 每轮页数有界，游标会留给下一轮继续', async () => {
  const all = jobs(8)
  const listedAfter = []
  const enqueued = []
  const sweep = createGenerationRecoverySweep({
    productStore: {
      listRecoverableGenerationJobs: async (input) => {
        listedAfter.push(input.after ? structuredClone(input.after) : null)
        return keysetPage(all, input)
      },
    },
    enqueue: async (jobId) => { enqueued.push(jobId) },
    maxPages: 2,
  })

  const first = await sweep({ limit: 2 })
  const second = await sweep({ limit: 2 })
  assert.equal(first.pages, 2)
  assert.equal(first.scanned, 4)
  assert.equal(second.pages, 2)
  assert.deepEqual(enqueued, ['job-1', 'job-2', 'job-3', 'job-4', 'job-5', 'job-6', 'job-7', 'job-8'])
  assert.deepEqual(listedAfter, [
    null,
    { updatedAt: 20, id: 'job-2' },
    { updatedAt: 40, id: 'job-4' },
    { updatedAt: 60, id: 'job-6' },
  ])
})

test('Generation recovery 遇到重复满页游标停滞时中止本轮并 wrap', async () => {
  const page = jobs(2)
  const listedAfter = []
  const sweep = createGenerationRecoverySweep({
    productStore: {
      listRecoverableGenerationJobs: async ({ after }) => {
        listedAfter.push(after ? structuredClone(after) : null)
        return page.map((job) => structuredClone(job))
      },
    },
    enqueue: async () => {},
    maxPages: 5,
  })

  const first = await sweep({ limit: 2 })
  await sweep({ limit: 2 })
  assert.equal(first.pages, 2, '检测到第二页重复后立即停止，不耗尽全部页预算')
  assert.deepEqual(listedAfter, [null, { updatedAt: 20, id: 'job-2' }, null, { updatedAt: 20, id: 'job-2' }])
})
