// @ts-check

import { agentEntityLimits } from './botanicAgentPersistence.mjs'
import { decodeAgentMessageCursor } from './agentMessagePersistence.mjs'
import {
  AgentContextCoordinatorError,
  createAgentContextCoordinator,
} from './agentContextCoordinator.mjs'
import { AgentContextCompactionError } from './agentContextCompaction.mjs'
import { ProjectAuthorizationError, requireProjectPermission } from './projectAuthorization.mjs'

const MESSAGE_PAGE_LIMIT = 200
const ID_LIMIT = 160
const IDEMPOTENCY_KEY_LIMIT = 200
const SAFE_KINDS = new Set(['compacted', 'replay', 'reused', 'no_change'])

export class AgentManualContextCompactionServiceError extends Error {
  constructor(code, message, statusCode) {
    super(message)
    this.name = 'AgentManualContextCompactionServiceError'
    this.code = code
    this.statusCode = statusCode
  }
}

/** @returns {never} */
function failure(code, message, statusCode) {
  throw new AgentManualContextCompactionServiceError(code, message, statusCode)
}

function requiredIdentity(value, code, label) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > ID_LIMIT) {
    failure(code, `${label}无效。`, code === 'AGENT_CONTEXT_USER_REQUIRED' ? 401 : 400)
  }
  return value.trim()
}

function requiredIdempotencyKey(value) {
  if (typeof value !== 'string') {
    failure('INVALID_IDEMPOTENCY_KEY', 'Agent Context 压缩提交标识无效，请重试。', 400)
  }
  const key = value.trim()
  if (!key || key.length > IDEMPOTENCY_KEY_LIMIT || /[\u0000-\u001f\u007f]/u.test(key)) {
    failure('INVALID_IDEMPOTENCY_KEY', 'Agent Context 压缩提交标识无效，请重试。', 400)
  }
  return key
}

function localeValue(value) {
  if (value === undefined || value === null || value === '') return 'zh-CN'
  if (value === 'zh-CN' || value === 'en') return value
  failure('AGENT_CONTEXT_LOCALE_INVALID', 'Agent Context locale 无效。', 400)
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function safeInteger(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback
}

function safeText(value, maximum = 200) {
  return typeof value === 'string' && value.trim() && value.trim().length <= maximum
    ? value.trim()
    : undefined
}

function publicMeter(value) {
  if (!value || typeof value !== 'object') return undefined
  const result = {
    inputTokens: safeInteger(value.inputTokens),
    contextWindowTokens: safeInteger(value.contextWindowTokens),
    utilizationRatio: Number.isFinite(Number(value.utilizationRatio))
      ? Math.max(0, Number(value.utilizationRatio))
      : 0,
    shouldCompact: value.shouldCompact === true,
    overLimit: value.overLimit === true,
  }
  const source = safeText(value.source, 40)
  return { ...result, ...(source ? { source } : {}) }
}

function publicCompaction(value) {
  if (!value || typeof value !== 'object') return undefined
  const id = safeText(value.id)
  const sourceSurfaceHash = safeText(value.sourceSurfaceHash)
  const resultSurfaceHash = safeText(value.resultSurfaceHash)
  const checkpointContentHash = safeText(value.checkpoint?.contentHash)
  const policyId = safeText(value.policy?.id)
  const policyHash = safeText(value.policy?.hash)
  const policyModel = safeText(value.policy?.model, 160)
  if (!id || value.version !== 2 || !['pre_step', 'overflow', 'manual'].includes(value.trigger)
    || !sourceSurfaceHash || !resultSurfaceHash || !checkpointContentHash
    || !policyId || !policyHash || !policyModel
    || !Array.isArray(value.replacedMessageRevisions) || !value.replacedMessageRevisions.length) {
    failure('AGENT_CONTEXT_MANUAL_RESULT_INVALID', 'Agent Context 压缩结果无效。', 500)
  }
  const meterBefore = publicMeter(value.meterBefore)
  const meterAfter = publicMeter(value.meterAfter)
  if (!meterBefore || !meterAfter) {
    failure('AGENT_CONTEXT_MANUAL_RESULT_INVALID', 'Agent Context 压缩计量结果无效。', 500)
  }
  const threadSummaryHash = safeText(value.checkpoint?.threadSummaryHash)
  return {
    id,
    version: 2,
    trigger: value.trigger,
    sequence: safeInteger(value.sequence),
    createdAt: safeInteger(value.createdAt),
    sourceSurfaceHash,
    resultSurfaceHash,
    replacedMessageCount: value.replacedMessageRevisions.length,
    checkpoint: {
      contentHash: checkpointContentHash,
      ...(threadSummaryHash ? { threadSummaryHash } : {}),
    },
    policy: { id: policyId, hash: policyHash, model: policyModel },
    meterBefore,
    meterAfter,
  }
}

function publicState(value, { projectId, sessionId }) {
  if (!value || typeof value !== 'object'
    || value.projectId !== projectId || value.sessionId !== sessionId) {
    failure('AGENT_CONTEXT_MANUAL_RESULT_INVALID', 'Agent Context 状态身份无效。', 500)
  }
  const revision = safeInteger(value.revision)
  const headCompactionId = safeText(value.headCompactionId)
  const headCompactionSequence = value.headCompactionSequence === undefined
    ? undefined
    : safeInteger(value.headCompactionSequence)
  if (Boolean(headCompactionId) !== Boolean(headCompactionSequence)) {
    failure('AGENT_CONTEXT_MANUAL_RESULT_INVALID', 'Agent Context Head 状态无效。', 500)
  }
  return {
    version: 2,
    projectId,
    sessionId,
    revision,
    updatedAt: safeInteger(value.updatedAt),
    ...(headCompactionId ? { headCompactionId, headCompactionSequence } : {}),
  }
}

function publicOutcome(outcome, identity) {
  if (!outcome || !SAFE_KINDS.has(outcome.kind)) {
    failure('AGENT_CONTEXT_MANUAL_RESULT_INVALID', 'Agent Context Coordinator 返回了未知状态。', 500)
  }
  const state = publicState(outcome.state, identity)
  const compaction = publicCompaction(outcome.compaction)
  if (['compacted', 'replay'].includes(outcome.kind) && (!compaction || compaction.trigger !== 'manual')) {
    failure('AGENT_CONTEXT_MANUAL_RESULT_INVALID', 'Agent Context 手动压缩提交结果无效。', 500)
  }
  return deepFreeze({
    version: 1,
    kind: outcome.kind,
    changed: outcome.kind === 'compacted',
    state,
    ...(compaction ? { compaction } : {}),
  })
}

function modelForSession(session, messages, defaultModel) {
  const storedModel = safeText(session?.plannerModel, 160)
  if (storedModel) return storedModel
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const frozenModel = safeText(messages[index]?.turnRequestSnapshot?.plannerModel, 160)
    if (frozenModel) return frozenModel
  }
  const fallback = safeText(defaultModel, 160)
  if (fallback) return fallback
  failure('AGENT_CONTEXT_MODEL_REQUIRED', 'Agent 会话缺少可用于 Context V2 的服务端模型。', 409)
}

