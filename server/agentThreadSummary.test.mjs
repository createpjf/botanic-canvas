import assert from 'node:assert/strict'
import test from 'node:test'
import {
  THREAD_CONTEXT_KINDS,
  THREAD_SUMMARY_THRESHOLD,
  buildThreadSummaryCheckpoint,
  hasThreadSummaryFactProvenance,
  messageSummaryRevision,
  redactSummaryText,
  renderThreadSummary,
  summaryRelevantDigest,
  shouldCompactThread,
} from './agentThreadSummary.mjs'

/** 固定回归集：一段包含目标、确认决策、约束、追问与实体的早期对话。 */
function thread() {
  return [
    { id: 'm1', role: 'user', kind: 'text', content: '双十一首图，主色必须是品牌绿。', createdAt: 1, updatedAt: 1 },
    { id: 'm2', role: 'assistant', kind: 'text', content: '好的，我先看一下素材。', createdAt: 2, updatedAt: 2 },
    {
      id: 'm3', role: 'assistant', kind: 'plan', status: 'submitted', runId: 'run-1',
      content: '锁定人物与服装，替换场景。', createdAt: 3, updatedAt: 3,
      plan: {
        intent: 'replace_scene', summary: '锁定人物与服装，替换场景。',
        prompt: '一大段不该进摘要的执行 Prompt……'.repeat(20),
        constraints: [{ dimension: 'person', mode: 'preserve' }, { dimension: 'scene', mode: 'vary' }],
        output: { count: 2 },
      },
    },
    {
      id: 'm4', role: 'assistant', kind: 'question', status: 'pending',
      content: '需要留标题空间吗？', createdAt: 4, updatedAt: 4,
      question: { id: 'q1', question: '需要留标题空间吗？' },
    },
    { id: 'm5', role: 'user', kind: 'text', content: '参考这张 /api/media/media_secret 的构图。', createdAt: 5, updatedAt: 5, mentions: [{ nodeId: 'result-7' }] },
  ]
}

test('四类上下文层是声明式的，不能混成一坨', () => {
  // 混在一起会让「这条约束是这次说的还是上个月存的」无从判断。
  assert.deepEqual([...THREAD_CONTEXT_KINDS], ['turn_context', 'thread_summary', 'project_memory', 'artifact_reference'])
})

test('检查点保留目标、已确认决策、约束、开放问题与实体标识', () => {
  const summary = buildThreadSummaryCheckpoint({ messages: thread(), now: 100 })
  assert.deepEqual(summary.goals, ['双十一首图，主色必须是品牌绿。', '参考这张 [媒体标识已省略] 的构图。'])
  assert.equal(summary.decisions[0].intent, 'replace_scene')
  assert.equal(summary.decisions[0].runId, 'run-1')
  assert.deepEqual(summary.constraints, ['person:preserve', 'scene:vary'])
  assert.deepEqual(summary.openQuestions, [{ messageId: 'm4', question: '需要留标题空间吗？' }])
  assert.deepEqual(summary.entityIds, ['run-1', 'result-7'])
  assert.equal(summary.coveredThrough, 5)
})

test('摘要不含执行 Prompt 原文', () => {
  // Prompt 是执行细节不是用户决定；需要重放它的地方读 Run 的编译快照。
  const summary = buildThreadSummaryCheckpoint({ messages: thread() })
  assert.equal(JSON.stringify(summary).includes('不该进摘要的执行 Prompt'), false)
})

test('摘要不含私有媒体地址、链接与凭据', () => {
  // 一旦写进检查点，之后每一轮都会重新带上。
  const summary = buildThreadSummaryCheckpoint({
    messages: [
      { id: 'm1', role: 'user', kind: 'text', content: '看 https://x.example/a 和 /api/media/media_x，key 是 sk-abcdefgh12345', createdAt: 1, updatedAt: 1 },
    ],
  })
  const serialized = JSON.stringify(summary)
  assert.equal(serialized.includes('/api/media/'), false)
  assert.equal(serialized.includes('https://'), false)
  assert.equal(serialized.includes('sk-abcdefgh'), false)
  assert.equal(redactSummaryText('data:image/png;base64,AAAA'), '[媒体已省略]')
  assert.equal(redactSummaryText(undefined), '')
})

