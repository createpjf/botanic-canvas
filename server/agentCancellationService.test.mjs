import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AgentDelegationFenceError,
  assertTurnAllowsDelegation,
  createAgentCancellationService,
} from './agentCancellationService.mjs'
import {
  acknowledgedGenerationJobCancellation,
  requestedGenerationJobCancellation,
} from './generation/generationJobExecution.mjs'

function branch(id, status, activeJobId) {
  return {
    id,
    status,
    attempt: 0,
    jobIds: activeJobId ? [activeJobId] : [],
    ...(activeJobId ? { activeJobId } : {}),
    outputCount: 0,
    updatedAt: 10,
  }
}

function harness(input = {}) {
  const order = []
  const turns = new Map((input.turns ?? [{ id: 'turn-1', ownerId: 'user-1', projectId: 'project-1', status: 'running' }])
    .map((turn) => [turn.id, structuredClone(turn)]))
  const runs = new Map((input.runs ?? []).map((run) => [run.id, structuredClone(run)]))
  const jobs = new Map((input.jobs ?? []).map((job) => [job.id, structuredClone(job)]))
  const subagents = new Map((input.subagents ?? []).map((subagent) => [subagent.id, structuredClone(subagent)]))
  const cancelEvents = []
  const runUpdates = []
  const jobUpdates = []
  let storeNow = Number(input.storeNow) || 30

  const pageAfterId = (items, afterId, limit) => {
    const sorted = items.sort((left, right) => left.id.localeCompare(right.id))
    const cursorIndex = afterId ? sorted.findIndex((item) => item.id === afterId) : -1
    return sorted.slice(cursorIndex + 1, cursorIndex + 1 + limit)
  }

  const productStore = {
    async readAgentTurn(userId, turnId) {
      const turn = turns.get(turnId)
      return turn?.ownerId === userId ? structuredClone(turn) : undefined
    },
    async listAgentRunsForTurnPage(userId, projectId, turnId, { afterId, limit = 50 } = {}) {
      order.push('list-runs')
      if (Object.hasOwn(input, 'failRunPageAfterId') && input.failRunPageAfterId === afterId) {
        throw new Error('run page unavailable')
      }
      const candidates = [...runs.values()]
        .filter((run) => run.ownerId === userId && run.projectId === projectId && run.turnId === turnId)
      return pageAfterId(candidates, afterId, limit)
        .map((run) => structuredClone(run))
    },
    async listAgentSubagentsForRootTurnPage(userId, projectId, rootTurnId, { afterId, limit = 50 } = {}) {
      order.push('list-subagents')
      if (Object.hasOwn(input, 'failSubagentPageAfterId') && input.failSubagentPageAfterId === afterId) {
        throw new Error('subagent page unavailable')
      }
      const candidates = [...subagents.values()]
        .filter((subagent) => subagent.projectId === projectId && subagent.rootTurnId === rootTurnId)
      return pageAfterId(candidates, afterId, limit)
        .map((subagent) => structuredClone(subagent))
    },
    async listGenerationJobsForAgentRunPage(userId, projectId, runId, { afterId, limit = 50 } = {}) {
      if (input.failJobPageRunIds?.includes(runId)) throw new Error('job page unavailable')
      const candidates = [...jobs.values()]
        .filter((job) => job.ownerId === userId
          && job.projectId === projectId
          && job.agentRun?.runId === runId)
      return pageAfterId(candidates, afterId, limit)
        .map((job) => structuredClone(job))
    },
    async readAgentRun(userId, runId) {
      const run = runs.get(runId)
      return run?.ownerId === userId ? structuredClone(run) : undefined
    },
    async putAgentRun(userId, run) {
      assert.equal(run.ownerId, userId)
      runs.set(run.id, structuredClone(run))
      return structuredClone(run)
    },
    async readGenerationJob(userId, jobId) {
      if (input.failedJobReads?.includes(jobId)) throw new Error(`sensitive provider failure for ${jobId}`)
      const job = jobs.get(jobId)
      return job?.ownerId === userId ? structuredClone(job) : undefined
    },
    async putGenerationJob(userId, job) {
      assert.equal(job.ownerId, userId)
      jobs.set(job.id, structuredClone(job))
      return structuredClone(job)
    },
    async cancelGenerationJobExecution(userId, command) {
      const current = jobs.get(command.id)
      if (!current || current.ownerId !== userId || current.projectId !== command.projectId) {
        return { kind: 'missing', changed: false }
      }
      const decision = requestedGenerationJobCancellation(current, {
        ...command,
        observedAt: storeNow,
      })
      if (decision.changed) jobs.set(command.id, structuredClone(decision.job))
      return structuredClone(decision)
    },
    async acknowledgeGenerationJobCancellation(userId, command) {
      const current = jobs.get(command.id)
      if (!current || current.ownerId !== userId || current.projectId !== command.projectId) {
        return { kind: 'missing', changed: false }
      }
      const decision = acknowledgedGenerationJobCancellation(current, {
        ...command,
        observedAt: storeNow,
      })
      if (decision.changed) jobs.set(command.id, structuredClone(decision.job))
      return structuredClone(decision)
    },
  }

  const cancelTurn = async ({ userId, projectId, turnId }) => {
    order.push('cancel-turn')
    const turn = turns.get(turnId)
    if (!turn || turn.ownerId !== userId || turn.projectId !== projectId) return undefined
    if (!['failed', 'cancelled'].includes(turn.status)) {
      Object.assign(turn, { status: 'cancelling', updatedAt: 20 })
    }
    return structuredClone(turn)
  }
  const finalizeTurn = input.finalizeTurn === true
    ? async ({ turnId }) => {
        order.push('finalize-turn')
        const turn = turns.get(turnId)
        Object.assign(turn, { status: 'cancelled', updatedAt: 31 })
        return structuredClone(turn)
      }
    : input.finalizeTurn

  const service = createAgentCancellationService({
    productStore,
    cancelTurn,
    finalizeTurn,
    cancelSubagent: input.cancelSubagent ?? (async (command) => {
      order.push(`cancel-subagent:${command.subagentId}`)
      if (input.failedSubagentCancellations?.includes(command.subagentId)) {
        throw new Error(`sensitive subagent failure for ${command.subagentId}`)
      }
      const current = subagents.get(command.subagentId)
      if (!current || current.projectId !== command.projectId) {
        return { kind: 'missing', changed: false }
      }
      if (input.pendingSubagentCancellations?.includes(command.subagentId)) {
        Object.assign(current, { status: 'cancelling', updatedAt: 30 })
        return { kind: 'not_ready', changed: true, subagent: structuredClone(current) }
      }
      const changed = current.status !== 'cancelled'
      Object.assign(current, { status: 'cancelled', updatedAt: 30 })
      return {
        kind: changed ? 'finalized' : 'replay',
        changed,
        subagent: structuredClone(current),
      }
    }),
    redisQueue: { cancel: async (id) => order.push(`dequeue:${id}`) },
    publishCancel: async (event) => {
      if (input.publishFailures?.has(`${event.scope}:${event.id}`)) throw new Error('取消信号暂时无法发布')
      cancelEvents.push(structuredClone(event))
      order.push(`cancel-event:${event.scope}:${event.id}`)
      if (event.scope === 'job' && event.signalId && input.autoAcknowledge !== false) {
        const current = jobs.get(event.id)
        const decision = acknowledgedGenerationJobCancellation(current, {
          id: current.id,
          projectId: current.projectId,
          signalId: event.signalId,
          executionGeneration: current.execution.generation,
          leaseToken: current.execution.leaseToken,
          releaseBasis: 'worker_exit',
          observedAt: storeNow,
        })
        if (decision.changed) jobs.set(event.id, structuredClone(decision.job))
      }
    },
    publishGenerationJobUpdated: async (event) => jobUpdates.push(structuredClone(event)),
    publishAgentRunUpdated: async (event) => runUpdates.push(structuredClone(event)),
    now: () => 30,
  })

  return {
    service, productStore, turns, runs, jobs, subagents, order, cancelEvents, runUpdates, jobUpdates,
    setStoreNow(value) { storeNow = Number(value) },
  }
}

