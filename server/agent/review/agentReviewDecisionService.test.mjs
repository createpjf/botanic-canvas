import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentReviewDecisionService } from './agentReviewDecisionService.mjs'
import { agentReviewRetryRunId } from './agentReviewRetryMaterialization.mjs'
import { agentReviewResultId } from './agentReviewTask.mjs'

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

test('普通人工决定读取权威任务并通过一次 Store commit 返回任务', async () => {
  const task = completedTask()
  const commands = []
  const decide = createAgentReviewDecisionService({
    productStore: {
      readAgentReviewTask: async () => structuredClone(task),
      commitAgentReviewHumanDecisions: async (_actorId, command) => {
        commands.push(structuredClone(command))
        return {
          kind: 'committed',
          task: { ...structuredClone(task), decisions: structuredClone(command.decisions) },
          retryRuns: [],
        }
      },
    },
    now: () => 200,
  })

  const outcome = await decide({
    actorId: 'project-editor',
    expectedProjectId: 'project-1',
    taskId: 'review-task-1',
    idempotencyKey: 'decision-command-1',
    entries: [{ artifactId, decision: 'accepted', note: '采用' }],
  })

  assert.equal(commands.length, 1)
  assert.equal(commands[0].id, 'review-task-1')
  assert.equal(commands[0].projectId, 'project-1')
  assert.equal(commands[0].decisions.length, 1)
  assert.equal(commands[0].decisions[0].decidedBy, 'project-editor')
  assert.equal(commands[0].decisions[0].decision, 'accepted')
  assert.deepEqual(commands[0].retryRunCandidates, [])
  assert.equal(outcome.task.decisions[0].decision, 'accepted')
  assert.equal(outcome.decisions[0].decision, 'accepted')
  assert.deepEqual(outcome.retryRuns, [])
})

