import assert from 'node:assert/strict'
import test from 'node:test'
import {
  botanicAgentRegionSelectNotice,
  compositionOverlayReferences,
  gptImage2EditQuality,
  instructionRequestsMarkOverlay,
  isGenerationMarkReference,
  orderCompositionReferences,
  shouldPixelOverlayCompose,
  shouldUseHighFidelityCompose,
  withRegionEditOverlayReferences,
} from './generationComposition.ts'

test('按名称识别标识类参考，人像和商品图不是标识', () => {
  assert.equal(isGenerationMarkReference({ name: 'logo-full 2' }), true)
  assert.equal(isGenerationMarkReference({ name: '品牌标识' }), true)
  assert.equal(isGenerationMarkReference({ name: '领针徽章' }), true)
  assert.equal(isGenerationMarkReference({ name: '棚拍人像' }), false)
  assert.equal(isGenerationMarkReference({ name: '球衣' }), false)
  assert.equal(isGenerationMarkReference({ name: '' }), false)
})

test('多图合成时标识不能当第一张底图，其余相对顺序不变', () => {
  assert.deepEqual(
    orderCompositionReferences([
      { name: 'logo-full 2' },
      { name: '棚拍人像' },
      { name: '灰色背景' },
    ]).map((item) => item.name),
    ['棚拍人像', '灰色背景', 'logo-full 2'],
  )
  assert.deepEqual(
    orderCompositionReferences([{ name: 'logo-full 2' }]).map((item) => item.name),
    ['logo-full 2'],
  )
  assert.deepEqual(
    orderCompositionReferences([{ name: '球衣' }, { name: '模特' }]).map((item) => item.name),
    ['球衣', '模特'],
  )
})

test('局部重绘在没有本轮参考时，只从原配方补回标识图', () => {
  const recipe = {
    prompt: '勋章还原标识',
    references: [] as Array<{ name: string; image: string }>,
    maskRegion: { x: 0.7, y: 0.3, width: 0.1, height: 0.1 },
  }
  const parent = {
    references: [
      { name: '棚拍人像', image: '/api/media/media_person' },
      { name: 'logo-full 2', image: '/api/media/media_logo' },
    ],
  }

  const filled = withRegionEditOverlayReferences(recipe, parent)
  assert.deepEqual(filled.references, [{ name: 'logo-full 2', image: '/api/media/media_logo' }])
  assert.equal(filled.references[0] === parent.references[1], false)

  const alreadySet = withRegionEditOverlayReferences({
    ...recipe,
    references: [{ name: '本轮氛围', image: '/api/media/media_mood' }],
  }, parent)
  assert.deepEqual(alreadySet.references.map((item) => item.name), ['本轮氛围'])

  assert.deepEqual(compositionOverlayReferences(parent.references).map((item) => item.name), ['logo-full 2'])
})

test('贴标识默认走 GPT Image 2 高质合成，像素贴图层只在显式 overlay', () => {
  assert.equal(instructionRequestsMarkOverlay('添加flock.io的logo'), true)
  assert.equal(instructionRequestsMarkOverlay('勋章图案严格还原文字标识'), true)
  assert.equal(instructionRequestsMarkOverlay('把右上角换成盛开花丛'), false)
  assert.equal(shouldUseHighFidelityCompose({
    prompt: '添加flock.io的logo',
    references: [{ name: 'logo-full 2' }],
  }), true)
  assert.equal(gptImage2EditQuality({
    prompt: '添加flock.io的logo',
    references: [{ name: 'logo-full 2' }],
    settings: { resolution: '1K' },
  }), 'high')
  assert.equal(gptImage2EditQuality({
    prompt: '香氛商品主图',
    references: [{ name: '主商品' }],
    settings: { resolution: '1K' },
  }), 'low')
  assert.equal(shouldPixelOverlayCompose({
    prompt: '添加flock.io的logo',
    maskRegion: { x: 0.7, y: 0.3, width: 0.1, height: 0.1 },
    references: [{ name: 'logo-full 2' }],
  }), false)
  assert.equal(shouldPixelOverlayCompose({
    prompt: '添加flock.io的logo',
    maskRegion: { x: 0.7, y: 0.3, width: 0.1, height: 0.1 },
    references: [{ name: 'logo-full 2' }],
    composeMode: 'overlay',
  }), true)
  assert.equal(botanicAgentRegionSelectNotice('添加logo', '精修候选1'), '请在「精修候选1」上框选标识要贴上去的位置。我们会把参考图原样贴进选区，不会让模型另造徽章。')
})
