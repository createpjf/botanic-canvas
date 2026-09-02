import assert from 'node:assert/strict'
import test from 'node:test'
import { agentReviewRetryMaterializationDecision } from './agentReviewRetryMaterialization.mjs'
import { agentReviewHumanDecisionCommitDecision } from './agentReviewExecution.mjs'
import { agentReviewResultId, createAgentHumanDecision } from './agentReviewTask.mjs'
import {
  agentRunSubmissionBinding,
  createPersistentAgentRun,
  createReviewRetryAgentRunInput,
  storedAgentRunSubmissionBinding,
  validateAgentRunCreation,
} from '../semantic/botanicAgentRun.mjs'
import { createIdempotencyRequestBinding } from '../../idempotencyRequestBinding.mjs'

const artifactId = 'generation:job-source:output-source'

function completedTask() {
  return {
    id: 'review-task-1',
    projectId: 'project-1',
    ownerId: 'run-owner',
    runId: 'run-source',
    status: 'completed',
    coverage: { artifactIds: [artifactId] },
    results: [{
      id: agentReviewResultId('review-task-1', artifactId),
      taskId: 'review-task-1',
      projectId: 'project-1',
      artifactId,
      candidateStatus: 'pending_human',
      createdAt: 100,
      updatedAt: 100,
    }],
    decisions: [],
    createdAt: 90,
    updatedAt: 100,
  }
}

function taskWithSecondResult() {
  const task = completedTask()
  const secondArtifactId = 'generation:job-source:output-second'
  task.coverage.artifactIds.push(secondArtifactId)
  task.results.push({
    ...task.results[0],
    id: agentReviewResultId(task.id, secondArtifactId),
    artifactId: secondArtifactId,
    createdAt: 110,
    updatedAt: 110,
  })
  return task
}

function humanDecision(task, input = {}) {
  return createAgentHumanDecision({
    taskId: task.id,
    projectId: task.projectId,
    artifactId: input.artifactId ?? artifactId,
    decision: input.decision ?? 'accepted',
    decidedBy: input.decidedBy ?? 'editor-a',
    idempotencyKey: input.idempotencyKey ?? 'decision-1',
    now: input.now ?? 200,
  })
}

function sourceRun() {
  return {
    id: 'run-source',
    projectId: 'project-1',
    ownerId: 'run-owner',
    status: 'completed',
    plan: {
      intent: 'replace_scene',
      instruction: '保持商品，替换背景。',
      summary: '替换背景',
      selectedResultNodeId: 'result-source',
      prompt: '把背景替换为海边。',
      settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
      constraints: [{ dimension: 'product', mode: 'preserve' }],
      output: { mode: 'single', count: 1, candidatesPerItem: 1 },
    },
    branches: [{
      id: 'branch-source', label: '海边', status: 'succeeded', attempt: 0,
      activeJobId: 'job-source', jobIds: ['job-source'], outputCount: 1, updatedAt: 80,
    }],
    createdAt: 50,
    updatedAt: 80,
  }
}

function retryCandidate(task, input = {}) {
  const result = task.results.find((entry) => entry.artifactId === (input.artifactId ?? artifactId))
  const retryInput = validateAgentRunCreation(createReviewRetryAgentRunInput(sourceRun(), {
    branchId: 'branch-source',
    reviewTaskId: task.id,
    artifactId: result.artifactId,
    now: result.createdAt,
  }))
  const run = createPersistentAgentRun(retryInput, {
    id: input.runId ?? 'agent_run_review_retry_TICkz92zmcIV3cABWbrqGS32gH1y2yT5',
    ownerId: input.ownerId ?? 'editor-a',
    now: result.createdAt,
    idempotencyBinding: agentRunSubmissionBinding(retryInput),
  })
  return {
    reviewResultId: result.id,
    artifactId: result.artifactId,
    sourceRunId: 'run-source',
    sourceBranchId: 'branch-source',
    sourceJobId: input.sourceJobId ?? 'job-source',
    sourceOutputId: input.sourceOutputId ?? 'output-source',
    idempotencyBinding: createIdempotencyRequestBinding({
      scope: input.scope ?? 'agent-review.retry',
      projectId: task.projectId,
      request: {
        taskId: task.id,
        reviewResultId: result.id,
        artifactId: result.artifactId,
        sourceRunId: 'run-source',
        sourceBranchId: 'branch-source',
        sourceJobId: input.sourceJobId ?? 'job-source',
        sourceOutputId: input.sourceOutputId ?? 'output-source',
      },
    }),
    run,
  }
}

