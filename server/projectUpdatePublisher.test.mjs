import assert from 'node:assert/strict'
import test from 'node:test'
import { publishProjectUpdatedSafely } from './projectUpdatePublisher.mjs'

test('项目已经保存后，实时通知失败不会把保存结果改写成失败', async () => {
  const logged = []
  const published = await publishProjectUpdatedSafely({
    publishProjectUpdated: async () => { throw new Error('temporary realtime failure') },
  }, {
    document: { id: 'project-1', nodes: [], edges: [], updatedAt: 200 },
    revision: 2,
    graphRevision: 3,
  }, 'user-1', {
    error: (message) => logged.push(message),
  })

  assert.equal(published, false)
  assert.equal(logged.length, 1)
  assert.match(logged[0], /temporary realtime failure/)
})
