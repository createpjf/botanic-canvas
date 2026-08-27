import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAgentReviewDecisionService } from './agentReviewDecisionService.mjs'
import { agentReviewPreparedCheckpoint } from './agentReviewExecution.mjs'
import { agentReviewRetryRunId } from './agentReviewRetryMaterialization.mjs'
import { agentReviewResultId } from './agentReviewTask.mjs'
import { createProductStore } from './productStore.mjs'
import { productStoreCoreMethods } from './productStoreContract.mjs'

const reviewExecutionMethods = [
  'claimAgentReviewExecution',
  'commitAgentReviewExecution',
  'commitAgentReviewHumanDecisions',
]

function harness({ artifactIds = ['generation:job-1:output-1'] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'botanic-review-execution-'))
  const store = createProductStore({
    dataPath: join(directory, 'product.json'),
    bootstrapAccessToken: 'review-execution-owner',
  })
  const owner = store.authenticate('review-execution-owner')
  const projectId = 'project-review-execution'
  store.writeProject(owner.id, {
    schemaVersion: 25,
    id: projectId,
    name: 'Review execution',
    nodes: [], edges: [], assets: [], assetGroups: [], generationJobs: [], agentRuns: [],
    updatedAt: 1,
  })
  const task = {
    id: 'review-task-execution',
    ownerId: owner.id,
    projectId,
    runId: 'run-review-execution',
    status: 'queued',
    attempt: 0,
    qualityPolicyFingerprint: 'quality-v1',
    coverage: { artifactIds },
    results: [],
    createdAt: 1,
    updatedAt: 1,
  }
  store.putAgentReviewTask(owner.id, task)
  return { directory, store, owner, task }
}

function completeReview(store, owner, task) {
  const claim = store.claimAgentReviewExecution(owner.id, {
    id: task.id,
    projectId: task.projectId,
    leaseToken: 'review-lease-complete',
    leaseDurationMs: 30_000,
  })
  for (const [index, artifactId] of task.coverage.artifactIds.entries()) {
    store.commitAgentReviewExecution(owner.id, {
      id: task.id,
      projectId: task.projectId,
      leaseToken: 'review-lease-complete',
      executionGeneration: claim.task.execution.generation,
      status: 'running',
      checkpoint: agentReviewPreparedCheckpoint({ artifactId, preparedAt: Date.now() + index }),
    })
    store.commitAgentReviewExecution(owner.id, {
      id: task.id,
      projectId: task.projectId,
      leaseToken: 'review-lease-complete',
      executionGeneration: claim.task.execution.generation,
      status: 'running',
      result: {
        id: agentReviewResultId(task.id, artifactId),
        taskId: task.id,
        projectId: task.projectId,
        artifactId,
        verdict: 'pass',
        candidateStatus: 'pending_human',
        createdAt: 100 + index,
        updatedAt: 100 + index,
      },
      checkpoint: null,
    })
  }
  return store.commitAgentReviewExecution(owner.id, {
    id: task.id,
    projectId: task.projectId,
    leaseToken: 'review-lease-complete',
    executionGeneration: claim.task.execution.generation,
    status: 'completed',
  }).task
}

function createProjectMember(store, owner, task, role, suffix) {
  const accessToken = `review-${role}-${suffix}`
  const member = store.createUser(owner.id, {
    email: `${role}-${suffix}@example.com`,
    name: `${role}-${suffix}`,
    accessToken,
  })
  store.addProjectMember(owner.id, task.projectId, member.id, role)
  return member
}