function completedSourceRun() {
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

function sourceJob() {
  return {
    id: 'job-source',
    projectId: 'project-1',
    ownerId: 'run-owner',
    status: 'succeeded',
    agentRun: { runId: 'run-source', branchId: 'branch-source', attempt: 0 },
    outputs: [{ id: 'output-source' }],
  }
}

test('Editor 可为他人拥有的源 Run 请求重试，且 queued Run 绑定真实 branch/output', async () => {
  const task = completedTask()
  const sourceRun = completedSourceRun()
  const job = sourceJob()
  let committed
  const decide = createAgentReviewDecisionService({
    productStore: {
      readAgentReviewTask: async (actorId) => {
        assert.equal(actorId, 'project-editor')
        return structuredClone(task)
      },
      readAgentRunForWorker: async (runId) => {
        assert.equal(runId, 'run-source')
        return structuredClone(sourceRun)
      },
      readGenerationJobForWorker: async (jobId) => {
        assert.equal(jobId, 'job-source')
        return structuredClone(job)
      },
      commitAgentReviewHumanDecisions: async (actorId, command) => {
        assert.equal(actorId, 'project-editor')
        committed = structuredClone(command)
        return {
          kind: 'committed',
          task: { ...structuredClone(task), decisions: structuredClone(command.decisions) },
          retryRuns: command.retryRunCandidates.map((candidate) => structuredClone(candidate.run)),
        }
      },
    },
    now: () => 500,
  })

  const outcome = await decide({
    actorId: 'project-editor',
    expectedProjectId: 'project-1',
    taskId: 'review-task-1',
    idempotencyKey: 'decision-retry-1',
    entries: [{ artifactId, decision: 'retry_requested' }],
  })

  assert.equal(committed.retryRunCandidates.length, 1)
  const candidate = committed.retryRunCandidates[0]
  assert.equal(candidate.reviewResultId, agentReviewResultId('review-task-1', artifactId))
  assert.equal(candidate.artifactId, artifactId)
  assert.equal(candidate.sourceRunId, 'run-source')
  assert.equal(candidate.sourceBranchId, 'branch-source')
  assert.equal(candidate.sourceJobId, 'job-source')
  assert.equal(candidate.sourceOutputId, 'output-source')
  assert.equal(candidate.idempotencyBinding.scope, 'agent-review.retry')
  assert.equal(candidate.idempotencyBinding.projectId, 'project-1')
  assert.match(candidate.run.id, /^agent_run_review_retry_[A-Za-z0-9_-]{32}$/)
  assert.equal(candidate.run.id, agentReviewRetryRunId(task.id, candidate.reviewResultId))
  assert.equal(candidate.run.ownerId, 'project-editor')
  assert.equal(candidate.run.status, 'queued')
  assert.equal(candidate.run.lineage.parentRunId, 'run-source')
  assert.equal(candidate.run.lineage.parentBranchId, 'branch-source')
  assert.equal(candidate.run.lineage.reviewTaskId, 'review-task-1')
  assert.equal(candidate.run.lineage.sourceArtifactId, artifactId)
  assert.equal(candidate.run.branches[0].status, 'queued')
  assert.equal(outcome.retryRuns[0].id, candidate.run.id)
})

test('伪造为 undefined 的 Artifact/output identity 必须 fail-closed 且不提交决定', async () => {
  const forgedArtifactId = 'generation:job-source:undefined'
  const task = completedTask()
  task.coverage.artifactIds = [forgedArtifactId]
  task.results[0] = {
    ...task.results[0],
    id: agentReviewResultId(task.id, forgedArtifactId),
    artifactId: forgedArtifactId,
  }
  const job = { ...sourceJob(), outputs: [{ id: undefined }] }
  let commitCount = 0
  const decide = createAgentReviewDecisionService({
    productStore: {
      readAgentReviewTask: async () => structuredClone(task),
      readAgentRunForWorker: async () => completedSourceRun(),
      readGenerationJobForWorker: async () => job,
      commitAgentReviewHumanDecisions: async () => {
        commitCount += 1
        return { kind: 'committed', task, retryRuns: [] }
      },
    },
  })

  await assert.rejects(decide({
    actorId: 'project-editor',
    expectedProjectId: 'project-1',
    taskId: task.id,
    idempotencyKey: 'forged-output',
    entries: [{ artifactId: forgedArtifactId, decision: 'retry_requested' }],
  }), (caught) => (
    caught?.code === 'AGENT_REVIEW_RETRY_OUTPUT_INVALID'
    && caught?.statusCode === 409
  ))
  assert.equal(commitCount, 0)
})

test('同 key 重放或换新 key 都物化同一个 Run identity 与请求绑定', async () => {
  const task = completedTask()
  const commands = []
  let clock = 500
  const decide = createAgentReviewDecisionService({
    productStore: {
      readAgentReviewTask: async () => structuredClone(task),
      readAgentRunForWorker: async () => completedSourceRun(),
      readGenerationJobForWorker: async () => sourceJob(),
      commitAgentReviewHumanDecisions: async (_actorId, command) => {
        commands.push(structuredClone(command))
        return {
          kind: commands.length === 1 ? 'committed' : 'replay',
          task: { ...structuredClone(task), decisions: structuredClone(command.decisions) },
          retryRuns: command.retryRunCandidates.map((candidate) => structuredClone(candidate.run)),
        }
      },
    },
    now: () => (clock += 100),
  })
  const request = (idempotencyKey) => decide({
    actorId: 'project-editor',
    expectedProjectId: 'project-1',
    taskId: task.id,
    idempotencyKey,
    entries: [{ artifactId, decision: 'retry_requested' }],
  })

  const first = await request('retry-same-key')
  const replay = await request('retry-same-key')
  const newCommand = await request('retry-new-key')

  assert.equal(first.retryRuns[0].id, replay.retryRuns[0].id)
  assert.equal(first.retryRuns[0].id, newCommand.retryRuns[0].id)
  assert.deepEqual(commands[0].retryRunCandidates[0].run, commands[1].retryRunCandidates[0].run)
  assert.deepEqual(commands[0].retryRunCandidates[0].run, commands[2].retryRunCandidates[0].run)
  assert.deepEqual(
    commands[0].retryRunCandidates[0].idempotencyBinding,
    commands[2].retryRunCandidates[0].idempotencyBinding,
  )
  assert.equal(commands[0].decisions[0].id, commands[1].decisions[0].id)
  assert.notEqual(commands[0].decisions[0].id, commands[2].decisions[0].id)
})

test('批量多 Artifact 在一次原子 commit 中各自产生稳定 retry Run', async () => {
  const secondArtifactId = 'generation:job-source:output-second'
  const task = completedTask()
  task.coverage.artifactIds.push(secondArtifactId)
  task.results.push({
    ...task.results[0],
    id: agentReviewResultId(task.id, secondArtifactId),
    artifactId: secondArtifactId,
    createdAt: 110,
    updatedAt: 110,
  })
  const job = { ...sourceJob(), outputs: [{ id: 'output-source' }, { id: 'output-second' }] }
  let commitCount = 0
  let runReadCount = 0
  let jobReadCount = 0
  let committed
  const decide = createAgentReviewDecisionService({
    productStore: {
      readAgentReviewTask: async () => structuredClone(task),
      readAgentRunForWorker: async () => {
        runReadCount += 1
        return completedSourceRun()
      },
      readGenerationJobForWorker: async () => {
        jobReadCount += 1
        return structuredClone(job)
      },
      commitAgentReviewHumanDecisions: async (_actorId, command) => {
        commitCount += 1
        committed = structuredClone(command)
        return {
          kind: 'committed',
          task: { ...structuredClone(task), decisions: structuredClone(command.decisions) },
          retryRuns: command.retryRunCandidates.map((candidate) => structuredClone(candidate.run)),
        }
      },
    },
  })

  const outcome = await decide({
    actorId: 'project-editor',
    expectedProjectId: 'project-1',
    taskId: task.id,
    idempotencyKey: 'batch-retry',
    entries: [
      { artifactId, decision: 'retry_requested' },
      { artifactId: secondArtifactId, decision: 'retry_requested' },
    ],
  })

  assert.equal(commitCount, 1)
  assert.equal(runReadCount, 1)
  assert.equal(jobReadCount, 1)
  assert.equal(committed.decisions.length, 2)
  assert.ok(committed.decisions.every((decision) => decision.commandId === 'batch-retry'))
  assert.deepEqual(
    committed.retryRunCandidates.map((candidate) => candidate.artifactId),
    [artifactId, secondArtifactId],
  )
  assert.equal(new Set(committed.retryRunCandidates.map((candidate) => candidate.run.id)).size, 2)
  assert.equal(outcome.retryRuns.length, 2)
})

test('Store conflict/not_ready/permission 都转换为调用方可解释的失败', async (t) => {
  const cases = [
    {
      name: 'conflict',
      commit: async () => ({ kind: 'conflict' }),
      code: 'AGENT_REVIEW_DECISION_CONFLICT',
      statusCode: 409,
    },
    {
      name: 'not_ready',
      commit: async () => ({ kind: 'not_ready' }),
      code: 'AGENT_REVIEW_NOT_READY',
      statusCode: 409,
    },
    {
      name: 'permission',
      commit: async () => {
        const denied = new Error('项目角色没有编辑权限。')
        denied.code = 'PROJECT_WRITE_FORBIDDEN'
        throw denied
      },
      code: 'PROJECT_WRITE_FORBIDDEN',
      statusCode: 403,
    },
  ]
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const task = completedTask()
      const decide = createAgentReviewDecisionService({
        productStore: {
          readAgentReviewTask: async () => task,
          commitAgentReviewHumanDecisions: entry.commit,
        },
      })
      await assert.rejects(decide({
        actorId: 'project-editor',
        expectedProjectId: task.projectId,
        taskId: task.id,
        idempotencyKey: `store-${entry.name}`,
        entries: [{ artifactId, decision: 'accepted' }],
      }), (caught) => caught?.code === entry.code && caught?.statusCode === entry.statusCode)
    })
  }
})

test('Store 若声称提交成功却没有返回原子物化的 retry Run，服务 fail-closed', async () => {
  const task = completedTask()
  const decide = createAgentReviewDecisionService({
    productStore: {
      readAgentReviewTask: async () => task,
      readAgentRunForWorker: async () => completedSourceRun(),
      readGenerationJobForWorker: async () => sourceJob(),
      // 模拟尚未升级扩展事务的 legacy Store：它只提交了 decision，忽略 retry candidate。
      commitAgentReviewHumanDecisions: async () => ({ kind: 'committed', task }),
    },
  })

  await assert.rejects(decide({
    actorId: 'project-editor',
    expectedProjectId: task.projectId,
    taskId: task.id,
    idempotencyKey: 'legacy-store-must-not-look-successful',
    entries: [{ artifactId, decision: 'retry_requested' }],
  }), (caught) => (
    caught?.code === 'AGENT_REVIEW_RETRY_COMMIT_INVALID'
    && caught?.statusCode === 409
  ))
})
