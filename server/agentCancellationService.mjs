// @ts-check

import { applyGenerationJobToAgentRun, cancelPersistentAgentRun } from './botanicAgentRun.mjs'
import { cancelGenerationJob } from './generation/generationCancellation.mjs'

const terminalTurnStatuses = new Set(['failed'])
const cancellationFenceStatuses = new Set(['cancelling', 'cancelled'])
const cancellationPageSize = 50
// 只让「无法证明下游 durable 状态」的故障阻止 Turn finalize。明确查无 Job 表示
// 没有可继续执行的 durable 任务，虽记录诊断 failure，但不应让 Turn 永久 cancelling。
const blockingCancellationFailureCodes = new Set([
  // durable fence 虽已落库，但本轮没有证据表明远端 Worker 已收到 abort。
  // 保留 cancelling，让 Sweep 重发信号后再收口，避免表面 cancelled 而 Provider 仍占槽。
  'CANCEL_SIGNAL_PUBLISH_FAILED',
  'GENERATION_JOB_READ_FAILED',
  'GENERATION_JOB_SCOPE_MISMATCH',
  'GENERATION_JOB_CANCEL_FAILED',
  'GENERATION_JOB_CANCEL_ACK_READ_FAILED',
  'GENERATION_JOB_CANCEL_ACK_PENDING',
  'GENERATION_JOBS_FOR_RUN_READ_FAILED',
  'GENERATION_JOBS_FOR_RUN_PAGE_INVALID',
  'AGENT_RUN_REFRESH_FAILED',
  'AGENT_RUN_CANCEL_FAILED',
  'AGENT_SUBAGENT_CANCEL_FAILED',
  'AGENT_SUBAGENT_CANCEL_PENDING',
])

/**
 * Turn 取消与 Run delegation 的业务冲突。权限仍由 HTTP / 工具调用方负责；这里
 * 只保护已经落库的取消 fence，避免取消反查完成后才创建的新 Run 穿透。
 */
export class AgentDelegationFenceError extends Error {
  constructor(code, message, statusCode) {
    super(message)
    this.name = 'AgentDelegationFenceError'
    this.code = code
    this.statusCode = statusCode
  }
}

/**
 * delegation 的强制前置检查。
 *
 * 调用方须在「创建 Run 前」及「提交首个 Generation Job 前」各调用一次。前者阻止
 * 已取消 Turn 创建 Run；后者封住检查与创建之间的窄竞态。若取消恰好落在第二次
 * 检查之后，Turn 的重复取消 / sweep 会由 `run.turnId` 反查并收口该 Run。
 */
export async function assertTurnAllowsDelegation(input) {
  const { productStore, userId, projectId, turnId } = input ?? {}
  if (!productStore?.readAgentTurn || !userId || !projectId || !turnId) {
    throw new TypeError('Turn delegation fence 缺少身份或 ProductStore。')
  }
  const turn = await productStore.readAgentTurn(userId, turnId)
  if (!turn || turn.projectId !== projectId) {
    throw new AgentDelegationFenceError('AGENT_TURN_NOT_FOUND', '未找到当前项目的 Agent Turn。', 404)
  }
  if (cancellationFenceStatuses.has(turn.status)) {
    throw new AgentDelegationFenceError(
      'AGENT_TURN_DELEGATION_CANCELLED',
      'Agent Turn 已进入取消流程，不能再创建或提交关联 Run。',
      409,
    )
  }
  if (turn.status !== 'completed') {
    throw new AgentDelegationFenceError(
      'AGENT_TURN_DELEGATION_NOT_READY',
      'Agent Turn 尚未成功完成，不能创建或提交关联 Run。',
      409,
    )
  }
  return turn
}

function safeFailure(scope, id, code) {
  return { scope, id, code }
}

function candidateJobIds(run) {
  const ids = []
  for (const branch of run?.branches ?? []) {
    const active = branch.status === 'queued' || branch.status === 'running'
    // Run 已取消但 Job 取消曾失败时，branch 已无 active 状态。重复取消仍须重新读取
    // 其历史 Job，才能把那次局部失败真正收口；终态 Job 的共享取消函数是无操作。
    if (!active && run.status !== 'cancelled') continue
    if (branch.activeJobId) ids.push(branch.activeJobId)
    if (run.status === 'cancelled') ids.push(...(branch.jobIds ?? []))
  }
  return [...new Set(ids.filter(Boolean))]
}

