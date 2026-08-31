import assert from 'node:assert/strict'
import test from 'node:test'
import { createCanvasSyncOutbox, type CanvasSyncMutation, type CanvasSyncOutboxStorage } from './canvasSyncOutbox.ts'

function memoryStorage(actions: string[]) {
  const records = new Map<string, CanvasSyncMutation>()
  const storage: CanvasSyncOutboxStorage = {
    async put(record) {
      actions.push(`put:${record.mutationId}`)
      records.set(record.id, structuredClone(record))
    },
    async list(projectId) {
      return [...records.values()].filter((record) => record.projectId === projectId).map((record) => structuredClone(record))
    },
    async delete(id) { records.delete(id) },
  }
  return { storage, records }
}

test('CRDT update 先持久化；丢 ACK 后新实例重放同一 mutation，ACK 后才删除', async () => {
  const actions: string[] = []
  const { storage, records } = memoryStorage(actions)
  const delivered: Array<{ mutationId: string; update: string }> = []
  const pendingCounts: number[] = []
  const options = {
    projectId: 'project-1',
    storage,
    publish: (event: { mutationId: string; update: string }) => {
      actions.push(`publish:${event.mutationId}`)
      delivered.push({ mutationId: event.mutationId, update: event.update })
      return true
    },
    createMutationId: () => 'mutation-1',
    now: () => 100,
    onPendingChanged: (count: number) => pendingCounts.push(count),
  }

  await createCanvasSyncOutbox(options).enqueue('AQID')
  assert.deepEqual(actions, ['put:mutation-1', 'publish:mutation-1'])
  assert.equal(records.size, 1, 'socket send 不是 durable ACK，不能清除 Outbox')
  assert.equal(pendingCounts.at(-1), 1)

  const restored = createCanvasSyncOutbox(options)
  await restored.flush()
  assert.deepEqual(delivered, [
    { mutationId: 'mutation-1', update: 'AQID' },
    { mutationId: 'mutation-1', update: 'AQID' },
  ])

  await restored.ack('mutation-1')
  assert.equal(records.size, 0)
  assert.equal(pendingCounts.at(-1), 0)
})

test('WebSocket 不可用时走 HTTP fallback；网络失败保留原 mutation 供恢复重放', async () => {
  const actions: string[] = []
  const { storage, records } = memoryStorage(actions)
  let rejectFallback!: () => void
  const blockedFallback = new Promise<never>((_resolve, reject) => {
    rejectFallback = () => reject(new Error('offline'))
  })
  let mutationIndex = 0
  const failed = createCanvasSyncOutbox({
    projectId: 'project-1',
    storage,
    publish: () => false,
    fallback: async (event) => {
      actions.push(`fallback-failed:${event.mutationId}`)
      return blockedFallback
    },
    createMutationId: () => `mutation-fallback-${++mutationIndex}`,
    now: () => 100,
  })

  const first = failed.enqueue('AQID')
  while (!actions.includes('fallback-failed:mutation-fallback-1')) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  const second = failed.enqueue('BAUG')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(records.size, 2, '网络请求不能阻塞后续 update 写入 Dexie')
  rejectFallback()
  await Promise.all([first, second])

  const committed: string[] = []
  const restored = createCanvasSyncOutbox({
    projectId: 'project-1',
    storage,
    publish: () => false,
    fallback: async (event) => {
      actions.push(`fallback-committed:${event.mutationId}`)
      committed.push(event.mutationId)
      return { mutationId: event.mutationId }
    },
  })
  assert.deepEqual(await restored.pendingUpdates(), ['AQID', 'BAUG'])
  await restored.flush()

  assert.deepEqual(committed, ['mutation-fallback-1', 'mutation-fallback-2'])
  assert.equal(records.size, 0)

  let permanentAttempts = 0
  const permanentFailure = Object.assign(new Error('mutation conflict'), { code: 'CANVAS_MUTATION_CONFLICT' })
  const permanentOptions = {
    projectId: 'project-1',
    storage,
    publish: () => false,
    fallback: async (event: { mutationId: string }) => {
      permanentAttempts += 1
      if (permanentAttempts === 1) throw permanentFailure
      return { mutationId: event.mutationId }
    },
    classifyPermanentFailure: (error: unknown) => error === permanentFailure
      ? { code: permanentFailure.code, status: 409 }
      : undefined,
  }
  await createCanvasSyncOutbox({
    ...permanentOptions,
    createMutationId: () => 'mutation-permanent',
    now: () => 200,
  }).enqueue('BwgJ')
  assert.deepEqual(records.get('project-1:mutation-permanent')?.blocked, {
    code: 'CANVAS_MUTATION_CONFLICT', status: 409, at: 200,
  })

  const reloaded = createCanvasSyncOutbox(permanentOptions)
  await reloaded.flush()
  assert.equal(permanentAttempts, 1, '刷新后不得自动重发永久失败的增量')
  await reloaded.retryBlocked()
  assert.equal(permanentAttempts, 2, '只在用户显式重试后再次提交')
  assert.equal(records.size, 0)
})