function persistRetrySource(store, owner, task) {
  const sourceRun = {
    id: task.runId,
    projectId: task.projectId,
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
      id: 'branch-source',
      label: '海边',
      status: 'succeeded',
      attempt: 0,
      activeJobId: 'job-1',
      jobIds: ['job-1'],
      outputCount: task.coverage.artifactIds.length,
      updatedAt: 80,
    }],
    completedBranchCount: 1,
    failedBranchCount: 0,
    createdAt: 50,
    updatedAt: 80,
  }
  store.putAgentRun(owner.id, sourceRun)
  store.putGenerationJob(owner.id, {
    id: 'job-1',
    projectId: task.projectId,
    status: 'succeeded',
    agentRun: { runId: sourceRun.id, branchId: 'branch-source', attempt: 0 },
    outputs: task.coverage.artifactIds.map((artifactId) => ({
      id: artifactId.slice('generation:job-1:'.length),
    })),
    createdAt: 60,
    updatedAt: 80,
  }, { updateAgentRun: false, recordAudit: false })
}

function reviewDecisionService(store) {
  return createAgentReviewDecisionService({ productStore: store, now: () => 500 })
}

async function captureRetryCommand(store, actorId, task, idempotencyKey, entries) {
  let captured
  const decide = createAgentReviewDecisionService({
    productStore: {
      readAgentReviewTask: (...args) => store.readAgentReviewTask(...args),
      readAgentRunForWorker: (...args) => store.readAgentRunForWorker(...args),
      readGenerationJobForWorker: (...args) => store.readGenerationJobForWorker(...args),
      commitAgentReviewHumanDecisions: async (_actorId, command) => {
        captured = structuredClone(command)
        const existing = store.readAgentReviewTask(actorId, task.id)
        return {
          kind: 'committed',
          task: { ...existing, decisions: structuredClone(command.decisions) },
          retryRuns: command.retryRunCandidates.map((candidate) => structuredClone(candidate.run)),
        }
      },
    },
    now: () => 500,
  })
  await decide({
    actorId,
    expectedProjectId: task.projectId,
    taskId: task.id,
    idempotencyKey,
    entries,
  })
  return captured
}

function postgresMethodSource(source, methodName, nextMethodName) {
  const start = source.indexOf(`async ${methodName}(`)
  const end = source.indexOf(`\n    async ${nextMethodName}(`, start)
  assert.ok(start >= 0, `${methodName} 缺失`)
  assert.ok(end > start, `${methodName} 边界缺失`)
  return source.slice(start, end)
}

test('ProductStore 核心契约显式要求 Review execution 与 human decision 原子方法', () => {
  for (const method of reviewExecutionMethods) {
    assert.equal(productStoreCoreMethods.includes(method), true, method)
  }
})