test('未提交的计划不进决策：只有已提交执行的才是「已定下的事」', () => {
  // 状态词表里没有 confirmed；用户点确认后计划被提交，落到 submitted。
  const pending = thread().map((message) => (message.id === 'm3' ? { ...message, status: 'pending' } : message))
  const summary = buildThreadSummaryCheckpoint({ messages: pending })
  assert.deepEqual(summary.decisions, [])
  assert.deepEqual(summary.constraints, [])
})

test('增量刷新不丢弃旧事实，也不重复扫描已覆盖的消息', () => {
  // 检查点只增不改写历史，否则早期决策会随新一轮压缩悄悄消失。
  const first = buildThreadSummaryCheckpoint({ messages: thread(), now: 100 })
  const later = buildThreadSummaryCheckpoint({
    messages: [
      ...thread(),
      {
        id: 'm6', role: 'assistant', kind: 'plan', status: 'submitted', runId: 'run-2',
        content: '按新场景再出两张。', createdAt: 6, updatedAt: 6,
        plan: { intent: 'continue_generation', summary: '按新场景再出两张。', constraints: [{ dimension: 'style', mode: 'preserve' }] },
      },
    ],
    previous: first,
    now: 200,
  })
  assert.deepEqual(later.decisions.map((decision) => decision.runId), ['run-1', 'run-2'])
  assert.deepEqual(later.constraints, ['person:preserve', 'scene:vary', 'style:preserve'])
  assert.equal(later.entityIds.includes('run-1'), true)
  // 没有新消息时原样返回，不做无意义的重建。
  assert.equal(buildThreadSummaryCheckpoint({ messages: thread(), previous: first }), first)
})

test('目标先去重再截断，前几条重复不会挤掉后续不同目标', () => {
  const summary = buildThreadSummaryCheckpoint({
    messages: [
      { id: 'g1', role: 'user', kind: 'text', content: '品牌首图', updatedAt: 1 },
      { id: 'g2', role: 'user', kind: 'text', content: '品牌首图', updatedAt: 2 },
      { id: 'g3', role: 'user', kind: 'text', content: '品牌首图', updatedAt: 3 },
      { id: 'g4', role: 'user', kind: 'text', content: '同时交付竖版广告', updatedAt: 4 },
    ],
  })

  assert.deepEqual(summary.goals, ['品牌首图', '同时交付竖版广告'])
})

test('已被回答的追问不再算开放问题', () => {
  const first = buildThreadSummaryCheckpoint({
    messages: [
      ...thread(),
      { id: 'm-later', role: 'assistant', kind: 'text', content: '稍后消息', createdAt: 100, updatedAt: 100 },
    ],
    now: 100,
  })
  assert.equal(first.openQuestions.length, 1)
  const answered = buildThreadSummaryCheckpoint({
    // 这个实体的新版本早于会话全局高水位 100；必须按 message ID 跟踪版本。
    messages: [{ ...thread()[3], id: 'm4', status: 'answered', updatedAt: 9 }],
    previous: first,
    now: 200,
  })
  assert.deepEqual(answered.openQuestions, [])
})

test('pending 追问的 revision 更新按 Message ID 替换，覆盖 ID 与 revision 一一对齐', () => {
  const pending = thread()[3]
  const first = buildThreadSummaryCheckpoint({ messages: [pending], now: 100 })
  const refreshed = buildThreadSummaryCheckpoint({
    messages: [{
      ...pending,
      content: '标题需要留多大空间？',
      question: { ...pending.question, question: '标题需要留多大空间？' },
      updatedAt: 9,
    }],
    previous: first,
    now: 200,
  })

  assert.deepEqual(refreshed.openQuestions, [{ messageId: 'm4', question: '标题需要留多大空间？' }])
  assert.deepEqual(refreshed.coveredMessageIds, ['m4'])
  assert.deepEqual(refreshed.coveredMessageRevisions, [{
    messageId: 'm4', revision: messageSummaryRevision(refreshed.factCandidates[0].openQuestions
      ? { ...pending, content: '标题需要留多大空间？', question: { ...pending.question, question: '标题需要留多大空间？' }, updatedAt: 9 }
      : pending),
  }])
})

