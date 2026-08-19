import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyCustomGenerationSize,
  catalogAspectRatiosForModel,
  catalogGenerationSize,
  customGenerationSizeFields,
  generationSettingsSizeLabel,
  inferAspectRatioFromPixels,
  modelSupportsCustomSize,
  normalizeCustomGenerationSize,
  parseCustomGenerationSize,
  resolveGenerationOutputSize,
  withoutCustomGenerationSize,
} from './generationOutputSize.ts'

test('gpt-image-2 目录含 16:9 / 4:3 的合法像素，1K 16:9 为 1536x864', () => {
  assert.equal(catalogGenerationSize('16:9', '1K'), '1536x864')
  assert.equal(catalogGenerationSize('4:3', '1K'), '1536x1152')
  assert.equal(catalogGenerationSize('16:9', '2K'), '2048x1152')
  assert.equal(catalogGenerationSize('1:1', '2K'), '2048x2048')
})

test('1920x1080 对齐到 16 的倍数后可被 gpt-image-2 接受', () => {
  const result = normalizeCustomGenerationSize(1920, 1080)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.width, 1920)
  assert.equal(result.height, 1088)
  assert.equal(result.snapped, true)
  assert.equal(result.size, '1920x1088')
})

test('过小、过长或比例超过 3:1 的自定义尺寸被拒绝', () => {
  assert.equal(normalizeCustomGenerationSize(100, 100).ok, false)
  assert.equal(normalizeCustomGenerationSize(3840, 16).ok, false)
  assert.equal(normalizeCustomGenerationSize(5000, 5000).ok, false)
})

test('从指令里解析 1920×1080 / 1920*1080', () => {
  assert.deepEqual(parseCustomGenerationSize('请用 1920×1080 出图'), { width: 1920, height: 1080 })
  assert.deepEqual(parseCustomGenerationSize('自定义 1920*1080'), { width: 1920, height: 1080 })
  assert.equal(parseCustomGenerationSize('只要 16:9'), undefined)
})

test('有自定义像素时标签显示宽高，否则显示比例与清晰度', () => {
  assert.equal(generationSettingsSizeLabel({ aspectRatio: '1:1', resolution: '1K' }), '1:1 · 1K')
  assert.equal(generationSettingsSizeLabel({
    aspectRatio: '16:9', resolution: '2K', outputWidth: 1920, outputHeight: 1088,
  }), '1920×1088')
})

test('resolveGenerationOutputSize 优先自定义像素，否则走目录', () => {
  assert.equal(resolveGenerationOutputSize({ aspectRatio: '3:4', resolution: '2K' }), '1536x2048')
  assert.equal(resolveGenerationOutputSize({
    aspectRatio: '16:9', resolution: '1K', outputWidth: 1920, outputHeight: 1080,
  }), '1920x1088')
})

test('只有 gpt-image-2 支持自定义尺寸', () => {
  assert.equal(modelSupportsCustomSize({ id: 'gpt-image-2' }), true)
  assert.equal(modelSupportsCustomSize('gpt-image-2'), true)
  assert.equal(modelSupportsCustomSize({ id: 'gpt-image-1' }), false)
  assert.equal(modelSupportsCustomSize({ id: 'image-01', supportsCustomSize: false }), false)
  assert.equal(inferAspectRatioFromPixels(1920, 1088), '16:9')
})

test('gpt-image-2 缺省目录含 16:9 / 4:3，其它模型保持竖图四档', () => {
  assert.deepEqual(catalogAspectRatiosForModel('gpt-image-2'), ['1:1', '16:9', '4:3', '3:4', '4:5', '9:16'])
  assert.deepEqual(catalogAspectRatiosForModel({ id: 'gpt-image-1' }), ['1:1', '3:4', '4:5', '9:16'])
  assert.deepEqual(catalogAspectRatiosForModel({
    id: 'gpt-image-2', aspectRatios: ['1:1', '16:9'],
  }), ['1:1', '16:9'])
})

test('无效自定义像素被丢弃，合法像素会对齐后写回', () => {
  assert.equal(customGenerationSizeFields({ outputWidth: 100, outputHeight: 100 }), undefined)
  assert.deepEqual(customGenerationSizeFields({ outputWidth: 1920, outputHeight: 1080 }), {
    outputWidth: 1920, outputHeight: 1088,
  })
  const applied = applyCustomGenerationSize({
    model: 'gpt-image-2', aspectRatio: '1:1', resolution: '2K',
  }, 1920, 1080)
  assert.equal(applied.ok, true)
  if (!applied.ok || !applied.settings) return
  assert.equal(applied.settings.aspectRatio, '16:9')
  assert.equal(applied.settings.outputWidth, 1920)
  assert.equal(applied.settings.outputHeight, 1088)
  assert.equal('outputWidth' in withoutCustomGenerationSize(applied.settings), false)
})