function subagent(id, rootTurnId, status = 'active') {
  return {
    id,
    projectId: 'project-1',
    rootTurnId,
    status,
    createdAt: 1,
    updatedAt: 10,
  }
}

function run(id, turnId, branches) {
  return {
    id,
    ownerId: 'user-1',
    projectId: 'project-1',
    turnId,
    status: 'running',
    plan: { id: `plan-${id}`, summary: 'safe test plan' },
    branches,
    createdAt: 1,
    updatedAt: 10,
  }
}

function job(id, status, runId, branchId) {
  return {
    id,
    ownerId: 'user-1',
    projectId: 'project-1',
    status,
    settings: { model: 'gpt-image-1' },
    agentRun: { runId, branchId },
    createdAt: 1,
    updatedAt: 10,
    ...(status === 'running' ? {
      executionVersion: 1,
      execution: {
        generation: 1,
        leaseToken: `lease-${id}`,
        leaseDurationMs: 90,
        leaseExpiresAt: 100,
      },
    } : {}),
  }
}

test('running Job 未有 durable release ack 时阻止 Turn finalize，Worker ack 后重复取消才收口', async () => {
  let finalizeCalls = 0
  const state = harness({
    autoAcknowledge: false,
    runs: [run('run-ack', 'turn-1', [branch('branch-ack', 'running', 'job-ack')])],
    jobs: [job('job-ack', 'running', 'run-ack', 'branch-ack')],
    finalizeTurn: async ({ turnId }) => {
      finalizeCalls += 1
      const turn = state.turns.get(turnId)
      Object.assign(turn, { status: 'cancelled', updatedAt: 40 })
      return structuredClone(turn)
    },
  })

  const pending = await state.service.cancelAgentTurn({
    userId: 'user-1', projectId: 'project-1', turnId: 'turn-1',
  })
  assert.equal(finalizeCalls, 0)
  assert.equal(pending.kind, 'cancelling')
  assert.deepEqual(pending.failures, [
    { scope: 'job', id: 'job-ack', code: 'GENERATION_JOB_CANCEL_ACK_PENDING' },
  ])
  const cancelled = state.jobs.get('job-ack')
  assert.equal(cancelled.cancel.workerReleased, false)

  await state.productStore.acknowledgeGenerationJobCancellation('user-1', {
    id: cancelled.id,
    projectId: cancelled.projectId,
    signalId: cancelled.cancel.signalId,
    executionGeneration: 1,
    leaseToken: cancelled.execution.leaseToken,
    releaseBasis: 'worker_exit',
  })
  const finalized = await state.service.cancelAgentTurn({
    userId: 'user-1', projectId: 'project-1', turnId: 'turn-1',
  })
  assert.equal(finalizeCalls, 1)
  assert.equal(finalized.kind, 'cancelled')
})

