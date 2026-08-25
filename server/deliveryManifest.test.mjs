import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DELIVERY_NAME_VARIABLES,
  buildDeliveryManifest,
  deliveryFileName,
  isApprovedForDelivery,
} from './deliveryManifest.mjs'

const spec = { mimeType: 'image/png', byteSize: 4096, width: 1024, height: 1024 }

function run() {
  return {
    id: 'wf-run-1', workflowId: 'wf-1', workflowVersion: 2, projectId: 'project-1',
    definition: { output: { aspectRatio: '1:1', nameTemplate: '{{sku}}-{{channel}}-{{index}}' }, planFingerprint: 'plan-fp' },
    items: [
      { id: 'SKU-001', input: { sku: 'SKU-001', channel: 'tmall' }, jobId: 'job-a', status: 'succeeded' },
      { id: 'SKU-002', input: { sku: 'SKU-002', channel: 'tmall' }, jobId: 'job-b', status: 'succeeded' },
    ],
  }
}

const jobs = () => [
  { id: 'job-a', settings: { model: 'gpt-image-2' }, branchFingerprint: 'branch-a', outputs: [{ id: 'out-1', mediaKind: 'image', spec }] },
  { id: 'job-b', settings: { model: 'gpt-image-2' }, branchFingerprint: 'branch-b', outputs: [{ id: 'out-1', mediaKind: 'image', spec }] },
]

const approvals = (decisions) => [{
  id: 'review_task_1', qualityPolicyFingerprint: 'policy-fp',
  decisions,
}]

test('只有人工批准的候选进交付包', () => {
  // 自动评审通过不算批准：ADR 0006 明确自动评审不得标记品牌批准。
  const manifest = buildDeliveryManifest({
    run: run(), jobs: jobs(), now: 100,
    reviewTasks: approvals([{ artifactId: 'generation:job-a:out-1', decision: 'accepted', decidedAt: 5 }]),
  })
  assert.equal(manifest.fileCount, 1)
  assert.equal(manifest.files[0].artifactId, 'generation:job-a:out-1')
  // 被排除的候选与原因一起给出：静默少几张比报错更难查。
  assert.deepEqual(manifest.excluded, [{ artifactId: 'generation:job-b:out-1', itemId: 'SKU-002', reason: 'not_approved' }])
})

test('同一候选多次决定以最后一次为准', () => {
  const artifactId = 'generation:job-a:out-1'
  assert.equal(isApprovedForDelivery(artifactId, approvals([
    { artifactId, decision: 'accepted', decidedAt: 5 },
    { artifactId, decision: 'rejected', decidedAt: 9 },
  ])), false)
  assert.equal(isApprovedForDelivery(artifactId, approvals([
    { artifactId, decision: 'rejected', decidedAt: 5 },
    { artifactId, decision: 'accepted', decidedAt: 9 },
  ])), true)
  assert.equal(isApprovedForDelivery(artifactId, approvals([])), false)
  assert.equal(isApprovedForDelivery(artifactId, []), false)
})

test('文件名按业务身份生成，规格是实测值', () => {
  const manifest = buildDeliveryManifest({
    run: run(), jobs: jobs(), now: 100,
    reviewTasks: approvals([
      { artifactId: 'generation:job-a:out-1', decision: 'accepted', decidedAt: 5 },
      { artifactId: 'generation:job-b:out-1', decision: 'accepted', decidedAt: 5 },
    ]),
  })
  assert.deepEqual(manifest.files.map((file) => file.fileName), ['SKU-001-tmall-1.png', 'SKU-002-tmall-1.png'])
  assert.deepEqual(manifest.files[0].spec, { mimeType: 'image/png', byteSize: 4096, width: 1024, height: 1024 })
  assert.deepEqual(manifest.files[0].lineage, {
    workflowId: 'wf-1', workflowVersion: 2, runId: 'wf-run-1',
    planFingerprint: 'plan-fp', branchFingerprint: 'branch-a', model: 'gpt-image-2',
  })
  assert.equal(manifest.approvals.length, 2)
  assert.ok(manifest.checksum)
})

test('文件名重复直接拒绝：打包时同名会互相覆盖', () => {
  const collided = run()
  collided.definition.output.nameTemplate = '{{channel}}'
  assert.throws(() => buildDeliveryManifest({
    run: collided, jobs: jobs(),
    reviewTasks: approvals([
      { artifactId: 'generation:job-a:out-1', decision: 'accepted', decidedAt: 5 },
      { artifactId: 'generation:job-b:out-1', decision: 'accepted', decidedAt: 5 },
    ]),
  }), /交付文件名重复/u)
})

test('未声明的命名变量原样保留，不静默变空', () => {
  // 静默替换成空串会产出 `--1.png` 这种看不出哪里错了的名字。
  assert.equal(
    deliveryFileName('{{sku}}-{{unknownField}}', { sku: 'SKU-1' }, { extension: 'png' }),
    'SKU-1-{{unknownField}}.png',
  )
  // 声明过但本项没值的变量同样保留占位，暴露「这一项缺 SKU」。
  assert.equal(deliveryFileName('{{sku}}-{{index}}', { index: '1' }, { extension: 'png' }), '{{sku}}-1.png')
  assert.equal(deliveryFileName(undefined, { itemId: 'item-1', index: '2' }, { extension: 'png' }), 'item-1-2.png')
  assert.deepEqual([...DELIVERY_NAME_VARIABLES], ['sku', 'channel', 'language', 'aspectRatio', 'index', 'itemId', 'runId'])
})

test('视频与图片按实测类型给扩展名，清单不含媒体字节', () => {
  const videoRun = run()
  videoRun.items = [{ id: 'SKU-V', input: { sku: 'SKU-V' }, jobId: 'job-v' }]
  const manifest = buildDeliveryManifest({
    run: videoRun,
    jobs: [{ id: 'job-v', settings: { model: 'minimax-h3' }, outputs: [{ id: 'out-1', mediaKind: 'video', spec: { mimeType: 'video/mp4', byteSize: 9, durationSeconds: 5 } }] }],
    reviewTasks: approvals([{ artifactId: 'generation:job-v:out-1', decision: 'accepted', decidedAt: 1 }]),
  })
  assert.match(manifest.files[0].fileName, /\.mp4$/u)
  assert.equal(manifest.files[0].spec.durationSeconds, 5)
  const serialized = JSON.stringify(manifest)
  assert.equal(serialized.includes('/api/media/'), false)
  assert.equal(serialized.includes('data:'), false)
})

test('没有任何批准时给出空清单而不是报错', () => {
  const manifest = buildDeliveryManifest({ run: run(), jobs: jobs(), reviewTasks: [] })
  assert.equal(manifest.fileCount, 0)
  assert.equal(manifest.excluded.length, 2)
})
