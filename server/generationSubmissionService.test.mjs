import assert from 'node:assert/strict'
import test from 'node:test'
import { createGenerationSubmissionService } from './generationSubmissionService.mjs'

function harness() {
  const jobs = new Map()
  const enqueued = []
  const reservations = []
  const consumes = []
  const service = createGenerationSubmissionService({
    config: {
      models: ['gpt-image-2'],
      modelOptions: [{
        id: 'gpt-image-2', provider: 'openai', mediaKind: 'image',
        aspectRatios: ['1:1'], resolutions: ['1K'],
      }],
      maximumBatchCount: 4,
      maximumReferenceBytes: 8 * 1024 * 1024,
      security: { generationOutputsPerDay: 100 },
      generationBudgets: { workspace: 100, project: 100, member: 100 },
    },
    productStore: {
      projectAccess: async () => ({ exists: true, role: 'owner' }),
      readGenerationJob: async (_userId, id) => jobs.get(id),
      putGenerationJob: async (_userId, job) => { jobs.set(job.id, structuredClone(job)); return job },
      readAgentRun: async () => undefined,
    },
    securityControls: {
      consume: async (input) => { consumes.push(input); return { allowed: true } },
      reserveMany: async (input) => { reservations.push(input); return { allowed: true, reused: false, remaining: 99 } },
    },
    enqueue: async (id) => { enqueued.push(id) },
  })
  return { service, jobs, enqueued, reservations, consumes }
}

const rawInput = {
  projectId: 'project-a', kind: 'generation', prompt: '生成品牌首图', batchCount: 1,
  settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
  recipe: { references: [{ name: '产品', mediaId: 'media_product', inputRole: 'reference_image' }] },
}

test('重复提交复用同一任务、队列和预算预留', async () => {
  const { service, enqueued, reservations, consumes } = harness()
  const first = await service({ user: { id: 'user-a' }, rawInput, idempotencyKey: 'workflow_run-a_item-a' })
  const duplicate = await service({ user: { id: 'user-a' }, rawInput, idempotencyKey: 'workflow_run-a_item-a' })

  assert.equal(duplicate.job.id, first.job.id)
  assert.equal(duplicate.existing, true)
  assert.equal(enqueued.length, 1)
  assert.equal(reservations.length, 1)
  assert.equal(consumes.length, 1)
})

test('失败项原配方重试复用任务与幂等键且不重复扣费', async () => {
  const { service, jobs, enqueued, reservations, consumes } = harness()
  const first = await service({ user: { id: 'user-a' }, rawInput, idempotencyKey: 'workflow_run-a_item-a' })
  jobs.set(first.job.id, {
    ...jobs.get(first.job.id), status: 'failed', error: 'provider timeout',
    variants: [{ index: 0, status: 'failed', error: 'provider timeout' }],
  })

  const retried = await service({
    user: { id: 'user-a' }, rawInput, idempotencyKey: 'workflow_run-a_item-a', retryExisting: true,
  })

  assert.equal(retried.job.id, first.job.id)
  assert.equal(retried.job.idempotencyKey, 'workflow_run-a_item-a')
  assert.equal(retried.job.status, 'queued')
  assert.equal(retried.retried, true)
  assert.equal(enqueued.length, 2)
  assert.equal(reservations.length, 1)
  assert.equal(consumes.length, 1)
})
