import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AgentReviewError,
  CANDIDATE_STATUSES,
  HUMAN_DECISIONS,
  REVIEW_COVERAGE_STRATEGIES,
  REVIEW_TASK_STATUSES,
  agentReviewTaskCompletion,
  createAgentHumanDecision,
  createAgentReviewResult,
  createAgentReviewTask,
  memoryProposalFromRejection,
  planReviewCoverage,
  publicAgentReviewTask,
  reviewTaskIdFor,
  settleAgentReviewTask,
} from './agentReviewTask.mjs'

const qualityPolicy = { version: 1, requiredCriteria: ['identity', 'composition'], humanDecisionRequired: true }
const candidates = [
  { artifactId: 'generation:job-a:out-1', branchId: 'branch-a' },
  { artifactId: 'generation:job-a:out-2', branchId: 'branch-a' },
  { artifactId: 'generation:job-b:out-1', branchId: 'branch-b' },
]

const taskOf = (coverage) => createAgentReviewTask({
  runId: 'run-1', projectId: 'project-1', ownerId: 'user-1', qualityPolicy,
  planFingerprint: 'plan-fp', coverage, now: 100,
})

test('评审判据必须来自计划快照的质量策略', () => {
  // Review 自带硬编码 rubric 的话，「结果符合用户确认的约束」无法被证明。
  assert.throws(
    () => createAgentReviewTask({ runId: 'run-1', projectId: 'project-1', ownerId: 'user-1', qualityPolicy: undefined }),
    (error) => error instanceof AgentReviewError && error.code === 'AGENT_REVIEW_POLICY_MISSING',
  )
  assert.throws(
    () => createAgentReviewTask({ runId: 'run-1', projectId: 'project-1', ownerId: 'user-1', qualityPolicy: { requiredCriteria: [] } }),
    (error) => error.code === 'AGENT_REVIEW_POLICY_MISSING',
  )
  const task = taskOf(planReviewCoverage({ candidates }))
  assert.ok(task.qualityPolicyFingerprint)
  assert.deepEqual(task.qualityPolicy.requiredCriteria, ['identity', 'composition'])
  assert.equal(task.planFingerprint, 'plan-fp')
  assert.equal(task.status, 'queued')
})

test('同一 Run 同一质量策略只有一个评审任务', () => {
  assert.equal(taskOf(planReviewCoverage({ candidates })).id, taskOf(planReviewCoverage({ candidates })).id)
  assert.notEqual(reviewTaskIdFor('run-1', 'fp-a'), reviewTaskIdFor('run-1', 'fp-b'))
  assert.notEqual(reviewTaskIdFor('run-1', 'fp-a'), reviewTaskIdFor('run-2', 'fp-a'))
})

test('评审公共读模型不泄露 ownerId 与 Worker execution lease', () => {
  const task = {
    ...taskOf(planReviewCoverage({ candidates })),
    status: 'cancelled',
    execution: { generation: 2, leaseToken: 'worker-secret', leaseExpiresAt: 999 },
    cancel: {
      signalId: 'cancel-secret', idempotencyKey: 'cancel-key', requestedBy: 'user-secret',
      requestedAt: 200, releaseBasis: 'worker_exit', executionGeneration: 2,
    },
    reconciliation: {
      version: 1,
      retryCount: 1,
      resolutions: [{
        idempotencyKey: 'reconcile-key', actorId: 'user-secret', action: 'retry_once', resolvedAt: 180,
        prior: { executionGeneration: 1, results: [{ id: 'private-prior' }] },
        risk: { code: 'AGENT_REVIEW_RETRY_MAY_DUPLICATE_PROVIDER_CALL', message: '内部风险明细' },
      }],
    },
    results: [{
      id: 'result-1', taskId: 'task-1', projectId: 'project-1', artifactId: 'artifact-1',
      resolution: { kind: 'human_resolution', action: 'continue_unverifiable', resolvedBy: 'user-secret', resolvedAt: 180 },
    }],
  }
  const publicTask = publicAgentReviewTask(task)
  assert.equal(publicTask.ownerId, undefined)
  assert.equal(publicTask.execution, undefined)
  assert.deepEqual(publicTask.cancel, { status: 'cancelled', requestedAt: 200, releaseBasis: 'worker_exit' })
  assert.deepEqual(publicTask.reconciliation, {
    version: 1,
    retryCount: 1,
    resolutions: [{
      action: 'retry_once', resolvedAt: 180,
      risk: { code: 'AGENT_REVIEW_RETRY_MAY_DUPLICATE_PROVIDER_CALL' },
    }],
  })
  assert.equal(publicTask.results[0].resolution.resolvedBy, undefined)
})

