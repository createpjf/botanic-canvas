import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GENERATION_LIQUID_TRAVEL, generationLiquidTravel } from './generationLiquidTravel.ts'

test('liquid 只跟任务阶段和等待时长对齐，不循环也不到 1', () => {
  assert.equal(generationLiquidTravel({ taskStatus: 'submission_unknown' }), GENERATION_LIQUID_TRAVEL.submissionUnknown)
  assert.equal(generationLiquidTravel({ taskStatus: 'uploading' }), GENERATION_LIQUID_TRAVEL.uploading)
  assert.equal(generationLiquidTravel({ taskStatus: 'queued', elapsedSeconds: 40 }), GENERATION_LIQUID_TRAVEL.queued)
  assert.ok(generationLiquidTravel({ taskStatus: 'uploading' }) < generationLiquidTravel({ taskStatus: 'queued' }))
  assert.ok(generationLiquidTravel({ taskStatus: 'queued' }) < generationLiquidTravel({ taskStatus: 'running', elapsedSeconds: 0 }))

  const start = generationLiquidTravel({ taskStatus: 'running', elapsedSeconds: 0 })
  const mid = generationLiquidTravel({ taskStatus: 'running', elapsedSeconds: 8 })
  const later = generationLiquidTravel({ taskStatus: 'running', elapsedSeconds: 24 })
  const long = generationLiquidTravel({ taskStatus: 'running', elapsedSeconds: 180 })
  assert.ok(start < mid)
  assert.ok(mid < later)
  assert.ok(later <= long)
  assert.ok(long < 0.87)
  assert.ok(long < 1)

  const beforeWrap = generationLiquidTravel({ taskStatus: 'running', elapsedSeconds: 5 })
  const afterOldCycle = generationLiquidTravel({ taskStatus: 'running', elapsedSeconds: 12 })
  assert.ok(afterOldCycle > beforeWrap)
})

test('视频任务用更长视界，同样单次逼近上限', () => {
  const image = generationLiquidTravel({ taskStatus: 'running', elapsedSeconds: 16, mediaKind: 'image' })
  const video = generationLiquidTravel({ taskStatus: 'running', elapsedSeconds: 16, mediaKind: 'video' })
  assert.ok(video < image)
  assert.ok(generationLiquidTravel({ taskStatus: 'running', elapsedSeconds: 200, mediaKind: 'video' }) < 0.87)
})