function refreshRunBinding(run) {
  const immutable = structuredClone(run)
  delete immutable.idempotencyBinding
  run.idempotencyBinding = storedAgentRunSubmissionBinding(immutable)
}

test('普通 accept/reject 复用 HumanDecision 语义且不创建 Run', () => {
  const task = taskWithSecondResult()
  const original = structuredClone(task)
  const outcome = agentReviewRetryMaterializationDecision(task, {
    id: task.id,
    projectId: task.projectId,
    actorId: 'editor-a',
    observedAt: 300,
    decisions: [
      humanDecision(task),
      humanDecision(task, {
        artifactId: task.results[1].artifactId,
        decision: 'rejected',
        idempotencyKey: 'decision-2',
      }),
    ],
    retryRunCandidates: [],
  }, new Map())

  assert.equal(outcome.kind, 'committed')
  assert.equal(outcome.changed, true)
  assert.equal(outcome.task.results[0].candidateStatus, 'accepted')
  assert.equal(outcome.task.results[1].candidateStatus, 'rejected')
  assert.equal(outcome.task.results[0].retryMaterialization, undefined)
  assert.deepEqual(outcome.retryRuns, [])
  assert.deepEqual(outcome.runsToInsert, [])
  assert.deepEqual(task, original)
})

test('first writer 原子记录 retry materialization 并返回待插入 queued Run', () => {
  const task = completedTask()
  const decision = humanDecision(task, { decision: 'retry_requested' })
  const candidate = retryCandidate(task)
  const outcome = agentReviewRetryMaterializationDecision(task, {
    id: task.id,
    projectId: task.projectId,
    actorId: 'editor-a',
    observedAt: 300,
    decisions: [decision],
    retryRunCandidates: [candidate],
  }, new Map())

  assert.equal(outcome.kind, 'committed')
  assert.equal(outcome.changed, true)
  assert.equal(outcome.task.results[0].candidateStatus, 'pending_review')
  assert.deepEqual(outcome.task.results[0].retryMaterialization, {
    requestBinding: candidate.idempotencyBinding,
    runId: candidate.run.id,
    runOwnerId: 'editor-a',
    requestedBy: 'editor-a',
    createdAt: 300,
  })
  assert.deepEqual(outcome.retryRuns, [candidate.run])
  assert.deepEqual(outcome.runsToInsert, [candidate.run])
  assert.equal(outcome.runsToInsert[0].status, 'queued')
})

test('批量 retry 一次返回全部 materialization 与待插入 Runs', () => {
  const task = taskWithSecondResult()
  const secondArtifactId = task.results[1].artifactId
  const candidates = [
    retryCandidate(task),
    retryCandidate(task, {
      artifactId: secondArtifactId,
      sourceOutputId: 'output-second',
      runId: 'agent_run_review_retry_YZq3FYKTyBuK4LYSh2N4fpWa20oDu__N',
    }),
  ]
  const outcome = agentReviewRetryMaterializationDecision(task, {
    id: task.id,
    projectId: task.projectId,
    actorId: 'editor-a',
    observedAt: 300,
    decisions: [
      humanDecision(task, { decision: 'retry_requested' }),
      humanDecision(task, {
        artifactId: secondArtifactId,
        decision: 'retry_requested',
        idempotencyKey: 'decision-2',
      }),
    ],
    retryRunCandidates: candidates,
  }, new Map())

  assert.equal(outcome.kind, 'committed')
  assert.equal(outcome.changed, true)
  assert.deepEqual(outcome.retryRuns.map((run) => run.id), candidates.map((candidate) => candidate.run.id))
  assert.deepEqual(outcome.runsToInsert.map((run) => run.id), candidates.map((candidate) => candidate.run.id))
  assert.ok(outcome.task.results.every((result) => result.retryMaterialization?.runId))
})

