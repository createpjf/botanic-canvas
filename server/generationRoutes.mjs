import { generationIdempotencyKey, generationJobIdForIdempotency } from './generationIdempotency.mjs'
import { generationTimeoutForModel, providerForModel } from './generationModels.mjs'
import { persistedGenerationJob, publicGenerationJob, validateGenerationInput } from './generationProvider.mjs'
import { reconcileGenerationResults } from './generationResultReconciliation.mjs'
import { requireProjectPermission } from './projectAuthorization.mjs'

/**
 * 生成任务的提交、查询、取消与项目级结果对账模块。
 * 幂等键、额度扣减和终态持久化都在同一资源处理器内保持原子顺序。
 */
export function createGenerationRouteHandler({
  config,
  productStore,
  redisQueue,
  json,
  error,
  readJson,
  text,
  requireUser,
  enforceRateLimit,
  enqueue,
  publishProjectUpdated,
  projectResponseHeaders,
}) {
  return async function handleGenerationRoute(request, response, url, routeMatches) {
    const {
      projectGenerationJobs: projectGenerationJobsMatch,
      projectGenerationReconcile: projectGenerationReconcileMatch,
      generationJob: jobMatch,
    } = routeMatches

    if (projectGenerationJobsMatch && request.method === 'GET') {
      const user = await requireUser(request)
      const projectId = decodeURIComponent(projectGenerationJobsMatch[1])
      await requireProjectPermission(productStore, user.id, projectId, 'read')
      const jobs = await productStore.listGenerationJobsForProject(user.id, projectId, Number(url.searchParams.get('limit') ?? 60))
      if (!jobs) return error(response, 404, 'PROJECT_NOT_FOUND', '未找到项目或你没有访问权限。')
      return json(response, 200, {
        jobs: jobs.map((job) => publicGenerationJob(job, { includeIdempotencyKey: job.ownerId === user.id })),
      })
    }

    if (projectGenerationReconcileMatch && request.method === 'POST') {
      const user = await requireUser(request)
      const projectId = decodeURIComponent(projectGenerationReconcileMatch[1])
      await requireProjectPermission(productStore, user.id, projectId, 'edit')
      const project = await productStore.readProject(user.id, projectId)
      if (!project) return error(response, 404, 'PROJECT_NOT_FOUND', '未找到项目或你没有访问权限。')
      const jobs = await productStore.listGenerationJobsForProject(user.id, projectId, 120)
      const reconciled = reconcileGenerationResults(project.document, jobs ?? [])
      if (!reconciled.changed) return json(response, 200, { ...project, changed: false }, projectResponseHeaders(project))
      try {
        const saved = await productStore.writeProject(user.id, reconciled.document, project.revision, project.graphRevision)
        await publishProjectUpdated(saved, user.id)
        return json(response, 200, { ...saved, changed: true }, projectResponseHeaders(saved))
      } catch (caught) {
        if (caught?.code === 'PROJECT_CONFLICT' || caught?.code === 'CANVAS_GRAPH_CONFLICT') return error(response, 409, caught.code, caught.message)
        return error(response, 403, 'PROJECT_WRITE_FORBIDDEN', caught instanceof Error ? caught.message : '历史结果回填失败。')
      }
    }

    if (url.pathname === '/api/generation-jobs') {
      if (request.method !== 'POST') {
        return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '生成任务集合接口只接受提交请求。' } }, {
          Allow: 'POST',
        })
      }
      const user = await requireUser(request)
      const idempotencyKey = generationIdempotencyKey(request.headers['idempotency-key'])
      if (!idempotencyKey) return error(response, 400, 'INVALID_IDEMPOTENCY_KEY', '任务提交标识无效，请刷新页面后重试。')
      const rawInput = await readJson(request)
      const input = validateGenerationInput(rawInput, {
        models: config.modelOptions?.length ? config.modelOptions : config.models,
        maximumBatchCount: config.maximumBatchCount,
        maximumReferenceBytes: config.maximumReferenceBytes,
      })
      const selectedModel = providerForModel(config.modelOptions ?? [], input.settings.model)
      if (!selectedModel) return error(response, 503, 'PROVIDER_NOT_CONFIGURED', '所选生成模型尚未配置，请检查对应供应商 API Key。')
      await requireProjectPermission(productStore, user.id, input.projectId, 'edit')
      let agentRun
      if (rawInput.agentRun !== undefined) {
        const runId = text(rawInput.agentRun?.runId, 'Agent Run', 160)
        const branchId = text(rawInput.agentRun?.branchId, 'Agent 分支', 160)
        const run = await productStore.readAgentRun(user.id, runId)
        if (!run || run.projectId !== input.projectId) return error(response, 404, 'AGENT_RUN_NOT_FOUND', '未找到当前项目的 Agent Run。')
        if (!run.branches.some((branch) => branch.id === branchId)) return error(response, 404, 'AGENT_BRANCH_NOT_FOUND', '未找到 Agent 分支。')
        agentRun = { runId, branchId }
      }
      const id = generationJobIdForIdempotency(user.id, idempotencyKey)
      const existing = await productStore.readGenerationJob(user.id, id)
      if (existing) return json(response, 202, publicGenerationJob(existing, { includeIdempotencyKey: existing.ownerId === user.id }))
      if (!await enforceRateLimit(response, {
        scope: 'generation-output', subject: user.id,
        limit: config.security.generationOutputsPerDay, windowMs: 24 * 60 * 60_000,
        cost: input.batchCount,
      })) return true
      const timestamp = Date.now()
      const job = {
        id, ownerId: user.id, projectId: input.projectId, status: 'queued', kind: input.kind,
        createdAt: timestamp, updatedAt: timestamp, batchCount: input.batchCount, settings: input.settings,
        provider: selectedModel.provider === 'minimax'
          ? selectedModel.mediaKind === 'video' ? 'minimax-video' : 'minimax-image'
          : 'openai-images',
        refinementMode: input.refinementMode,
        idempotencyKey,
        outputs: [], error: undefined, rawInput, agentRun,
      }
      await productStore.putGenerationJob(user.id, persistedGenerationJob(job))
      try {
        await enqueue(job.id)
      } catch {
        const failed = { ...job, status: 'failed', error: '生成任务无法进入队列，请检查 Redis Worker 后重试。', updatedAt: Date.now() }
        await productStore.putGenerationJob(user.id, persistedGenerationJob(failed))
        return error(response, 503, 'QUEUE_UNAVAILABLE', failed.error)
      }
      return json(response, 202, publicGenerationJob(job, { includeIdempotencyKey: true }))
    }

    if (jobMatch && request.method === 'GET' && !jobMatch[2]) {
      const user = await requireUser(request)
      const job = await productStore.readGenerationJob(user.id, decodeURIComponent(jobMatch[1]))
      if (!job) return error(response, 404, 'JOB_NOT_FOUND', '未找到该真实生成任务。')
      const maximumTaskDurationMs = generationTimeoutForModel(config.modelOptions ?? [], job.settings?.model, {
        imageTimeoutMs: config.generationTimeoutMs ?? 5 * 60_000,
        videoTimeoutMs: config.videoGenerationTimeoutMs ?? 20 * 60_000,
      })
      if ((job.status === 'queued' || job.status === 'running') && Date.now() - job.createdAt >= maximumTaskDurationMs) {
        const failed = {
          ...job,
          status: 'failed',
          error: '生成任务超过模型等待时限，已停止，请稍后重试。',
          updatedAt: Date.now(),
        }
        await productStore.putGenerationJob(user.id, persistedGenerationJob(failed))
        if (job.status === 'queued') await redisQueue?.cancel(job.id)
        return json(response, 200, publicGenerationJob(failed, { includeIdempotencyKey: failed.ownerId === user.id }))
      }
      return json(response, 200, publicGenerationJob(job, { includeIdempotencyKey: job.ownerId === user.id }))
    }

    if (jobMatch && request.method === 'POST' && jobMatch[2] === 'cancel') {
      const user = await requireUser(request)
      const jobId = decodeURIComponent(jobMatch[1])
      const job = await productStore.readGenerationJob(user.id, jobId)
      if (!job) return error(response, 404, 'JOB_NOT_FOUND', '未找到该真实生成任务。')
      if (job.status === 'queued' || job.status === 'running') {
        const cancelled = { ...job, status: 'cancelled', error: undefined, updatedAt: Date.now() }
        await productStore.putGenerationJob(user.id, persistedGenerationJob(cancelled))
        await redisQueue?.cancel(jobId)
        return json(response, 200, publicGenerationJob(cancelled, { includeIdempotencyKey: cancelled.ownerId === user.id }))
      }
      return json(response, 200, publicGenerationJob(job, { includeIdempotencyKey: job.ownerId === user.id }))
    }

    return false
  }
}
