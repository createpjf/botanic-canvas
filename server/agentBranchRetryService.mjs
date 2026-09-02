// @ts-check
import { publicAgentRun } from './botanicAgentRun.mjs'
import { generationJobIdForIdempotency } from './generation/generationIdempotency.mjs'
import { createIdempotencyRequestBinding, matchingIdempotencyRequestBinding } from './idempotencyRequestBinding.mjs'
import { persistedGenerationJob, publicGenerationJob } from './generation/generationProvider.mjs'
import { retargetGenerationJobForRetry } from './generation/generationResultReconciliation.mjs'
import { compareAndSetGenerationJob } from './generation/generationJobCas.mjs'
import {
  canvasProjectMutationId,
  commitCanvasProjectMutation,
  supportsDurableCanvasGraphMutation,
} from './canvas/canvasGraphCommitService.mjs'

/**
 * 分支重试的唯一实现。
 *
 * 抽出来的原因不是「代码复用好看」，而是它有两个调用方（HTTP 路由与 Agent 运维工具），
 * 而**重试逻辑复制出错的代价是重复扣费**：任务标识由幂等键派生，两份实现只要有一处
 * 算法不同，同一次重试就会创建第二个 Job 并再扣一次额度。
 *
 * 返回判别联合而不是直接写 HTTP 响应：工具调用方没有 response 可写。
 *
 * @typedef {{ kind: 'error', status: number, code: string, message: string, retryAfterSeconds?: number }} BranchRetryError
 * @typedef {{ kind: 'reused', run: any, job: any }} BranchRetryReused
 * @typedef {{ kind: 'queued', run: any, job: any }} BranchRetryQueued
 */

/**
 * @param {{
 *   productStore: any, config: any, enqueue: (jobId: string) => Promise<any>,
 *   securityControls: any, publishProjectUpdated: any, publishAgentRunUpdated: any,
 *   agentRunGeneration: any,
 *   recordCollaborationActivity?: (actor: any, projectId: string, input: any) => Promise<any>,
 *   observeRun?: (event: any) => void,
 * }} input
 */