test('跨 Editor 用新 key 重放同一结果时保留 first-writer Run owner', () => {
  const initialTask = completedTask()
  const firstCandidate = retryCandidate(initialTask)
  const first = agentReviewRetryMaterializationDecision(initialTask, {
    id: initialTask.id,
    projectId: initialTask.projectId,
    actorId: 'editor-a',
    observedAt: 300,
    decisions: [humanDecision(initialTask, { decision: 'retry_requested' })],
    retryRunCandidates: [firstCandidate],
  }, new Map())
  const firstMaterialization = structuredClone(first.task.results[0].retryMaterialization)
  const replayCandidate = retryCandidate(first.task, { ownerId: 'editor-b' })
  const progressedRun = structuredClone(firstCandidate.run)
  progressedRun.status = 'running'
  progressedRun.updatedAt = 450
  progressedRun.branches[0] = {
    ...progressedRun.branches[0],
    status: 'running',
    activeJobId: 'job-retry',
    jobIds: ['job-retry'],
    updatedAt: 450,
  }

  const replay = agentReviewRetryMaterializationDecision(first.task, {
    id: first.task.id,
    projectId: first.task.projectId,
    actorId: 'editor-b',
    observedAt: 500,
    decisions: [humanDecision(first.task, {
      decision: 'retry_requested',
      decidedBy: 'editor-b',
      idempotencyKey: 'decision-editor-b',
      now: 400,
    })],
    retryRunCandidates: [replayCandidate],
  }, new Map([[firstCandidate.run.id, progressedRun]]))

  assert.equal(replay.kind, 'committed')
  assert.equal(replay.changed, true)
  assert.equal(replay.task.decisions.length, 2)
  assert.deepEqual(replay.task.results[0].retryMaterialization, firstMaterialization)
  assert.deepEqual(replay.runsToInsert, [])
  assert.equal(replay.retryRuns[0].id, firstCandidate.run.id)
  assert.equal(replay.retryRuns[0].ownerId, 'editor-a')
  assert.equal(replay.retryRuns[0].status, 'running')
})

test('同 key 重放不改 Task、不插入第二个 Run', () => {
  const initialTask = completedTask()
  const candidate = retryCandidate(initialTask)
  const command = {
    id: initialTask.id,
    projectId: initialTask.projectId,
    actorId: 'editor-a',
    observedAt: 300,
    decisions: [humanDecision(initialTask, { decision: 'retry_requested' })],
    retryRunCandidates: [candidate],
  }
  const first = agentReviewRetryMaterializationDecision(initialTask, command, new Map())
  const replay = agentReviewRetryMaterializationDecision(first.task, {
    ...command,
    observedAt: 600,
    decisions: [humanDecision(first.task, { decision: 'retry_requested', now: 500 })],
  }, new Map([[candidate.run.id, candidate.run]]))

  assert.equal(replay.kind, 'replay')
  assert.equal(replay.changed, false)
  assert.deepEqual(replay.task, first.task)
  assert.deepEqual(replay.runsToInsert, [])
  assert.deepEqual(replay.retryRuns, [candidate.run])
})

test('retry Run ID 不等于 (taskId, reviewResultId) 稳定身份时整批 conflict', () => {
  const task = completedTask()
  const candidate = retryCandidate(task, { runId: 'agent_run_review_retry_forged' })
  const outcome = agentReviewRetryMaterializationDecision(task, {
    id: task.id,
    projectId: task.projectId,
    actorId: 'editor-a',
    observedAt: 300,
    decisions: [humanDecision(task, { decision: 'retry_requested' })],
    retryRunCandidates: [candidate],
  }, new Map())

  assert.equal(outcome.kind, 'conflict')
  assert.equal(outcome.changed, false)
  assert.deepEqual(outcome.task, task)
  assert.deepEqual(outcome.retryRuns, [])
  assert.deepEqual(outcome.runsToInsert, [])
})

test('candidate source 字段与 materialization binding 漂移时 conflict', () => {
  const task = completedTask()
  const candidate = retryCandidate(task)
  candidate.sourceOutputId = 'output-forged'
  const outcome = agentReviewRetryMaterializationDecision(task, {
    id: task.id,
    projectId: task.projectId,
    actorId: 'editor-a',
    observedAt: 300,
    decisions: [humanDecision(task, { decision: 'retry_requested' })],
    retryRunCandidates: [candidate],
  }, new Map())

  assert.equal(outcome.kind, 'conflict')
  assert.equal(outcome.changed, false)
  assert.deepEqual(outcome.task, task)
  assert.deepEqual(outcome.runsToInsert, [])
})