function runNeedsCancellation(run) {
  return run?.status === 'cancelled'
    || (run?.branches ?? []).some((branch) => branch.status === 'queued' || branch.status === 'running')
}

/**
 * Turn / Run / GenerationJob 取消的单一编排层。
 *
 * - 权限检查外置，调用者传入的 userId 已获授权；
 * - Turn 必须先由 `cancelTurn` 原子落到 cancelling，之后才允许反查 Run；
 * - Job 与 Run 的单体状态机继续复用既有权威函数，本模块只拥有级联和故障隔离；
 * - 返回值和发布的 update 只含身份、状态、计费判定等安全摘要，不带 Prompt、媒体
 *   地址、Provider 回包或底层异常文本。
 */
export function createAgentCancellationService(input) {
  const {
    productStore,
    cancelTurn,
    finalizeTurn,
    cancelSubagent,
    redisQueue,
    publishCancel,
    publishGenerationJobUpdated,
    publishAgentRunUpdated,
    afterGenerationJobPersist,
    modelOptions = [],
    now = Date.now,
  } = input ?? {}

  if (!productStore?.listAgentRunsForTurnPage
    || !productStore?.listAgentSubagentsForRootTurnPage
    || !productStore?.listGenerationJobsForAgentRunPage
    || !productStore?.readAgentRun
    || !productStore?.putAgentRun
    || !productStore?.readGenerationJob
    || typeof productStore?.cancelGenerationJobExecution !== 'function'
    || typeof productStore?.acknowledgeGenerationJobCancellation !== 'function') {
    throw new TypeError('Agent Cancellation Service 缺少 ProductStore 能力。')
  }
  if (typeof cancelTurn !== 'function') throw new TypeError('Agent Cancellation Service 缺少 cancelTurn。')
  if (typeof cancelSubagent !== 'function') throw new TypeError('Agent Cancellation Service 缺少 cancelSubagent。')

  async function publishCancellation(event, failures) {
    if (typeof publishCancel !== 'function') return
    try {
      await publishCancel(event)
    } catch {
      failures.push(safeFailure(event.scope, event.id, 'CANCEL_SIGNAL_PUBLISH_FAILED'))
    }
  }

  async function listDirectJobIds(context) {
    const { userId, projectId, runId, failures } = context
    const ids = []
    const seenIds = new Set()
    let afterId
    while (true) {
      let page
      try {
        page = await productStore.listGenerationJobsForAgentRunPage(
          userId,
          projectId,
          runId,
          { afterId, limit: cancellationPageSize },
        )
      } catch {
        failures.push(safeFailure('run', runId, 'GENERATION_JOBS_FOR_RUN_READ_FAILED'))
        return ids
      }
      if (!Array.isArray(page)) {
        failures.push(safeFailure('run', runId, 'GENERATION_JOBS_FOR_RUN_PAGE_INVALID'))
        return ids
      }
      if (page.length === 0) return ids

      const priorCursor = afterId
      let lastId
      for (const job of page) {
        const jobId = typeof job?.id === 'string' ? job.id : ''
        if (!jobId.trim() || seenIds.has(jobId)) {
          failures.push(safeFailure('run', runId, 'GENERATION_JOBS_FOR_RUN_PAGE_INVALID'))
          return ids
        }
        seenIds.add(jobId)
        ids.push(jobId)
        lastId = jobId
      }
      // Adapter/数据库拥有自己的 collation；Service 只要求 opaque cursor 确实推进，
      // 不能用 JS 字符串大小关系否定数据库已经给出的稳定顺序。
      if (!lastId || lastId === priorCursor) {
        failures.push(safeFailure('run', runId, 'GENERATION_JOBS_FOR_RUN_PAGE_INVALID'))
        return ids
      }
      afterId = lastId
      if (page.length < cancellationPageSize) return ids
    }
  }

  async function confirmGenerationWorkerRelease(job, failures) {
    if (job?.cancel?.signalRequired !== true) return job
    let latest
    try {
      // publish success 只是把信号交给 Redis；必须重新读取 Job 上由实际 Worker 退出
      // 写入的 durable ack，不能用本次取消调用的旧返回值替代。
      latest = await productStore.readGenerationJob(job.ownerId, job.id)
    } catch {
      failures.push(safeFailure('job', job.id, 'GENERATION_JOB_CANCEL_ACK_READ_FAILED'))
      return job
    }
    if (!latest) {
      failures.push(safeFailure('job', job.id, 'GENERATION_JOB_CANCEL_ACK_READ_FAILED'))
      return job
    }
    const released = () => latest.cancel?.workerReleased === true
      && Number(latest.cancel?.signalAcknowledgedAt) > 0
    if (released()) return latest

    // Worker 崩溃无法留下 exit ack。Adapter 只能在同一 generation 的数据库 lease
    // 已被 DB clock 判定过期后写入替代证明；到期前返回 pending，绝不提前 finalize。
    try {
      await productStore.acknowledgeGenerationJobCancellation(job.ownerId, {
        id: latest.id,
        projectId: latest.projectId,
        signalId: latest.cancel?.signalId,
        executionGeneration: Number(latest.execution?.generation ?? latest.executionVersion ?? 0),
        releaseBasis: 'lease_expired',
      })
    } catch {
      // response lost 可能发生在 durable 写之后，所以下面仍必须复读一次。
    }
    try {
      latest = await productStore.readGenerationJob(job.ownerId, job.id)
    } catch {
      failures.push(safeFailure('job', job.id, 'GENERATION_JOB_CANCEL_ACK_READ_FAILED'))
      return job
    }
    if (!latest || !released()) {
      failures.push(safeFailure('job', job.id, 'GENERATION_JOB_CANCEL_ACK_PENDING'))
    }
    return latest ?? job
  }

  async function cancelLinkedRun(context) {
    const { userId, projectId, run, requestedBy, requestedAt, failures } = context
    const needsRunCancellation = runNeedsCancellation(run)
    // branch.jobIds 是 Run 投影，可能在「Job 已落库、Run 投影尚未写回」的崩溃窗
    // 里缺边。必须再按 Job.agentRun.runId 反查并分页，二者取并集后再逐个权威读取。
    const directJobIds = await listDirectJobIds({ userId, projectId, runId: run.id, failures })
    const linkedJobIds = [...new Set([...candidateJobIds(run), ...directJobIds])]
    if (!needsRunCancellation && linkedJobIds.length === 0) {
      return { cancelledRunCount: 0, cancelledJobCount: 0 }
    }

    let cancelledJobCount = 0
    const authoritativeJobs = []
    for (const jobId of linkedJobIds) {
      let generationJob
      try {
        generationJob = await productStore.readGenerationJob(userId, jobId)
      } catch {
        failures.push(safeFailure('job', jobId, 'GENERATION_JOB_READ_FAILED'))
        continue
      }
      if (!generationJob) {
        failures.push(safeFailure('job', jobId, 'GENERATION_JOB_NOT_FOUND'))
        continue
      }
      if (generationJob.projectId !== projectId
        || (generationJob.agentRun?.runId && generationJob.agentRun.runId !== run.id)) {
        failures.push(safeFailure('job', jobId, 'GENERATION_JOB_SCOPE_MISMATCH'))
        continue
      }

      const isolatedQueue = redisQueue?.cancel
        ? {
            cancel: async (id) => {
              try {
                return await redisQueue.cancel(id)
              } catch {
                failures.push(safeFailure('job', id, 'GENERATION_QUEUE_CANCEL_FAILED'))
                return undefined
              }
            },
          }
        : undefined
      try {
        const outcome = await cancelGenerationJob({
          productStore,
          redisQueue: isolatedQueue,
          publishCancel: (event) => publishCancellation(event, failures),
          modelOptions,
          ownerId: userId,
          job: generationJob,
          reason: 'agent-run',
          requestedAt,
          requestedBy,
          afterPersist: async (cancelledJob) => {
            if (typeof afterGenerationJobPersist === 'function') {
              try {
                await afterGenerationJobPersist({
                  userId,
                  projectId,
                  runId: run.id,
                  job: cancelledJob,
                })
              } catch {
                failures.push(safeFailure('job', cancelledJob.id, 'GENERATION_JOB_PROJECTION_FAILED'))
              }
            }
            if (typeof publishGenerationJobUpdated === 'function') {
              try {
                await publishGenerationJobUpdated({
                  projectId,
                  runId: run.id,
                  jobId: cancelledJob.id,
                  status: cancelledJob.status,
                  updatedAt: cancelledJob.updatedAt,
                })
              } catch {
                failures.push(safeFailure('job', cancelledJob.id, 'GENERATION_JOB_UPDATE_PUBLISH_FAILED'))
              }
            }
          },
        })
        if (outcome.job) {
          authoritativeJobs.push(await confirmGenerationWorkerRelease(outcome.job, failures))
        }
        if (outcome.cancelled) cancelledJobCount += 1
      } catch {
        failures.push(safeFailure('job', jobId, 'GENERATION_JOB_CANCEL_FAILED'))
      }
    }

    let cancelledRunCount = 0
    if (needsRunCancellation) {
      let latestRun = run
      try {
        latestRun = await productStore.readAgentRun(userId, run.id) ?? run
      } catch {
        failures.push(safeFailure('run', run.id, 'AGENT_RUN_REFRESH_FAILED'))
      }
      // Job terminal 是执行权威，Run 可能仍处于 terminal Job durable 与后置投影之间。
      // 先把本轮已读取的权威 Job 合入最新 Run，再只取消仍 active 的分支，避免把已经
      // succeeded 的分支写成 cancelled 并永久压住迟到 terminal 投影。
      const reconciledRun = authoritativeJobs.reduce(
        (current, authoritativeJob) => applyGenerationJobToAgentRun(current, authoritativeJob),
        latestRun,
      )
      const cancelledRun = cancelPersistentAgentRun(reconciledRun, { now: requestedAt })
      let storedRun = latestRun
      if (cancelledRun !== latestRun) {
        try {
          storedRun = await productStore.putAgentRun(userId, cancelledRun)
          cancelledRunCount = 1
          if (typeof publishAgentRunUpdated === 'function') {
            try {
              await publishAgentRunUpdated({
                projectId,
                runId: storedRun.id,
                status: storedRun.status,
                updatedAt: storedRun.updatedAt,
              })
            } catch {
              failures.push(safeFailure('run', run.id, 'AGENT_RUN_UPDATE_PUBLISH_FAILED'))
            }
          }
        } catch {
          failures.push(safeFailure('run', run.id, 'AGENT_RUN_CANCEL_FAILED'))
        }
      }

      await publishCancellation({
        scope: 'run',
        id: run.id,
        projectId,
        requestedAt,
      }, failures)
    }
    return { cancelledRunCount, cancelledJobCount }
  }

  async function cancelAgentRun(command) {
    const { userId, projectId, runId, requestedBy = userId } = command ?? {}
    if (!userId || !projectId || !runId) throw new TypeError('取消 Agent Run 缺少身份。')
    const failures = []
    let run
    try {
      run = await productStore.readAgentRun(userId, runId)
    } catch {
      return {
        kind: 'failed', runId, status: 'unknown', cancelledRunCount: 0, cancelledJobCount: 0,
        failures: [safeFailure('run', runId, 'AGENT_RUN_READ_FAILED')],
      }
    }
    if (!run || run.projectId !== projectId) {
      return {
        kind: 'not_found', runId, status: 'missing', cancelledRunCount: 0, cancelledJobCount: 0,
        failures,
      }
    }
    const requestedAt = Number(now()) || Date.now()
    const outcome = await cancelLinkedRun({ userId, projectId, run, requestedBy, requestedAt, failures })
    return {
      kind: runNeedsCancellation(run) ? 'cancelling' : 'already_settled',
      runId,
      status: outcome.cancelledRunCount ? 'cancelled' : run.status,
      ...outcome,
      failures,
    }
  }

  async function cancelAgentTurn(command) {
    const {
      userId,
      projectId,
      turnId,
      requestedBy = userId,
      reason = '用户取消了 Agent 回合。',
    } = command ?? {}
    if (!userId || !projectId || !turnId) throw new TypeError('取消 Agent Turn 缺少身份。')

    // 这是整个级联的 durable fence。它失败时绝不能继续取消下游，否则会留下一个
    // 表面仍可 delegation、下游却已被撤销的矛盾 Turn。
    const turn = await cancelTurn({ userId, projectId, turnId, reason })
    if (!turn || turn.projectId !== projectId) {
      return {
        kind: 'not_found', turnId, status: 'missing', linkedRunCount: 0,
        linkedSubagentCount: 0, cancelledRunCount: 0, cancelledJobCount: 0,
        cancelledSubagentCount: 0, failures: [],
      }
    }
    if (terminalTurnStatuses.has(turn.status)) {
      return {
        kind: 'already_settled', turnId, status: turn.status, linkedRunCount: 0,
        linkedSubagentCount: 0, cancelledRunCount: 0, cancelledJobCount: 0,
        cancelledSubagentCount: 0, failures: [],
      }
    }
    if (!cancellationFenceStatuses.has(turn.status)) {
      throw new AgentDelegationFenceError(
        'AGENT_TURN_CANCEL_FENCE_NOT_PERSISTED',
        'Agent Turn 取消状态尚未持久化，请重试取消。',
        503,
      )
    }

    const requestedAt = Number(now()) || Date.now()
    const failures = []
    await publishCancellation({ scope: 'turn', id: turnId, projectId, requestedAt }, failures)

    const linkedRuns = []
    const seenRunIds = new Set()
    let afterId
    while (true) {
      let page
      try {
        // 必须位于 cancelTurn 之后：run.turnId 是权威反向边，先列再落 fence 会让此处
        // 与新 delegation 竞态，漏掉刚创建的 Run。Turn 只有在权威反向边稳定分页
        // 全部遍历成功后才有资格 finalize。
        page = await productStore.listAgentRunsForTurnPage(
          userId,
          projectId,
          turnId,
          { afterId, limit: cancellationPageSize },
        )
      } catch {
        throw new AgentDelegationFenceError(
          'AGENT_TURN_LINKED_RUNS_READ_FAILED',
          'Agent Turn 已进入取消流程，但关联任务读取失败，请重试取消。',
          503,
        )
      }
      if (!Array.isArray(page)) {
        throw new AgentDelegationFenceError(
          'AGENT_TURN_LINKED_RUNS_READ_FAILED',
          'Agent Turn 已进入取消流程，但关联任务分页结果无效，请重试取消。',
          503,
        )
      }
      if (page.length === 0) break

      const priorCursor = afterId
      let lastId
      for (const run of page) {
        const runId = typeof run?.id === 'string' ? run.id : ''
        if (!runId.trim() || seenRunIds.has(runId)
          || run.ownerId !== userId || run.projectId !== projectId || run.turnId !== turnId) {
          throw new AgentDelegationFenceError(
            'AGENT_TURN_LINKED_RUNS_READ_FAILED',
            'Agent Turn 已进入取消流程，但关联任务分页结果不完整，请重试取消。',
            503,
          )
        }
        seenRunIds.add(runId)
        linkedRuns.push(run)
        lastId = runId
      }
      if (!lastId || lastId === priorCursor) {
        throw new AgentDelegationFenceError(
          'AGENT_TURN_LINKED_RUNS_READ_FAILED',
          'Agent Turn 已进入取消流程，但关联任务分页游标未推进，请重试取消。',
          503,
        )
      }
      afterId = lastId
      if (page.length < cancellationPageSize) break
    }

    const linkedSubagents = []
    const seenSubagentIds = new Set()
    afterId = undefined
    while (true) {
      let page
      try {
        // Subagent descriptor 的 rootTurnId 是权威反向边。与 Run 相同，必须在根 Turn
        // cancellation fence 落库后稳定遍历完整集合，才能封住并发 start/followup。
        page = await productStore.listAgentSubagentsForRootTurnPage(
          userId,
          projectId,
          turnId,
          { afterId, limit: cancellationPageSize },
        )
      } catch {
        throw new AgentDelegationFenceError(
          'AGENT_TURN_LINKED_SUBAGENTS_READ_FAILED',
          'Agent Turn 已进入取消流程，但关联 Subagent 读取失败，请重试取消。',
          503,
        )
      }
      if (!Array.isArray(page)) {
        throw new AgentDelegationFenceError(
          'AGENT_TURN_LINKED_SUBAGENTS_READ_FAILED',
          'Agent Turn 已进入取消流程，但关联 Subagent 分页结果无效，请重试取消。',
          503,
        )
      }
      if (page.length === 0) break

      const priorCursor = afterId
      let lastId
      for (const subagent of page) {
        const subagentId = typeof subagent?.id === 'string' ? subagent.id : ''
        if (!subagentId.trim() || seenSubagentIds.has(subagentId)
          || subagent.projectId !== projectId || subagent.rootTurnId !== turnId) {
          throw new AgentDelegationFenceError(
            'AGENT_TURN_LINKED_SUBAGENTS_READ_FAILED',
            'Agent Turn 已进入取消流程，但关联 Subagent 分页结果不完整，请重试取消。',
            503,
          )
        }
        seenSubagentIds.add(subagentId)
        linkedSubagents.push(subagent)
        lastId = subagentId
      }
      if (!lastId || lastId === priorCursor) {
        throw new AgentDelegationFenceError(
          'AGENT_TURN_LINKED_SUBAGENTS_READ_FAILED',
          'Agent Turn 已进入取消流程，但关联 Subagent 分页游标未推进，请重试取消。',
          503,
        )
      }
      afterId = lastId
      if (page.length < cancellationPageSize) break
    }

    let cancelledRunCount = 0
    let cancelledJobCount = 0
    for (const run of linkedRuns) {
      const outcome = await cancelLinkedRun({ userId, projectId, run, requestedBy, requestedAt, failures })
      cancelledRunCount += outcome.cancelledRunCount
      cancelledJobCount += outcome.cancelledJobCount
    }
    let cancelledSubagentCount = 0
    for (const subagent of linkedSubagents) {
      try {
        const outcome = await cancelSubagent({
          userId,
          projectId,
          subagentId: subagent.id,
          idempotencyKey: `agent-turn-cancel:${turnId}:subagent:${subagent.id}`,
          reason,
        })
        if (outcome?.subagent?.status === 'cancelled') {
          cancelledSubagentCount += 1
        } else {
          failures.push(safeFailure(
            'subagent',
            subagent.id,
            outcome?.subagent?.status === 'cancelling'
              ? 'AGENT_SUBAGENT_CANCEL_PENDING'
              : 'AGENT_SUBAGENT_CANCEL_FAILED',
          ))
        }
      } catch {
        failures.push(safeFailure('subagent', subagent.id, 'AGENT_SUBAGENT_CANCEL_FAILED'))
      }
    }
    let finalizedTurn = turn
    const hasBlockingFailure = failures.some((failure) => blockingCancellationFailureCodes.has(failure.code))
    if (!hasBlockingFailure && typeof finalizeTurn === 'function' && turn.status !== 'cancelled') {
      try {
        finalizedTurn = await finalizeTurn({ userId, projectId, turnId, reason }) ?? turn
      } catch {
        failures.push(safeFailure('turn', turnId, 'AGENT_TURN_FINALIZE_FAILED'))
      }
    }
    return {
      kind: finalizedTurn.status === 'cancelled' ? 'cancelled' : 'cancelling',
      turnId,
      status: finalizedTurn.status,
      linkedRunCount: linkedRuns.length,
      linkedSubagentCount: linkedSubagents.length,
      cancelledRunCount,
      cancelledJobCount,
      cancelledSubagentCount,
      failures,
    }
  }

  return { cancelAgentTurn, cancelAgentRun }
}