test('Worker crash 无 ack 时仅 DB clock 证明原 generation lease 过期后收口', async () => {
  const state = harness({
    autoAcknowledge: false,
    storeNow: 30,
    finalizeTurn: true,
    runs: [run('run-expiry', 'turn-1', [branch('branch-expiry', 'running', 'job-expiry')])],
    jobs: [job('job-expiry', 'running', 'run-expiry', 'branch-expiry')],
  })

  const pending = await state.service.cancelAgentTurn({
    userId: 'user-1', projectId: 'project-1', turnId: 'turn-1',
  })
  assert.equal(pending.kind, 'cancelling')
  assert.equal(state.jobs.get('job-expiry').cancel.signalAcknowledgedAt, undefined)

  state.setStoreNow(100)
  const finalized = await state.service.cancelAgentTurn({
    userId: 'user-1', projectId: 'project-1', turnId: 'turn-1',
  })
  assert.equal(finalized.kind, 'cancelled')
  assert.equal(state.jobs.get('job-expiry').cancel.releaseBasis, 'lease_expired')
})

test('Turn 先持久化 cancelling，再反查并取消多个关联 Run 与活动 Job', async () => {
  const firstRun = run('run-1', 'turn-1', [branch('b1', 'queued', 'job-1'), branch('b2', 'running', 'job-2')])
  const secondRun = run('run-2', 'turn-1', [branch('b3', 'queued', 'job-3')])
  const state = harness({
    turns: [{ id: 'turn-1', ownerId: 'user-1', projectId: 'project-1', status: 'completed' }],
    finalizeTurn: true,
    runs: [firstRun, secondRun, run('unlinked', 'turn-other', [branch('b4', 'queued', 'job-4')])],
    jobs: [
      job('job-1', 'queued', 'run-1', 'b1'),
      job('job-2', 'running', 'run-1', 'b2'),
      job('job-3', 'queued', 'run-2', 'b3'),
      job('job-4', 'queued', 'unlinked', 'b4'),
    ],
  })

  const result = await state.service.cancelAgentTurn({
    userId: 'user-1', projectId: 'project-1', turnId: 'turn-1', requestedBy: 'user-1',
  })

  assert.deepEqual(state.order.slice(0, 3), ['cancel-turn', 'cancel-event:turn:turn-1', 'list-runs'])
  assert.equal(result.kind, 'cancelled', 'completed Turn 仍须进入深取消以撤销已授权的下游任务')
  assert.equal(state.turns.get('turn-1').status, 'cancelled')
  assert.equal(state.runs.get('run-1').status, 'cancelled')
  assert.equal(state.runs.get('run-2').status, 'cancelled')
  assert.equal(state.runs.get('unlinked').status, 'running')
  assert.equal(state.jobs.get('job-1').status, 'cancelled')
  assert.equal(state.jobs.get('job-2').status, 'cancelled')
  assert.equal(state.jobs.get('job-3').status, 'cancelled')
  assert.equal(state.jobs.get('job-4').status, 'queued')
  assert.deepEqual(result, {
    kind: 'cancelled',
    turnId: 'turn-1',
    status: 'cancelled',
    linkedRunCount: 2,
    linkedSubagentCount: 0,
    cancelledRunCount: 2,
    cancelledJobCount: 3,
    cancelledSubagentCount: 0,
    failures: [],
  })
  assert.deepEqual(state.runUpdates.map((event) => event.runId).sort(), ['run-1', 'run-2'])
  assert.deepEqual(state.jobUpdates.map((event) => Object.keys(event).sort()), [
    ['jobId', 'projectId', 'runId', 'status', 'updatedAt'],
    ['jobId', 'projectId', 'runId', 'status', 'updatedAt'],
    ['jobId', 'projectId', 'runId', 'status', 'updatedAt'],
  ])
  assert.ok(state.cancelEvents.some((event) => event.scope === 'run' && event.id === 'run-1'))
})

