import assert from 'node:assert/strict'
import test from 'node:test'
import {
  botanicAgentTurnMessageLimit,
  botanicAgentTurnRequestFromSnapshot,
  botanicAgentTurnRequestSnapshot,
  buildBotanicAgentTurnRequest,
} from './agentTurnContract.ts'

test('回合请求携带权威会话与本轮稳定消息身份', () => {
  const request = buildBotanicAgentTurnRequest({
    projectId: 'project-1',
    sessionId: 'session-1',
    locale: 'zh-CN',
    inputMessage: {
      id: 'agent-message-stable',
      content: '按品牌规范生成主图',
      mentions: [
        { kind: 'skill', id: 'skill-brand', name: '品牌规范' },
        { kind: 'reference', id: 'asset-product', label: '商品正面图' },
      ],
    },
    messages: [{ role: 'assistant', content: '旧历史仅用于兼容' }],
    contextNodeIds: [],
  })

  assert.equal(request.sessionId, 'session-1')
  assert.deepEqual(request.inputMessage, {
    id: 'agent-message-stable',
    content: '按品牌规范生成主图',
    mentions: [
      { kind: 'skill', id: 'skill-brand', name: '品牌规范' },
      { kind: 'reference', id: 'asset-product', label: '商品正面图' },
    ],
  })
})

test('权威消息请求不再要求浏览器重传整段历史', () => {
  const request = buildBotanicAgentTurnRequest({
    projectId: 'project-1',
    sessionId: 'session-1',
    locale: 'zh-CN',
    inputMessage: { id: 'agent-message-stable', content: '继续完成主图' },
    contextNodeIds: [],
  })

  assert.equal(request.messages, undefined)
})

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

test('Composer 挂载的 Skill 随回合下发，空列表不占键', () => {
  const mounted = buildBotanicAgentTurnRequest({
    projectId: 'project-1',
    locale: 'zh-CN',
    messages: [{ role: 'user', content: '出一套货架图' }],
    contextNodeIds: [],
    mountedSkillIds: ['ecommerce_listing', 'ecommerce_listing', 'platform_pack'],
  })
  assert.deepEqual(mounted.mountedSkillIds, ['ecommerce_listing', 'platform_pack'])

  const empty = buildBotanicAgentTurnRequest({
    projectId: 'project-1',
    locale: 'zh-CN',
    messages: [{ role: 'user', content: '生成一张' }],
    contextNodeIds: [],
    mountedSkillIds: [],
  })
  assert.equal(empty.mountedSkillIds, undefined)
})

test('选中结果与执行模式随回合下发；没有选中就不带结果标签', () => {
  const selected = buildBotanicAgentTurnRequest({
    projectId: 'project-1',
    locale: 'zh-CN',
    messages: [{ role: 'user', content: '换个背景' }],
    contextNodeIds: [],
    hasTarget: true,
    selectedResultNodeId: 'result-selected',
    selectedResultLabel: '  首图 01  ',
    executionMode: 'auto',
  })
  assert.equal(selected.selectedResultNodeId, 'result-selected')
  assert.equal(selected.selectedResultLabel, '首图 01')
  assert.equal(selected.executionMode, 'auto')

  // 没有选中却带标签会让模型以为在改图，必须丢弃。
  const unselected = buildBotanicAgentTurnRequest({
    projectId: 'project-1',
    locale: 'zh-CN',
    messages: [{ role: 'user', content: '生成一张' }],
    contextNodeIds: [],
    hasTarget: false,
    selectedResultNodeId: 'result-must-not-leak',
    selectedResultLabel: '首图 01',
    executionMode: 'manual',
  })
  assert.equal(unselected.selectedResultNodeId, undefined)
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

  const authoritative = buildBotanicAgentTurnRequest({
    projectId: 'project-1',
    sessionId: 'session-1',
    locale: 'zh-CN',
    inputMessage: { id: 'message-long', content: '长'.repeat(12_000) },
    contextNodeIds: [],
  })
  assert.equal(authoritative.inputMessage?.content.length, botanicAgentTurnMessageLimit)
})

test('生成模型目录不由客户端上报，缺省字段不产出噪声键', () => {
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
  assert.equal(request.generationModels, undefined)
})

test('POST 未到服务端时，刷新恢复只用 Message 里的完整 request snapshot', () => {
  const original = {
    projectId: 'project-1', sessionId: 'session-1',
    inputMessage: { id: 'message-stable', content: '给这张换背景' },
    locale: 'zh-CN' as const,
    plannerModel: 'planner-original',
    showRawReasoning: true,
    mountedSkillIds: ['skill-original'],
    contextNodeIds: ['result-original', 'asset-reference'],
    hasTarget: true,
    selectedResultNodeId: 'result-original',
    selectedResultLabel: '原结果',
    executionMode: 'manual' as const,
    generationModels: [{ id: 'image-original', label: '原模型', mediaKind: 'image' as const }],
    maxOutputCount: 6,
  }
  const snapshot = botanicAgentTurnRequestSnapshot(original)
  const restored = botanicAgentTurnRequestFromSnapshot({
    projectId: 'project-1', sessionId: 'session-1',
    inputMessage: { id: 'message-stable', content: '给这张换背景' },
    snapshot,
  })

  assert.equal(restored.selectedResultNodeId, 'result-original')
  assert.equal(restored.plannerModel, 'planner-original')
  assert.equal(restored.showRawReasoning, true)
  assert.equal(restored.executionMode, 'manual')
  assert.deepEqual(restored.contextNodeIds, ['result-original', 'asset-reference'])
  assert.equal(restored.generationModels, undefined)
  assert.throws(
    () => botanicAgentTurnRequestSnapshot({ ...original, selectedResultNodeId: undefined }),
    (error: unknown) => (error as { code?: string }).code === 'AGENT_TURN_TARGET_IDENTITY_MISSING',
  )
})
