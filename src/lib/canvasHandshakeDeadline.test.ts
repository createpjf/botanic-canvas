import assert from 'node:assert/strict'
import test from 'node:test'
import { createCanvasHandshakeDeadline } from './canvasHandshakeDeadline.ts'

test('画布握手超时会触发恢复，收到回执后不会误触发', async () => {
  let expired = 0
  const deadline = createCanvasHandshakeDeadline(() => { expired += 1 }, 10)

  deadline.arm()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(expired, 1)

  deadline.arm()
  deadline.clear()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(expired, 1)
})
