import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentReviewTaskSnapshot } from '../../domain/agentReviewPresentation.ts'
import { loadAgentReviewProjection } from './agentReviewProjection.ts'

const completedTask: AgentReviewTaskSnapshot = {
  id: 'review-1',
  runId: 'run-1',
  status: 'completed',
  updatedAt: 2,
  results: [],
}

test('首次 503 会释放请求键，同一 Run 第二次成功且只投影一次', async () => {
  const requested = new Set<string>()
  const messages: string[] = []
  let reads = 0
  const read = async () => {
    reads += 1
    if (reads === 1) throw Object.assign(new Error('temporary'), { status: 503 })
    return [completedTask]
  }

  const first = await loadAgentReviewProjection({ requestKey: 'run-1:v1', requested, read })
  assert.equal(first.kind, 'retry')
  assert.equal(requested.size, 0)

  const second = await loadAgentReviewProjection({ requestKey: 'run-1:v1', requested, read })
  if (second.kind === 'ready') messages.push(second.task.id)
  assert.equal(second.kind, 'ready')

  const duplicate = await loadAgentReviewProjection({ requestKey: 'run-1:v1', requested, read })
  if (duplicate.kind === 'ready') messages.push(duplicate.task.id)
  assert.equal(duplicate.kind, 'duplicate')
  assert.deepEqual(messages, ['review-1'])
})

test('不可重试的 4xx 进入最终失败', async () => {
  const result = await loadAgentReviewProjection({
    requestKey: 'run-1:v1',
    requested: new Set(),
    read: async () => { throw Object.assign(new Error('forbidden'), { status: 403 }) },
  })
  assert.equal(result.kind, 'failed')
})
