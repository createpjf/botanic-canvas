import assert from 'node:assert/strict'
import test from 'node:test'
import { publishProjectUpdatedSafely } from './projectUpdatePublisher.mjs'

test('项目已经保存后，实时通知失败不会把保存结果改写成失败', async () => {
  const logged = []
  const canvasUpdates = []
  let projectUpdate
  const published = await publishProjectUpdatedSafely({
    publishCanvasGraphCommitted: async (event) => canvasUpdates.push(event),
    publishProjectUpdated: async (event) => {
      projectUpdate = event
      throw new Error('temporary realtime failure')
    },
  }, {
    document: { id: 'project-1', nodes: [], edges: [], updatedAt: 200 },
    revision: 2,
    graphRevision: 3,
  }, 'user-1', {
    error: (message) => logged.push(message),
  }, {
    changed: true,
    update: 'AAA=',
    mutationId: 'generation:job-1',
    graphRevision: 3,
    updatedAt: 200,
  })

  assert.equal(published, false)
  assert.equal(canvasUpdates.length, 1)
  assert.equal('graph' in projectUpdate, false)
  assert.equal(logged.length, 1)
  assert.match(logged[0], /temporary realtime failure/)
})

test('重复图谱提交仍通知 Hub 重载 durable room', async () => {
  const canvasUpdates = []
  await publishProjectUpdatedSafely({
    async publishCanvasGraphCommitted(event) { canvasUpdates.push(event) },
    async publishProjectUpdated() {},
  }, {
    document: { id: 'project-1', updatedAt: 200 },
    revision: 2,
    graphRevision: 3,
  }, 'user-1', console, {
    changed: true,
    duplicate: true,
    update: 'AAA=',
    mutationId: 'generation:job-1',
  })

  assert.equal(canvasUpdates.length, 1)
  assert.equal(canvasUpdates[0].duplicate, true)
})
