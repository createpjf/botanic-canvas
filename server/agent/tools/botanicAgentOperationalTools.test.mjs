import assert from 'node:assert/strict'
import test from 'node:test'
import {
  OPERATIONAL_ACTION_TOOLS,
  OPERATIONAL_READ_TOOLS,
  botanicAgentOperationalSourceLabels,
  createBotanicAgentOperationalActionDefinitions,
  createBotanicAgentOperationalToolDefinitions,
  operationalActionToolsForRole,
} from './botanicAgentOperationalTools.mjs'

const run = {
  id: 'run-1', status: 'partial', createdAt: 1, updatedAt: 2,
  completedBranchCount: 1, failedBranchCount: 1, turnId: 'turn-1',
  compiledPlan: { version: 2, planFingerprint: 'plan-fp' },
  compiledPlanProvenance: 'compiled_v2',
  plan: { prompt: '不该出现在工具结果里的 Prompt' },
  branches: [
    { id: 'branch-a', label: '海边', status: 'succeeded', attempt: 0, jobIds: ['job-a'], activeJobId: 'job-a', outputCount: 2 },
    { id: 'branch-b', label: '森林', status: 'failed', attempt: 2, jobIds: ['job-b'], outputCount: 0, error: '模型超时' },
  ],
}

const job = {
  id: 'job-b', status: 'failed', kind: 'generation', settings: { model: 'gpt-image-2' },
  provider: 'openai-images', batchCount: 2, outputs: [], missingOutputCount: 2,
  error: '生成服务响应超时，任务已停止，请稍后重试。', createdAt: 1, updatedAt: 2,
  planFingerprint: 'plan-fp', branchFingerprint: 'branch-fp-b',
  providerAttempts: [{ provider: 'openai', model: 'gpt-image-2', startedAt: 5 }],
  executionVersion: 7,
  execution: { generation: 7, leaseToken: 'PRIVATE_GENERATION_LEASE', leaseExpiresAt: 99 },
  rawInput: { prompt: '不该出现的 Prompt', recipe: { references: [{ dataUrl: 'data:image/png;base64,SECRET' }] } },
  cancel: { requestedAt: 9, reason: 'user', billing: 'possible', capability: 'local-abort-only', code: 'CANCELLED_RESULT_DISCARDED' },
}

const artifact = {
  id: 'generation:job-a:out-1', kind: 'image', label: '首图 01', placement: 'canvas',
  url: '/api/media/media_private_secret', createdAt: 3,
  origin: { type: 'generation_output', jobId: 'job-a', outputId: 'out-1' },
  provenance: { actionId: 'generation:job-a', toolName: 'image_generation', runId: 'run-1', sourceNodeIds: ['result-1'] },
  metadata: { status: 'succeeded', jobId: 'job-a', branchId: 'branch-a', planFingerprint: 'plan-fp', branchFingerprint: 'branch-fp-a', prompt: '不该出现的 Prompt', savedToLibrary: true },
}

const reviewTask = {
  id: 'review_task_1', runId: 'run-1', status: 'completed', attempt: 1,
  qualityPolicyFingerprint: 'policy-fp', planFingerprint: 'plan-fp',
  coverage: { strategy: 'capped', totalCandidates: 5, reviewedCandidates: 2, skippedCandidates: 3, artifactIds: ['a1', 'a2'] },
  results: [{ artifactId: 'a1', verdict: 'fail', candidateStatus: 'pending_human', criteria: [{ id: 'aspect_ratio', layer: 'deterministic', verdict: 'fail', evidence: '期望 1:1，实际 1:2。' }] }],
  decisions: [{ artifactId: 'a1', decision: 'rejected', decidedAt: 7, decidedBy: 'user-1', note: '背景过曝' }],
}

