// @ts-check
import { prepareAgentBranchRetry, publicAgentRun } from './botanicAgentRun.mjs'
import { generationJobIdForIdempotency } from './generationIdempotency.mjs'
import { persistedGenerationJob, publicGenerationJob } from './generationProvider.mjs'
import { retargetGenerationJobForRetry } from './generationResultReconciliation.mjs'

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
    const previousJob = branch.activeJobId ? await productStore.readGenerationJob(userId, branch.activeJobId) : undefined
    if (!previousJob?.rawInput) {
      return { kind: 'error', status: 409, code: 'AGENT_BRANCH_RETRY_SOURCE_MISSING', message: '该分支缺少可重试的原始生成配方。' }
    }
    // 任务标识由幂等键派生：同一次重试请求重复到达时命中既有任务，不会重复扣费。
    const jobId = generationJobIdForIdempotency(userId, idempotencyKey)
    const existingJob = await productStore.readGenerationJob(userId, jobId)
    if (existingJob) {
      const currentRun = await productStore.readAgentRun(userId, runId)
      observeRun({ type: 'retry_reused', requestId, projectId: run.projectId, runId, branchId, jobId, status: currentRun?.status ?? run.status })
      return { kind: 'reused', run: publicAgentRun(currentRun), job: publicGenerationJob(existingJob, { includeIdempotencyKey: existingJob.ownerId === userId }) }
    }
    const rate = await securityControls.consume({
      scope: 'generation-output',
      subject: userId,
      limit: config.security.generationOutputsPerDay,
      windowMs: 24 * 60 * 60_000,
      cost: previousJob.batchCount,
    })
    if (!rate.allowed) {
      return { kind: 'error', status: 429, code: 'RATE_LIMITED', message: '操作过于频繁，请稍后重试。', retryAfterSeconds: rate.retryAfterSeconds }
    }
    const timestamp = Date.now()
    const retriedRun = prepareAgentBranchRetry(run, branchId, { jobId, now: timestamp })
    const job = {
      ...previousJob,
      id: jobId,
      status: 'queued',
      idempotencyKey,
      createdAt: timestamp,
      updatedAt: timestamp,
      outputs: [],
      error: undefined,
      missingOutputCount: 0,
      partialError: undefined,
      agentRun: { runId, branchId },
    }
    const project = await productStore.readProject(userId, run.projectId)
    const retargeted = project ? retargetGenerationJobForRetry(project.document, previousJob.id, jobId, timestamp) : { changed: false }
    if (project && retargeted.changed) {
      try {
        const saved = await productStore.writeProject(userId, retargeted.document, project.revision, project.graphRevision)
        await publishProjectUpdated(saved, userId)
      } catch (caught) {
        const conflict = /** @type {any} */ (caught)?.code
        if (conflict === 'PROJECT_CONFLICT' || conflict === 'CANVAS_GRAPH_CONFLICT') {
          return { kind: 'error', status: 409, code: conflict, message: '画布刚刚发生变化，请刷新后重试该分支。' }
        }
        throw caught
      }
    }
    await productStore.putAgentRun(userId, retriedRun)
    await recordCollaborationActivity(actor, run.projectId, {
      id: `agent-run-${retriedRun.id}-${retriedRun.updatedAt}`,
      kind: 'task',
      summary: `重试了任务「${retriedRun.plan?.summary || '生成任务'}」`,
      target: { kind: 'task', runId: retriedRun.id },
    })
    await productStore.putGenerationJob(userId, persistedGenerationJob(job))
    try {
      await enqueue(job.id)
    } catch {
      const failed = { ...job, status: 'failed', error: '生成任务无法进入队列，请检查 Redis Worker 后重试。', updatedAt: Date.now() }
      await productStore.putGenerationJob(userId, persistedGenerationJob(failed))
      await agentRunGeneration.persistJobState(userId, run.projectId, failed)
      const failedRun = await productStore.readAgentRun(userId, runId)
      await publishAgentRunUpdated({ projectId: run.projectId, run: publicAgentRun(failedRun) })
      observeRun({ type: 'retry_failed', requestId, projectId: run.projectId, runId, branchId, jobId, status: failedRun?.status ?? 'failed', code: 'QUEUE_UNAVAILABLE' })
      return { kind: 'error', status: 503, code: 'QUEUE_UNAVAILABLE', message: failed.error }
    }
    const queuedRun = await productStore.readAgentRun(userId, runId)
    await publishAgentRunUpdated({ projectId: run.projectId, run: publicAgentRun(queuedRun) })
    observeRun({ type: 'retry_queued', requestId, projectId: run.projectId, runId, branchId, jobId, status: queuedRun?.status ?? 'queued' })
    return { kind: 'queued', run: publicAgentRun(queuedRun), job: publicGenerationJob(job, { includeIdempotencyKey: true }) }
  }
}
