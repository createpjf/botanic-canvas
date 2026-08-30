import assert from 'node:assert/strict'
import test from 'node:test'
import {
  botanicAgentCompositionItemSpecLabel,
  botanicAgentCompositionTotalCandidateCount,
  botanicAgentMessageComposition,
  buildBotanicAgentCompositionPlan,
  formatBotanicAgentCompositionMessage,
  formatBotanicAgentCompositionSummary,
  instructionRequestsCompositionRun,
  latestBotanicAgentComposition,
  normalizeBotanicAgentComposition,
  resolveBotanicAgentCompositionImageModel,
  resolveBotanicAgentCompositionItem,
} from './agentCreativeComposition.ts'
import type { BotanicAgentMessage } from './agent.ts'

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
  assert.equal(botanicAgentCompositionItemSpecLabel(composition.items[0]), '图片 1 张')
  assert.equal(botanicAgentCompositionItemSpecLabel(composition.items[1]), '图片 2 张')
  assert.match(message, /1\. 主视觉（图片 1 张）/)
  assert.match(message, /2\. 细节（图片 2 张）/)
  assert.match(message, /生成第 N 项/)
  assert.equal(formatBotanicAgentCompositionSummary(composition), '已把这次需求分解为一套 2 项的创意方案：春季系列')

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

test('成套方案转计划：条目数与候选总数分开，确认数量使用候选总数', () => {
  const composition = normalizeBotanicAgentComposition({
    theme: '春季系列',
    items: [
      { title: '主视觉', mediaKind: 'image', prompt: '主画面', count: 4 },
      { title: '细节', mediaKind: 'image', prompt: '细节画面', count: 2 },
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
  assert.match(plan.summary, /成套生成「春季系列」，共 3 项、7 个候选（含 1 条视频）/)
  assert.equal(botanicAgentCompositionTotalCandidateCount(composition), 7)
  assert.deepEqual(plan.output, {
    mode: 'single',
    count: 7,
    candidatesPerItem: 1,
    itemCount: 3,
    totalCandidateCount: 7,
  })
  assert.equal(plan.prompt, '主画面')
  assert.equal(plan.composition?.items.length, 3)

  assert.throws(() => buildBotanicAgentCompositionPlan({
    instruction: '执行方案',
    composition,
    contextSnapshot: [],
    settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
  }), /至少一项图片素材/)
})

test('成套方案模型选择遵循当次 override、会话偏好、项目默认、系统默认', () => {
  const models = [
    { id: 'system-image', label: '系统图片', mediaKind: 'image' as const },
    { id: 'project-image', label: '项目图片', mediaKind: 'image' as const },
    { id: 'session-image', label: '会话图片', mediaKind: 'image' as const },
    { id: 'override-image', label: '当次图片', mediaKind: 'image' as const },
    { id: 'video', label: '视频', mediaKind: 'video' as const },
  ]
  assert.equal(resolveBotanicAgentCompositionImageModel(models, [
    'override-image', 'session-image', 'project-image',
  ])?.id, 'override-image')
  assert.equal(resolveBotanicAgentCompositionImageModel(models, [
    undefined, 'session-image', 'project-image',
  ])?.id, 'session-image')
  assert.equal(resolveBotanicAgentCompositionImageModel(models, [
    undefined, undefined, 'project-image',
  ])?.id, 'project-image')
  assert.equal(resolveBotanicAgentCompositionImageModel(models, ['video'])?.id, 'system-image')
})

function compositionMessage(
  partial: Partial<BotanicAgentMessage> & Pick<BotanicAgentMessage, 'id' | 'composition'>,
): BotanicAgentMessage {
  return {
    role: 'assistant',
    kind: 'composition',
    content: formatBotanicAgentCompositionSummary(partial.composition!),
    createdAt: 1,
    ...partial,
  }
}

test('方案是会话消息：刷新后从最近一条 composition 恢复，旧卡仍绑自己的条目', () => {
  const spring = normalizeBotanicAgentComposition({
    theme: '春季系列',
    items: [
      { title: '主视觉', mediaKind: 'image', prompt: '春日主画面' },
      { title: '细节', mediaKind: 'image', prompt: '花瓣特写' },
    ],
  })!
  const summer = normalizeBotanicAgentComposition({
    theme: '夏季系列',
    items: [
      { title: '主视觉', mediaKind: 'image', prompt: '夏日主画面' },
      { title: '视频', mediaKind: 'video', prompt: '镜头缓推', duration: 10 },
    ],
  }, { videoDurations: [5, 10] })!

  const messages: BotanicAgentMessage[] = [
    { id: 'user-1', role: 'user', kind: 'text', content: '做一套春季', createdAt: 10 },
    compositionMessage({ id: 'comp-spring', composition: spring, createdAt: 20 }),
    { id: 'user-2', role: 'user', kind: 'text', content: '改成夏季', createdAt: 30 },
    compositionMessage({ id: 'comp-summer', composition: summer, createdAt: 40 }),
    {
      id: 'legacy-text',
      role: 'assistant',
      kind: 'text',
      content: formatBotanicAgentCompositionMessage(spring),
      createdAt: 50,
    },
  ]

  // 纯文本旧消息没有结构化字段，刷新后不能当方案卡用。
  assert.equal(botanicAgentMessageComposition(messages[4]), null)
  assert.equal(latestBotanicAgentComposition(messages)?.theme, '夏季系列')
  assert.equal(resolveBotanicAgentCompositionItem(latestBotanicAgentComposition(messages)!, '生成第 2 项')?.title, '视频')

  // 旧方案卡点「生成第 2 项」必须落到该卡自己的条目，而不是最新方案。
  const springFromCard = botanicAgentMessageComposition(messages[1])
  assert.equal(springFromCard?.theme, '春季系列')
  assert.equal(resolveBotanicAgentCompositionItem(springFromCard!, '生成第 2 项')?.prompt, '花瓣特写')
})

test('会话里没有 composition 消息时，生成第 N 项 / 执行方案没有结构化落点', () => {
  const messages: BotanicAgentMessage[] = [
    { id: 'user-1', role: 'user', kind: 'text', content: '做一套春季', createdAt: 10 },
    {
      id: 'text-only',
      role: 'assistant',
      kind: 'text',
      content: formatBotanicAgentCompositionMessage(normalizeBotanicAgentComposition({
        theme: '春季系列',
        items: [{ title: '主视觉', prompt: '主画面' }, { title: '细节', prompt: '细节' }],
      })!),
      createdAt: 20,
    },
  ]
  assert.equal(latestBotanicAgentComposition(messages), null)
})