test('summary revision 含 summaryRelevantDigest，同时间戳修订也会替换旧 candidate', () => {
  const original = { id: 'goal-same-time', role: 'user', kind: 'text', content: '旧目标', updatedAt: 9 }
  const revised = { ...original, content: '新目标' }
  assert.notEqual(summaryRelevantDigest(original), summaryRelevantDigest(revised))
  assert.notEqual(messageSummaryRevision(original), messageSummaryRevision(revised))

  const first = buildThreadSummaryCheckpoint({ messages: [original], now: 10 })
  const refreshed = buildThreadSummaryCheckpoint({ messages: [revised], previous: first, now: 11 })
  assert.deepEqual(refreshed.goals, ['新目标'])
  assert.equal(refreshed.factCandidates.length, 1)
  assert.equal(hasThreadSummaryFactProvenance(refreshed), true)
})

test('goal/constraint/artifact/ref 采用最新来源，较新来源撤回后回退到较旧来源', () => {
  const olderGoal = { id: 'goal-old', role: 'user', kind: 'text', content: '共同目标', updatedAt: 1 }
  const newerGoal = { id: 'goal-new', role: 'user', kind: 'text', content: '共同目标', updatedAt: 2 }
  const olderPlan = {
    id: 'plan-old', role: 'assistant', kind: 'plan', status: 'submitted', content: '旧计划', updatedAt: 3,
    plan: {
      intent: 'replace_scene', summary: '旧计划', constraints: [{ dimension: 'person', mode: 'preserve' }],
      actions: [{ result: { artifacts: [{ id: 'artifact-shared', kind: 'image', label: '旧标签' }] } }],
    },
  }
  const newerPlan = {
    ...olderPlan, id: 'plan-new', content: '新计划', updatedAt: 4,
    plan: {
      ...olderPlan.plan, summary: '新计划',
      actions: [{ result: { artifacts: [{ id: 'artifact-shared', kind: 'image', label: '新标签' }] } }],
    },
  }
  const olderRef = {
    id: 'agent-turn-result-turn-old', turnId: 'turn-old', role: 'assistant', kind: 'text',
    content: '旧引用', updatedAt: 5,
    entityReferences: [{ type: 'artifact', id: 'artifact-ref-shared' }],
  }
  const newerRef = {
    id: 'agent-turn-result-turn-new', turnId: 'turn-new', role: 'assistant', kind: 'text',
    content: '新引用', updatedAt: 6,
    entityReferences: [{ type: 'artifact', id: 'artifact-ref-shared' }],
  }
  const first = buildThreadSummaryCheckpoint({
    messages: [olderGoal, newerGoal, olderPlan, newerPlan, olderRef, newerRef], now: 10,
  })
  assert.deepEqual(first.goals, ['共同目标'])
  assert.deepEqual(first.constraints, ['person:preserve'])
  assert.deepEqual(first.artifacts, [{ id: 'artifact-shared', kind: 'image', label: '新标签' }])
  assert.deepEqual(first.entityReferences, [{ type: 'artifact', id: 'artifact-ref-shared' }])

  const withdrawn = buildThreadSummaryCheckpoint({
    messages: [
      { ...newerGoal, kind: 'notice', role: 'assistant', content: '已撤回', updatedAt: 20 },
      { ...newerPlan, status: 'answered', plan: undefined, updatedAt: 21 },
      { ...newerRef, entityReferences: [], updatedAt: 22 },
    ],
    previous: first,
    now: 30,
  })
  assert.deepEqual(withdrawn.goals, ['共同目标'])
  assert.deepEqual(withdrawn.constraints, ['person:preserve'])
  assert.deepEqual(withdrawn.artifacts, [{ id: 'artifact-shared', kind: 'image', label: '旧标签' }])
  assert.deepEqual(withdrawn.entityReferences, [{ type: 'artifact', id: 'artifact-ref-shared' }])
})

test('constraint 以 dimension 为槽位 newest-wins，新值撤回后回退旧 mode', () => {
  const oldPlan = {
    id: 'constraint-old', role: 'assistant', kind: 'plan', status: 'submitted', content: '保留人物', updatedAt: 1,
    plan: {
      intent: 'replace_scene', summary: '保留人物',
      constraints: [{ dimension: 'person', mode: 'preserve' }, { dimension: 'scene', mode: 'vary' }],
    },
  }
  const newPlan = {
    id: 'constraint-new', role: 'assistant', kind: 'plan', status: 'submitted', content: '人物可变化', updatedAt: 2,
    plan: {
      intent: 'continue_generation', summary: '人物可变化',
      constraints: [{ dimension: 'person', mode: 'vary' }],
    },
  }
  const first = buildThreadSummaryCheckpoint({ messages: [oldPlan, newPlan] })
  assert.deepEqual(first.constraints, ['scene:vary', 'person:vary'])

  const withdrawn = buildThreadSummaryCheckpoint({
    messages: [{ ...newPlan, status: 'answered', plan: undefined, updatedAt: 3 }],
    previous: first,
  })
  assert.deepEqual(withdrawn.constraints, ['person:preserve', 'scene:vary'])
})