export function createAgentBranchRetryService({
  productStore,
  config,
  enqueue,
  securityControls,
  publishProjectUpdated,
  publishAgentRunUpdated,
  agentRunGeneration,
  recordCollaborationActivity = async () => {},
  observeRun = () => {},
}) {
  if (!productStore) throw new TypeError('分支重试服务缺少 ProductStore。')

  /**
   * @param {{ userId: string, runId: string, branchId: string, idempotencyKey: string, requestId?: string, actor?: any }} input
   * @returns {Promise<BranchRetryError | BranchRetryReused | BranchRetryQueued>}
   */
  return async function retryAgentBranch({ userId, runId, branchId, idempotencyKey, requestId, actor }) {
    if (!idempotencyKey) return { kind: 'error', status: 400, code: 'INVALID_IDEMPOTENCY_KEY', message: '分支重试标识无效，请重试。' }
    const run = await productStore.readAgentRun(userId, runId)
    if (!run) return { kind: 'error', status: 404, code: 'AGENT_RUN_NOT_FOUND', message: '未找到该 Agent Run。' }
    const branch = run.branches.find((candidate) => candidate.id === branchId)
    if (!branch) return { kind: 'error', status: 404, code: 'AGENT_BRANCH_NOT_FOUND', message: '未找到 Agent 分支。' }
    // 任务标识由幂等键派生：同一次重试请求重复到达时命中既有任务，不会重复扣费。
    const jobId = generationJobIdForIdempotency(userId, idempotencyKey)
    const existingJob = await productStore.readGenerationJob(userId, jobId)
    let storedJob
    if (existingJob) {
      // Legacy Job 没有 endpoint scope，无法证明它来自本分支的本次 attempt；
      // 不能用当前请求替它补绑定，否则跨入口 key 碰撞仍会错复用。
      if (!matchingIdempotencyRequestBinding(existingJob.idempotencyBinding, existingJob.idempotencyBinding)
        || existingJob.idempotencyBinding.scope !== 'agent-branch.retry'
        || existingJob.idempotencyBinding.projectId !== run.projectId
        || existingJob.projectId !== run.projectId
        || existingJob.agentRun?.runId !== runId
        || existingJob.agentRun?.branchId !== branchId) {
        return { kind: 'error', status: 409, code: 'IDEMPOTENCY_KEY_CONFLICT', message: '同一提交标识已绑定到另一份分支重试请求，请使用新的提交标识。' }
      }
      const currentRun = await productStore.readAgentRun(userId, runId)
      const currentBranch = currentRun?.branches?.find((candidate) => candidate.id === branchId)
      const orphanedQueued = existingJob.status === 'queued' && !existingJob.execution
        && currentBranch?.activeJobId === existingJob.id
        && Number(currentBranch?.attempt) === Number(existingJob.agentRun?.attempt)
      if (!orphanedQueued) {
        observeRun({ type: 'retry_reused', requestId, projectId: run.projectId, runId, branchId, jobId, status: currentRun?.status ?? run.status })
        return { kind: 'reused', run: publicAgentRun(currentRun), job: publicGenerationJob(existingJob, { includeIdempotencyKey: existingJob.ownerId === userId }) }
      }
      // Job 已落库但 enqueue 回执丢失：同 identity 再入幂等队列，不能永久留 queued。
      storedJob = existingJob
    } else {
      let sourceAttempt
      let sourceJobId
      let idempotencyBinding
      if (branch.retryClaim?.jobId === jobId) {
        sourceAttempt = Number(branch.retryClaim.sourceAttempt)
        sourceJobId = branch.retryClaim.sourceJobId
        idempotencyBinding = branch.retryClaim.idempotencyBinding
        if (!Number.isInteger(sourceAttempt) || sourceAttempt < 0
          || typeof sourceJobId !== 'string' || !sourceJobId
          || !matchingIdempotencyRequestBinding(idempotencyBinding, idempotencyBinding)
          || idempotencyBinding.scope !== 'agent-branch.retry'
          || idempotencyBinding.projectId !== run.projectId) {
          return { kind: 'error', status: 409, code: 'AGENT_BRANCH_RETRY_CONFLICT', message: '该分支重试身份不完整，无法安全恢复。' }
        }
      } else {
        if (!['failed', 'cancelled'].includes(branch.status)) {
          return { kind: 'error', status: 409, code: 'AGENT_BRANCH_RETRY_CONFLICT', message: '该分支已被另一项重试接管。' }
        }
        sourceAttempt = Number(branch.attempt) || 0
        sourceJobId = branch.activeJobId
        if (typeof sourceJobId !== 'string' || !sourceJobId) {
          return { kind: 'error', status: 409, code: 'AGENT_BRANCH_RETRY_SOURCE_MISSING', message: '该分支缺少可重试的原始生成参数。' }
        }
        idempotencyBinding = createIdempotencyRequestBinding({
          scope: 'agent-branch.retry',
          projectId: run.projectId,
          request: { runId, branchId, sourceAttempt, sourceJobId },
        })
      }
      const previousJob = await productStore.readGenerationJob(userId, sourceJobId)
      if (!previousJob?.rawInput || previousJob.projectId !== run.projectId
        || (previousJob.agentRun && (previousJob.agentRun.runId !== runId
          || previousJob.agentRun.branchId !== branchId
          || (Number.isInteger(previousJob.agentRun.attempt)
            && previousJob.agentRun.attempt !== sourceAttempt)))) {
        return { kind: 'error', status: 409, code: 'AGENT_BRANCH_RETRY_SOURCE_MISSING', message: '该分支缺少可重试的原始生成参数。' }
      }
      const rate = await securityControls.reserveMany({
        reservationId: `agent-branch-retry-output:${userId}:${run.projectId}:${runId}:${branchId}:${sourceAttempt}:${sourceJobId}`,
        windowMs: 24 * 60 * 60_000,
        entries: [{
          scope: 'generation-output',
          subject: userId,
          limit: config.security.generationOutputsPerDay,
          cost: previousJob.batchCount,
        }],
      })
      if (!rate.allowed) {
        return { kind: 'error', status: 429, code: 'RATE_LIMITED', message: '操作过于频繁，请稍后重试。', retryAfterSeconds: rate.retryAfterSeconds }
      }
      const requestedAt = Date.now()
      const job = persistedGenerationJob({
        ...previousJob,
        id: jobId,
        status: 'queued',
        idempotencyKey,
        createdAt: requestedAt,
        updatedAt: requestedAt,
        outputs: [],
        error: undefined,
        missingOutputCount: 0,
        partialError: undefined,
        idempotencyBinding,
        // 新 Job identity 不继承上一任务的 Worker fence；同 identity 重试才保留水位。
        executionVersion: undefined,
        execution: undefined,
        agentRun: { runId, branchId, attempt: sourceAttempt + 1 },
      })
      if (typeof productStore.claimAgentBranchRetry !== 'function') {
        throw new TypeError('ProductStore 缺少 Agent Branch retry 原子 claim 能力。')
      }
      const claim = await productStore.claimAgentBranchRetry(userId, {
        runId,
        projectId: run.projectId,
        branchId,
        expectedAttempt: sourceAttempt,
        expectedActiveJobId: sourceJobId,
        jobId,
        idempotencyBinding,
        job,
      })
      if (claim?.kind === 'missing') {
        return { kind: 'error', status: 404, code: 'AGENT_RUN_NOT_FOUND', message: '未找到该 Agent Run。' }
      }
      if (!['claimed', 'replay'].includes(claim?.kind)) {
        return { kind: 'error', status: 409, code: 'AGENT_BRANCH_RETRY_CONFLICT', message: '该分支已被另一项重试接管。' }
      }
      const retriedRun = claim.run
      const claimedBranch = retriedRun?.branches?.find((candidate) => candidate.id === branchId)
      if (claimedBranch?.activeJobId !== jobId
        || Number(claimedBranch?.attempt) !== sourceAttempt + 1
        || !matchingIdempotencyRequestBinding(claimedBranch?.retryClaim?.idempotencyBinding, idempotencyBinding)) {
        return { kind: 'error', status: 409, code: 'AGENT_BRANCH_RETRY_CONFLICT', message: '该分支已被另一项重试接管。' }
      }
      storedJob = claim.job
      if (!storedJob
        || !matchingIdempotencyRequestBinding(storedJob.idempotencyBinding, idempotencyBinding)
        || storedJob.projectId !== run.projectId
        || storedJob.agentRun?.runId !== runId
        || storedJob.agentRun?.branchId !== branchId
        || storedJob.agentRun?.attempt !== sourceAttempt + 1) {
        return { kind: 'error', status: 409, code: 'IDEMPOTENCY_KEY_CONFLICT', message: '同一提交标识已绑定到另一份分支重试请求，请使用新的提交标识。' }
      }
      const timestamp = Number(storedJob.createdAt)
        || Number(claimedBranch.retryClaim?.claimedAt)
        || Number(retriedRun.updatedAt)
        || requestedAt
      const project = await productStore.readProject(userId, run.projectId)
      const retarget = (document) => {
        const retargeted = retargetGenerationJobForRetry(document, previousJob.id, jobId, timestamp)
        return retargeted.changed ? retargeted.document : undefined
      }
      if (project && retarget(project.document)) {
        try {
          if (supportsDurableCanvasGraphMutation(productStore)) {
            const committed = await commitCanvasProjectMutation({
              productStore,
              userId,
              projectId: run.projectId,
              mutationId: canvasProjectMutationId('agent-retry', {
                sourceJobId: previousJob.id,
                jobId,
                attempt: storedJob.agentRun?.attempt,
              }),
              mutate: retarget,
            })
            if (committed?.changed && committed.saved) {
              await publishProjectUpdated(committed.saved, userId, committed.graphCommit)
            }
          } else {
            const document = retarget(project.document)
            const saved = await productStore.writeProject(userId, document, project.revision, project.graphRevision)
            await publishProjectUpdated(saved, userId)
          }
        } catch (caught) {
          const conflict = /** @type {any} */ (caught)?.code
          if (conflict === 'PROJECT_CONFLICT' || conflict === 'CANVAS_GRAPH_CONFLICT') {
            return { kind: 'error', status: 409, code: conflict, message: '画布刚刚发生变化，请用同一重试标识继续恢复该分支。' }
          }
          throw caught
        }
      }
      await recordCollaborationActivity(actor, run.projectId, {
        id: `agent-run-${retriedRun.id}-${retriedRun.updatedAt}`,
        kind: 'task',
        summary: `重试了任务「${retriedRun.plan?.summary || '生成任务'}」`,
        target: { kind: 'task', runId: retriedRun.id },
      })
    }
    // guarded put 可能返回并发重试已 claim/settle 的权威 Job。只给仍未 claim
    // 的 queued identity 入队；否则重复 enqueue 失败会误把真实 running Worker 终结。
    if (storedJob.status === 'queued' && !storedJob.execution) {
      try {
        await enqueue(storedJob.id)
      } catch {
        const failed = { ...storedJob, status: 'failed', error: '生成任务无法进入队列，请检查 Redis Worker 后重试。', updatedAt: Date.now() }
        const failure = await compareAndSetGenerationJob(productStore, userId, storedJob, failed)
        const authoritative = failure?.job ?? storedJob
        await agentRunGeneration.persistJobState(userId, run.projectId, authoritative)
        const failedRun = await productStore.readAgentRun(userId, runId)
        await publishAgentRunUpdated({ projectId: run.projectId, run: publicAgentRun(failedRun) })
        if (!failure?.changed) {
          observeRun({ type: 'retry_queued', requestId, projectId: run.projectId, runId, branchId, jobId, status: failedRun?.status ?? authoritative.status })
          return { kind: 'queued', run: publicAgentRun(failedRun), job: publicGenerationJob(authoritative, { includeIdempotencyKey: true }) }
        }
        observeRun({ type: 'retry_failed', requestId, projectId: run.projectId, runId, branchId, jobId, status: failedRun?.status ?? 'failed', code: 'QUEUE_UNAVAILABLE' })
        return { kind: 'error', status: 503, code: 'QUEUE_UNAVAILABLE', message: failed.error }
      }
    }
    const queuedRun = await productStore.readAgentRun(userId, runId)
    await publishAgentRunUpdated({ projectId: run.projectId, run: publicAgentRun(queuedRun) })
    observeRun({ type: 'retry_queued', requestId, projectId: run.projectId, runId, branchId, jobId, status: queuedRun?.status ?? 'queued' })
    return { kind: 'queued', run: publicAgentRun(queuedRun), job: publicGenerationJob(storedJob, { includeIdempotencyKey: true }) }
  }
}