function tools(overrides = {}) {
  const definitions = createBotanicAgentOperationalToolDefinitions({
    queryCanvas: async () => ({ nodes: [], edges: [], page: { returned: 0, hasMore: false, edgesTruncated: false } }),
    readRun: async () => run,
    readJob: async () => job,
    searchArtifacts: async () => [artifact],
    readReviews: async () => [reviewTask],
    readWorkflowRun: async () => ({
      id: 'wf-run-1', workflowId: 'wf-1', workflowVersion: 2, status: 'partially_failed',
      items: [
        { id: 'sku-a', status: 'succeeded', jobId: 'job-x', artifactIds: ['a1'] },
        { id: 'sku-b', status: 'failed', jobId: 'job-y', error: { code: 'GENERATION_FAILED', message: '上游失败' } },
      ],
    }),
    readDeliveries: async () => [{ id: 'delivery-1', name: '双十一首图', channel: 'tmall', status: 'draft', items: [{}, {}], createdAt: 1, updatedAt: 2 }],
    ...overrides,
  })
  return new Map(definitions.map((definition) => [definition.name, definition]))
}

test('七个只读运维工具都声明 read 风险', () => {
  const registry = tools()
  assert.deepEqual([...registry.keys()], [...OPERATIONAL_READ_TOOLS])
  assert.ok([...registry.values()].every((tool) => tool.risk === 'read'))
})

test('缺读取器的工具不暴露：模型看不到就不会声称能用', () => {
  const registry = createBotanicAgentOperationalToolDefinitions({ readRun: async () => run })
  assert.deepEqual(registry.map((tool) => tool.name), ['agent_run_read'])
  assert.deepEqual(createBotanicAgentOperationalToolDefinitions(), [])
})

test('任务状态给结构化分支状态，不给 Prompt', async () => {
  const result = await tools().get('agent_run_read').execute({ runId: 'run-1' })
  assert.equal(result.run.status, 'partial')
  assert.equal(result.run.planFingerprint, 'plan-fp')
  assert.equal(result.run.compiledPlanProvenance, 'compiled_v2')
  assert.deepEqual(result.run.branches.map((branch) => `${branch.id}:${branch.status}:${branch.attempt}`), [
    'branch-a:succeeded:0', 'branch-b:failed:2',
  ])
  assert.equal(result.run.branches[1].error, '模型超时')
  assert.equal(JSON.stringify(result).includes('不该出现在工具结果里的 Prompt'), false)
})

test('找不到实体时明确返回 found: false，不编造状态', async () => {
  const registry = tools({ readRun: async () => undefined, readJob: async () => undefined, readWorkflowRun: async () => undefined })
  assert.deepEqual(await registry.get('agent_run_read').execute({ runId: 'run-x' }), { found: false, runId: 'run-x' })
  assert.deepEqual(await registry.get('generation_job_read').execute({ jobId: 'job-x' }), { found: false, jobId: 'job-x' })
  assert.deepEqual(await registry.get('workflow_run_read').execute({ runId: 'wf-x' }), { found: false, runId: 'wf-x' })
})

test('任务失败原因给错误码与 Provider 尝试，不给原始回包或 Prompt', async () => {
  const result = await tools().get('generation_job_read').execute({ jobId: 'job-b' })
  assert.equal(result.job.status, 'failed')
  assert.match(result.job.error, /响应超时/u)
  assert.deepEqual(result.job.providerAttempts, [{ provider: 'openai', model: 'gpt-image-2', startedAt: 5 }])
  // 取消回执直接回答「为什么停了、费用是否可能已产生」。
  assert.deepEqual(result.job.cancel, { reason: 'user', billing: 'possible', code: 'CANCELLED_RESULT_DISCARDED' })
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes('不该出现的 Prompt'), false)
  assert.equal(serialized.includes('data:image'), false)
  assert.equal(serialized.includes('SECRET'), false)
  assert.equal(serialized.includes('PRIVATE_GENERATION_LEASE'), false)
  assert.equal(serialized.includes('executionVersion'), false)
})

test('历史结果检索不返回媒体地址', async () => {
  // 工具结果会进模型上下文；受控媒体地址一旦进去就不再受控。
  const result = await tools().get('artifact_search').execute({ query: '', kind: '', limit: 20 })
  assert.equal(result.artifacts[0].id, 'generation:job-a:out-1')
  assert.equal(result.artifacts[0].planFingerprint, 'plan-fp')
  assert.equal(result.artifacts[0].savedToLibrary, true)
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes('/api/media/'), false)
  assert.equal(serialized.includes('不该出现的 Prompt'), false)
})

