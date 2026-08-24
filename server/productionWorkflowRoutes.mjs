import {
  applyWorkflowItemResult,
  createProductionWorkflowRun,
  createProductionWorkflowVersion,
  productionWorkflowVersion,
  resolveProductionWorkflowRecipe,
  retryFailedWorkflowItems,
  transitionProductionWorkflowRun,
} from './productionWorkflow.mjs'
import { persistedGenerationJob, publicGenerationJob } from './generationProvider.mjs'
import { requireProjectPermission } from './projectAuthorization.mjs'

const clone = (value) => structuredClone(value)

function interpolate(prompt, variables = {}) {
  return prompt.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, key) => variables[key] === undefined ? `{{${key}}}` : String(variables[key]))
}

function workflowInput(workflow, run, item, document) {
  const definition = run.definition
  const override = item.input?.rawInput ?? {}
  const settings = {
    ...clone(definition.settings ?? {}),
    ...clone(override.settings ?? {}),
    model: override.settings?.model ?? definition.model,
  }
  delete settings.batchCount
  return {
    projectId: workflow.projectId,
    kind: override.kind ?? 'generation',
    prompt: override.prompt ?? interpolate(definition.prompt, item.input?.variables),
    batchCount: override.batchCount ?? definition.settings?.batchCount ?? 1,
    settings,
    recipe: clone(override.recipe ?? item.input?.recipe ?? resolveProductionWorkflowRecipe(definition, document)),
    ...(override.parent ? { parent: clone(override.parent) } : {}),
    productionWorkflow: {
      workflowId: workflow.id,
      workflowVersion: run.workflowVersion,
      workflowRunId: run.id,
      workflowItemId: item.id,
      sourceVersionId: item.input?.sourceVersionId,
    },
  }
}

function documents(value) {
  return {
    workflows: Array.isArray(value?.productionWorkflows) ? value.productionWorkflows : [],
    runs: Array.isArray(value?.productionWorkflowRuns) ? value.productionWorkflowRuns : [],
  }
}

