import assert from 'node:assert/strict'
import test from 'node:test'
import { requestedGenerationJobCancellation } from './generationJobExecution.mjs'
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
  const cancelled = []
  const dequeued = []
  const broadcast = []
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
      listAgentReviewTasksForRun: async () => options.reviewTasks ?? [],
      cancelGenerationJobExecution: async (_userId, command) => {
        const decision = requestedGenerationJobCancellation(options.jobs?.[command.id], command)
        if (decision.changed) {
          options.jobs[command.id] = structuredClone(decision.job)
          cancelled.push(structuredClone(decision.job))
        }
        return decision
      },
      putGenerationJob: async (_userId, job) => {
        cancelled.push(job)
        if (options.jobs?.[job.id]) options.jobs[job.id] = job
      },
    },
    json: (_response, status, body) => { responses.push({ status, body }); return true },
    error: (_response, status, code, message) => { responses.push({ status, body: { error: { code, message } } }); return true },
    readJson: async () => bodies.shift(),
    requireUser: async () => ({ id: 'user-a' }),
    submitGeneration,
    publishProjectUpdated: async () => undefined,
    redisQueue: { cancel: async (jobId) => dequeued.push(jobId) },
    publishCancel: async (event) => broadcast.push(event),
    modelOptions: [{ id: 'gpt-image-2', provider: 'openai' }],
  })
  return { handler, responses, document: () => document, cancelled, dequeued, broadcast }
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

function runningRunDocument(itemStatus = 'running') {
  return {
    id: 'project-a', nodes: [],
    productionWorkflows: [{ id: 'workflow-a', currentVersion: 1, versions: [{ version: 1, definition }] }],
    productionWorkflowRuns: [{
      id: 'run-a', workflowId: 'workflow-a', workflowVersion: 1, status: 'running',
      items: [
        { id: 'sku-a', status: itemStatus, jobId: 'job-queued' },
        { id: 'sku-b', status: itemStatus, jobId: 'job-running' },
      ],
    }],
  }
}

const activeJobs = () => ({
  'job-queued': { id: 'job-queued', projectId: 'project-a', status: 'queued', settings: { model: 'gpt-image-2' }, outputs: [] },
  'job-running': { id: 'job-running', projectId: 'project-a', status: 'running', settings: { model: 'gpt-image-2' }, outputs: [] },
})

test('取消整批工作流会广播到 Worker，运行中的任务才会真的停下', async () => {
  // 之前这里只写库加出队：出队对已派发的任务无效，Worker 仍会把 Provider 调用
  // 跑完，用户取消一整批之后槽位依然被占满。
  const { handler, responses, cancelled, dequeued, broadcast } = harness(
    [{ action: 'cancel' }], undefined, { initialDocument: runningRunDocument(), jobs: activeJobs() },
  )
  await handler({ method: 'PATCH' }, {}, new URL('http://test'), { projectProductionWorkflowRun: ['path', 'project-a', 'run-a'] })

  assert.equal(responses.at(-1).status, 200)
  assert.equal(responses.at(-1).body.run.status, 'cancelled')
  assert.deepEqual(cancelled.map((job) => job.id).sort(), ['job-queued', 'job-running'])
  assert.ok(cancelled.every((job) => job.status === 'cancelled'))
  assert.deepEqual(dequeued.sort(), ['job-queued', 'job-running'])
  assert.deepEqual(broadcast.map((event) => event.id).sort(), ['job-queued', 'job-running'])
  assert.ok(broadcast.every((event) => event.scope === 'job' && event.projectId === 'project-a' && event.requestedAt > 0))
})

test('取消回执按取消前的状态归因计费，不把两种任务混成一句话', async () => {
  const { handler, cancelled } = harness(
    [{ action: 'cancel' }], undefined, { initialDocument: runningRunDocument(), jobs: activeJobs() },
  )
  await handler({ method: 'PATCH' }, {}, new URL('http://test'), { projectProductionWorkflowRun: ['path', 'project-a', 'run-a'] })

  const byId = new Map(cancelled.map((job) => [job.id, job.cancel]))
  assert.equal(byId.get('job-queued').billing, 'none')
  assert.equal(byId.get('job-queued').code, 'CANCELLED_BEFORE_DISPATCH')
  assert.equal(byId.get('job-running').billing, 'possible')
  assert.equal(byId.get('job-running').workerReleaseExpected, true)
  assert.equal(byId.get('job-running').workerReleased, false)
  assert.equal(byId.get('job-running').signalRequired, true)
  assert.match(byId.get('job-running').signalId, /^generation-cancel:job-running:0:/u)
  assert.ok(byId.get('job-queued').requestedAt > 0)
  assert.equal(byId.get('job-running').reason, 'workflow-cancel')
})