test('默认覆盖每个候选，抽样与上限都必须显式声明', () => {
  const all = planReviewCoverage({ candidates })
  assert.equal(all.strategy, 'all')
  assert.equal(all.reviewedCandidates, 3)
  assert.equal(all.skippedCandidates, 0)

  // 「每分支只评第一张」是历史行为，保留为显式可选项而不是隐式默认。
  const perBranch = planReviewCoverage({ candidates, strategy: 'per_branch_first' })
  assert.deepEqual(perBranch.artifactIds, ['generation:job-a:out-1', 'generation:job-b:out-1'])
  assert.equal(perBranch.skippedCandidates, 1)

  const capped = planReviewCoverage({ candidates, strategy: 'capped', limit: 2 })
  assert.equal(capped.limit, 2)
  assert.equal(capped.reviewedCandidates, 2)
  // 被跳过的数量必须出现在读模型里，否则截断看起来像「全评过了」。
  assert.equal(capped.skippedCandidates, 1)

  assert.throws(() => planReviewCoverage({ candidates, strategy: 'sample_randomly' }), /未声明的评审覆盖策略/u)
  assert.deepEqual([...REVIEW_COVERAGE_STRATEGIES], ['all', 'per_branch_first', 'capped'])
})

test('每个候选都产出结论后任务才能完成', () => {
  const task = taskOf(planReviewCoverage({ candidates }))
  const result = (artifactId) => createAgentReviewResult({
    taskId: task.id, projectId: task.projectId, artifactId,
    criteria: [{ id: 'aspect_ratio', layer: 'deterministic', verdict: 'pass' }],
  })
  const partial = agentReviewTaskCompletion(task, [result('generation:job-a:out-1')])
  assert.equal(partial.complete, false)
  assert.deepEqual(partial.missing, ['generation:job-a:out-2', 'generation:job-b:out-1'])

  const full = agentReviewTaskCompletion(task, task.coverage.artifactIds.map(result))
  assert.equal(full.complete, true)
  assert.deepEqual(full.missing, [])
})

test('别的任务的结论不能顶替本任务的覆盖', () => {
  const task = taskOf(planReviewCoverage({ candidates: [candidates[0]] }))
  const foreign = createAgentReviewResult({
    taskId: 'review_task_other', projectId: task.projectId, artifactId: candidates[0].artifactId,
    criteria: [{ id: 'aspect_ratio', verdict: 'pass' }],
  })
  assert.equal(agentReviewTaskCompletion(task, [foreign]).complete, false)
})

test('结论按判据收敛，无法验证不折叠成通过', () => {
  const base = { taskId: 'task-1', projectId: 'project-1', artifactId: 'artifact-1' }
  assert.equal(createAgentReviewResult({ ...base, criteria: [{ id: 'a', verdict: 'pass' }] }).verdict, 'pass')
  assert.equal(createAgentReviewResult({ ...base, criteria: [{ id: 'a', verdict: 'pass' }, { id: 'b', verdict: 'unverifiable' }] }).verdict, 'unverifiable')
  assert.equal(createAgentReviewResult({ ...base, criteria: [{ id: 'a', verdict: 'unverifiable' }, { id: 'b', verdict: 'fail' }] }).verdict, 'fail')
})

