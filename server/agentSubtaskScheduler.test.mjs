import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentSubtask } from './agentSubtask.mjs'
import {
  dedupeSubtasks,
  planSubtaskBatches,
  runAgentSubtask,
  runAgentSubtaskFanout,
  subtaskFanoutSummary,
} from './agentSubtaskScheduler.mjs'

const registry = {
  get: (name) => (['web_search', 'canvas_read'].includes(name) ? { name, risk: 'read' } : undefined),
  execute: async (name, args) => ({ tool: name, args }),
}

const outputSchema = { type: 'object', required: ['summary'], properties: { summary: { type: 'string', maxLength: 100 } } }

const subtaskOf = (overrides = {}) => createAgentSubtask({
  parentTurnId: 'turn-1', projectId: 'p-1', ownerId: 'u-1', role: 'brand_research',
  input: { question: 'q' }, allowedTools: ['web_search'], outputSchema, registry,
  budget: { maxSteps: 2, maxToolCalls: 2 }, timeoutMs: 2_000, ...overrides,
})

test('并发按上限分批，扇出总量也有硬上限', () => {
  const many = Array.from({ length: 7 }, (_, index) => subtaskOf({ input: { question: `q${index}` } }))
  assert.deepEqual(planSubtaskBatches(many, { maxConcurrent: 3 }).map((batch) => batch.length), [3, 3, 1])
  // 上限被夹在硬顶之内：调用方要 100 并发也不行，配额是整个工作区共享的。
  assert.deepEqual(planSubtaskBatches(many, { maxConcurrent: 100 }).map((batch) => batch.length), [4, 3])
  const tooMany = Array.from({ length: 13 }, (_, index) => subtaskOf({ input: { question: `x${index}` } }))
  assert.throws(() => planSubtaskBatches(tooMany), (error) => error.code === 'SUBTASK_FANOUT_TOO_LARGE')
})

test('重复派发被报出来，不静默去重', () => {
  const one = subtaskOf()
  const { subtasks, duplicates } = dedupeSubtasks([one, { ...one }, subtaskOf({ role: 'audience_research' })])
  assert.equal(subtasks.length, 2)
  // 静默去重会让「我明明派了 3 个」变成无从查证的问题。
  assert.deepEqual(duplicates, [one.id])
})

test('超时可追踪地终止，且不把进程拖住', async () => {
  const result = await runAgentSubtask({
    subtask: subtaskOf({ timeoutMs: 1_000 }),
    runSubagent: ({ signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ summary: '太晚了' }), 30_000)
      timer.unref?.()
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) })
    }),
    registry,
  })
  assert.equal(result.status, 'terminated')
  assert.equal(result.termination.reason, 'timeout')
  assert.match(result.termination.detail, /超过 1000ms/u)
})

test('子任务调用白名单外的工具立即终止，原因是 tool_denied', async () => {
  const result = await runAgentSubtask({
    subtask: subtaskOf(),
    runSubagent: async ({ callTool }) => {
      await callTool('canvas_read', {})
      return { summary: '不该走到这里' }
    },
    registry,
  })
  assert.equal(result.status, 'terminated')
  // 泛化成 failed 就看不出是越权还是崩了。
  assert.equal(result.termination.reason, 'tool_denied')
  assert.match(result.termination.detail, /canvas_read/u)
})

test('工具调用预算被实际执行，不是只声明', async () => {
  const result = await runAgentSubtask({
    subtask: subtaskOf({ budget: { maxSteps: 2, maxToolCalls: 2 } }),
    runSubagent: async ({ callTool }) => {
      await callTool('web_search', { q: 1 })
      await callTool('web_search', { q: 2 })
      await callTool('web_search', { q: 3 })
      return { summary: '不该走到这里' }
    },
    registry,
  })
  assert.equal(result.status, 'terminated')
  assert.equal(result.termination.reason, 'budget_exhausted')
  assert.match(result.termination.detail, /工具调用已达上限 2/u)
})

test('输出不合 Schema 时按 output_invalid 终止，不是泛化失败', async () => {
  const result = await runAgentSubtask({
    subtask: subtaskOf(), registry,
    runSubagent: async () => ({ notSummary: '缺字段' }),
  })
  assert.equal(result.status, 'terminated')
  assert.equal(result.termination.reason, 'output_invalid')

  const smuggled = await runAgentSubtask({
    subtask: subtaskOf(), registry,
    runSubagent: async () => ({ summary: '看似正常', canvasCommands: [{ kind: 'addNode' }] }),
  })
  assert.equal(smuggled.termination.reason, 'output_invalid')
})

