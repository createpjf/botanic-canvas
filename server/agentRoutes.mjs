import { BotanicAgentPlannerError, planBotanicGeneration, validateBotanicAgentPlanInput } from './botanicAgentPlanner.mjs'
import { BotanicAgentChatError, chatWithBotanicAgent, validateBotanicAgentChatInput } from './botanicAgentChat.mjs'
import { createAgentSkill, publicAgentSkill, validateAgentSkillCreation } from './botanicAgentSkill.mjs'
import { cancelPersistentAgentRun, createPersistentAgentRun, prepareAgentBranchRetry, publicAgentRun, validateAgentRunCreation } from './botanicAgentRun.mjs'
import { AgentToolRuntimeError, executeConfirmedAgentAction } from './agentToolRuntime.mjs'
import { botanicAgentBuiltInSkill, createBotanicAgentActionToolRegistry } from './botanicAgentTools.mjs'
import { decodeArtifactCursor, encodeArtifactCursor } from './botanicArtifactIndex.mjs'
import { generationIdempotencyKey, generationJobIdForIdempotency } from './generationIdempotency.mjs'
import { persistedGenerationJob, publicGenerationJob } from './generationProvider.mjs'
import { retargetGenerationJobForRetry } from './generationResultReconciliation.mjs'
import { requireProjectPermission } from './projectAuthorization.mjs'

export { BotanicAgentPlannerError, BotanicAgentChatError }