test('Turn 无关联 Run 时取消仍成功且不伪造下游结果', async () => {
  const state = harness()
  const result = await state.service.cancelAgentTurn({ userId: 'user-1', projectId: 'project-1', turnId: 'turn-1' })

  assert.deepEqual(result, {
    kind: 'cancelling',
    turnId: 'turn-1',
    status: 'cancelling',
    linkedRunCount: 0,
    linkedSubagentCount: 0,
    cancelledRunCount: 0,
    cancelledJobCount: 0,
    cancelledSubagentCount: 0,
    failures: [],
  })
  assert.equal(state.runUpdates.length, 0)
  assert.equal(state.jobUpdates.length, 0)
})

test('linked Run/Job durable 取消无阻塞失败后，Turn 原子收口为 cancelled', async () => {
  const state = harness({ finalizeTurn: true })
  const result = await state.service.cancelAgentTurn({
    userId: 'user-1', projectId: 'project-1', turnId: 'turn-1',
  })

  assert.equal(state.turns.get('turn-1').status, 'cancelled')
  assert.equal(state.order.at(-1), 'finalize-turn')
  assert.equal(result.kind, 'cancelled')
  assert.equal(result.status, 'cancelled')
})

test('跨实例 cancel signal 发布失败时保留 cancelling，Sweep 重发成功后再终态化', async () => {
  const publishFailures = new Set(['turn:turn-1'])
  const state = harness({ finalizeTurn: true, publishFailures })

  const first = await state.service.cancelAgentTurn({
    userId: 'user-1', projectId: 'project-1', turnId: 'turn-1',
  })

  assert.equal(first.kind, 'cancelling')
  assert.equal(state.turns.get('turn-1').status, 'cancelling')
  assert.deepEqual(first.failures, [{ scope: 'turn', id: 'turn-1', code: 'CANCEL_SIGNAL_PUBLISH_FAILED' }])
  assert.equal(state.order.includes('finalize-turn'), false)

  publishFailures.clear()
  const recovered = await state.service.cancelAgentTurn({
    userId: 'user-1', projectId: 'project-1', turnId: 'turn-1',
  })

  assert.equal(recovered.kind, 'cancelled')
  assert.equal(state.turns.get('turn-1').status, 'cancelled')
  assert.equal(state.order.at(-1), 'finalize-turn')
})