test('正常完成时记录花费，工具调用带上子任务身份', async () => {
  const seen = []
  const result = await runAgentSubtask({
    subtask: subtaskOf(),
    registry: { ...registry, execute: async (name, args, context) => { seen.push(context); return { name, args } } },
    context: { userId: 'u-1' },
    runSubagent: async ({ callTool }) => {
      await callTool('web_search', { q: '品牌' })
      return { summary: '品牌偏克制' }
    },
  })
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.spent, { steps: 1, toolCalls: 1 })
  assert.equal(result.result.output.summary, '品牌偏克制')
  // 日志里要能区分是哪个子 Agent 发起的调用。
  assert.equal(seen[0].subtaskId, result.id)
  assert.equal(seen[0].traceId, 'turn-1')
  assert.equal(seen[0].userId, 'u-1')
})

test('重放命中已有终态直接复用，不重新执行', async () => {
  const subtask = subtaskOf()
  let runs = 0
  const first = await runAgentSubtaskFanout({
    subtasks: [subtask], registry,
    runSubagent: async () => { runs += 1; return { summary: '第一次' } },
  })
  assert.equal(runs, 1)

  const replay = await runAgentSubtaskFanout({
    subtasks: [subtask], registry,
    existingResults: first.results,
    runSubagent: async () => { runs += 1; return { summary: '第二次' } },
  })
  // 恢复一次中断的编排时，已经跑完的研究不该再花一次钱，也不该给出与上次不同的提案。
  assert.equal(runs, 1)
  assert.equal(replay.reused, 1)
  assert.equal(replay.results[0].result.output.summary, '第一次')
})

test('终止的子任务同样算已结算，重放不会把它再跑一遍', async () => {
  const subtask = subtaskOf()
  let runs = 0
  const first = await runAgentSubtaskFanout({
    subtasks: [subtask], registry,
    runSubagent: async () => { runs += 1; throw new Error('provider 挂了') },
  })
  assert.equal(first.terminated.length, 1)
  await runAgentSubtaskFanout({
    subtasks: [subtask], registry, existingResults: first.results,
    runSubagent: async () => { runs += 1; return { summary: '第二次' } },
  })
  assert.equal(runs, 1)
})

test('一路失败不取消其余', async () => {
  const good = subtaskOf({ input: { question: 'a' } })
  const bad = subtaskOf({ input: { question: 'b' } })
  const outcome = await runAgentSubtaskFanout({
    subtasks: [good, bad], registry, maxConcurrent: 2,
    // 并行探索里有一路失败是正常的；全组作废会让另一路已经花掉的钱白费。
    runSubagent: async ({ subtask }) => {
      if (subtask.id === bad.id) throw new Error('这一路挂了')
      return { summary: '这一路成了' }
    },
  })
  assert.equal(outcome.completed.length, 1)
  assert.equal(outcome.terminated.length, 1)
  assert.equal(outcome.terminated[0].termination.reason, 'failed')
})

test('摘要必须把终止数与完成数并列', () => {
  // 只报「拿到 3 份提案」会让人以为全部跑成功，而结论其实是在残缺输入上得出的。
  const outcome = {
    completed: [{}, {}, {}],
    terminated: [{ termination: { reason: 'timeout' } }, { termination: { reason: 'budget_exhausted' } }],
    reused: 1,
  }
  const summary = subtaskFanoutSummary(outcome)
  assert.match(summary, /3 份提案/u)
  assert.match(summary, /2 个子任务提前终止（timeout、budget_exhausted）/u)
  assert.match(summary, /1 个复用了上一次的结果/u)
  assert.equal(subtaskFanoutSummary({ completed: [{}] }), '1 份提案。')
  assert.match(subtaskFanoutSummary(outcome, 'en'), /2 subtask\(s\) stopped early \(timeout, budget_exhausted\)/u)
})

test('并发上限被真的执行，不是只分批', async () => {
  let inFlight = 0
  let peak = 0
  const subtasks = Array.from({ length: 6 }, (_, index) => subtaskOf({ input: { question: `q${index}` } }))
  await runAgentSubtaskFanout({
    subtasks, registry, maxConcurrent: 2,
    runSubagent: async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => { setTimeout(resolve, 5) })
      inFlight -= 1
      return { summary: 'ok' }
    },
  })
  assert.equal(peak, 2, `同时在跑的子任务峰值应为 2，实际 ${peak}`)
})