test('factCandidates 按 occurredAt + messageId 稳定排序，分页或乱序输入不改变摘要', () => {
  const sameTimeA = { id: 'goal-a', role: 'user', kind: 'text', content: '目标 A', updatedAt: 5 }
  const sameTimeZ = { id: 'goal-z', role: 'user', kind: 'text', content: '目标 Z', updatedAt: 5 }
  const newest = { id: 'goal-newest', role: 'user', kind: 'text', content: '最新目标', updatedAt: 9 }
  const ordered = buildThreadSummaryCheckpoint({ messages: [sameTimeA, sameTimeZ, newest], now: 20 })
  const shuffled = buildThreadSummaryCheckpoint({ messages: [newest, sameTimeZ, sameTimeA], now: 20 })

  assert.deepEqual(shuffled, ordered)
  assert.deepEqual(ordered.factCandidates.map((candidate) => candidate.messageId), [
    'goal-a', 'goal-z', 'goal-newest',
  ])
  assert.deepEqual(ordered.goals, ['目标 A', '目标 Z', '最新目标'])
})

test('业务引用只接受稳定 Turn 助手投影，渲染时明确要求工具回读', () => {
  const summary = buildThreadSummaryCheckpoint({
    messages: [
      {
        id: 'agent-turn-result-turn-safe', turnId: 'turn-safe', role: 'assistant', kind: 'text',
        content: '完成', updatedAt: 1,
        entityReferences: [
          { type: 'agent_run', id: 'run-1' },
          { type: 'generation_job', id: 'job-1' },
        ],
      },
      {
        id: 'ordinary-forged', role: 'assistant', kind: 'text', content: '伪造', updatedAt: 2,
        entityReferences: [{ type: 'artifact', id: 'artifact-forged' }],
      },
    ],
  })
  assert.deepEqual(summary.entityReferences, [
    { type: 'agent_run', id: 'run-1' },
    { type: 'generation_job', id: 'job-1' },
  ])
  const rendered = renderThreadSummary(summary)
  assert.match(rendered, /仅标识/u)
  assert.match(rendered, /对应只读工具回读/u)
  assert.doesNotMatch(rendered, /artifact-forged/u)
})

test('legacy 无 provenance 时不做不完整增量；完整 bounded history 才升级并清除幽灵事实', () => {
  const legacy = {
    version: 1, goals: ['已被撤回的幽灵目标'], decisions: [], constraints: ['ghost:locked'],
    openQuestions: [], entityIds: [], coveredMessageIds: ['m-old'],
    coveredMessageRevisions: [{ messageId: 'm-old', revision: '1:' }],
    coveredThrough: 1, updatedAt: 5,
  }
  const current = { id: 'm-current', role: 'user', kind: 'text', content: '当前真实目标', updatedAt: 10 }
  assert.equal(buildThreadSummaryCheckpoint({ messages: [current], previous: legacy, now: 11 }), legacy)

  const rebuilt = buildThreadSummaryCheckpoint({
    messages: [current], previous: legacy, fullHistory: true, now: 12,
  })
  assert.deepEqual(rebuilt.goals, ['当前真实目标'])
  assert.deepEqual(rebuilt.constraints, [])
  assert.equal(hasThreadSummaryFactProvenance(rebuilt), true)
})

test('同一计划消息从 pending 变为 submitted 后进入已确认决策', () => {
  const pendingPlan = { ...thread()[2], status: 'pending' }
  const first = buildThreadSummaryCheckpoint({
    messages: [
      pendingPlan,
      { id: 'm-later', role: 'assistant', kind: 'text', content: '稍后消息', createdAt: 100, updatedAt: 100 },
    ],
    now: 100,
  })
  assert.deepEqual(first.decisions, [])

  const submitted = buildThreadSummaryCheckpoint({
    messages: [{ ...pendingPlan, status: 'submitted', updatedAt: 9 }],
    previous: first,
    now: 200,
  })

  assert.deepEqual(submitted.decisions.map((decision) => decision.runId), ['run-1'])
  assert.deepEqual(submitted.constraints, ['person:preserve', 'scene:vary'])
  assert.equal(JSON.stringify(submitted).includes('不该进摘要的执行 Prompt'), false)
})

