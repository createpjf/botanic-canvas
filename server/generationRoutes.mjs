import { generationJobTimedOut, generationTimeoutForModel, timedOutGenerationJobPatch } from './generationModels.mjs'
import { cancelGenerationJob } from './generationCancellation.mjs'
import { publicGenerationJob } from './generationProvider.mjs'
import { reconcileGenerationResults } from './generationResultReconciliation.mjs'
import { requireProjectPermission } from './projectAuthorization.mjs'
import { compareAndSetGenerationJob } from './generationJobCas.mjs'

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
      // 判定与补丁都在 generationModels：同一条超时语义有两个产生点，
      // 就地各写一份迟早会漂移（此前这一份就漏了 errorCode）。
      if (generationJobTimedOut(job, { maximumTaskDurationMs })) {
        // 超时 CAS 可能终结一个已有部分输出的 running Job。先只 durable Job 并
        // 保留恢复标记；Canvas / Artifact 完成后再由 Processor 推进关联 Run。
        const failed = { ...job, ...timedOutGenerationJobPatch(), projectWritebackPending: true }
        const timeout = await compareAndSetGenerationJob(productStore, user.id, job, failed, { updateAgentRun: false })
        const authoritative = timeout?.job ?? job
        if (timeout?.changed && job.status === 'queued') await redisQueue?.cancel(job.id)
        return json(response, 200, publicGenerationJob(authoritative, { includeIdempotencyKey: authoritative.ownerId === user.id }))
      }
      return json(response, 200, publicGenerationJob(job, { includeIdempotencyKey: job.ownerId === user.id }))
    }

    if (jobMatch && request.method === 'POST' && jobMatch[2] === 'cancel') {
      const user = await requireUser(request)
      const jobId = decodeURIComponent(jobMatch[1])
      const job = await productStore.readGenerationJob(user.id, jobId)
      if (!job) return error(response, 404, 'JOB_NOT_FOUND', '未找到该真实生成任务。')
      // 取消的四个动作（判定、落库、出队、广播）都在这个共享实现里，
      // 重复取消也会拿到与第一次相同的判定。
      const result = await cancelGenerationJob({
        productStore, redisQueue, publishCancel,
        modelOptions: config.modelOptions ?? [],
        ownerId: user.id, job, reason: 'user', requestedBy: user.id,
      })
      return json(response, 200, {
        ...publicGenerationJob(result.job, { includeIdempotencyKey: result.job.ownerId === user.id }),
        cancelOutcome: result.outcome,
      })
    }

    return false
  }
}