test('检索参数被收敛到安全上限', () => {
  const validate = tools().get('artifact_search').validate
  assert.deepEqual(validate({}), { query: '', kind: '', limit: 20 })
  assert.equal(validate({ limit: 999 }).limit, 50)
  assert.equal(validate({ limit: 0 }).limit, 1)
  assert.equal(validate({ query: ' 首图 ' }).query, '首图')
})

test('评审读取暴露覆盖策略与被跳过数，逐条判据可见', async () => {
  const result = await tools().get('review_read').execute({ runId: 'run-1' })
  const task = result.tasks[0]
  assert.equal(task.coverage.strategy, 'capped')
  // 静默截断会让「评了 2 张」看起来像「全评过了」。
  assert.equal(task.coverage.skippedCandidates, 3)
  assert.equal(task.results[0].criteria[0].evidence, '期望 1:1，实际 1:2。')
  assert.equal(task.decisions[0].decision, 'rejected')
  // 决定者身份与备注不进模型上下文。
  assert.equal(JSON.stringify(result).includes('decidedBy'), false)
})

test('review_read 对任务、结果、判据和决定分层有界，并准确报告 omitted', async () => {
  const reviewTasks = Array.from({ length: 10 }, (_, taskIndex) => ({
    id: `task-${taskIndex + 1}`, runId: 'run-many', status: 'completed',
    results: Array.from({ length: 15 }, (_, resultIndex) => ({
      artifactId: `artifact-${taskIndex + 1}-${resultIndex + 1}`,
      verdict: 'pass', candidateStatus: 'reviewed',
      criteria: Array.from({ length: 10 }, (_, criterionIndex) => ({
        id: `criterion-${criterionIndex + 1}`, layer: 'visual', verdict: 'pass',
        evidence: '证'.repeat(1_000),
      })),
    })),
    decisions: Array.from({ length: 25 }, (_, decisionIndex) => ({
      artifactId: `artifact-${taskIndex + 1}-${decisionIndex + 1}`,
      decision: 'accepted', decidedAt: decisionIndex + 1,
    })),
  }))

  const result = await tools({ readReviews: async () => reviewTasks })
    .get('review_read').execute({ runId: 'run-many' })

  assert.equal(result.total, 10)
  assert.equal(result.tasks.length, 8)
  assert.ok(result.tasks.every((task) => task.results.length === 12))
  assert.ok(result.tasks.every((task) => task.results.every((entry) => entry.criteria.length === 8)))
  assert.ok(result.tasks.every((task) => task.decisions.length === 20))
  assert.ok(result.tasks.every((task) => task.results.every((entry) => (
    entry.criteria.every((criterion) => criterion.evidence.length === 300)
  ))))
  assert.deepEqual(result.omitted, {
    tasks: 2,
    results: 54,
    criteria: 732,
    decisions: 90,
  })
})

test('工作流运行逐项给出成败与错误码', async () => {
  const result = await tools().get('workflow_run_read').execute({ runId: 'wf-run-1' })
  assert.equal(result.run.status, 'partially_failed')
  assert.deepEqual(result.run.items.map((item) => item.status), ['succeeded', 'failed'])
  assert.equal(result.run.items[1].error.code, 'GENERATION_FAILED')
})

test('投放交付只给清单与状态', async () => {
  const result = await tools().get('delivery_read').execute({})
  assert.deepEqual(result.deliveries, [{
    id: 'delivery-1', name: '双十一首图', channel: 'tmall', status: 'draft', itemCount: 2, createdAt: 1, updatedAt: 2,
  }])
})

test('工具来源标签只认已声明的运维工具', () => {
  assert.deepEqual(
    botanicAgentOperationalSourceLabels([{ name: 'agent_run_read' }, { name: 'review_read' }, { name: 'web_search' }]),
    ['Agent 任务状态', '结果评审'],
  )
})

