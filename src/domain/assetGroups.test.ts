import assert from 'node:assert/strict'
import test from 'node:test'
import type { AssetGroup, AssetRecord } from './canvas.ts'
import { normalizeAssetGroups, removeAssetFromGroups, upsertCollectionGroups } from './assetGroups.ts'

const assets: AssetRecord[] = [
  { id: 'scene-1', name: '海边', role: '场景', source: 'upload', collection: '夏季场景', image: 'scene-1', tags: [] },
  { id: 'scene-2', name: '公园', role: '场景', source: 'upload', collection: '夏季场景', image: 'scene-2', tags: [] },
  { id: 'model-1', name: '模特', role: '模特', source: 'upload', collection: '夏季模特', image: 'model-1', tags: [] },
]

test('上传文件夹自动形成素材组并保留全部素材', () => {
  const groups = upsertCollectionGroups([], assets, 100)
  assert.equal(groups.length, 2)
  assert.deepEqual(groups.find((group) => group.name === '夏季场景')?.assetIds, ['scene-1', 'scene-2'])
  assert.equal(groups.find((group) => group.name === '夏季场景')?.role, '场景')
})

test('素材删除后只清理素材组引用，不删除素材组', () => {
  const group: AssetGroup = { id: 'group-1', name: '夏季场景', role: '场景', assetIds: ['scene-1', 'scene-2'], coverAssetId: 'scene-1', createdAt: 1, updatedAt: 1 }
  const [next] = removeAssetFromGroups([group], 'scene-1', 200)
  assert.deepEqual(next.assetIds, ['scene-2'])
  assert.equal(next.coverAssetId, 'scene-2')
})

test('打开旧项目时清理失效和重复素材引用', () => {
  const groups = normalizeAssetGroups([
    { id: 'group-1', name: '  夏季场景  ', role: '场景', assetIds: ['scene-1', 'missing', 'scene-1'], coverAssetId: 'missing', createdAt: 1, updatedAt: 1 },
  ], assets)
  assert.equal(groups[0].name, '夏季场景')
  assert.deepEqual(groups[0].assetIds, ['scene-1'])
  assert.equal(groups[0].coverAssetId, 'scene-1')
})
