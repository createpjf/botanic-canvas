import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatBotanicAgentCompositionMessage,
  normalizeBotanicAgentComposition,
  resolveBotanicAgentCompositionItem,
} from './agentCreativeComposition.ts'

test('分解归一化：空项剔除、数量夹取、视频固定一条且时长取目录', () => {
  const composition = normalizeBotanicAgentComposition({
    theme: '小红书春季山茶花系列',
    items: [
      { title: '主视觉', mediaKind: 'image', prompt: '盛开山茶花与人物半身像', count: 99 },
      { prompt: '' },
      { title: '细节', purpose: '第二屏', mediaKind: 'image', prompt: '花瓣特写，晨露' },
      { title: '氛围视频', mediaKind: 'video', prompt: '镜头缓推花丛', count: 3, duration: 7 },
    ],
  }, { videoDurations: [5, 10] })

  assert.ok(composition)
  assert.equal(composition.items.length, 3)
  assert.deepEqual(composition.items.map((item) => item.index), [1, 2, 3])
  assert.equal(composition.items[0].count, 4)
  assert.equal(composition.items[2].mediaKind, 'video')
  assert.equal(composition.items[2].count, 1)
  assert.equal(composition.items[2].duration, 5)
})

test('少于 2 个有效项或缺主题时不成方案', () => {
  assert.equal(normalizeBotanicAgentComposition({ theme: '单项', items: [{ prompt: '只有一项', mediaKind: 'image' }] }), null)
  assert.equal(normalizeBotanicAgentComposition({ theme: '', items: [{ prompt: 'a' }, { prompt: 'b' }] }), null)
})

test('方案卡逐项可读，「生成第 N 项」按序号（含中文数字）直落对应项', () => {
  const composition = normalizeBotanicAgentComposition({
    theme: '春季系列',
    items: [
      { title: '主视觉', mediaKind: 'image', prompt: '主画面' },
      { title: '细节', mediaKind: 'image', prompt: '细节画面', count: 2 },
    ],
  })!
  const message = formatBotanicAgentCompositionMessage(composition)
  assert.match(message, /1\. 主视觉（图片 1 张）/)
  assert.match(message, /2\. 细节（图片 2 张）/)
  assert.match(message, /回复「生成第 N 项」/)

  assert.equal(resolveBotanicAgentCompositionItem(composition, '生成第 2 项')?.title, '细节')
  assert.equal(resolveBotanicAgentCompositionItem(composition, '先做第一张')?.title, '主视觉')
  assert.equal(resolveBotanicAgentCompositionItem(composition, '生成第 9 项'), null)
  assert.equal(resolveBotanicAgentCompositionItem(composition, '再优化一下主视觉'), null)
})