test('重复取消幂等，并会重新检查已取消 Run 中上次未取消成功的 Job', async () => {
  const state = harness({
    runs: [run('run-1', 'turn-1', [branch('b1', 'running', 'job-1')])],
    jobs: [job('job-1', 'running', 'run-1', 'b1')],
  })

  const first = await state.service.cancelAgentTurn({ userId: 'user-1', projectId: 'project-1', turnId: 'turn-1' })
  const second = await state.service.cancelAgentTurn({ userId: 'user-1', projectId: 'project-1', turnId: 'turn-1' })

  assert.equal(first.cancelledRunCount, 1)
  assert.equal(first.cancelledJobCount, 1)
  assert.equal(second.cancelledRunCount, 0)
  assert.equal(second.cancelledJobCount, 0)
  assert.equal(state.runs.get('run-1').status, 'cancelled')
  assert.equal(state.jobs.get('job-1').status, 'cancelled')
  assert.equal(state.runUpdates.length, 1)
  assert.equal(state.jobUpdates.length, 1)
})

test('Job 终态已 durable 但 Run 投影尚未到达时，取消先对账终态而不把分支改成 cancelled', async () => {
  const staleRun = run('run-terminal-window', 'turn-1', [branch('b1', 'running', 'job-terminal')])
  const terminalJob = {
    ...job('job-terminal', 'succeeded', staleRun.id, 'b1'),
    outputs: [{ id: 'output-terminal' }],
    updatedAt: 25,
    projectWritebackPending: true,
  }
  const state = harness({
    finalizeTurn: true,
    runs: [staleRun],
    jobs: [terminalJob],
  })

  const result = await state.service.cancelAgentTurn({
    userId: 'user-1', projectId: 'project-1', turnId: 'turn-1',
  })

  assert.equal(state.jobs.get('job-terminal').status, 'succeeded')
  assert.equal(state.runs.get(staleRun.id).branches[0].status, 'succeeded')
  assert.equal(state.runs.get(staleRun.id).status, 'completed')
  assert.equal(result.kind, 'cancelled')
  assert.equal(state.turns.get('turn-1').status, 'cancelled')
})

test('单个 Job 读取失败被安全隔离，其余 Job 与 Run 继续取消', async () => {
  let finalizeCalls = 0
  const state = harness({
    runs: [run('run-1', 'turn-1', [branch('b1', 'running', 'job-secret'), branch('b2', 'queued', 'job-ok')])],
    jobs: [job('job-secret', 'running', 'run-1', 'b1'), job('job-ok', 'queued', 'run-1', 'b2')],
    failedJobReads: ['job-secret'],
    finalizeTurn: async () => { finalizeCalls += 1 },
  })

  const result = await state.service.cancelAgentTurn({ userId: 'user-1', projectId: 'project-1', turnId: 'turn-1' })

  assert.equal(state.jobs.get('job-secret').status, 'running')
  assert.equal(state.jobs.get('job-ok').status, 'cancelled')
  assert.equal(state.runs.get('run-1').status, 'cancelled')
  assert.deepEqual(result.failures, [{ scope: 'job', id: 'job-secret', code: 'GENERATION_JOB_READ_FAILED' }])
  assert.equal(finalizeCalls, 0, '存在 durable 阻塞失败时必须保留 cancelling 供 Sweep 重试')
  assert.equal(state.turns.get('turn-1').status, 'cancelling')
  assert.doesNotMatch(JSON.stringify(result), /sensitive provider failure/u)
})

