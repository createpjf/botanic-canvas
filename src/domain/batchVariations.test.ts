import assert from 'node:assert/strict'
import test from 'node:test'
import { createBatchVariationRun, mapBatchVariationWithConcurrency, nextResumableBatchVariationRun, summarizeBatchVariationRun } from './batchVariations.ts'

const settings = { model: 'gpt-image-2', aspectRatio: '3:4' as const, resolution: '2K' as const }

test('批量变体为每个素材建立独立可恢复子任务', () => {
  const run = createBatchVariationRun({
    now: 100,
    sourceResultNodeId: 'result-a',
    group: { id: 'group-scene', name: '夏日场景', role: '场景', assetIds: ['scene-a', 'scene-b'] },
    prompt: '只替换场景', candidatesPerAsset: 2, maximumBatchCount: 4, settings,
    resolveAssetName: (assetId) => assetId === 'scene-a' ? '海边' : '泳池',
    agentRunId: 'run-a',
    agentBranches: [{ assetId: 'scene-b', branchId: 'branch-b' }],
  })

  assert.equal(run.items.length, 2)
  assert.deepEqual(run.items.map((item) => item.status), ['queued', 'queued'])
  assert.deepEqual(run.items.map((item) => item.assetName), ['海边', '泳池'])
  assert.equal(run.items[1].agentBranchId, 'branch-b')
  assert.notEqual(run.items[0].id, run.items[1].id)
})

test('批量变体总输出超过 20 时在提交前拒绝', () => {
  assert.throws(() => createBatchVariationRun({
    now: 100, sourceResultNodeId: 'result-a',
    group: { id: 'group-scene', name: '场景', role: '场景', assetIds: Array.from({ length: 7 }, (_, index) => `asset-${index}`) },
    prompt: '替换场景', candidatesPerAsset: 3, maximumBatchCount: 4, settings,
    resolveAssetName: (assetId) => assetId,
  }), /单次批量最多创建 20 张结果/)
})

test('并发执行器始终遵守上限且保留全部项目', async () => {
  let active = 0
  let peak = 0
  const completed: number[] = []
  await mapBatchVariationWithConcurrency([0, 1, 2, 3, 4], 3, async (item) => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 1))
    completed.push(item)
    active -= 1
  })

  assert.equal(peak, 3)
  assert.deepEqual(completed.toSorted(), [0, 1, 2, 3, 4])
})

test('部分成功不会被标记成全量成功', () => {
  assert.deepEqual(summarizeBatchVariationRun([
    { status: 'succeeded' }, { status: 'failed' }, { status: 'cancelled' },
  ]), { status: 'partial', succeeded: 1, failed: 2 })
})

test('恢复时只选择队列顺序中的首个未完成父任务', () => {
  const completed = createBatchVariationRun({
    now: 100, sourceResultNodeId: 'result-a',
    group: { id: 'group-a', name: 'A', role: '场景', assetIds: ['asset-a'] },
    prompt: '替换场景', candidatesPerAsset: 1, maximumBatchCount: 4, settings,
    resolveAssetName: (assetId) => assetId,
  })
  const running = createBatchVariationRun({
    now: 200, sourceResultNodeId: 'result-b',
    group: { id: 'group-b', name: 'B', role: '场景', assetIds: ['asset-b'] },
    prompt: '替换场景', candidatesPerAsset: 1, maximumBatchCount: 4, settings,
    resolveAssetName: (assetId) => assetId,
  })
  const queued = createBatchVariationRun({
    now: 300, sourceResultNodeId: 'result-c',
    group: { id: 'group-c', name: 'C', role: '场景', assetIds: ['asset-c'] },
    prompt: '替换场景', candidatesPerAsset: 1, maximumBatchCount: 4, settings,
    resolveAssetName: (assetId) => assetId,
  })

  assert.equal(nextResumableBatchVariationRun([
    { ...completed, status: 'succeeded' },
    { ...running, status: 'running' },
    queued,
  ])?.id, running.id)
  assert.equal(nextResumableBatchVariationRun([{ ...completed, status: 'failed' }]), undefined)
})
