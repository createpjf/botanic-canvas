import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentStateFromDocument,
  mergeAgentStateIntoDocument,
  shouldApplyAgentEntityWrite,
  shouldApplyAgentRunWrite,
  validateAgentMemoryEntity,
  validateAgentMessageEntity,
  validateAgentSessionEntity,
} from './botanicAgentPersistence.mjs'

const session = (id, updatedAt, messages = []) => ({
  id, title: id, executionMode: 'manual', contextNodeIds: [], messages,
  createdAt: 10, updatedAt,
})

const message = (id, content, createdAt) => ({
  id, role: 'user', kind: 'text', content, createdAt,
})

test('Agent 文档状态被拆成独立 Session、Message、Memory 与 Run 实体', () => {
  const state = agentStateFromDocument({
    agentSessions: [session('session-a', 20, [message('message-a', '第一条', 11)])],
    agentMemory: [{ id: 'memory-a', kind: 'rule', content: '  保持   品牌色  ', sourceNodeIds: ['node-a'], createdAt: 12, updatedAt: 12 }],
    agentRuns: [{ id: 'run-a', status: 'queued', updatedAt: 13 }],
  })

  assert.deepEqual(state.sessions[0], {
    id: 'session-a', title: 'session-a', executionMode: 'manual', contextNodeIds: [], createdAt: 10, updatedAt: 20,
  })
  assert.equal(state.messages[0].sessionId, 'session-a')
  assert.equal(state.messages[0].message.content, '第一条')
  assert.equal(state.memory[0].content, '保持 品牌色')
  assert.equal(state.runs[0].id, 'run-a')
})

test('Agent 会话阅读锚点会进入独立实体并在跨设备读取时保留', () => {
  const state = agentStateFromDocument({
    agentSessions: [{
      ...session('session-reading', 40, [message('message-reading', '停在这里', 30)]),
      readingAnchorMessageId: 'message-reading',
      readingAnchorUpdatedAt: 40,
    }],
    agentMemory: [],
    agentRuns: [],
  })

  assert.equal(state.sessions[0].readingAnchorMessageId, 'message-reading')
  assert.equal(state.sessions[0].readingAnchorUpdatedAt, 40)
  const merged = mergeAgentStateIntoDocument({ agentSessions: [], agentMemory: [], agentRuns: [] }, state)
  assert.equal(merged.agentSessions[0].readingAnchorMessageId, 'message-reading')
})

test('独立实体按 ID 合并，不因旧文档缺少并发新增消息而丢失', () => {
  const merged = mergeAgentStateIntoDocument({
    agentSessions: [session('session-a', 20, [message('message-a', '设备 A', 11)])],
    agentMemory: [],
    agentRuns: [],
    activeAgentSessionId: 'session-a',
  }, {
    sessions: [session('session-a', 30)],
    messages: [
      { sessionId: 'session-a', updatedAt: 20, message: message('message-a', '设备 A', 11) },
      { sessionId: 'session-a', updatedAt: 30, message: message('message-b', '设备 B', 12) },
    ],
  })

  assert.deepEqual(merged.agentSessions[0].messages.map((item) => item.id), ['message-a', 'message-b'])
  assert.equal(merged.agentSessions[0].updatedAt, 30)
})

test('仅存在于独立实体表的 Agent Run 会进入兼容文档', () => {
  const merged = mergeAgentStateIntoDocument({
    agentSessions: [], agentMemory: [], agentRuns: [],
  }, {
    runs: [{ id: 'run-entity-only', status: 'running', updatedAt: 30 }],
  })

  assert.deepEqual(merged.agentRuns, [{ id: 'run-entity-only', status: 'running', updatedAt: 30 }])
})

