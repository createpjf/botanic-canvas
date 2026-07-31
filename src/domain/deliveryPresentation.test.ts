import assert from 'node:assert/strict'
import test from 'node:test'
import type { DeliveryArtifact } from './canvas.ts'
import {
  buildDeliveryPreviewArtifacts,
  canUseForImageDelivery,
  resolveDeliveryDraft,
} from './deliveryPresentation.ts'

test('图片投放交付会拦截视频结果', () => {
  assert.equal(canUseForImageDelivery('image'), true)
  assert.equal(canUseForImageDelivery('video'), false)
})

test('切换到没有交付记录的新素材时不会继承上一张素材的文案', () => {
  const deliveries: DeliveryArtifact[] = [{
    id: 'delivery-old-taobao',
    targetNodeId: 'result-old',
    targetLabel: '旧素材',
    image: '/old.png',
    presetId: 'taobao',
    title: '旧标题',
    subtitle: '旧副标题',
    safeZone: false,
    createdAt: 1,
  }]

  assert.deepEqual(resolveDeliveryDraft('result-old', deliveries), {
    title: '旧标题',
    subtitle: '旧副标题',
    safeZone: false,
  })
  assert.deepEqual(resolveDeliveryDraft('result-new', deliveries), {
    title: '',
    subtitle: '',
    safeZone: true,
  })
})

test('实时预览按已选渠道生成独立规格且不会修改原文案', () => {
  const artifacts = buildDeliveryPreviewArtifacts({
    target: {
      nodeId: 'result-new',
      versionId: 'version-new',
      image: '/new.png',
      label: '新素材',
    },
    presets: ['taobao', 'douyin'],
    draft: {
      title: '  夏日香氛  ',
      subtitle: '  清透留白  ',
      safeZone: true,
    },
    createdAt: 42,
  })

  assert.deepEqual(artifacts.map((item) => item.presetId), ['taobao', 'douyin'])
  assert.deepEqual(artifacts.map((item) => item.id), [
    'delivery-preview-result-new-taobao',
    'delivery-preview-result-new-douyin',
  ])
  assert.equal(artifacts[0]?.title, '夏日香氛')
  assert.equal(artifacts[0]?.subtitle, '清透留白')
  assert.equal(artifacts[0]?.targetVersionId, 'version-new')
})