const executors = {
  retryBranch: async (args) => ({ retried: args }),
  cancelRun: async (args) => ({ cancelled: args }),
  promoteArtifact: async (args) => ({ promoted: args }),
  decideReview: async (args) => ({ decided: args }),
  retryReview: async (args) => ({ retryRequested: args }),
  publishWorkflow: async (args) => ({ published: args }),
  retryWorkflowFailed: async (args) => ({ retried: args }),
}

test('Viewer 看不到任何写工具，Editor 与 Owner 按权限看到全部七个', () => {
  // 不是「点了会失败」，而是根本看不到：模型看不到的工具不会被它拿去向用户承诺。
  assert.deepEqual(operationalActionToolsForRole('viewer'), [])
  assert.deepEqual(createBotanicAgentOperationalActionDefinitions({ role: 'viewer', ...executors }), [])
  assert.deepEqual(operationalActionToolsForRole('editor'), [...OPERATIONAL_ACTION_TOOLS])
  assert.deepEqual(operationalActionToolsForRole('owner'), [...OPERATIONAL_ACTION_TOOLS])
  assert.deepEqual(operationalActionToolsForRole(undefined), [])
})

test('写工具全部需要确认，并按真实代价声明风险', () => {
  const definitions = createBotanicAgentOperationalActionDefinitions({ role: 'editor', ...executors })
  assert.equal(definitions.length, 7)
  assert.ok(definitions.every((tool) => tool.requiresConfirmation === true))
  const byName = new Map(definitions.map((tool) => [tool.name, tool]))
  // 会调用 Provider 的两个声明 costly，其余是 write。
  assert.equal(byName.get('agent_branch_retry').risk, 'costly')
  assert.equal(byName.get('workflow_run_retry_failed').risk, 'costly')
  assert.equal(byName.get('review_retry').risk, 'costly')
  assert.equal(byName.get('agent_run_cancel').risk, 'write')
  assert.equal(byName.get('review_decide').risk, 'write')
})

test('缺执行器的写工具同样不暴露', () => {
  const definitions = createBotanicAgentOperationalActionDefinitions({ role: 'owner', cancelRun: executors.cancelRun })
  assert.deepEqual(definitions.map((tool) => tool.name), ['agent_run_cancel'])
})

test('评审标记与付费重试拆成两个权限和风险不同的工具', () => {
  const decide = createBotanicAgentOperationalActionDefinitions({ role: 'editor', ...executors })
    .find((tool) => tool.name === 'review_decide')
  assert.deepEqual(
    decide.validate({ taskId: 't1', artifactId: 'a1', decision: 'accepted', note: ' 很好 ' }),
    { taskId: 't1', artifactId: 'a1', decision: 'accepted', note: '很好' },
  )
  assert.throws(() => decide.validate({ taskId: 't1', artifactId: 'a1', decision: 'retry_requested' }), /接受或拒绝/u)
  const retry = createBotanicAgentOperationalActionDefinitions({ role: 'editor', ...executors })
    .find((tool) => tool.name === 'review_retry')
  assert.deepEqual(
    retry.validate({ taskId: 't1', artifactId: 'a1', note: ' 再来一张 ' }),
    { taskId: 't1', artifactId: 'a1', note: '再来一张' },
  )
})

test('分支重试与工作流发布的参数是显式标识，不让模型自由发挥', () => {
  const definitions = new Map(createBotanicAgentOperationalActionDefinitions({ role: 'owner', ...executors })
    .map((tool) => [tool.name, tool]))
  assert.deepEqual(definitions.get('agent_branch_retry').validate({ runId: 'run-1', branchId: 'branch-a' }), {
    runId: 'run-1', branchId: 'branch-a',
  })
  assert.throws(() => definitions.get('agent_branch_retry').validate({ runId: 'run-1' }), /分支标识/u)
  // 发布必须指名来源画布节点：不再猜「第一条可用节点」。
  assert.throws(() => definitions.get('workflow_publish').validate({ name: '首图流程' }), /来源画布节点/u)
})