test('独立 Agent Run 是权威状态，不被更新的兼容文档回退', () => {
  const merged = mergeAgentStateIntoDocument({
    agentSessions: [], agentMemory: [],
    agentRuns: [{
      id: 'run-authoritative', status: 'awaiting_confirmation', updatedAt: 500,
      plan: { rootRecipe: { prompt: '完整本地配方' } },
    }],
  }, {
    runs: [{ id: 'run-authoritative', status: 'running', updatedAt: 100 }],
  })

  assert.equal(merged.agentRuns[0].status, 'running')
  assert.equal(merged.agentRuns[0].updatedAt, 100)
  assert.equal(merged.agentRuns[0].plan.rootRecipe.prompt, '完整本地配方')
})

test('历史 Agent Run 非法状态在写入独立实体前回退到等待确认', () => {
  const state = agentStateFromDocument({
    agentSessions: [], agentMemory: [],
    agentRuns: [{ id: 'run-invalid', status: 'future_status', updatedAt: 13 }],
  })

  assert.equal(state.runs[0].status, 'awaiting_confirmation')
})

test('独立消息按自身 updatedAt 合并，旧会话时间戳不会覆盖另一设备的新内容', () => {
  const merged = mergeAgentStateIntoDocument({
    agentSessions: [session('session-a', 400, [{
      ...message('message-a', '设备 A 旧内容', 100),
      updatedAt: 100,
    }])],
    agentMemory: [],
    agentRuns: [],
    activeAgentSessionId: 'session-a',
  }, {
    sessions: [session('session-a', 300)],
    messages: [{
      sessionId: 'session-a',
      updatedAt: 300,
      message: { ...message('message-a', '设备 B 新内容', 100), updatedAt: 300 },
    }],
  })

  assert.equal(merged.agentSessions[0].messages[0].content, '设备 B 新内容')
  assert.equal(merged.agentSessions[0].messages[0].updatedAt, 300)
})

test('独立 Memory 墓碑会覆盖旧 CanvasDocument 中的已删除记忆', () => {
  const merged = mergeAgentStateIntoDocument({
    agentSessions: [], agentRuns: [],
    agentMemory: [{ id: 'memory-a', kind: 'avoid', content: '不要暖色', sourceNodeIds: [], createdAt: 10, updatedAt: 10 }],
  }, { deletedMemoryIds: ['memory-a'] })

  assert.deepEqual(merged.agentMemory, [])
})

test('Agent 实体验证拒绝越界类型与超长消息', () => {
  assert.throws(() => validateAgentSessionEntity({ id: 's', title: 'S', executionMode: 'unsafe' }))
  assert.throws(() => validateAgentMemoryEntity({ id: 'm', kind: 'secret', content: 'x' }))
  assert.throws(() => validateAgentMessageEntity({ id: 'm', role: 'system', kind: 'text', content: 'x' }))
  assert.throws(() => validateAgentMessageEntity({ id: 'm', role: 'user', kind: 'text', content: 'x'.repeat(64_001), createdAt: 1 }))
})

test('用户消息的 Skill / 素材引用随独立消息保留，且剥离图片地址', () => {
  const result = validateAgentMessageEntity({
    id: 'message-mentions', role: 'user', kind: 'text', content: '帮我出套图', createdAt: 1,
    mentions: [
      { kind: 'skill', id: 'ecommerce_listing', name: '电商套图' },
      { kind: 'reference', id: 'node-mia', label: 'Mia 肖像', image: 'https://private.example.com/mia.webp' },
      { kind: 'skill', id: 'ecommerce_listing', name: '重复挂载' },
    ],
  }, { now: 2 })

  assert.deepEqual(result.mentions, [
    { kind: 'skill', id: 'ecommerce_listing', name: '电商套图' },
    { kind: 'reference', id: 'node-mia', label: 'Mia 肖像' },
  ])
  assert.equal(result.mentions[1].image, undefined)
  assert.throws(() => validateAgentMessageEntity({
    id: 'message-mentions', role: 'user', kind: 'text', content: 'x', createdAt: 1,
    mentions: [{ kind: 'prompt', id: 'p', name: 'x' }],
  }, { now: 2 }))
})

