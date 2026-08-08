import assert from 'node:assert/strict'
import test from 'node:test'
import { createProductionWorkflowRouteHandler } from './productionWorkflowRoutes.mjs'

function harness(bodies, submitGeneration = async ({ idempotencyKey }) => ({
  job: { id: `job-${idempotencyKey}`, status: 'queued' },
})) {
  let document = { id: 'project-a', nodes: [], productionWorkflows: [], productionWorkflowRuns: [] }
  let revision = 1
  const responses = []
  const handler = createProductionWorkflowRouteHandler({
    productStore: {
      projectAccess: async () => ({ exists: true, role: 'owner' }),
      readProject: async () => ({ document: structuredClone(document), revision, graphRevision: 1 }),
      writeProject: async (_userId, next) => {
        document = structuredClone(next)
        revision += 1
        return { document, revision, graphRevision: 1 }
      },
      readGenerationJob: async () => undefined,
    },
    json: (_response, status, body) => { responses.push({ status, body }); return true },
    error: (_response, status, code, message) => { responses.push({ status, body: { error: { code, message } } }); return true },
    readJson: async () => bodies.shift(),
    requireUser: async () => ({ id: 'user-a' }),
    submitGeneration,
    publishProjectUpdated: async () => undefined,
  })
  return { handler, responses, document: () => document }
}

const definition = {
  prompt: '为 {{product}} 生成品牌首图',
  model: 'gpt-image-2',
  settings: { aspectRatio: '1:1', resolution: '1K', batchCount: 1 },
  output: { mediaKind: 'image', reviewRequired: true },
  brandRules: ['保持品牌绿'],
  assetGroupIds: ['group-a'],
  confirmationPolicy: 'before-submit',
  recipe: { references: [{ name: '产品', role: '商品', mediaId: 'media_product' }] },
}

test('生产工作流通过服务端发布不可变版本并从指定版本创建批量运行', async () => {
  const { handler, responses, document } = harness([
    { id: 'workflow-a', name: '品牌首图', definition },
    { id: 'run-a', workflowVersion: 1, items: [{ id: 'sku-a', variables: { product: '香水 A' } }, { id: 'sku-b', variables: { product: '香水 B' } }] },
  ])

  await handler({ method: 'POST' }, {}, new URL('http://test/api/projects/project-a/production-workflows'), {
    projectProductionWorkflows: ['path', 'project-a'],
  })
  await handler({ method: 'POST' }, {}, new URL('http://test/api/projects/project-a/production-workflows/workflow-a/runs'), {
    projectProductionWorkflowRuns: ['path', 'project-a', 'workflow-a'],
  })

  assert.deepEqual(responses.map((entry) => entry.status), [201, 202])
  assert.equal(document().productionWorkflows[0].currentVersion, 1)
  assert.equal(document().productionWorkflowRuns[0].workflowVersion, 1)
  assert.deepEqual(document().productionWorkflowRuns[0].items.map((item) => item.status), ['running', 'running'])
  assert.match(document().productionWorkflowRuns[0].items[0].idempotencyKey, /^workflow_[A-Za-z0-9_-]{43}$/)
})

test('批量提交部分失败会保留成功任务并进入可重试状态', async () => {
  let calls = 0
  const { handler, responses, document } = harness([
    { id: 'workflow-a', name: '品牌首图', definition },
    { id: 'run-a', workflowVersion: 1, items: [{ id: 'sku-a' }, { id: 'sku-b' }] },
  ], async ({ idempotencyKey }) => {
    calls += 1
    if (calls === 2) {
      const error = new Error('队列暂不可用')
      error.code = 'QUEUE_UNAVAILABLE'
      throw error
    }
    return { job: { id: `job-${idempotencyKey}`, status: 'queued' } }
  })

  await handler({ method: 'POST' }, {}, new URL('http://test/api/projects/project-a/production-workflows'), {
    projectProductionWorkflows: ['path', 'project-a'],
  })
  await handler({ method: 'POST' }, {}, new URL('http://test/api/projects/project-a/production-workflows/workflow-a/runs'), {
    projectProductionWorkflowRuns: ['path', 'project-a', 'workflow-a'],
  })

  assert.equal(responses.at(-1).status, 202)
  assert.equal(document().productionWorkflowRuns[0].status, 'running')
  assert.deepEqual(document().productionWorkflowRuns[0].items.map((item) => item.status), ['running', 'failed'])
})

test('重复创建同一运行不会重复派发任务，且运行标识不能切换工作流版本', async () => {
  let submits = 0
  const { handler, responses } = harness([
    { id: 'workflow-a', name: '品牌首图', definition },
    { id: 'run-a', workflowVersion: 1, items: [{ id: 'sku-a' }] },
    { id: 'run-a', workflowVersion: 1, items: [{ id: 'sku-a' }] },
    { id: 'workflow-a', name: '品牌首图', definition: { ...definition, prompt: '新版 {{product}}' } },
    { id: 'run-a', workflowVersion: 2, items: [{ id: 'sku-a' }] },
  ], async ({ idempotencyKey }) => {
    submits += 1
    return { job: { id: `job-${idempotencyKey}`, status: 'queued' } }
  })

  const collection = { projectProductionWorkflows: ['path', 'project-a'] }
  const runs = { projectProductionWorkflowRuns: ['path', 'project-a', 'workflow-a'] }
  await handler({ method: 'POST' }, {}, new URL('http://test'), collection)
  await handler({ method: 'POST' }, {}, new URL('http://test'), runs)
  await handler({ method: 'POST' }, {}, new URL('http://test'), runs)
  await handler({ method: 'POST' }, {}, new URL('http://test'), collection)
  await handler({ method: 'POST' }, {}, new URL('http://test'), runs)

  assert.equal(submits, 1)
  assert.equal(responses[2].status, 200)
  assert.equal(responses[2].body.reused, true)
  assert.equal(responses.at(-1).status, 409)
  assert.equal(responses.at(-1).body.error.code, 'WORKFLOW_RUN_ID_CONFLICT')
})