export function createAgentRouteHandler({
  config,
  productStore,
  redisQueue,
  configuredMcpTools,
  json,
  error,
  readJson,
  text,
  requireUser,
  enforceRateLimit,
  agentRunGeneration,
  publishAgentRunUpdated,
  enqueue,
  publishProjectUpdated,
  publishCollaborationActivity,
  observeAgentRun = () => {},
}) {
  const agentActionExecutions = new Map()
  const methodNotAllowed = (response, message, allow) => json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message } }, { Allow: allow })
  const observeRun = (event) => {
    try { observeAgentRun(event) } catch { /* 运行日志不得阻断用户请求。 */ }
  }
  const recordCollaborationActivity = async (user, projectId, input) => {
    try {
      const activity = await productStore.putCollaborationActivity(user.id, projectId, input)
      await publishCollaborationActivity?.({ projectId, activity })
    } catch {
      // 协作历史是派生读模型；写入或广播失败不能回滚权威 Agent 实体。
    }
  }

  return async function handleAgentRoute(request, response, url, routeMatches, requestId) {
    const {
      projectAgentRuns: projectAgentRunsMatch,
      projectAgentSkills: projectAgentSkillsMatch,
      projectAgentState: projectAgentStateMatch,
      projectAgentArtifacts: projectAgentArtifactsMatch,
      agentSession: agentSessionMatch,
      agentSessionReadingAnchor: agentSessionReadingAnchorMatch,
      agentMessage: agentMessageMatch,
      agentMemory: agentMemoryMatch,
      agentRun: agentRunMatch,
      agentRunCancel: agentRunCancelMatch,
      agentBranchRetry: agentBranchRetryMatch,
    } = routeMatches

    if (url.pathname === '/api/agent-plans') {
      if (request.method !== 'POST') return methodNotAllowed(response, 'Agent 规划资源只接受提交请求。', 'POST')
      const user = await requireUser(request)
      if (!await enforceRateLimit(response, { scope: 'agent-plan', subject: user.id, limit: config.security.agentPlansPerFiveMinutes, windowMs: 5 * 60_000 })) return true
      if (!config.flockApiBaseUrl || !config.flockApiKey || !config.flockTextModel) return error(response, 503, 'PROVIDER_NOT_CONFIGURED', '生图 Agent 规划服务尚未配置。')
      const validatedInput = validateBotanicAgentPlanInput(await readJson(request, config.maximumPromptRefinementRequestBytes, 'Agent 规划请求过大，请精简后重试。'))
      await requireProjectPermission(productStore, user.id, validatedInput.projectId, 'edit')
      const projectSkills = await productStore.listAgentSkills(user.id, validatedInput.projectId) ?? []
      const input = {
        ...validatedInput,
        availableMcpTools: (config.agentMcpTools ?? []).map(({ server, tool }) => ({ server, tool })),
        projectSkills: projectSkills.map((skill) => ({ id: skill.id, name: skill.name, instructions: skill.instructions, status: skill.status })),
      }
      const controller = new AbortController()
      const cancel = () => controller.abort()
      const cancelOnClosedResponse = () => { if (!response.writableEnded) cancel() }
      request.once('aborted', cancel)
      response.once('close', cancelOnClosedResponse)
      if (request.aborted || response.destroyed) cancel()
      try {
        const plan = await planBotanicGeneration(input, config, { signal: controller.signal })
        if (controller.signal.aborted || response.destroyed) return true
        return plan?.kind === 'clarification' ? json(response, 200, { clarification: plan.clarification }) : json(response, 200, { plan })
      } catch (caught) {
        if (controller.signal.aborted || response.destroyed) return true
        throw caught
      } finally {
        request.off('aborted', cancel)
        response.off('close', cancelOnClosedResponse)
      }
    }

    if (url.pathname === '/api/agent-chat') {
      if (request.method !== 'POST') return methodNotAllowed(response, 'Agent 对话资源只接受提交请求。', 'POST')
      const user = await requireUser(request)
      if (!await enforceRateLimit(response, { scope: 'agent-chat', subject: user.id, limit: config.security.agentChatsPerFiveMinutes, windowMs: 5 * 60_000 })) return true
      if (!config.flockApiBaseUrl || !config.flockApiKey || !config.flockTextModel) return error(response, 503, 'PROVIDER_NOT_CONFIGURED', 'Agent 对话服务尚未配置。')
      const validatedInput = validateBotanicAgentChatInput(await readJson(request, config.maximumPromptRefinementRequestBytes, 'Agent 对话请求过大，请精简后重试。'))
      await requireProjectPermission(productStore, user.id, validatedInput.projectId, 'read')
      const project = await productStore.readProject(user.id, validatedInput.projectId)
      if (!project?.document) return error(response, 404, 'PROJECT_NOT_FOUND', '未找到项目或你没有访问权限。')
      const projectSkills = await productStore.listAgentSkills(user.id, validatedInput.projectId) ?? []
      const input = { ...validatedInput, projectSkills: projectSkills.map((skill) => ({ id: skill.id, name: skill.name, instructions: skill.instructions, status: skill.status })) }
      const controller = new AbortController()
      const cancel = () => controller.abort()
      const cancelOnClosedResponse = () => { if (!response.writableEnded) cancel() }
      request.once('aborted', cancel)
      response.once('close', cancelOnClosedResponse)
      if (request.aborted || response.destroyed) cancel()
      try {
        const result = await chatWithBotanicAgent(input, config, { document: project.document, projectSkills, signal: controller.signal })
        if (controller.signal.aborted || response.destroyed) return true
        return json(response, 200, { response: result })
      } catch (caught) {
        if (controller.signal.aborted || response.destroyed) return true
        throw caught
      } finally {
        request.off('aborted', cancel)
        response.off('close', cancelOnClosedResponse)
      }
    }

    if (projectAgentSkillsMatch) {
      if (request.method !== 'GET') return methodNotAllowed(response, '项目 Skill 资源只支持读取。', 'GET')
      const user = await requireUser(request)
      const projectId = decodeURIComponent(projectAgentSkillsMatch[1])
      await requireProjectPermission(productStore, user.id, projectId, 'read')
      const skills = await productStore.listAgentSkills(user.id, projectId) ?? []
      return json(response, 200, { skills: skills.map(publicAgentSkill) })
    }
    if (projectAgentStateMatch) {
      if (request.method !== 'GET') return methodNotAllowed(response, 'Agent 状态资源只支持读取。', 'GET')
      const user = await requireUser(request)
      const projectId = decodeURIComponent(projectAgentStateMatch[1])
      await requireProjectPermission(productStore, user.id, projectId, 'read')
      const state = await productStore.readAgentState(user.id, projectId)
      return state ? json(response, 200, state) : error(response, 404, 'PROJECT_NOT_FOUND', '未找到项目或你没有访问权限。')
    }
    if (projectAgentArtifactsMatch) {
      if (request.method !== 'GET') return methodNotAllowed(response, 'Artifact 资源只支持读取。', 'GET')
      const user = await requireUser(request)
      const projectId = decodeURIComponent(projectAgentArtifactsMatch[1])
      await requireProjectPermission(productStore, user.id, projectId, 'read')
      const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 100, 200))
      let before
      try { before = decodeArtifactCursor(url.searchParams.get('before') ?? undefined) } catch { return error(response, 400, 'INVALID_ARTIFACT_CURSOR', 'Artifact 分页游标无效。') }
      const artifacts = await productStore.listAgentArtifacts(user.id, projectId, { limit, before })
      if (!artifacts) return error(response, 404, 'PROJECT_NOT_FOUND', '未找到项目或你没有访问权限。')
      return json(response, 200, { artifacts, nextBefore: artifacts.length === limit ? encodeArtifactCursor(artifacts.at(-1)) : undefined })
    }
    if (agentSessionReadingAnchorMatch) {
      if (request.method !== 'PATCH') return methodNotAllowed(response, 'Agent 阅读位置只接受更新。', 'PATCH')
      const user = await requireUser(request)
      const projectId = decodeURIComponent(agentSessionReadingAnchorMatch[1])
      const sessionId = decodeURIComponent(agentSessionReadingAnchorMatch[2])
      await requireProjectPermission(productStore, user.id, projectId, 'read')
      const body = await readJson(request, 4 * 1024, 'Agent 阅读位置请求过大。')
      const messageId = text(body?.messageId, 'Agent 阅读位置', 160)
      const state = await productStore.readAgentState(user.id, projectId)
      const session = state?.sessions?.find((candidate) => candidate.id === sessionId)
      if (!session) return error(response, 404, 'AGENT_SESSION_NOT_FOUND', '未找到该 Agent 对话。')
      if (!session.messages?.some((message) => message.id === messageId)) {
        return error(response, 409, 'AGENT_MESSAGE_NOT_FOUND', '目标消息已不存在，请刷新对话后重试。')
      }
      const updatedAt = Date.now()
      return json(response, 200, { receipt: await productStore.putAgentSessionReadReceipt(user.id, projectId, sessionId, {
        messageId,
        updatedAt,
      }) })
    }
    if (agentSessionMatch) {
      if (request.method !== 'PUT') return methodNotAllowed(response, 'Agent 会话资源只接受写入。', 'PUT')
      const user = await requireUser(request)
      const projectId = decodeURIComponent(agentSessionMatch[1])
      const sessionId = decodeURIComponent(agentSessionMatch[2])
      await requireProjectPermission(productStore, user.id, projectId, 'edit')
      const body = await readJson(request, 64 * 1024, 'Agent 会话请求过大。')
      if (body?.id !== sessionId) return error(response, 400, 'INVALID_AGENT_ENTITY', 'Agent 会话标识不一致。')
      let previous
      try {
        const before = await productStore.readAgentState(user.id, projectId)
        previous = before?.sessions?.find((candidate) => candidate.id === sessionId)
      } catch { /* 差异判断失败时仍应完成权威 Session 写入。 */ }
      const session = await productStore.putAgentSession(user.id, projectId, body)
      const settingsChanged = !previous
        || previous.title !== session.title
        || previous.executionMode !== session.executionMode
        || JSON.stringify(previous.contextNodeIds ?? []) !== JSON.stringify(session.contextNodeIds ?? [])
      if (settingsChanged) await recordCollaborationActivity(user, projectId, {
        id: `agent-session-${session.id}-${session.updatedAt}`,
        kind: 'conversation',
        summary: previous ? `更新了对话设置「${session.title || '新建对话'}」` : `创建了对话「${session.title || '新建对话'}」`,
      })
      return json(response, 200, { session })
    }
    if (agentMessageMatch) {
      if (request.method !== 'PUT') return methodNotAllowed(response, 'Agent 消息资源只接受写入。', 'PUT')
      const user = await requireUser(request)
      const projectId = decodeURIComponent(agentMessageMatch[1])
      const sessionId = decodeURIComponent(agentMessageMatch[2])
      const messageId = decodeURIComponent(agentMessageMatch[3])
      await requireProjectPermission(productStore, user.id, projectId, 'edit')
      const body = await readJson(request, 96 * 1024, 'Agent 消息请求过大。')
      if (body?.id !== messageId) return error(response, 400, 'INVALID_AGENT_ENTITY', 'Agent 消息标识不一致。')
      const message = await productStore.putAgentMessage(user.id, projectId, sessionId, body)
      let sessionTitle = '新建对话'
      try {
        const state = await productStore.readAgentState(user.id, projectId)
        sessionTitle = state?.sessions?.find((candidate) => candidate.id === sessionId)?.title || sessionTitle
      } catch { /* 标题只用于协作历史，不得阻断消息权威写入。 */ }
      await recordCollaborationActivity(user, projectId, {
        id: `agent-message-${message.id}`,
        kind: 'conversation',
        summary: `更新了对话「${sessionTitle}」`,
        target: { kind: 'message', sessionId, messageId: message.id },
      })
      return json(response, 200, { message })
    }
    if (agentMemoryMatch) {
      const user = await requireUser(request)
      const projectId = decodeURIComponent(agentMemoryMatch[1])
      const memoryId = decodeURIComponent(agentMemoryMatch[2])
      await requireProjectPermission(productStore, user.id, projectId, 'edit')
      if (request.method === 'PUT') {
        const body = await readJson(request, 16 * 1024, 'Agent 记忆请求过大。')
        if (body?.id !== memoryId) return error(response, 400, 'INVALID_AGENT_ENTITY', 'Agent 记忆标识不一致。')
        const memory = await productStore.putAgentMemoryItem(user.id, projectId, body)
        await recordCollaborationActivity(user, projectId, {
          id: `agent-memory-${memory.id}-${memory.updatedAt}`,
          kind: 'project',
          summary: '更新了项目记忆',
          target: { kind: 'project' },
        })
        return json(response, 200, { memory })
      }
      if (request.method === 'DELETE') {
        await productStore.deleteAgentMemoryItem(user.id, projectId, memoryId)
        await recordCollaborationActivity(user, projectId, {
          id: `agent-memory-${memoryId}-deleted-${Date.now()}`,
          kind: 'project',
          summary: '删除了项目记忆',
          target: { kind: 'project' },
        })
        return json(response, 204)
      }
      return methodNotAllowed(response, 'Agent 记忆资源不支持该请求方法。', 'PUT, DELETE')
    }

    if (url.pathname === '/api/agent-actions') {
      if (request.method !== 'POST') return methodNotAllowed(response, 'Agent 行动资源只接受提交请求。', 'POST')
      const user = await requireUser(request)
      const idempotencyKey = generationIdempotencyKey(request.headers['idempotency-key'])
      if (!idempotencyKey) return error(response, 400, 'INVALID_IDEMPOTENCY_KEY', 'Agent 行动提交标识无效，请重试。')
      const body = await readJson(request, 16 * 1024, 'Agent 行动请求过大。')
      const projectId = text(body?.projectId, '项目', 160)
      await requireProjectPermission(productStore, user.id, projectId, 'edit')
      const receiptId = `agent_action_${generationJobIdForIdempotency(user.id, `${projectId}:${idempotencyKey}`).slice(4)}`
      const persistedReceipt = await productStore.readAgentActionReceipt(user.id, receiptId)
      if (persistedReceipt) return json(response, 200, persistedReceipt.result)
      const execute = async () => {
        const registry = createBotanicAgentActionToolRegistry({
          createWorkflow: async ({ planId }) => {
            const { project, prepared } = await agentRunGeneration.prepareProjectExecution(user.id, projectId, planId, { submission: false })
            await agentRunGeneration.persistWorkflow(user.id, project, prepared)
            return { message: `已创建 ${prepared.workflows.length} 条画布工作流。`, canvasNodeIds: prepared.workflows.flatMap((workflow) => [workflow.generateNodeId, workflow.resultNodeId]) }
          },
          submitGeneration: async ({ planId }) => {
            const execution = await agentRunGeneration.submitGeneration(user.id, projectId, planId)
            return {
              message: `已提交 ${execution.jobs.length} 个 Agent 生成分支。`,
              run: publicAgentRun(execution.run),
              jobIds: execution.jobs.map((job) => job.id),
              canvasNodeIds: execution.workflows.flatMap((workflow) => [workflow.generateNodeId, workflow.resultNodeId]),
            }
          },
          applySkill: async ({ skillId }) => {
            const builtIn = botanicAgentBuiltInSkill(skillId)
            if (builtIn) return { skill: builtIn }
            const skills = await productStore.listAgentSkills(user.id, projectId) ?? []
            const skill = skills.find((candidate) => candidate.id === skillId && candidate.status === 'active')
            if (!skill) throw new AgentToolRuntimeError('SKILL_NOT_ALLOWED', 'Skill 不在当前项目的允许列表。', 403)
            return { skill: { id: skill.id, name: skill.name, instructions: skill.instructions } }
          },
          createSkill: async (argumentsValue) => {
            const input = validateAgentSkillCreation({ projectId, ...argumentsValue })
            const skill = createAgentSkill(input, { ownerId: user.id })
            return { skill: publicAgentSkill(await productStore.putAgentSkill(user.id, skill)) }
          },
          mcpTools: configuredMcpTools,
        })
        const result = await executeConfirmedAgentAction({
          registry,
          name: text(body?.name, '工具名称', 80),
          arguments: body?.arguments,
          toolCallId: text(body?.toolCallId, '工具调用标识', 160),
          confirmed: body?.confirmed,
          context: { projectId, userId: user.id, requestId },
        })
        await productStore.putAgentActionReceipt(user.id, { id: receiptId, projectId, toolCallId: result.toolCall.id, result, createdAt: Date.now() })
        return result
      }
      let execution = agentActionExecutions.get(receiptId)
      if (!execution) {
        execution = execute().finally(() => agentActionExecutions.delete(receiptId))
        agentActionExecutions.set(receiptId, execution)
      }
      return json(response, 200, await execution)
    }

    if (url.pathname === '/api/agent-runs') {
      const startedAt = Date.now()
      if (request.method !== 'POST') return methodNotAllowed(response, 'Agent Run 集合只接受提交请求。', 'POST')
      const user = await requireUser(request)
      const idempotencyKey = generationIdempotencyKey(request.headers['idempotency-key'])
      if (!idempotencyKey) return error(response, 400, 'INVALID_IDEMPOTENCY_KEY', 'Agent Run 提交标识无效，请重试。')
      const input = validateAgentRunCreation(await readJson(request, 64 * 1024, 'Agent Run 请求过大。'))
      await requireProjectPermission(productStore, user.id, input.projectId, 'edit')
      const id = `agent_run_${generationJobIdForIdempotency(user.id, idempotencyKey).slice(4)}`
      const existing = await productStore.readAgentRun(user.id, id)
      if (existing) {
        observeRun({ type: 'submission_reused', requestId, projectId: existing.projectId, runId: existing.id, status: existing.status, durationMs: Date.now() - startedAt })
        return json(response, 200, { run: publicAgentRun(existing) })
      }
      const run = createPersistentAgentRun(input, { id, ownerId: user.id })
      const storedRun = await productStore.putAgentRun(user.id, run)
      await recordCollaborationActivity(user, storedRun.projectId, {
        id: `agent-run-${storedRun.id}-${storedRun.updatedAt}`,
        kind: 'task',
        summary: `提交了任务「${storedRun.plan?.summary || '生成任务'}」`,
        target: { kind: 'task', runId: storedRun.id },
      })
      await publishAgentRunUpdated({ projectId: storedRun.projectId, run: publicAgentRun(storedRun) })
      observeRun({ type: 'created', requestId, projectId: storedRun.projectId, runId: storedRun.id, status: storedRun.status, durationMs: Date.now() - startedAt })
      return json(response, 201, { run: publicAgentRun(storedRun) })
    }
    if (projectAgentRunsMatch) {
      if (request.method !== 'GET') return methodNotAllowed(response, '项目 Agent Run 资源只支持读取。', 'GET')
      const user = await requireUser(request)
      const projectId = decodeURIComponent(projectAgentRunsMatch[1])
      await requireProjectPermission(productStore, user.id, projectId, 'read')
      return json(response, 200, { runs: (await productStore.listAgentRunsForProject(user.id, projectId)).map(publicAgentRun) })
    }
    if (agentRunMatch) {
      if (request.method !== 'GET') return methodNotAllowed(response, 'Agent Run 资源只支持读取。', 'GET')
      const user = await requireUser(request)
      const run = await productStore.readAgentRun(user.id, decodeURIComponent(agentRunMatch[1]))
      if (!run) return error(response, 404, 'AGENT_RUN_NOT_FOUND', '未找到该 Agent Run。')
      await requireProjectPermission(productStore, user.id, run.projectId, 'read')
      return json(response, 200, { run: publicAgentRun(run) })
    }
    if (agentRunCancelMatch) {
      if (request.method !== 'POST') return methodNotAllowed(response, 'Agent Run 取消资源只接受提交请求。', 'POST')
      const user = await requireUser(request)
      const runId = decodeURIComponent(agentRunCancelMatch[1])
      const run = await productStore.readAgentRun(user.id, runId)
      if (!run) return error(response, 404, 'AGENT_RUN_NOT_FOUND', '未找到该 Agent Run。')
      await requireProjectPermission(productStore, user.id, run.projectId, 'edit')
      const activeJobIds = [...new Set(run.branches.filter((branch) => branch.status === 'queued' || branch.status === 'running').map((branch) => branch.activeJobId).filter(Boolean))]
      for (const jobId of activeJobIds) {
        const job = await productStore.readGenerationJob(user.id, jobId)
        if (job?.status === 'queued' || job?.status === 'running') {
          const cancelledJob = { ...job, status: 'cancelled', error: undefined, updatedAt: Date.now() }
          await productStore.putGenerationJob(user.id, persistedGenerationJob(cancelledJob))
          await agentRunGeneration.persistJobState(user.id, run.projectId, cancelledJob)
          await redisQueue?.cancel(jobId)
        }
      }
      const latestRun = await productStore.readAgentRun(user.id, runId) ?? run
      const cancelledRun = cancelPersistentAgentRun(latestRun)
      if (cancelledRun !== latestRun) await productStore.putAgentRun(user.id, cancelledRun)
      if (cancelledRun !== latestRun) await recordCollaborationActivity(user, run.projectId, {
        id: `agent-run-${cancelledRun.id}-${cancelledRun.updatedAt}`,
        kind: 'task',
        summary: `取消了任务「${cancelledRun.plan?.summary || '生成任务'}」`,
        target: { kind: 'task', runId: cancelledRun.id },
      })
      await publishAgentRunUpdated({ projectId: run.projectId, run: publicAgentRun(cancelledRun) })
      observeRun({ type: 'cancelled', requestId, projectId: run.projectId, runId, status: cancelledRun.status, activeJobCount: activeJobIds.length })
      return json(response, 200, { run: publicAgentRun(cancelledRun) })
    }
    if (agentBranchRetryMatch) {
      if (request.method !== 'POST') return methodNotAllowed(response, 'Agent 分支重试资源只接受提交请求。', 'POST')
      const user = await requireUser(request)
      const runId = decodeURIComponent(agentBranchRetryMatch[1])
      const branchId = decodeURIComponent(agentBranchRetryMatch[2])
      const idempotencyKey = generationIdempotencyKey(request.headers['idempotency-key'])
      if (!idempotencyKey) return error(response, 400, 'INVALID_IDEMPOTENCY_KEY', '分支重试标识无效，请重试。')
      const run = await productStore.readAgentRun(user.id, runId)
      if (!run) return error(response, 404, 'AGENT_RUN_NOT_FOUND', '未找到该 Agent Run。')
      await requireProjectPermission(productStore, user.id, run.projectId, 'edit')
      const branch = run.branches.find((candidate) => candidate.id === branchId)
      if (!branch) return error(response, 404, 'AGENT_BRANCH_NOT_FOUND', '未找到 Agent 分支。')
      const previousJob = branch.activeJobId ? await productStore.readGenerationJob(user.id, branch.activeJobId) : undefined
      if (!previousJob?.rawInput) return error(response, 409, 'AGENT_BRANCH_RETRY_SOURCE_MISSING', '该分支缺少可重试的原始生成配方。')
      const jobId = generationJobIdForIdempotency(user.id, idempotencyKey)
      const existingJob = await productStore.readGenerationJob(user.id, jobId)
      if (existingJob) {
        const currentRun = await productStore.readAgentRun(user.id, runId)
        observeRun({ type: 'retry_reused', requestId, projectId: run.projectId, runId, branchId, jobId, status: currentRun?.status ?? run.status })
        return json(response, 202, { run: publicAgentRun(currentRun), job: publicGenerationJob(existingJob, { includeIdempotencyKey: existingJob.ownerId === user.id }) })
      }
      if (!await enforceRateLimit(response, { scope: 'generation-output', subject: user.id, limit: config.security.generationOutputsPerDay, windowMs: 24 * 60 * 60_000, cost: previousJob.batchCount })) return true
      const timestamp = Date.now()
      const retriedRun = prepareAgentBranchRetry(run, branchId, { jobId, now: timestamp })
      const job = { ...previousJob, id: jobId, status: 'queued', idempotencyKey, createdAt: timestamp, updatedAt: timestamp, outputs: [], error: undefined, missingOutputCount: 0, partialError: undefined, agentRun: { runId, branchId } }
      const project = await productStore.readProject(user.id, run.projectId)
      const retargeted = project ? retargetGenerationJobForRetry(project.document, previousJob.id, jobId, timestamp) : { changed: false }
      if (project && retargeted.changed) {
        try {
          const saved = await productStore.writeProject(user.id, retargeted.document, project.revision, project.graphRevision)
          await publishProjectUpdated(saved, user.id)
        } catch (caught) {
          if (caught?.code === 'PROJECT_CONFLICT' || caught?.code === 'CANVAS_GRAPH_CONFLICT') return error(response, 409, caught.code, '画布刚刚发生变化，请刷新后重试该分支。')
          throw caught
        }
      }
      await productStore.putAgentRun(user.id, retriedRun)
      await recordCollaborationActivity(user, run.projectId, {
        id: `agent-run-${retriedRun.id}-${retriedRun.updatedAt}`,
        kind: 'task',
        summary: `重试了任务「${retriedRun.plan?.summary || '生成任务'}」`,
        target: { kind: 'task', runId: retriedRun.id },
      })
      await productStore.putGenerationJob(user.id, persistedGenerationJob(job))
      try {
        await enqueue(job.id)
      } catch {
        const failed = { ...job, status: 'failed', error: '生成任务无法进入队列，请检查 Redis Worker 后重试。', updatedAt: Date.now() }
        await productStore.putGenerationJob(user.id, persistedGenerationJob(failed))
        await agentRunGeneration.persistJobState(user.id, run.projectId, failed)
        const failedRun = await productStore.readAgentRun(user.id, runId)
        await publishAgentRunUpdated({ projectId: run.projectId, run: publicAgentRun(failedRun) })
        observeRun({ type: 'retry_failed', requestId, projectId: run.projectId, runId, branchId, jobId, status: failedRun?.status ?? 'failed', code: 'QUEUE_UNAVAILABLE' })
        return error(response, 503, 'QUEUE_UNAVAILABLE', failed.error)
      }
      const queuedRun = await productStore.readAgentRun(user.id, runId)
      await publishAgentRunUpdated({ projectId: run.projectId, run: publicAgentRun(queuedRun) })
      observeRun({ type: 'retry_queued', requestId, projectId: run.projectId, runId, branchId, jobId, status: queuedRun?.status ?? 'queued' })
      return json(response, 202, { run: publicAgentRun(queuedRun), job: publicGenerationJob(job, { includeIdempotencyKey: true }) })
    }
    return false
  }
}
