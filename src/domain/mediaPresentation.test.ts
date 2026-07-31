import assert from 'node:assert/strict'
import test from 'node:test'
import { mediaFileExtension, reducedAspectRatio } from './mediaPresentation.ts'

test('视频结果使用媒体真实宽高显示节点比例', () => {
  assert.equal(reducedAspectRatio(1440, 1440), '1:1')
  assert.equal(reducedAspectRatio(1920, 1080), '16:9')
  assert.equal(reducedAspectRatio(0, 1080), undefined)
})

test('视频下载始终使用 MP4 扩展名', () => {
  assert.equal(mediaFileExtension('video'), 'mp4')
  assert.equal(mediaFileExtension('image', 'image/jpeg'), 'jpg')
})