test('已覆盖计划的新版本替换同一条决策，不产生重复事实', () => {
  const first = buildThreadSummaryCheckpoint({ messages: thread(), now: 100 })
  const refreshed = buildThreadSummaryCheckpoint({
    messages: [{
      ...thread()[2],
      content: '锁定人物、服装和商品，替换场景。',
      updatedAt: 9,
      plan: { ...thread()[2].plan, summary: '锁定人物、服装和商品，替换场景。' },
    }],
    previous: first,
    now: 200,
  })

  assert.deepEqual(refreshed.decisions, [{
    messageId: 'm3', intent: 'replace_scene', summary: '锁定人物、服装和商品，替换场景。',
    runId: 'run-1', outputCount: 2, decidedAt: 9,
  }])
})

test('压缩阈值按结构化消息数判定', () => {
  assert.equal(THREAD_SUMMARY_THRESHOLD, 8)
  assert.equal(shouldCompactThread(thread()), false)
  const long = Array.from({ length: 9 }, (_, index) => ({ id: `m${index}`, role: 'user', kind: 'text', content: 'x' }))
  assert.equal(shouldCompactThread(long), true)
  // 没有标识的条目不参与计数：它们不会进检查点，也就不该触发压缩。
  assert.equal(shouldCompactThread(long.map((message) => ({ ...message, id: undefined }))), false)
})

test('渲染出的摘要明确标注是早前结论，不是本轮输入', () => {
  // 不标注的话模型会把它当成用户刚说的话，于是把早就定好的约束又问一遍。
  const rendered = renderThreadSummary(buildThreadSummaryCheckpoint({ messages: thread() }))
  assert.match(rendered, /本线程早前已经定下的事实/u)
  assert.match(rendered, /已锁定约束：person:preserve、scene:vary/u)
  assert.match(rendered, /尚未回答的问题：需要留标题空间吗？/u)
  assert.match(renderThreadSummary(buildThreadSummaryCheckpoint({ messages: thread() }), { locale: 'en' }), /Earlier in this thread/u)
  assert.equal(renderThreadSummary(undefined), '')
  assert.equal(renderThreadSummary({ version: 1 }), '')
})

test('artifact_reference 层存的是目录，不是结果内容', () => {
  // 此前这一层只体现为实体标识，没有可回读的指针：结果被挤出窗口后，模型既不知道
  // 有过这些产出，也就不会想到去 artifact_search 回读，「上次那版在哪」是凭空作答。
  const checkpoint = buildThreadSummaryCheckpoint({
    messages: [
      { id: 'm-1', role: 'user', kind: 'text', content: '做一版香水首图', updatedAt: 1 },
      {
        id: 'm-2', role: 'assistant', kind: 'text', content: '好了', updatedAt: 2,
        artifacts: [
          { id: 'generation:job-1:out-1', kind: 'image', label: '香水首图 A', url: '/api/media/m1', content: '不该进摘要' },
          { id: 'generation:job-1:out-2', kind: 'image', label: '香水首图 B', metadata: { prompt: '不该进摘要' } },
        ],
      },
    ],
    now: 5,
  })
  assert.deepEqual(checkpoint.artifacts, [
    { id: 'generation:job-1:out-1', kind: 'image', label: '香水首图 A' },
    { id: 'generation:job-1:out-2', kind: 'image', label: '香水首图 B' },
  ])
  // 内容、地址与元数据都不进摘要 —— 那才是「把结果重新塞回上下文」。
  const serialized = JSON.stringify(checkpoint)
  assert.equal(serialized.includes('不该进摘要'), false)
  assert.equal(serialized.includes('/api/media/'), false)
})

