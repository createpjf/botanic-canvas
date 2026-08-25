import { BotanicAgentPlannerError, planBotanicGeneration, validateBotanicAgentPlanInput } from './botanicAgentPlanner.mjs'
import { BotanicAgentChatError, chatWithBotanicAgent, validateBotanicAgentChatInput } from './botanicAgentChat.mjs'
import { reviewBotanicAgentRunResults } from './botanicAgentReview.mjs'
import { normalizeBotanicAgentLocale } from './agentInstructions.mjs'
import { resolveBotanicAgentTurn, validateBotanicAgentTurnInput } from './botanicAgentTurn.mjs'
import { createAgentSkill, isUsableAgentSkill, publicAgentSkill, validateAgentSkillCreation } from './botanicAgentSkill.mjs'
import { cancelPersistentAgentRun, createPersistentAgentRun, createReviewRetryAgentRunInput, prepareAgentBranchRetry, publicAgentRun, validateAgentRunCreation } from './botanicAgentRun.mjs'
import { AgentToolRuntimeError, executeConfirmedAgentAction } from './agentToolRuntime.mjs'
import { botanicAgentBuiltInSkill, botanicAgentSystemSkills, createBotanicAgentActionToolRegistry } from './botanicAgentTools.mjs'
import { decodeArtifactCursor, encodeArtifactCursor } from './botanicArtifactIndex.mjs'
import { cancelGenerationJob } from './generationCancellation.mjs'
import { retryFailedWorkflowItems } from './productionWorkflow.mjs'
import { generationIdempotencyKey, generationJobIdForIdempotency } from './generationIdempotency.mjs'
import { persistedGenerationJob, publicGenerationJob } from './generationProvider.mjs'
import { retargetGenerationJobForRetry } from './generationResultReconciliation.mjs'
import { requireProjectPermission } from './projectAuthorization.mjs'
import { buildAgentExecutionTrace } from './agentExecutionTrace.mjs'
import { actionArgumentsHash, agentToolPermission, assertFreshActionApproval, createActionApprovalToken } from './agentActionGovernance.mjs'
import { agentTurnIdForIdempotency, agentTurnLastSequence, createBotanicAgentTurnRuntime, publicAgentTurn } from './botanicAgentTurnRuntime.mjs'
import { createLocalCancelRegistry } from './localCancelRegistry.mjs'
import { createAgentHumanDecision, publicAgentReviewTask } from './agentReviewTask.mjs'
import { createAgentBranchRetryService } from './agentBranchRetryService.mjs'
import { createProductionWorkflowPublishService } from './productionWorkflowPublishService.mjs'
import { selectBotanicAgentMemory } from './botanicAgentMemory.mjs'
import { buildThreadSummaryCheckpoint, shouldCompactThread } from './agentThreadSummary.mjs'
import { compareBotanicAgentRunBranches } from './botanicAgentCompare.mjs'
import { createForkedAgentRunInput, forkedAgentRunIdForIdempotency } from './botanicAgentFork.mjs'

export { BotanicAgentPlannerError, BotanicAgentChatError }

/**
 * SSE 写出器。通道必须在模型吐出第一事件之前打开：Vercel 反代会在首字节过晚
 * 或静默间隙把流掐断，浏览器随后报 `network error`。第一次写出后响应头已定，
 * 任何失败都只能作为事件送达，因此调用方需要用 started 判断还能不能回退成
 * 普通错误响应。
 */
const agentChatStreamHeartbeatMs = 3_000