test('Local Review Adapter：并发 claim 单胜者，且不信任调用方 observedAt', () => {
  const { directory, store, owner, task } = harness()
  try {
    const first = store.claimAgentReviewExecution(owner.id, {
      id: task.id,
      projectId: task.projectId,
      leaseToken: 'review-lease-a',
      leaseDurationMs: 30_000,
      observedAt: 1,
      allowTakeover: true,
    })
    const second = store.claimAgentReviewExecution(owner.id, {
      id: task.id,
      projectId: task.projectId,
      leaseToken: 'review-lease-b',
      leaseDurationMs: 30_000,
      // 若 Adapter 误信这个未来时间，就会错误接管仍活着的租约。
      observedAt: Date.now() + 60_000,
      allowTakeover: true,
    })
    assert.equal(first.kind, 'claimed')
    assert.equal(second.kind, 'in_progress')
    assert.equal(second.task.execution.leaseToken, 'review-lease-a')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Local Review Adapter：prepared 先落盘，结果同 CAS 清 checkpoint，响应丢失可重放', () => {
  const { directory, store, owner, task } = harness()
  try {
    const claim = store.claimAgentReviewExecution(owner.id, {
      id: task.id,
      projectId: task.projectId,
      leaseToken: 'review-lease-a',
      leaseDurationMs: 30_000,
    })
    const checkpoint = agentReviewPreparedCheckpoint({
      artifactId: task.coverage.artifactIds[0],
      preparedAt: Date.now(),
    })
    const prepared = store.commitAgentReviewExecution(owner.id, {
      id: task.id,
      projectId: task.projectId,
      leaseToken: 'review-lease-a',
      executionGeneration: claim.task.execution.generation,
      status: 'running',
      checkpoint,
    })
    assert.equal(prepared.kind, 'committed')
    assert.deepEqual(prepared.task.execution.checkpoint, checkpoint)

    const result = {
      id: 'review-result-1',
      taskId: task.id,
      projectId: task.projectId,
      artifactId: checkpoint.artifactId,
      criteria: [{ id: 'identity', verdict: 'pass' }],
      verdict: 'pass',
    }
    const committed = store.commitAgentReviewExecution(owner.id, {
      id: task.id,
      projectId: task.projectId,
      leaseToken: 'review-lease-a',
      executionGeneration: claim.task.execution.generation,
      status: 'running',
      result,
      checkpoint: null,
    })
    assert.equal(committed.kind, 'committed')
    assert.equal(committed.task.execution.checkpoint, undefined)
    assert.deepEqual(committed.task.results, [result])

    const replay = store.commitAgentReviewExecution(owner.id, {
      id: task.id,
      projectId: task.projectId,
      leaseToken: 'review-lease-a',
      executionGeneration: claim.task.execution.generation,
      status: 'running',
      result: {
        verdict: 'pass',
        criteria: [{ verdict: 'pass', id: 'identity' }],
        artifactId: checkpoint.artifactId,
        projectId: task.projectId,
        taskId: task.id,
        id: 'review-result-1',
      },
      checkpoint: null,
    })
    assert.notEqual(replay.kind, 'conflict')
    assert.equal(replay.task.results.length, 1)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('普通 put 不能铸造/擦除 Review lease、prepared 或 result', () => {
  const { directory, store, owner, task } = harness()
  try {
    const forged = store.putAgentReviewTask(owner.id, {
      ...task,
      status: 'running',
      executionVersion: 99,
      execution: { generation: 99, leaseToken: 'forged', leaseExpiresAt: Number.MAX_SAFE_INTEGER },
    })
    assert.equal(forged.status, 'queued')
    assert.equal(forged.execution, undefined)
    assert.equal(forged.executionVersion, undefined)

    const claim = store.claimAgentReviewExecution(owner.id, {
      id: task.id,
      projectId: task.projectId,
      leaseToken: 'review-lease-real',
      leaseDurationMs: 30_000,
    })
    const checkpoint = agentReviewPreparedCheckpoint({
      artifactId: task.coverage.artifactIds[0],
      preparedAt: Date.now(),
    })
    const prepared = store.commitAgentReviewExecution(owner.id, {
      id: task.id,
      projectId: task.projectId,
      leaseToken: 'review-lease-real',
      executionGeneration: claim.task.execution.generation,
      status: 'running',
      checkpoint,
    })

    const stale = store.putAgentReviewTask(owner.id, {
      ...task,
      status: 'completed',
      results: [{ id: 'forged-result', artifactId: checkpoint.artifactId }],
      execution: undefined,
    })
    assert.equal(stale.status, 'running')
    assert.deepEqual(stale.execution, prepared.task.execution)
    assert.deepEqual(stale.results, [])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Local Review Adapter：人工决定原子合并，重放保留首次时间，identity 漂移 fail-closed', () => {
  const { directory, store, owner, task } = harness()
  try {
    completeReview(store, owner, task)
    const decision = {
      id: 'human-decision-1',
      taskId: task.id,
      projectId: task.projectId,
      artifactId: task.coverage.artifactIds[0],
      decision: 'accepted',
      candidateStatus: 'accepted',
      decidedBy: owner.id,
      idempotencyKey: 'human-command-1',
      note: '确认可交付',
      decidedAt: 4_000,
    }
    const first = store.commitAgentReviewHumanDecisions(owner.id, {
      id: task.id, projectId: task.projectId, decisions: [decision],
    })
    assert.equal(first.kind, 'committed')
    assert.equal(first.task.results[0].humanDecisionId, decision.id)
    assert.equal(first.task.results[0].candidateStatus, 'accepted')
    const authoritativeDecidedAt = first.task.decisions[0].decidedAt
    assert.equal(first.task.decisions[0].decisionRevision, 1)
    assert.notEqual(authoritativeDecidedAt, decision.decidedAt)

    const replay = store.commitAgentReviewHumanDecisions(owner.id, {
      id: task.id, projectId: task.projectId,
      decisions: [{ ...decision, decidedAt: 99_999 }],
    })
    assert.equal(replay.kind, 'replay')
    assert.equal(replay.task.decisions[0].decidedAt, authoritativeDecidedAt)

    for (const changed of [
      { decision: 'rejected', candidateStatus: 'rejected' },
      { artifactId: 'generation:job-other:output-other' },
      { note: '篡改说明' },
      { decidedBy: 'other-user' },
    ]) {
      const conflict = store.commitAgentReviewHumanDecisions(owner.id, {
        id: task.id, projectId: task.projectId,
        decisions: [{ ...decision, ...changed, decidedAt: 100_000 }],
      })
      assert.equal(conflict.kind, 'conflict')
      assert.equal(conflict.task.decisions[0].decidedAt, authoritativeDecidedAt)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Local Review Adapter：不同 Artifact 的并发人工决定不会 read-then-put 丢写', async () => {
  const artifactIds = ['generation:job-1:output-1', 'generation:job-1:output-2']
  const { directory, store, owner, task } = harness({ artifactIds })
  try {
    completeReview(store, owner, task)
    const command = (artifactId, index) => ({
      id: task.id,
      projectId: task.projectId,
      decisions: [{
        id: `human-decision-${index}`,
        taskId: task.id,
        projectId: task.projectId,
        artifactId,
        decision: 'accepted',
        candidateStatus: 'accepted',
        decidedBy: owner.id,
        idempotencyKey: `human-command-${index}`,
        decidedAt: 5_000 + index,
      }],
    })
    await Promise.all(artifactIds.map((artifactId, index) => Promise.resolve().then(() => (
      store.commitAgentReviewHumanDecisions(owner.id, command(artifactId, index))
    ))))
    const stored = store.readAgentReviewTask(owner.id, task.id)
    assert.deepEqual(new Set(stored.decisions.map((item) => item.artifactId)), new Set(artifactIds))
    assert.ok(stored.results.every((result) => result.candidateStatus === 'accepted'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Local Review Adapter：retry decision 与 queued Run 在同一次提交中持久化', async () => {
  const { directory, store, owner, task } = harness()
  try {
    completeReview(store, owner, task)
    persistRetrySource(store, owner, task)
    const editor = createProjectMember(store, owner, task, 'editor', 'retry-once')

    const outcome = await reviewDecisionService(store)({
      actorId: editor.id,
      expectedProjectId: task.projectId,
      taskId: task.id,
      idempotencyKey: 'retry-once',
      entries: [{ artifactId: task.coverage.artifactIds[0], decision: 'retry_requested' }],
    })

    assert.equal(outcome.retryRuns.length, 1)
    const retryRun = store.readAgentRunForWorker(outcome.retryRuns[0].id)
    assert.equal(retryRun.ownerId, editor.id)
    assert.equal(retryRun.status, 'queued')
    const storedTask = store.readAgentReviewTask(editor.id, task.id)
    assert.equal(storedTask.results[0].retryMaterialization.runId, retryRun.id)
    assert.equal(storedTask.results[0].retryMaterialization.runOwnerId, editor.id)
    const reloaded = createProductStore({
      dataPath: join(directory, 'product.json'),
      bootstrapAccessToken: 'review-execution-owner',
    })
    assert.equal(reloaded.readAgentRunForWorker(retryRun.id).ownerId, editor.id)
    assert.equal(
      reloaded.readAgentReviewTask(editor.id, task.id).results[0].retryMaterialization.runId,
      retryRun.id,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Local Review Adapter：批量 retry 全部提交，任一 candidate 冲突则 Task/Run 零写', async (t) => {
  const artifactIds = ['generation:job-1:output-1', 'generation:job-1:output-2']
  await t.test('批量成功', async () => {
    const { directory, store, owner, task } = harness({ artifactIds })
    try {
      completeReview(store, owner, task)
      persistRetrySource(store, owner, task)
      const editor = createProjectMember(store, owner, task, 'editor', 'batch-ok')
      const outcome = await reviewDecisionService(store)({
        actorId: editor.id,
        expectedProjectId: task.projectId,
        taskId: task.id,
        idempotencyKey: 'retry-batch-ok',
        entries: artifactIds.map((artifactId) => ({ artifactId, decision: 'retry_requested' })),
      })

      assert.equal(outcome.retryRuns.length, 2)
      assert.equal(new Set(outcome.retryRuns.map((run) => run.id)).size, 2)
      assert.ok(outcome.retryRuns.every((run) => store.readAgentRunForWorker(run.id)?.status === 'queued'))
      const stored = store.readAgentReviewTask(editor.id, task.id)
      assert.equal(stored.results.filter((result) => result.retryMaterialization).length, 2)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  await t.test('第二个 candidate 冲突时整体回滚', async () => {
    const { directory, store, owner, task } = harness({ artifactIds })
    try {
      completeReview(store, owner, task)
      persistRetrySource(store, owner, task)
      const editor = createProjectMember(store, owner, task, 'editor', 'batch-conflict')
      const command = await captureRetryCommand(
        store,
        editor.id,
        task,
        'retry-batch-conflict',
        artifactIds.map((artifactId) => ({ artifactId, decision: 'retry_requested' })),
      )
      command.retryRunCandidates[1].run.plan.prompt = '篡改后不再匹配 durable binding'
      const before = readFileSync(join(directory, 'product.json'), 'utf8')

      const outcome = store.commitAgentReviewHumanDecisions(editor.id, command)

      assert.equal(outcome.kind, 'conflict')
      assert.equal(outcome.changed, false)
      assert.equal(readFileSync(join(directory, 'product.json'), 'utf8'), before)
      assert.equal(store.readAgentReviewTask(editor.id, task.id).decisions?.length ?? 0, 0)
      for (const candidate of command.retryRunCandidates) {
        assert.equal(store.readAgentRunForWorker(candidate.run.id), undefined)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

test('Local Review Adapter：retry 重放保留首次 Run owner，跨 Editor 新决定不重复建 Run', async () => {
  const { directory, store, owner, task } = harness()
  try {
    completeReview(store, owner, task)
    persistRetrySource(store, owner, task)
    const firstEditor = createProjectMember(store, owner, task, 'editor', 'first-owner')
    const secondEditor = createProjectMember(store, owner, task, 'editor', 'second-owner')
    const request = (actorId, idempotencyKey) => reviewDecisionService(store)({
      actorId,
      expectedProjectId: task.projectId,
      taskId: task.id,
      idempotencyKey,
      entries: [{ artifactId: task.coverage.artifactIds[0], decision: 'retry_requested' }],
    })

    const first = await request(firstEditor.id, 'retry-first-owner')
    const replay = await request(firstEditor.id, 'retry-first-owner')
    const crossEditor = await request(secondEditor.id, 'retry-second-editor')

    assert.equal(first.retryRuns[0].id, replay.retryRuns[0].id)
    assert.equal(first.retryRuns[0].id, crossEditor.retryRuns[0].id)
    assert.equal(crossEditor.retryRuns[0].ownerId, firstEditor.id)
    const storedRun = store.readAgentRunForWorker(first.retryRuns[0].id)
    assert.equal(storedRun.ownerId, firstEditor.id)
    const storedTask = store.readAgentReviewTask(secondEditor.id, task.id)
    assert.equal(storedTask.decisions.length, 2)
    assert.equal(storedTask.results[0].retryMaterialization.runOwnerId, firstEditor.id)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Local Review Adapter：普通 accept 仅需 edit；viewer retry 被拒且无写入', async () => {
  const { directory, store, owner, task } = harness()
  try {
    completeReview(store, owner, task)
    persistRetrySource(store, owner, task)
    const editor = createProjectMember(store, owner, task, 'editor', 'accept')
    const viewer = createProjectMember(store, owner, task, 'viewer', 'retry-denied')
    const accepted = await reviewDecisionService(store)({
      actorId: editor.id,
      expectedProjectId: task.projectId,
      taskId: task.id,
      idempotencyKey: 'accept-with-edit',
      entries: [{ artifactId: task.coverage.artifactIds[0], decision: 'accepted' }],
    })
    assert.deepEqual(accepted.retryRuns, [])
    const before = readFileSync(join(directory, 'product.json'), 'utf8')
    const retryRunId = agentReviewRetryRunId(task.id, agentReviewResultId(
      task.id,
      task.coverage.artifactIds[0],
    ))

    await assert.rejects(reviewDecisionService(store)({
      actorId: viewer.id,
      expectedProjectId: task.projectId,
      taskId: task.id,
      idempotencyKey: 'viewer-retry-denied',
      entries: [{ artifactId: task.coverage.artifactIds[0], decision: 'retry_requested' }],
    }), (caught) => caught?.code === 'PROJECT_WRITE_FORBIDDEN' && caught?.statusCode === 403)

    assert.equal(readFileSync(join(directory, 'product.json'), 'utf8'), before)
    assert.equal(store.readAgentRunForWorker(retryRunId), undefined)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Local Review Adapter：missing/not_ready 不改变持久化状态', () => {
  const { directory, store, owner, task } = harness()
  try {
    const before = readFileSync(join(directory, 'product.json'), 'utf8')
    const missing = store.commitAgentReviewHumanDecisions(owner.id, {
      id: 'missing-review-task',
      projectId: task.projectId,
      decisions: [],
    })
    const notReady = store.commitAgentReviewHumanDecisions(owner.id, {
      id: task.id,
      projectId: task.projectId,
      decisions: [{ decision: 'accepted' }],
    })

    assert.equal(missing.kind, 'missing')
    assert.equal(notReady.kind, 'not_ready')
    assert.equal(readFileSync(join(directory, 'product.json'), 'utf8'), before)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Local Review Adapter：legacy retry decision 缺 materialization 时不补建 Run、也不写 Task', async () => {
  const { directory, store, owner, task } = harness()
  try {
    completeReview(store, owner, task)
    persistRetrySource(store, owner, task)
    const editor = createProjectMember(store, owner, task, 'editor', 'legacy-unknown')
    const command = await captureRetryCommand(
      store,
      editor.id,
      task,
      'legacy-retry',
      [{ artifactId: task.coverage.artifactIds[0], decision: 'retry_requested' }],
    )
    const dataPath = join(directory, 'product.json')
    const legacyState = JSON.parse(readFileSync(dataPath, 'utf8'))
    const legacyTask = legacyState.agentReviewTasks.find((entry) => entry.id === task.id)
    const legacyDecision = {
      ...command.decisions[0],
      decisionRevision: 1,
      decidedAt: 600,
    }
    legacyTask.decisions = [legacyDecision]
    legacyTask.decisionVersion = 1
    legacyTask.updatedAt = 600
    legacyTask.results[0] = {
      ...legacyTask.results[0],
      candidateStatus: 'pending_review',
      humanDecisionId: legacyDecision.id,
      updatedAt: 600,
    }
    writeFileSync(dataPath, JSON.stringify(legacyState, null, 2))
    const legacyStore = createProductStore({
      dataPath,
      bootstrapAccessToken: 'review-execution-owner',
    })
    const before = readFileSync(dataPath, 'utf8')

    const outcome = legacyStore.commitAgentReviewHumanDecisions(editor.id, command)

    assert.equal(outcome.kind, 'legacy_unknown')
    assert.equal(outcome.changed, false)
    assert.equal(readFileSync(dataPath, 'utf8'), before)
    assert.equal(legacyStore.readAgentRunForWorker(command.retryRunCandidates[0].run.id), undefined)
    assert.equal(legacyStore.readAgentReviewTask(editor.id, task.id).decisions.length, 1)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('PostgreSQL Review retry：在有界方法内锁 Task/Run，并按稳定 ID 原子插入后更新 Task', () => {
  const postgres = readFileSync(new URL('./postgresProductStore.mjs', import.meta.url), 'utf8')
  const method = postgresMethodSource(
    postgres,
    'commitAgentReviewHumanDecisions',
    'readAgentReviewTask',
  )

  assert.match(method, /sql\.begin/u)
  assert.match(method, /hashtextextended\(\$\{command\?\.id \?\? ''\}, 5\)/u)
  assert.match(method, /agent_review_tasks[\s\S]*for update/u)
  assert.match(method, /'edit'[\s\S]*'create-generation'/u)
  assert.match(method, /candidateRunIds[\s\S]*\.sort\(\)/u)
  assert.match(method, /hashtextextended\(\$\{runId\}, 0\)/u)
  assert.match(method, /agent_runs where id = \$\{runId\} for update/u)
  assert.match(method, /agentReviewRetryMaterializationDecision/u)
  assert.match(method, /if \(decision\.changed\)/u)
  assert.match(method, /insert into agent_runs/u)
  assert.match(method, /persistAgentReviewExecutionDecision/u)
  assert.ok(method.indexOf('insert into agent_runs') < method.indexOf('persistAgentReviewExecutionDecision'))
  assert.match(method, /retryRuns/u)
  assert.doesNotMatch(method, /putAgentRun/u)
})

test('PostgreSQL/Supabase Adapter 与迁移暴露同一 Review fence，SQL 使用 DB clock 与行锁', () => {
  const postgres = readFileSync(new URL('./postgresProductStore.mjs', import.meta.url), 'utf8')
  const supabase = readFileSync(new URL('./supabaseProductStore.mjs', import.meta.url), 'utf8')
  const migration = readFileSync(new URL(
    '../supabase/migrations/20260828140000_agent_review_execution.sql',
    import.meta.url,
  ), 'utf8')

  for (const method of reviewExecutionMethods) {
    assert.match(postgres, new RegExp(`async ${method}\\(`), method)
    assert.match(supabase, new RegExp(`async ${method}\\(`), method)
  }
  for (const rpc of [
    'botanic_put_agent_review_task_guarded',
    'botanic_claim_agent_review_execution',
    'botanic_commit_agent_review_execution',
    'botanic_commit_agent_review_human_decisions',
  ]) {
    assert.match(migration, new RegExp(`create or replace function public\\.${rpc}\\(`), rpc)
    assert.match(supabase, new RegExp(`'${rpc}'`), rpc)
  }
  assert.match(postgres, /claimAgentReviewExecution[\s\S]*for update[\s\S]*clock_timestamp/u)
  assert.match(postgres, /commitAgentReviewExecution[\s\S]*for update[\s\S]*clock_timestamp/u)
  assert.match(migration, /clock_timestamp\(\)/u)
  assert.match(migration, /for update/u)
  assert.match(migration, /AGENT_REVIEW_OUTCOME_UNKNOWN/u)
  assert.match(migration, /lease_token/u)
  assert.match(migration, /execution_version/u)
  assert.match(migration, /existing_decision/u)
  assert.match(migration, /humanDecisionId/u)

  const humanRpcStart = migration.indexOf(
    'create or replace function public.botanic_commit_agent_review_human_decisions',
  )
  const humanRpcEnd = migration.indexOf(
    '\nrevoke all on function public.botanic_valid_agent_review_checkpoint',
    humanRpcStart,
  )
  const humanRpc = migration.slice(humanRpcStart, humanRpcEnd)
  assert.match(humanRpc, /for update[\s\S]*clock_timestamp\(\)/u)
  assert.match(humanRpc, /decision_version := decision_version \+ 1/u)
  assert.match(humanRpc, /requested_decision - 'decidedAt'/u)
  assert.match(humanRpc, /existing_decision - 'decidedAt'/u)
  assert.match(humanRpc, /results_payload := stored_payload->'results'/u)
  assert.doesNotMatch(humanRpc, /p_command->'results'/u)
})
