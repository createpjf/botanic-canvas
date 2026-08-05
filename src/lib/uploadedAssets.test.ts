import test from 'node:test'
import assert from 'node:assert/strict'
import { maxUploadAssets, validateUploadFiles } from './uploadedAssets.ts'

test('上传素材端口集中声明批次上限和可接受图片类型', () => {
  const accepted = new File(['image'], 'product.png', { type: 'image/png' })
  const rejectedType = new File(['image'], 'product.gif', { type: 'image/gif' })
  const empty = new File([], 'empty.jpg', { type: 'image/jpeg' })
  const result = validateUploadFiles([accepted, rejectedType, empty])

  assert.equal(maxUploadAssets, 12)
  assert.deepEqual(result.accepted, [accepted])
  assert.match(result.message, /已跳过 2 个文件/)
})
