// @ts-check
import { createHash, randomUUID } from 'node:crypto'
import { agentReviewPreparedCheckpoint } from './agentReviewExecution.mjs'
import { buildReviewTaskForRun, runAgentReviewTask } from './agentReviewRunner.mjs'
import { boundedSweepPageSize, nextUpdatedAtIdSweepCursor } from './updatedAtIdSweepCursor.mjs'

/**
 * 评审任务的持久化编排。
 *
 * 与执行状态的边界在这里守住：本模块只读 Run/Job，只写评审任务 —— 评审失败或等待
 * 人工都不得把已成功持久化的 Run 改回失败（ADR 0006）。
 */

const terminalRunStatuses = new Set(['completed', 'partial'])
const agentReviewWorkerFailureByCode = Object.freeze({
  AGENT_REVIEW_EXECUTION_STALE: { statusCode: 409, message: 'Agent Review 执行权已失效。' },
  AGENT_REVIEW_EXECUTION_CONFLICT: { statusCode: 409, message: 'Agent Review 执行冲突。' },
  AGENT_REVIEW_CLAIM_FAILED: { statusCode: 409, message: 'Agent Review 无法取得执行权。' },
  AGENT_REVIEW_CANCELLED: { statusCode: 499, message: 'Agent Review 已取消。' },
  AGENT_REVIEW_EXECUTION_FAILED: { statusCode: 500, message: 'Agent Review 执行失败。' },
})
const observableErrorCodes = new Set([
  ...Object.keys(agentReviewWorkerFailureByCode),
  'AGENT_REVIEW_CANCEL_PUBLISH_FAILED',
  'AGENT_REVIEW_SWEEP_FAILED',
])

function safeObservedErrorCode(caught, fallback) {
  const code = caught && typeof caught === 'object' && 'code' in caught
    ? caught.code
    : undefined
  return typeof code === 'string' && observableErrorCodes.has(code) ? code : fallback
}

class AgentReviewExecutionError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message)
    this.name = 'AgentReviewExecutionError'
    this.code = code
    this.statusCode = statusCode
  }
}

/**
 * Review Worker/BullMQ 的失败面只允许稳定 code 与固定文案。Provider 异常可能含
 * Authorization、请求 URL 或完整 Prompt，不能把 caught.message 当作 failureReason。
 */
export function safeAgentReviewWorkerFailure(caught) {
  const requestedCode = caught && typeof caught === 'object' && 'code' in caught
    ? caught.code
    : undefined
  const code = typeof requestedCode === 'string' && Object.hasOwn(agentReviewWorkerFailureByCode, requestedCode)
    ? requestedCode
    : 'AGENT_REVIEW_EXECUTION_FAILED'
  return { code, ...agentReviewWorkerFailureByCode[code] }
}

function safeAgentReviewExecutionError(caught) {
  const failure = safeAgentReviewWorkerFailure(caught)
  return new AgentReviewExecutionError(failure.code, failure.message, failure.statusCode)
}

/**
 * @param {{
 *   productStore: any,
 *   reviewCandidate?: (input: { candidate: any, task: any }) => Promise<any>,
 *   judgeWith?: (input: { criterion: any, candidate: any }) => any,
 *   observe?: (event: any) => void,
 *   now?: () => number,
 *   leaseMs?: number,
 *   heartbeatMs?: number,
 *   setIntervalFn?: (callback: () => any, delay: number) => any,
 *   clearIntervalFn?: (handle: any) => void,
 *   publishCancel?: (event: any) => Promise<unknown>,
 * }} input
 */