test('Turn 取消分页遍历超过旧 60 条上限的全部关联 Run', async () => {
  const runs = Array.from({ length: 65 }, (_, index) => run(
    `run-${String(index).padStart(3, '0')}`,
    'turn-1',
    [branch(`branch-${index}`, 'queued')],
  ))
  const state = harness({ runs, finalizeTurn: true })

  const result = await state.service.cancelAgentTurn({
    userId: 'user-1', projectId: 'project-1', turnId: 'turn-1',
  })

  assert.equal(result.linkedRunCount, 65)
  assert.equal(result.cancelledRunCount, 65)
  assert.equal([...state.runs.values()].every((item) => item.status === 'cancelled'), true)
  assert.equal(state.turns.get('turn-1').status, 'cancelled')
  assert.equal(state.order.filter((item) => item === 'list-runs').length, 2)
})

test('根 Turn 取消按稳定分页收口全部关联 Subagent，并返回安全计数', async () => {
  const subagents = Array.from({ length: 65 }, (_, index) => subagent(
    `subagent-${String(index).padStart(3, '0')}`,
    'turn-1',
  ))
  const state = harness({ subagents, finalizeTurn: true })

  const result = await state.service.cancelAgentTurn({
    userId: 'user-1', projectId: 'project-1', turnId: 'turn-1',
  })

  assert.equal(result.linkedSubagentCount, 65)
  assert.equal(result.cancelledSubagentCount, 65)
  assert.equal([...state.subagents.values()].every((item) => item.status === 'cancelled'), true)
  assert.equal(state.turns.get('turn-1').status, 'cancelled')
  assert.equal(state.order.filter((item) => item === 'list-subagents').length, 2)
  assert.ok(state.order.indexOf('list-subagents') > state.order.indexOf('cancel-turn'))
  assert.equal(state.order.at(-1), 'finalize-turn')
})

test('根 Turn 通过稳定幂等命令调用注入的 cancelSubagent', async () => {
  const commands = []
  const state = harness({
    subagents: [subagent('subagent-1', 'turn-1')],
    finalizeTurn: true,
    cancelSubagent: async (command) => {
      commands.push(structuredClone(command))
      return { kind: 'finalized', subagent: subagent(command.subagentId, 'turn-1', 'cancelled') }
    },
  })

  await state.service.cancelAgentTurn({
    userId: 'user-1',
    projectId: 'project-1',
    turnId: 'turn-1',
    reason: '停止根任务',
  })

  assert.deepEqual(commands, [{
    userId: 'user-1',
    projectId: 'project-1',
    subagentId: 'subagent-1',
    idempotencyKey: 'agent-turn-cancel:turn-1:subagent:subagent-1',
    reason: '停止根任务',
  }])
})

test('Subagent 取消 pending 或失败时隔离其余项并阻止根 Turn finalize', async () => {
  let finalizeCalls = 0
  const state = harness({
    subagents: [
      subagent('subagent-failed', 'turn-1'),
      subagent('subagent-ok', 'turn-1'),
      subagent('subagent-pending', 'turn-1'),
    ],
    failedSubagentCancellations: ['subagent-failed'],
    pendingSubagentCancellations: ['subagent-pending'],
    finalizeTurn: async () => { finalizeCalls += 1 },
  })

  const result = await state.service.cancelAgentTurn({
    userId: 'user-1', projectId: 'project-1', turnId: 'turn-1',
  })

  assert.equal(result.kind, 'cancelling')
  assert.equal(result.linkedSubagentCount, 3)
  assert.equal(result.cancelledSubagentCount, 1)
  assert.deepEqual(result.failures, [
    { scope: 'subagent', id: 'subagent-failed', code: 'AGENT_SUBAGENT_CANCEL_FAILED' },
    { scope: 'subagent', id: 'subagent-pending', code: 'AGENT_SUBAGENT_CANCEL_PENDING' },
  ])
  assert.equal(state.subagents.get('subagent-ok').status, 'cancelled')
  assert.equal(finalizeCalls, 0)
  assert.equal(state.turns.get('turn-1').status, 'cancelling')
  assert.doesNotMatch(JSON.stringify(result), /sensitive subagent failure/u)
})

