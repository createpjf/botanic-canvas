import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildImageProviderPrompt,
  compositionBrandGuard,
  compositionOverlayReferences,
  gptImage2EditQuality,
  isGenerationMarkReference,
  orderCompositionReferences,
  shouldPixelOverlayCompose,
} from './generationComposition.mjs'

test('标识类参考按名称识别，并在多图时排到最后', () => {
  assert.equal(isGenerationMarkReference({ name: 'logo-full 2' }), true)
  assert.equal(isGenerationMarkReference({ name: '棚拍人像' }), false)
  assert.deepEqual(
    orderCompositionReferences([{ name: 'logo-full 2' }, { name: '棚拍人像' }]).map((item) => item.name),
    ['棚拍人像', 'logo-full 2'],
  )
  assert.deepEqual(
    compositionOverlayReferences([
      { name: '棚拍人像' },
      { name: 'logo-full 2' },
    ]).map((item) => item.name),
    ['logo-full 2'],
  )
})

test('多图合成 Prompt 把第一张当底图，并要求原样使用标识', () => {
  const prompt = buildImageProviderPrompt({
    kind: 'generation',
    prompt: '勋章图案严格还原文字标识，杂志封面光影。',
    settings: { aspectRatio: '3:4', resolution: '2K' },
    references: [
      { name: 'logo-full 2', role: '参考', primary: true },
      { name: '棚拍人像', role: '模特' },
    ],
  })
  assert.match(prompt, /GPT Image 多图编辑/)
  assert.match(prompt, /Image 1（模特：棚拍人像）：底图/)
  assert.match(prompt, /Image 2（参考：logo-full 2）：必须忠实复原/)
  assert.match(prompt, /禁止替换成其他徽章或随机图案/)
  assert.equal(prompt.includes('电商品牌首图'), false)
  assert.equal(prompt.includes('不要添加未被要求的品牌标识'), false)
  assert.equal(gptImage2EditQuality({
    prompt: '勋章图案严格还原文字标识，杂志封面光影。',
    settings: { resolution: '2K' },
    references: [{ name: 'logo-full 2' }, { name: '棚拍人像' }],
  }), 'high')
})

test('单张商品图仍提醒不要发明参考图里没有的标识', () => {
  const prompt = buildImageProviderPrompt({
    kind: 'generation',
    prompt: '香氛商品主图',
    settings: { aspectRatio: '1:1', resolution: '2K' },
    references: [{ name: '主商品', role: '商品', primary: true }],
  })
  assert.match(prompt, /品牌时尚视觉/)
  assert.match(prompt, /不要添加参考图中没有的品牌标识/)
  assert.equal(compositionBrandGuard([{ name: '主商品' }]).includes('必须原样出现'), false)
})

test('贴标识默认不走像素合成，只有显式 overlay 才贴图层', () => {
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
})

test('局部重绘带标识时，后续图是填进选区的元素', () => {
  const prompt = buildImageProviderPrompt({
    kind: 'refinement',
    refinementMode: 'faithful',
    prompt: '勋章还原标识',
    settings: { aspectRatio: '3:4', resolution: '1K' },
    parent: { name: '已选首图' },
    references: [{ name: 'logo-full 2', role: '参考' }],
    maskRegion: { x: 0.7, y: 0.3, width: 0.1, height: 0.1 },
  })
  assert.match(prompt, /GPT Image 多图编辑/)
  assert.match(prompt, /Image 1（底图：已选首图）：底图/)
  assert.match(prompt, /Image 2（参考：logo-full 2）：必须忠实复原/)
  assert.match(prompt, /原样嵌入选区/)
})