test('binding 即使自洽，Artifact 不是对应 source Job/output 也必须 conflict', () => {
  const task = completedTask()
  const candidate = retryCandidate(task, { sourceOutputId: 'output-forged' })
  const outcome = agentReviewRetryMaterializationDecision(task, {
    id: task.id,
    projectId: task.projectId,
    actorId: 'editor-a',
    observedAt: 300,
    decisions: [humanDecision(task, { decision: 'retry_requested' })],
    retryRunCandidates: [candidate],
  }, new Map())

  assert.equal(outcome.kind, 'conflict')
  assert.equal(outcome.changed, false)
  assert.deepEqual(outcome.task, task)
  assert.deepEqual(outcome.runsToInsert, [])
})

test('历史 retry decision 缺少 materialization 时 legacy_unknown，绝不补建付费 Run', () => {
  const task = completedTask()
  const legacyDecision = humanDecision(task, { decision: 'retry_requested' })
  const legacy = agentReviewHumanDecisionCommitDecision(task, {
    id: task.id,
    projectId: task.projectId,
    actorId: 'editor-a',
    observedAt: 300,
    decisions: [legacyDecision],
  })
  assert.equal(legacy.task.results[0].retryMaterialization, undefined)

  const outcome = agentReviewRetryMaterializationDecision(legacy.task, {
    id: task.id,
    projectId: task.projectId,
    actorId: 'editor-a',
    observedAt: 500,
    decisions: [humanDecision(legacy.task, { decision: 'retry_requested', now: 400 })],
    retryRunCandidates: [retryCandidate(legacy.task)],
  }, new Map())

  assert.equal(outcome.kind, 'legacy_unknown')
  assert.equal(outcome.changed, false)
  assert.deepEqual(outcome.task, legacy.task)
  assert.deepEqual(outcome.retryRuns, [])
  assert.deepEqual(outcome.runsToInsert, [])
})

test('批量中任一 existing Run 请求身份漂移则全批不改 Task、也不插入前序 Run', () => {
  const task = taskWithSecondResult()
  const secondArtifactId = task.results[1].artifactId
  const firstCandidate = retryCandidate(task)
  const secondCandidate = retryCandidate(task, {
    artifactId: secondArtifactId,
    sourceOutputId: 'output-second',
    runId: 'agent_run_review_retry_YZq3FYKTyBuK4LYSh2N4fpWa20oDu__N',
  })
  const driftedExistingRun = structuredClone(secondCandidate.run)
  driftedExistingRun.plan.prompt = '已漂移的请求主体'

  const outcome = agentReviewRetryMaterializationDecision(task, {
    id: task.id,
    projectId: task.projectId,
    actorId: 'editor-a',
    observedAt: 300,
    decisions: [
      humanDecision(task, { decision: 'retry_requested' }),
      humanDecision(task, {
        artifactId: secondArtifactId,
        decision: 'retry_requested',
        idempotencyKey: 'decision-2',
      }),
    ],
    retryRunCandidates: [firstCandidate, secondCandidate],
  }, new Map([[secondCandidate.run.id, driftedExistingRun]]))

  assert.equal(outcome.kind, 'conflict')
  assert.equal(outcome.changed, false)
  assert.deepEqual(outcome.task, task)
  assert.deepEqual(outcome.retryRuns, [])
  assert.deepEqual(outcome.runsToInsert, [])
})

