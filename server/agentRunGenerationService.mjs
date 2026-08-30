import { persistedGenerationJob } from './generationProvider.mjs'
import { failUnsubmittedPersistentAgentRun, publicAgentRun } from './botanicAgentRun.mjs'
import { prepareAgentRunExecution, reconcileAgentGenerationJobToProject } from './botanicAgentExecution.mjs'
import { AgentToolRuntimeError } from './agentToolRuntime.mjs'
import { generationJobIdForIdempotency } from './generationIdempotency.mjs'
import { buildGenerationUsage, reserveGenerationBudget } from './generationGovernance.mjs'
import { agentRunCompiledPlanProvenance, compileRunCreativePlan } from './creativePlanResolver.mjs'
import { findBrandKit, globalBrandKitLibraryId } from './brandKit.mjs'
import { AgentDelegationFenceError, assertTurnAllowsDelegation } from './agentCancellationService.mjs'
import { cancelGenerationJob } from './generationCancellation.mjs'
import { compareAndSetGenerationJob } from './generationJobCas.mjs'
import { assertAgentTargetBinding } from './agentTargetBinding.mjs'

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
  mediaService,
}) {
  const sameAgentRunBranch = (left, right) => left?.runId === right?.runId && left?.branchId === right?.branchId

  /**
   * 乐观写冲突只在另一提交者已经落下同一组确定性工作流时可当成幂等成功。
   * 只看节点 id 不够：用户也可能创建同名节点；Job、Run/branch 边与生成/结果节点
   * 必须同时吻合。状态允许继续推进，不能用整对象相等把 running/succeeded 误判成冲突。
   */
  function containsPreparedWorkflow(document, prepared) {
    if (!prepared.jobs.length || prepared.jobs.length !== prepared.workflows.length) return false
    const jobs = new Map((document?.generationJobs ?? []).map((job) => [job.id, job]))
    const nodes = new Map((document?.nodes ?? []).map((node) => [node.id, node]))
    return prepared.jobs.every((job, index) => {
      const storedJob = jobs.get(job.id)
      const workflow = prepared.workflows[index]
      const generateNode = nodes.get(workflow?.generateNodeId)
      const resultNode = nodes.get(workflow?.resultNodeId)
      const promptNode = nodes.get(workflow?.promptNodeId)
      return sameAgentRunBranch(storedJob?.agentRun, job.agentRun)
        && generateNode?.data?.jobId === job.id
        && resultNode?.data?.jobId === job.id
        && sameAgentRunBranch(generateNode?.data?.agentRun, job.agentRun)
        && sameAgentRunBranch(resultNode?.data?.agentRun, job.agentRun)
        && Boolean(promptNode)
    })
  }

  /**
   * 读取工作区全局品牌套件。品牌库读失败**不阻断生成**：那会让一次存储抖动
   * 变成「所有生成都提交不了」。但也不能静默按无品牌继续 —— 那是悄悄丢掉品牌约束。
   * 折中是让它按缺失处理并抛出可诊断错误，交由上层阻断；这里只负责取。
   */
  async function readGlobalBrandKit(userId, brandId) {
    if (typeof brandId !== 'string' || !brandId.trim()) return undefined
    const library = await productStore.readGlobalAssetLibrary(userId, globalBrandKitLibraryId)
    return findBrandKit(library, brandId)
  }

  async function prepareProjectExecution(userId, projectId, runId, { submission }) {
    const run = await productStore.readAgentRun(userId, runId)
    if (!run || run.projectId !== projectId) {
      throw new AgentToolRuntimeError('AGENT_RUN_NOT_FOUND', '未找到当前项目的 Agent Run。', 404)
    }
    const project = await productStore.readProject(userId, projectId)
    if (!project) throw new AgentToolRuntimeError('PROJECT_NOT_FOUND', '未找到当前项目。', 404)
    if (run.plan?.targetBinding) {
      await assertAgentTargetBinding(project.document, {
        hasTarget: true,
        selectedResultNodeId: run.plan.selectedResultNodeId,
        targetBinding: run.plan.targetBinding,
      }, {
        resolveMedia: mediaService?.enabled
          ? (mediaId, options) => mediaService.readGenerationInput(userId, mediaId, projectId, options)
          : undefined,
        projectRevision: project.revision,
      })
    }
    const models = config.modelOptions?.length ? config.modelOptions : config.models
    // 首次执行时把编译快照落到 Run 上（ADR 0005 不变量一）。
    //
    // 为什么不在创建 Run 时编译：客户端确认后先创建 Run、再 flush 画布写入，因此
    // 创建那一刻服务端文档里可能还没有计划引用的节点，编译会因「引用不存在」失败。
    // 首次执行是文档已经权威、且尚未调用 Provider 的最早时点 —— 阻断仍在花钱之前，
    // 而重试与恢复从此只读快照，不会因模型目录或绑定变动而漂移。
    const executableRun = agentRunCompiledPlanProvenance(run) === 'compiled_v2'
      ? run
      : {
        ...run,
        compiledPlan: compileRunCreativePlan({
          run,
          document: project.document,
          models,
          // 只在项目确实绑定了品牌时才去读全局套件：未绑定的项目不该为品牌库多付一次
          // 存储往返，更不该被套上一份它没选过的「默认品牌」。
          globalBrandKit: await readGlobalBrandKit(userId, project.document?.brandId),
          // evaluator Skill 作为自定义评审判据固定进质量策略（Epic 6 × Epic 11）。
          // 存储没实现这个读取口时按「没有自定义判据」处理，而不是让整条提交路径挂掉 ——
          // 自定义判据是增量能力，它不可用不该阻断生成本身。
          projectSkills: await productStore.listAgentSkills?.(userId, projectId) ?? [],
        }),
      }
    // 预览不落库：它反映的文档状态可能还会变，锁死快照会把预览当成确认。
    const storedRun = executableRun === run || !submission
      ? executableRun
      : await productStore.putAgentRun(userId, executableRun) ?? executableRun
    const prepared = prepareAgentRunExecution({
      run: storedRun,
      document: project.document,
      submission,
      models,
      maximumBatchCount: config.maximumBatchCount,
      maximumReferenceBytes: config.maximumReferenceBytes,
      jobIdForBranch: (branch) => generationJobIdForIdempotency(
        userId,
        `${run.id}:${branch.id}:attempt-${branch.attempt ?? 0}`,
      ),
    })
    return { run: storedRun, project, prepared }
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
        const latest = await productStore.readProject(userId, project.document.id)
        if (latest && containsPreparedWorkflow(latest.document, prepared)) return latest
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

  async function enforceDelegationAfterJobPut(userId, projectId, run, job) {
    try {
      if (run.turnId) {
        await assertTurnAllowsDelegation({ productStore, userId, projectId, turnId: run.turnId })
      }
      const latestRun = await productStore.readAgentRun(userId, run.id)
      if (!latestRun || latestRun.projectId !== projectId) {
        throw new AgentToolRuntimeError('AGENT_RUN_NOT_FOUND', '未找到当前项目的 Agent Run。', 404)
      }
      if (latestRun.status === 'cancelled') {
        throw new AgentDelegationFenceError(
          'AGENT_RUN_DELEGATION_CANCELLED',
          'Agent Run 已取消，不能再提交关联 Generation Job。',
          409,
        )
      }
      return job
    } catch (caught) {
      // 这个 Job 还没有 enqueue，不需要撤队列或广播 Worker；先把权威 Job durable
      // 收口为 cancelled，再抛原 fence 错误，避免 Turn/Run 已取消后留下孤儿 queued Job。
      const cancelled = await cancelGenerationJob({
        productStore,
        ownerId: userId,
        job,
        reason: 'agent-run',
        requestedBy: userId,
      })
      // 画布是兼容投影，不得让它的冲突覆盖权威取消错误；后续对账仍可重建。
      await persistJobState(userId, projectId, cancelled.job).catch(() => undefined)
      throw caught
    }
  }

  async function submitGenerationOnce(userId, projectId, runId) {
    const { run, project, prepared } = await prepareProjectExecution(userId, projectId, runId, { submission: true })
    if (run.turnId) {
      await assertTurnAllowsDelegation({ productStore, userId, projectId, turnId: run.turnId })
    }
    const existingJobs = new Map()
    for (const job of prepared.jobs) existingJobs.set(job.id, await productStore.readGenerationJob(userId, job.id))
    const pendingJobs = prepared.jobs.filter((job) => !existingJobs.get(job.id))
    const outputCost = pendingJobs.reduce((total, job) => total + job.batchCount, 0)
    if (outputCost) {
      const quota = await securityControls.reserveMany({
        reservationId: `agent-run-generation-output:${userId}:${projectId}:${run.id}`,
        windowMs: 24 * 60 * 60_000,
        entries: [{
          scope: 'generation-output',
          subject: userId,
          limit: config.security.generationOutputsPerDay,
          cost: outputCost,
        }],
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
      // 每个 Job 写入前都重读 durable fence。至少首个提交必须被挡住；逐个检查还能
      // 在多分支提交途中收到取消时停止创建后续 Job，已创建的由深取消收口。
      if (run.turnId) {
        await assertTurnAllowsDelegation({ productStore, userId, projectId, turnId: run.turnId })
      }
      const storedJob = await productStore.putGenerationJob(userId, persistedGenerationJob(job))
        ?? persistedGenerationJob(job)
      Object.assign(job, storedJob)
      await enforceDelegationAfterJobPut(userId, projectId, run, storedJob)
      // 同一确定性 Job 的并发提交可能已经被另一请求入队并 claim/settle。
      // guarded put 返回的权威状态不是 queued 时无需重复入队，更不能把网络失败
      // 误解释成 running→failed。
      if (storedJob.status !== 'queued' || storedJob.execution) continue
      try {
        await enqueue(storedJob.id)
      } catch {
        const failed = { ...storedJob, status: 'failed', error: '生成任务无法进入队列，请检查 Redis Worker 后重试。', updatedAt: Date.now() }
        const failure = await compareAndSetGenerationJob(productStore, userId, storedJob, failed)
        const authoritative = failure?.job ?? storedJob
        Object.assign(job, authoritative)
        await persistJobState(userId, projectId, authoritative)
        // enqueue 的响应可能丢失，但 Job 已被 Worker claim。CAS 输掉时以 Store 为准。
        if (failure?.changed) queueFailures.push(authoritative)
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
