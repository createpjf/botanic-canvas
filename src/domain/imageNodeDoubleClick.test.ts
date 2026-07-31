import assert from 'node:assert/strict'
import test from 'node:test'
import { imageNodeDoubleClickIntent } from './imageNodeDoubleClick.ts'

test('双击已有图片的结果节点会打开带来源身份的继续生成菜单', () => {
  assert.deepEqual(imageNodeDoubleClickIntent({
    id: 'result-01',
    type: 'result',
    image: '/api/media/result-01',
    label: '首图候选-01',
  }), {
    kind: 'open-generation-menu',
    resultNodeId: 'result-01',
  })
})

test('双击素材节点仍保持图片预览行为', () => {
  assert.deepEqual(imageNodeDoubleClickIntent({
    id: 'asset-01',
    type: 'asset',
    image: '/api/media/asset-01',
    label: '商品正面',
  }), {
    kind: 'preview-image',
    image: '/api/media/asset-01',
    name: '商品正面',
  })
})