test('已记录 retryMaterialization 被改绑时 conflict', () => {
  const task = completedTask()
  const candidate = retryCandidate(task)
  const first = agentReviewRetryMaterializationDecision(task, {
    id: task.id,
    projectId: task.projectId,
    actorId: 'editor-a',
    observedAt: 300,
    decisions: [humanDecision(task, { decision: 'retry_requested' })],
    retryRunCandidates: [candidate],
  }, new Map())
  const driftedTask = structuredClone(first.task)
  driftedTask.results[0].retryMaterialization.requestBinding.requestHash = 'forged-request-binding'

  const outcome = agentReviewRetryMaterializationDecision(driftedTask, {
    id: task.id,
    projectId: task.projectId,
    actorId: 'editor-a',
    observedAt: 500,
    decisions: [humanDecision(driftedTask, { decision: 'retry_requested', now: 400 })],
    retryRunCandidates: [candidate],
  }, new Map([[candidate.run.id, candidate.run]]))

  assert.equal(outcome.kind, 'conflict')
  assert.equal(outcome.changed, false)
  assert.deepEqual(outcome.task, driftedTask)
  assert.deepEqual(outcome.retryRuns, [])
  assert.deepEqual(outcome.runsToInsert, [])
})

test('首次 queued candidate 的时间与 execution identity 漂移时不得插入', () => {
  const task = completedTask()
  const mutations = [
    (run) => { run.createdAt += 1 },
    (run) => { run.updatedAt += 1 },
    (run) => { run.lineage.createdAt += 1 },
    (run) => { run.branches[0].updatedAt += 1 },
    (run) => { run.executionVersion = 1 },
    (run) => { run.execution = { generation: 1, leaseToken: 'forged-lease' } },
    (run) => { run.jobId = 'forged-job' },
  ]
  for (const mutate of mutations) {
    const candidate = retryCandidate(task)
    mutate(candidate.run)
    const outcome = agentReviewRetryMaterializationDecision(task, {
      id: task.id,
      projectId: task.projectId,
      actorId: 'editor-a',
      observedAt: 300,
      decisions: [humanDecision(task, { decision: 'retry_requested' })],
      retryRunCandidates: [candidate],
    }, new Map())
    assert.equal(outcome.kind, 'conflict')
    assert.equal(outcome.changed, false)
    assert.deepEqual(outcome.task, task)
    assert.deepEqual(outcome.runsToInsert, [])
  }
})

test('retryMaterialization 的 first-writer actor/时间漂移时 conflict', () => {
  const task = completedTask()
  const candidate = retryCandidate(task)
  const firstDecision = humanDecision(task, { decision: 'retry_requested' })
  const first = agentReviewRetryMaterializationDecision(task, {
    id: task.id,
    projectId: task.projectId,
    actorId: 'editor-a',
    observedAt: 300,
    decisions: [firstDecision],
    retryRunCandidates: [candidate],
  }, new Map())
  const mutations = [
    (materialization) => { materialization.requestedBy = 'forged-editor' },
    (materialization) => { materialization.createdAt += 1 },
  ]
  for (const mutate of mutations) {
    const driftedTask = structuredClone(first.task)
    mutate(driftedTask.results[0].retryMaterialization)
    const outcome = agentReviewRetryMaterializationDecision(driftedTask, {
      id: task.id,
      projectId: task.projectId,
      actorId: 'editor-a',
      observedAt: 500,
      decisions: [humanDecision(driftedTask, { decision: 'retry_requested', now: 400 })],
      retryRunCandidates: [candidate],
    }, new Map([[candidate.run.id, candidate.run]]))

    assert.equal(outcome.kind, 'conflict')
    assert.equal(outcome.changed, false)
    assert.deepEqual(outcome.task, driftedTask)
    assert.deepEqual(outcome.runsToInsert, [])
  }
})

test('自洽 binding 也不能把单 Artifact retry 扩成多分支或多输出', () => {
  const task = completedTask()
  const mutations = [
    (run) => {
      run.branches.push({ ...structuredClone(run.branches[0]), id: 'retry-extra-branch' })
    },
    (run) => {
      run.plan.output = { mode: 'single', count: 2, candidatesPerItem: 1 }
    },
  ]
  for (const mutate of mutations) {
    const candidate = retryCandidate(task)
    mutate(candidate.run)
    refreshRunBinding(candidate.run)
    const outcome = agentReviewRetryMaterializationDecision(task, {
      id: task.id,
      projectId: task.projectId,
      actorId: 'editor-a',
      observedAt: 300,
      decisions: [humanDecision(task, { decision: 'retry_requested' })],
      retryRunCandidates: [candidate],
    }, new Map())

    assert.equal(outcome.kind, 'conflict')
    assert.equal(outcome.changed, false)
    assert.deepEqual(outcome.runsToInsert, [])
  }
})