test('Prompt 消息的结构化结果会随独立消息保留', () => {
  const result = validateAgentMessageEntity({
    id: 'message-prompt', role: 'assistant', kind: 'text', content: '可直接使用的 Prompt',
    prompt: '保持人物和服装，替换为海边场景。', createdAt: 1,
  }, { now: 2 })

  assert.equal(result.prompt, '保持人物和服装，替换为海边场景。')
  assert.throws(() => validateAgentMessageEntity({
    id: 'message-prompt', role: 'assistant', kind: 'text', content: 'x', prompt: 'x'.repeat(12_001), createdAt: 1,
  }, { now: 2 }))
})

test('多轮追问中的 Creative Brief 会随问题消息持久化', () => {
  const brief = {
    version: 1,
    mode: 'generation',
    originalInstruction: '生成一张海边人像',
    output: { model: 'gpt-image-2', deliveryPreset: 'custom', resolution: '2K' },
    creative: { promptDirection: 'faithful' },
    provenance: { model: 'default', delivery_preset: 'user', resolution: 'user', prompt_direction: 'user' },
  }
  const result = validateAgentMessageEntity({
    id: 'message-brief', role: 'assistant', kind: 'question', content: '请选择图片比例。', createdAt: 1,
    status: 'pending',
    question: {
      id: 'clarification-brief', question: '请选择图片比例。', originalInstruction: brief.originalInstruction,
      brief,
      fields: [{ id: 'aspect_ratio', label: '图片比例', required: true, control: 'single_choice', options: [{ value: '3:4', label: '3:4' }] }],
    },
  }, { now: 2 })

  assert.deepEqual(result.question.brief, brief)
  assert.notEqual(result.question.brief, brief)
})

test('Postgres/Supabase 使用同一时间戳冲突规则，Memory 墓碑永久胜出', () => {
  assert.equal(shouldApplyAgentEntityWrite(undefined, { updatedAt: 20 }), true)
  assert.equal(shouldApplyAgentEntityWrite({ updatedAt: 20 }, { updatedAt: 19 }), false)
  assert.equal(shouldApplyAgentEntityWrite({ updatedAt: '20' }, { updatedAt: 19 }), false)
  assert.equal(shouldApplyAgentEntityWrite({ updatedAt: 20 }, { updatedAt: 20 }), true)
  assert.equal(shouldApplyAgentEntityWrite(
    { updatedAt: '2026-08-04T08:00:00.000Z', deletedAt: '2026-08-04T08:00:00.000Z' },
    { updatedAt: '2026-08-04T08:00:00.000Z' },
    { tombstoneWinsTie: true },
  ), false)
  assert.equal(shouldApplyAgentEntityWrite(
    { updatedAt: 20, deletedAt: 20 },
    { updatedAt: 21 },
    { tombstoneWinsTie: true },
  ), false)
})

test('Agent Run 拒绝旧或更新的本地待确认状态覆盖已执行实体', () => {
  assert.equal(shouldApplyAgentRunWrite(undefined, { status: 'awaiting_confirmation', updatedAt: 500 }), true)
  assert.equal(shouldApplyAgentRunWrite(
    { status: 'queued', updatedAt: 200 },
    { status: 'awaiting_confirmation', updatedAt: 100 },
  ), false)
  assert.equal(shouldApplyAgentRunWrite(
    { status: 'running', updatedAt: 200 },
    { status: 'awaiting_confirmation', updatedAt: 500 },
  ), false)
  assert.equal(shouldApplyAgentRunWrite(
    { status: 'queued', updatedAt: 200 },
    { status: 'running', updatedAt: 300 },
  ), true)
})