async function readAllMessages(productStore, userId, projectId, sessionId) {
  const history = []
  const seenCursors = new Set()
  let before
  while (history.length < agentEntityLimits.messagesPerSession) {
    let page
    try {
      page = await productStore.listAgentSessionMessages(userId, projectId, sessionId, {
        limit: Math.min(MESSAGE_PAGE_LIMIT, agentEntityLimits.messagesPerSession - history.length),
        ...(before ? { before } : {}),
      })
    } catch {
      failure('AGENT_CONTEXT_HISTORY_READ_FAILED', '无法读取完整 Agent 会话历史。', 503)
    }
    if (!page) failure('AGENT_SESSION_NOT_FOUND', '未找到当前项目的 Agent 会话。', 404)
    if (!Array.isArray(page.messages)) {
      failure('AGENT_CONTEXT_HISTORY_INVALID', 'Agent 会话历史分页无效。', 409)
    }
    history.unshift(...page.messages)
    if (!page.nextBefore) return history
    if (seenCursors.has(page.nextBefore)) {
      failure('AGENT_CONTEXT_HISTORY_INCOMPLETE', 'Agent 会话历史无法完整回溯，未执行压缩。', 409)
    }
    seenCursors.add(page.nextBefore)
    try {
      before = decodeAgentMessageCursor(page.nextBefore)
    } catch {
      failure('AGENT_CONTEXT_HISTORY_INCOMPLETE', 'Agent 会话历史游标无效，未执行压缩。', 409)
    }
    if (history.length >= agentEntityLimits.messagesPerSession) {
      // Adapter 的 nextBefore 表示「本页刚好填满」，不保证后面一定还有记录。
      // 在 500 条实体上限恰好填满时做一次 1 条 probe：空页证明历史完整，
      // 非空则说明已越过可验证边界，必须 fail closed。
      let probe
      try {
        probe = await productStore.listAgentSessionMessages(userId, projectId, sessionId, {
          limit: 1,
          before,
        })
      } catch {
        failure('AGENT_CONTEXT_HISTORY_READ_FAILED', '无法验证 Agent 会话历史边界。', 503)
      }
      if (!probe) failure('AGENT_SESSION_NOT_FOUND', '未找到当前项目的 Agent 会话。', 404)
      if (!Array.isArray(probe.messages)) {
        failure('AGENT_CONTEXT_HISTORY_INVALID', 'Agent 会话历史分页无效。', 409)
      }
      if (!probe.messages.length) return history
      failure('AGENT_CONTEXT_HISTORY_INCOMPLETE', 'Agent 会话历史超过可验证边界，未执行压缩。', 409)
    }
  }
  failure('AGENT_CONTEXT_HISTORY_INCOMPLETE', 'Agent 会话历史超过可验证边界，未执行压缩。', 409)
}

