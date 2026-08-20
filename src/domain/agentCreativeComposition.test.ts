import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildBotanicAgentCompositionPlan,
  formatBotanicAgentCompositionMessage,
  instructionRequestsCompositionRun,
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

test('一键整套执行语识别：「执行方案」「整套生成」是，「生成第 2 项」不是', () => {
  assert.equal(instructionRequestsCompositionRun('执行方案'), true)
  assert.equal(instructionRequestsCompositionRun('整套生成吧'), true)
  assert.equal(instructionRequestsCompositionRun('全部生成'), true)
  assert.equal(instructionRequestsCompositionRun('生成第 2 项'), false)
  assert.equal(instructionRequestsCompositionRun('帮我生成一张海报'), false)
})

test('成套方案转计划：分支兜底 Prompt、条目总数进 output、无图片上下文时拒绝', () => {
  const composition = normalizeBotanicAgentComposition({
    theme: '春季系列',
    items: [
      { title: '主视觉', mediaKind: 'image', prompt: '主画面' },
      { title: '氛围视频', mediaKind: 'video', prompt: '镜头缓推', duration: 10 },
    ],
  }, { videoDurations: [5, 10] })!
  const plan = buildBotanicAgentCompositionPlan({
    instruction: '执行方案',
    composition,
    contextSnapshot: [
      { nodeId: 'asset-1', label: '商品图', kind: '素材', mediaKind: 'image', role: '商品' },
    ],
    settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
  })
  assert.equal(plan.intent, 'initial_generation')
  assert.match(plan.summary, /成套生成「春季系列」，共 2 项（含 1 条视频）/)
  assert.equal(plan.output.count, 2)
  assert.equal(plan.prompt, '主画面')
  assert.equal(plan.composition?.items.length, 2)

  assert.throws(() => buildBotanicAgentCompositionPlan({
    instruction: '执行方案',
    composition,
    contextSnapshot: [],
    settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
  }), /至少一项图片素材/)
})
