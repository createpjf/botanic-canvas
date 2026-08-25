import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DeliveryPackageError,
  createDeliveryPackage,
  deliveryPackageFileName,
  mediaIdFromUrl,
} from './deliveryPackage.mjs'

const run = {
  id: 'run-1', workflowId: 'wf-1', workflowVersion: 1, projectId: 'p-1',
  definition: { planFingerprint: 'plan-1' },
  items: [
    { id: 'item-1', jobId: 'job-1', input: { sku: 'SKU-A' } },
    { id: 'item-2', jobId: 'job-2', input: { sku: 'SKU-B' } },
  ],
}

const jobs = [
  {
    id: 'job-1', settings: { model: 'gpt-image-2' }, brandKitFingerprint: 'brand-1',
    generationRecipe: { references: [{ assetId: 'asset-1' }] },
    outputs: [{ id: 'out-1', image: '/api/media/media-1', spec: { mimeType: 'image/png', byteSize: 3 } }],
  },
  {
    id: 'job-2', settings: { model: 'gpt-image-2' }, brandKitFingerprint: 'brand-1',
    generationRecipe: { references: [{ assetId: 'asset-1' }] },
    outputs: [{ id: 'out-2', image: '/api/media/media-2', spec: { mimeType: 'image/png', byteSize: 3 } }],
  },
]

const approvals = (artifactIds) => [{
  id: 't-1', qualityPolicyFingerprint: 'qp-1',
  decisions: artifactIds.map((artifactId) => ({ artifactId, decision: 'accepted', decidedAt: 1 })),
}]

const media = { 'media-1': Buffer.from('AAA'), 'media-2': Buffer.from('BBB') }
const readMedia = async (mediaId) => (media[mediaId] ? { buffer: media[mediaId] } : undefined)

const collect = async (stream) => {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

test('同源媒体地址解析，非同源一律取不到', () => {
  assert.equal(mediaIdFromUrl('/api/media/abc%2F1'), 'abc/1')
  // data URL 与外部地址都不是可打包的媒体记录。
  assert.equal(mediaIdFromUrl('https://example.com/a.png'), undefined)
  assert.equal(mediaIdFromUrl('data:image/png;base64,AA'), undefined)
  assert.equal(mediaIdFromUrl(undefined), undefined)
})

test('包里装的就是清单里的那些文件，外加清单本身', async () => {
  const pack = createDeliveryPackage({
    run, jobs, reviewTasks: approvals(['generation:job-1:out-1', 'generation:job-2:out-2']),
    nameTemplate: '{{sku}}-{{index}}', readMedia, now: 5,
  })
  assert.deepEqual(pack.manifest.files.map((file) => file.fileName), ['SKU-A-1.png', 'SKU-B-1.png'])
  const buffer = await collect(pack.stream())
  // 独立按规范读回中央目录（与 zipArchive.test.mjs 同一读法）。
  const names = readZipNames(buffer)
  // 清单本身进包：交付出去的文件要能自证血缘与审批。
  assert.deepEqual(names, ['SKU-A-1.png', 'SKU-B-1.png', 'manifest.json'])
  assert.equal(pack.fileName, 'delivery-run-1.zip')
})

test('未获人工批准的候选不进包，也不进清单', async () => {
  // 只批准了第一项。
  const pack = createDeliveryPackage({
    run, jobs, reviewTasks: approvals(['generation:job-1:out-1']),
    nameTemplate: '{{sku}}-{{index}}', readMedia, now: 5,
  })
  assert.deepEqual(pack.manifest.files.map((file) => file.fileName), ['SKU-A-1.png'])
  assert.deepEqual(pack.manifest.excluded.map((entry) => entry.reason), ['not_approved'])
  assert.deepEqual(readZipNames(await collect(pack.stream())), ['SKU-A-1.png', 'manifest.json'])
})

test('一个都没批准时直接拒绝出包，并说明有几个待批', () => {
  assert.throws(
    () => createDeliveryPackage({ run, jobs, reviewTasks: [], readMedia, now: 5 }),
    (error) => error instanceof DeliveryPackageError
      && error.code === 'DELIVERY_PACKAGE_EMPTY'
      && /2 个候选未获批准/u.test(error.message),
  )
})

test('取不到字节让整个包失败，不静默少几张', async () => {
  // 少了几张的包比报错糟得多：报错能重试，而收到包的人不会去数够不够。
  const pack = createDeliveryPackage({
    run, jobs, reviewTasks: approvals(['generation:job-1:out-1', 'generation:job-2:out-2']),
    nameTemplate: '{{sku}}-{{index}}', now: 5,
    readMedia: async (mediaId) => (mediaId === 'media-1' ? { buffer: media['media-1'] } : undefined),
  })
  await assert.rejects(() => collect(pack.stream()),
    (error) => error instanceof DeliveryPackageError && error.code === 'DELIVERY_MEDIA_UNAVAILABLE'
      && /SKU-B-1\.png/u.test(error.message))
})

test('输出不是同源媒体记录时同样失败', async () => {
  const external = jobs.map((job) => (job.id === 'job-2'
    ? { ...job, outputs: [{ ...job.outputs[0], image: 'https://example.com/b.png' }] }
    : job))
  const pack = createDeliveryPackage({
    run, jobs: external, reviewTasks: approvals(['generation:job-1:out-1', 'generation:job-2:out-2']),
    nameTemplate: '{{sku}}-{{index}}', readMedia, now: 5,
  })
  await assert.rejects(() => collect(pack.stream()), /没有可读取的媒体记录/u)
})

test('清单级冲突在写字节之前就暴露', () => {
  // 响应头在写第一个字节之前发出；之后再失败只能断流。
  const collidingRun = {
    ...run,
    items: [
      { id: 'item-1', jobId: 'job-1', input: { sku: 'SAME' } },
      { id: 'item-2', jobId: 'job-2', input: { sku: 'SAME' } },
    ],
  }
  assert.throws(() => createDeliveryPackage({
    run: collidingRun, jobs, reviewTasks: approvals(['generation:job-1:out-1', 'generation:job-2:out-2']),
    nameTemplate: '{{sku}}-{{index}}', readMedia, now: 5,
  }), /交付文件名重复/u)
})

test('包名用运行标识而不是工作流名', () => {
  // 工作流可以改名，而运行标识唯一；收到两个同名包却对应不同批次最难查。
  assert.equal(deliveryPackageFileName({ runId: 'run-9' }), 'delivery-run-9.zip')
  assert.equal(deliveryPackageFileName({ runId: 'a b/c' }), 'delivery-a-b-c.zip')
  assert.equal(deliveryPackageFileName({}), 'delivery-run.zip')
})

/** 独立按 ZIP 规范读中央目录里的条目名。 */
function readZipNames(buffer) {
  const eocd = buffer.length - 22
  assert.equal(buffer.readUInt32LE(eocd), 0x06054b50, 'EOCD 签名')
  const count = buffer.readUInt16LE(eocd + 10)
  let cursor = buffer.readUInt32LE(eocd + 16)
  const names = []
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    names.push(buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength))
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return names
}