test('产出目录读取持久化计划行动的结果，不依赖不存在的 Message.artifacts 字段', () => {
  const checkpoint = buildThreadSummaryCheckpoint({
    messages: [{
      id: 'm-action', role: 'assistant', kind: 'plan', status: 'submitted',
      content: '已把结果存入素材库。', createdAt: 1, updatedAt: 2,
      plan: {
        intent: 'continue_generation', summary: '保存结果', constraints: [],
        actions: [{
          id: 'action-1', toolName: 'asset_store',
          result: { artifacts: [{ id: 'asset:stored-1', kind: 'file', label: '香水首图归档', url: '/api/media/private' }] },
        }],
      },
    }],
  })

  assert.deepEqual(checkpoint.artifacts, [
    { id: 'asset:stored-1', kind: 'file', label: '香水首图归档' },
  ])
  assert.doesNotMatch(JSON.stringify(checkpoint), /api\/media/u)
})

test('渲染时必须写明只有标识、内容要用工具回读', () => {
  // 不写的话模型会拿标签当成它看过的内容直接描述画面 —— 比不给这份目录更糟。
  const rendered = renderThreadSummary({
    artifacts: [{ id: 'generation:job-1:out-1', kind: 'image', label: '香水首图 A' }],
  })
  assert.match(rendered, /只有标识/u)
  assert.match(rendered, /不要凭这行描述画面/u)
  assert.match(rendered, /香水首图 A（generation:job-1:out-1）/u)
  assert.match(renderThreadSummary({ artifacts: [{ id: 'a', kind: 'image', label: 'A' }] }, { locale: 'en' }),
    /identifiers only.*do not describe them from memory/u)
})

test('产出目录有上限且去重，留最近的', () => {
  const many = Array.from({ length: 20 }, (_, index) => ({
    id: 'm-' + index, role: 'assistant', kind: 'text', content: 'x', updatedAt: index,
    artifacts: [{ id: `artifact-${index}`, kind: 'image', label: `图 ${index}` }],
  }))
  const checkpoint = buildThreadSummaryCheckpoint({ messages: many, now: 5 })
  assert.equal(checkpoint.artifacts.length, 12)
  // 早期结果更可能已被后续版本取代，因此留最近的。
  assert.equal(checkpoint.artifacts.at(-1).id, 'artifact-19')

  // 同一产出在多条消息里重复出现时只留一份。
  const deduped = buildThreadSummaryCheckpoint({
    messages: [
      { id: 'a', role: 'assistant', kind: 'text', content: 'x', updatedAt: 1, artifacts: [{ id: 'same', kind: 'image', label: '图' }] },
      { id: 'b', role: 'assistant', kind: 'text', content: 'x', updatedAt: 2, artifacts: [{ id: 'same', kind: 'image', label: '图' }] },
    ],
    now: 5,
  })
  assert.equal(deduped.artifacts.length, 1)
})

test('没有产出时不写这个键，摘要形状与改动前一致', () => {
  const checkpoint = buildThreadSummaryCheckpoint({
    messages: [{ id: 'm-1', role: 'user', kind: 'text', content: '目标', updatedAt: 1 }], now: 5,
  })
  assert.equal('artifacts' in checkpoint, false)
  assert.equal(/产出/u.test(renderThreadSummary(checkpoint)), false)
})

test('检查点保留创作 settings 与待确认行动，并渲染进摘要', () => {
  const summary = buildThreadSummaryCheckpoint({
    messages: [
      {
        id: 'm-plan', role: 'assistant', kind: 'plan', status: 'submitted', runId: 'run-creative',
        content: '出两张首图。', createdAt: 1, updatedAt: 1,
        plan: {
          intent: 'generate_image', summary: '出两张首图。',
          settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
          constraints: [{ dimension: 'person', mode: 'preserve' }],
          actions: [
            { id: 'a1', toolName: 'generate_image', label: '生成首图', status: 'awaiting_confirmation' },
            { id: 'a2', toolName: 'generate_image', label: '生成备选', status: 'succeeded' },
            {
              id: 'a3', toolName: 'asset_store', label: '存 https://evil.example/x',
              status: 'awaiting_confirmation',
            },
          ],
        },
      },
    ],
    now: 10,
  })
  assert.deepEqual(summary.decisions[0].settings, {
    model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K',
  })
  assert.deepEqual(summary.pendingActions, [
    { toolName: 'generate_image', label: '生成首图' },
    { toolName: 'asset_store', label: '存 [链接已省略]' },
  ])
  const rendered = renderThreadSummary(summary)
  assert.match(rendered, /gpt-image-2 · 3:4 · 2K/u)
  assert.match(rendered, /待确认行动：/u)
  assert.match(rendered, /生成首图（generate_image）/u)
  assert.equal(rendered.includes('https://'), false)
})