test('计划落库时剥离提供方原始推理，其余字段原样保留', () => {
  const message = validateAgentMessageEntity({
    id: 'message-plan', role: 'assistant', kind: 'plan', content: '海边换景', createdAt: 100,
    plan: {
      intent: 'replace_scene',
      instruction: '把背景换成海边',
      summary: '替换场景',
      prompt: '海边黄昏',
      settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
      constraints: [{ dimension: 'scene', mode: 'vary' }],
      output: { mode: 'single', count: 1, candidatesPerItem: 1 },
      // 模型自述的调用目的可以持久化；提供方完整思维链不可以。
      toolCalls: [{ id: 'call-1', name: 'canvas_read', label: '读取画布', risk: 'read', status: 'succeeded', requiresConfirmation: false, summary: '先确认画布内容' }],
      reasoning: [{ step: 0, source: 'raw', text: '完整思维链不应落库' }],
    },
  })

  assert.equal(message.plan.reasoning, undefined)
  assert.equal(message.plan.prompt, '海边黄昏')
  assert.equal(message.plan.toolCalls[0].summary, '先确认画布内容')
  assert.deepEqual(message.plan.constraints, [{ dimension: 'scene', mode: 'vary' }])
})

test('成套方案作为 composition 消息落库，刷新后仍带结构化条目', () => {
  const message = validateAgentMessageEntity({
    id: 'message-composition', role: 'assistant', kind: 'composition',
    content: '已把这次需求分解为一套 2 项的创意方案：春季系列',
    createdAt: 100,
    composition: {
      theme: '春季系列',
      items: [
        { title: '主视觉', purpose: '封面', mediaKind: 'image', prompt: '春日主画面', count: 2 },
        { title: '氛围视频', mediaKind: 'video', prompt: '镜头缓推', count: 3, duration: 10, url: 'https://private/media.mp4' },
      ],
    },
  })

  assert.equal(message.kind, 'composition')
  assert.equal(message.composition.theme, '春季系列')
  assert.equal(message.composition.items.length, 2)
  assert.equal(message.composition.items[0].count, 2)
  assert.equal(message.composition.items[1].count, 1)
  assert.equal(message.composition.items[1].duration, 10)
  assert.equal(message.composition.items[1].url, undefined)
})

test('方案消息拒绝无效条目或缺少结构化方案', () => {
  assert.throws(() => validateAgentMessageEntity({
    id: 'message-composition', role: 'assistant', kind: 'composition',
    content: '只有一项', createdAt: 1,
    composition: { theme: '单项', items: [{ title: 'a', mediaKind: 'image', prompt: 'x' }] },
  }))
  assert.throws(() => validateAgentMessageEntity({
    id: 'message-composition', role: 'assistant', kind: 'composition',
    content: '没有方案', createdAt: 1,
  }))
  assert.throws(() => validateAgentMessageEntity({
    id: 'message-unknown', role: 'assistant', kind: 'recipe', content: 'x', createdAt: 1,
  }))
})

test('评审消息只保存结构化结论并支持人工决策状态', () => {
  const message = validateAgentMessageEntity({
    id: 'message-review', role: 'assistant', kind: 'text', content: '已完成评审。', createdAt: 1,
    review: {
      id: 'review-1', version: 2, runId: 'run-1', projectId: 'project-a', locale: 'zh-CN', status: 'pending',
      summary: '主体稳定。', bestNodeId: 'node-a', items: [{ nodeId: 'node-a', branchLabel: '首图', verdict: 'pass', note: '清晰' }],
      requiredCriteria: ['identity'],
    },
  })
  assert.equal(message.review.status, 'pending')
  assert.equal(message.review.items[0].verdict, 'pass')
  assert.throws(() => validateAgentMessageEntity({
    id: 'message-review-invalid', role: 'assistant', kind: 'text', content: 'x', createdAt: 1,
    review: { summary: 'x', items: [{ nodeId: 'node-a', branchLabel: 'a', verdict: 'bad' }] },
  }))
})