export function createServerSentEventWriter(response, options = {}) {
  let started = false
  let heartbeat
  const heartbeatMs = Number.isFinite(Number(options.heartbeatMs))
    ? Math.max(0, Number(options.heartbeatMs))
    : agentChatStreamHeartbeatMs
  const scheduleHeartbeat = options.scheduleHeartbeat ?? ((fn, ms) => setInterval(fn, ms))
  const unscheduleHeartbeat = options.unscheduleHeartbeat ?? ((id) => clearInterval(id))

  const stopHeartbeat = () => {
    if (heartbeat == null) return
    unscheduleHeartbeat(heartbeat)
    heartbeat = undefined
  }

  const writeComment = () => {
    if (response.writableEnded || response.destroyed) return false
    response.write(': keep-alive\n\n')
    response.flush?.()
    return true
  }

  const start = () => {
    if (response.writableEnded) return false
    if (started) return true
    started = true
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // no-cache 阻止中间层把未结束的流当成可缓存完整响应。
      'Cache-Control': 'no-cache, no-store',
      // Vercel / gzip 中间层看到 identity/none 才不会缓冲 SSE。
      'Content-Encoding': 'none',
      // HTTP/2 不允许 Connection；写 keep-alive 会被 Chromium 收成 network error。
      'X-Accel-Buffering': 'no',
    })
    response.flushHeaders?.()
    writeComment()
    if (heartbeatMs > 0) {
      heartbeat = scheduleHeartbeat(writeComment, heartbeatMs)
      heartbeat?.unref?.()
    }
    return true
  }

  return {
    get started() { return started },
    start,
    send(event) {
      if (response.writableEnded) return false
      start()
      if (response.writableEnded || response.destroyed) return false
      // 只有携带稳定序号的事件才写 id:。SSE 的 id: 会成为客户端的续读锚点，
      // 给无序事件写 id 等于让客户端把一个无法定位的位置当成可恢复点。
      if (Number.isInteger(event?.sequence)) response.write(`id: ${event.sequence}\n`)
      response.write(`data: ${JSON.stringify(event)}\n\n`)
      response.flush?.()
      return true
    },
    end() {
      stopHeartbeat()
      if (!response.writableEnded) response.end()
      return true
    },
  }
}

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
  consumeWebResearchQuota,
  mediaService,
  localCancelRegistry,
  publishCancel,
  securityControls,
}) {
  // 看图只读当前项目内的媒体：readGenerationInput 校验归属，图片字节不离开服务端与模型网关。
  const visionMediaResolver = (userId, projectId) => (mediaService?.enabled
    ? (mediaId) => mediaService.readGenerationInput(userId, mediaId, projectId)
    : undefined)
  const plannerSkillInput = (skill) => ({
    id: skill.id,
    name: skill.name,
    instructions: skill.instructions,
    status: skill.status,
    ...(Number.isInteger(skill.version) ? { version: skill.version } : {}),
    ...(typeof skill.contentHash === 'string' ? { contentHash: skill.contentHash } : {}),
    ...(Array.isArray(skill.capabilities) ? { capabilities: skill.capabilities } : {}),
  })
  const agentActionExecutions = new Map()
  const agentTurnRuntime = createBotanicAgentTurnRuntime({ productStore })
  // 本实例的执行句柄表由外部注入：跨实例取消信号的订阅方需要拿到同一个表，
  // 才能在收到别的实例发来的取消时就地中止（见 localCancelRegistry）。
  const cancelRegistry = localCancelRegistry ?? createLocalCancelRegistry()
  const methodNotAllowed = (response, message, allow) => json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message } }, { Allow: allow })
  const observeRun = (event) => {
    try { observeAgentRun(event) } catch { /* 运行日志不得阻断用户请求。 */ }
  }
  // 需要短期审批 Token 的行动：会花钱或触达外部系统的那些。运维写工具里
  // 重试分支与重试工作流失败项都会真的调用 Provider，因此同样进这个集合。
  const approvalRequired = new Set([
    'generation_submit', 'mcp_call', 'agent_branch_retry', 'workflow_run_retry_failed',
  ])
  const requireActionProposal = async ({ user, projectId, actionName, toolCallId, argumentsValue }) => {
    if (actionName === 'generation_submit') {
      const runId = text(argumentsValue?.planId, 'Agent Run', 160)
      const run = await productStore.readAgentRun(user.id, runId)
      if (!run || run.projectId !== projectId || !['awaiting_confirmation', 'queued', 'executing', 'running'].includes(run.status)) {
        throw new AgentToolRuntimeError('ACTION_PROPOSAL_NOT_FOUND', '该生成行动已不存在或已完成，请重新规划。', 409)
      }
      return
    }
    const state = await productStore.readAgentState(user.id, projectId)
    const proposal = state?.sessions?.flatMap((session) => session.messages ?? [])
      .flatMap((message) => message.plan?.actions ?? [])
      .find((action) => action.id === toolCallId && action.toolName === actionName)
    if (!proposal || !['awaiting_confirmation', 'failed'].includes(proposal.status)) {
      throw new AgentToolRuntimeError('ACTION_PROPOSAL_NOT_FOUND', '该行动已不存在或已处理，请重新规划。', 409)
    }
    if (actionArgumentsHash(proposal.arguments) !== actionArgumentsHash(argumentsValue)) {
      throw new AgentToolRuntimeError('ACTION_PROPOSAL_MISMATCH', '行动参数已变化，请重新确认。', 409)
    }
  }
  const recordCollaborationActivity = async (user, projectId, input) => {
    try {
      const activity = await productStore.putCollaborationActivity(user.id, projectId, input)
      await publishCollaborationActivity?.({ projectId, activity })
    } catch {
      // 协作历史是派生读模型；写入或广播失败不能回滚权威 Agent 实体。
    }
  }
  const configuredActionTimeout = Number(config?.agentActionTimeoutMs)
  const agentActionTimeoutMs = Number.isFinite(configuredActionTimeout)
    ? Math.max(1, Math.min(120_000, configuredActionTimeout))
    : 30_000
  /**
   * 工作流发布的唯一实现，路由与运维工具共用。这里自带一个最小的项目写入器：
   * 与工作流路由一样按乐观并发重试，来源校验在回调内做，因此并发修改无法在校验与
   * 写入之间把来源改掉。
   */
  const publishProductionWorkflow = createProductionWorkflowPublishService({
    productStore,
    updateProject: async (userId, projectId, mutate) => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const project = await productStore.readProject(userId, projectId)
        if (!project) return undefined
        const document = mutate(structuredClone(project.document))
        try {
          const saved = await productStore.writeProject(userId, document, project.revision, project.graphRevision)
          await publishProjectUpdated(saved, userId)
          return saved
        } catch (caught) {
          if (!['PROJECT_CONFLICT', 'CANVAS_GRAPH_CONFLICT'].includes(caught?.code) || attempt === 4) throw caught
        }
      }
      return undefined
    },
  })

  // 分支重试的唯一实现，路由与运维工具共用。
  const retryAgentBranch = createAgentBranchRetryService({
    productStore,
    config,
    enqueue,
    securityControls,
    publishProjectUpdated,
    publishAgentRunUpdated,
    agentRunGeneration,
    recordCollaborationActivity,
    observeRun: (event) => observeAgentRun(event),
  })

  /**
   * 线程摘要检查点（Epic 8）。
   *
   * 回合请求只带最近一个窗口的消息，超出窗口的早期决策会彻底消失。这里从持久化的
   * 会话消息里**确定性**派生检查点并写回会话 —— 让模型复述一遍约束，就没有任何东西
   * 能保证它复述对了。
   *
   * 派生失败不能挡住回合：摘要缺失只是少一层上下文，不是这次对话不能进行。
   */
  const threadSummaryForSession = async (userId, projectId, sessionId) => {
    if (!sessionId || typeof productStore.readAgentState !== 'function') return undefined
    try {
      const projectState = await productStore.readAgentState(userId, projectId)
      const session = (projectState?.sessions ?? []).find((entry) => entry?.id === sessionId)
      if (!session) return undefined
      const messages = session.messages ?? []
      if (!shouldCompactThread(messages)) return session.threadSummary
      const summary = buildThreadSummaryCheckpoint({ messages, previous: session.threadSummary })
      if (summary && summary !== session.threadSummary && typeof productStore.putAgentSession === 'function') {
        await productStore.putAgentSession(userId, projectId, { ...session, threadSummary: summary })
      }
      return summary
    } catch (caught) {
      console.error(`[agent-thread] 摘要派生跳过: ${caught instanceof Error ? caught.message : String(caught)}`)
      return undefined
    }
  }

  /**
   * 运维只读工具的数据源。全部按项目权限读取，且不返回受控媒体地址 ——
   * 工具结果会进模型上下文（Epic 4）。
   */
  const operationalReaders = (userId, projectId, document) => ({
    readRun: async (runId) => {
      const run = await productStore.readAgentRun(userId, runId)
      // 跨项目的 Run 不能通过工具泄漏。
      return run && run.projectId === projectId ? publicAgentRun(run) : undefined
    },
    readJob: async (jobId) => {
      const job = await productStore.readGenerationJob(userId, jobId)
      return job && job.projectId === projectId ? job : undefined
    },
    searchArtifacts: async ({ query, kind, limit }) => {
      const artifacts = await productStore.listAgentArtifacts(userId, projectId, { limit: Math.min(limit * 4, 200) }) ?? []
      const needle = String(query ?? '').trim().toLocaleLowerCase('zh-CN')
      return artifacts
        .filter((artifact) => (!kind || artifact.kind === kind)
          && (!needle || `${artifact.label ?? ''} ${artifact.id ?? ''}`.toLocaleLowerCase('zh-CN').includes(needle)))
        .slice(0, limit)
    },
    readReviews: async (runId) => {
      const run = await productStore.readAgentRun(userId, runId)
      if (!run || run.projectId !== projectId) return []
      return (await productStore.listAgentReviewTasksForRun(userId, projectId, runId)) ?? []
    },
    readWorkflowRun: async (runId) => (document?.productionWorkflowRuns ?? []).find((entry) => entry?.id === runId),
    readDeliveries: async () => document?.deliveries ?? [],
  })

  const bindAuthoritativeKnowledge = async (userId, input) => {
    const [projectState, projectSkills] = await Promise.all([
      typeof productStore.readAgentState === 'function' ? productStore.readAgentState(userId, input.projectId) : undefined,
      typeof productStore.listAgentSkills === 'function' ? productStore.listAgentSkills(userId, input.projectId) : [],
    ])
    const memoriesById = new Map((projectState?.memory ?? []).map((memory) => [memory.id, memory]))
    const skillsById = new Map((projectSkills ?? []).map((skill) => [skill.id, skill]))
    const bind = (bindings, catalog, label) => (bindings ?? []).map((binding) => {
      const current = catalog.get(binding.id)
      // 项目 Memory/Skill 必须在确认瞬间仍存在且 hash 一致。内置 Skill 没有项目版本
      // 记录，但版本与摘要随代码确定，同样要写进绑定 —— 留「系统 Skill 免填」的口子
      // 等于允许出现无法重放的 Run（ADR 0006）。
      if (!current) {
        const builtIn = label === 'Skill' ? botanicAgentBuiltInSkill(binding.id) : undefined
        if (builtIn) return { ...binding, version: builtIn.version, contentHash: builtIn.contentHash }
        const error = new Error(`${label}「${binding.id}」已不存在或未获项目授权。`)
        error.statusCode = 409
        error.code = `${label === 'Skill' ? 'AGENT_SKILL' : 'AGENT_MEMORY'}_BINDING_STALE`
        throw error
      }
      if (binding.version !== undefined && Number(current.version ?? 1) !== Number(binding.version)) {
        const error = new Error(`${label}「${binding.id}」已更新，请重新规划。`)
        error.statusCode = 409
        error.code = `${label === 'Skill' ? 'AGENT_SKILL' : 'AGENT_MEMORY'}_BINDING_STALE`
        throw error
      }
      if (binding.contentHash && current.contentHash && binding.contentHash !== current.contentHash) {
        const error = new Error(`${label}「${binding.id}」内容已更新，请重新规划。`)
        error.statusCode = 409
        error.code = `${label === 'Skill' ? 'AGENT_SKILL' : 'AGENT_MEMORY'}_BINDING_STALE`
        throw error
      }
      const bound = {
        ...binding,
        version: Number(current.version ?? 1),
        ...(current.contentHash ? { contentHash: current.contentHash } : {}),
      }
      // 版本与内容摘要在 Run 绑定里是必填。缺任一项都说明这条绑定无法重放，
      // 与其存下一个不可重放的 Run，不如就地失败。
      if (!Number.isInteger(bound.version) || !bound.contentHash) {
        const error = new Error(`${label}「${binding.id}」缺少可重放的版本与内容摘要。`)
        error.statusCode = 409
        error.code = `${label === 'Skill' ? 'AGENT_SKILL' : 'AGENT_MEMORY'}_BINDING_UNREPLAYABLE`
        throw error
      }
      return bound
    })
    return {
      ...input,
      plan: {
        ...input.plan,
        ...(input.plan.memoryBindings ? { memoryBindings: bind(input.plan.memoryBindings, memoriesById, '项目记忆') } : {}),
        ...(input.plan.skillBindings ? { skillBindings: bind(input.plan.skillBindings, skillsById, 'Skill') } : {}),
      },
    }
  }
  const withActionTimeout = (promise, actionName) => new Promise((resolve, reject) => {
    let settled = false
    const timeoutId = setTimeout(() => {
      if (settled) return
      settled = true
      const label = actionName === 'skill_apply' ? 'Skill 执行超时，请稍后重试。' : 'Agent 行动执行超时，请稍后重试。'
      reject(new AgentToolRuntimeError('AGENT_ACTION_TIMEOUT', label, 504))
    }, agentActionTimeoutMs)
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timeoutId)
        resolve(value)
      },
      (caught) => {
        if (settled) return
        settled = true
        clearTimeout(timeoutId)
        reject(caught)
      },
    )
  })

  return async function handleAgentRoute(request, response, url, routeMatches, requestId) {
    const {
      projectAgentRuns: projectAgentRunsMatch,
      projectAgentSkills: projectAgentSkillsMatch,
      agentSkillCatalog: agentSkillCatalogMatch,
      projectAgentState: projectAgentStateMatch,
      projectAgentArtifacts: projectAgentArtifactsMatch,
      agentSession: agentSessionMatch,
      agentSessionReadingAnchor: agentSessionReadingAnchorMatch,
      agentMessage: agentMessageMatch,
      agentMemory: agentMemoryMatch,
      agentRun: agentRunMatch,
      agentRunFork: agentRunForkMatch,
      agentRunCompare: agentRunCompareMatch,
      agentRunTrace: agentRunTraceMatch,
      agentRunReviewTasks: agentRunReviewTasksMatch,
      agentReviewTaskDecisions: agentReviewTaskDecisionsMatch,
      agentRunCancel: agentRunCancelMatch,
      agentBranchRetry: agentBranchRetryMatch,
      agentTurns: agentTurnsMatch,
      agentTurnStream: agentTurnStreamMatch,
      agentTurn: agentTurnMatch,
      agentTurnCancel: agentTurnCancelMatch,
      agentReviewDecision: agentReviewDecisionMatch,
    } = routeMatches

    if (agentTurnsMatch || agentTurnStreamMatch) {
      const streaming = Boolean(agentTurnStreamMatch)
      if (request.method !== 'POST') return methodNotAllowed(response, 'Agent Turn 资源只接受提交请求。', 'POST')
      const user = await requireUser(request)
      if (!await enforceRateLimit(response, { scope: 'agent-chat', subject: user.id, limit: config.security.agentChatsPerFiveMinutes, windowMs: 5 * 60_000 })) return true
      if (!config.flockApiBaseUrl || !config.flockApiKey || !config.flockTextModel) return error(response, 503, 'PROVIDER_NOT_CONFIGURED', 'Agent 服务尚未配置。')
      const idempotencyKey = generationIdempotencyKey(request.headers['idempotency-key'])
      if (!idempotencyKey) return error(response, 400, 'INVALID_IDEMPOTENCY_KEY', 'Agent Turn 提交标识无效，请重试。')
      const validatedInput = validateBotanicAgentTurnInput(await readJson(request, config.maximumPromptRefinementRequestBytes, 'Agent Turn 请求过大，请精简后重试。'))
      await requireProjectPermission(productStore, user.id, validatedInput.projectId, 'read')
      const project = await productStore.readProject(user.id, validatedInput.projectId)
      if (!project?.document) return error(response, 404, 'PROJECT_NOT_FOUND', '未找到项目或你没有访问权限。')
      const projectSkills = await productStore.listAgentSkills(user.id, validatedInput.projectId) ?? []
      const input = {
        ...validatedInput,
        projectSkills: projectSkills.map(plannerSkillInput),
      }
      const turnId = agentTurnIdForIdempotency(user.id, validatedInput.projectId, idempotencyKey)
      const controller = new AbortController()
      // 同一幂等键并发重放时复用首个解析器的取消控制器：登记表拒绝后来者覆盖，
      // 否则明确取消只会中断一个无效的重复控制器。
      cancelRegistry.register(turnId, controller)
      const cancel = () => controller.abort()
      const cancelOnClosedResponse = () => { if (!response.writableEnded) cancel() }
      request.once('aborted', cancel)
      response.once('close', cancelOnClosedResponse)
      if (request.aborted || response.destroyed) cancel()
      const sse = streaming ? createServerSentEventWriter(response) : undefined
      sse?.start()
      try {
        const execution = await agentTurnRuntime.execute({
          userId: user.id,
          projectId: validatedInput.projectId,
          sessionId: typeof request.headers['x-agent-session-id'] === 'string' ? request.headers['x-agent-session-id'] : undefined,
          requestId,
          id: turnId,
          idempotencyKey,
          // 只快照用户请求本身。projectSkills 与项目文档是派生上下文，恢复时应重新
          // 读取 —— 重放一份过期的 Skill 列表或画布快照会让恢复出的回合与当前项目
          // 不一致，而且它们体积远大于请求。
          request: validatedInput,
          resolve: (resolveOptions) => resolveBotanicAgentTurn(input, config, resolveOptions),
          resolveOptions: {
            document: project.document,
            projectSkills,
            threadSummary: await threadSummaryForSession(
              user.id,
              validatedInput.projectId,
              typeof request.headers['x-agent-session-id'] === 'string' ? request.headers['x-agent-session-id'] : undefined,
            ),
            operations: operationalReaders(user.id, validatedInput.projectId, project.document),
            signal: controller.signal,
            resolveVisionMedia: visionMediaResolver(user.id, validatedInput.projectId),
            consumeWebResearchQuota: consumeWebResearchQuota
              ? () => consumeWebResearchQuota(user.id)
              : undefined,
          },
          onEvent: (event) => sse?.send(event),
        })
        if (controller.signal.aborted || response.destroyed) return true
        // 保持旧客户端的 `turn` 业务结果形状；V2 生命周期记录单独放在 runtimeTurn，
        // 这样迁移期间既不会把状态记录误当成生成意图，也不会破坏现有时间线渲染。
        const turnResult = execution.result ?? execution.turn?.result
        if (!sse) return json(response, 200, { turn: turnResult, runtimeTurn: execution.turn })
        sse.send({ type: 'done', turn: turnResult, runtimeTurn: execution.turn })
        return sse.end()
      } catch (caught) {
        if (controller.signal.aborted || response.destroyed) return true
        const statusCode = Number.isInteger(caught?.statusCode) ? caught.statusCode : 502
        if (sse?.started) {
          sse.send({ type: 'error', code: caught?.code ?? 'AGENT_TURN_FAILED', message: typeof caught?.message === 'string' ? caught.message : 'Agent 回合未完成，请重试。' })
          return sse.end()
        }
        return error(response, statusCode, caught?.code ?? 'AGENT_TURN_FAILED', typeof caught?.message === 'string' ? caught.message : 'Agent 回合未完成，请重试。')
      } finally {
        cancelRegistry.release(turnId, controller)
        sse?.end()
        request.off('aborted', cancel)
        response.off('close', cancelOnClosedResponse)
      }
    }

    if (agentTurnCancelMatch) {
      if (request.method !== 'POST') return methodNotAllowed(response, 'Agent Turn 取消资源只接受提交请求。', 'POST')
      const user = await requireUser(request)
      const turnId = decodeURIComponent(agentTurnCancelMatch[1])
      const turn = await productStore.readAgentTurn(user.id, turnId)
      if (!turn) return error(response, 404, 'AGENT_TURN_NOT_FOUND', '未找到该 Agent Turn。')
      await requireProjectPermission(productStore, user.id, turn.projectId, 'read')
      cancelRegistry.abort(turnId)
      const cancelled = await agentTurnRuntime.cancel({ userId: user.id, projectId: turn.projectId, turnId })
      // 无条件广播，不只在本实例没跑时才发：`activeTurns` 是进程内的，同一 turnId
      // 理论上可能同时被两个实例执行，只中止本地会漏掉另一个。本地重复收到自己
      // 发的信号无害（对已中止的控制器再 abort 一次是空操作）。
      await publishCancel?.({ scope: 'turn', id: turnId, projectId: turn.projectId })
      return json(response, 200, { turn: publicAgentTurn(cancelled) })
    }

    if (agentTurnMatch) {
      if (request.method !== 'GET') return methodNotAllowed(response, 'Agent Turn 资源只支持读取。', 'GET')
      const user = await requireUser(request)
      const turn = await productStore.readAgentTurn(user.id, decodeURIComponent(agentTurnMatch[1]))
      if (!turn) return error(response, 404, 'AGENT_TURN_NOT_FOUND', '未找到该 Agent Turn。')
      await requireProjectPermission(productStore, user.id, turn.projectId, 'read')
      const turnEvents = await productStore.listAgentTurnEvents(user.id, turn.projectId, turn.id) ?? []
      // 这次回合确认出的 Run 按权威边 `run.turnId` 反查，不写在 Turn 记录上（见 publicTurn）。
      const linkedRuns = await productStore.listAgentRunsForTurn(user.id, turn.projectId, turn.id) ?? []
      return json(response, 200, {
        turn: publicAgentTurn(turn, {
          lastSequence: agentTurnLastSequence(turnEvents),
          linkedRunIds: linkedRuns.map((run) => run.id),
        }),
        events: turnEvents,
      })
    }

    if (agentReviewDecisionMatch) {
      if (request.method !== 'POST') return methodNotAllowed(response, 'Agent 评审决策只接受提交请求。', 'POST')
      const user = await requireUser(request)
      const body = await readJson(request, 8 * 1024, 'Agent 评审决策请求过大。')
      const projectId = text(body?.projectId, '项目', 160)
      const decision = text(body?.decision, '评审决策', 32)
      if (!['accepted', 'rejected', 'retry_requested'].includes(decision)) return error(response, 400, 'AGENT_REVIEW_DECISION_INVALID', '评审决策无效。')
      await requireProjectPermission(productStore, user.id, projectId, 'edit')
      const review = await productStore.putAgentReviewDecision(user.id, projectId, decodeURIComponent(agentReviewDecisionMatch[1]), decision, typeof body?.note === 'string' ? body.note : '')
      return json(response, 200, { review })
    }

    if (url.pathname === '/api/agent-plans' || url.pathname === '/api/agent-plans/stream') {
      // 实时通道与一次性请求共用同一套鉴权、限流、校验与取消语义；工具步经 onEvent 推送。
      const streaming = url.pathname.endsWith('/stream')
      if (request.method !== 'POST') return methodNotAllowed(response, 'Agent 规划资源只接受提交请求。', 'POST')
      const user = await requireUser(request)
      if (!await enforceRateLimit(response, { scope: 'agent-plan', subject: user.id, limit: config.security.agentPlansPerFiveMinutes, windowMs: 5 * 60_000 })) return true
      if (!config.flockApiBaseUrl || !config.flockApiKey || !config.flockTextModel) return error(response, 503, 'PROVIDER_NOT_CONFIGURED', '生图 Agent 规划服务尚未配置。')
      const validatedInput = validateBotanicAgentPlanInput(await readJson(request, config.maximumPromptRefinementRequestBytes, 'Agent 规划请求过大，请精简后重试。'))
      await requireProjectPermission(productStore, user.id, validatedInput.projectId, 'edit')
      // 三次读取并行：加读项目是为了拿 brandId（记忆的适用主体要按它判定），
      // 串行会白白多一次往返的延迟。
      const [projectSkillsRaw, projectState, project] = await Promise.all([
        productStore.listAgentSkills(user.id, validatedInput.projectId),
        productStore.readAgentState(user.id, validatedInput.projectId),
        productStore.readProject(user.id, validatedInput.projectId),
      ])
      const projectSkills = projectSkillsRaw ?? []
      const input = {
        ...validatedInput,
        // 规划器只能读取服务端当前项目记忆；客户端传入的临时/推测记忆
        // 不具备品牌事实资格，不能绕过 Memory V2 的激活边界。
        //
        // 走同一个选择器而不是就地过滤：项目内只允许一条记忆读取路径（ADR 0006），
        // 就地过滤会让激活、范围与墓碑规则在这条路径上各自演化。
        projectMemory: selectBotanicAgentMemory(projectState?.memory ?? [], {
          query: validatedInput.instruction,
          contextNodeIds: (validatedInput.contextSnapshot ?? []).map((item) => item.nodeId),
          limit: 30,
          // 规划阶段能确定的身份维度只有品牌与操作人。渠道/产品要到批量项才有，
          // 因此限定渠道的规则在这里会落进 filtered 并说明原因，而不是「碰巧适用」。
          context: { brandId: project?.document?.brandId, userId: user.id },
        }).items.map((memory) => ({ id: memory.id, kind: memory.kind, content: memory.content })),
        availableMcpTools: (config.agentMcpTools ?? []).map(({ server, tool }) => ({ server, tool })),
        projectSkills: projectSkills.map(plannerSkillInput),
      }
      const controller = new AbortController()
      const cancel = () => controller.abort()
      const cancelOnClosedResponse = () => { if (!response.writableEnded) cancel() }
      request.once('aborted', cancel)
      response.once('close', cancelOnClosedResponse)
      if (request.aborted || response.destroyed) cancel()
      const sse = streaming ? createServerSentEventWriter(response) : undefined
      sse?.start()
      try {
        const result = await planBotanicGeneration(input, config, {
          signal: controller.signal,
          consumeWebResearchQuota: consumeWebResearchQuota
            ? () => consumeWebResearchQuota(user.id)
            : undefined,
          ...(sse ? { onEvent: (event) => sse.send(event) } : {}),
        })
        if (controller.signal.aborted || response.destroyed) return true
        // reasoning 必须留在 plan 之外：计划会被原样持久化到会话消息里，
        // 而原始推理只允许随当轮响应下发。
        const { reasoning, ...plan } = result ?? {}
        const liveReasoning = reasoning?.length ? { reasoning } : {}
        if (!sse) {
          return result?.kind === 'clarification'
            ? json(response, 200, { clarification: result.clarification, ...liveReasoning })
            : json(response, 200, { plan, ...liveReasoning })
        }
        if (result?.kind === 'clarification') {
          sse.send({ type: 'done', clarification: result.clarification, ...liveReasoning })
        } else {
          sse.send({ type: 'done', plan, ...liveReasoning })
        }
        return sse.end()
      } catch (caught) {
        if (controller.signal.aborted || response.destroyed) return true
        if (sse?.started) {
          sse.send({
            type: 'error',
            code: caught?.code ?? 'AGENT_PLAN_FAILED',
            message: typeof caught?.message === 'string' ? caught.message : 'Agent 规划未完成，请重试。',
          })
          return sse.end()
        }
        throw caught
      } finally {
        sse?.end()
        request.off('aborted', cancel)
        response.off('close', cancelOnClosedResponse)
      }
    }

    if (url.pathname === '/api/agent-chat' || url.pathname === '/api/agent-chat/stream') {
      // 实时通道与一次性请求共用同一套鉴权、限流、校验与取消语义，只是回传方式不同。
      const streaming = url.pathname.endsWith('/stream')
      if (request.method !== 'POST') return methodNotAllowed(response, 'Agent 对话资源只接受提交请求。', 'POST')
      const user = await requireUser(request)
      if (!await enforceRateLimit(response, { scope: 'agent-chat', subject: user.id, limit: config.security.agentChatsPerFiveMinutes, windowMs: 5 * 60_000 })) return true
      if (!config.flockApiBaseUrl || !config.flockApiKey || !config.flockTextModel) return error(response, 503, 'PROVIDER_NOT_CONFIGURED', 'Agent 对话服务尚未配置。')
      const validatedInput = validateBotanicAgentChatInput(await readJson(request, config.maximumPromptRefinementRequestBytes, 'Agent 对话请求过大，请精简后重试。'))
      await requireProjectPermission(productStore, user.id, validatedInput.projectId, 'read')
      const project = await productStore.readProject(user.id, validatedInput.projectId)
      if (!project?.document) return error(response, 404, 'PROJECT_NOT_FOUND', '未找到项目或你没有访问权限。')
      const projectSkills = await productStore.listAgentSkills(user.id, validatedInput.projectId) ?? []
      const input = { ...validatedInput, projectSkills: projectSkills.map(plannerSkillInput) }
      const controller = new AbortController()
      const cancel = () => controller.abort()
      const cancelOnClosedResponse = () => { if (!response.writableEnded) cancel() }
      request.once('aborted', cancel)
      response.once('close', cancelOnClosedResponse)
      if (request.aborted || response.destroyed) cancel()
      const sse = streaming ? createServerSentEventWriter(response) : undefined
      // 先打开通道再等模型：搜索前后的静默期靠注释心跳维持反代连接。
      sse?.start()
      try {
        const result = await chatWithBotanicAgent(input, config, {
          document: project.document,
          projectSkills,
          signal: controller.signal,
          resolveVisionMedia: visionMediaResolver(user.id, validatedInput.projectId),
          consumeWebResearchQuota: consumeWebResearchQuota
            ? () => consumeWebResearchQuota(user.id)
            : undefined,
          ...(sse ? { onEvent: (event) => sse.send(event) } : {}),
        })
        if (controller.signal.aborted || response.destroyed) return true
        if (!sse) return json(response, 200, { response: result })
        // done 事件携带与非流式完全一致的响应体，客户端据此收敛这一轮。
        sse.send({ type: 'done', response: result })
        return sse.end()
      } catch (caught) {
        if (controller.signal.aborted || response.destroyed) return true
        // 已经开始推送就不能再改状态码，只能把失败作为事件送达。
        if (sse?.started) {
          sse.send({
            type: 'error',
            code: caught?.code ?? 'AGENT_CHAT_FAILED',
            message: typeof caught?.message === 'string' ? caught.message : 'Agent 对话未完成，请重试。',
          })
          return sse.end()
        }
        throw caught
      } finally {
        sse?.end()
        request.off('aborted', cancel)
        response.off('close', cancelOnClosedResponse)
      }
    }

    if (agentSkillCatalogMatch) {
      if (request.method !== 'GET') return methodNotAllowed(response, '系统 Skill 目录只支持读取。', 'GET')
      await requireUser(request)
      return json(response, 200, { skills: botanicAgentSystemSkills() })
    }

    if (url.pathname === '/api/agent-intent' || url.pathname === '/api/agent-intent/stream') {
      const streaming = url.pathname.endsWith('/stream')
      if (request.method !== 'POST') return methodNotAllowed(response, 'Agent 意图资源只接受提交请求。', 'POST')
      const user = await requireUser(request)
      if (!await enforceRateLimit(response, { scope: 'agent-chat', subject: user.id, limit: config.security.agentChatsPerFiveMinutes, windowMs: 5 * 60_000 })) return true
      if (!config.flockApiBaseUrl || !config.flockApiKey || !config.flockTextModel) return error(response, 503, 'PROVIDER_NOT_CONFIGURED', 'Agent 服务尚未配置。')
      const validatedInput = validateBotanicAgentTurnInput(await readJson(request, config.maximumPromptRefinementRequestBytes, 'Agent 请求过大，请精简后重试。'))
      await requireProjectPermission(productStore, user.id, validatedInput.projectId, 'read')
      const project = await productStore.readProject(user.id, validatedInput.projectId)
      if (!project?.document) return error(response, 404, 'PROJECT_NOT_FOUND', '未找到项目或你没有访问权限。')
      const projectSkills = await productStore.listAgentSkills(user.id, validatedInput.projectId) ?? []
      const input = { ...validatedInput, projectSkills: projectSkills.map(plannerSkillInput) }
      const controller = new AbortController()
      const cancel = () => controller.abort()
      const cancelOnClosedResponse = () => { if (!response.writableEnded) cancel() }
      request.once('aborted', cancel)
      response.once('close', cancelOnClosedResponse)
      if (request.aborted || response.destroyed) cancel()
      const sse = streaming ? createServerSentEventWriter(response) : undefined
      sse?.start()
      try {
        const turn = await resolveBotanicAgentTurn(input, config, {
          document: project.document,
          projectSkills,
          threadSummary: await threadSummaryForSession(
            user.id,
            validatedInput.projectId,
            typeof request.headers['x-agent-session-id'] === 'string' ? request.headers['x-agent-session-id'] : undefined,
          ),
          operations: operationalReaders(user.id, validatedInput.projectId, project.document),
          signal: controller.signal,
          resolveVisionMedia: visionMediaResolver(user.id, validatedInput.projectId),
          consumeWebResearchQuota: consumeWebResearchQuota
            ? () => consumeWebResearchQuota(user.id)
            : undefined,
          ...(sse ? { onEvent: (event) => sse.send(event) } : {}),
        })
        if (controller.signal.aborted || response.destroyed) return true
        if (!sse) return json(response, 200, { turn })
        sse.send({ type: 'done', turn })
        return sse.end()
      } catch (caught) {
        if (controller.signal.aborted || response.destroyed) return true
        if (sse?.started) {
          sse.send({
            type: 'error',
            code: caught?.code ?? 'AGENT_TURN_FAILED',
            message: typeof caught?.message === 'string' ? caught.message : 'Agent 意图解析未完成，请重试。',
          })
          return sse.end()
        }
        throw caught
      } finally {
        sse?.end()
        request.off('aborted', cancel)
        response.off('close', cancelOnClosedResponse)
      }
    }

    if (url.pathname === '/api/agent-run-reviews') {
      if (request.method !== 'POST') return methodNotAllowed(response, 'Agent 结果评审只接受提交请求。', 'POST')
      const user = await requireUser(request)
      if (!await enforceRateLimit(response, { scope: 'agent-chat', subject: user.id, limit: config.security.agentChatsPerFiveMinutes, windowMs: 5 * 60_000 })) return true
      const body = await readJson(request, 4 * 1024, 'Agent 评审请求过大。')
      const projectId = text(body?.projectId, '项目', 160)
      const runId = text(body?.runId, 'Agent Run', 160)
      if (body?.locale !== undefined && body.locale !== 'zh-CN' && body.locale !== 'en') return error(response, 400, 'INVALID_LOCALE', 'Agent locale 不支持。')
      const locale = normalizeBotanicAgentLocale(body?.locale ?? (String(request.headers['accept-language'] ?? '').toLowerCase().startsWith('en') ? 'en' : 'zh-CN'))
      await requireProjectPermission(productStore, user.id, projectId, 'read')
      const run = await productStore.readAgentRun(user.id, runId)
      if (!run || run.projectId !== projectId) return error(response, 404, 'AGENT_RUN_NOT_FOUND', '未找到该 Agent 任务。')
      if (run.status !== 'completed' && run.status !== 'partial') {
        return error(response, 409, 'AGENT_RUN_NOT_SETTLED', '任务还没有可评审的结果。')
      }
      const project = await productStore.readProject(user.id, projectId)
      if (!project?.document) return error(response, 404, 'PROJECT_NOT_FOUND', '未找到项目或你没有访问权限。')
      // 先读持久化质量结论；视觉模型暂时不可用时，历史评审仍应可读取。
      const persisted = await productStore.readAgentReview(user.id, projectId, runId, locale)
      if (persisted) return json(response, 200, { review: persisted })
      if (!config.agentVisionModel || !config.flockApiKey) return error(response, 503, 'VISION_NOT_CONFIGURED', '结果评审需要配置视觉模型。')
      const controller = new AbortController()
      const cancel = () => controller.abort()
      const cancelOnClosedResponse = () => { if (!response.writableEnded) cancel() }
      request.once('aborted', cancel)
      response.once('close', cancelOnClosedResponse)
      try {
        const review = await reviewBotanicAgentRunResults({
          run,
          document: project.document,
          runtimeConfig: config,
          resolveMedia: visionMediaResolver(user.id, projectId),
          signal: controller.signal,
          locale,
        }).catch(() => undefined)
        if (controller.signal.aborted || response.destroyed) return true
        if (!review) return json(response, 200, { review: null })
        const timestamp = Date.now()
        const persistedReview = await productStore.putAgentReview(user.id, {
          ...review,
          id: `agent-review-${runId}-${locale}`,
          version: 2,
          runId,
          projectId,
          locale,
          status: 'pending',
          requiredCriteria: run.plan?.qualityPolicy?.requiredCriteria ?? ['identity', 'product_structure', 'composition', 'lighting', 'brand_style'],
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        return json(response, 200, { review: persistedReview })
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
        || previous.plannerModel !== session.plannerModel
        || JSON.stringify(previous.mountedSkillIds ?? []) !== JSON.stringify(session.mountedSkillIds ?? [])
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

    if (url.pathname === '/api/agent-action-approvals') {
      if (request.method !== 'POST') return methodNotAllowed(response, 'Agent 行动审批资源只接受提交请求。', 'POST')
      const user = await requireUser(request)
      const idempotencyKey = generationIdempotencyKey(request.headers['idempotency-key'])
      if (!idempotencyKey) return error(response, 400, 'INVALID_IDEMPOTENCY_KEY', 'Agent 行动审批标识无效，请重试。')
      const body = await readJson(request, 16 * 1024, 'Agent 行动审批请求过大。')
      const projectId = text(body?.projectId, '项目', 160)
      const actionName = text(body?.name, '工具名称', 80)
      const toolCallId = text(body?.toolCallId, '工具调用标识', 160)
      if (!approvalRequired.has(actionName)) return error(response, 400, 'ACTION_APPROVAL_NOT_REQUIRED', '该行动不需要审批凭据。')
      await requireProjectPermission(productStore, user.id, projectId, agentToolPermission(actionName))
      await requireActionProposal({ user, projectId, actionName, toolCallId, argumentsValue: body?.arguments })
      if (!config.agentActionApprovalSecret) return error(response, 503, 'ACTION_APPROVAL_UNAVAILABLE', '当前行动审批服务尚未配置，请稍后重试。')
      return json(response, 200, {
        approval: createActionApprovalToken({
          secret: config.agentActionApprovalSecret,
          userId: user.id,
          projectId,
          actionName,
          toolCallId,
          argumentsValue: body?.arguments,
          idempotencyKey,
        }),
      })
    }

    if (url.pathname === '/api/agent-actions') {
      if (request.method !== 'POST') return methodNotAllowed(response, 'Agent 行动资源只接受提交请求。', 'POST')
      const user = await requireUser(request)
      const idempotencyKey = generationIdempotencyKey(request.headers['idempotency-key'])
      if (!idempotencyKey) return error(response, 400, 'INVALID_IDEMPOTENCY_KEY', 'Agent 行动提交标识无效，请重试。')
      const body = await readJson(request, 16 * 1024, 'Agent 行动请求过大。')
      const projectId = text(body?.projectId, '项目', 160)
      const actionName = text(body?.name, '工具名称', 80)
      const toolCallId = text(body?.toolCallId, '工具调用标识', 160)
      await requireProjectPermission(productStore, user.id, projectId, agentToolPermission(actionName))
      if (approvalRequired.has(actionName)) {
        assertFreshActionApproval(body, {
          secret: config.agentActionApprovalSecret,
          userId: user.id,
          projectId,
          actionName,
          toolCallId,
          argumentsValue: body?.arguments,
          idempotencyKey,
        })
      }
      const receiptId = `agent_action_${generationJobIdForIdempotency(user.id, `${projectId}:${idempotencyKey}`).slice(4)}`
      const persistedReceipt = await productStore.readAgentActionReceipt(user.id, receiptId)
      if (persistedReceipt) return json(response, 200, persistedReceipt.result)
      const execute = async () => {
        const registry = createBotanicAgentActionToolRegistry({
          createWorkflow: async ({ planId }) => {
            const { project, prepared } = await agentRunGeneration.prepareProjectExecution(user.id, projectId, planId, { submission: false })
            const saved = await agentRunGeneration.persistWorkflow(user.id, project, prepared)
            return {
              message: `已创建 ${prepared.workflows.length} 条画布工作流。`,
              canvasNodeIds: prepared.workflows.flatMap((workflow) => [workflow.promptNodeId, workflow.generateNodeId, workflow.resultNodeId]),
              canvasPatch: {
                nodes: prepared.workflows.flatMap((workflow) => [workflow.promptNode, workflow.generateNode, workflow.resultNode]),
                edges: prepared.workflows.flatMap((workflow) => workflow.edges),
                updatedAt: saved.document.updatedAt,
                revision: saved.revision,
                graphRevision: saved.graphRevision,
              },
            }
          },
          submitGeneration: async ({ planId }) => {
            const execution = await agentRunGeneration.submitGeneration(user.id, projectId, planId)
            return {
              message: `已提交 ${execution.jobs.length} 个 Agent 生成分支。`,
              run: publicAgentRun(execution.run),
              jobIds: execution.jobs.map((job) => job.id),
              canvasNodeIds: execution.workflows.flatMap((workflow) => [workflow.promptNodeId, workflow.generateNodeId, workflow.resultNodeId]),
            }
          },
          applySkill: async ({ skillId }) => {
            const builtIn = botanicAgentBuiltInSkill(skillId)
            if (builtIn) return { skill: builtIn }
            const skills = await productStore.listAgentSkills(user.id, projectId) ?? []
            const skill = skills.find((candidate) => candidate.id === skillId && isUsableAgentSkill(candidate))
            if (!skill) throw new AgentToolRuntimeError('SKILL_NOT_ALLOWED', 'Skill 不在当前项目的允许列表。', 403)
            return { skill: {
              id: skill.id,
              name: skill.name,
              instructions: skill.instructions,
              version: skill.version,
              contentHash: skill.contentHash,
              capabilities: skill.capabilities,
            } }
          },
          role: (await productStore.projectAccess(user.id, projectId))?.role,
          retryBranch: async ({ runId, branchId }) => {
            // 与 HTTP 路由共用同一实现与同一幂等键，因此工具重复触发不会重复扣费。
            const outcome = await retryAgentBranch({
              userId: user.id, runId, branchId, idempotencyKey, requestId, actor: user,
            })
            if (outcome.kind === 'error') {
              throw new AgentToolRuntimeError(outcome.code, outcome.message, outcome.status)
            }
            return { runId, branchId, jobId: outcome.job.id, reused: outcome.kind === 'reused', status: outcome.run?.status }
          },
          cancelRun: async ({ runId }) => {
            const run = await productStore.readAgentRun(user.id, runId)
            if (!run || run.projectId !== projectId) throw new AgentToolRuntimeError('AGENT_RUN_NOT_FOUND', '未找到当前项目的 Agent Run。', 404)
            const activeJobIds = [...new Set((run.branches ?? [])
              .filter((branch) => branch.status === 'queued' || branch.status === 'running')
              .map((branch) => branch.activeJobId).filter(Boolean))]
            const outcomes = []
            for (const jobId of activeJobIds) {
              const job = await productStore.readGenerationJob(user.id, jobId)
              if (!job) continue
              const result = await cancelGenerationJob({
                productStore, redisQueue, publishCancel,
                modelOptions: config.modelOptions ?? [],
                ownerId: user.id, job, reason: 'agent-run', requestedBy: user.id,
                afterPersist: (cancelledJob) => agentRunGeneration.persistJobState(user.id, run.projectId, cancelledJob),
              })
              outcomes.push({ jobId, cancelled: result.cancelled, billing: result.outcome.billing, code: result.outcome.code })
            }
            const latest = await productStore.readAgentRun(user.id, runId) ?? run
            const cancelledRun = cancelPersistentAgentRun(latest)
            if (cancelledRun !== latest) {
              await productStore.putAgentRun(user.id, cancelledRun)
              await publishAgentRunUpdated({ projectId: run.projectId, run: publicAgentRun(cancelledRun) })
            }
            return { runId, status: cancelledRun.status, cancelledJobs: outcomes }
          },
          decideReview: async ({ taskId, artifactId, decision, note }) => {
            const task = await productStore.readAgentReviewTask(user.id, taskId)
            if (!task || task.projectId !== projectId) throw new AgentToolRuntimeError('AGENT_REVIEW_TASK_NOT_FOUND', '未找到当前项目的评审任务。', 404)
            if (!(task.coverage?.artifactIds ?? []).includes(artifactId)) {
              throw new AgentToolRuntimeError('AGENT_REVIEW_ARTIFACT_NOT_COVERED', '决定的候选不在本次评审覆盖范围内。', 409)
            }
            const humanDecision = createAgentHumanDecision({
              taskId: task.id, projectId, artifactId, decision, note,
              decidedBy: user.id, idempotencyKey,
            })
            const decisions = [...(task.decisions ?? []).filter((item) => item.id !== humanDecision.id), humanDecision]
            const results = (task.results ?? []).map((result) => (result.artifactId === artifactId
              ? { ...result, candidateStatus: humanDecision.candidateStatus, updatedAt: humanDecision.decidedAt }
              : result))
            const stored = await productStore.putAgentReviewTask(user.id, { ...task, decisions, results, updatedAt: Date.now() })
            return { taskId: stored.id, artifactId, decision, candidateStatus: humanDecision.candidateStatus }
          },
          promoteArtifact: async ({ artifactId, name }) => {
            const artifacts = await productStore.listAgentArtifacts(user.id, projectId, { limit: 200 }) ?? []
            const artifact = artifacts.find((item) => item.id === artifactId)
            if (!artifact?.url) throw new AgentToolRuntimeError('AGENT_ARTIFACT_NOT_FOUND', '未找到该结果，或它没有可入库的媒体。', 404)
            const project = await productStore.readProject(user.id, projectId)
            if (!project) throw new AgentToolRuntimeError('PROJECT_NOT_FOUND', '未找到当前项目。', 404)
            const assetId = `asset-${generationJobIdForIdempotency(user.id, `${projectId}:${artifactId}`).slice(4, 28)}`
            const assets = project.document.assets ?? []
            // 已入库就直接返回：重复确认不该产生第二份素材。
            if (assets.some((asset) => asset.id === assetId)) return { artifactId, assetId, reused: true }
            const document = {
              ...project.document,
              assets: [...assets, {
                id: assetId,
                name: name || artifact.label || '入库结果',
                image: artifact.url,
                role: '参考',
                source: 'generated',
                mediaKind: artifact.kind === 'video' ? 'video' : 'image',
                tags: ['Agent'],
              }],
            }
            const saved = await productStore.writeProject(user.id, document, project.revision, project.graphRevision)
            await publishProjectUpdated(saved, user.id)
            return { artifactId, assetId, reused: false }
          },
          publishWorkflow: async ({ name, sourceCanvasNodeId }) => {
            const project = await productStore.readProject(user.id, projectId)
            if (!project) throw new AgentToolRuntimeError('PROJECT_NOT_FOUND', '未找到当前项目。', 404)
            const node = (project.document.nodes ?? []).find((entry) => entry?.id === sourceCanvasNodeId)
            if (!node || node.type !== 'generate') {
              throw new AgentToolRuntimeError('WORKFLOW_SOURCE_NOT_GENERATE_NODE', '来源必须是画布上的生成节点。', 409)
            }
            const data = node.data ?? {}
            // 来源结果由服务端从权威画布解析：不猜「第一条可用节点」（Epic 3B）。
            const resultNodeIds = (project.document.nodes ?? [])
              .filter((entry) => entry?.type === 'result' && entry?.data?.outputOf === node.id && entry?.data?.jobId && entry?.data?.candidateId)
              .map((entry) => entry.id)
            const outcome = await publishProductionWorkflow({
              userId: user.id,
              projectId,
              id: `production-${sourceCanvasNodeId}`,
              name,
              definition: {
                prompt: data.generationRecipe?.prompt ?? data.prompt,
                model: data.settings?.model,
                settings: { ...(data.settings ?? {}), batchCount: data.batchCount ?? 1 },
                output: {
                  aspectRatio: data.settings?.aspectRatio,
                  resolution: data.settings?.resolution,
                  ...(data.settings?.duration ? { duration: data.settings.duration } : {}),
                  candidates: data.batchCount ?? 1,
                },
                assetGroupIds: [],
                confirmationPolicy: 'before-submit',
                ...(data.generationRecipe ? { recipe: data.generationRecipe } : {}),
              },
              source: {
                canvasNodeId: sourceCanvasNodeId,
                ...(data.agentRun?.runId ? { runId: data.agentRun.runId } : {}),
                ...(data.agentRun?.branchId ? { branchId: data.agentRun.branchId } : {}),
                resultNodeIds,
              },
            })
            if (outcome.kind === 'error') throw new AgentToolRuntimeError(outcome.code, outcome.message, outcome.status)
            return {
              workflowId: outcome.workflow.id,
              version: outcome.workflow.currentVersion,
              sourceCanvasNodeId,
              resultNodeCount: resultNodeIds.length,
            }
          },
          retryWorkflowFailed: async ({ runId }) => {
            const project = await productStore.readProject(user.id, projectId)
            if (!project) throw new AgentToolRuntimeError('PROJECT_NOT_FOUND', '未找到当前项目。', 404)
            const workflowRun = (project.document.productionWorkflowRuns ?? []).find((entry) => entry?.id === runId)
            if (!workflowRun) throw new AgentToolRuntimeError('PRODUCTION_WORKFLOW_RUN_NOT_FOUND', '未找到工作流运行。', 404)
            const failedItemIds = (workflowRun.items ?? []).filter((item) => item?.status === 'failed').map((item) => item.id)
            if (!failedItemIds.length) return { runId, retriedItemIds: [], message: 'no_failed_items' }
            // 真正的重投由既有工作流接口完成；这里只把失败项标回排队，避免在两处
            // 各写一份派发逻辑。已成功的项不动，因此不会重复生成。
            const retried = retryFailedWorkflowItems(workflowRun)
            const document = {
              ...project.document,
              productionWorkflowRuns: (project.document.productionWorkflowRuns ?? [])
                .map((entry) => (entry.id === runId ? retried : entry)),
            }
            const saved = await productStore.writeProject(user.id, document, project.revision, project.graphRevision)
            await publishProjectUpdated(saved, user.id)
            return { runId, retriedItemIds: failedItemIds, status: retried.status }
          },
          createSkill: async (argumentsValue) => {
            const input = validateAgentSkillCreation({ projectId, ...argumentsValue })
            // 批准人是确认这次行动的用户：Skill 只能由用户确认的创建动作进入
            // published，「已批准」不能凭创建这个动作本身成立（ADR 0006）。
            // riskOf 取自**当前行动注册表**：Skill 少报能力（声明只读却把写工具放进
            // Manifest 白名单）在这里就被拒绝，不留到运行时靠取最大值兜底。
            const skill = createAgentSkill(input, {
              ownerId: user.id,
              approvedBy: user.id,
              riskOf: (name) => registry.get?.(name)?.risk,
            })
            return { skill: publicAgentSkill(await productStore.putAgentSkill(user.id, skill)) }
          },
          mcpTools: configuredMcpTools,
        })
        const result = await executeConfirmedAgentAction({
          registry,
          name: actionName,
          arguments: body?.arguments,
          toolCallId,
          confirmed: body?.confirmed,
          context: { projectId, userId: user.id, requestId },
        })
        await productStore.putAgentActionReceipt(user.id, { id: receiptId, projectId, toolCallId: result.toolCall.id, result, createdAt: Date.now() })
        return result
      }
      let execution = agentActionExecutions.get(receiptId)
      if (!execution) {
        execution = withActionTimeout(execute(), actionName).finally(() => agentActionExecutions.delete(receiptId))
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
      await requireProjectPermission(productStore, user.id, input.projectId, 'create-generation')
      const authoritativeInput = await bindAuthoritativeKnowledge(user.id, input)

      // 导演模式：确认计划即授权其声明的生成提交。Run 落库后服务端直接建工作流并送队列，
      // 执行不再寄生在浏览器三跳里，关掉页面也不影响推进。配额、预算与 Job 幂等仍由
      // agentRunGeneration 把关；权限矩阵中 create-generation 与 modify-workflow 同组出现，
      // 能创建 Run 就能建工作流。失败时 4xx 已在内部把 Run 收口为 failed 并广播，
      // 其余（队列暂不可用等）保持 queued，由客户端恢复器按原路径幂等兜底。
      const readyForAutoSubmit = (run) => run.status === 'queued'
        && run.branches.length > 0
        && run.branches.every((branch) => !branch.activeJobId && !(branch.jobIds?.length))
      const autoSubmitAgentRun = async (run) => {
        if (!agentRunGeneration?.submitGeneration || !readyForAutoSubmit(run)) return run
        try {
          const execution = await agentRunGeneration.submitGeneration(user.id, run.projectId, run.id)
          observeRun({ type: 'auto_submitted', requestId, projectId: run.projectId, runId: run.id, status: execution.run.status, durationMs: Date.now() - startedAt })
          return execution.run
        } catch {
          const latest = await productStore.readAgentRun(user.id, run.id)
          observeRun({ type: 'auto_submit_deferred', requestId, projectId: run.projectId, runId: run.id, status: latest?.status ?? run.status, durationMs: Date.now() - startedAt })
          return latest ?? run
        }
      }

      const id = `agent_run_${generationJobIdForIdempotency(user.id, idempotencyKey).slice(4)}`
      const existing = await productStore.readAgentRun(user.id, id)
      if (existing) {
        // 幂等重放同样收敛到已执行状态：确认后页面立刻关闭时 Run 停在 queued，
        // 重放这条请求应把它送进执行，而不是原样返回。
        const resumed = await autoSubmitAgentRun(existing)
        observeRun({ type: 'submission_reused', requestId, projectId: resumed.projectId, runId: resumed.id, status: resumed.status, durationMs: Date.now() - startedAt })
        return json(response, 200, { run: publicAgentRun(resumed) })
      }
      const run = createPersistentAgentRun(authoritativeInput, { id, ownerId: user.id })
      const storedRun = await productStore.putAgentRun(user.id, run)
      await recordCollaborationActivity(user, storedRun.projectId, {
        id: `agent-run-${storedRun.id}-${storedRun.updatedAt}`,
        kind: 'task',
        summary: `提交了任务「${storedRun.plan?.summary || '生成任务'}」`,
        target: { kind: 'task', runId: storedRun.id },
      })
      await publishAgentRunUpdated({ projectId: storedRun.projectId, run: publicAgentRun(storedRun) })
      observeRun({ type: 'created', requestId, projectId: storedRun.projectId, runId: storedRun.id, status: storedRun.status, durationMs: Date.now() - startedAt })
      const submittedRun = await autoSubmitAgentRun(storedRun)
      return json(response, 201, { run: publicAgentRun(submittedRun) })
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
    if (agentRunForkMatch) {
      if (request.method !== 'POST') return methodNotAllowed(response, 'Agent Run 分叉资源只接受提交请求。', 'POST')
      const user = await requireUser(request)
      const sourceRunId = decodeURIComponent(agentRunForkMatch[1])
      const sourceRun = await productStore.readAgentRun(user.id, sourceRunId)
      if (!sourceRun) return error(response, 404, 'AGENT_RUN_NOT_FOUND', '未找到 Agent Run。')
      await requireProjectPermission(productStore, user.id, sourceRun.projectId, 'create-generation')
      const idempotencyKey = generationIdempotencyKey(request.headers['idempotency-key'])
      if (!idempotencyKey) return error(response, 400, 'INVALID_IDEMPOTENCY_KEY', 'Agent 分叉标识无效，请重试。')
      const body = await readJson(request, 16 * 1024, 'Agent 分叉请求过大。')
      const input = createForkedAgentRunInput(sourceRun, { branchId: body?.branchId, promptDelta: body?.promptDelta })
      const id = forkedAgentRunIdForIdempotency(user.id, sourceRun.id, idempotencyKey)
      const existing = await productStore.readAgentRun(user.id, id)
      if (existing) return json(response, 200, { run: publicAgentRun(existing), reused: true })
      const created = createPersistentAgentRun(input, { id, ownerId: user.id })
      const stored = await productStore.putAgentRun(user.id, created)
      await publishAgentRunUpdated({ projectId: stored.projectId, run: publicAgentRun(stored) })
      return json(response, 201, { run: publicAgentRun(stored), sourceRunId: sourceRun.id })
    }
    if (agentRunCompareMatch) {
      if (request.method !== 'GET') return methodNotAllowed(response, 'Agent Run 比较资源只支持读取。', 'GET')
      const user = await requireUser(request)
      const runId = decodeURIComponent(agentRunCompareMatch[1])
      const run = await productStore.readAgentRun(user.id, runId)
      if (!run) return error(response, 404, 'AGENT_RUN_NOT_FOUND', '未找到 Agent Run。')
      await requireProjectPermission(productStore, user.id, run.projectId, 'read')
      const jobIds = [...new Set(run.branches.flatMap((branch) => branch.jobIds ?? []).filter(Boolean))]
      const jobs = (await Promise.all(jobIds.map((jobId) => productStore.readGenerationJob(user.id, jobId)))).filter(Boolean)
      const artifacts = (await productStore.listAgentArtifacts(user.id, run.projectId, { limit: 200 }) ?? [])
        .filter((artifact) => artifact?.provenance?.runId === run.id)
      const reviews = await productStore.listAgentReviewsForRun(user.id, run.projectId, run.id) ?? []
      return json(response, 200, { comparison: compareBotanicAgentRunBranches({ run, jobs, artifacts, reviews }) })
    }
    if (agentRunTraceMatch) {
      if (request.method !== 'GET') return methodNotAllowed(response, 'Agent 执行链路只支持读取。', 'GET')
      const user = await requireUser(request)
      const run = await productStore.readAgentRun(user.id, decodeURIComponent(agentRunTraceMatch[1]))
      if (!run) return error(response, 404, 'AGENT_RUN_NOT_FOUND', '未找到该 Agent Run。')
      await requireProjectPermission(productStore, user.id, run.projectId, 'read-operational')
      const jobIds = [...new Set(run.branches.flatMap((branch) => branch.jobIds ?? []).filter(Boolean))]
      const jobs = (await Promise.all(jobIds.map((jobId) => productStore.readGenerationJob(user.id, jobId)))).filter(Boolean)
      const artifacts = await productStore.listAgentArtifacts(user.id, run.projectId, { limit: 200 }) ?? []
      return json(response, 200, { trace: buildAgentExecutionTrace({ run, jobs, artifacts }) })
    }
    if (agentRunReviewTasksMatch) {
      if (request.method !== 'GET') return methodNotAllowed(response, '评审任务资源只支持读取。', 'GET')
      const user = await requireUser(request)
      const runId = decodeURIComponent(agentRunReviewTasksMatch[1])
      const run = await productStore.readAgentRun(user.id, runId)
      if (!run) return error(response, 404, 'AGENT_RUN_NOT_FOUND', '未找到该 Agent Run。')
      await requireProjectPermission(productStore, user.id, run.projectId, 'read-operational')
      const tasks = (await productStore.listAgentReviewTasksForRun(user.id, run.projectId, run.id)) ?? []
      return json(response, 200, { tasks: tasks.map(publicAgentReviewTask) })
    }
    if (agentReviewTaskDecisionsMatch) {
      if (request.method !== 'POST') return methodNotAllowed(response, '评审决定资源只接受提交请求。', 'POST')
      const user = await requireUser(request)
      const taskId = decodeURIComponent(agentReviewTaskDecisionsMatch[1])
      const task = await productStore.readAgentReviewTask(user.id, taskId)
      if (!task) return error(response, 404, 'AGENT_REVIEW_TASK_NOT_FOUND', '未找到该评审任务。')
      // 人工决定改变的是候选能否交付，因此按编辑权限校验，而不是只读。
      await requireProjectPermission(productStore, user.id, task.projectId, 'edit')
      const idempotencyKey = generationIdempotencyKey(request.headers['idempotency-key'])
      if (!idempotencyKey) return error(response, 400, 'INVALID_IDEMPOTENCY_KEY', '评审决定标识无效，请重试。')
      const body = await readJson(request, 16 * 1024, '评审决定请求过大。')
      const requested = Array.isArray(body?.decisions) ? body.decisions : [body]
      if (!requested.length || requested.length > 60) return error(response, 400, 'INVALID_AGENT_REVIEW', '评审决定数量无效。')
      let decisions
      try {
        // 批量共享一个 commandId，但逐候选落库：给多个 Artifact 共用一个模糊状态
        // 会让「哪一张被接受了」无法回答。
        decisions = requested.map((entry) => createAgentHumanDecision({
          taskId: task.id,
          projectId: task.projectId,
          artifactId: entry?.artifactId,
          decision: entry?.decision,
          note: entry?.note,
          decidedBy: user.id,
          commandId: requested.length > 1 ? idempotencyKey : undefined,
          idempotencyKey,
        }))
      } catch (caught) {
        if (caught?.name !== 'AgentReviewError') throw caught
        return error(response, caught.statusCode ?? 400, caught.code, caught.message)
      }
      const covered = new Set(task.coverage?.artifactIds ?? [])
      const outside = decisions.filter((decision) => !covered.has(decision.artifactId))
      if (outside.length) {
        return error(response, 409, 'AGENT_REVIEW_ARTIFACT_NOT_COVERED', '决定的候选不在本次评审覆盖范围内。')
      }
      const existing = task.decisions ?? []
      const merged = [...existing.filter((item) => !decisions.some((decision) => decision.id === item.id)), ...decisions]
      const results = (task.results ?? []).map((result) => {
        const decision = decisions.find((item) => item.artifactId === result.artifactId)
        // 接受与拒绝都不覆盖原 Artifact，只改变候选状态。
        return decision ? { ...result, candidateStatus: decision.candidateStatus, updatedAt: decision.decidedAt } : result
      })
      const stored = await productStore.putAgentReviewTask(user.id, { ...task, decisions: merged, results, updatedAt: Date.now() })
      // `retry_requested` 必须产生新的 Run 并关联原 Run/Review/Artifact；原 Artifact 不被覆盖。
      const retries = decisions.filter((decision) => decision.decision === 'retry_requested')
      const retryRuns = []
      if (retries.length) {
        const sourceRun = await productStore.readAgentRun(user.id, task.runId)
        if (sourceRun) {
          for (const retry of retries) {
            // 同一份计划重跑，不改写 Prompt：改写会让重试结果无法与原结果对照。
            const input = createReviewRetryAgentRunInput(sourceRun, {
              reviewTaskId: task.id,
              artifactId: retry.artifactId,
            })
            const id = forkedAgentRunIdForIdempotency(user.id, sourceRun.id, `${idempotencyKey}__${retry.artifactId}`)
            const alreadyCreated = await productStore.readAgentRun(user.id, id)
            const created = alreadyCreated
              ?? await productStore.putAgentRun(user.id, createPersistentAgentRun(input, { id, ownerId: user.id }))
            retryRuns.push({ artifactId: retry.artifactId, runId: created.id })
            if (!alreadyCreated) await publishAgentRunUpdated({ projectId: created.projectId, run: publicAgentRun(created) })
          }
        }
      }
      return json(response, 200, {
        task: publicAgentReviewTask(stored),
        decisions,
        ...(retryRuns.length ? { retryRuns } : {}),
      })
    }
    if (agentRunCancelMatch) {
      if (request.method !== 'POST') return methodNotAllowed(response, 'Agent Run 取消资源只接受提交请求。', 'POST')
      const user = await requireUser(request)
      const runId = decodeURIComponent(agentRunCancelMatch[1])
      const run = await productStore.readAgentRun(user.id, runId)
      if (!run) return error(response, 404, 'AGENT_RUN_NOT_FOUND', '未找到该 Agent Run。')
      await requireProjectPermission(productStore, user.id, run.projectId, 'create-generation')
      const activeJobIds = [...new Set(run.branches.filter((branch) => branch.status === 'queued' || branch.status === 'running').map((branch) => branch.activeJobId).filter(Boolean))]
      for (const jobId of activeJobIds) {
        const job = await productStore.readGenerationJob(user.id, jobId)
        if (!job) continue
        // 走共享取消实现：这里过去漏了广播，Worker 会把 Provider 调用跑完才
        // 发现结果没人要，用户停掉 Run 之后槽位仍被占着。
        await cancelGenerationJob({
          productStore, redisQueue, publishCancel,
          modelOptions: config.modelOptions ?? [],
          ownerId: user.id, job, reason: 'agent-run', requestedBy: user.id,
          afterPersist: (cancelledJob) => agentRunGeneration.persistJobState(user.id, run.projectId, cancelledJob),
        })
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
      const run = await productStore.readAgentRun(user.id, runId)
      if (!run) return error(response, 404, 'AGENT_RUN_NOT_FOUND', '未找到该 Agent Run。')
      await requireProjectPermission(productStore, user.id, run.projectId, 'create-generation')
      // 重试逻辑只有一份实现：两份实现只要幂等键算法有一处不同，同一次重试就会
      // 创建第二个 Job 并再扣一次额度。
      const outcome = await retryAgentBranch({
        userId: user.id,
        runId,
        branchId,
        idempotencyKey: generationIdempotencyKey(request.headers['idempotency-key']),
        requestId,
        actor: user,
      })
      if (outcome.kind === 'error') {
        if (outcome.code === 'RATE_LIMITED') {
          return json(response, 429, { error: { code: outcome.code, message: outcome.message } }, {
            'Retry-After': String(outcome.retryAfterSeconds ?? 1),
          })
        }
        return error(response, outcome.status, outcome.code, outcome.message)
      }
      return json(response, 202, { run: outcome.run, job: outcome.job })
    }
    return false
  }
}