test('暂停只收回尚未派发的任务，不丢弃已在 Provider 侧执行的那一张', async () => {
  const { handler, cancelled, broadcast } = harness(
    [{ action: 'pause' }], undefined, { initialDocument: runningRunDocument(), jobs: activeJobs() },
  )
  await handler({ method: 'PATCH' }, {}, new URL('http://test'), { projectProductionWorkflowRun: ['path', 'project-a', 'run-a'] })

  assert.deepEqual(cancelled.map((job) => job.id), ['job-queued'])
  assert.equal(cancelled[0].cancel.reason, 'workflow-pause')
  // 排队中的任务不需要广播就已经停住；只有它被取消，不该有第二次广播。
  assert.deepEqual(broadcast.map((event) => event.id), ['job-queued'])
})

test('发布时品牌规则由服务端从权威文档派生，客户端提交的那份被丢弃', () => {
  // 客户端那份绕过了激活过滤，也不带版本绑定；不可变定义不能采信它（ADR 0006）。
  return (async () => {
    const initialDocument = {
      id: 'project-a',
      nodes: [{ id: 'generate-a', type: 'generate', data: { kind: 'generate' } }],
      agentMemory: [
        { id: 'memory-active', kind: 'rule', content: '主色只用品牌绿', sourceNodeIds: [], source: 'human', confidence: 'confirmed', version: 3, contentHash: 'hash-green', updatedAt: 300 },
        { id: 'memory-provisional', kind: 'rule', content: '模型猜的规则', sourceNodeIds: [], source: 'conversation', confidence: 'provisional', updatedAt: 400 },
      ],
      productionWorkflows: [],
      productionWorkflowRuns: [],
    }
    const { handler, responses } = harness(
      [{ id: 'workflow-a', name: '品牌首图', definition: { ...definition, brandRules: ['客户端伪造的规则'] }, source }],
      undefined,
      { initialDocument },
    )
    await handler({ method: 'POST' }, {}, new URL('http://test'), workflowCollection)

    assert.equal(responses.at(-1).status, 201)
    const published = responses.at(-1).body.workflow.versions[0].definition
    assert.deepEqual(published.brandRules, ['主色只用品牌绿'])
    assert.deepEqual(published.brandRuleBindings, [
      { id: 'memory-active', version: 3, contentHash: 'hash-green', selectionReason: '用户确认的常驻项目规则' },
    ])
  })()
})

test('交付清单只打包人工批准过的候选，并给出被排除的原因', () => {
  return (async () => {
    const initialDocument = {
      id: 'project-a', nodes: [], agentMemory: [], productionWorkflows: [],
      productionWorkflowRuns: [{
        id: 'run-a', workflowId: 'workflow-a', workflowVersion: 1, projectId: 'project-a', status: 'awaiting_review',
        definition: { output: { aspectRatio: '1:1', nameTemplate: '{{sku}}-{{index}}' }, planFingerprint: 'plan-fp' },
        items: [
          { id: 'SKU-1', input: { sku: 'SKU-1' }, jobId: 'job-1', status: 'succeeded' },
          { id: 'SKU-2', input: { sku: 'SKU-2' }, jobId: 'job-2', status: 'succeeded' },
        ],
      }],
    }
    const { handler, responses } = harness([], undefined, {
      initialDocument,
      jobs: {
        'job-1': { id: 'job-1', status: 'succeeded', settings: { model: 'gpt-image-2' }, agentRun: { runId: 'agent-run-1' }, outputs: [{ id: 'o1', mediaKind: 'image', spec: { mimeType: 'image/png', byteSize: 10, width: 8, height: 8 } }] },
        'job-2': { id: 'job-2', status: 'succeeded', settings: { model: 'gpt-image-2' }, agentRun: { runId: 'agent-run-1' }, outputs: [{ id: 'o1', mediaKind: 'image', spec: { mimeType: 'image/png', byteSize: 10, width: 8, height: 8 } }] },
      },
      reviewTasks: [{
        id: 'review_task_1', qualityPolicyFingerprint: 'policy-fp',
        decisions: [{ artifactId: 'generation:job-1:o1', decision: 'accepted', decidedAt: 3 }],
      }],
    })
    await handler({ method: 'GET' }, {}, new URL('http://test'), {
      projectProductionWorkflowRunManifest: ['path', 'project-a', 'run-a'],
    })

    assert.equal(responses.at(-1).status, 200)
    const manifest = responses.at(-1).body.manifest
    assert.equal(manifest.fileCount, 1)
    assert.equal(manifest.files[0].fileName, 'SKU-1-1.png')
    assert.deepEqual(manifest.excluded, [{ artifactId: 'generation:job-2:o1', itemId: 'SKU-2', reason: 'not_approved' }])
    assert.equal(manifest.files[0].lineage.planFingerprint, 'plan-fp')
  })()
})
