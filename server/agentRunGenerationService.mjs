import { persistedGenerationJob } from './generationProvider.mjs'
import { failUnsubmittedPersistentAgentRun, publicAgentRun } from './botanicAgentRun.mjs'
import { prepareAgentRunExecution, reconcileAgentGenerationJobToProject } from './botanicAgentExecution.mjs'
import { AgentToolRuntimeError } from './agentToolRuntime.mjs'
import { generationJobIdForIdempotency } from './generationIdempotency.mjs'
import { buildGenerationUsage, reserveGenerationBudget } from './generationGovernance.mjs'

/**
 * Agent Run 确认后的唯一生成提交模块。路由只调用这个小接口；配额、幂等、
 * 画布占位、队列失败回写和实时发布全部留在同一实现中。
 */
export function createAgentRunGenerationService({
  config,
  productStore,
  securityControls,
  enqueue,
  publishProjectUpdated,
  publishAgentRunUpdated,
}) {
  async function prepareProjectExecution(userId, projectId, runId, { submission }) {
    const run = await productStore.readAgentRun(userId, runId)
    if (!run || run.projectId !== projectId) {
      throw new AgentToolRuntimeError('AGENT_RUN_NOT_FOUND', '未找到当前项目的 Agent Run。', 404)
    }
    const project = await productStore.readProject(userId, projectId)
    if (!project) throw new AgentToolRuntimeError('PROJECT_NOT_FOUND', '未找到当前项目。', 404)
    const prepared = prepareAgentRunExecution({
      run,
      document: project.document,
      submission,
      models: config.modelOptions?.length ? config.modelOptions : config.models,
      maximumBatchCount: config.maximumBatchCount,
      maximumReferenceBytes: config.maximumReferenceBytes,
      jobIdForBranch: (branch) => generationJobIdForIdempotency(
        userId,
        `${run.id}:${branch.id}:attempt-${branch.attempt ?? 0}`,
      ),
    })
    return { run, project, prepared }
  }

  async function persistWorkflow(userId, project, prepared) {
    try {
      const saved = await productStore.writeProject(
        userId,
        prepared.document,
        project.revision,
        project.graphRevision,
      )
      await publishProjectUpdated(saved, userId)
      return saved
    } catch (caught) {
      if (caught?.code === 'PROJECT_CONFLICT' || caught?.code === 'CANVAS_GRAPH_CONFLICT') {
        throw new AgentToolRuntimeError(caught.code, '画布刚刚发生变化，请刷新后重新执行 Agent 计划。', 409)
      }
      throw caught
    }
  }

  async function persistJobState(userId, projectId, job) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const project = await productStore.readProject(userId, projectId)
      if (!project) return
      const reconciled = reconcileAgentGenerationJobToProject(project.document, job)
      if (!reconciled.changed) return
      try {
        const saved = await productStore.writeProject(
          userId,
          reconciled.document,
          project.revision,
          project.graphRevision,
        )
        await publishProjectUpdated(saved, userId)
        return
      } catch (caught) {
        if (caught?.code !== 'PROJECT_CONFLICT' && caught?.code !== 'CANVAS_GRAPH_CONFLICT') throw caught
      }
    }
    throw new AgentToolRuntimeError('AGENT_WRITEBACK_CONFLICT', '任务状态回写连续冲突，请刷新画布后重试。', 409)
  }

  async function submitGenerationOnce(userId, projectId, runId) {
    const { run, project, prepared } = await prepareProjectExecution(userId, projectId, runId, { submission: true })
    const existingJobs = new Map()
    for (const job of prepared.jobs) existingJobs.set(job.id, await productStore.readGenerationJob(userId, job.id))
    const pendingJobs = prepared.jobs.filter((job) => !existingJobs.get(job.id))
    const outputCost = pendingJobs.reduce((total, job) => total + job.batchCount, 0)
    if (outputCost) {
      const quota = await securityControls.consume({
        scope: 'generation-output', subject: userId,
        limit: config.security.generationOutputsPerDay, windowMs: 24 * 60 * 60_000,
        cost: outputCost,
      })
      if (!quota.allowed) throw new AgentToolRuntimeError('RATE_LIMITED', '今日生成额度已用完，请稍后重试。', 429)
    }
    for (const job of pendingJobs) {
      const model = (config.modelOptions ?? []).find((candidate) => candidate.id === job.settings?.model)
      const usage = buildGenerationUsage(job.rawInput ?? job, {
        jobId: job.id,
        memberId: userId,
        mediaKind: model?.mediaKind ?? 'image',
        provider: model?.provider ?? job.provider,
      })
      const budget = await reserveGenerationBudget({ securityControls, usage, limits: config.generationBudgets })
      if (!budget.allowed) throw new AgentToolRuntimeError('GENERATION_BUDGET_EXCEEDED', '生成额度不足，请降低输出规格或联系工作区所有者。', 402)
      job.usage = usage
      if (budget.warning) job.budgetWarning = '生成额度接近上限。'
    }
    await persistWorkflow(userId, project, prepared)
    const queueFailures = []
    for (const job of pendingJobs) {
      await productStore.putGenerationJob(userId, persistedGenerationJob(job))
      try {
        await enqueue(job.id)
      } catch {
        const failed = { ...job, status: 'failed', error: '生成任务无法进入队列，请检查 Redis Worker 后重试。', updatedAt: Date.now() }
        await productStore.putGenerationJob(userId, persistedGenerationJob(failed))
        await persistJobState(userId, projectId, failed)
        queueFailures.push(failed)
      }
    }
    const latestRun = await productStore.readAgentRun(userId, run.id) ?? run
    await publishAgentRunUpdated({ projectId, run: publicAgentRun(latestRun) })
    if (queueFailures.length) throw new AgentToolRuntimeError('QUEUE_UNAVAILABLE', queueFailures[0].error, 503)
    return { run: latestRun, jobs: prepared.jobs, workflows: prepared.workflows }
  }

  async function submitGeneration(userId, projectId, runId) {
    try {
      return await submitGenerationOnce(userId, projectId, runId)
    } catch (caught) {
      // 4xx 代表这次请求在当前画布/配额/权限下已确定无法提交。
      // 收口为 failed 后 UI 可给出明确调整/重试入口，避免每 4 秒无限重打。
      // 5xx/网络等未知错误仍保留 queued，交给幂等恢复器再确认。
      if (caught instanceof AgentToolRuntimeError && caught.statusCode >= 400 && caught.statusCode < 500) {
        const run = await productStore.readAgentRun(userId, runId)
        const failed = failUnsubmittedPersistentAgentRun(run, caught.message)
        if (failed && failed !== run) {
          await productStore.putAgentRun(userId, failed)
          await publishAgentRunUpdated({ projectId, run: publicAgentRun(failed) })
        }
      }
      throw caught
    }
  }

  return { prepareProjectExecution, persistWorkflow, persistJobState, submitGeneration }
}