test('Subagent 分页读取失败时保留根 Turn cancelling，不能基于不完整集合 finalize', async () => {
  let finalizeCalls = 0
  const subagents = Array.from({ length: 51 }, (_, index) => subagent(
    `subagent-${String(index).padStart(3, '0')}`,
    'turn-1',
  ))
  const state = harness({
    subagents,
    failSubagentPageAfterId: 'subagent-049',
    finalizeTurn: async () => { finalizeCalls += 1 },
  })

  await assert.rejects(
    () => state.service.cancelAgentTurn({
      userId: 'user-1', projectId: 'project-1', turnId: 'turn-1',
    }),
    (caught) => caught instanceof AgentDelegationFenceError
      && caught.code === 'AGENT_TURN_LINKED_SUBAGENTS_READ_FAILED'
      && caught.statusCode === 503,
  )
  assert.equal(finalizeCalls, 0)
  assert.equal(state.turns.get('turn-1').status, 'cancelling')
  assert.equal(state.order.some((item) => item.startsWith('cancel-subagent:')), false)
})

test('每个 Run 反查分页补齐未写入 branch 的孤儿 Job', async () => {
  const orphanJobs = Array.from({ length: 55 }, (_, index) => job(
    `job-${String(index).padStart(3, '0')}`,
    'queued',
    'run-orphan',
    `orphan-${index}`,
  ))
  const state = harness({
    runs: [run('run-orphan', 'turn-1', [branch('branch-without-job-edge', 'running')])],
    jobs: orphanJobs,
    finalizeTurn: true,
  })

  const result = await state.service.cancelAgentTurn({
    userId: 'user-1', projectId: 'project-1', turnId: 'turn-1',
  })

  assert.equal(result.cancelledJobCount, 55)
  assert.equal([...state.jobs.values()].every((item) => item.status === 'cancelled'), true)
  assert.equal(state.runs.get('run-orphan').status, 'cancelled')
  assert.equal(state.turns.get('turn-1').status, 'cancelled')
})

test('Service 接受 Adapter collation 的混合大小写与标点顺序，并跨页取消全部 Run/Job', async () => {
  const runIds = [
    'run_1', 'run-10', 'run-a', 'Run-A', 'run-Z', 'run:9', 'run!3', 'run.2',
    ...Array.from({ length: 47 }, (_, index) => `run-${String(index + 100).padStart(3, '0')}`),
  ]
  const jobIds = [
    'job_1', 'job-10', 'job-a', 'Job-A', 'job-Z', 'job:9', 'job!3', 'job.2',
    ...Array.from({ length: 47 }, (_, index) => `job-${String(index + 100).padStart(3, '0')}`),
  ]
  const targetRunId = runIds[0]
  const state = harness({
    runs: runIds.map((id, index) => run(id, 'turn-1', [branch(`branch-${index}`, 'queued')])),
    jobs: jobIds.map((id, index) => job(id, 'queued', targetRunId, `orphan-${index}`)),
    finalizeTurn: true,
  })

  const result = await state.service.cancelAgentTurn({
    userId: 'user-1', projectId: 'project-1', turnId: 'turn-1',
  })

  assert.equal(result.linkedRunCount, runIds.length)
  assert.equal(result.cancelledRunCount, runIds.length)
  assert.equal(result.cancelledJobCount, jobIds.length)
  assert.deepEqual(result.failures, [])
  assert.equal([...state.runs.values()].every((item) => item.status === 'cancelled'), true)
  assert.equal([...state.jobs.values()].every((item) => item.status === 'cancelled'), true)
  assert.equal(state.turns.get('turn-1').status, 'cancelled')
})

test('Run 分页读取失败时保留 Turn cancelling，不能基于不完整集合 finalize', async () => {
  let finalizeCalls = 0
  const runs = Array.from({ length: 51 }, (_, index) => run(
    `run-${String(index).padStart(3, '0')}`,
    'turn-1',
    [branch(`branch-${index}`, 'queued')],
  ))
  const state = harness({
    runs,
    failRunPageAfterId: 'run-049',
    finalizeTurn: async () => { finalizeCalls += 1 },
  })

  await assert.rejects(
    () => state.service.cancelAgentTurn({
      userId: 'user-1', projectId: 'project-1', turnId: 'turn-1',
    }),
    (caught) => caught instanceof AgentDelegationFenceError
      && caught.code === 'AGENT_TURN_LINKED_RUNS_READ_FAILED'
      && caught.statusCode === 503,
  )
  assert.equal(finalizeCalls, 0)
  assert.equal(state.turns.get('turn-1').status, 'cancelling')
})