function mappedError(caught) {
  if (caught instanceof AgentManualContextCompactionServiceError) return caught
  if (caught instanceof ProjectAuthorizationError) {
    return new AgentManualContextCompactionServiceError(caught.code, caught.message, caught.statusCode)
  }
  if (caught instanceof AgentContextCoordinatorError || caught instanceof AgentContextCompactionError) {
    return new AgentManualContextCompactionServiceError(caught.code, caught.message, caught.statusCode)
  }
  if (caught?.code === 'PROJECT_WRITE_FORBIDDEN') {
    return new AgentManualContextCompactionServiceError(
      'PROJECT_ACCESS_FORBIDDEN', '你没有执行该项目操作的权限。', 403,
    )
  }
  if (caught?.code === 'AGENT_CONTEXT_PERSISTENCE_REQUIRED') {
    return new AgentManualContextCompactionServiceError(
      'AGENT_CONTEXT_PERSISTENCE_REQUIRED', 'Agent Context V2 持久化尚不可用。', 503,
    )
  }
  if (caught?.code === 'WORKSPACE_STORE_TIMEOUT') {
    return new AgentManualContextCompactionServiceError(
      'AGENT_CONTEXT_STORE_TIMEOUT', 'Agent Context 存储响应超时，请重试。', 503,
    )
  }
  return new AgentManualContextCompactionServiceError(
    'AGENT_CONTEXT_MANUAL_UNAVAILABLE', 'Agent Context 手动压缩暂时不可用。', 503,
  )
}

/**
 * Editor-only 手动 Context V2 压缩服务。
 *
 * 服务只读取权威 Session/Message，并调用本地确定性 Coordinator + Store CAS；
 * 不接收 prompt/checkpoint/model，不注入也不调用任何 Provider。
 *
 * @param {{productStore:any,policies?:any,defaultModel?:string,contextCoordinator?:any,observe?:(event:any)=>void}} dependencies
 */
export function createAgentManualContextCompactionService(dependencies) {
  const { productStore, policies, defaultModel } = dependencies ?? {}
  if (typeof productStore?.projectAccess !== 'function'
    || typeof productStore?.listAgentSessions !== 'function'
    || typeof productStore?.listAgentSessionMessages !== 'function') {
    throw new TypeError('Agent Manual Context Compaction Service 缺少项目、会话或消息读取 Interface。')
  }
  const coordinator = dependencies?.contextCoordinator ?? createAgentContextCoordinator({
    productStore,
    policies,
    observe: dependencies?.observe,
  })
  if (typeof coordinator?.resolve !== 'function') {
    throw new TypeError('Agent Manual Context Compaction Service 缺少 Context Coordinator。')
  }

  /**
   * @param {{userId:string,projectId:string,sessionId:string,idempotencyKey:string,locale?:string}} command
   */
  return async function compactAgentContextManually(command) {
    try {
      const userId = requiredIdentity(command?.userId, 'AGENT_CONTEXT_USER_REQUIRED', 'Agent 用户标识')
      const projectId = requiredIdentity(command?.projectId, 'AGENT_CONTEXT_PROJECT_REQUIRED', 'Agent 项目标识')
      const sessionId = requiredIdentity(command?.sessionId, 'AGENT_CONTEXT_SESSION_REQUIRED', 'Agent 会话标识')
      const idempotencyKey = requiredIdempotencyKey(command?.idempotencyKey)
      const locale = localeValue(command?.locale)

      await requireProjectPermission(productStore, userId, projectId, 'edit')
      const sessions = await productStore.listAgentSessions(userId, projectId, { limit: agentEntityLimits.sessions })
      const session = Array.isArray(sessions)
        ? sessions.find((candidate) => candidate?.id === sessionId)
        : undefined
      if (!session) failure('AGENT_SESSION_NOT_FOUND', '未找到当前项目的 Agent 会话。', 404)

      const messages = await readAllMessages(productStore, userId, projectId, sessionId)
      const model = modelForSession(session, messages, defaultModel)
      const currentMessage = messages.findLast((message) => message?.role === 'user')
      const outcome = await coordinator.resolve({
        userId,
        projectId,
        sessionId,
        model,
        messages,
        ...(safeText(currentMessage?.id) ? { currentMessageId: currentMessage.id.trim() } : {}),
        locale,
        threadSummary: session.threadSummary,
        force: true,
        trigger: 'manual',
        idempotencyKey,
      })
      return publicOutcome(outcome, { projectId, sessionId })
    } catch (caught) {
      throw mappedError(caught)
    }
  }
}
