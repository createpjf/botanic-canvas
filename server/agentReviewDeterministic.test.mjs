import assert from 'node:assert/strict'
import test from 'node:test'
import { DETERMINISTIC_CRITERIA, REVIEW_VERDICTS, reviewDeterministicLayer, shouldRunModelLayer } from './agentReviewDeterministic.mjs'

const imageSettings = { aspectRatio: '3:4', resolution: '2K' }
const imageSpec = { mimeType: 'image/png', byteSize: 1024, width: 1536, height: 2048 }

const verdictOf = (criteria, id) => criteria.find((item) => item.id === id)?.verdict

test('合规图片逐条通过第 1 层，不需要模型', () => {
  const result = reviewDeterministicLayer({ output: { spec: imageSpec }, settings: imageSettings })
  assert.equal(result.verdict, 'pass')
  assert.equal(verdictOf(result.criteria, 'aspect_ratio'), 'pass')
  assert.equal(verdictOf(result.criteria, 'resolution'), 'pass')
  assert.ok(result.criteria.every((item) => item.layer === 'deterministic'))
})

test('比例不符直接 fail，且不再进第 2 层', () => {
  // 一张比例错误的图不需要再问模型好不好看。
  const result = reviewDeterministicLayer({
    output: { spec: { ...imageSpec, width: 2048, height: 2048 } },
    settings: imageSettings,
  })
  assert.equal(result.verdict, 'fail')
  assert.equal(verdictOf(result.criteria, 'aspect_ratio'), 'fail')
  assert.match(result.criteria.find((item) => item.id === 'aspect_ratio').evidence, /期望 3:4，实际 1:1/u)
  assert.equal(shouldRunModelLayer(result), false)
})

test('分辨率只校验下限：Provider 会给接近而非等于档位的尺寸', () => {
  assert.equal(reviewDeterministicLayer({
    output: { spec: { ...imageSpec, width: 1600, height: 2133 } }, settings: imageSettings,
  }).criteria.find((item) => item.id === 'resolution').verdict, 'pass')
  assert.equal(reviewDeterministicLayer({
    output: { spec: { ...imageSpec, width: 768, height: 1024 } }, settings: imageSettings,
  }).criteria.find((item) => item.id === 'resolution').verdict, 'fail')
})

test('没有实测规格判「无法验证」，不是默认通过', () => {
  // 默认通过会让「没记规格」看起来像「规格正确」。
  const result = reviewDeterministicLayer({ output: {}, settings: imageSettings })
  assert.equal(result.verdict, 'unverifiable')
  assert.equal(verdictOf(result.criteria, 'file_integrity'), 'unverifiable')
  // 无法验证不阻止模型层：规格没记下来不代表画面不对。
  assert.equal(shouldRunModelLayer(result), true)
})

test('声明类型与文件头不一致判 fail', () => {
  const result = reviewDeterministicLayer({
    output: { spec: { ...imageSpec, declaredMimeType: 'video/mp4' } },
    settings: imageSettings,
  })
  assert.equal(verdictOf(result.criteria, 'media_kind'), 'fail')
  assert.equal(result.verdict, 'fail')
})

test('图片计划拿到视频输出判 fail', () => {
  const result = reviewDeterministicLayer({
    output: { spec: { mimeType: 'video/mp4', byteSize: 2048, durationSeconds: 5 } },
    settings: imageSettings,
  })
  assert.equal(verdictOf(result.criteria, 'media_kind'), 'fail')
})

test('视频的时长与容器同样走第 1 层，不因「是视频」整体跳过', () => {
  const settings = { aspectRatio: '9:16', resolution: '1080P', duration: 5 }
  const pass = reviewDeterministicLayer({
    output: { spec: { mimeType: 'video/mp4', byteSize: 4096, durationSeconds: 5.04 } }, settings,
  })
  assert.equal(pass.verdict, 'pass')
  assert.equal(verdictOf(pass.criteria, 'duration'), 'pass')

  const tooShort = reviewDeterministicLayer({
    output: { spec: { mimeType: 'video/mp4', byteSize: 4096, durationSeconds: 2 } }, settings,
  })
  assert.equal(verdictOf(tooShort.criteria, 'duration'), 'fail')

  const unknownDuration = reviewDeterministicLayer({
    output: { spec: { mimeType: 'video/mp4', byteSize: 4096 } }, settings,
  })
  assert.equal(verdictOf(unknownDuration.criteria, 'duration'), 'unverifiable')
  assert.equal(unknownDuration.verdict, 'unverifiable')
})

test('计划没声明比例或分辨率时报无法验证，而不是悄悄跳过', () => {
  const result = reviewDeterministicLayer({ output: { spec: imageSpec }, settings: {} })
  assert.equal(verdictOf(result.criteria, 'aspect_ratio'), 'unverifiable')
  assert.equal(verdictOf(result.criteria, 'resolution'), 'unverifiable')
  assert.equal(result.verdict, 'unverifiable')
})

test('判定档与检查项都是声明式的', () => {
  assert.deepEqual([...REVIEW_VERDICTS], ['pass', 'fail', 'unverifiable'])
  assert.deepEqual([...DETERMINISTIC_CRITERIA], ['media_kind', 'file_integrity', 'aspect_ratio', 'resolution', 'duration'])
})