/** 生产工作流保存在项目文档的兼容扩展区；独立任务、Artifact 与画布图谱仍是权威。 */
export function createProductionWorkflowRouteHandler({
  productStore,
  json,
  error,
  readJson,
  requireUser,
  submitGeneration,
  redisQueue,
  publishProjectUpdated,
}) {
  async function updateProject(userId, projectId, mutate) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const project = await productStore.readProject(userId, projectId)
      if (!project) return undefined
      const document = mutate(clone(project.document))
      try {
        const saved = await productStore.writeProject(userId, document, project.revision, project.graphRevision)
        await publishProjectUpdated(saved, userId)
        return saved
      } catch (caught) {
        if (!['PROJECT_CONFLICT', 'CANVAS_GRAPH_CONFLICT'].includes(caught?.code) || attempt === 4) throw caught
      }
    }
    return undefined
  }

  async function reconcileRun(user, project, run) {
    let next = clone(run)
    let changed = false
    for (const item of next.items) {
      if (!item.jobId) continue
      const job = await productStore.readGenerationJob(user.id, item.jobId)
      // Generation Job 的 queued 在工作流中表示已接管、等待 Worker；不能把它
      // 当成未知状态写入工作流状态机，否则恢复读取会直接抛错并返回 500。
      const workflowStatus = job?.status === 'queued' ? 'running' : job?.status
      if (!job || item.status === workflowStatus) continue
      const artifacts = (job.outputs ?? []).map((output) => `generation:${job.id}:${output.id}`)
      const canvasNodeIds = (project.document.nodes ?? []).filter((node) => node?.type === 'result'
        && node?.data?.jobId === job.id).map((node) => node.id)
      next = applyWorkflowItemResult(next, item.id, {
        status: workflowStatus,
        jobId: job.id,
        artifactIds: artifacts,
        canvasNodeIds,
        ...(job.error ? { error: { code: 'GENERATION_FAILED', message: job.error } } : {}),
      })
      changed = true
    }
    return { run: next, changed }
  }

  async function dispatchItems(user, workflow, run, document, itemIds = run.items.map((item) => item.id), retryExisting = false) {
    let next = run.status === 'queued' ? transitionProductionWorkflowRun(run, 'start') : clone(run)
    for (const itemId of itemIds) {
      const item = next.items.find((entry) => entry.id === itemId)
      if (!item) continue
      try {
        const submitted = await submitGeneration({
          user,
          rawInput: workflowInput(workflow, next, item, document),
          idempotencyKey: item.idempotencyKey,
          retryExisting,
        })
        next = applyWorkflowItemResult(next, item.id, {
          status: submitted.job.status === 'queued' ? 'running' : submitted.job.status,
          jobId: submitted.job.id,
        })
      } catch (caught) {
        next = applyWorkflowItemResult(next, item.id, {
          status: 'failed',
          error: { code: caught?.code ?? 'WORKFLOW_ITEM_SUBMIT_FAILED', message: caught instanceof Error ? caught.message : String(caught) },
        })
      }
    }
    return next
  }

  return async function handleProductionWorkflowRoute(request, response, _url, matches) {
    const collectionMatch = matches.projectProductionWorkflows
    const workflowMatch = matches.projectProductionWorkflow
    const runsMatch = matches.projectProductionWorkflowRuns
    const runMatch = matches.projectProductionWorkflowRun

    if (collectionMatch) {
      const user = await requireUser(request)
      const projectId = decodeURIComponent(collectionMatch[1])
      if (request.method === 'GET') {
        await requireProjectPermission(productStore, user.id, projectId, 'read')
        const project = await productStore.readProject(user.id, projectId)
        if (!project) return error(response, 404, 'PROJECT_NOT_FOUND', '未找到项目或你没有访问权限。')
        return json(response, 200, { workflows: documents(project.document).workflows })
      }
      if (request.method === 'POST') {
        await requireProjectPermission(productStore, user.id, projectId, 'modify-workflow')
        const body = await readJson(request)
        let created
        const saved = await updateProject(user.id, projectId, (document) => {
          const state = documents(document)
          const existing = state.workflows.find((workflow) => workflow.id === body.id)
          created = createProductionWorkflowVersion({
            id: body.id,
            projectId,
            name: body.name,
            definition: body.definition,
            previous: existing,
          }, { actorId: user.id })
          return { ...document, productionWorkflows: [...state.workflows.filter((workflow) => workflow.id !== created.id), created] }
        })
        if (!saved) return error(response, 404, 'PROJECT_NOT_FOUND', '未找到项目或你没有访问权限。')
        return json(response, 201, { workflow: created })
      }
      return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '生产工作流集合不支持该请求方法。' } }, { Allow: 'GET, POST' })
    }

    if (workflowMatch) {
      const user = await requireUser(request)
      const projectId = decodeURIComponent(workflowMatch[1])
      await requireProjectPermission(productStore, user.id, projectId, 'read')
      const project = await productStore.readProject(user.id, projectId)
      const workflow = project && documents(project.document).workflows.find((entry) => entry.id === decodeURIComponent(workflowMatch[2]))
      if (!workflow) return error(response, 404, 'PRODUCTION_WORKFLOW_NOT_FOUND', '未找到生产工作流。')
      if (request.method === 'GET') return json(response, 200, { workflow })
      return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '生产工作流资源只支持读取；更新请发布新版本。' } }, { Allow: 'GET' })
    }

    if (runsMatch) {
      const user = await requireUser(request)
      const projectId = decodeURIComponent(runsMatch[1])
      const workflowId = decodeURIComponent(runsMatch[2])
      if (request.method === 'GET') {
        await requireProjectPermission(productStore, user.id, projectId, 'read')
        const project = await productStore.readProject(user.id, projectId)
        if (!project) return error(response, 404, 'PROJECT_NOT_FOUND', '未找到项目或你没有访问权限。')
        return json(response, 200, { runs: documents(project.document).runs.filter((run) => run.workflowId === workflowId) })
      }
      if (request.method === 'POST') {
        await requireProjectPermission(productStore, user.id, projectId, 'create-generation')
        const project = await productStore.readProject(user.id, projectId)
        const workflow = project && documents(project.document).workflows.find((entry) => entry.id === workflowId)
        if (!workflow) return error(response, 404, 'PRODUCTION_WORKFLOW_NOT_FOUND', '未找到生产工作流。')
        const body = await readJson(request)
        const existingRun = documents(project.document).runs.find((entry) => entry.id === body.id)
        if (existingRun) {
          if (existingRun.workflowId !== workflowId || existingRun.workflowVersion !== Number(body.workflowVersion)) {
            return error(response, 409, 'WORKFLOW_RUN_ID_CONFLICT', '运行标识已被其他工作流版本使用。')
          }
          return json(response, 200, { run: existingRun, reused: true })
        }
        if (!productionWorkflowVersion(workflow, body.workflowVersion)) return error(response, 409, 'WORKFLOW_VERSION_NOT_FOUND', '指定工作流版本不存在。')
        let run = createProductionWorkflowRun({
          id: body.id,
          workflow,
          workflowVersion: body.workflowVersion,
          itemInputs: body.items,
        }, { actorId: user.id })

        // 先保存固定版本与输入快照，再创建真实任务。这样项目写入失败时不会留下
        // 无法从工作流历史追溯的孤儿任务。
        const prepared = await updateProject(user.id, projectId, (document) => {
          const state = documents(document)
          return { ...document, productionWorkflowRuns: [...state.runs, run] }
        })
        if (!prepared) return error(response, 404, 'PROJECT_NOT_FOUND', '未找到项目或你没有访问权限。')

        run = await dispatchItems(user, workflow, run, project.document)
        await updateProject(user.id, projectId, (document) => {
          const state = documents(document)
          return { ...document, productionWorkflowRuns: [...state.runs.filter((entry) => entry.id !== run.id), run] }
        })
        return json(response, 202, { run })
      }
      return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '工作流运行集合不支持该请求方法。' } }, { Allow: 'GET, POST' })
    }

    if (runMatch) {
      const user = await requireUser(request)
      const projectId = decodeURIComponent(runMatch[1])
      const runId = decodeURIComponent(runMatch[2])
      const access = await requireProjectPermission(productStore, user.id, projectId, request.method === 'GET' ? 'read' : 'create-generation')
      const project = await productStore.readProject(user.id, projectId)
      if (!project) return error(response, 404, 'PROJECT_NOT_FOUND', '未找到项目或你没有访问权限。')
      const state = documents(project.document)
      let run = state.runs.find((entry) => entry.id === runId)
      const workflow = state.workflows.find((entry) => entry.id === run?.workflowId)
      if (!run || !workflow) return error(response, 404, 'PRODUCTION_WORKFLOW_RUN_NOT_FOUND', '未找到工作流运行。')
      const reconciled = await reconcileRun(user, project, run)
      run = reconciled.run
      if (request.method === 'GET') {
        // Viewer 可以读取并即时看到 Job 状态，但不能因为 GET 触发项目写入。
        // Owner/Editor 仍将恢复后的运行快照持久化，避免刷新后重复进入旧状态。
        if (reconciled.changed && access.role !== 'viewer') await updateProject(user.id, projectId, (document) => ({
          ...document,
          productionWorkflowRuns: documents(document).runs.map((entry) => entry.id === run.id ? run : entry),
        }))
        return json(response, 200, { run })
      }
      if (request.method === 'PATCH') {
        const body = await readJson(request)
        if (body.action === 'retry-failed') {
          run = retryFailedWorkflowItems(run)
          run = await dispatchItems(user, workflow, run, project.document, run.items.filter((item) => item.status === 'queued').map((item) => item.id), true)
        } else if (body.action === 'pause') {
          run = transitionProductionWorkflowRun(run, 'pause')
          for (const item of run.items.filter((entry) => entry.jobId && entry.status === 'running')) {
            const job = await productStore.readGenerationJob(user.id, item.jobId)
            if (job?.status !== 'queued') continue
            await productStore.putGenerationJob(user.id, persistedGenerationJob({ ...job, status: 'cancelled', updatedAt: Date.now() }))
            await redisQueue?.cancel(job.id)
          }
        } else if (body.action === 'resume') {
          run = transitionProductionWorkflowRun(run, 'resume')
          run = await dispatchItems(user, workflow, run, project.document, run.items.filter((item) => item.jobId).map((item) => item.id), true)
        } else if (body.action === 'cancel') {
          run = transitionProductionWorkflowRun(run, 'cancel')
          for (const item of run.items.filter((entry) => entry.jobId)) {
            const job = await productStore.readGenerationJob(user.id, item.jobId)
            if (!job || !['queued', 'running'].includes(job.status)) continue
            await productStore.putGenerationJob(user.id, persistedGenerationJob({ ...job, status: 'cancelled', updatedAt: Date.now() }))
            await redisQueue?.cancel(job.id)
          }
        } else if (body.action === 'approve-review' || body.action === 'reject-review') {
          run = transitionProductionWorkflowRun(run, body.action, { actorId: user.id })
        } else {
          return error(response, 400, 'INVALID_WORKFLOW_ACTION', '工作流操作不支持。')
        }
        await updateProject(user.id, projectId, (document) => ({
          ...document,
          productionWorkflowRuns: documents(document).runs.map((entry) => entry.id === run.id ? run : entry),
        }))
        return json(response, 200, { run })
      }
      return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '工作流运行资源不支持该请求方法。' } }, { Allow: 'GET, PATCH' })
    }

    return false
  }
}

export function publicProductionWorkflowRun(run, jobs = []) {
  return {
    ...clone(run),
    jobs: jobs.map((job) => publicGenerationJob(job, { includeIdempotencyKey: false })),
  }
}
