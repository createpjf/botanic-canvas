import assert from 'node:assert/strict'
import test from 'node:test'
import { createGenerationRouteHandler } from './generationRoutes.mjs'

test('GET 超时补丁 CAS 输给并发成功时返回权威 succeeded，不覆盖或误出队', async () => {
  const stale = {
    id: 'job-timeout-race', ownerId: 'user-1', projectId: 'project-1', status: 'running',
    createdAt: 1, updatedAt: 1, batchCount: 1, outputs: [],
    settings: { model: 'gpt-image-2' },
    execution: { generation: 1, leaseToken: 'lease-worker' },
  }
  const succeeded = { ...stale, status: 'succeeded', outputs: [{ id: 'output-1', image: '/api/media/output-1' }] }
  const cancelledQueueIds = []
  let responseBody
  let receivedCommand
  const handler = createGenerationRouteHandler({
    config: {
      modelOptions: [{ id: 'gpt-image-2', provider: 'openai', mediaKind: 'image', timeoutMs: 1 }],
      generationTimeoutMs: 1,
    },
    productStore: {
      async readGenerationJob() { return structuredClone(stale) },
      async compareAndSetGenerationJob(_userId, command) {
        receivedCommand = command
        return { kind: 'stale', changed: false, job: structuredClone(succeeded) }
      },
    },
    redisQueue: { async cancel(id) { cancelledQueueIds.push(id) } },
    requireUser: async () => ({ id: 'user-1' }),
    json: (_response, status, body) => { responseBody = body; return { status, body } },
    error: () => { throw new Error('unexpected error response') },
  })

  const result = await handler(
    { method: 'GET' },
    {},
    new URL('http://localhost/api/generation-jobs/job-timeout-race'),
    { generationJob: ['/api/generation-jobs/job-timeout-race', 'job-timeout-race', undefined] },
  )

  assert.equal(receivedCommand.expectedStatus, 'running')
  assert.equal(receivedCommand.expectedExecutionGeneration, 1)
  assert.equal(receivedCommand.job.projectWritebackPending, true)
  assert.equal(receivedCommand.updateAgentRun, false)
  assert.equal(result.status, 200)
  assert.equal(responseBody.status, 'succeeded')
  assert.deepEqual(responseBody.outputs, [{ id: 'output-1', image: '/api/media/output-1' }])
  assert.deepEqual(cancelledQueueIds, [])
})