test('自动结论一律停在待人工，不代替人工批准也不替用户否掉', () => {
  const base = { taskId: 'task-1', projectId: 'project-1', artifactId: 'artifact-1' }
  assert.equal(createAgentReviewResult({ ...base, criteria: [{ id: 'a', verdict: 'pass' }] }).candidateStatus, 'pending_human')
  assert.equal(createAgentReviewResult({ ...base, criteria: [{ id: 'a', verdict: 'fail' }] }).candidateStatus, 'pending_human')
  assert.ok(CANDIDATE_STATUSES.includes('pending_human'))
})

test('评审失败必须可诊断，不接受空错误', () => {
  const task = taskOf(planReviewCoverage({ candidates }))
  assert.throws(() => settleAgentReviewTask(task, { status: 'failed' }), /可诊断的错误码/u)
  const failed = settleAgentReviewTask(task, { status: 'failed', error: { code: 'REVIEW_MODEL_UNAVAILABLE', message: '视觉模型不可用。' } })
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error.code, 'REVIEW_MODEL_UNAVAILABLE')
  const cancelled = settleAgentReviewTask(failed, { status: 'cancelled' })
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.error, undefined)
  // 进入 running 时累加尝试次数，重试可被观察。
  assert.equal(settleAgentReviewTask(task, { status: 'running' }).attempt, 1)
  assert.deepEqual([...REVIEW_TASK_STATUSES], ['queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled'])
})

test('人工决定逐候选幂等，批量共享 commandId 也各自落库', () => {
  const shared = { taskId: 'task-1', projectId: 'project-1', decidedBy: 'user-1', decision: 'accepted', commandId: 'batch-1' }
  const first = createAgentHumanDecision({ ...shared, artifactId: 'artifact-1', idempotencyKey: 'key-1' })
  const repeat = createAgentHumanDecision({ ...shared, artifactId: 'artifact-1', idempotencyKey: 'key-1' })
  const sibling = createAgentHumanDecision({ ...shared, artifactId: 'artifact-2', idempotencyKey: 'key-1' })
  assert.equal(first.id, repeat.id)
  assert.notEqual(first.id, sibling.id)
  assert.equal(first.commandId, sibling.commandId)
  assert.equal(first.candidateStatus, 'accepted')
  assert.throws(() => createAgentHumanDecision({ ...shared, artifactId: 'artifact-1', decision: 'maybe', idempotencyKey: 'key-1' }), /未声明的人工决定/u)
  assert.deepEqual([...HUMAN_DECISIONS], ['accepted', 'rejected', 'retry_requested'])
})

test('请求重试让候选回到待评审，不标记为拒绝', () => {
  const retry = createAgentHumanDecision({
    taskId: 'task-1', projectId: 'project-1', artifactId: 'artifact-1',
    decision: 'retry_requested', decidedBy: 'user-1', idempotencyKey: 'key-retry',
  })
  assert.equal(retry.candidateStatus, 'pending_review')
})

test('拒绝可以产出记忆建议，但只是 proposed', () => {
  const rejected = createAgentHumanDecision({
    taskId: 'task-1', projectId: 'project-1', artifactId: 'artifact-1',
    decision: 'rejected', note: '背景饱和度过高', decidedBy: 'user-1', idempotencyKey: 'key-reject',
  })
  const proposal = memoryProposalFromRejection(rejected)
  assert.equal(proposal.status, 'proposed')
  assert.equal(proposal.source, 'review')
  assert.equal(proposal.content, '背景饱和度过高')
  assert.deepEqual(proposal.evidence, [{ kind: 'review', ref: rejected.id }])
  // 没有理由就没有建议：凭空造一条规则比不造更糟。
  assert.equal(memoryProposalFromRejection({ ...rejected, note: undefined }), undefined)
  assert.equal(memoryProposalFromRejection({ ...rejected, decision: 'accepted' }), undefined)
})
