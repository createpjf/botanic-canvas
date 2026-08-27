// @ts-check
import { randomUUID } from 'node:crypto'
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

class AgentReviewExecutionError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'AgentReviewExecutionError'
    this.code = code
  }
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
}) {
  if (!productStore) throw new TypeError('评审服务缺少 ProductStore。')
  const boundedLeaseMs = Math.max(30_000, Math.min(Number(leaseMs) || 300_000, 900_000))
  const boundedHeartbeatMs = Math.max(
    1_000,
    Math.min(Number(heartbeatMs) || Math.floor(boundedLeaseMs / 3), Math.floor(boundedLeaseMs / 2)),
  )
  let pendingReviewAfter = null

  function assertExecutionStore() {
    if (typeof productStore.claimAgentReviewExecution !== 'function'
      || typeof productStore.commitAgentReviewExecution !== 'function') {
      throw new TypeError('评审服务缺少 ProductStore 原子执行权 Interface。')
    }
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
  async function executeReviewTask(userId, taskId) {
    assertExecutionStore()
    // 预读只用于取得不可变 projectId；是否能执行仍由后续原子 claim 决定。
    const observed = await productStore.readAgentReviewTask(userId, taskId)
    if (!observed) return undefined
    const leaseToken = `agent_review_lease_${randomUUID()}`
    const claim = await productStore.claimAgentReviewExecution(userId, {
      id: observed.id,
      projectId: observed.projectId,
      leaseToken,
      leaseDurationMs: boundedLeaseMs,
      observedAt: now(),
      allowTakeover: true,
    })
    if (['replay', 'terminal', 'outcome_unknown', 'in_progress', 'stale'].includes(claim?.kind)) {
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
    const commit = (command) => productStore.commitAgentReviewExecution(userId, {
      id: task.id,
      projectId: task.projectId,
      leaseToken,
      executionGeneration,
      ...command,
      observedAt: now(),
    })
    const controller = new AbortController()
    let heartbeatStopped = false
    let heartbeatFailure
    let heartbeatTail = Promise.resolve()

    function executionStale(caught) {
      if (caught instanceof AgentReviewExecutionError && caught.code === 'AGENT_REVIEW_EXECUTION_STALE') return caught
      return new AgentReviewExecutionError(
        'AGENT_REVIEW_EXECUTION_STALE',
        `Agent Review heartbeat 已失去执行权：${caught instanceof Error ? caught.message : String(caught)}`,
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
      const run = await productStore.readAgentRun(task.ownerId ?? userId, task.runId)
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
      const built = buildReviewTaskForRun({ run, jobs: await jobsForRun(task.ownerId ?? userId, run), now: now() })
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
    } finally {
      await stopHeartbeat()
    }
  }

  /**
   * 清扫未收口的评审任务。浏览器关掉后评审仍要推进，靠的就是这条路径。
   */
  /** @param {{ olderThan?: number, limit?: number }} [input] */
  async function sweepPendingReviewTasks({ olderThan, limit = 25 } = {}) {
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
          message: caught instanceof Error ? caught.message : String(caught),
        })
      }
    }
    return { scanned: pending.length, settled: settled.filter(Boolean).length }
  }

  return { ensureReviewTaskForRun, executeReviewTask, sweepPendingReviewTasks }
}
