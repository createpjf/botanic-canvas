import assert from 'node:assert/strict'
import test from 'node:test'
import {
  advanceProductionWorkflowRun,
  createProductionWorkflowSweep,
  reconcileWorkflowRunItems,
} from './productionWorkflowAdvance.mjs'

function run(overrides = {}) {
  return {
    id: 'wf-run-1', workflowId: 'wf-1', workflowVersion: 1, projectId: 'project-1',
    status: 'running',
    qualityGate: { required: false, status: 'not_required' },
    items: [
      { id: 'sku-a', index: 0, status: 'running', jobId: 'job-a', attempt: 1, updatedAt: 1 },
      { id: 'sku-b', index: 1, status: 'running', jobId: 'job-b', attempt: 1, updatedAt: 1 },
    ],
    createdAt: 1, createdBy: 'user-1', updatedAt: 1,
    ...overrides,
  }
}

const jobs = (a, b) => new Map([
  ['job-a', { id: 'job-a', status: a, outputs: a === 'succeeded' ? [{ id: 'out-1' }] : [] }],
  ['job-b', { id: 'job-b', status: b, outputs: b === 'succeeded' ? [{ id: 'out-1' }] : [], ...(b === 'failed' ? { error: '上游失败' } : {}) }],
])

test('按任务真实状态对账项，queued 在工作流里表示已接管', () => {
  const outcome = reconcileWorkflowRunItems({ run: run(), jobs: jobs('succeeded', 'queued') })
  assert.equal(outcome.changed, true)
  assert.deepEqual(outcome.run.items.map((item) => item.status), ['succeeded', 'running'])
  assert.deepEqual(outcome.run.items[0].artifactIds, ['generation:job-a:out-1'])
})

test('没有变化时不报告变化，避免无意义写库', () => {
  const settled = run({ items: run().items.map((item) => ({ ...item, status: 'running' })) })
  assert.equal(reconcileWorkflowRunItems({ run: settled, jobs: jobs('running', 'running') }).changed, false)
  // 缺任务记录时不猜状态。
  assert.equal(reconcileWorkflowRunItems({ run: settled, jobs: new Map() }).changed, false)
})

test('全部项到终态后推进运行；页面无人打开也能收口', () => {
  // 状态收敛沿用 applyWorkflowItemResult 那一份判定，这里只补上此前缺失的对账。
  const outcome = advanceProductionWorkflowRun({ run: run(), jobs: jobs('succeeded', 'succeeded'), now: 500 })
  assert.equal(outcome.run.status, 'succeeded')
  assert.equal(outcome.run.completedAt, 500)
  assert.equal(outcome.changed, true)
})

test('部分失败收敛为 partially_failed，全失败为 failed', () => {
  assert.equal(advanceProductionWorkflowRun({ run: run(), jobs: jobs('succeeded', 'failed'), now: 1 }).run.status, 'partially_failed')
  assert.equal(advanceProductionWorkflowRun({ run: run(), jobs: jobs('failed', 'failed'), now: 1 }).run.status, 'failed')
})

test('需要质量门时先进 awaiting_review，自动推进不代替人工批准', () => {
  const gated = run({
    qualityGate: { required: true, status: 'pending' },
    definition: { output: { reviewRequired: true } },
  })
  const outcome = advanceProductionWorkflowRun({ run: gated, jobs: jobs('succeeded', 'succeeded'), now: 1 })
  assert.equal(outcome.run.status, 'awaiting_review')
  assert.equal(outcome.run.qualityGate.status, 'pending')
})

test('暂停中与等待评审的运行不被自动推进', () => {
  // 用户按下暂停就是要它停在那里；等待评审要等人。
  for (const status of ['paused', 'awaiting_review']) {
    const held = run({ status })
    assert.equal(advanceProductionWorkflowRun({ run: held, jobs: jobs('succeeded', 'succeeded') }).changed, false)
  }
})

test('清扫逐项目推进，一个项目失败不挡住其他项目', async () => {
  const written = []
  const events = []
  const projects = {
    'project-broken': undefined,
    'project-ok': {
      revision: 3, graphRevision: 1,
      document: {
        id: 'project-ok', nodes: [],
        productionWorkflowRuns: [run({ projectId: 'project-ok' })],
      },
    },
  }
  const sweep = createProductionWorkflowSweep({
    productStore: {
      listProjectsWithActiveWorkflowRuns: async () => [
        { ownerId: 'user-1', projectId: 'project-broken' },
        { ownerId: 'user-1', projectId: 'project-ok' },
      ],
      readProject: async (_userId, projectId) => {
        if (projectId === 'project-broken') throw new Error('读取失败')
        return projects[projectId]
      },
      readGenerationJob: async (_userId, jobId) => jobs('succeeded', 'succeeded').get(jobId),
      writeProject: async (_userId, document) => { written.push(document); return { document, revision: 4 } },
    },
    observe: (event) => events.push(event),
    now: () => 900,
  })

  const result = await sweep()
  assert.equal(result.scanned, 2)
  assert.equal(result.advanced, 1)
  assert.equal(written[0].productionWorkflowRuns[0].status, 'succeeded')
  assert.ok(events.some((event) => event.event === 'workflow.advance.failed' && event.projectId === 'project-broken'))
})

test('没有活跃运行的部署不做任何写入', async () => {
  const sweep = createProductionWorkflowSweep({ productStore: { readProject: async () => undefined } })
  assert.deepEqual(await sweep(), { scanned: 0, advanced: 0 })
})
