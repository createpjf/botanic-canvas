import { generationTimeoutForModel } from './generationModels.mjs'
import { persistedGenerationJob, publicGenerationJob } from './generationProvider.mjs'
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
  publishCancel,
  json,
  error,
  readJson,
  requireUser,
  submitGeneration,
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
      const reconciled = reconcileGenerationResults(project.document, jobs ?? [], { ensureAgentPlaceholders: true })
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
      const rawInput = await readJson(request)
      try {
        const submitted = await submitGeneration({
          user,
          rawInput,
          idempotencyKey: request.headers['idempotency-key'],
        })
        return json(response, 202, publicGenerationJob(submitted.job, { includeIdempotencyKey: true }))
      } catch (caught) {
        if (caught?.code === 'RATE_LIMITED') {
          return json(response, 429, { error: { code: caught.code, message: caught.message } }, {
            'Retry-After': String(caught.retryAfterSeconds ?? 1),
          })
        }
        throw caught
      }
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
        // 队列里移除只对尚未派发的任务有效，那也是唯一真能省下费用的路径。
        await redisQueue?.cancel(jobId)
        // 已在执行的任务需要通知 Worker 进程：它是独立进程，看不到这里写下的
        // cancelled，只会等 Provider 跑完再丢弃结果。广播后它就地 abort，
        // Provider 调用停下、worker 槽位释放。
        await publishCancel?.({ scope: 'job', id: jobId, projectId: job.projectId })
        return json(response, 200, publicGenerationJob(cancelled, { includeIdempotencyKey: cancelled.ownerId === user.id }))
      }
      return json(response, 200, publicGenerationJob(job, { includeIdempotencyKey: job.ownerId === user.id }))
    }

    return false
  }
}
