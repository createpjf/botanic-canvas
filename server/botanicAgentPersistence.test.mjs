import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentEntityLimits,
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

test('CanvasDocument 兼容提取不接受客户端 entityReferences，直接 Message 权威写仍保留', () => {
  const stableProjection = {
    id: 'agent-turn-result-turn-canvas-refs', role: 'assistant', kind: 'text', content: '完成',
    turnId: 'turn-canvas-refs', createdAt: 11, updatedAt: 12,
    entityReferences: [{ type: 'artifact', id: 'artifact-authoritative' }],
  }

  const state = agentStateFromDocument({
    agentSessions: [session('session-canvas-refs', 20, [stableProjection])],
    agentMemory: [],
    agentRuns: [],
  })

  assert.equal('entityReferences' in state.messages[0].message, false)
  assert.deepEqual(
    validateAgentMessageEntity(stableProjection, { now: 20 }).entityReferences,
    [{ type: 'artifact', id: 'artifact-authoritative' }],
  )
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

test('读合并对每会话消息套用 MESSAGE_LIMIT，保留最新的一段', () => {
  const total = agentEntityLimits.messagesPerSession + 40
  const merged = mergeAgentStateIntoDocument({ agentSessions: [session('session-big', 20)], agentMemory: [], agentRuns: [] }, {
    messages: Array.from({ length: total }, (_, index) => ({
      sessionId: 'session-big',
      updatedAt: index + 1,
      message: message(`message-${index}`, `第 ${index} 条`, index + 1),
    })),
  })
  const messages = merged.agentSessions[0].messages
  assert.equal(messages.length, agentEntityLimits.messagesPerSession)
  assert.equal(messages[0].id, 'message-40')
  assert.equal(messages.at(-1).id, `message-${total - 1}`)
})

test('mergeAgentStateIntoDocument 可在读路径跳过消息嵌套', () => {
  const merged = mergeAgentStateIntoDocument({ agentSessions: [], agentMemory: [], agentRuns: [] }, {
    sessions: [session('session-a', 20)],
    messages: [{ sessionId: 'session-a', updatedAt: 11, message: message('message-a', '第一条', 11) }],
  }, { includeMessages: false })
  assert.equal(merged.agentSessions[0].messages.length, 0)
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

test('Subagent 会话有独立类型与父会话绑定，普通会话不能伪造关联', () => {
  const session = validateAgentSessionEntity({
    id: 'agent-subagent-session-subagent-1',
    title: '品牌调研',
    executionMode: 'manual',
    contextNodeIds: [],
    kind: 'subagent',
    subagentId: 'subagent-1',
    parentSessionId: 'primary-session-1',
    createdAt: 10,
    updatedAt: 10,
  }, { now: 10 })
  assert.equal(session.kind, 'subagent')
  assert.equal(session.subagentId, 'subagent-1')
  assert.equal(session.parentSessionId, 'primary-session-1')
  assert.throws(() => validateAgentSessionEntity({
    id: 'primary-session', title: '主会话', subagentId: 'forged-subagent',
  }), /普通 Agent 会话/u)
  assert.throws(() => validateAgentSessionEntity({
    id: 'subagent-session', title: '子会话', kind: 'subagent',
  }), /Subagent 标识/u)
})

test('pending Message 持久化完整 Turn request snapshot，目标身份不能缺失', () => {
  const base = {
    id: 'message-turn-snapshot', role: 'user', kind: 'text', content: '换背景', createdAt: 10,
    status: 'pending',
    turnRequestSnapshot: {
      locale: 'zh-CN', plannerModel: 'planner-a', mountedSkillIds: ['skill-a'],
      contextNodeIds: ['result-b'], hasTarget: true,
      selectedResultNodeId: 'result-b', selectedResultLabel: '结果 B', executionMode: 'auto',
      generationModels: [{ id: 'image-a', label: '图像 A', mediaKind: 'image', aspectRatios: ['3:4'], resolutions: ['2K'] }],
      maxOutputCount: 6,
    },
  }
  const persisted = validateAgentMessageEntity(base, { now: 20 })
  assert.deepEqual(persisted.turnRequestSnapshot, base.turnRequestSnapshot)
  assert.throws(() => validateAgentMessageEntity({
    ...base,
    turnRequestSnapshot: { ...base.turnRequestSnapshot, selectedResultNodeId: undefined },
  }, { now: 20 }))
  assert.throws(() => validateAgentMessageEntity({
    ...base,
    role: 'assistant',
  }, { now: 20 }), /用户消息/)
})

test('线程摘要只持久化 Artifact 目录和消息版本，不带结果内容或地址', () => {
  const result = validateAgentSessionEntity({
    id: 'session-summary', title: '摘要会话', executionMode: 'manual', contextNodeIds: [], createdAt: 1, updatedAt: 20,
    threadSummary: {
      version: 1,
      goals: ['制作香水首图'], decisions: [], constraints: [], openQuestions: [], entityIds: [],
      artifacts: [{
        id: 'generation:job-1:out-1', kind: 'image', label: '香水首图 A',
        url: '/api/media/private-result', content: '不该持久化的结果内容', metadata: { prompt: '不该持久化的 Prompt' },
      }],
      coveredMessageIds: ['message-1'],
      coveredMessageRevisions: [{ messageId: 'message-1', revision: '9:submitted' }],
      coveredThrough: 9,
      updatedAt: 20,
    },
  }, { now: 20 })

  assert.deepEqual(result.threadSummary.artifacts, [
    { id: 'generation:job-1:out-1', kind: 'image', label: '香水首图 A' },
  ])
  assert.deepEqual(result.threadSummary.coveredMessageRevisions, [
    { messageId: 'message-1', revision: '9:submitted' },
  ])
  const serialized = JSON.stringify(result.threadSummary)
  assert.equal(serialized.includes('/api/media/'), false)
  assert.equal(serialized.includes('不该持久化'), false)
})

test('线程摘要持久化逐 Message factCandidates、digest revision 与 typed refs，并校验 provenance 对齐', () => {
  const revision = `9:answered:${'a'.repeat(43)}`
  const summary = {
    version: 1,
    goals: [], decisions: [], constraints: [], openQuestions: [], entityIds: [],
    entityReferences: [{ type: 'agent_run', id: 'run-1' }],
    factCandidates: [{
      messageId: 'message-refs', revision, occurredAt: 9,
      artifacts: [{
        id: 'artifact-1', kind: 'image', label: '结果 A',
        url: 'https://private.test/a', content: '不该持久化',
      }],
      entityReferences: [{ type: 'agent_run', id: 'run-1' }],
    }],
    coveredMessageIds: ['message-refs'],
    coveredMessageRevisions: [{ messageId: 'message-refs', revision }],
    coveredThrough: 9,
    updatedAt: 20,
  }
  const result = validateAgentSessionEntity({
    id: 'session-provenance', title: '摘要会话', executionMode: 'manual', contextNodeIds: [],
    createdAt: 1, updatedAt: 20, threadSummary: summary,
  }, { now: 20 })

  assert.deepEqual(result.threadSummary.entityReferences, [{ type: 'agent_run', id: 'run-1' }])
  assert.deepEqual(result.threadSummary.factCandidates, [{
    messageId: 'message-refs', revision, occurredAt: 9,
    artifacts: [{ id: 'artifact-1', kind: 'image', label: '结果 A' }],
    entityReferences: [{ type: 'agent_run', id: 'run-1' }],
  }])
  assert.doesNotMatch(JSON.stringify(result.threadSummary), /private|不该持久化/u)

  assert.throws(() => validateAgentSessionEntity({
    id: 'session-provenance-invalid', title: '摘要会话', executionMode: 'manual', contextNodeIds: [],
    createdAt: 1, updatedAt: 20,
    threadSummary: {
      ...summary,
      factCandidates: [{ ...summary.factCandidates[0], revision: `9:answered:${'b'.repeat(43)}` }],
    },
  }, { now: 20 }), /provenance|来源|候选/u)
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

test('Message 安全保存来源 Turn 身份，供刷新后重挂接且拒绝空身份', () => {
  const result = validateAgentMessageEntity({
    id: 'message-turn-link', role: 'user', kind: 'text', content: '继续生成', createdAt: 1,
    turnId: 'turn-stable-1',
    turnCancellationRequestedAt: 2,
  }, { now: 2 })

  assert.equal(result.turnId, 'turn-stable-1')
  assert.equal(result.turnCancellationRequestedAt, 2)
  assert.throws(() => validateAgentMessageEntity({
    id: 'message-turn-link-invalid', role: 'user', kind: 'text', content: '继续生成', createdAt: 1,
    turnId: '   ',
  }, { now: 2 }))
  for (const turnCancellationRequestedAt of [1.5, '2', -1, 300_003]) {
    assert.throws(() => validateAgentMessageEntity({
      id: 'message-turn-cancel-invalid', role: 'user', kind: 'text', content: '停止', createdAt: 1,
      turnCancellationRequestedAt,
    }, { now: 2 }))
  }
})

test('稳定 Turn 助手投影只持久化有界 typed entityReferences，其他消息不得携带', () => {
  const stable = validateAgentMessageEntity({
    id: 'agent-turn-result-turn-refs', role: 'assistant', kind: 'text', content: '完成',
    turnId: 'turn-refs', createdAt: 1,
    entityReferences: [
      { type: 'agent_run', id: 'run-1' },
      { type: 'artifact', id: 'artifact-1' },
    ],
  }, { now: 2 })

  assert.deepEqual(stable.entityReferences, [
    { type: 'agent_run', id: 'run-1' },
    { type: 'artifact', id: 'artifact-1' },
  ])
  for (const invalid of [
    { ...stable, id: 'ordinary-assistant' },
    { ...stable, role: 'user' },
    { ...stable, entityReferences: [{ type: 'artifact', id: 'https://evil.test/a' }] },
    { ...stable, entityReferences: [{ type: 'artifact', id: 'artifact-1', url: 'https://evil.test/a' }] },
  ]) {
    assert.throws(
      () => validateAgentMessageEntity(invalid, { now: 2 }),
      (caught) => ['INVALID_AGENT_ENTITY', 'AGENT_ENTITY_REFERENCES_INVALID'].includes(caught?.code),
    )
  }
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

test('模型建议不能直接成为生效记忆，人工保存才可以', () => {
  // 一次对话里的猜测若立刻变成品牌事实，之后每一轮生成都会按它执行。
  const suggested = validateAgentMemoryEntity({
    id: 'memory-suggested', kind: 'rule', content: '模型猜的规则', source: 'conversation',
  })
  assert.equal(suggested.status, 'proposed')

  const saved = validateAgentMemoryEntity({
    id: 'memory-saved', kind: 'rule', content: '用户保存的规则', source: 'human',
  })
  assert.equal(saved.status, 'active')

  // 声明 active 也不行：没有人工来源也没有已确认证据。
  assert.throws(
    () => validateAgentMemoryEntity({
      id: 'memory-forced', kind: 'rule', content: '硬说自己生效', source: 'review', status: 'active',
    }),
    /人工来源或已确认证据/u,
  )
})

test('已确认的证据可以支撑非人工来源的记忆生效', () => {
  const backed = validateAgentMemoryEntity({
    id: 'memory-evidence', kind: 'approved', content: '评审确认过的方向', source: 'review', status: 'active',
    evidence: [{ kind: 'review', ref: 'review-1', confirmedAt: 100 }],
  })
  assert.equal(backed.status, 'active')
  assert.deepEqual(backed.evidence, [{ kind: 'review', ref: 'review-1', confirmedAt: 100 }])

  // 未确认的证据不算：它只是「有人提过」，不是「有人认过」。
  assert.throws(
    () => validateAgentMemoryEntity({
      id: 'memory-unconfirmed', kind: 'approved', content: '只是提过', source: 'review', status: 'active',
      evidence: [{ kind: 'review', ref: 'review-2' }],
    }),
    /人工来源或已确认证据/u,
  )
})

test('激活态与可信度各自独立表达', () => {
  // 「未确认但很可信」：状态是建议态，可信度是 confirmed。
  const item = validateAgentMemoryEntity({
    id: 'memory-mixed', kind: 'rule', content: '很可能对但还没人确认', source: 'review',
    confidence: 'confirmed', status: 'proposed',
  })
  assert.equal(item.status, 'proposed')
  assert.equal(item.confidence, 'confirmed')
})

test('替代关系与冲突关系必须自洽', () => {
  assert.throws(
    () => validateAgentMemoryEntity({ id: 'memory-x', kind: 'rule', content: '旧规则', source: 'human', status: 'superseded' }),
    /必须指明替代者/u,
  )
  const superseded = validateAgentMemoryEntity({
    id: 'memory-x', kind: 'rule', content: '旧规则', source: 'human', status: 'superseded', supersededBy: 'memory-y',
  })
  assert.equal(superseded.supersededBy, 'memory-y')
  assert.throws(
    () => validateAgentMemoryEntity({ id: 'memory-x', kind: 'rule', content: '规则', source: 'human', conflictsWith: ['memory-x'] }),
    /不能与自身冲突/u,
  )
  assert.deepEqual(
    validateAgentMemoryEntity({ id: 'memory-x', kind: 'rule', content: '规则', source: 'human', conflictsWith: ['memory-y', 'memory-y'] }).conflictsWith,
    ['memory-y'],
  )
})
