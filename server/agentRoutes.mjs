import { BotanicAgentPlannerError, validateBotanicAgentPlanInput } from './botanicAgentPlanner.mjs'
import { BotanicAgentChatError, validateBotanicAgentChatInput } from './botanicAgentChat.mjs'
import { reviewBotanicAgentRunResults } from './botanicAgentReview.mjs'
import { normalizeBotanicAgentLocale } from './agentInstructions.mjs'
import { validateBotanicAgentTurnInput } from './botanicAgentTurn.mjs'
import { createAgentSkill, isUsableAgentSkill, publicAgentSkill, validateAgentSkillCreation } from './botanicAgentSkill.mjs'
import { agentRunSubmissionBinding, createPersistentAgentRun, prepareAgentBranchRetry, publicAgentRun, storedAgentRunSubmissionBinding, validateAgentRunCreation } from './botanicAgentRun.mjs'
import { AgentToolRuntimeError, executeConfirmedAgentAction } from './agentToolRuntime.mjs'
import {
  botanicAgentBuiltInSkill,
  botanicAgentSkillToolRisk,
  botanicAgentSystemSkills,
  createBotanicAgentActionToolRegistry,
} from './botanicAgentTools.mjs'
import { decodeAgentMessageCursor } from './agentMessagePersistence.mjs'
import { decodeArtifactCursor, encodeArtifactCursor } from './botanicArtifactIndex.mjs'
import { retryFailedWorkflowItems } from './productionWorkflow.mjs'
import { generationIdempotencyKey, generationJobIdForIdempotency } from './generationIdempotency.mjs'
import { persistedGenerationJob, publicGenerationJob } from './generationProvider.mjs'
import { retargetGenerationJobForRetry } from './generationResultReconciliation.mjs'
import { requireProjectPermission } from './projectAuthorization.mjs'
import { projectPermissionDecision } from './authorization.mjs'
import { buildAgentExecutionTrace } from './agentExecutionTrace.mjs'
import { actionArgumentsHash, agentToolPermission, assertFreshActionApproval, createActionApprovalToken } from './agentActionGovernance.mjs'
import { createBotanicAgentTurnRuntime } from './botanicAgentTurnRuntime.mjs'
import { configuredAgentGenerationModels, createAgentTurnSubmission } from './agentTurnSubmission.mjs'
import { createAgentTurnHttpAdapter } from './agentTurnRoutes.mjs'
import { createAgentCompatibilityTurn } from './agentCompatibilityTurn.mjs'
import { createLocalCancelRegistry } from './localCancelRegistry.mjs'
import { publicAgentReviewTask } from './agentReviewTask.mjs'
import { AgentReviewDecisionServiceError, createAgentReviewDecisionService } from './agentReviewDecisionService.mjs'
import { createAgentReviewService } from './agentReviewService.mjs'
import { createAgentBranchRetryService } from './agentBranchRetryService.mjs'
import { createProductionWorkflowPublishService } from './productionWorkflowPublishService.mjs'
import { selectBotanicAgentMemory } from './botanicAgentMemory.mjs'
import { buildThreadSummaryCheckpoint, shouldCompactThread } from './agentThreadSummary.mjs'
import { compareAndSetDerivedAgentThreadSummary, createAgentThreadContext } from './agentThreadContext.mjs'
import { createAgentContextCoordinator } from './agentContextCoordinator.mjs'
import { resolveAgentContextRollout } from './agentContextRollout.mjs'
import { createAgentContextObserver } from './agentContextObservability.mjs'
import {
  createAgentContextCheckpointEnricher,
  createFlockContextSummaryInvoker,
} from './agentContextSummarizer.mjs'
import {
  AgentManualContextCompactionServiceError,
  createAgentManualContextCompactionService,
} from './agentManualContextCompactionService.mjs'
import { compareBotanicAgentRunBranches } from './botanicAgentCompare.mjs'
import { createForkedAgentRunInput, forkedAgentRunIdForIdempotency } from './botanicAgentFork.mjs'
import { createAgentActionExecution } from './agentActionExecution.mjs'
import {
  agentActionReconciliationIdentity,
  agentActionReconciliationStoreError,
  createAgentActionReconciliation,
} from './agentActionReconciliation.mjs'
import { AgentDelegationFenceError, assertTurnAllowsDelegation, createAgentCancellationService } from './agentCancellationService.mjs'
import { matchingIdempotencyRequestBinding } from './idempotencyRequestBinding.mjs'
import { createAgentMessageRouteHandler } from './agentMessageRoutes.mjs'
import { agentCompatibilityIdempotencyKey } from './agentRuntimeRequest.mjs'
import { createAgentOperationalReaders } from './agentOperationalReaders.mjs'
import { AgentSubagentServiceError } from './agentSubagentService.mjs'
import { createDurableAgentSubagentRunner } from './agentSubagentBroker.mjs'
import { assertAgentTargetBinding } from './agentTargetBinding.mjs'
import {
  AgentSubagentPersistenceError,
  publicAgentSubagent,
  publicAgentSubagentActivation,
} from './agentSubagentPersistence.mjs'

export { BotanicAgentPlannerError, BotanicAgentChatError }

const editableAgentSessionFields = new Set([
  'title', 'executionMode', 'confirmationWaivers', 'plannerModel', 'mountedSkillIds', 'contextNodeIds',
])

const agentSubagentStartBodyFields = new Set(['rootTurnId', 'role', 'content'])
const agentSubagentFollowupBodyFields = new Set(['sourceTurnId', 'content'])
const agentSubagentCancelBodyFields = new Set(['reason'])
const agentSubagentAuthorityFieldPattern = /prompt|instruction|capabilit|tool|model|schema|budget/iu

function agentSubagentBodyFailure(body, allowedFields, label) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { statusCode: 400, code: 'AGENT_SUBAGENT_REQUEST_INVALID', message: `${label}格式无效。` }
  }
  const unsupported = Object.keys(body).find((key) => !allowedFields.has(key))
  if (!unsupported) return undefined
  if (agentSubagentAuthorityFieldPattern.test(unsupported)) {
    return {
      statusCode: 403,
      code: 'AGENT_SUBAGENT_AUTHORITY_FORBIDDEN',
      message: '客户端不能提交 Subagent 系统指令、模型或能力定义。',
    }
  }
  return {
    statusCode: 400,
    code: 'AGENT_SUBAGENT_REQUEST_INVALID',
    message: `${label}包含未声明字段：${unsupported}。`,
  }
}

function publicAgentSubagentMutation(outcome) {
  const subagent = publicAgentSubagent(outcome?.subagent)
  const activation = publicAgentSubagentActivation(outcome?.activation)
  return {
    kind: outcome?.kind,
    changed: outcome?.changed === true,
    ...(subagent ? { subagent } : {}),
    ...(activation ? { activation } : {}),
  }
}

function publicAgentSubagentMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)
    || typeof message.id !== 'string' || typeof message.content !== 'string') return undefined
  return {
    id: message.id,
    role: message.role,
    kind: message.kind,
    content: message.content,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    ...(typeof message.turnId === 'string' ? { turnId: message.turnId } : {}),
    ...(typeof message.status === 'string' ? { status: message.status } : {}),
    ...(Array.isArray(message.entityReferences)
      ? { entityReferences: structuredClone(message.entityReferences) }
      : {}),
  }
}

function isAuthorizedAgentMediaUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('/api/media/') || value.length > 2048) return false
  try {
    const parsed = new URL(value, 'http://botanic.internal')
    return parsed.origin === 'http://botanic.internal' && parsed.pathname.startsWith('/api/media/')
  } catch {
    return false
  }
}

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
    if (response.writableEnded || response.destroyed) return false
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
      if (!response.writableEnded && !response.destroyed) response.end()
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
  agentSubagentService,
  agentManualContextCompactionService,
}) {
  // 看图只读当前项目内的媒体：readGenerationInput 校验归属，图片字节不离开服务端与模型网关。
  const visionMediaResolver = (userId, projectId) => (mediaService?.enabled
    ? (mediaId, options) => mediaService.readGenerationInput(userId, mediaId, projectId, options)
    : undefined)
  const authorizedWebResearchQuota = (userId, projectId) => async () => {
    await requireProjectPermission(productStore, userId, projectId, 'execute-external-tool')
    return consumeWebResearchQuota?.(userId, projectId, 'execute-external-tool')
  }
  const configuredMcpCatalog = () => (
    typeof configuredMcpTools?.catalog === 'function' ? configuredMcpTools.catalog() : []
  )
  // HTTP 连接只是观察者；Runtime 与跨实例取消订阅方共用这张执行句柄表。
  const cancelRegistry = localCancelRegistry ?? createLocalCancelRegistry()
  const agentTurnRuntime = createBotanicAgentTurnRuntime({ productStore, localCancelRegistry: cancelRegistry })
  let agentTurnSubmissionModule
  const turnSubmission = () => {
    agentTurnSubmissionModule ??= createAgentTurnSubmission({
      productStore,
      runtime: agentTurnRuntime,
      config,
      resolveThreadContext: (input) => authoritativeThreadContext().resolve(input),
      resolveLegacyThreadSummary: (...args) => threadSummaryForSession(...args),
      resolveVisionMedia: visionMediaResolver,
      durableSubagentRunner,
      observeAgentContext,
      enrichAgentContextCheckpoint,
      persistUsageAnchor: persistAgentContextUsageAnchor,
      consumeWebResearchQuota,
    })
    return agentTurnSubmissionModule
  }
  // 正式 HTTP 入口绝不回退到进程内 Subagent：未完整配置时显式注入 undefined，
  // Planner 会直接隐藏派发工具；配置完整时则统一走 descriptor/queue/Turn Runtime。
  const durableSubagentRunner = agentSubagentService
    && config?.agentSubagentModel
    && config?.flockApiKey
    ? createDurableAgentSubagentRunner({ service: agentSubagentService })
    : undefined

  let compatibilityTurnModule
  const executeCompatibilityTurn = (command) => {
    compatibilityTurnModule ??= createAgentCompatibilityTurn({
      config,
      productStore,
      turnSubmission,
      durableSubagentRunner,
      observeAgentContext,
      enrichAgentContextCheckpoint,
      persistUsageAnchor: persistAgentContextUsageAnchor,
    })
    return compatibilityTurnModule(command)
  }
  let agentCancellation
  const cancellationService = () => {
    agentCancellation ??= createAgentCancellationService({
      productStore,
      cancelTurn: (command) => agentTurnRuntime.cancel(command),
      finalizeTurn: (command) => agentTurnRuntime.finalizeCancellation(command),
      cancelSubagent: (command) => {
        if (typeof agentSubagentService?.cancel !== 'function') {
          throw new AgentSubagentServiceError(
            'AGENT_SUBAGENT_CANCELLATION_UNAVAILABLE',
            'Subagent 取消服务尚未配置。',
            503,
          )
        }
        return agentSubagentService.cancel(command)
      },
      redisQueue,
      publishCancel,
      modelOptions: config?.modelOptions ?? [],
      afterGenerationJobPersist: agentRunGeneration?.persistJobState
        ? ({ userId, projectId, job }) => agentRunGeneration.persistJobState(userId, projectId, job)
        : undefined,
    })
    return agentCancellation
  }
  // pre-put fence 只能收窄竞态，不能消灭「检查通过 → Turn 被取消 → Run 落库」的
  // TOCTOU。落库后再读一次权威 Turn；若 fence 已关闭，立刻用同一深取消服务补偿
  // 新 Run（包括尚无 Job 的 queued Run），再把稳定的 delegation 错误交给调用方。
  const enforceDelegationAfterPut = async (userId, run) => {
    if (!run?.turnId) return run
    try {
      await assertTurnAllowsDelegation({
        productStore, userId, projectId: run.projectId, turnId: run.turnId,
      })
      return run
    } catch (caught) {
      if (!(caught instanceof AgentDelegationFenceError)) throw caught
      await cancellationService().cancelAgentRun({
        userId, projectId: run.projectId, runId: run.id, requestedBy: userId,
      })
      const cancelledRun = await productStore.readAgentRun(userId, run.id) ?? run
      await Promise.allSettled([
        publishAgentRunUpdated?.({ projectId: run.projectId, run: publicAgentRun(cancelledRun) }),
      ])
      throw caught
    }
  }
  let agentActionExecution
  const durableAgentActionExecution = () => {
    agentActionExecution ??= createAgentActionExecution({
      productStore,
      timeoutMs: agentActionTimeoutMs,
    })
    return agentActionExecution
  }
  let agentActionReconciliation
  const durableAgentActionReconciliation = () => {
    agentActionReconciliation ??= createAgentActionReconciliation({ productStore })
    return agentActionReconciliation
  }
  let agentThreadContext
  let agentContextCoordinator
  let manualAgentContextCompaction = agentManualContextCompactionService
  const observeAgentContext = createAgentContextObserver()
  // 仅 Runtime 环内 ephemeral 压缩；默认关。不进 Coordinator CAS / Shadow / 手动压缩。
  const enrichAgentContextCheckpoint = config.agentContextLlmSummary
    ? createAgentContextCheckpointEnricher({
      enabled: true,
      invokeChat: createFlockContextSummaryInvoker(config),
      observe: observeAgentContext,
    })
    : undefined
  const durableAgentContextCoordinator = () => {
    agentContextCoordinator ??= createAgentContextCoordinator({
      productStore,
      policies: config.agentModelContextPolicies,
      observe: observeAgentContext,
    })
    return agentContextCoordinator
  }
  const persistAgentContextUsageAnchor = ({ userId, projectId, sessionId }) => async (usageAnchor) => (
    durableAgentContextCoordinator().persistUsageAnchor({
      userId,
      projectId,
      sessionId,
      usageAnchor,
    })
  )
  const compactAgentContextManually = () => {
    manualAgentContextCompaction ??= createAgentManualContextCompactionService({
      productStore,
      policies: config.agentModelContextPolicies,
      defaultModel: config.flockTextModel,
      observe: observeAgentContext,
    })
    return manualAgentContextCompaction
  }
  const authoritativeThreadContext = () => {
    agentThreadContext ??= createAgentThreadContext({
      productStore,
      contextV2: {
        resolveRollout: ({ userId, projectId }) => resolveAgentContextRollout({
          featureFlags: config.agentFeatureFlags,
          rolloutFlags: config.rolloutFlags,
          userId,
          projectId,
        }),
        policies: config.agentModelContextPolicies,
        observe: observeAgentContext,
      },
    })
    return agentThreadContext
  }
  const methodNotAllowed = (response, message, allow) => json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message } }, { Allow: allow })
  const hasAgentSubagentService = () => ['start', 'followup', 'read', 'cancel']
    .every((name) => typeof agentSubagentService?.[name] === 'function')
  const callAgentSubagentService = async (response, operation) => {
    try {
      return { outcome: await operation() }
    } catch (caught) {
      if (!(caught instanceof AgentSubagentServiceError)
        && !(caught instanceof AgentSubagentPersistenceError)) throw caught
      return { handled: error(response, caught.statusCode, caught.code, caught.message) }
    }
  }
  const agentSubagentEnqueueResponse = (response, outcome) => {
    if (outcome?.kind === 'missing') {
      return error(response, 404, 'AGENT_SUBAGENT_NOT_FOUND', '未找到该 Subagent。')
    }
    if (outcome?.kind === 'inactive') {
      return error(response, 409, 'AGENT_SUBAGENT_INACTIVE', 'Subagent 已停止，不能继续追加消息。')
    }
    if (outcome?.kind === 'conflict') {
      return error(response, 409, 'AGENT_SUBAGENT_IDEMPOTENCY_CONFLICT', '同一提交标识已绑定到不同请求。')
    }
    if (!['enqueued', 'replay'].includes(outcome?.kind) || !outcome?.subagent || !outcome?.activation) {
      return error(response, 503, 'AGENT_SUBAGENT_ENQUEUE_FAILED', 'Subagent 请求暂未可靠入队，请稍后重试。')
    }
    return json(response, outcome.kind === 'enqueued' ? 202 : 200, publicAgentSubagentMutation(outcome))
  }
  const observeRun = (event) => {
    try { observeAgentRun(event) } catch { /* 运行日志不得阻断用户请求。 */ }
  }
  // 需要短期审批 Token 的行动：会花钱或触达外部系统的那些。运维写工具里
  // 重试分支与重试工作流失败项都会真的调用 Provider，因此同样进这个集合。
  const approvalRequired = new Set([
    'generation_submit', 'mcp_call', 'agent_branch_retry', 'review_retry', 'workflow_run_retry_failed',
  ])
  // 这些动作有稳定自有身份且重放无新增副作用；其余（MCP、创建 Skill、
  // 发布 Workflow、提交/重试计费任务）出现未知结果时一律停下，不自动再执行。
  const safelyReplayableAgentActions = new Set([
    'workflow_create', 'skill_apply', 'agent_run_cancel', 'artifact_promote',
    'review_decide', 'review_retry', 'workflow_run_retry_failed',
  ])
  // 这三条路径在存量客户端中本来就不属于 Message Proposal：
  // Run 确认的工作流/生成提交，以及 Skill Registry 直接创建。
  // 其他 HTTP Action 即使省略 context，也必须反查到唯一权威 Proposal。
  const standaloneAgentActions = new Set(['workflow_create', 'generation_submit', 'skill_create'])
  const projectAgentActionIdempotencyKey = (action) => {
    const actionKey = `${action.id}-${action.toolName}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 112)
    return `agent-action-${actionKey}`
  }
  const actionHasContext = (body) => ['sessionId', 'messageId', 'actionId']
    .some((field) => typeof body?.[field] === 'string' && body[field].trim())
  const requireActionProposal = async ({
    user, projectId, actionName, toolCallId, argumentsValue, body, requireExactContext = false,
  }) => {
    const contextual = requireExactContext || actionHasContext(body)
    if (contextual) {
      const sessionId = text(body?.sessionId, '会话', 160)
      const messageId = text(body?.messageId, '消息', 160)
      const actionId = text(body?.actionId, '行动', 160)
      const state = await productStore.readAgentState(user.id, projectId)
      const session = state?.sessions?.find((candidate) => candidate.id === sessionId)
      const message = session?.messages?.find((candidate) => candidate.id === messageId)
      const proposal = message?.plan?.actions?.find((candidate) => candidate.id === actionId)
      if (!proposal
        || proposal.id !== toolCallId
        || proposal.toolName !== actionName
        || proposal.status === 'dismissed') {
        throw new AgentToolRuntimeError('ACTION_PROPOSAL_NOT_FOUND', '该行动不属于指定的会话或消息，请重新规划。', 409)
      }
      if (actionArgumentsHash(proposal.arguments) !== actionArgumentsHash(argumentsValue)) {
        throw new AgentToolRuntimeError('ACTION_PROPOSAL_MISMATCH', '行动参数已变化，请重新确认。', 409)
      }
      return { session, message, proposal, contextual: true }
    }
    if (actionName === 'generation_submit') {
      const runId = text(argumentsValue?.planId, 'Agent Run', 160)
      const run = await productStore.readAgentRun(user.id, runId)
      if (!run || run.projectId !== projectId || !['awaiting_confirmation', 'queued', 'executing', 'running'].includes(run.status)) {
        throw new AgentToolRuntimeError('ACTION_PROPOSAL_NOT_FOUND', '该生成行动已不存在或已完成，请重新规划。', 409)
      }
      return { contextual: false }
    }
    const state = await productStore.readAgentState(user.id, projectId)
    const matches = (state?.sessions ?? []).flatMap((session) => (
      (session.messages ?? []).flatMap((message) => (
        (message.plan?.actions ?? [])
          .filter((action) => action.id === toolCallId
            && action.toolName === actionName
            && action.status !== 'dismissed')
          .map((proposal) => ({ session, message, proposal }))
      ))
    ))
    // 不用 find：历史数据如果有重复 action id，省略 context 时不能猜一条执行。
    if (matches.length !== 1) {
      throw new AgentToolRuntimeError('ACTION_PROPOSAL_NOT_FOUND', '该行动已不存在或已处理，请重新规划。', 409)
    }
    const { session, message, proposal } = matches[0]
    if (actionArgumentsHash(proposal.arguments) !== actionArgumentsHash(argumentsValue)) {
      throw new AgentToolRuntimeError('ACTION_PROPOSAL_MISMATCH', '行动参数已变化，请重新确认。', 409)
    }
    return { session, message, proposal, contextual: true, inferredContext: true }
  }
  const authoritativeActionAttempt = ({ user, projectId, proposalContext, idempotencyKey }) => {
    const { session, message, proposal } = proposalContext
    const originalIdempotencyKey = projectAgentActionIdempotencyKey(proposal)
    const action = {
      userId: user.id,
      projectId,
      sessionId: session.id,
      messageId: message.id,
      actionId: proposal.id,
      toolCallId: proposal.id,
      name: proposal.toolName,
      arguments: proposal.arguments,
      idempotencyKey,
    }
    const originalAction = { ...action, idempotencyKey: originalIdempotencyKey }
    return {
      action,
      originalAction,
      originalIdempotencyKey,
      manualRetry: idempotencyKey !== originalIdempotencyKey,
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
  const handleAgentMessageRoute = createAgentMessageRouteHandler({
    productStore, json, error, readJson, requireUser, methodNotAllowed,
    resolveMedia: visionMediaResolver, recordCollaborationActivity,
  })
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
  let agentReviewDecision
  const reviewDecisionService = () => {
    agentReviewDecision ??= createAgentReviewDecisionService({ productStore })
    return agentReviewDecision
  }
  let agentReviewOperations
  const reviewOperationsService = () => {
    agentReviewOperations ??= createAgentReviewService({
      productStore,
      publishCancel,
      observe: (event) => observeRun(event),
    })
    return agentReviewOperations
  }
  const commitAgentReviewAction = async (command) => {
    try {
      return await reviewDecisionService()(command)
    } catch (caught) {
      if (!(caught instanceof AgentReviewDecisionServiceError)) throw caught
      throw new AgentToolRuntimeError(caught.code, caught.message, caught.statusCode)
    }
  }

  /**
   * 线程摘要检查点（Epic 8）。
   *
   * 回合请求只带最近一个窗口的消息，超出窗口的早期决策会彻底消失。这里从持久化的
   * 会话消息里**确定性**派生检查点并写回会话 —— 让模型复述一遍约束，就没有任何东西
   * 能保证它复述对了。
   *
   * CAS 冲突代表已有更新者胜出，可以继续；权限、Store 与契约错误必须 fail closed，
   * 否则当前回合会在无法证明摘要版本的情况下继续执行。
   */
  const threadSummaryForSession = async (userId, projectId, sessionId) => {
    if (!sessionId || typeof productStore.readAgentState !== 'function') return undefined
    if (typeof productStore.compareAndSetAgentThreadSummary !== 'function') {
      throw new TypeError('Agent Thread Summary CAS Interface 缺失。')
    }
    const projectState = await productStore.readAgentState(userId, projectId)
    const session = (projectState?.sessions ?? []).find((entry) => entry?.id === sessionId)
    if (!session) return undefined
    const messages = session.messages ?? []
    if (!shouldCompactThread(messages)) return session.threadSummary
    // 摘要有独立 CAS 版本；Session 主更新时间不会因 compaction 改变，因此增量版本
    // 必须同时晚于旧摘要。兼容旧客户端的路径也不能复用/回退摘要时间戳。
    const checkpointAt = Math.max(
      (Number(session.updatedAt) || 0) + 1,
      (Number(session.threadSummary?.updatedAt) || 0) + 1,
      Date.now(),
    )
    const summary = buildThreadSummaryCheckpoint({
      messages,
      previous: session.threadSummary,
      now: checkpointAt,
      // readAgentState 返回 Adapter 的完整有界会话窗口（messagesPerSession），因此
      // legacy v1 可在这条兼容路径从零升级 provenance；不完整分页路径由 ThreadContext 处理。
      fullHistory: true,
    })
    if (summary && summary !== session.threadSummary) {
      await compareAndSetDerivedAgentThreadSummary({ productStore, userId, session, summary })
    }
    return summary
  }

  const bindAuthoritativeKnowledge = async (userId, input) => {
    const [projectState, projectSkills] = await Promise.all([
      typeof productStore.readAgentState === 'function' ? productStore.readAgentState(userId, input.projectId, { includeMessages: false }) : undefined,
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
  let agentTurnHttpAdapter
  const turnHttpAdapter = () => {
    agentTurnHttpAdapter ??= createAgentTurnHttpAdapter({
      config,
      productStore,
      json,
      error,
      readJson,
      requireUser,
      enforceRateLimit,
      createSse: createServerSentEventWriter,
      turnSubmission,
      cancellationService,
      publishAgentRunUpdated,
    })
    return agentTurnHttpAdapter
  }
  return async function handleAgentRoute(request, response, url, routeMatches, requestId) {
    const turnHandled = await turnHttpAdapter()({ request, response, url, routeMatches, requestId })
    if (turnHandled !== false) return turnHandled
    const {
      projectAgentRuns: projectAgentRunsMatch,
      projectAgentSkills: projectAgentSkillsMatch,
      projectAgentSkillVersion: projectAgentSkillVersionMatch,
      agentSkillCatalog: agentSkillCatalogMatch,
      projectAgentState: projectAgentStateMatch,
      projectAgentSessions: projectAgentSessionsMatch,
      agentSessionContextCompactions: agentSessionContextCompactionsMatch,
      agentSessionMessages: agentSessionMessagesMatch,
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
      agentReviewTaskCancel: agentReviewTaskCancelMatch,
      agentReviewTaskReconciliation: agentReviewTaskReconciliationMatch,
      agentRunCancel: agentRunCancelMatch,
      agentBranchRetry: agentBranchRetryMatch,
      projectAgentSubagents: projectAgentSubagentsMatch,
      agentSubagent: agentSubagentMatch,
      agentSubagentFollowups: agentSubagentFollowupsMatch,
      agentSubagentCancel: agentSubagentCancelMatch,
      agentReviewDecision: agentReviewDecisionMatch,
    } = routeMatches

    if (projectAgentSubagentsMatch) {
      if (request.method !== 'POST') return methodNotAllowed(response, '项目 Subagent 资源只接受提交请求。', 'POST')
      const user = await requireUser(request)
      if (!hasAgentSubagentService()) {
        return error(response, 503, 'AGENT_SUBAGENT_SERVICE_UNAVAILABLE', 'Subagent 服务暂不可用。')
      }
      const idempotencyKey = generationIdempotencyKey(request.headers['idempotency-key'])
      if (!idempotencyKey) return error(response, 400, 'INVALID_IDEMPOTENCY_KEY', 'Subagent 提交标识无效，请重试。')
      const body = await readJson(request, 256 * 1024, 'Subagent 请求过大，请精简后重试。')
      const bodyFailure = agentSubagentBodyFailure(body, agentSubagentStartBodyFields, 'Subagent start 请求')
      if (bodyFailure) return error(response, bodyFailure.statusCode, bodyFailure.code, bodyFailure.message)
      const projectId = decodeURIComponent(projectAgentSubagentsMatch[1])
      await requireProjectPermission(productStore, user.id, projectId, 'edit')
      const serviceCall = await callAgentSubagentService(response, () => agentSubagentService.start({
        userId: user.id,
        projectId,
        rootTurnId: body.rootTurnId,
        role: body.role,
        content: body.content,
        idempotencyKey,
        requestId,
      }))
      if ('handled' in serviceCall) return serviceCall.handled
      return agentSubagentEnqueueResponse(response, serviceCall.outcome)
    }

    if (agentSubagentFollowupsMatch) {
      if (request.method !== 'POST') return methodNotAllowed(response, 'Subagent Followup 资源只接受提交请求。', 'POST')
      const user = await requireUser(request)
      if (!hasAgentSubagentService()) {
        return error(response, 503, 'AGENT_SUBAGENT_SERVICE_UNAVAILABLE', 'Subagent 服务暂不可用。')
      }
      const idempotencyKey = generationIdempotencyKey(request.headers['idempotency-key'])
      if (!idempotencyKey) return error(response, 400, 'INVALID_IDEMPOTENCY_KEY', 'Subagent Followup 提交标识无效，请重试。')
      const body = await readJson(request, 256 * 1024, 'Subagent Followup 请求过大，请精简后重试。')
      const bodyFailure = agentSubagentBodyFailure(body, agentSubagentFollowupBodyFields, 'Subagent followup 请求')
      if (bodyFailure) return error(response, bodyFailure.statusCode, bodyFailure.code, bodyFailure.message)
      const subagentId = decodeURIComponent(agentSubagentFollowupsMatch[1])
      const current = await productStore.readAgentSubagent(user.id, subagentId)
      if (!current) return error(response, 404, 'AGENT_SUBAGENT_NOT_FOUND', '未找到该 Subagent。')
      await requireProjectPermission(productStore, user.id, current.projectId, 'edit')
      const serviceCall = await callAgentSubagentService(response, () => agentSubagentService.followup({
        userId: user.id,
        subagentId,
        sourceTurnId: body.sourceTurnId,
        content: body.content,
        idempotencyKey,
        requestId,
      }))
      if ('handled' in serviceCall) return serviceCall.handled
      return agentSubagentEnqueueResponse(response, serviceCall.outcome)
    }

    if (agentSubagentCancelMatch) {
      if (request.method !== 'POST') return methodNotAllowed(response, 'Subagent 取消资源只接受提交请求。', 'POST')
      const user = await requireUser(request)
      if (!hasAgentSubagentService()) {
        return error(response, 503, 'AGENT_SUBAGENT_SERVICE_UNAVAILABLE', 'Subagent 服务暂不可用。')
      }
      const idempotencyKey = generationIdempotencyKey(request.headers['idempotency-key'])
      if (!idempotencyKey) return error(response, 400, 'INVALID_IDEMPOTENCY_KEY', 'Subagent 取消标识无效，请重试。')
      const body = await readJson(request, 8 * 1024, 'Subagent 取消请求过大。')
      const bodyFailure = agentSubagentBodyFailure(body, agentSubagentCancelBodyFields, 'Subagent cancel 请求')
      if (bodyFailure) return error(response, bodyFailure.statusCode, bodyFailure.code, bodyFailure.message)
      if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 500)) {
        return error(response, 400, 'AGENT_SUBAGENT_REQUEST_INVALID', 'Subagent 取消原因格式无效。')
      }
      const subagentId = decodeURIComponent(agentSubagentCancelMatch[1])
      const current = await productStore.readAgentSubagent(user.id, subagentId)
      if (!current) return error(response, 404, 'AGENT_SUBAGENT_NOT_FOUND', '未找到该 Subagent。')
      await requireProjectPermission(productStore, user.id, current.projectId, 'edit')
      const serviceCall = await callAgentSubagentService(response, () => agentSubagentService.cancel({
        userId: user.id,
        projectId: current.projectId,
        subagentId,
        idempotencyKey,
        ...(body.reason?.trim() ? { reason: body.reason.trim() } : {}),
      }))
      if ('handled' in serviceCall) return serviceCall.handled
      const outcome = serviceCall.outcome
      if (outcome?.kind === 'missing') return error(response, 404, 'AGENT_SUBAGENT_NOT_FOUND', '未找到该 Subagent。')
      if (['conflict', 'stale', 'not_cancelling'].includes(outcome?.kind)) {
        return error(response, 409, 'AGENT_SUBAGENT_CANCELLATION_CONFLICT', 'Subagent 取消请求与当前状态冲突。')
      }
      const stored = await productStore.readAgentSubagent(user.id, subagentId)
      if (!stored) return error(response, 404, 'AGENT_SUBAGENT_NOT_FOUND', '未找到该 Subagent。')
      if (!['cancelling', 'cancelled'].includes(stored.status)) {
        return error(response, 409, 'AGENT_SUBAGENT_NOT_CANCELLABLE', '该 Subagent 当前不可取消。')
      }
      return json(response, stored.status === 'cancelling' ? 202 : 200, {
        kind: outcome?.kind,
        changed: outcome?.changed === true,
        subagent: publicAgentSubagent(stored),
      })
    }

    if (agentSubagentMatch) {
      if (request.method !== 'GET') return methodNotAllowed(response, 'Subagent 资源只支持读取。', 'GET')
      const user = await requireUser(request)
      if (!hasAgentSubagentService()) {
        return error(response, 503, 'AGENT_SUBAGENT_SERVICE_UNAVAILABLE', 'Subagent 服务暂不可用。')
      }
      const subagentId = decodeURIComponent(agentSubagentMatch[1])
      const current = await productStore.readAgentSubagent(user.id, subagentId)
      if (!current) return error(response, 404, 'AGENT_SUBAGENT_NOT_FOUND', '未找到该 Subagent。')
      await requireProjectPermission(productStore, user.id, current.projectId, 'read')
      const rawAfterSequence = url.searchParams.get('afterSequence')
      const rawLimit = url.searchParams.get('limit')
      if (rawAfterSequence !== null && !/^\d+$/.test(rawAfterSequence)) {
        return error(response, 400, 'INVALID_AGENT_SUBAGENT_CURSOR', 'Subagent Activation 游标无效。')
      }
      if (rawLimit !== null && !/^\d+$/.test(rawLimit)) {
        return error(response, 400, 'INVALID_AGENT_SUBAGENT_LIMIT', 'Subagent Activation 数量无效。')
      }
      const afterSequence = rawAfterSequence === null ? 0 : Number(rawAfterSequence)
      const limit = rawLimit === null ? 50 : Number(rawLimit)
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0
        || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
        return error(response, 400, 'INVALID_AGENT_SUBAGENT_CURSOR', 'Subagent Activation 续读参数无效。')
      }
      const serviceCall = await callAgentSubagentService(response, () => agentSubagentService.read(
        user.id,
        subagentId,
        { afterSequence, limit },
      ))
      if ('handled' in serviceCall) return serviceCall.handled
      const snapshot = serviceCall.outcome
      if (!snapshot?.subagent) return error(response, 404, 'AGENT_SUBAGENT_NOT_FOUND', '未找到该 Subagent。')
      const activations = (Array.isArray(snapshot.activations) ? snapshot.activations : [])
        .map(publicAgentSubagentActivation)
        .filter(Boolean)
      const messages = (Array.isArray(snapshot.messages) ? snapshot.messages : [])
        .map(publicAgentSubagentMessage)
        .filter(Boolean)
      return json(response, 200, {
        subagent: publicAgentSubagent(snapshot.subagent),
        activations,
        messages,
        cursor: {
          afterSequence: activations.at(-1)?.sequence ?? afterSequence,
          hasMore: activations.length === limit,
        },
      })
    }

    if (agentReviewDecisionMatch) {
      if (request.method !== 'POST') return methodNotAllowed(response, 'Agent 评审决策只接受提交请求。', 'POST')
      const user = await requireUser(request)
      const body = await readJson(request, 8 * 1024, 'Agent 评审决策请求过大。')
      const projectId = text(body?.projectId, '项目', 160)
      const decision = text(body?.decision, '评审决策', 32)
      // 旧版 Run 级 Review 没有 Artifact/Job 输出身份，无法安全物化重试 Run。
      // 新请求只允许状态决定；重试必须走 ReviewTask 的原子决定资源。
      if (!['accepted', 'rejected'].includes(decision)) return error(response, 400, 'AGENT_REVIEW_DECISION_INVALID', '旧版评审只支持接受或拒绝；请求重试请使用候选评审任务。')
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
        productStore.readAgentState(user.id, validatedInput.projectId, { includeMessages: false }),
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
        availableMcpTools: configuredMcpCatalog(),
      }
      const idempotencyKey = agentCompatibilityIdempotencyKey(
        'plan', input, request.headers['idempotency-key'], requestId,
      )
      const sse = streaming ? createServerSentEventWriter(response) : undefined
      sse?.start()
      try {
        const execution = await executeCompatibilityTurn({
          operation: 'plan',
          request,
          response,
          user,
          projectId: validatedInput.projectId,
          requestId,
          idempotencyKey,
          input,
          sse,
          resolveOptions: {
            document: project?.document,
            projectSkills,
            observeAgentContext,
            consumeWebResearchQuota: consumeWebResearchQuota
              ? () => consumeWebResearchQuota(user.id, validatedInput.projectId, 'execute-external-tool')
              : undefined,
          },
        })
        if (execution.detached) return true
        if (execution.pending) return json(response, 202, {
          runtimeTurn: execution.runtimeTurn,
          observer: execution.observer,
        })
        if (!sse) return json(response, 200, { ...execution.body, runtimeTurn: execution.runtimeTurn })
        sse.send({ type: 'done', ...execution.body, runtimeTurn: execution.runtimeTurn })
        return sse.end()
      } catch (caught) {
        if (response.destroyed) return true
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
      if (!validatedInput.sessionId || !validatedInput.inputMessage) {
        return error(response, 400, 'AGENT_THREAD_CONTEXT_REQUIRED', 'Agent 对话必须使用会话与当前消息的稳定身份。')
      }
      const access = await requireProjectPermission(productStore, user.id, validatedInput.projectId, 'read')
      const project = await productStore.readProject(user.id, validatedInput.projectId)
      if (!project?.document) return error(response, 404, 'PROJECT_NOT_FOUND', '未找到项目或你没有访问权限。')
      const projectSkills = await productStore.listAgentSkills(user.id, validatedInput.projectId) ?? []
      const threadContext = await authoritativeThreadContext().resolve({
        userId: user.id,
        projectId: validatedInput.projectId,
        sessionId: validatedInput.sessionId,
        locale: validatedInput.locale,
        model: validatedInput.plannerModel || config.flockTextModel,
        inputMessage: { ...validatedInput.inputMessage, role: 'user' },
      })
      const input = {
        ...validatedInput,
        messages: [
          ...(threadContext.threadSummaryText
            ? [{ role: 'user', content: threadContext.threadSummaryText }]
            : []),
          ...threadContext.messages,
        ],
        threadContextSnapshot: structuredClone(threadContext.threadContextSnapshot),
      }
      const idempotencyKey = agentCompatibilityIdempotencyKey(
        'chat', input, request.headers['idempotency-key'], requestId,
      )
      const sse = streaming ? createServerSentEventWriter(response) : undefined
      // 先打开通道再等模型：搜索前后的静默期靠注释心跳维持反代连接。
      sse?.start()
      try {
        const execution = await executeCompatibilityTurn({
          operation: 'chat',
          request,
          response,
          user,
          projectId: validatedInput.projectId,
          sessionId: validatedInput.sessionId,
          requestId,
          idempotencyKey,
          input,
          sse,
          resolveOptions: {
            document: project.document,
            projectSkills,
            observeAgentContext,
            role: access.role,
            requireTargetVision: true,
            allowWebResearch: projectPermissionDecision(access.role, 'execute-external-tool') === 'allow',
            resolveVisionMedia: visionMediaResolver(user.id, validatedInput.projectId),
            consumeWebResearchQuota: authorizedWebResearchQuota(user.id, validatedInput.projectId),
          },
        })
        if (execution.detached) return true
        if (execution.pending) return json(response, 202, {
          runtimeTurn: execution.runtimeTurn,
          observer: execution.observer,
        })
        if (!sse) return json(response, 200, { ...execution.body, runtimeTurn: execution.runtimeTurn })
        // done 事件携带与非流式完全一致的响应体，客户端据此收敛这一轮。
        sse.send({ type: 'done', ...execution.body, runtimeTurn: execution.runtimeTurn })
        return sse.end()
      } catch (caught) {
        if (response.destroyed) return true
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
      if (!validatedInput.sessionId && config.agentLegacyClientHistory !== true) {
        return error(response, 426, 'AGENT_THREAD_CONTEXT_REQUIRED', 'Agent 意图请求必须使用会话与当前消息的稳定身份。')
      }
      const access = await requireProjectPermission(productStore, user.id, validatedInput.projectId, 'read')
      const project = await productStore.readProject(user.id, validatedInput.projectId)
      if (!project?.document) return error(response, 404, 'PROJECT_NOT_FOUND', '未找到项目或你没有访问权限。')
      const projectSkills = await productStore.listAgentSkills(user.id, validatedInput.projectId) ?? []
      let canonicalInput = validatedInput
      let threadSummary
      if (validatedInput.sessionId && validatedInput.inputMessage) {
        const threadContext = await authoritativeThreadContext().resolve({
          userId: user.id,
          projectId: validatedInput.projectId,
          sessionId: validatedInput.sessionId,
          locale: validatedInput.locale,
          model: validatedInput.plannerModel || config.flockTextModel,
          inputMessage: { ...validatedInput.inputMessage, role: 'user' },
        })
        canonicalInput = {
          ...validatedInput,
          messages: threadContext.messages,
          threadContextSnapshot: structuredClone(threadContext.threadContextSnapshot),
        }
        threadSummary = threadContext.threadSummary
      } else {
        threadSummary = await threadSummaryForSession(
          user.id,
          validatedInput.projectId,
          typeof request.headers['x-agent-session-id'] === 'string' ? request.headers['x-agent-session-id'] : undefined,
        )
        canonicalInput = {
          ...canonicalInput,
          threadContextSnapshot: {
            version: 1,
            messages: structuredClone(canonicalInput.messages ?? []),
            ...(threadSummary ? { threadSummary: structuredClone(threadSummary) } : {}),
          },
        }
      }
      const input = { ...canonicalInput, generationModels: configuredAgentGenerationModels(config) }
      const idempotencyKey = agentCompatibilityIdempotencyKey(
        'intent', input, request.headers['idempotency-key'], requestId,
      )
      const sse = streaming ? createServerSentEventWriter(response) : undefined
      sse?.start()
      try {
        const execution = await executeCompatibilityTurn({
          operation: 'intent',
          request,
          response,
          user,
          projectId: validatedInput.projectId,
          sessionId: validatedInput.sessionId,
          requestId,
          idempotencyKey,
          input,
          sse,
          resolveOptions: {
            document: project.document,
            projectSkills,
            observeAgentContext,
            role: access.role,
            requireTargetVision: true,
            allowWebResearch: projectPermissionDecision(access.role, 'execute-external-tool') === 'allow',
            ...(threadSummary ? { threadSummary } : {}),
            operations: createAgentOperationalReaders({
              productStore,
              userId: user.id,
              projectId: validatedInput.projectId,
              document: project.document,
            }),
            resolveVisionMedia: visionMediaResolver(user.id, validatedInput.projectId),
            consumeWebResearchQuota: authorizedWebResearchQuota(user.id, validatedInput.projectId),
          },
        })
        if (execution.detached) return true
        if (execution.pending) return json(response, 202, {
          runtimeTurn: execution.runtimeTurn,
          observer: execution.observer,
        })
        if (!sse) return json(response, 200, { ...execution.body, runtimeTurn: execution.runtimeTurn })
        sse.send({ type: 'done', ...execution.body, runtimeTurn: execution.runtimeTurn })
        return sse.end()
      } catch (caught) {
        if (response.destroyed) return true
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

    if (projectAgentSkillVersionMatch) {
      if (request.method !== 'GET') return methodNotAllowed(response, 'Skill 历史版本只支持读取。', 'GET')
      const user = await requireUser(request)
      const projectId = decodeURIComponent(projectAgentSkillVersionMatch[1])
      const skillId = decodeURIComponent(projectAgentSkillVersionMatch[2])
      const rawVersion = decodeURIComponent(projectAgentSkillVersionMatch[3])
      if (!/^\d+$/.test(rawVersion) || !Number.isSafeInteger(Number(rawVersion)) || Number(rawVersion) < 1) {
        return error(response, 400, 'INVALID_AGENT_SKILL_VERSION', 'Skill 历史版本无效。')
      }
      await requireProjectPermission(productStore, user.id, projectId, 'read')
      const version = await productStore.readAgentSkillVersion(user.id, projectId, skillId, Number(rawVersion))
      if (!version) return error(response, 404, 'AGENT_SKILL_VERSION_NOT_FOUND', '未找到该 Skill 历史版本。')
      return json(response, 200, {
        version: {
          skillId,
          version: version.version,
          contentHash: version.contentHash,
          instructions: version.instructions,
          updatedAt: version.updatedAt,
          ...(version.name ? { name: version.name } : {}),
          ...(version.capabilities ? { capabilities: version.capabilities } : {}),
          ...(version.manifest ? { manifest: version.manifest } : {}),
          ...(version.publishedBy ? { publishedBy: version.publishedBy } : {}),
          ...(version.publishedAt ? { publishedAt: version.publishedAt } : {}),
        },
      })
    }
    if (projectAgentSkillsMatch) {
      if (request.method !== 'GET') return methodNotAllowed(response, '项目 Skill 资源只支持读取。', 'GET')
      const user = await requireUser(request)
      const projectId = decodeURIComponent(projectAgentSkillsMatch[1])
      await requireProjectPermission(productStore, user.id, projectId, 'read')
      const skills = await productStore.listAgentSkills(user.id, projectId) ?? []
      return json(response, 200, { skills: skills.map(publicAgentSkill) })
    }
    if (projectAgentSessionsMatch) {
      if (request.method !== 'GET') return methodNotAllowed(response, 'Agent 会话列表只支持读取。', 'GET')
      const user = await requireUser(request)
      const projectId = decodeURIComponent(projectAgentSessionsMatch[1])
      await requireProjectPermission(productStore, user.id, projectId, 'read')
      const sessions = await productStore.listAgentSessions(user.id, projectId, {
        limit: url.searchParams.get('limit') ?? undefined,
      })
      if (!sessions) return error(response, 404, 'PROJECT_NOT_FOUND', '未找到项目或你没有访问权限。')
      return json(response, 200, { sessions })
    }
    if (agentSessionContextCompactionsMatch) {
      if (request.method !== 'POST') {
        return methodNotAllowed(response, 'Agent Context 压缩资源只接受提交请求。', 'POST')
      }
      const user = await requireUser(request)
      const projectId = decodeURIComponent(agentSessionContextCompactionsMatch[1])
      const sessionId = decodeURIComponent(agentSessionContextCompactionsMatch[2])
      const contextRollout = resolveAgentContextRollout({
        featureFlags: config.agentFeatureFlags,
        rolloutFlags: config.rolloutFlags,
        userId: user.id,
        projectId,
      })
      if (contextRollout.mode !== 'active') {
        return error(response, 404, 'AGENT_CONTEXT_COMPACTION_DISABLED', 'Agent Context Compaction V2 尚未对该项目开放。')
      }
      const body = await readJson(request, 4 * 1024, 'Agent Context 压缩请求过大。')
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some((field) => field !== 'locale')) {
        return error(response, 400, 'AGENT_CONTEXT_MANUAL_REQUEST_INVALID', 'Agent Context 压缩请求包含未声明字段。')
      }
      try {
        const outcome = await compactAgentContextManually()({
          userId: user.id,
          projectId,
          sessionId,
          idempotencyKey: request.headers['idempotency-key'],
          ...(body.locale === undefined ? {} : { locale: body.locale }),
        })
        return json(response, 200, { contextCompaction: outcome })
      } catch (caught) {
        if (!(caught instanceof AgentManualContextCompactionServiceError)) throw caught
        return error(response, caught.statusCode, caught.code, caught.message)
      }
    }
    if (agentSessionMessagesMatch) {
      if (request.method !== 'GET') return methodNotAllowed(response, 'Agent 消息资源只支持读取。', 'GET')
      const user = await requireUser(request)
      const projectId = decodeURIComponent(agentSessionMessagesMatch[1])
      const sessionId = decodeURIComponent(agentSessionMessagesMatch[2])
      await requireProjectPermission(productStore, user.id, projectId, 'read')
      const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 50, 200))
      let before
      try { before = decodeAgentMessageCursor(url.searchParams.get('before') ?? undefined) } catch {
        return error(response, 400, 'INVALID_AGENT_MESSAGE_CURSOR', 'Agent 消息分页游标无效。')
      }
      const page = await productStore.listAgentSessionMessages(user.id, projectId, sessionId, { limit, before })
      if (!page) return error(response, 404, 'AGENT_SESSION_NOT_FOUND', '未找到该 Agent 对话。')
      return json(response, 200, { messages: page.messages, nextBefore: page.nextBefore })
    }
    if (projectAgentStateMatch) {
      if (request.method !== 'GET') return methodNotAllowed(response, 'Agent 状态资源只支持读取。', 'GET')
      const user = await requireUser(request)
      const projectId = decodeURIComponent(projectAgentStateMatch[1])
      await requireProjectPermission(productStore, user.id, projectId, 'read')
      const includeMessages = url.searchParams.get('includeMessages') !== '0'
      const state = await productStore.readAgentState(user.id, projectId, { includeMessages })
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
      const updatedAt = Date.now()
      return json(response, 200, { receipt: await productStore.putAgentSessionReadReceipt(user.id, projectId, sessionId, {
        messageId,
        updatedAt,
      }) })
    }
    if (agentSessionMatch) {
      if (request.method !== 'PATCH') return methodNotAllowed(response, 'Agent 会话设置只接受增量更新。', 'PATCH')
      const user = await requireUser(request)
      const projectId = decodeURIComponent(agentSessionMatch[1])
      const sessionId = decodeURIComponent(agentSessionMatch[2])
      await requireProjectPermission(productStore, user.id, projectId, 'edit')
      const body = await readJson(request, 64 * 1024, 'Agent 会话请求过大。')
      const unsupportedBodyFields = Object.keys(body ?? {}).filter((field) => !['expectedRevision', 'changes', 'createdAt'].includes(field))
      const changes = body?.changes
      const unsupportedFields = changes && typeof changes === 'object' && !Array.isArray(changes)
        ? Object.keys(changes).filter((field) => !editableAgentSessionFields.has(field))
        : []
      if (unsupportedBodyFields.length || unsupportedFields.length) {
        return error(response, 400, 'INVALID_AGENT_SESSION_FIELDS', 'Agent 会话请求包含不可由客户端写入的字段。')
      }
      if (!Number.isSafeInteger(body?.expectedRevision) || body.expectedRevision < 0 || !changes || typeof changes !== 'object' || Array.isArray(changes)) {
        return error(response, 400, 'INVALID_AGENT_SESSION_SETTINGS', 'Agent Session 设置变更无效。')
      }
      const decision = await productStore.compareAndSetAgentSessionSettings(user.id, projectId, {
        sessionId,
        expectedRevision: body.expectedRevision,
        changes,
        ...(Number.isSafeInteger(body.createdAt) && body.createdAt >= 0 ? { createdAt: body.createdAt } : {}),
      })
      if (decision.kind === 'conflict') {
        return error(response, 409, 'AGENT_SESSION_REVISION_CONFLICT', 'Agent 会话设置已在其他设备更新，请刷新后重试。')
      }
      const session = decision.session
      if (decision.changed) await recordCollaborationActivity(user, projectId, {
        id: `agent-session-${session.id}-${session.updatedAt}`,
        kind: 'conversation',
        summary: decision.kind === 'created'
          ? `创建了对话「${session.title || '新建对话'}」`
          : `更新了对话设置「${session.title || '新建对话'}」`,
      })
      return json(response, 200, { session })
    }
    if (agentMessageMatch) {
      return handleAgentMessageRoute(request, response, agentMessageMatch)
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

    if (url.pathname === '/api/agent-actions/status' || url.pathname === '/api/agent-actions/resolve') {
      const resolving = url.pathname.endsWith('/resolve')
      if (request.method !== 'POST') {
        return methodNotAllowed(response, resolving ? 'Agent 行动调和资源只接受提交请求。' : 'Agent 行动状态资源只接受查询请求。', 'POST')
      }
      const user = await requireUser(request)
      const idempotencyKey = generationIdempotencyKey(request.headers['idempotency-key'])
      if (!idempotencyKey) return error(response, 400, 'INVALID_IDEMPOTENCY_KEY', 'Agent 行动回执标识无效，请重试。')
      const body = await readJson(request, 16 * 1024, resolving ? 'Agent 行动调和请求过大。' : 'Agent 行动状态请求过大。')
      const projectId = text(body?.projectId, '项目', 160)
      const actionName = text(body?.name, '工具名称', 80)
      const toolCallId = text(body?.toolCallId, '工具调用标识', 160)
      await requireProjectPermission(productStore, user.id, projectId, agentToolPermission(actionName))
      const proposalContext = await requireActionProposal({
        user, projectId, actionName, toolCallId, argumentsValue: body?.arguments,
        body, requireExactContext: true,
      })
      const attempt = authoritativeActionAttempt({ user, projectId, proposalContext, idempotencyKey })
      const retryOptions = attempt.manualRetry ? { manualRetryOf: attempt.originalAction } : undefined
      const reconciliation = durableAgentActionReconciliation()
      if (resolving) {
        const resolution = await reconciliation.resolve({
          action: attempt.action,
          decision: body?.decision,
          ...(body?.preparedRetryIdempotencyKey !== undefined
            ? { preparedRetryIdempotencyKey: body.preparedRetryIdempotencyKey }
            : {}),
          ...(retryOptions ?? {}),
        })
        return json(response, 200, resolution)
      }
      const status = await reconciliation.readStatus(attempt.action, retryOptions)
      let execution
      if (status.status === 'succeeded') {
        const identity = agentActionReconciliationIdentity(attempt.action)
        let receipt
        try {
          receipt = await productStore.readAgentActionReceipt(user.id, identity.receiptId)
        } catch (caught) {
          throw agentActionReconciliationStoreError(caught)
        }
        const identityMatches = receipt?.id === identity.receiptId
          && receipt?.ownerId === identity.userId
          && receipt?.projectId === identity.projectId
          && receipt?.toolCallId === identity.toolCallId
          && receipt?.actionName === identity.actionName
          && receipt?.intentHash === identity.intentHash
          && receipt?.actionBindingHash === identity.actionBindingHash
        // 只回读已持久化的成功结果；人工 confirmed_applied 没有 result，因而不会伪造 execution。
        if (identityMatches && receipt.status === 'succeeded' && receipt.result !== undefined) {
          execution = structuredClone(receipt.result)
        }
      }
      return json(response, 200, { status, ...(execution !== undefined ? { execution } : {}) })
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
      await requireActionProposal({ user, projectId, actionName, toolCallId, argumentsValue: body?.arguments, body })
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
      const contextual = actionHasContext(body)
      const proposalContext = contextual
        ? await requireActionProposal({
            user, projectId, actionName, toolCallId, argumentsValue: body?.arguments,
            body, requireExactContext: true,
          })
        : standaloneAgentActions.has(actionName)
          ? undefined
          : await requireActionProposal({
              user, projectId, actionName, toolCallId, argumentsValue: body?.arguments, body,
            })
      const attempt = proposalContext
        ? authoritativeActionAttempt({ user, projectId, proposalContext, idempotencyKey })
        : undefined
      const attemptIdentity = attempt ? agentActionReconciliationIdentity(attempt.action) : undefined
      const executionArguments = proposalContext?.proposal?.arguments ?? body?.arguments
      let manualRetryToken = ''
      if (attempt?.manualRetry) {
        manualRetryToken = typeof body?.manualRetryAuthorization?.token === 'string'
          ? body.manualRetryAuthorization.token.trim()
          : ''
      } else if (attempt && body?.manualRetryAuthorization !== undefined) {
        throw new AgentToolRuntimeError(
          'AGENT_ACTION_MANUAL_RETRY_IDEMPOTENCY_REUSED',
          '手动重试必须使用新的行动提交标识。',
          409,
        )
      }
      if (approvalRequired.has(actionName)) {
        assertFreshActionApproval(body, {
          secret: config.agentActionApprovalSecret,
          userId: user.id,
          projectId,
          actionName,
          toolCallId,
          argumentsValue: executionArguments,
          idempotencyKey,
        })
      }
      const receiptId = attemptIdentity?.receiptId
        ?? `agent_action_${generationJobIdForIdempotency(user.id, `${projectId}:${idempotencyKey}`).slice(4)}`
      if (attempt?.manualRetry) {
        const authorization = await durableAgentActionReconciliation().consumeManualRetryAuthorization({
          action: attempt.originalAction,
          ...(manualRetryToken ? { token: manualRetryToken } : {}),
          retryIdempotencyKey: idempotencyKey,
        })
        if (authorization.retryReceiptId !== receiptId) {
          throw new AgentToolRuntimeError(
            'AGENT_ACTION_MANUAL_RETRY_SCOPE_MISMATCH',
            '手动重试授权与当前回执不匹配。',
            409,
          )
        }
      } else if (attempt && !attempt.manualRetry) {
        const originalIdentity = agentActionReconciliationIdentity(attempt.originalAction)
        let originalReceipt
        try {
          originalReceipt = await productStore.readAgentActionReceipt(user.id, originalIdentity.receiptId)
        } catch (caught) {
          throw agentActionReconciliationStoreError(caught)
        }
        if (originalReceipt?.resolution || originalReceipt?.status === 'uncertain') {
          throw new AgentToolRuntimeError(
            'AGENT_ACTION_RECONCILIATION_REQUIRED',
            '该行动已进入人工调和或结果未知状态，不能直接重放。',
            409,
          )
        }
      }
      const execute = async ({ signal, intentHash }) => {
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
            const cancellation = await cancellationService().cancelAgentRun({
              userId: user.id, projectId, runId, requestedBy: user.id,
            })
            const cancelledRun = await productStore.readAgentRun(user.id, runId) ?? run
            try {
              await publishAgentRunUpdated?.({ projectId, run: publicAgentRun(cancelledRun) })
            } catch { /* durable 取消已完成，实时旁路失败不能反向伪造行动失败。 */ }
            return {
              runId,
              status: cancelledRun.status,
              cancelledJobCount: cancellation.cancelledJobCount,
              failures: cancellation.failures,
            }
          },
          decideReview: async ({ taskId, artifactId, decision, note }) => {
            const committed = await commitAgentReviewAction({
              actorId: user.id, expectedProjectId: projectId, taskId, idempotencyKey,
              entries: [{ artifactId, decision, note }],
            })
            const storedDecision = committed.decisions[0]
            return {
              taskId: committed.task.id,
              artifactId,
              decision: storedDecision.decision,
              candidateStatus: storedDecision.candidateStatus,
            }
          },
          retryReview: async ({ taskId, artifactId, note }) => {
            const committed = await commitAgentReviewAction({
              actorId: user.id, expectedProjectId: projectId, taskId, idempotencyKey,
              entries: [{ artifactId, decision: 'retry_requested', note }],
            })
            const run = committed.retryRuns[0]
            if (!run) throw new AgentToolRuntimeError('AGENT_REVIEW_RETRY_COMMIT_INVALID', '评审重试没有返回权威 Run。', 409)
            try {
              await publishAgentRunUpdated?.({ projectId: run.projectId, run: publicAgentRun(run) })
            } catch { /* queued Run 已原子落库，实时广播失败不能伪造提交失败。 */ }
            return {
              taskId: committed.task.id,
              artifactId,
              decision: 'retry_requested',
              candidateStatus: committed.decisions[0].candidateStatus,
              runId: run.id,
              status: run.status,
            }
          },
          promoteArtifact: async ({ artifactId, name }) => {
            const artifacts = await productStore.listAgentArtifacts(user.id, projectId, { limit: 200 }) ?? []
            const artifact = artifacts.find((item) => item.id === artifactId)
            if (!artifact?.url) throw new AgentToolRuntimeError('AGENT_ARTIFACT_NOT_FOUND', '未找到该结果，或它没有可入库的媒体。', 404)
            // 历史 Artifact 允许保留外链用于只读追溯，但入库会把 URL 变成项目可用媒体，
            // 因此这里只接受已经过本项目媒体授权边界的同源资源。
            if (!isAuthorizedAgentMediaUrl(artifact.url)) {
              throw new AgentToolRuntimeError('AGENT_ARTIFACT_MEDIA_NOT_AUTHORIZED', '该结果不是已授权的项目媒体，不能入库。', 403)
            }
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
            const projectSkillCatalog = [
              ...botanicAgentSystemSkills(),
              ...(await productStore.listAgentSkills(user.id, projectId) ?? []),
            ]
            const skill = createAgentSkill(input, {
              ownerId: user.id,
              approvedBy: user.id,
              riskOf: (name) => botanicAgentSkillToolRisk(name, registry),
              skillCatalog: projectSkillCatalog,
            })
            return { skill: publicAgentSkill(await productStore.putAgentSkill(user.id, skill)) }
          },
          mcpRuntime: configuredMcpTools,
        })
        const result = await executeConfirmedAgentAction({
          registry,
          name: actionName,
          arguments: executionArguments,
          toolCallId,
          confirmed: body?.confirmed,
          context: { projectId, userId: user.id, requestId, signal, actionIntentHash: intentHash },
        })
        return result
      }
      const execution = await durableAgentActionExecution().execute({
        userId: user.id,
        projectId,
        receiptId,
        toolCallId,
        name: actionName,
        arguments: executionArguments,
        ...(attemptIdentity ? { actionBindingHash: attemptIdentity.actionBindingHash } : {}),
        replayPolicy: attempt?.manualRetry ? 'never' : safelyReplayableAgentActions.has(actionName) ? 'safe' : 'never',
        executor: execute,
      })
      return json(response, 200, execution)
    }

    if (url.pathname === '/api/agent-runs') {
      const startedAt = Date.now()
      if (request.method !== 'POST') return methodNotAllowed(response, 'Agent Run 集合只接受提交请求。', 'POST')
      const user = await requireUser(request)
      const idempotencyKey = generationIdempotencyKey(request.headers['idempotency-key'])
      if (!idempotencyKey) return error(response, 400, 'INVALID_IDEMPOTENCY_KEY', 'Agent Run 提交标识无效，请重试。')
      const input = validateAgentRunCreation(await readJson(request, 64 * 1024, 'Agent Run 请求过大。'))
      await requireProjectPermission(productStore, user.id, input.projectId, 'create-generation')
      let authoritativeInput = await bindAuthoritativeKnowledge(user.id, input)
      if (authoritativeInput.turnId && authoritativeInput.plan.intent !== 'initial_generation') {
        const sourceTurn = await productStore.readAgentTurn(user.id, authoritativeInput.turnId)
        const sourceRequest = sourceTurn?.request?.runtimeOperation
          ? sourceTurn.request.input
          : sourceTurn?.request
        const targetBinding = sourceRequest?.targetBinding
        if (!targetBinding || targetBinding.nodeId !== authoritativeInput.plan.selectedResultNodeId) {
          throw Object.assign(new Error('Agent Run 的父图与来源 Turn 目标不一致，请重新确认。'), {
            code: 'AGENT_TARGET_STALE', statusCode: 409,
          })
        }
        const project = await productStore.readProject(user.id, authoritativeInput.projectId)
        await assertAgentTargetBinding(project?.document, sourceRequest, {
          resolveMedia: visionMediaResolver(user.id, authoritativeInput.projectId),
          projectRevision: project?.revision,
        })
        authoritativeInput = {
          ...authoritativeInput,
          plan: { ...authoritativeInput.plan, targetBinding: structuredClone(targetBinding) },
        }
      }
      const idempotencyBinding = agentRunSubmissionBinding(authoritativeInput)
      if (authoritativeInput.turnId) {
        await assertTurnAllowsDelegation({
          productStore, userId: user.id, projectId: authoritativeInput.projectId, turnId: authoritativeInput.turnId,
        })
      }

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
        } catch (caught) {
          // durable cancel fence 是业务冲突，不是「队列暂不可用」。吞掉它会把取消后的
          // linked Run 留在 queued，随后恢复器仍可能再次尝试提交。
          if (['AGENT_TURN_DELEGATION_CANCELLED', 'AGENT_TURN_DELEGATION_NOT_READY', 'AGENT_TURN_NOT_FOUND'].includes(caught?.code)) throw caught
          const latest = await productStore.readAgentRun(user.id, run.id)
          observeRun({ type: 'auto_submit_deferred', requestId, projectId: run.projectId, runId: run.id, status: latest?.status ?? run.status, durationMs: Date.now() - startedAt })
          return latest ?? run
        }
      }

      const id = `agent_run_${generationJobIdForIdempotency(user.id, idempotencyKey).slice(4)}`
      const existing = await productStore.readAgentRun(user.id, id)
      if (existing) {
        if (!matchingIdempotencyRequestBinding(storedAgentRunSubmissionBinding(existing), idempotencyBinding)) {
          throw Object.assign(new Error('同一提交标识已绑定到另一份 Agent Run 请求，请使用新的提交标识。'), {
            code: 'AGENT_RUN_IDEMPOTENCY_CONFLICT',
            statusCode: 409,
          })
        }
        await enforceDelegationAfterPut(user.id, existing)
        // 幂等重放同样收敛到已执行状态：确认后页面立刻关闭时 Run 停在 queued，
        // 重放这条请求应把它送进执行，而不是原样返回。
        const resumed = await autoSubmitAgentRun(existing)
        observeRun({ type: 'submission_reused', requestId, projectId: resumed.projectId, runId: resumed.id, status: resumed.status, durationMs: Date.now() - startedAt })
        return json(response, 200, { run: publicAgentRun(resumed) })
      }
      const run = createPersistentAgentRun(authoritativeInput, { id, ownerId: user.id, idempotencyBinding })
      // 绑定知识与幂等读取可能经历多次存储往返；写入前再读一次 fence，尽量收窄
      // 「第一次检查后刚好取消」的窗口。Job 提交层还会再次检查。
      if (run.turnId) {
        await assertTurnAllowsDelegation({
          productStore, userId: user.id, projectId: run.projectId, turnId: run.turnId,
        })
      }
      const storedRun = await productStore.putAgentRun(user.id, run)
      if (!matchingIdempotencyRequestBinding(storedAgentRunSubmissionBinding(storedRun), idempotencyBinding)) {
        throw Object.assign(new Error('同一提交标识已绑定到另一份 Agent Run 请求，请使用新的提交标识。'), {
          code: 'AGENT_RUN_IDEMPOTENCY_CONFLICT',
          statusCode: 409,
        })
      }
      await enforceDelegationAfterPut(user.id, storedRun)
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
      if (existing) {
        await enforceDelegationAfterPut(user.id, existing)
        return json(response, 200, { run: publicAgentRun(existing), reused: true })
      }
      const created = createPersistentAgentRun(input, { id, ownerId: user.id })
      if (created.turnId) {
        await assertTurnAllowsDelegation({
          productStore, userId: user.id, projectId: created.projectId, turnId: created.turnId,
        })
      }
      const stored = await productStore.putAgentRun(user.id, created)
      await enforceDelegationAfterPut(user.id, stored)
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
    if (agentReviewTaskCancelMatch) {
      if (request.method !== 'POST') return methodNotAllowed(response, '评审取消资源只接受提交请求。', 'POST')
      const user = await requireUser(request)
      const taskId = decodeURIComponent(agentReviewTaskCancelMatch[1])
      const task = await productStore.readAgentReviewTask(user.id, taskId)
      if (!task) return error(response, 404, 'AGENT_REVIEW_TASK_NOT_FOUND', '未找到该评审任务。')
      await requireProjectPermission(productStore, user.id, task.projectId, 'edit')
      const idempotencyKey = generationIdempotencyKey(request.headers['idempotency-key'])
      if (!idempotencyKey) return error(response, 400, 'INVALID_IDEMPOTENCY_KEY', '评审取消标识无效，请重试。')
      const body = await readJson(request, 8 * 1024, '评审取消请求过大。')
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some((key) => key !== 'reason')
        || (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 500))) {
        return error(response, 400, 'INVALID_AGENT_REVIEW_CANCELLATION', '评审取消请求字段无效。')
      }
      const decision = await reviewOperationsService().requestReviewCancellation({
        userId: user.id,
        taskId: task.id,
        projectId: task.projectId,
        idempotencyKey,
        requestedBy: user.id,
        ...(body.reason?.trim() ? { reason: body.reason.trim() } : {}),
      })
      if (!decision?.task) return error(response, 404, 'AGENT_REVIEW_TASK_NOT_FOUND', '未找到该评审任务。')
      if (decision.kind === 'conflict') {
        return error(response, 409, 'AGENT_REVIEW_CANCELLATION_CONFLICT', '同一评审取消标识已绑定到不同请求。')
      }
      if (!['cancelling', 'cancelled'].includes(decision.task.status)) {
        return error(response, 409, 'AGENT_REVIEW_NOT_CANCELLABLE', '该评审任务当前不可取消。')
      }
      return json(response, decision.task.status === 'cancelling' ? 202 : 200, {
        task: publicAgentReviewTask(decision.task),
      })
    }
    if (agentReviewTaskReconciliationMatch) {
      if (request.method !== 'POST') return methodNotAllowed(response, '评审结果核对资源只接受提交请求。', 'POST')
      const user = await requireUser(request)
      const taskId = decodeURIComponent(agentReviewTaskReconciliationMatch[1])
      const task = await productStore.readAgentReviewTask(user.id, taskId)
      if (!task) return error(response, 404, 'AGENT_REVIEW_TASK_NOT_FOUND', '未找到该评审任务。')
      await requireProjectPermission(productStore, user.id, task.projectId, 'edit')
      const idempotencyKey = generationIdempotencyKey(request.headers['idempotency-key'])
      if (!idempotencyKey) return error(response, 400, 'INVALID_IDEMPOTENCY_KEY', '评审结果核对标识无效，请重试。')
      const body = await readJson(request, 8 * 1024, '评审结果核对请求过大。')
      const action = body?.action
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).length !== 1
        || !['continue_unverifiable', 'retry_once'].includes(action)) {
        return error(response, 400, 'INVALID_AGENT_REVIEW_RECONCILIATION', '评审结果核对动作无效。')
      }
      // retry_once 会再次调用 Provider；只有明确具备生成权限的人才能选择这条有成本路径。
      if (action === 'retry_once') {
        await requireProjectPermission(productStore, user.id, task.projectId, 'create-generation')
      }
      const decision = await reviewOperationsService().reconcileReviewOutcome({
        userId: user.id,
        taskId: task.id,
        projectId: task.projectId,
        idempotencyKey,
        action,
      })
      if (!decision?.task) return error(response, 404, 'AGENT_REVIEW_TASK_NOT_FOUND', '未找到该评审任务。')
      if (decision.kind === 'conflict') {
        return error(response, 409, 'AGENT_REVIEW_RECONCILIATION_CONFLICT', '同一核对标识已绑定到不同动作。')
      }
      if (decision.kind === 'retry_limit') {
        return error(response, 409, 'AGENT_REVIEW_RETRY_LIMIT', '该未知结果已使用过唯一一次显式重试。')
      }
      if (decision.kind === 'not_reconcilable') {
        return error(response, 409, 'AGENT_REVIEW_NOT_RECONCILABLE', '该评审任务当前不需要结果核对。')
      }
      return json(response, action === 'retry_once' && decision.task.status === 'queued' ? 202 : 200, {
        task: publicAgentReviewTask(decision.task),
      })
    }
    if (agentReviewTaskDecisionsMatch) {
      if (request.method !== 'POST') return methodNotAllowed(response, '评审决定资源只接受提交请求。', 'POST')
      const user = await requireUser(request)
      const taskId = decodeURIComponent(agentReviewTaskDecisionsMatch[1])
      const task = await productStore.readAgentReviewTask(user.id, taskId)
      if (!task) return error(response, 404, 'AGENT_REVIEW_TASK_NOT_FOUND', '未找到该评审任务。')
      const idempotencyKey = generationIdempotencyKey(request.headers['idempotency-key'])
      if (!idempotencyKey) return error(response, 400, 'INVALID_IDEMPOTENCY_KEY', '评审决定标识无效，请重试。')
      const body = await readJson(request, 16 * 1024, '评审决定请求过大。')
      const requested = Array.isArray(body?.decisions) ? body.decisions : [body]
      if (!requested.length || requested.length > 60) return error(response, 400, 'INVALID_AGENT_REVIEW', '评审决定数量无效。')
      // 接受/拒绝只改变交付状态；请求重试会创建可进入生成队列的新 Run，必须额外具备
      // create-generation 权限。Adapter 在事务内再次校验，避免检查后的成员角色竞态。
      await requireProjectPermission(productStore, user.id, task.projectId, 'edit')
      if (requested.some((entry) => entry?.decision === 'retry_requested')) {
        await requireProjectPermission(productStore, user.id, task.projectId, 'create-generation')
      }
      let committed
      try {
        committed = await reviewDecisionService()({
          actorId: user.id,
          expectedProjectId: task.projectId,
          taskId: task.id,
          idempotencyKey,
          entries: requested,
        })
      } catch (caught) {
        if (!(caught instanceof AgentReviewDecisionServiceError)) throw caught
        return error(response, caught.statusCode, caught.code, caught.message)
      }
      const retryArtifactIds = committed.decisions
        .filter((decision) => decision.decision === 'retry_requested')
        .map((decision) => decision.artifactId)
      const retryRuns = committed.retryRuns.map((run, index) => ({
        artifactId: retryArtifactIds[index], runId: run.id,
      }))
      await Promise.allSettled(committed.retryRuns.map((run) => (
        publishAgentRunUpdated?.({ projectId: run.projectId, run: publicAgentRun(run) })
      )))
      return json(response, 200, {
        task: publicAgentReviewTask(committed.task),
        decisions: committed.decisions,
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
      const cancellation = await cancellationService().cancelAgentRun({
        userId: user.id, projectId: run.projectId, runId, requestedBy: user.id,
      })
      if (cancellation.kind === 'failed') {
        return error(response, 503, 'AGENT_RUN_CANCEL_FAILED', 'Agent Run 取消暂未完成，请重试。')
      }
      const cancelledRun = await productStore.readAgentRun(user.id, runId) ?? run
      if (cancelledRun.status === 'cancelled' && run.status !== 'cancelled') await recordCollaborationActivity(user, run.projectId, {
        id: `agent-run-${cancelledRun.id}-${cancelledRun.updatedAt}`,
        kind: 'task',
        summary: `取消了任务「${cancelledRun.plan?.summary || '生成任务'}」`,
        target: { kind: 'task', runId: cancelledRun.id },
      })
      try {
        await publishAgentRunUpdated?.({ projectId: run.projectId, run: publicAgentRun(cancelledRun) })
      } catch { /* durable 取消已完成，实时旁路失败不能改变 HTTP 结果。 */ }
      observeRun({
        type: 'cancelled', requestId, projectId: run.projectId, runId,
        status: cancelledRun.status, activeJobCount: cancellation.cancelledJobCount,
      })
      return json(response, 200, { run: publicAgentRun(cancelledRun), cancellation })
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
