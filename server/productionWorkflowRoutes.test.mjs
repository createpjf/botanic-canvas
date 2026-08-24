import assert from 'node:assert/strict'
import test from 'node:test'
import { createProductionWorkflowRouteHandler } from './productionWorkflowRoutes.mjs'

function harness(bodies, submitGeneration = async ({ idempotencyKey }) => ({
  job: { id: `job-${idempotencyKey}`, status: 'queued' },
}), options = {}) {
  let document = structuredClone(options.initialDocument ?? {
    id: 'project-a',
    nodes: [{ id: 'generate-a', type: 'generate', data: { kind: 'generate' } }],
    productionWorkflows: [],
    productionWorkflowRuns: [],
  })
  let revision = 1
  const responses = []
  const handler = createProductionWorkflowRouteHandler({
    productStore: {
      projectAccess: async () => ({ exists: true, role: options.role ?? 'owner' }),
      readProject: async () => ({ document: structuredClone(document), revision, graphRevision: 1 }),
      writeProject: async (_userId, next) => {
        if (options.rejectWrites) {
          const caught = new Error('Viewer 不得写入项目')
          caught.code = 'PROJECT_ACCESS_FORBIDDEN'
          throw caught
        }
        document = structuredClone(next)
        revision += 1
        return { document, revision, graphRevision: 1 }
      },
      readGenerationJob: async (_userId, jobId) => options.jobs?.[jobId],
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

const source = { canvasNodeId: 'generate-a', resultNodeIds: [] }
const workflowCollection = { projectProductionWorkflows: ['path', 'project-a'] }

test('生产工作流通过服务端发布不可变版本并从指定版本创建批量运行', async () => {
  const { handler, responses, document } = harness([
    { id: 'workflow-a', name: '品牌首图', definition, source },
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
    { id: 'workflow-a', name: '品牌首图', definition, source },
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
    { id: 'workflow-a', name: '品牌首图', definition, source },
    { id: 'run-a', workflowVersion: 1, items: [{ id: 'sku-a' }] },
    { id: 'run-a', workflowVersion: 1, items: [{ id: 'sku-a' }] },
    { id: 'workflow-a', name: '品牌首图', definition: { ...definition, prompt: '新版 {{product}}' }, source },
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

test('恢复读取时将排队中的 Generation Job 映射为工作流运行中，不返回 500', async () => {
  const { handler, responses, document } = harness([
    { id: 'workflow-a', name: '品牌首图', definition, source },
    { id: 'run-a', workflowVersion: 1, items: [{ id: 'sku-a' }] },
  ], undefined, { jobs: { 'job-sku-a': { id: 'job-sku-a', status: 'queued', outputs: [] } } })
  // 先创建运行，再把测试文档中的任务绑定为已排队 Job。
  await handler({ method: 'POST' }, {}, new URL('http://test'), { projectProductionWorkflows: ['path', 'project-a'] })
  await handler({ method: 'POST' }, {}, new URL('http://test'), { projectProductionWorkflowRuns: ['path', 'project-a', 'workflow-a'] })
  const run = document().productionWorkflowRuns[0]
  run.items[0].jobId = 'job-sku-a'
  run.items[0].status = 'running'
  const getResponse = await handler({ method: 'GET' }, {}, new URL('http://test'), { projectProductionWorkflowRun: ['path', 'project-a', 'run-a'] })
  assert.equal(getResponse, true)
  assert.equal(responses.at(-1).status, 200)
  assert.equal(responses.at(-1).body.run.items[0].status, 'running')
})

test('Viewer 读取运行状态不尝试写回项目，仍返回最新任务状态', async () => {
  const initialDocument = {
    id: 'project-a', nodes: [], productionWorkflows: [{ id: 'workflow-a', currentVersion: 1, versions: [{ version: 1, definition }] }],
    productionWorkflowRuns: [{ id: 'run-a', workflowId: 'workflow-a', workflowVersion: 1, status: 'running', items: [{ id: 'sku-a', status: 'running', jobId: 'job-sku-a' }] }],
  }
  const { handler, responses } = harness([], undefined, {
    role: 'viewer', rejectWrites: true, initialDocument,
    jobs: { 'job-sku-a': { id: 'job-sku-a', status: 'succeeded', outputs: [] } },
  })
  await handler({ method: 'GET' }, {}, new URL('http://test'), { projectProductionWorkflowRun: ['path', 'project-a', 'run-a'] })
  assert.equal(responses.at(-1).status, 200)
  assert.equal(responses.at(-1).body.run.items[0].status, 'succeeded')
})

test('发布必须显式携带来源，缺失时拒绝而不是猜第一个生成节点', async () => {
  const { handler, responses, document } = harness([{ id: 'workflow-a', name: '品牌首图', definition }])
  await handler({ method: 'POST' }, {}, new URL('http://test'), workflowCollection)
  assert.equal(responses.at(-1).status, 400)
  assert.equal(responses.at(-1).body.error.code, 'WORKFLOW_SOURCE_REQUIRED')
  assert.deepEqual(document().productionWorkflows, [])
})

test('来源实体不属于当前项目文档时按具名错误拒绝发布', async () => {
  const { handler, responses, document } = harness([
    { id: 'workflow-a', name: '品牌首图', definition, source: { canvasNodeId: 'ghost-node', resultNodeIds: [] } },
    { id: 'workflow-a', name: '品牌首图', definition, source: { canvasNodeId: 'generate-a', runId: 'ghost-run', resultNodeIds: [] } },
    { id: 'workflow-a', name: '品牌首图', definition, source: { canvasNodeId: 'generate-a', resultNodeIds: ['ghost-result'] } },
  ])
  for (let index = 0; index < 3; index += 1) {
    await handler({ method: 'POST' }, {}, new URL('http://test'), workflowCollection)
  }
  assert.deepEqual(responses.map((entry) => entry.body.error.code), [
    'WORKFLOW_SOURCE_NODE_NOT_FOUND',
    'WORKFLOW_SOURCE_RUN_NOT_FOUND',
    'WORKFLOW_SOURCE_RESULT_NOT_FOUND',
  ])
  assert.deepEqual(document().productionWorkflows, [])
})

test('发布成功的版本固定来源身份并标记为已校验', async () => {
  const initialDocument = {
    id: 'project-a',
    nodes: [
      { id: 'generate-a', type: 'generate', data: { kind: 'generate', agentRun: { runId: 'run-a', branchId: 'branch-a' } } },
      { id: 'result-a', type: 'result', data: { kind: 'result', jobId: 'job-a', candidateId: 'candidate-a', agentRun: { runId: 'run-a', branchId: 'branch-a' } } },
    ],
    agentRuns: [{ id: 'run-a', status: 'completed', branches: [{ id: 'branch-a' }] }],
    productionWorkflows: [],
    productionWorkflowRuns: [],
  }
  const { handler, responses, document } = harness([{
    id: 'workflow-a', name: '品牌首图', definition,
    source: { canvasNodeId: 'generate-a', runId: 'run-a', branchId: 'branch-a', resultNodeIds: ['result-a'] },
  }], undefined, { initialDocument })

  await handler({ method: 'POST' }, {}, new URL('http://test'), workflowCollection)
  assert.equal(responses.at(-1).status, 201)
  const version = document().productionWorkflows[0].versions[0]
  assert.equal(version.provenance, 'verified')
  assert.deepEqual(version.source, {
    canvasNodeId: 'generate-a', runId: 'run-a', branchId: 'branch-a',
    resultNodeIds: ['result-a'],
    // Artifact 标识由服务端从结果节点解析，客户端不拼装格式。
    artifactIds: ['generation:job-a:candidate-a'],
  })
})

test('读取历史工作流时把缺少来源的版本标记为 legacy_unverified', async () => {
  const initialDocument = {
    id: 'project-a',
    nodes: [{ id: 'generate-a', type: 'generate', data: { kind: 'generate' } }],
    productionWorkflows: [{
      id: 'workflow-legacy', projectId: 'project-a', name: '历史流程', currentVersion: 1,
      versions: [{ version: 1, definition, createdAt: 1, createdBy: 'user-a' }],
    }],
    productionWorkflowRuns: [],
  }
  const { handler, responses } = harness([], undefined, { initialDocument })
  await handler({ method: 'GET' }, {}, new URL('http://test'), workflowCollection)
  assert.equal(responses.at(-1).body.workflows[0].versions[0].provenance, 'legacy_unverified')
  // 历史版本仍可读取，只是被标记；不伪造 source 字段。
  assert.equal(responses.at(-1).body.workflows[0].versions[0].source, undefined)
})

test('来源结果跨 Run 或分支不匹配时拒绝，未完成的 Run 也不能发布', async () => {
  const initialDocument = {
    id: 'project-a',
    nodes: [
      { id: 'generate-a', type: 'generate', data: { kind: 'generate' } },
      { id: 'result-other', type: 'result', data: { kind: 'result', jobId: 'job-b', candidateId: 'candidate-b', agentRun: { runId: 'run-b', branchId: 'branch-b' } } },
    ],
    agentRuns: [{ id: 'run-a', status: 'completed', branches: [{ id: 'branch-a' }] }, { id: 'run-running', status: 'running', branches: [] }],
    productionWorkflows: [],
    productionWorkflowRuns: [],
  }
  const { handler, responses } = harness([
    { id: 'workflow-a', name: '品牌首图', definition, source: { canvasNodeId: 'generate-a', runId: 'run-a', branchId: 'branch-a', resultNodeIds: ['result-other'] } },
    { id: 'workflow-a', name: '品牌首图', definition, source: { canvasNodeId: 'generate-a', runId: 'run-running', resultNodeIds: [] } },
    { id: 'workflow-a', name: '品牌首图', definition, source: { canvasNodeId: 'generate-a', runId: 'run-a', branchId: 'ghost-branch', resultNodeIds: [] } },
  ], undefined, { initialDocument })
  for (let index = 0; index < 3; index += 1) {
    await handler({ method: 'POST' }, {}, new URL('http://test'), workflowCollection)
  }
  assert.deepEqual(responses.map((entry) => entry.body.error.code), [
    'WORKFLOW_SOURCE_RESULT_MISMATCH',
    'WORKFLOW_SOURCE_RUN_NOT_TERMINAL',
    'WORKFLOW_SOURCE_BRANCH_NOT_FOUND',
  ])
})
