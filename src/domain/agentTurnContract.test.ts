import assert from 'node:assert/strict'
import test from 'node:test'
import { botanicAgentTurnMessageLimit, buildBotanicAgentTurnRequest } from './agentTurnContract.ts'

test('回合请求只发送最近 16 条消息与去重后的上下文节点', () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
    content: `第 ${index} 条`,
  }))
  const request = buildBotanicAgentTurnRequest({
    projectId: 'project-1',
    locale: 'en',
    plannerModel: 'deepseek-v4-pro',
    messages,
    contextNodeIds: ['a', 'a', 'b'],
    hasTarget: true,
    maxOutputCount: 6,
  })
  assert.equal(request.messages.length, 16)
  assert.equal(request.locale, 'en')
  assert.equal(request.messages[0].content, '第 4 条')
  assert.deepEqual(request.contextNodeIds, ['a', 'b'])
  assert.equal(request.hasTarget, true)
  assert.equal(request.maxOutputCount, 6)
})

test('选中结果与执行模式随回合下发；没有选中就不带结果标签', () => {
  const selected = buildBotanicAgentTurnRequest({
    projectId: 'project-1',
    locale: 'zh-CN',
    messages: [{ role: 'user', content: '换个背景' }],
    contextNodeIds: [],
    hasTarget: true,
    selectedResultLabel: '  首图 01  ',
    executionMode: 'auto',
  })
  assert.equal(selected.selectedResultLabel, '首图 01')
  assert.equal(selected.executionMode, 'auto')

  // 没有选中却带标签会让模型以为在改图，必须丢弃。
  const unselected = buildBotanicAgentTurnRequest({
    projectId: 'project-1',
    locale: 'zh-CN',
    messages: [{ role: 'user', content: '生成一张' }],
    contextNodeIds: [],
    hasTarget: false,
    selectedResultLabel: '首图 01',
    executionMode: 'manual',
  })
  assert.equal(unselected.selectedResultLabel, undefined)
  assert.equal(unselected.executionMode, 'manual')
})

test('超长历史消息被截断到服务端上限，不让整轮请求被判非法', () => {
  const request = buildBotanicAgentTurnRequest({
    projectId: 'project-1',
    locale: 'zh-CN',
    // 助手回答最长可到 12000 字，原样回传会超过服务端单条上限。
    messages: [
      { role: 'assistant', content: '长'.repeat(12_000) },
      { role: 'user', content: '按这个出 3 张' },
    ],
    contextNodeIds: [],
  })
  assert.equal(request.messages[0].content.length, botanicAgentTurnMessageLimit)
  assert.equal(request.messages[1].content, '按这个出 3 张')
})

test('生成模型目录只携带安全字段，缺省字段不产出噪声键', () => {
  const request = buildBotanicAgentTurnRequest({
    projectId: 'project-1',
    locale: 'zh-CN',
    messages: [{ role: 'user', content: '生成' }],
    contextNodeIds: [],
    generationModels: [
      { id: 'gpt-image-2', label: 'GPT Image 2', mediaKind: 'image', aspectRatios: ['1:1'], resolutions: ['2K'] },
      { id: 'video-1', label: '视频', mediaKind: 'video' },
    ],
  })
  assert.equal(request.hasTarget, false)
  assert.equal(request.plannerModel, undefined)
  assert.equal(request.maxOutputCount, undefined)
  assert.equal(request.executionMode, undefined)
  assert.deepEqual(request.generationModels, [
    { id: 'gpt-image-2', label: 'GPT Image 2', mediaKind: 'image', aspectRatios: ['1:1'], resolutions: ['2K'] },
    { id: 'video-1', label: '视频', mediaKind: 'video' },
  ])
})
