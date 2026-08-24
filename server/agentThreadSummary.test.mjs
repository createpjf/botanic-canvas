import assert from 'node:assert/strict'
import test from 'node:test'
import {
  THREAD_CONTEXT_KINDS,
  THREAD_SUMMARY_THRESHOLD,
  buildThreadSummaryCheckpoint,
  redactSummaryText,
  renderThreadSummary,
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

test('已被回答的追问不再算开放问题', () => {
  const first = buildThreadSummaryCheckpoint({ messages: thread(), now: 100 })
  assert.equal(first.openQuestions.length, 1)
  const answered = buildThreadSummaryCheckpoint({
    messages: [{ ...thread()[3], id: 'm4', status: 'answered', updatedAt: 9 }],
    previous: { ...first, coveredMessageIds: first.coveredMessageIds.filter((id) => id !== 'm4') },
    now: 200,
  })
  assert.deepEqual(answered.openQuestions, [])
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