test('Job 反查分页失败会阻止 finalize，但仍取消 branch 已知 Job', async () => {
  let finalizeCalls = 0
  const state = harness({
    runs: [run('run-1', 'turn-1', [branch('b1', 'running', 'job-known')])],
    jobs: [job('job-known', 'running', 'run-1', 'b1')],
    failJobPageRunIds: ['run-1'],
    finalizeTurn: async () => { finalizeCalls += 1 },
  })

  const result = await state.service.cancelAgentTurn({
    userId: 'user-1', projectId: 'project-1', turnId: 'turn-1',
  })

  assert.equal(state.jobs.get('job-known').status, 'cancelled')
  assert.deepEqual(result.failures, [
    { scope: 'run', id: 'run-1', code: 'GENERATION_JOBS_FOR_RUN_READ_FAILED' },
  ])
  assert.equal(finalizeCalls, 0)
  assert.equal(state.turns.get('turn-1').status, 'cancelling')
})

test('取消 fence 阻止反查后才出现的新 Run delegation，completed Turn 仍可委派', async () => {
  const state = harness()
  await state.service.cancelAgentTurn({ userId: 'user-1', projectId: 'project-1', turnId: 'turn-1' })
  state.runs.set('late-run', run('late-run', 'turn-1', [branch('late', 'queued')]))

  await assert.rejects(
    () => assertTurnAllowsDelegation({
      productStore: state.productStore,
      userId: 'user-1',
      projectId: 'project-1',
      turnId: 'turn-1',
    }),
    (caught) => caught instanceof AgentDelegationFenceError
      && caught.code === 'AGENT_TURN_DELEGATION_CANCELLED'
      && caught.statusCode === 409,
  )

  state.turns.get('turn-1').status = 'completed'
  const allowed = await assertTurnAllowsDelegation({
    productStore: state.productStore,
    userId: 'user-1',
    projectId: 'project-1',
    turnId: 'turn-1',
  })
  assert.equal(allowed.status, 'completed')
})

test('delegation 只接受 completed Turn，其余生命周期均拒绝', async () => {
  const state = harness()
  for (const status of ['queued', 'running', 'waiting_user', 'failed']) {
    state.turns.get('turn-1').status = status
    await assert.rejects(
      assertTurnAllowsDelegation({
        productStore: state.productStore,
        userId: 'user-1', projectId: 'project-1', turnId: 'turn-1',
      }),
      (caught) => caught?.code === 'AGENT_TURN_DELEGATION_NOT_READY' && caught?.statusCode === 409,
      status,
    )
  }
  for (const status of ['cancelling', 'cancelled']) {
    state.turns.get('turn-1').status = status
    await assert.rejects(
      assertTurnAllowsDelegation({
        productStore: state.productStore,
        userId: 'user-1', projectId: 'project-1', turnId: 'turn-1',
      }),
      (caught) => caught?.code === 'AGENT_TURN_DELEGATION_CANCELLED',
      status,
    )
  }
})

test('Cancellation Service 构造时 fail-fast 要求原子 Job cancel 与根 Turn Subagent 级联', () => {
  const state = harness()
  const { putGenerationJob: _unusedPut, ...withoutLegacyPut } = state.productStore
  assert.doesNotThrow(() => createAgentCancellationService({
    productStore: withoutLegacyPut,
    cancelTurn: async () => undefined,
    cancelSubagent: async () => undefined,
  }))

  const { cancelGenerationJobExecution: _atomicCancel, ...withoutAtomicCancel } = state.productStore
  assert.throws(
    () => createAgentCancellationService({
      productStore: withoutAtomicCancel,
      cancelTurn: async () => undefined,
      cancelSubagent: async () => undefined,
    }),
    /缺少 ProductStore 能力/u,
  )

  const { listAgentSubagentsForRootTurnPage: _listSubagents, ...withoutSubagentLookup } = state.productStore
  assert.throws(
    () => createAgentCancellationService({
      productStore: withoutSubagentLookup,
      cancelTurn: async () => undefined,
      cancelSubagent: async () => undefined,
    }),
    /缺少 ProductStore 能力/u,
  )
  assert.throws(
    () => createAgentCancellationService({
      productStore: state.productStore,
      cancelTurn: async () => undefined,
    }),
    /缺少 cancelSubagent/u,
  )
})