export function createAgentReviewService({
  productStore,
  reviewCandidate,
  judgeWith,
  observe = () => {},
  now = () => Date.now(),
  leaseMs = 300_000,
  heartbeatMs,
  setIntervalFn = (callback, delay) => setInterval(callback, delay),
  clearIntervalFn = (handle) => clearInterval(handle),
  publishCancel,
}) {
  if (!productStore) throw new TypeError('评审服务缺少 ProductStore。')
  const boundedLeaseMs = Math.max(30_000, Math.min(Number(leaseMs) || 300_000, 900_000))
  const boundedHeartbeatMs = Math.max(
    1_000,
    Math.min(Number(heartbeatMs) || Math.floor(boundedLeaseMs / 3), Math.floor(boundedLeaseMs / 2)),
  )
  let pendingReviewAfter = null
  /**
   * 本地句柄只是跨实例 cancel signal 的落点，不是状态权威。generation 必须一起
   * 匹配：旧消息晚到时不能杀掉已经接管任务的新 Worker。
   * @type {Map<string, {
   *   taskId: string, projectId: string, executionGeneration: number,
   *   leaseToken: string, controller: AbortController, signalId?: string,
   * }>}
   */
  const activeExecutions = new Map()

  function assertExecutionStore() {
    if (typeof productStore.claimAgentReviewExecution !== 'function'
      || typeof productStore.commitAgentReviewExecution !== 'function'
      || typeof productStore.readAgentReviewTaskForWorker !== 'function') {
      throw new TypeError('评审服务缺少 ProductStore 原子执行权 Interface。')
    }
  }

  function assertCancellationStore() {
    if (typeof productStore.requestAgentReviewCancellation !== 'function'
      || typeof productStore.finalizeAgentReviewCancellation !== 'function') {
      throw new TypeError('评审服务缺少 ProductStore durable cancellation Interface。')
    }
  }

  function cancellationSignalId(taskId, idempotencyKey) {
    const digest = createHash('sha256')
      .update(`${taskId}:${idempotencyKey}`)
      .digest('base64url')
    return `agent_review_cancel_${digest.slice(0, 32)}`
  }

  function cancellationEvent(task) {
    const cancel = task?.cancel
    const executionGeneration = Number(cancel?.executionGeneration ?? task?.execution?.generation)
    if (task?.status !== 'cancelling'
      || typeof cancel?.signalId !== 'string'
      || !cancel.signalId
      || !Number.isInteger(executionGeneration)
      || executionGeneration < 1) return undefined
    return {
      scope: 'review',
      id: task.id,
      projectId: task.projectId,
      signalId: cancel.signalId,
      executionGeneration,
      requestedAt: cancel.requestedAt,
    }
  }

  function cancellationError(taskId) {
    return new AgentReviewExecutionError(
      'AGENT_REVIEW_CANCELLED',
      `Agent Review ${taskId} 已收到 durable 取消信号。`,
      499,
    )
  }

  /** 收到 Redis 旁路后只中止完全匹配的本地 generation。 */
  function handleCancellationSignal(event) {
    if (event?.scope !== 'review'
      || typeof event.id !== 'string'
      || typeof event.projectId !== 'string'
      || typeof event.signalId !== 'string'
      || !Number.isInteger(event.executionGeneration)) return false
    const active = activeExecutions.get(event.id)
    if (!active
      || active.projectId !== event.projectId
      || active.executionGeneration !== event.executionGeneration) return false
    active.signalId = event.signalId
    if (!active.controller.signal.aborted) active.controller.abort(cancellationError(event.id))
    return true
  }

  async function readTaskForWorker(taskId) {
    assertExecutionStore()
    return productStore.readAgentReviewTaskForWorker(taskId)
  }

  async function finalizeCancellation(ownerId, task, proof) {
    assertCancellationStore()
    const event = cancellationEvent(task)
    if (!event) return task
    const decision = await productStore.finalizeAgentReviewCancellation(ownerId, {
      id: task.id,
      projectId: task.projectId,
      signalId: event.signalId,
      executionGeneration: event.executionGeneration,
      proof,
    })
    return decision?.task ?? task
  }

  /**
   * HTTP 只写取消意图并广播。`cancelling` 不能在这里伪装成 `cancelled`；终态只由
   * Worker 实际退出或 DB 证明租约过期后写入。
   */
  async function requestReviewCancellation({
    userId, taskId, projectId, idempotencyKey, requestedBy = userId, reason,
  }) {
    assertCancellationStore()
    const decision = await productStore.requestAgentReviewCancellation(userId, {
      id: taskId,
      projectId,
      idempotencyKey,
      signalId: cancellationSignalId(taskId, idempotencyKey),
      requestedBy,
      ...(reason ? { reason } : {}),
    })
    const task = decision?.task
    if (!task) return decision
    const event = cancellationEvent(task)
    if (event) {
      handleCancellationSignal(event)
      try {
        await publishCancel?.(event)
      } catch (caught) {
        // durable cancelling 已经成立；Redis 是加速中止的旁路。发布失败时由租约
        // 过期清扫收口，不能回滚权威取消意图。
        observe({
          event: 'agent.review.cancel.publish_deferred',
          taskId: task.id,
          projectId: task.projectId,
          code: safeObservedErrorCode(caught, 'AGENT_REVIEW_CANCEL_PUBLISH_FAILED'),
        })
      }
    }
    return decision
  }

  /** outcome_unknown 只能经显式人类选择解决；本方法自身从不调用 Provider。 */
  async function reconcileReviewOutcome({ userId, taskId, projectId, idempotencyKey, action }) {
    if (typeof productStore.resolveAgentReviewOutcomeUnknown !== 'function') {
      throw new TypeError('评审服务缺少 ProductStore outcome reconciliation Interface。')
    }
    return productStore.resolveAgentReviewOutcomeUnknown(userId, {
      id: taskId,
      projectId,
      idempotencyKey,
      action,
      actorId: userId,
    })
  }

  function committedTask(decision, operation) {
    if (decision?.kind === 'committed' || decision?.kind === 'replay') return decision.task
    throw new AgentReviewExecutionError(
      decision?.kind === 'stale' ? 'AGENT_REVIEW_EXECUTION_STALE' : 'AGENT_REVIEW_EXECUTION_CONFLICT',
      `Agent Review ${operation} 未取得当前执行 fence。`,
    )
  }

  async function jobsForRun(userId, run) {
    const jobIds = [...new Set((run.branches ?? []).flatMap((branch) => branch.jobIds ?? []).filter(Boolean))]
    const jobs = await Promise.all(jobIds.map((jobId) => productStore.readGenerationJob(userId, jobId)))
    return jobs.filter(Boolean)
  }

  /**
   * Run 到执行终态后建立评审任务。已存在则原样返回 —— 任务标识由
   * (runId, qualityPolicyFingerprint) 决定，重复调用不会产生第二份。
   */
  async function ensureReviewTaskForRun(userId, runId) {
    const run = await productStore.readAgentRun(userId, runId)
    if (!run || !terminalRunStatuses.has(run.status)) return undefined
    const existing = (await productStore.listAgentReviewTasksForRun(userId, run.projectId, run.id)) ?? []
    if (existing.length) return existing[0]
    const built = buildReviewTaskForRun({ run, jobs: await jobsForRun(userId, run), now: now() })
    if (!built) {
      // 没有编译快照或没有成功候选：不建任务，也不伪造一份 rubric。
      observe({ event: 'agent.review.skipped', runId, projectId: run.projectId })
      return undefined
    }
    const stored = await productStore.putAgentReviewTask(userId, built.task)
    observe({ event: 'agent.review.created', runId, projectId: run.projectId, taskId: stored.id, coverage: stored.coverage })
    return stored
  }

  /** 执行一个评审任务并逐候选落库。所有写入都绑定原子 claim 返回的 generation fence。 */
  async function executeReviewTaskInternal(userId, taskId) {
    assertExecutionStore()
    // Worker 读取必须保留 ownerId / execution fence；公共读取会清理这些私有字段。
    const observed = await readTaskForWorker(taskId)
    if (!observed) return undefined
    const executionOwnerId = observed.ownerId ?? userId
    // running Worker 崩溃后没有 worker_exit ack。清扫器只能提交 lease_expired 证明，
    // Adapter 使用 DB clock 判定；租约尚未到期时仍保持 cancelling。
    if (observed.status === 'cancelling') {
      return finalizeCancellation(executionOwnerId, observed, { kind: 'lease_expired' })
    }
    const leaseToken = `agent_review_lease_${randomUUID()}`
    const claim = await productStore.claimAgentReviewExecution(executionOwnerId, {
      id: observed.id,
      projectId: observed.projectId,
      leaseToken,
      leaseDurationMs: boundedLeaseMs,
      observedAt: now(),
      allowTakeover: true,
    })
    if (claim?.kind === 'cancelling') {
      return finalizeCancellation(executionOwnerId, claim.task, { kind: 'lease_expired' })
    }
    if (['replay', 'terminal', 'cancelled', 'outcome_unknown', 'in_progress', 'stale'].includes(claim?.kind)) {
      observe({
        event: 'agent.review.claim.skipped',
        taskId: observed.id,
        projectId: observed.projectId,
        reason: claim.kind,
      })
      return claim.task
    }
    if (claim?.kind === 'missing') return undefined
    if (claim?.kind !== 'claimed' || !claim.task?.execution) {
      throw new AgentReviewExecutionError('AGENT_REVIEW_CLAIM_FAILED', 'Agent Review 无法取得执行权。')
    }
    const task = claim.task
    const executionGeneration = Number(task.execution.generation)
    const commit = (command) => productStore.commitAgentReviewExecution(executionOwnerId, {
      id: task.id,
      projectId: task.projectId,
      leaseToken,
      executionGeneration,
      ...command,
      observedAt: now(),
    })
    const controller = new AbortController()
    const activeExecution = {
      taskId: task.id,
      projectId: task.projectId,
      executionGeneration,
      leaseToken,
      controller,
    }
    if (activeExecutions.has(task.id)) {
      throw new AgentReviewExecutionError(
        'AGENT_REVIEW_EXECUTION_CONFLICT',
        '本实例已存在该评审任务的活动执行句柄。',
      )
    }
    activeExecutions.set(task.id, activeExecution)
    let heartbeatStopped = false
    let heartbeatFailure
    let heartbeatTail = Promise.resolve()

    function executionStale(caught) {
      if (caught instanceof AgentReviewExecutionError && caught.code === 'AGENT_REVIEW_EXECUTION_STALE') return caught
      return new AgentReviewExecutionError(
        'AGENT_REVIEW_EXECUTION_STALE',
        agentReviewWorkerFailureByCode.AGENT_REVIEW_EXECUTION_STALE.message,
      )
    }

    function assertExecutionActive() {
      if (heartbeatFailure) throw heartbeatFailure
      if (controller.signal.aborted) throw controller.signal.reason
    }

    function heartbeat() {
      const next = heartbeatTail.then(async () => {
        if (heartbeatStopped || heartbeatFailure) return
        const decision = await commit({ status: 'running' })
        committedTask(decision, 'heartbeat')
      }).catch((caught) => {
        if (heartbeatFailure) return
        heartbeatFailure = executionStale(caught)
        controller.abort(heartbeatFailure)
        observe({
          event: 'agent.review.heartbeat.lost',
          taskId: task.id,
          projectId: task.projectId,
          code: heartbeatFailure.code,
        })
      })
      heartbeatTail = next
      return next
    }

    const heartbeatHandle = setIntervalFn(heartbeat, boundedHeartbeatMs)
    heartbeatHandle?.unref?.()
    async function stopHeartbeat() {
      if (!heartbeatStopped) {
        heartbeatStopped = true
        clearIntervalFn(heartbeatHandle)
      }
      // 定时器回调可能正在 Adapter CAS 中；terminal 之前先排空，避免终态之后
      // 才把一个预先排队的 running heartbeat 判成失租并误 abort 已完成执行。
      await heartbeatTail
    }
    try {
      // cancel signal 可能早于本地句柄登记到达；登记后补读权威 task，消除这段竞态。
      const registeredTask = await readTaskForWorker(task.id)
      const registeredCancellation = cancellationEvent(registeredTask)
      if (registeredCancellation) handleCancellationSignal(registeredCancellation)
      assertExecutionActive()
      const run = await productStore.readAgentRun(executionOwnerId, task.runId)
      assertExecutionActive()
      if (!run) {
        await stopHeartbeat()
        assertExecutionActive()
        const failed = await commit({
          status: 'failed',
          error: { code: 'AGENT_RUN_NOT_FOUND', message: '评审任务对应的 Run 已不存在。' },
        })
        return committedTask(failed, 'failed commit')
      }
      const built = buildReviewTaskForRun({ run, jobs: await jobsForRun(executionOwnerId, run), now: now() })
      assertExecutionActive()
      const outcome = await runAgentReviewTask({
        task,
        candidates: built?.candidates ?? [],
        // 断点续评：已产出的结论不重评，避免重复调用视觉模型。
        existingResults: task.results ?? [],
        reviewCandidate,
        // 项目自定义判据（evaluator Skill）。未注入时它们记为「无法验证」而不是通过。
        judgeWith,
        prepareCandidate: async ({ artifactId }) => {
          assertExecutionActive()
          const prepared = await commit({
            status: 'running',
            checkpoint: agentReviewPreparedCheckpoint({ artifactId, preparedAt: now() }),
          })
          committedTask(prepared, 'prepared commit')
          assertExecutionActive()
        },
        commitCandidateResult: async (result) => {
          assertExecutionActive()
          const committed = await commit({
            status: 'running',
            result,
            checkpoint: null,
          })
          committedTask(committed, 'result commit')
          assertExecutionActive()
        },
        signal: controller.signal,
        now,
      })
      assertExecutionActive()
      await stopHeartbeat()
      assertExecutionActive()
      const settled = await commit({
        status: outcome.task.status,
        ...(outcome.task.status === 'failed' ? { error: outcome.task.error } : {}),
      })
      const stored = committedTask(settled, 'terminal commit')
      observe({
        event: 'agent.review.settled',
        taskId: stored.id,
        runId: stored.runId,
        projectId: stored.projectId,
        status: stored.status,
        reviewed: stored.results?.length ?? outcome.results.length,
        skipped: stored.coverage?.skippedCandidates ?? 0,
        failures: outcome.failures.length,
      })
      return stored
    } catch (caught) {
      await stopHeartbeat()
      const authoritative = await readTaskForWorker(task.id)
      const event = cancellationEvent(authoritative)
      if (event && event.executionGeneration === executionGeneration) {
        const cancelled = await finalizeCancellation(executionOwnerId, authoritative, {
          kind: 'worker_exit',
          leaseToken,
        })
        observe({
          event: 'agent.review.cancelled',
          taskId: cancelled.id,
          projectId: cancelled.projectId,
          status: cancelled.status,
        })
        return cancelled
      }
      throw caught
    } finally {
      await stopHeartbeat()
      if (activeExecutions.get(task.id) === activeExecution) activeExecutions.delete(task.id)
    }
  }

  // 这是 Review 到 Worker/BullMQ 的失败边界。无论异常发生在初始读取、claim、
  // heartbeat、Provider 还是取消收口，都不能让底层异常正文成为 failureReason。
  async function executeReviewTask(userId, taskId) {
    try {
      return await executeReviewTaskInternal(userId, taskId)
    } catch (caught) {
      throw safeAgentReviewExecutionError(caught)
    }
  }

  /**
   * 清扫未收口的评审任务。浏览器关掉后评审仍要推进，靠的就是这条路径。
   */
  /** @param {{ olderThan?: number, limit?: number }} [input] */
  async function sweepPendingReviewTasksInternal({ olderThan, limit = 25 } = {}) {
    const pageLimit = boundedSweepPageSize(limit)
    const requestedAfter = pendingReviewAfter
    const pending = (await productStore.listPendingAgentReviewTasks({
      olderThan: olderThan ?? now(),
      after: requestedAfter,
      limit: pageLimit,
    })) ?? []
    const progression = nextUpdatedAtIdSweepCursor({ after: requestedAfter, page: pending, limit: pageLimit })
    pendingReviewAfter = progression.after
    if (progression.stalled) {
      observe({ event: 'agent.review.sweep.cursor_stalled', after: requestedAfter })
    }
    const settled = []
    for (const task of pending) {
      try {
        settled.push(await executeReviewTask(task.ownerId, task.id))
      } catch (caught) {
        // 一个坏任务不能挡住整批清扫。
        observe({
          event: 'agent.review.sweep.failed',
          taskId: task.id,
          code: safeObservedErrorCode(caught, 'AGENT_REVIEW_SWEEP_FAILED'),
        })
      }
    }
    return { scanned: pending.length, settled: settled.filter(Boolean).length }
  }

  async function sweepPendingReviewTasks(input) {
    try {
      return await sweepPendingReviewTasksInternal(input)
    } catch (caught) {
      throw safeAgentReviewExecutionError(caught)
    }
  }

  return {
    ensureReviewTaskForRun,
    executeReviewTask,
    sweepPendingReviewTasks,
    requestReviewCancellation,
    reconcileReviewOutcome,
    handleCancellationSignal,
  }
}
