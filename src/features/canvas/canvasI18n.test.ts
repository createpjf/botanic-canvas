import assert from 'node:assert/strict'
import test from 'node:test'
import { canvasSystemLabel } from './canvasI18n.ts'

test('画布只翻译 Botanic 稳定标签并保留用户名称', () => {
  assert.equal(canvasSystemLabel('图像生成 01', 'en'), 'Image generation 01')
  assert.equal(canvasSystemLabel('视频生成 02', 'en'), 'Video generation 02')
  assert.equal(canvasSystemLabel('商品主图 · 图像 03', 'en'), '商品主图 · Image 03')
  assert.equal(canvasSystemLabel('首图候选 · 等待确认', 'en'), 'Key visual candidate · Awaiting confirmation')
  assert.equal(canvasSystemLabel('用户自定义节点', 'en'), '用户自定义节点')
  assert.equal(canvasSystemLabel('图像生成 01', 'zh-CN'), '图像生成 01')
})
