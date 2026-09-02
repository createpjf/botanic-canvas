import { createHash, randomUUID } from 'node:crypto'
import { agentActionManualRetryConsumptionDecision, agentActionReceiptClaimDecision, agentActionReceiptResolutionDecision, agentSkillPersistenceDecision, agentThreadSummaryCompareAndSetDecision, agentTurnExecutionClaimDecision, authoritativeAgentActionManualRetryAuthorization, canvasGraphConflictCode, canvasMutationConflictCode, canvasSyncEpochStaleError, committedAgentTurnExecution, finalizedAgentTurnCancellation, normalizeAgentEntityIdPage, normalizeCanvasGraphMutation, normalizePendingAgentReviewRecoveryPage, normalizeStaleTurnQuery, normalizeTurnEventPage, normalizeUpdatedAtIdRecoveryPage, persistedAgentSkillVersion, reclaimableAgentTurnStatuses, requestedAgentTurnCancellation, settledAgentActionReceipt } from './productStoreContract.mjs'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { assertProjectPermission, assertWorkspacePermission, projectPermissionDecision } from '../authorization.mjs'
import { artifactIndexLimits, artifactsFromActionReceipt, artifactsFromAgentMessage, artifactsFromDocument, artifactsFromGenerationJob, generationArtifactRefreshReport, generationArtifactsFromJobReport } from '../botanicArtifactIndex.mjs'
import { applyGenerationJobToAgentRun, mergeAgentRunForWrite } from '../botanicAgentRun.mjs'
import { agentStateFromDocument, applyAgentSessionReadReceipts, compareAndSetAgentSessionSettings, mergeAgentStateIntoDocument, shouldApplyAgentEntityWrite, shouldApplyAgentRunWrite, stripAgentMessagesFromDocument, validateAgentEntityWriteTimestamp, validateAgentMemoryEntity, validateAgentMessageEntity, validateAgentSessionEntity, validateAgentSessionReadReceipt } from '../botanicAgentPersistence.mjs'
import { agentMessageListOptions, encodeAgentMessageCursor, normalizeAgentSessionListLimit } from '../agentMessagePersistence.mjs'
import { mergeAgentMessageForWrite } from '../agentMessageMerge.mjs'
import { observeProductStoreRead } from './productStoreMetrics.mjs'
import { collaborationActivitiesForMember, nextCollaborationReceipt, validateCollaborationActivity } from '../collaborationActivityPersistence.mjs'
import { acknowledgedGenerationJobCancellation, committedGenerationJobExecution, comparedAndSetGenerationJob, generationJobExecutionClaimDecision, generationJobPutDecision, requestedGenerationJobCancellation } from '../generation/generationJobExecution.mjs'
import { idempotencyRequestBindingWriteDecision } from '../idempotencyRequestBinding.mjs'
import { agentBranchRetryClaimDecision, agentBranchRetryJobDecision } from '../agentBranchRetryClaim.mjs'
import { agentReviewCancellationFinalizeDecision, agentReviewCancellationRequestDecision, agentReviewExecutionClaimDecision, agentReviewTaskPutDecision, committedAgentReviewExecution } from '../agentReviewExecution.mjs'
import { agentReviewRetryMaterializationDecision } from '../agentReviewRetryMaterialization.mjs'
import { agentReviewOutcomeReconciliationDecision } from '../agentReviewReconciliation.mjs'
import {
  agentSubagentActivationClaimDecision,
  agentSubagentActivationSettleDecision,
  assertAgentSubagentRootTurnFence,
  agentSubagentCancellationFinalizeDecision,
  agentSubagentCancellationRequestDecision,
  agentSubagentEnqueueDecision,
  materializeAgentSubagentEnqueueCommand,
  normalizeAgentSubagentActivationPage,
  normalizeRunnableAgentSubagentPage,
  publicAgentSubagent,
  publicAgentSubagentActivation,
} from '../agentSubagentPersistence.mjs'
import {
  agentContextStateCompareAndSetDecision,
  materializeAgentContextCommand,
  normalizeAgentContextCompactionPage,
  publicAgentContextCompaction,
} from '../agentContextPersistence.mjs'

const schemaVersion = 1

function now() {
  return Date.now()
}

function hashAccessToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

function clone(value) {
  return structuredClone(value)
}

function preserveAgentThreadSummary(current, incoming) {
  if (current?.threadSummary === undefined) return incoming
  return { ...incoming, threadSummary: clone(current.threadSummary) }
}

function productError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

function publicUser(user) {
  return user ? {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status ?? 'active',
    createdAt: user.createdAt,
  } : undefined
}

function canvasGraph(document) {
  return {
    nodes: clone(Array.isArray(document?.nodes) ? document.nodes : []),
    edges: clone(Array.isArray(document?.edges) ? document.edges : []),
  }
}

function sameGraph(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function projectDocumentSummary(document) {
  const nodes = Array.isArray(document?.nodes) ? document.nodes : []
  const images = nodes
    .filter((node) => node?.type === 'result' && typeof node?.data?.image === 'string')
    .map((node) => node.data.image)
  return { nodeCount: nodes.length, resultCount: images.length, coverImage: images.at(-1) }
}

function initialState() {
  return {
    schemaVersion,
    users: [],
    accessTokens: [],
    projects: [],
    canvasGraphs: [],
    globalAssetLibraries: [],
    generationJobs: [],
    agentRuns: [],
    agentTurns: [],
    agentTurnEvents: [],
    agentSubagents: [],
    agentSubagentActivations: [],
    agentReviews: [],
    agentReviewTasks: [],
    agentSessions: [],
    agentSessionReadReceipts: [],
    agentContextStates: [],
    agentContextCompactions: [],
    collaborationActivities: [],
    collaborationActivityReceipts: [],
    agentMessages: [],
    agentMemoryItems: [],
    agentArtifacts: [],
    agentSkills: [],
    agentActionReceipts: [],
    auditEvents: [],
  }
}

/**
 * 单实例持久化模块。
 *
 * 调用方只知道“用户、项目、任务、审计”四类读写；原子文件写入、令牌散列与
 * 重启恢复均封装在此处。生产部署应将 dataPath 放在持久卷上；未来替换为
 * PostgreSQL 时保持这个 Interface，不把数据访问复杂度扩散回路由层。
 */
export function createProductStore({ dataPath, bootstrapAccessToken, bootstrapEmail = 'owner@botanic.local' }) {
  if (!bootstrapAccessToken) throw new Error('BOTANIC_BOOTSTRAP_ACCESS_TOKEN 未配置，拒绝启动受保护的产品服务。')

  const path = resolve(dataPath)
  mkdirSync(dirname(path), { recursive: true })
  let state = loadState(path)
  ensureBootstrapUser(state, bootstrapAccessToken, bootstrapEmail)
  backfillArtifactIndexes()
  persist(path, state)
  let durableState = clone(state)

  function save() {
    try {
      persist(path, state)
      durableState = clone(state)
    } catch (error) {
      state = clone(durableState)
      throw error
    }
  }

  function audit({ actorId, action, projectId, targetId, detail = {} }) {
    const event = {
      id: `audit_${randomUUID()}`,
      actorId,
      action,
      projectId,
      targetId,
      detail: clone(detail),
      createdAt: now(),
    }
    state.auditEvents.push(event)
    // 审计日志只保留最近 20,000 条，避免单机 MVP 无限增长；正式环境应归档到日志系统。
    if (state.auditEvents.length > 20_000) state.auditEvents.splice(0, state.auditEvents.length - 20_000)
    return event
  }

  function authenticatedUser(accessToken) {
    if (!accessToken) return undefined
    const token = state.accessTokens.find((item) => item.tokenHash === hashAccessToken(accessToken) && !item.revokedAt)
    if (!token) return undefined
    return state.users.find((item) => item.id === token.userId && item.status !== 'disabled')
  }

  function canAccess(project, userId, allowedRoles = ['owner', 'editor', 'viewer']) {
    const member = project.members.find((item) => item.userId === userId)
    return member && allowedRoles.includes(member.role) ? member : undefined
  }

  function agentStateForProject(projectId, userId, options = {}) {
    const includeMessages = options.includeMessages !== false
    const includeSubagents = options.includeSubagents === true
    const visibleSessionIds = new Set(state.agentSessions
      .filter((item) => item.projectId === projectId && (includeSubagents || item.payload?.kind !== 'subagent'))
      .map((item) => item.id))
    const sessions = state.agentSessions
      .filter((item) => visibleSessionIds.has(item.id))
      .map((item) => clone(item.payload))
    const receipts = userId
      ? state.agentSessionReadReceipts.filter((item) => item.projectId === projectId && item.userId === userId).map((item) => clone(item.payload))
      : []
    return {
      sessions: userId ? applyAgentSessionReadReceipts(sessions, receipts) : sessions,
      messages: includeMessages
        ? state.agentMessages.filter((item) => item.projectId === projectId && visibleSessionIds.has(item.sessionId)).map((item) => ({
          sessionId: item.sessionId, updatedAt: item.updatedAt, message: clone(item.payload),
        }))
        : [],
      memory: state.agentMemoryItems.filter((item) => item.projectId === projectId && !item.deletedAt).map((item) => clone(item.payload)),
      deletedMemoryIds: state.agentMemoryItems.filter((item) => item.projectId === projectId && item.deletedAt).map((item) => item.id),
      runs: state.agentRuns.filter((item) => item.projectId === projectId).map(clone),
    }
  }

  function upsertArtifactRecords(projectId, ownerId, artifacts) {
    for (const artifact of artifacts) {
      const existing = state.agentArtifacts.find((item) => item.projectId === projectId && item.id === artifact.id)
      if (existing && Number(existing.updatedAt ?? 0) > Number(artifact.updatedAt ?? 0)) continue
      const indexedCreatedAt = existing ? Math.min(existing.createdAt, artifact.createdAt) : artifact.createdAt
      const record = {
        id: artifact.id,
        projectId,
        ownerId: existing?.ownerId ?? ownerId,
        kind: artifact.kind,
        sourceKind: artifact.origin.type,
        runId: artifact.provenance.runId,
        jobId: artifact.origin.jobId,
        createdAt: indexedCreatedAt,
        updatedAt: artifact.updatedAt,
        payload: { ...clone(artifact), createdAt: indexedCreatedAt },
      }
      if (existing) Object.assign(existing, record)
      else state.agentArtifacts.push(record)
    }
  }

  function refreshGenerationArtifactRecords(project, job, ownerId) {
    const graph = state.canvasGraphs.find((item) => item.projectId === job.projectId)?.graph
    const conversion = generationArtifactsFromJobReport(job, {
      document: { ...project.document, ...(graph ?? {}) },
    })
    upsertArtifactRecords(job.projectId, ownerId, conversion.artifacts)
    const indexed = state.agentArtifacts
      .filter((item) => item.projectId === job.projectId && item.jobId === job.id)
      .map((item) => item.payload)
    return generationArtifactRefreshReport(conversion, indexed)
  }

  function backfillArtifactIndexes() {
    for (const project of state.projects) {
      const ownerId = project.members.find((member) => member.role === 'owner')?.userId ?? project.members[0]?.userId
      if (!ownerId) continue
      const graph = state.canvasGraphs.find((item) => item.projectId === project.id)?.graph
      const document = mergeAgentStateIntoDocument({ ...project.document, ...(graph ?? {}) }, agentStateForProject(project.id))
      const generationJobs = state.generationJobs.filter((job) => job.projectId === project.id)
      upsertArtifactRecords(project.id, ownerId, artifactsFromDocument(document, { generationJobs }))
      for (const receipt of state.agentActionReceipts.filter((item) => item.projectId === project.id)) {
        upsertArtifactRecords(project.id, receipt.ownerId ?? ownerId, artifactsFromActionReceipt(receipt))
      }
    }
  }

  function syncAgentStateFromDocument(userId, document, previousDocument) {
    const extracted = agentStateFromDocument(document)
    // 先完成所有不可变绑定校验，再修改本地状态；避免后续消息冲突时
    // 留下只更新了 Session 的半完成 CanvasDocument 兼容同步。
    for (const entry of extracted.messages) {
      const existing = state.agentMessages.find((item) => item.id === entry.message.id)
      if (existing && (existing.projectId !== document.id || existing.sessionId !== entry.sessionId)) {
        throw productError('Agent 消息标识已被其他会话使用。', 'AGENT_MESSAGE_ID_CONFLICT')
      }
      mergeAgentMessageForWrite(existing?.payload, entry.message, {
        currentUpdatedAt: existing?.updatedAt,
        incomingUpdatedAt: entry.updatedAt,
      })
    }
    for (const session of extracted.sessions) {
      const existing = state.agentSessions.find((item) => item.id === session.id)
      if (existing && existing.projectId !== document.id) throw productError('Agent 会话标识已被其他项目使用。', 'AGENT_SESSION_ID_CONFLICT')
      if (!existing) state.agentSessions.push({
        id: session.id,
        projectId: document.id,
        ownerId: userId,
        updatedAt: session.updatedAt,
        payload: clone(session),
      })
    }
    for (const entry of extracted.messages) {
      const existing = state.agentMessages.find((item) => item.id === entry.message.id)
      const merged = mergeAgentMessageForWrite(existing?.payload, entry.message, {
        currentUpdatedAt: existing?.updatedAt,
        incomingUpdatedAt: entry.updatedAt,
      })
      const message = merged.message
      const payload = {
        id: entry.message.id, projectId: document.id, sessionId: entry.sessionId,
        ownerId: existing?.ownerId ?? userId,
        updatedAt: merged.updatedAt,
        payload: clone(message),
      }
      if (!existing) state.agentMessages.push(payload)
      else Object.assign(existing, payload)
    }
    // 旧 CanvasDocument 的共享阅读位置只在迁移时归属本次写入成员；
    // 之后所有更新都走成员级回执，避免继续污染共享 Session。
    for (const session of extracted.sessions) {
      if (!session.readingAnchorMessageId || session.readingAnchorUpdatedAt === undefined) continue
      const messageExists = extracted.messages.some((entry) => entry.sessionId === session.id && entry.message.id === session.readingAnchorMessageId)
      if (!messageExists) continue
      const receipt = {
        sessionId: session.id,
        messageId: session.readingAnchorMessageId,
        updatedAt: session.readingAnchorUpdatedAt,
      }
      const existing = state.agentSessionReadReceipts.find((item) => item.userId === userId && item.projectId === document.id && item.sessionId === session.id)
      if (!existing) state.agentSessionReadReceipts.push({ userId, projectId: document.id, sessionId: session.id, updatedAt: receipt.updatedAt, payload: receipt })
      else if (receipt.updatedAt > existing.updatedAt) Object.assign(existing, { updatedAt: receipt.updatedAt, payload: receipt })
    }
    const previousMemoryIds = new Set((Array.isArray(previousDocument?.agentMemory) ? previousDocument.agentMemory : []).map((item) => item?.id).filter(Boolean))
    const nextMemoryIds = new Set(extracted.memory.map((item) => item.id))
    for (const removedId of previousMemoryIds) {
      if (nextMemoryIds.has(removedId)) continue
      const existing = state.agentMemoryItems.find((item) => item.id === removedId && item.projectId === document.id)
      if (existing) existing.deletedAt = now()
    }
    for (const memory of extracted.memory) {
      const existing = state.agentMemoryItems.find((item) => item.id === memory.id)
      if (existing && existing.projectId !== document.id) throw productError('Agent 记忆标识已被其他项目使用。', 'AGENT_MEMORY_ID_CONFLICT')
      const payload = {
        id: memory.id, projectId: document.id, ownerId: existing?.ownerId ?? userId,
        updatedAt: memory.updatedAt, deletedAt: undefined, payload: clone(memory),
      }
      if (!existing) state.agentMemoryItems.push(payload)
      else if (memory.updatedAt >= existing.updatedAt) Object.assign(existing, payload)
    }
    for (const run of extracted.runs) {
      const existing = state.agentRuns.find((item) => item.id === run.id)
      if (existing && existing.projectId !== document.id) throw productError('Agent Run 标识已被其他项目使用。', 'AGENT_RUN_ID_CONFLICT')
      const payload = { ...clone(run), projectId: document.id, ownerId: existing?.ownerId ?? userId }
      if (!existing) state.agentRuns.push(payload)
      // CanvasDocument 仅负责首次兼容迁移；已有独立 Run 始终是执行状态权威。
    }
    upsertArtifactRecords(document.id, userId, artifactsFromDocument(document))
  }

  function publicProject(project) {
    const graphEntry = state.canvasGraphs.find((item) => item.projectId === project.id)
    const summary = projectDocumentSummary(graphEntry ? { ...project.document, ...graphEntry.graph } : project.document)
    return {
      id: project.id,
      name: project.name,
      updatedAt: Math.max(project.updatedAt, graphEntry?.updatedAt ?? 0),
      revision: project.revision,
      graphRevision: graphEntry?.graphRevision ?? 1,
      ...summary,
      role: project.members.find((item) => item.userId === project.lastAccessedBy)?.role,
    }
  }

  function ensureCanvasGraph(project) {
    let entry = state.canvasGraphs.find((item) => item.projectId === project.id)
    if (!entry) {
      entry = {
        projectId: project.id,
        graph: {
          ...canvasGraph(project.document),
        },
        graphRevision: 1,
        syncProtocolEpoch: 1,
        updates: [],
        updatedAt: project.updatedAt,
      }
      state.canvasGraphs.push(entry)
      save()
    }
    if (!Array.isArray(entry.committedMutations)) entry.committedMutations = []
    return entry
  }

  function persistGenerationDecision(job, {
    updateAgentRun = true,
    recordAudit = true,
    syncArtifacts = true,
  } = {}) {
    const payload = clone(job)
    const index = state.generationJobs.findIndex((item) => item.id === payload.id)
    if (index >= 0) state.generationJobs[index] = payload
    else state.generationJobs.push(payload)
    // Job 是执行权威：先单独落盘，后续可重建投影失败不得回滚 claim/terminal/cancel。
    save()
    let artifactReady = true
    if (syncArtifacts) {
      try {
        const project = state.projects.find((item) => item.id === payload.projectId)
        artifactReady = project
          ? refreshGenerationArtifactRecords(project, payload, payload.ownerId).status === 'passed'
          : false
        save()
      } catch (caught) {
        artifactReady = false
        console.warn(`[artifact-index] generation sync deferred for ${payload.id}: ${caught instanceof Error ? caught.message : String(caught)}`)
      }
    }
    const terminalNeedsArtifacts = ['succeeded', 'failed'].includes(payload.status) && Boolean(payload.outputs?.length)
    if (updateAgentRun && payload.agentRun?.runId) {
      // Processor 的 fenced terminal commit 使用 syncArtifacts=false，代表显式 refresh 已成功。
      // 普通 terminal put 若索引失败，则宁可让 Run 暂停，也不发布缺 Artifact 的终态。
      if (!terminalNeedsArtifacts || !syncArtifacts || artifactReady) {
        const runIndex = state.agentRuns.findIndex((item) => item.id === payload.agentRun.runId && item.ownerId === payload.ownerId)
        if (runIndex < 0) throw productError('未找到关联的 Agent Run。', 'AGENT_RUN_NOT_FOUND')
        state.agentRuns[runIndex] = applyGenerationJobToAgentRun(state.agentRuns[runIndex], payload)
        save()
      }
    }
    if (recordAudit) audit({
      actorId: payload.ownerId,
      action: `generation.${payload.status}`,
      projectId: payload.projectId,
      targetId: payload.id,
      detail: { model: payload.settings?.model, batchCount: payload.batchCount },
    })
    if (recordAudit) save()
    return clone(payload)
  }

  function publicSubagentTurn(turn) {
    if (!turn) return undefined
    return {
      id: turn.id,
      version: turn.version,
      projectId: turn.projectId,
      sessionId: turn.sessionId,
      status: turn.status,
      createdAt: turn.createdAt,
      updatedAt: turn.updatedAt,
      ...(turn.result ? { result: clone(turn.result) } : {}),
      ...(turn.error ? { error: clone(turn.error) } : {}),
    }
  }

  function publicSubagentDecision(value) {
    return {
      kind: value.kind,
      subagent: publicAgentSubagent(value.subagent),
      activation: publicAgentSubagentActivation(value.activation),
      ...(value.turn ? { turn: publicSubagentTurn(value.turn) } : {}),
      changed: value.changed,
    }
  }

  function putSubagentResultMessage(subagent, message) {
    const existing = state.agentMessages.find((item) => item.id === message.id)
    if (existing && (existing.projectId !== subagent.projectId || existing.sessionId !== subagent.sessionId
      || existing.payload?.turnId !== message.turnId)) {
      throw productError('Subagent 结果消息标识已被其他会话使用。', 'AGENT_MESSAGE_ID_CONFLICT')
    }
    const storedUpdatedAt = Math.max(Number(existing?.updatedAt) || 0, Number(message.updatedAt) || 0)
    const authoritativeMessage = { ...clone(message), updatedAt: storedUpdatedAt }
    const record = {
      id: message.id,
      projectId: subagent.projectId,
      sessionId: subagent.sessionId,
      ownerId: existing?.ownerId ?? subagent.ownerId,
      updatedAt: storedUpdatedAt,
      payload: authoritativeMessage,
    }
    if (existing) Object.assign(existing, record)
    else state.agentMessages.push(record)
    upsertArtifactRecords(subagent.projectId, subagent.ownerId, artifactsFromAgentMessage(authoritativeMessage, {
      sessionId: subagent.sessionId,
      updatedAt: storedUpdatedAt,
    }))
    const session = state.agentSessions.find((item) => item.id === subagent.sessionId)
    if (session) {
      session.updatedAt = Math.max(Number(session.updatedAt) || 0, storedUpdatedAt)
      session.payload.updatedAt = session.updatedAt
    }
  }

  return {
    authenticate(accessToken) {
      const user = authenticatedUser(accessToken)
      return publicUser(user)
    },

    createUser(actorId, { email, name, role = 'member', accessToken }) {
      const actor = state.users.find((item) => item.id === actorId)
      assertWorkspacePermission(actor, 'manage-members', 'USER_CREATE_FORBIDDEN')
      if (!email || !accessToken) throw new Error('成员邮箱与访问令牌不能为空。')
      if (state.users.some((item) => item.email.toLowerCase() === email.toLowerCase())) throw new Error('该成员已存在。')
      const user = { id: `usr_${randomUUID()}`, email, name: name || email, role, status: 'active', createdAt: now() }
      state.users.push(user)
      state.accessTokens.push({ id: `token_${randomUUID()}`, userId: user.id, tokenHash: hashAccessToken(accessToken), createdAt: now() })
      audit({ actorId, action: 'member.created', targetId: user.id, detail: { email: user.email, role } })
      save()
      return publicUser(user)
    },

    listUsers(actorId) {
      const actor = state.users.find((item) => item.id === actorId)
      assertWorkspacePermission(actor, 'manage-members', 'USER_MANAGE_FORBIDDEN')
      return state.users
        .slice()
        .sort((left, right) => Number(left.createdAt ?? 0) - Number(right.createdAt ?? 0))
        .map(publicUser)
    },

    updateUser(actorId, targetId, updates) {
      const actor = state.users.find((item) => item.id === actorId)
      assertWorkspacePermission(actor, 'manage-members', 'USER_MANAGE_FORBIDDEN')
      const target = state.users.find((item) => item.id === targetId)
      if (!target) throw productError('未找到该工作区成员。', 'USER_NOT_FOUND')
      const nextRole = updates?.role ?? target.role
      const nextStatus = updates?.status ?? target.status ?? 'active'
      if (!['owner', 'member'].includes(nextRole) || !['active', 'disabled'].includes(nextStatus)) {
        throw productError('成员更新参数无效。', 'USER_UPDATE_INVALID')
      }
      if (target.role === 'owner' && (nextRole !== 'owner' || nextStatus === 'disabled')) {
        const activeOwners = state.users.filter((item) => item.role === 'owner' && item.status !== 'disabled')
        if (activeOwners.length <= 1) throw productError('工作区必须保留至少一名启用的所有者。', 'LAST_OWNER_REQUIRED')
      }
      target.role = nextRole
      target.status = nextStatus
      if (nextStatus === 'disabled') {
        for (const token of state.accessTokens) {
          if (token.userId === target.id && !token.revokedAt) token.revokedAt = now()
        }
      }
      audit({ actorId, action: 'member.updated', targetId, detail: { role: nextRole, status: nextStatus } })
      save()
      return publicUser(target)
    },

    listProjects(userId) {
      const startedAt = Date.now()
      const projects = state.projects
        .filter((project) => canAccess(project, userId))
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map((project) => ({
          ...publicProject(project),
          role: canAccess(project, userId)?.role,
        }))
      observeProductStoreRead('listProjects', {
        userId,
        durationMs: Date.now() - startedAt,
        ok: true,
        projectCount: projects.length,
      })
      return projects
    },

    readProject(userId, projectId) {
      const startedAt = Date.now()
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, userId)) return undefined
      project.lastAccessedBy = userId
      const graph = ensureCanvasGraph(project)
      const agentState = agentStateForProject(projectId, userId, { includeMessages: false })
      const result = {
        document: mergeAgentStateIntoDocument({
          ...clone(project.document),
          ...clone(graph.graph),
          updatedAt: Math.max(project.document.updatedAt ?? 0, project.updatedAt, graph.updatedAt ?? 0),
        }, agentState, { includeMessages: false }),
        revision: project.revision,
        graphRevision: graph.graphRevision,
        syncProtocolEpoch: graph.syncProtocolEpoch ?? 1,
      }
      observeProductStoreRead('readProject', {
        projectId,
        userId,
        durationMs: Date.now() - startedAt,
        ok: true,
        messageRowCount: 0,
        sessionCount: agentState.sessions.length,
      })
      return result
    },

    projectAccess(userId, projectId) {
      const project = state.projects.find((item) => item.id === projectId)
      return {
        exists: Boolean(project),
        role: project?.members.find((item) => item.userId === userId)?.role,
      }
    },

    canEditProject(userId, projectId) {
      const project = state.projects.find((item) => item.id === projectId)
      const role = project?.members.find((item) => item.userId === userId)?.role
      return projectPermissionDecision(role, 'edit') === 'allow'
    },

    readCanvasSyncProtocolEpoch(userId, projectId) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, userId)) return undefined
      return ensureCanvasGraph(project).syncProtocolEpoch ?? 1
    },

    writeProject(userId, document, expectedRevision, expectedGraphRevision) {
      const existing = state.projects.find((item) => item.id === document.id)
      if (existing) {
        const member = existing.members.find((item) => item.userId === userId)
        assertProjectPermission(member?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
        if (Number.isInteger(expectedRevision) && expectedRevision !== existing.revision) {
          const conflict = new Error('项目已被其他成员更新，请刷新后再保存。')
          conflict.code = 'PROJECT_CONFLICT'
          throw conflict
        }
        const graph = ensureCanvasGraph(existing)
        const nextGraph = canvasGraph(document)
        const graphChanged = !sameGraph(graph.graph, nextGraph)
        if (graphChanged && (graph.syncProtocolEpoch ?? 1) >= 2) {
          throw canvasSyncEpochStaleError(graph.syncProtocolEpoch)
        }
        if (graphChanged && Number.isInteger(expectedGraphRevision) && expectedGraphRevision !== graph.graphRevision) {
          const conflict = new Error('画布图谱已被其他成员更新，请刷新后再保存。')
          conflict.code = 'CANVAS_GRAPH_CONFLICT'
          throw conflict
        }
        if (graphChanged) {
          graph.graph = nextGraph
          graph.graphRevision += 1
          graph.updatedAt = now()
        }
        const previousDocument = existing.document
        syncAgentStateFromDocument(userId, document, previousDocument)
        existing.document = stripAgentMessagesFromDocument(clone(document))
        existing.name = document.name
        existing.updatedAt = now()
        existing.revision += 1
        audit({ actorId: userId, action: 'project.updated', projectId: existing.id, detail: { revision: existing.revision } })
        save()
        return {
          document: { ...clone(existing.document), ...clone(graph.graph) },
          revision: existing.revision,
          graphRevision: graph.graphRevision,
          syncProtocolEpoch: graph.syncProtocolEpoch ?? 1,
          created: false,
        }
      }

      const project = {
        id: document.id,
        name: document.name,
        document: stripAgentMessagesFromDocument(clone(document)),
        members: [{ userId, role: 'owner', addedAt: now() }],
        revision: 1,
        createdAt: now(),
        updatedAt: now(),
      }
      state.projects.push(project)
      state.canvasGraphs.push({
        projectId: project.id,
        graph: canvasGraph(document),
        graphRevision: 1,
        syncProtocolEpoch: 1,
        updates: [],
        updatedAt: project.updatedAt,
      })
      syncAgentStateFromDocument(userId, document)
      audit({ actorId: userId, action: 'project.created', projectId: project.id })
      save()
      return { document: clone(project.document), revision: project.revision, graphRevision: 1, syncProtocolEpoch: 1, created: true }
    },

    /**
     * 在 Store 锁内原子地「读最新文档 → mutate → 写回」。Worker 回写走这里就不再和
     * 用户保存比谁先拿到 revision；mutate 返回 undefined 表示无需写入。
     * 进程内 Store 天然串行；mutate 必须是同步函数。
     */
    updateProjectDocument(userId, projectId, mutate) {
      const existing = state.projects.find((item) => item.id === projectId)
      if (!existing) return undefined
      const member = existing.members.find((item) => item.userId === userId)
      assertProjectPermission(member?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const graph = ensureCanvasGraph(existing)
      const next = mutate({ ...clone(existing.document), ...clone(graph.graph) })
      if (!next) return undefined
      return this.writeProject(userId, next, existing.revision, graph.graphRevision)
    },

    deleteProject(userId, projectId) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project) return false
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'delete-project', 'PROJECT_DELETE_FORBIDDEN')
      state.projects = state.projects.filter((item) => item.id !== projectId)
      state.canvasGraphs = state.canvasGraphs.filter((item) => item.projectId !== projectId)
      state.generationJobs = state.generationJobs.filter((item) => item.projectId !== projectId)
      state.agentRuns = state.agentRuns.filter((item) => item.projectId !== projectId)
      state.agentSubagents = state.agentSubagents.filter((item) => item.projectId !== projectId)
      state.agentSubagentActivations = state.agentSubagentActivations.filter((item) => item.projectId !== projectId)
      state.agentSessions = state.agentSessions.filter((item) => item.projectId !== projectId)
      state.agentSessionReadReceipts = state.agentSessionReadReceipts.filter((item) => item.projectId !== projectId)
      state.agentContextStates = state.agentContextStates.filter((item) => item.projectId !== projectId)
      state.agentContextCompactions = state.agentContextCompactions.filter((item) => item.projectId !== projectId)
      state.collaborationActivities = state.collaborationActivities.filter((item) => item.projectId !== projectId)
      state.collaborationActivityReceipts = state.collaborationActivityReceipts.filter((item) => item.projectId !== projectId)
      state.agentMessages = state.agentMessages.filter((item) => item.projectId !== projectId)
      state.agentMemoryItems = state.agentMemoryItems.filter((item) => item.projectId !== projectId)
      state.agentArtifacts = state.agentArtifacts.filter((item) => item.projectId !== projectId)
      state.agentSkills = state.agentSkills.filter((item) => item.projectId !== projectId)
      state.agentActionReceipts = state.agentActionReceipts.filter((item) => item.projectId !== projectId)
      audit({ actorId: userId, action: 'project.deleted', targetId: projectId, detail: { name: project.name } })
      save()
      return true
    },

    addProjectMember(actorId, projectId, userId, role) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      assertProjectPermission(project.members.find((item) => item.userId === actorId)?.role, 'manage-members', 'PROJECT_MEMBER_FORBIDDEN')
      const user = state.users.find((item) => item.id === userId)
      if (!user) throw new Error('未找到成员。')
      const member = project.members.find((item) => item.userId === userId)
      if (member) member.role = role
      else project.members.push({ userId, role, addedAt: now() })
      project.updatedAt = now()
      project.revision += 1
      audit({ actorId, action: 'project.member.upserted', projectId, targetId: userId, detail: { role } })
      save()
    },

    loadCanvasCollaboration(userId, projectId) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, userId)) return undefined
      const entry = ensureCanvasGraph(project)
      return clone({
        graph: entry.graph,
        graphRevision: entry.graphRevision,
        syncProtocolEpoch: entry.syncProtocolEpoch ?? 1,
        snapshot: entry.snapshot,
        updates: entry.updates,
        updatedAt: entry.updatedAt,
      })
    },

    appendCanvasGraphUpdate(userId, projectId, input) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const { update, graph, mutationId, payloadHash, expectedGraphRevision, syncProtocolEpoch } = normalizeCanvasGraphMutation(input)
      const entry = ensureCanvasGraph(project)
      const currentSyncProtocolEpoch = entry.syncProtocolEpoch ?? 1
      if (currentSyncProtocolEpoch >= 2 && syncProtocolEpoch !== currentSyncProtocolEpoch) {
        throw canvasSyncEpochStaleError(currentSyncProtocolEpoch)
      }
      const committed = entry.committedMutations.find((item) => item.mutationId === mutationId)
      if (committed) {
        if (committed.payloadHash !== payloadHash) {
          throw productError('画布协作提交身份已绑定到其他更新。', canvasMutationConflictCode)
        }
        return {
          graphRevision: entry.graphRevision,
          mutationRevision: committed.graphRevision,
          updatedAt: entry.updatedAt,
          updateCount: entry.updates.length,
          duplicate: true,
          ...(committed.update ? { update: committed.update } : {}),
        }
      }
      if (Number.isInteger(expectedGraphRevision) && expectedGraphRevision !== entry.graphRevision) {
        throw productError('画布已被其他成员更新，请重新同步。', canvasGraphConflictCode)
      }
      entry.graph = clone(graph)
      entry.graphRevision += 1
      entry.updates.push(update)
      entry.updatedAt = now()
      entry.committedMutations.push({
        mutationId,
        payloadHash,
        update,
        graphRevision: entry.graphRevision,
        committedAt: entry.updatedAt,
      })
      save()
      return {
        graphRevision: entry.graphRevision,
        mutationRevision: entry.graphRevision,
        updatedAt: entry.updatedAt,
        updateCount: entry.updates.length,
        duplicate: false,
      }
    },

    compactCanvasGraphUpdates(userId, projectId, { snapshot, graph, expectedGraphRevision }) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      if (typeof snapshot !== 'string' || !snapshot || !Array.isArray(graph?.nodes) || !Array.isArray(graph?.edges)) {
        throw new TypeError('画布协作快照格式无效。')
      }
      const entry = ensureCanvasGraph(project)
      if (Number.isInteger(expectedGraphRevision) && expectedGraphRevision !== entry.graphRevision) {
        throw productError('画布已被其他成员更新，请重新同步。', canvasGraphConflictCode)
      }
      entry.graph = clone(graph)
      entry.snapshot = snapshot
      entry.updates = []
      entry.committedMutations.forEach((mutation) => { delete mutation.update })
      entry.updatedAt = now()
      save()
      return { graphRevision: entry.graphRevision, updatedAt: entry.updatedAt }
    },

    readGlobalAssetLibrary(userId, id) {
      const user = state.users.find((item) => item.id === userId)
      if (!user || user.status === 'disabled') return undefined
      const library = state.globalAssetLibraries.find((item) => item.id === id)
      return library ? clone(library.library) : undefined
    },

    writeGlobalAssetLibrary(userId, library) {
      const user = state.users.find((item) => item.id === userId)
      assertWorkspacePermission(user, 'manage-library', 'LIBRARY_WRITE_FORBIDDEN')
      const existing = state.globalAssetLibraries.find((item) => item.id === library.id)
      if (existing) {
        existing.library = clone(library)
        existing.updatedAt = now()
      } else {
        state.globalAssetLibraries.push({ id: library.id, library: clone(library), updatedAt: now() })
      }
      audit({ actorId: userId, action: 'brand-library.updated', targetId: library.id })
      save()
      return clone(library)
    },

    deleteGlobalAsset(userId, assetId) {
      const libraryEntry = state.globalAssetLibraries.find((item) => item.id === 'global-brand-assets')
      if (!libraryEntry) return { deleted: false, library: undefined }
      const user = state.users.find((item) => item.id === userId)
      assertWorkspacePermission(user, 'manage-library', 'LIBRARY_WRITE_FORBIDDEN')
      const assets = libraryEntry.library.assets.filter((asset) => asset.id !== assetId)
      const deleted = assets.length !== libraryEntry.library.assets.length
      if (deleted) {
        libraryEntry.library = { ...libraryEntry.library, assets, updatedAt: now() }
        libraryEntry.updatedAt = now()
        audit({ actorId: userId, action: 'brand-asset.deleted', targetId: assetId })
        save()
      }
      return { deleted, library: clone(libraryEntry.library) }
    },

    readAgentState(userId, projectId, options = {}) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, userId)) return undefined
      const hydrated = mergeAgentStateIntoDocument({ agentSessions: [], agentMemory: [], agentRuns: [] }, agentStateForProject(projectId, userId, options))
      return {
        sessions: hydrated.agentSessions,
        memory: hydrated.agentMemory,
        runs: hydrated.agentRuns,
      }
    },

    listAgentSessions(userId, projectId, options = {}) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, userId)) return undefined
      const limit = normalizeAgentSessionListLimit(options.limit)
      const stateSlice = agentStateForProject(projectId, userId, {
        includeMessages: false,
        includeSubagents: options.includeSubagents === true,
      })
      return stateSlice.sessions.slice(0, limit).map((session) => ({ ...session, messages: [] }))
    },

    readAgentSession(userId, projectId, sessionId, options = {}) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, userId)) return undefined
      const record = state.agentSessions.find((item) => item.projectId === projectId && item.id === sessionId)
      if (!record || (options.includeSubagents !== true && record.payload?.kind === 'subagent')) return undefined
      return { ...clone(record.payload), messages: [] }
    },

    listAgentSessionMessages(userId, projectId, sessionId, options = {}) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, userId)) return undefined
      if (!state.agentSessions.some((item) => item.projectId === projectId && item.id === sessionId
        && (options.includeSubagents === true || item.payload?.kind !== 'subagent'))) return undefined
      const page = agentMessageListOptions(options)
      const filtered = state.agentMessages
        .filter((item) => item.projectId === projectId && item.sessionId === sessionId)
        .filter((item) => !page.before
          || item.updatedAt < page.before.updatedAt
          || (item.updatedAt === page.before.updatedAt && item.id.localeCompare(page.before.id) < 0))
        .sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id))
        .slice(0, page.limit)
      const messages = filtered.map((item) => clone(item.payload)).reverse()
      const oldest = filtered.at(-1)
      return {
        messages,
        nextBefore: filtered.length === page.limit && oldest
          ? encodeAgentMessageCursor({ id: oldest.id, updatedAt: oldest.updatedAt, createdAt: oldest.updatedAt })
          : undefined,
        readMetrics: { messageCount: messages.length },
      }
    },

    listCollaborationActivities(userId, projectId, options = 100) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, userId)) return undefined
      const receipt = state.collaborationActivityReceipts.find((item) => item.userId === userId && item.projectId === projectId)
      return collaborationActivitiesForMember(
        state.collaborationActivities.filter((item) => item.projectId === projectId).map((item) => item.payload),
        receipt?.payload,
        userId,
        options,
      )
    },

    putCollaborationActivity(userId, projectId, input) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const existing = state.collaborationActivities.find((item) => item.projectId === projectId && item.id === input?.id)
      if (existing) return clone(existing.payload)
      const actor = state.users.find((item) => item.id === userId)
      const activity = validateCollaborationActivity(input, { actorId: userId, actorName: actor?.name })
      state.collaborationActivities.push({ id: activity.id, projectId, occurredAt: activity.occurredAt, payload: activity })
      if (state.collaborationActivities.length > 20_000) state.collaborationActivities.splice(0, state.collaborationActivities.length - 20_000)
      save()
      return clone(activity)
    },

    putCollaborationActivityReceipt(userId, projectId, input) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, userId)) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      const existing = state.collaborationActivityReceipts.find((item) => item.userId === userId && item.projectId === projectId)
      const receipt = nextCollaborationReceipt(existing?.payload, input?.action)
      const record = { userId, projectId, updatedAt: receipt.updatedAt, payload: receipt }
      if (existing) Object.assign(existing, record)
      else state.collaborationActivityReceipts.push(record)
      save()
      return clone(receipt)
    },

    putAgentSessionReadReceipt(userId, projectId, sessionId, input) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'read', 'PROJECT_READ_FORBIDDEN')
      const session = state.agentSessions.find((item) => item.id === sessionId && item.projectId === projectId)
      if (!session) throw productError('未找到 Agent 会话。', 'AGENT_SESSION_NOT_FOUND')
      const serverTime = now()
      const timestampValue = input?.updatedAt === undefined
        ? serverTime
        : validateAgentEntityWriteTimestamp(input.updatedAt, { now: serverTime })
      const receipt = validateAgentSessionReadReceipt({ ...input, sessionId, updatedAt: timestampValue }, { now: serverTime })
      const message = state.agentMessages.find((item) => item.id === receipt.messageId && item.projectId === projectId && item.sessionId === sessionId)
      if (!message) throw productError('目标消息已不存在。', 'AGENT_MESSAGE_NOT_FOUND')
      const existing = state.agentSessionReadReceipts.find((item) => item.userId === userId && item.projectId === projectId && item.sessionId === sessionId)
      if (existing && existing.updatedAt >= receipt.updatedAt) return clone(existing.payload)
      const record = { userId, projectId, sessionId, updatedAt: receipt.updatedAt, payload: receipt }
      if (existing) Object.assign(existing, record)
      else state.agentSessionReadReceipts.push(record)
      save()
      return clone(receipt)
    },

    compareAndSetAgentSessionSettings(userId, projectId, command) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const conflict = state.agentSessions.find((item) => item.id === command?.sessionId)
      if (conflict && conflict.projectId !== projectId) {
        throw productError('Agent 会话标识已被其他项目使用。', 'AGENT_SESSION_ID_CONFLICT')
      }
      const decision = compareAndSetAgentSessionSettings(conflict?.payload, command, { now: now() })
      if (!decision.changed) return clone(decision)
      const session = decision.session
      const record = {
        id: session.id,
        projectId,
        ownerId: conflict?.ownerId ?? userId,
        updatedAt: session.updatedAt,
        payload: clone(session),
      }
      if (conflict) Object.assign(conflict, record)
      else state.agentSessions.push(record)
      audit({ actorId: userId, action: decision.kind === 'created' ? 'agent-session.created' : 'agent-session.updated', projectId, targetId: session.id })
      save()
      return clone(decision)
    },

    putAgentSession(userId, projectId, input) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const timestamp = Number.isFinite(Number(input?.updatedAt)) ? Number(input.updatedAt) : now()
      let session = validateAgentSessionEntity({ ...input, updatedAt: timestamp }, { now: timestamp })
      const existing = state.agentSessions.find((item) => item.id === session.id)
      if (existing && existing.projectId !== projectId) throw productError('Agent 会话标识已被其他项目使用。', 'AGENT_SESSION_ID_CONFLICT')
      if (existing && existing.updatedAt >= session.updatedAt) return clone(existing.payload)
      // 线程摘要是服务端派生字段。普通设置写入不携带它时必须保留现值；显式携带
      // 仍供服务端内部摘要刷新使用，HTTP 层已拒绝客户端提交该字段。
      session = preserveAgentThreadSummary(existing?.payload, session)
      const record = { id: session.id, projectId, ownerId: existing?.ownerId ?? userId, updatedAt: timestamp, payload: session }
      if (existing) Object.assign(existing, record)
      else state.agentSessions.push(record)
      audit({ actorId: userId, action: existing ? 'agent-session.updated' : 'agent-session.created', projectId, targetId: session.id })
      save()
      return clone(session)
    },

    compareAndSetAgentThreadSummary(userId, command) {
      const inputDecision = agentThreadSummaryCompareAndSetDecision(undefined, command)
      if (inputDecision.kind === 'invalid') return clone(inputDecision)
      const existing = state.agentSessions.find((item) => item.id === command?.sessionId)
      if (!existing) return { kind: 'not_found', changed: false }
      const project = state.projects.find((item) => item.id === existing.projectId)
      if (!project) return { kind: 'not_found', changed: false }
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const decision = agentThreadSummaryCompareAndSetDecision(existing.payload, command)
      if (!decision.changed) return clone(decision)
      // 只替换 payload 子字段；record.updatedAt 与 payload.updatedAt 都保持不变，
      // Session 列表不会因为后台 compaction 跳到最前。
      existing.payload = { ...existing.payload, threadSummary: clone(decision.session.threadSummary) }
      save()
      return clone({ ...decision, session: existing.payload })
    },

    readAgentContextState(userId, projectId, sessionId) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, userId)) return undefined
      const session = state.agentSessions.find((item) => item.id === sessionId && item.projectId === projectId)
      if (!session) return undefined
      const record = state.agentContextStates.find((item) => item.sessionId === sessionId && item.projectId === projectId)
      return record ? clone(record.payload) : {
        version: 2, sessionId, projectId, revision: 0, updatedAt: 0,
      }
    },

    listAgentContextCompactions(userId, projectId, sessionId, options = {}) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, userId)) return undefined
      const session = state.agentSessions.find((item) => item.id === sessionId && item.projectId === projectId)
      if (!session) return undefined
      const page = normalizeAgentContextCompactionPage(options)
      const compactions = state.agentContextCompactions
        .filter((item) => item.projectId === projectId && item.sessionId === sessionId
          && item.sequence > page.afterSequence && item.payload?.compaction)
        .sort((left, right) => left.sequence - right.sequence)
        .slice(0, page.limit)
        .map((item) => publicAgentContextCompaction(item.payload))
        .filter(Boolean)
      return {
        compactions,
        ...(compactions.length === page.limit
          ? { nextAfterSequence: compactions.at(-1)?.sequence }
          : {}),
      }
    },

    compareAndSetAgentContextState(userId, rawCommand) {
      let command
      try {
        command = materializeAgentContextCommand(rawCommand)
      } catch {
        return { kind: 'invalid', changed: false }
      }
      const project = state.projects.find((item) => item.id === command.projectId)
      const session = state.agentSessions.find((item) => item.id === command.sessionId
        && item.projectId === command.projectId)
      if (!project || !session) return { kind: 'not_found', changed: false }
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const stateRecord = state.agentContextStates.find((item) => item.projectId === command.projectId
        && item.sessionId === command.sessionId)
      const replayRecord = state.agentContextCompactions.find((item) => item.projectId === command.projectId
        && item.sessionId === command.sessionId && item.idempotencyKey === command.idempotencyKey)
      const decision = agentContextStateCompareAndSetDecision({
        state: stateRecord?.payload,
        replayEntry: replayRecord?.payload,
        command,
        ownerId: stateRecord?.ownerId ?? session.ownerId,
        observedAt: now(),
      })
      if (!decision.changed) return clone(decision)
      const ledger = decision.ledgerEntry
      state.agentContextCompactions.push({
        id: ledger.id,
        ownerId: ledger.ownerId,
        projectId: ledger.projectId,
        sessionId: ledger.sessionId,
        sequence: ledger.sequence,
        idempotencyKey: ledger.idempotencyKey,
        requestHash: ledger.requestHash,
        createdAt: ledger.createdAt,
        payload: clone(ledger),
      })
      const nextStateRecord = {
        ownerId: stateRecord?.ownerId ?? session.ownerId,
        projectId: command.projectId,
        sessionId: command.sessionId,
        revision: decision.state.revision,
        updatedAt: decision.state.updatedAt,
        payload: clone(decision.state),
      }
      if (stateRecord) Object.assign(stateRecord, nextStateRecord)
      else state.agentContextStates.push(nextStateRecord)
      save()
      const { ledgerEntry: _ledgerEntry, ...publicDecision } = decision
      return clone(publicDecision)
    },

    putAgentMessage(userId, projectId, sessionId, input) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const session = state.agentSessions.find((item) => item.id === sessionId && item.projectId === projectId)
      if (!session) throw productError('未找到 Agent 会话。', 'AGENT_SESSION_NOT_FOUND')
      const timestamp = Number.isFinite(Number(input?.updatedAt)) ? Number(input.updatedAt) : now()
      let message = validateAgentMessageEntity({ ...input, updatedAt: timestamp }, { now: timestamp })
      const existing = state.agentMessages.find((item) => item.id === message.id)
      if (existing && (existing.projectId !== projectId || existing.sessionId !== sessionId)) {
        throw productError('Agent 消息标识已被其他会话使用。', 'AGENT_MESSAGE_ID_CONFLICT')
      }
      const merged = mergeAgentMessageForWrite(existing?.payload, message, {
        currentUpdatedAt: existing?.updatedAt,
        incomingUpdatedAt: message.updatedAt,
      })
      message = merged.message
      const storedUpdatedAt = merged.updatedAt
      const record = { id: message.id, projectId, sessionId, ownerId: existing?.ownerId ?? userId, updatedAt: storedUpdatedAt, payload: message }
      if (existing) Object.assign(existing, record)
      else state.agentMessages.push(record)
      session.updatedAt = Math.max(session.updatedAt, storedUpdatedAt)
      session.payload.updatedAt = session.updatedAt
      upsertArtifactRecords(projectId, userId, artifactsFromAgentMessage(message, { sessionId, updatedAt: storedUpdatedAt }))
      audit({ actorId: userId, action: existing ? 'agent-message.updated' : 'agent-message.created', projectId, targetId: message.id, detail: { sessionId } })
      save()
      return clone(message)
    },

    putAgentMemoryItem(userId, projectId, input) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const serverTime = now()
      const requestedTimestamp = input?.updatedAt === undefined
        ? serverTime
        : validateAgentEntityWriteTimestamp(input.updatedAt, { now: serverTime })
      const memory = validateAgentMemoryEntity({ ...input, updatedAt: requestedTimestamp }, { now: serverTime })
      const timestamp = validateAgentEntityWriteTimestamp(memory.updatedAt, { now: serverTime })
      const existing = state.agentMemoryItems.find((item) => item.id === memory.id)
      if (existing && existing.projectId !== projectId) throw productError('Agent 记忆标识已被其他项目使用。', 'AGENT_MEMORY_ID_CONFLICT')
      if (existing?.deletedAt) throw productError('该 Agent 记忆已删除，请创建新的记忆。', 'AGENT_MEMORY_DELETED')
      if (existing && !shouldApplyAgentEntityWrite(existing, memory, { tombstoneWinsTie: true })) {
        return clone(existing.payload)
      }
      const record = { id: memory.id, projectId, ownerId: existing?.ownerId ?? userId, updatedAt: timestamp, deletedAt: undefined, payload: memory }
      if (existing) Object.assign(existing, record)
      else state.agentMemoryItems.push(record)
      audit({ actorId: userId, action: existing ? 'agent-memory.updated' : 'agent-memory.created', projectId, targetId: memory.id })
      save()
      return clone(memory)
    },

    deleteAgentMemoryItem(userId, projectId, memoryId) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const existing = state.agentMemoryItems.find((item) => item.id === memoryId && item.projectId === projectId)
      if (!existing || existing.deletedAt) return false
      existing.deletedAt = now()
      existing.updatedAt = existing.deletedAt
      audit({ actorId: userId, action: 'agent-memory.deleted', projectId, targetId: memoryId })
      save()
      return true
    },

    listAgentArtifacts(userId, projectId, { limit = 100, before } = {}) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, userId)) return undefined
      const maximum = Math.max(1, Math.min(Number(limit) || 100, artifactIndexLimits.page))
      const beforeTimestamp = Number.isFinite(Number(before?.createdAt)) ? Number(before.createdAt) : Number.POSITIVE_INFINITY
      const beforeId = typeof before?.id === 'string' ? before.id : undefined
      return state.agentArtifacts
        .filter((artifact) => artifact.projectId === projectId && (
          artifact.createdAt < beforeTimestamp
          || (beforeId !== undefined && artifact.createdAt === beforeTimestamp && artifact.id.localeCompare(beforeId) > 0)
        ))
        .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
        .slice(0, maximum)
        .map((artifact) => ({ ...clone(artifact.payload), createdAt: artifact.createdAt }))
    },

    putAgentSkill(userId, skill) {
      const project = state.projects.find((item) => item.id === skill.projectId)
      if (!project) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const existing = state.agentSkills.find((item) => item.id === skill.id)
      if (existing && existing.projectId !== skill.projectId) throw productError('Skill 标识已被其他项目使用。', 'AGENT_SKILL_ID_CONFLICT')
      const decision = agentSkillPersistenceDecision(existing, skill, { ownerId: userId })
      if (decision.kind === 'replay') return clone(existing)
      const payload = decision.payload
      if (existing) Object.assign(existing, payload)
      else state.agentSkills.push(payload)
      audit({ actorId: userId, action: existing ? 'agent-skill.updated' : 'agent-skill.created', projectId: skill.projectId, targetId: skill.id })
      save()
      return clone(payload)
    },

    listAgentSkills(userId, projectId) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, userId)) return undefined
      return state.agentSkills
        .filter((skill) => skill.projectId === projectId && skill.status !== 'archived')
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map(clone)
    },

    readAgentSkillVersion(userId, projectId, skillId, version) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, userId)) return undefined
      const skill = state.agentSkills.find((item) => item.id === skillId && item.projectId === projectId)
      const snapshot = persistedAgentSkillVersion(skill, version)
      return snapshot ? clone({ projectId, skillId, ...snapshot }) : undefined
    },

    putAgentActionReceipt(userId, receipt) {
      const project = state.projects.find((item) => item.id === receipt.projectId)
      if (!project) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const existing = state.agentActionReceipts.find((item) => item.id === receipt.id)
      if (existing && (existing.ownerId !== userId || existing.projectId !== receipt.projectId)) {
        throw productError('Agent 行动回执冲突。', 'AGENT_ACTION_RECEIPT_CONFLICT')
      }
      // 兼容旧实例的完成回执只能首次插入；它不能覆盖已由 claim/settle 管理的
      // running 或终态记录。滚动部署仍需先排空旧实例，避免旧代码绕开执行前 claim。
      if (existing) return clone(existing)
      const payload = { ...clone(receipt), ownerId: userId }
      state.agentActionReceipts.push(payload)
      upsertArtifactRecords(receipt.projectId, userId, artifactsFromActionReceipt(receipt))
      audit({ actorId: userId, action: 'agent-action.succeeded', projectId: receipt.projectId, targetId: receipt.id, detail: { toolCallId: receipt.toolCallId } })
      save()
      return clone(payload)
    },

    readAgentActionReceipt(userId, receiptId) {
      const receipt = state.agentActionReceipts.find((item) => item.id === receiptId && item.ownerId === userId)
      if (!receipt) return undefined
      const project = state.projects.find((item) => item.id === receipt.projectId)
      return project && canAccess(project, userId) ? clone(receipt) : undefined
    },

    claimAgentActionReceipt(userId, claim) {
      if (typeof claim?.leaseToken !== 'string' || !claim.leaseToken.trim()) {
        throw productError('Agent 行动执行租约无效。', 'AGENT_ACTION_RECEIPT_INVALID')
      }
      const project = state.projects.find((item) => item.id === claim.projectId)
      if (!project) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const existing = state.agentActionReceipts.find((item) => item.id === claim.id)
      if (existing && (existing.ownerId !== userId || existing.projectId !== claim.projectId)) {
        return { kind: 'conflict' }
      }
      const decision = agentActionReceiptClaimDecision(existing, { ...clone(claim), ownerId: userId })
      if (decision.changed) {
        if (existing) Object.assign(existing, decision.receipt)
        else state.agentActionReceipts.push(decision.receipt)
        save()
      }
      return clone({ kind: decision.kind, receipt: decision.receipt })
    },

    settleAgentActionReceipt(userId, settlement) {
      if (typeof settlement?.leaseToken !== 'string' || !settlement.leaseToken.trim()) {
        throw productError('Agent 行动执行租约无效。', 'AGENT_ACTION_RECEIPT_INVALID')
      }
      const existing = state.agentActionReceipts.find((item) => item.id === settlement.id)
      if (!existing || existing.ownerId !== userId || existing.projectId !== settlement.projectId) {
        throw productError('未找到 Agent 行动回执。', 'AGENT_ACTION_RECEIPT_NOT_FOUND')
      }
      if (existing.leaseToken === settlement.leaseToken && existing.status === settlement.status
        && ['succeeded', 'failed', 'uncertain'].includes(existing.status)) {
        return clone(existing)
      }
      if (existing.status !== 'running' || existing.leaseToken !== settlement.leaseToken) {
        throw productError('Agent 行动执行租约已失效。', 'AGENT_ACTION_LEASE_STALE')
      }
      if (!['succeeded', 'failed', 'uncertain'].includes(settlement.status)) {
        throw productError('Agent 行动回执状态无效。', 'AGENT_ACTION_RECEIPT_INVALID')
      }
      Object.assign(existing, settledAgentActionReceipt(existing, settlement))
      if (settlement.status === 'succeeded') {
        delete existing.error
        upsertArtifactRecords(existing.projectId, userId, artifactsFromActionReceipt(existing))
        audit({ actorId: userId, action: 'agent-action.succeeded', projectId: existing.projectId, targetId: existing.id, detail: { toolCallId: existing.toolCallId } })
      }
      save()
      return clone(existing)
    },

    resolveAgentActionReceipt(userId, command) {
      const existing = state.agentActionReceipts.find((item) => item.id === command?.id)
      if (!existing || existing.ownerId !== userId || existing.projectId !== command?.projectId) {
        return { kind: 'not_found', changed: false }
      }
      const project = state.projects.find((item) => item.id === existing.projectId)
      assertProjectPermission(project?.members.find((item) => item.userId === userId)?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const observedAt = now()
      const requestedAuthorization = command?.manualRetryAuthorization
      const decision = agentActionReceiptResolutionDecision(existing, {
        ...clone(command), ownerId: userId, actorId: userId, resolvedAt: observedAt,
        ...(requestedAuthorization ? {
          manualRetryAuthorization: authoritativeAgentActionManualRetryAuthorization(
            requestedAuthorization,
            observedAt,
          ),
        } : {}),
      })
      if (decision.changed) {
        Object.assign(existing, decision.receipt)
        audit({
          actorId: userId,
          action: 'agent-action.reconciled',
          projectId: existing.projectId,
          targetId: existing.id,
          detail: {
            result: existing.resolution.decision,
            status: existing.status,
            toolCallId: existing.toolCallId,
            toolName: existing.actionName,
          },
        })
        save()
      }
      return clone(decision)
    },

    consumeAgentActionManualRetryAuthorization(userId, command) {
      const existing = state.agentActionReceipts.find((item) => item.id === command?.id)
      if (!existing || existing.ownerId !== userId || existing.projectId !== command?.projectId) {
        return { kind: 'not_found', changed: false }
      }
      const project = state.projects.find((item) => item.id === existing.projectId)
      assertProjectPermission(project?.members.find((item) => item.userId === userId)?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const decision = agentActionManualRetryConsumptionDecision(existing, {
        ...clone(command), ownerId: userId, actorId: userId, consumedAt: now(),
      })
      if (decision.changed) {
        Object.assign(existing, decision.receipt)
        audit({
          actorId: userId,
          action: 'agent-action.manual-retry-consumed',
          projectId: existing.projectId,
          targetId: existing.id,
          detail: {
            authorizationId: decision.authorization.id,
            retryReceiptId: decision.authorization.consumedByReceiptId,
            toolCallId: existing.toolCallId,
            toolName: existing.actionName,
          },
        })
        save()
      }
      return clone(decision)
    },

    putGenerationJob(userId, job, { updateAgentRun = true, recordAudit = true } = {}) {
      const incoming = { ...clone(job), ownerId: userId }
      const existing = state.generationJobs.find((item) => item.id === job.id)
      const decision = generationJobPutDecision(existing, incoming, { observedAt: now() })
      if (!decision.changed) return clone(decision.job)
      return persistGenerationDecision(decision.job, { updateAgentRun, recordAudit })
    },

    claimGenerationJobExecution(jobId, claim) {
      const existing = state.generationJobs.find((item) => item.id === jobId)
      const decision = generationJobExecutionClaimDecision(existing, { ...clone(claim), observedAt: now() })
      if (decision.changed) persistGenerationDecision(decision.job, {
        updateAgentRun: false,
        recordAudit: false,
        syncArtifacts: false,
      })
      return clone(decision)
    },

    commitGenerationJobExecution(userId, command) {
      const existing = state.generationJobs.find((item) => item.id === command?.id)
      if (existing && existing.ownerId !== userId) return { kind: 'missing', changed: false }
      const decision = committedGenerationJobExecution(existing, { ...clone(command), observedAt: now() })
      if (decision.changed) persistGenerationDecision(decision.job, {
        updateAgentRun: command.updateAgentRun !== false,
        recordAudit: command.recordAudit !== false,
        syncArtifacts: false,
      })
      return clone(decision)
    },

    cancelGenerationJobExecution(userId, command) {
      const existing = state.generationJobs.find((item) => item.id === command?.id)
      if (existing && existing.ownerId !== userId) return { kind: 'missing', changed: false }
      const decision = requestedGenerationJobCancellation(existing, { ...clone(command), observedAt: now() })
      if (decision.changed) persistGenerationDecision(decision.job)
      return clone(decision)
    },

    acknowledgeGenerationJobCancellation(userId, command) {
      const existing = state.generationJobs.find((item) => item.id === command?.id)
      if (existing && existing.ownerId !== userId) return { kind: 'missing', changed: false }
      const decision = acknowledgedGenerationJobCancellation(existing, { ...clone(command), observedAt: now() })
      if (decision.changed) persistGenerationDecision(decision.job, {
        updateAgentRun: false,
        recordAudit: false,
        syncArtifacts: false,
      })
      return clone(decision)
    },

    compareAndSetGenerationJob(userId, command) {
      const existing = state.generationJobs.find((item) => item.id === command?.id)
      if (existing && existing.ownerId !== userId) return { kind: 'missing', changed: false }
      const decision = comparedAndSetGenerationJob(existing, { ...clone(command), observedAt: now() })
      if (decision.changed) persistGenerationDecision(decision.job, {
        updateAgentRun: command.updateAgentRun !== false,
        recordAudit: command.recordAudit !== false,
      })
      return clone(decision)
    },

    refreshGenerationArtifacts(userId, jobId) {
      const job = state.generationJobs.find((item) => item.id === jobId && item.ownerId === userId)
      if (!job) return false
      const project = state.projects.find((item) => item.id === job.projectId)
      if (!project || !canAccess(project, userId)) return false
      const report = refreshGenerationArtifactRecords(project, job, userId)
      save()
      return report
    },

    putAgentRun(userId, run) {
      const project = state.projects.find((item) => item.id === run.projectId)
      if (!project) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const payload = { ...clone(run), ownerId: userId, updatedAt: Number(run.updatedAt) || now() }
      const existing = state.agentRuns.find((item) => item.id === run.id)
      if (existing && (existing.projectId !== run.projectId || existing.ownerId !== userId)) {
        throw productError('Agent Run 标识已被其他项目使用。', 'AGENT_RUN_ID_CONFLICT')
      }
      const bindingDecision = idempotencyRequestBindingWriteDecision(existing, payload)
      if (bindingDecision.kind === 'conflict') {
        throw productError('Agent Run 幂等请求绑定冲突。', 'IDEMPOTENCY_BINDING_CONFLICT')
      }
      if (bindingDecision.binding) payload.idempotencyBinding = clone(bindingDecision.binding)
      if (existing && !shouldApplyAgentRunWrite(existing, payload)) return clone(existing)
      const storedPayload = existing ? mergeAgentRunForWrite(existing, payload) : payload
      if (existing) Object.assign(existing, storedPayload)
      else state.agentRuns.push(storedPayload)
      audit({ actorId: userId, action: `agent-run.${storedPayload.status}`, projectId: run.projectId, targetId: run.id })
      save()
      return clone(storedPayload)
    },

    readAgentRun(userId, runId) {
      const run = state.agentRuns.find((item) => item.id === runId)
      if (!run || run.ownerId !== userId) return undefined
      const project = state.projects.find((item) => item.id === run.projectId)
      return project && canAccess(project, userId) ? clone(run) : undefined
    },

    readAgentRunForWorker(runId) {
      const run = state.agentRuns.find((item) => item.id === runId)
      return run ? clone(run) : undefined
    },

    claimAgentBranchRetry(userId, command) {
      const project = state.projects.find((item) => item.id === command?.projectId)
      if (!project) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const existing = state.agentRuns.find((item) => item.id === command?.runId)
      if (existing && (existing.ownerId !== userId || existing.projectId !== command.projectId)) {
        return { kind: 'conflict', changed: false }
      }
      const existingJob = state.generationJobs.find((item) => item.id === command?.jobId)
      const observedAt = now()
      const jobDecision = agentBranchRetryJobDecision(existingJob, command, { ownerId: userId, observedAt })
      if (jobDecision.kind === 'conflict') {
        return clone({ kind: 'job_conflict', changed: false, run: existing, job: jobDecision.job })
      }
      const decision = agentBranchRetryClaimDecision(existing, {
        ...clone(command),
        observedAt,
      })
      if (['claimed', 'replay'].includes(decision.kind)) {
        if (decision.changed) Object.assign(existing, decision.run)
        if (jobDecision.changed) state.generationJobs.push(jobDecision.job)
      }
      if (decision.changed || (['claimed', 'replay'].includes(decision.kind) && jobDecision.changed)) {
        audit({ actorId: userId, action: 'agent-run.branch-retry-claimed', projectId: command.projectId, targetId: command.runId })
        save()
      }
      return clone({
        ...decision,
        changed: decision.changed || (['claimed', 'replay'].includes(decision.kind) && jobDecision.changed),
        ...(['claimed', 'replay'].includes(decision.kind) ? { job: jobDecision.job } : {}),
      })
    },

    listQueuedAgentRunsForRecovery(options = {}) {
      const { afterId, limit } = normalizeAgentEntityIdPage(options)
      return state.agentRuns
        .filter((run) => run.status === 'queued'
          && (afterId === null || run.id.localeCompare(afterId) > 0))
        .sort((left, right) => left.id.localeCompare(right.id))
        .slice(0, limit)
        .map(clone)
    },

    listAgentRunsForProject(userId, projectId, limit = 30) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, userId)) return undefined
      return state.agentRuns
        .filter((run) => run.ownerId === userId && run.projectId === projectId)
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, Math.max(1, Math.min(limit, 60)))
        .map(clone)
    },

    listAgentRunsForTurn(userId, projectId, turnId, limit = 20) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, userId)) return undefined
      return state.agentRuns
        .filter((run) => run.ownerId === userId && run.projectId === projectId && run.turnId === turnId)
        .sort((left, right) => left.createdAt - right.createdAt)
        .slice(0, Math.max(1, Math.min(limit, 60)))
        .map(clone)
    },

    listAgentRunsForTurnPage(userId, projectId, turnId, options = {}) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, userId)) return undefined
      const { afterId, limit } = normalizeAgentEntityIdPage(options)
      return state.agentRuns
        .filter((run) => run.ownerId === userId && run.projectId === projectId && run.turnId === turnId)
        .filter((run) => afterId === null || run.id.localeCompare(afterId) > 0)
        .sort((left, right) => left.id.localeCompare(right.id))
        .slice(0, limit)
        .map(clone)
    },

    claimAgentTurnExecution(userId, claim) {
      if (typeof claim?.leaseToken !== 'string' || !claim.leaseToken.trim() || !claim?.turn?.id) {
        throw productError('Agent Turn 执行租约无效。', 'AGENT_TURN_EXECUTION_INVALID')
      }
      const project = state.projects.find((item) => item.id === claim.turn.projectId)
      if (!project) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'read', 'PROJECT_READ_FORBIDDEN')
      const existing = state.agentTurns.find((item) => item.id === claim.turn.id)
      if (existing && (existing.projectId !== claim.turn.projectId || existing.ownerId !== userId)) {
        return { kind: 'conflict' }
      }
      const observedAt = now()
      const decision = agentTurnExecutionClaimDecision(existing, {
        ...clone(claim),
        turn: { ...clone(claim.turn), ownerId: userId, lastSequence: 0 },
        observedAt,
      })
      if (decision.changed) {
        if (existing) Object.assign(existing, decision.turn)
        else state.agentTurns.push(decision.turn)
        if (decision.kind === 'claimed') {
          audit({ actorId: userId, action: 'agent-turn.running', projectId: claim.turn.projectId, targetId: claim.turn.id })
        }
        save()
      }
      return clone({ kind: decision.kind, turn: decision.turn })
    },

    commitAgentTurnExecution(userId, command) {
      if (typeof command?.leaseToken !== 'string' || !command.leaseToken.trim()
        || !Number.isInteger(command?.executionGeneration) || command.executionGeneration < 1) {
        throw productError('Agent Turn 执行租约无效。', 'AGENT_TURN_EXECUTION_INVALID')
      }
      const existing = state.agentTurns.find((item) => item.id === command.id)
      if (!existing || existing.ownerId !== userId || existing.projectId !== command.projectId) {
        throw productError('未找到 Agent Turn。', 'AGENT_TURN_NOT_FOUND')
      }
      const decision = committedAgentTurnExecution(existing, { ...clone(command), observedAt: now() })
      let storedEvent
      if (['committed', 'replay'].includes(decision.kind) && command.event) {
        if (command.event.turnId !== existing.id || command.event.projectId !== existing.projectId) {
          throw productError('Agent Turn 事件身份无效。', 'AGENT_TURN_EXECUTION_INVALID')
        }
        storedEvent = state.agentTurnEvents.find((item) => item.id === command.event.id)
        if (storedEvent && (storedEvent.turnId !== existing.id || storedEvent.type !== command.event.type)) {
          throw productError('Agent Turn 事件标识冲突。', 'AGENT_TURN_EVENT_CONFLICT')
        }
        if (!storedEvent && decision.kind === 'committed') {
          const lastSequence = Math.max(
            Number(existing.lastSequence) || 0,
            ...state.agentTurnEvents.filter((item) => item.turnId === existing.id).map((item) => Number(item.sequence) || 0),
          )
          storedEvent = {
            ...clone(command.event),
            ownerId: userId,
            projectId: existing.projectId,
            sequence: lastSequence + 1,
            executionGeneration: command.executionGeneration,
          }
          state.agentTurnEvents.push(storedEvent)
          decision.turn.lastSequence = storedEvent.sequence
          existing.lastSequence = storedEvent.sequence
        }
      }
      if (decision.changed) {
        // commit decision 是整条 Turn replace 投影；先删缺失键，避免 terminal clear 被 Object.assign 遗留。
        for (const key of Object.keys(existing)) {
          if (!Object.hasOwn(decision.turn, key)) delete existing[key]
        }
        Object.assign(existing, decision.turn)
      }
      if (decision.changed || storedEvent) {
        if (decision.kind === 'committed' && ['completed', 'failed', 'cancelled'].includes(existing.status)) {
          audit({ actorId: userId, action: `agent-turn.${existing.status}`, projectId: existing.projectId, targetId: existing.id })
        }
        save()
      }
      return clone({ kind: decision.kind, turn: decision.turn, ...(storedEvent ? { event: storedEvent } : {}) })
    },

    requestAgentTurnCancellation(userId, request) {
      const existing = state.agentTurns.find((item) => item.id === request?.id)
      if (!existing || existing.ownerId !== userId || existing.projectId !== request?.projectId) {
        throw productError('未找到 Agent Turn。', 'AGENT_TURN_NOT_FOUND')
      }
      const project = state.projects.find((item) => item.id === existing.projectId)
      assertProjectPermission(project?.members.find((item) => item.userId === userId)?.role, 'read', 'PROJECT_READ_FORBIDDEN')
      const decision = requestedAgentTurnCancellation(existing, { ...clone(request), observedAt: now() })
      let storedEvent
      if (decision.kind === 'requested' && request.event) {
        if (request.event.turnId !== existing.id || request.event.projectId !== existing.projectId) {
          throw productError('Agent Turn 事件身份无效。', 'AGENT_TURN_EXECUTION_INVALID')
        }
        const list = state.agentTurnEvents.filter((item) => item.turnId === existing.id)
        storedEvent = state.agentTurnEvents.find((item) => item.id === request.event.id)
        if (!storedEvent) {
          storedEvent = {
            ...clone(request.event),
            ownerId: userId,
            sequence: Math.max(Number(existing.lastSequence) || 0, ...list.map((item) => Number(item.sequence) || 0), 0) + 1,
          }
          state.agentTurnEvents.push(storedEvent)
          decision.turn.lastSequence = storedEvent.sequence
        }
      }
      if (decision.changed) Object.assign(existing, decision.turn)
      if (decision.changed || storedEvent) save()
      return clone({ kind: decision.kind, turn: decision.turn, ...(storedEvent ? { event: storedEvent } : {}) })
    },

    finalizeAgentTurnCancellation(userId, command) {
      const existing = state.agentTurns.find((item) => item.id === command?.id)
      if (!existing || existing.ownerId !== userId || existing.projectId !== command?.projectId) {
        throw productError('未找到 Agent Turn。', 'AGENT_TURN_NOT_FOUND')
      }
      const decision = finalizedAgentTurnCancellation(existing, { ...clone(command), observedAt: now() })
      let storedEvent
      if (command?.event) {
        if (command.event.turnId !== existing.id || command.event.projectId !== existing.projectId
          || command.event.type !== 'turn.cancelled') {
          throw productError('Agent Turn 取消收口事件身份无效。', 'AGENT_TURN_EXECUTION_INVALID')
        }
        storedEvent = state.agentTurnEvents.find((item) => item.id === command.event.id)
        if (storedEvent && (storedEvent.turnId !== existing.id || storedEvent.projectId !== existing.projectId
          || storedEvent.type !== 'turn.cancelled')) {
          throw productError('Agent Turn 事件标识冲突。', 'AGENT_TURN_EVENT_CONFLICT')
        }
        if (!storedEvent && decision.kind === 'finalized') {
          const list = state.agentTurnEvents.filter((item) => item.turnId === existing.id)
          storedEvent = {
            ...clone(command.event),
            ownerId: userId,
            projectId: existing.projectId,
            sequence: Math.max(Number(existing.lastSequence) || 0, ...list.map((item) => Number(item.sequence) || 0), 0) + 1,
            executionGeneration: Number(existing.execution?.generation) || undefined,
            createdAt: decision.turn.updatedAt,
            payload: clone(decision.turn.error),
          }
          state.agentTurnEvents.push(storedEvent)
          decision.turn.lastSequence = storedEvent.sequence
        }
      } else if (decision.kind === 'finalized') {
        throw productError('Agent Turn 取消收口事件缺失。', 'AGENT_TURN_EXECUTION_INVALID')
      }
      if (decision.changed) {
        Object.assign(existing, decision.turn)
        audit({ actorId: userId, action: 'agent-turn.cancelled', projectId: existing.projectId, targetId: existing.id })
        save()
      }
      return clone({ kind: decision.kind, turn: decision.turn, ...(storedEvent ? { event: storedEvent } : {}) })
    },

    putAgentTurn(userId, turn) {
      const project = state.projects.find((item) => item.id === turn.projectId)
      if (!project) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'read', 'PROJECT_READ_FORBIDDEN')
      const existing = state.agentTurns.find((item) => item.id === turn.id)
      if (existing && (existing.projectId !== turn.projectId || existing.ownerId !== userId)) {
        throw productError('Agent Turn 标识已被其他项目使用。', 'AGENT_TURN_ID_CONFLICT')
      }
      if (existing?.execution) return clone(existing)
      const payload = { ...clone(turn), ownerId: userId, updatedAt: Number(turn.updatedAt) || now() }
      if (existing) Object.assign(existing, payload)
      else state.agentTurns.push(payload)
      audit({ actorId: userId, action: `agent-turn.${turn.status}`, projectId: turn.projectId, targetId: turn.id })
      save()
      return clone(payload)
    },

    readAgentTurn(userId, turnId) {
      const turn = state.agentTurns.find((item) => item.id === turnId && item.ownerId === userId)
      if (!turn) return undefined
      const project = state.projects.find((item) => item.id === turn.projectId)
      return project && canAccess(project, userId) ? clone(turn) : undefined
    },

    readAgentTurnForWorker(turnId) {
      const turn = state.agentTurns.find((item) => item.id === turnId)
      return turn ? clone(turn) : undefined
    },

    listAgentTurnsForProject(userId, projectId, limit = 30) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, userId)) return undefined
      return state.agentTurns
        .filter((turn) => turn.projectId === projectId && turn.ownerId === userId)
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, Math.max(1, Math.min(Number(limit) || 30, 100)))
        .map(clone)
    },

    appendAgentTurnEvent(userId, projectId, event) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'read', 'PROJECT_READ_FORBIDDEN')
      const turn = state.agentTurns.find((item) => item.id === event.turnId && item.projectId === projectId && item.ownerId === userId)
      if (!turn) throw productError('未找到 Agent Turn。', 'AGENT_TURN_NOT_FOUND')
      const existing = state.agentTurnEvents.find((item) => item.turnId === event.turnId && item.sequence === event.sequence)
      if (existing) return clone(existing)
      const payload = { ...clone(event), ownerId: userId, projectId }
      state.agentTurnEvents.push(payload)
      if (state.agentTurnEvents.length > 100_000) state.agentTurnEvents.splice(0, state.agentTurnEvents.length - 100_000)
      save()
      return clone(payload)
    },

    /**
     * `after` 是 `(turnId, sequence)` 游标：只返回该序号之后的事件，
     * 断线重连据此续读而不必重新拉全量。
     */
    listAgentTurnEvents(userId, projectId, turnId, options = {}) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, userId)) return undefined
      const { after, limit } = normalizeTurnEventPage(options)
      return state.agentTurnEvents
        .filter((event) => event.projectId === projectId && event.turnId === turnId && event.ownerId === userId)
        .filter((event) => after === null || Number(event.sequence) > after)
        .sort((left, right) => left.sequence - right.sequence)
        .slice(0, limit)
        .map(clone)
    },

    /**
     * 跨项目扫描超过租约未推进的非终态 Turn，供派生任务队列回收孤儿。
     * 不做成员校验：清扫是系统行为，没有发起它的用户（与 readAgentTurnForWorker 同理）。
     */
    listStaleAgentTurns(options = {}) {
      const { olderThan, after, limit } = normalizeStaleTurnQuery(options)
      const effectiveUpdatedAt = (turn) => Number(turn.updatedAt ?? turn.createdAt) || 0
      return state.agentTurns
        .filter((turn) => reclaimableAgentTurnStatuses.includes(turn.status)
          && effectiveUpdatedAt(turn) < olderThan)
        .filter((turn) => after === null
          || effectiveUpdatedAt(turn) > after.updatedAt
          || (effectiveUpdatedAt(turn) === after.updatedAt && turn.id.localeCompare(after.id) > 0))
        .sort((left, right) => effectiveUpdatedAt(left) - effectiveUpdatedAt(right)
          || left.id.localeCompare(right.id))
        .slice(0, limit)
        .map(clone)
    },

    enqueueAgentSubagentActivation(userId, command) {
      const project = state.projects.find((item) => item.id === command?.projectId)
      if (!project) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')

      let existingSubagent = command?.kind === 'followup'
        ? state.agentSubagents.find((item) => item.id === command?.subagentId)
        : undefined
      if (command?.kind === 'followup' && (!existingSubagent || existingSubagent.projectId !== command.projectId)) {
        return publicSubagentDecision({ kind: 'missing', subagent: undefined, activation: undefined, changed: false })
      }
      // 与 Turn 取消共用同一 Local Store 临界区。先读 durable fence 再入队，避免
      // 「取消已开始但新 activation 仍穿透」；取消随后按 rootTurnId 反查已先落库者。
      const rootTurnId = command?.kind === 'start' ? command?.rootTurnId : existingSubagent?.rootTurnId
      const rootOwnerId = existingSubagent?.ownerId ?? userId
      const rootTurn = state.agentTurns.find((item) => item.id === rootTurnId
        && item.projectId === command?.projectId && item.ownerId === rootOwnerId)
      if (!rootTurn) throw productError('Subagent 根 Turn 不存在。', 'AGENT_SUBAGENT_ROOT_TURN_NOT_FOUND')
      assertAgentSubagentRootTurnFence(rootTurn, command?.rootExecution)
      const preexistingActivation = existingSubagent
        ? state.agentSubagentActivations.find((item) => item.subagentId === existingSubagent.id
          && item.idempotencyKey === command?.idempotencyKey)
        : undefined
      const sequence = command?.kind === 'start'
        ? 1
        : preexistingActivation?.sequence ?? (Number(existingSubagent?.lastEnqueuedSequence) + 1)
      const materialized = materializeAgentSubagentEnqueueCommand(existingSubagent?.ownerId ?? userId, {
        ...clone(command),
        sequence,
        cancelGeneration: Number(existingSubagent?.cancelGeneration) || 0,
        observedAt: now(),
      })
      if (command?.kind === 'start') {
        existingSubagent = state.agentSubagents.find((item) => item.id === materialized.subagentId)
      }
      const existingActivation = state.agentSubagentActivations.find((item) => item.subagentId === materialized.subagentId
        && item.idempotencyKey === materialized.idempotencyKey)
      const existingTurn = existingActivation
        ? state.agentTurns.find((item) => item.id === existingActivation.turnId)
        : undefined
      const result = agentSubagentEnqueueDecision(existingSubagent, existingActivation, {
        ...materialized,
        existingTurn,
      })
      if (!result.changed) return publicSubagentDecision(result)

      if (state.agentSubagentActivations.some((item) => item.id === result.activation.id)) {
        throw productError('Subagent Activation 标识冲突。', 'AGENT_SUBAGENT_ACTIVATION_CONFLICT')
      }
      if (state.agentTurns.some((item) => item.id === result.turn.id)) {
        throw productError('Subagent Turn 标识冲突。', 'AGENT_TURN_ID_CONFLICT')
      }
      if (state.agentMessages.some((item) => item.id === result.inputMessage.id)) {
        throw productError('Subagent 输入消息标识冲突。', 'AGENT_MESSAGE_ID_CONFLICT')
      }
      if (result.session && state.agentSessions.some((item) => item.id === result.session.id)) {
        throw productError('Subagent 会话标识冲突。', 'AGENT_SESSION_ID_CONFLICT')
      }

      if (existingSubagent) Object.assign(existingSubagent, result.subagent)
      else state.agentSubagents.push(result.subagent)
      state.agentSubagentActivations.push(result.activation)
      state.agentTurns.push(result.turn)
      if (result.session) {
        state.agentSessions.push({
          id: result.session.id,
          projectId: result.subagent.projectId,
          ownerId: result.subagent.ownerId,
          updatedAt: result.session.updatedAt,
          payload: result.session,
        })
      }
      state.agentMessages.push({
        id: result.inputMessage.id,
        projectId: result.subagent.projectId,
        sessionId: result.subagent.sessionId,
        ownerId: result.subagent.ownerId,
        updatedAt: result.inputMessage.updatedAt,
        payload: result.inputMessage,
      })
      const session = state.agentSessions.find((item) => item.id === result.subagent.sessionId)
      if (session) {
        session.updatedAt = Math.max(Number(session.updatedAt) || 0, Number(result.inputMessage.updatedAt) || 0)
        session.payload.updatedAt = session.updatedAt
      }
      audit({
        actorId: userId,
        action: `agent-subagent.activation-${result.activation.kind}`,
        projectId: result.subagent.projectId,
        targetId: result.activation.id,
        detail: { subagentId: result.subagent.id, sequence: result.activation.sequence, turnId: result.turn.id },
      })
      save()
      return publicSubagentDecision(result)
    },

    claimAgentSubagentActivation(command) {
      const subagent = state.agentSubagents.find((item) => item.id === command?.subagentId)
      const headSequence = Number(subagent?.settledThroughSequence) + 1
      const activation = command?.activationId
        ? state.agentSubagentActivations.find((item) => item.id === command.activationId)
        : state.agentSubagentActivations.find((item) => item.subagentId === subagent?.id && item.sequence === headSequence)
      const result = agentSubagentActivationClaimDecision(subagent, activation, { ...clone(command), observedAt: now() })
      if (result.changed) {
        Object.assign(subagent, result.subagent)
        Object.assign(activation, result.activation)
        save()
      }
      const turn = activation ? state.agentTurns.find((item) => item.id === activation.turnId) : undefined
      return clone({ ...result, ...(turn ? { turn } : {}) })
    },

    settleAgentSubagentActivation(command) {
      const subagent = state.agentSubagents.find((item) => item.id === command?.subagentId)
      const activation = state.agentSubagentActivations.find((item) => item.id === command?.activationId)
      const turn = activation ? state.agentTurns.find((item) => item.id === activation.turnId) : undefined
      const result = agentSubagentActivationSettleDecision(subagent, activation, turn, {
        ...clone(command),
        observedAt: now(),
      })
      if (result.changed) {
        Object.assign(subagent, result.subagent)
        Object.assign(activation, result.activation)
        putSubagentResultMessage(subagent, result.resultMessage)
        audit({
          actorId: subagent.ownerId,
          action: `agent-subagent.activation-${activation.status}`,
          projectId: subagent.projectId,
          targetId: activation.id,
          detail: { subagentId: subagent.id, sequence: activation.sequence, turnId: turn.id },
        })
        save()
      }
      const currentSubagent = result.subagent ?? subagent
      const nextSequence = Number(currentSubagent?.settledThroughSequence) + 1
      const next = currentSubagent?.status === 'active'
        ? state.agentSubagentActivations.find((item) => item.subagentId === currentSubagent.id
          && item.sequence === nextSequence && item.status === 'queued')
        : undefined
      const nextTurn = next ? state.agentTurns.find((item) => item.id === next.turnId) : undefined
      return clone({
        ...result,
        ...(next && nextTurn ? { nextActivation: { activation: next, turn: nextTurn } } : {}),
      })
    },

    readAgentSubagent(userId, id) {
      const subagent = state.agentSubagents.find((item) => item.id === id)
      if (!subagent) return undefined
      const project = state.projects.find((item) => item.id === subagent.projectId)
      return project && canAccess(project, userId) ? publicAgentSubagent(subagent) : undefined
    },

    readAgentSubagentForWorker(id) {
      const subagent = state.agentSubagents.find((item) => item.id === id)
      return subagent ? clone(subagent) : undefined
    },

    listAgentSubagentsForRootTurnPage(userId, projectId, rootTurnId, options = {}) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, userId)) return undefined
      const { afterId, limit } = normalizeAgentEntityIdPage(options)
      return state.agentSubagents
        .filter((item) => item.projectId === projectId && item.rootTurnId === rootTurnId)
        .filter((item) => afterId === null || item.id.localeCompare(afterId) > 0)
        .sort((left, right) => left.id.localeCompare(right.id))
        .slice(0, limit)
        .map(publicAgentSubagent)
    },

    listAgentSubagentActivations(userId, id, options = {}) {
      const subagent = state.agentSubagents.find((item) => item.id === id)
      const project = subagent ? state.projects.find((item) => item.id === subagent.projectId) : undefined
      if (!subagent || !project || !canAccess(project, userId)) return undefined
      const { afterSequence, limit } = normalizeAgentSubagentActivationPage(options)
      return state.agentSubagentActivations
        .filter((item) => item.subagentId === id && item.sequence > afterSequence)
        .sort((left, right) => left.sequence - right.sequence)
        .slice(0, limit)
        .map(publicAgentSubagentActivation)
    },

    listAgentSubagentActivationsForWorker(id, options = {}) {
      if (!state.agentSubagents.some((item) => item.id === id)) return undefined
      const { afterSequence, limit } = normalizeAgentSubagentActivationPage(options)
      return state.agentSubagentActivations
        .filter((item) => item.subagentId === id && item.sequence > afterSequence)
        .sort((left, right) => left.sequence - right.sequence)
        .slice(0, limit)
        .map((activation) => ({
          activation: clone(activation),
          turn: clone(state.agentTurns.find((item) => item.id === activation.turnId)),
        }))
        .filter((entry) => entry.turn)
    },

    listRunnableAgentSubagents(options = {}) {
      const page = normalizeRunnableAgentSubagentPage(options)
      return state.agentSubagents
        .filter((subagent) => ['active', 'cancelling'].includes(subagent.status))
        .map((subagent) => {
          const sequence = Number(subagent.settledThroughSequence) + 1
          const activation = state.agentSubagentActivations.find((item) => item.subagentId === subagent.id
            && item.sequence === sequence)
          const runnable = subagent.status === 'cancelling'
            ? Boolean(activation)
            : activation?.status === 'queued'
              || (activation?.status === 'running' && Number(activation.execution?.leaseExpiresAt) <= page.now)
          const turn = runnable ? state.agentTurns.find((item) => item.id === activation.turnId) : undefined
          return runnable && turn ? { subagent, activation, turn } : undefined
        })
        .filter(Boolean)
        .filter((entry) => page.after === null
          || Number(entry.subagent.updatedAt) > page.after.updatedAt
          || (Number(entry.subagent.updatedAt) === page.after.updatedAt
            && entry.subagent.id.localeCompare(page.after.id) > 0))
        .sort((left, right) => Number(left.subagent.updatedAt) - Number(right.subagent.updatedAt)
          || left.subagent.id.localeCompare(right.subagent.id))
        .slice(0, page.limit)
        .map(clone)
    },

    requestAgentSubagentCancellation(userId, command) {
      const subagent = state.agentSubagents.find((item) => item.id === command?.subagentId
        && item.projectId === command?.projectId)
      const project = subagent ? state.projects.find((item) => item.id === subagent.projectId) : undefined
      if (project) {
        assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      }
      const headSequence = Number(subagent?.settledThroughSequence) + 1
      const activation = state.agentSubagentActivations.find((item) => item.subagentId === subagent?.id
        && item.sequence === headSequence)
      const result = agentSubagentCancellationRequestDecision(subagent, activation, {
        ...clone(command),
        observedAt: now(),
      })
      if (result.changed) {
        Object.assign(subagent, result.subagent)
        if (activation && result.activation) Object.assign(activation, result.activation)
        audit({
          actorId: userId,
          action: `agent-subagent.${subagent.status}`,
          projectId: subagent.projectId,
          targetId: subagent.id,
        })
        save()
      }
      return publicSubagentDecision(result)
    },

    finalizeAgentSubagentCancellation(userId, command) {
      const subagent = state.agentSubagents.find((item) => item.id === command?.subagentId
        && item.projectId === command?.projectId)
      const project = subagent ? state.projects.find((item) => item.id === subagent.projectId) : undefined
      if (project) {
        assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      }
      const activations = subagent
        ? state.agentSubagentActivations
          .filter((item) => item.subagentId === subagent.id
            && item.sequence > Number(subagent.settledThroughSequence))
        : []
      const turns = activations
        .map((activation) => state.agentTurns.find((item) => item.id === activation.turnId))
        .filter(Boolean)
      const result = agentSubagentCancellationFinalizeDecision(subagent, activations, turns, {
        ...clone(command),
        observedAt: now(),
      })
      if (result.changed) {
        Object.assign(subagent, result.subagent)
        for (const updated of result.activations) {
          const stored = state.agentSubagentActivations.find((item) => item.id === updated.id)
          if (stored) Object.assign(stored, updated)
        }
        for (const message of result.resultMessages) putSubagentResultMessage(subagent, message)
        audit({ actorId: userId, action: 'agent-subagent.cancelled', projectId: subagent.projectId, targetId: subagent.id })
        save()
      }
      return publicSubagentDecision(result)
    },

    listRunsWithFailedBranches(options = {}) {
      const { after, limit } = normalizeUpdatedAtIdRecoveryPage(options)
      const updatedAt = (run) => Number(run.updatedAt) || 0
      return state.agentRuns
        .filter((run) => ['partial', 'failed'].includes(run?.status)
          && (run.branches ?? []).some((branch) => branch?.status === 'failed'))
        .filter((run) => after === null
          || updatedAt(run) > after.updatedAt
          || (updatedAt(run) === after.updatedAt && run.id.localeCompare(after.id) > 0))
        .sort((left, right) => updatedAt(left) - updatedAt(right) || left.id.localeCompare(right.id))
        .slice(0, limit)
        .map((run) => ({
          id: run.id,
          runId: run.id,
          ownerId: run.ownerId,
          projectId: run.projectId,
          updatedAt: updatedAt(run),
        }))
    },

    listProjectsWithActiveWorkflowRuns({ limit = 25 } = {}) {
      const active = new Set(['queued', 'running'])
      return state.projects
        .filter((project) => (project.document?.productionWorkflowRuns ?? []).some((run) => active.has(run?.status)))
        .slice(0, Math.max(1, Math.min(limit, 200)))
        .map((project) => ({
          projectId: project.id,
          ownerId: project.members?.find((member) => member.role === 'owner')?.userId ?? project.ownerId,
        }))
        .filter((entry) => entry.ownerId)
    },

    putAgentReviewTask(userId, task) {
      const project = state.projects.find((item) => item.id === task.projectId)
      if (!project) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'read', 'PROJECT_READ_FORBIDDEN')
      const existing = state.agentReviewTasks.find((item) => item.id === task.id)
      if (existing && existing.projectId !== task.projectId) throw productError('评审任务标识已被其他项目使用。', 'AGENT_REVIEW_TASK_ID_CONFLICT')
      const decision = agentReviewTaskPutDecision(existing, {
        ...clone(task), ownerId: task.ownerId ?? userId,
      }, { observedAt: now() })
      if (decision.kind === 'conflict') throw productError('评审任务身份冲突。', 'AGENT_REVIEW_TASK_ID_CONFLICT')
      if (!decision.changed) return clone(decision.task)
      const payload = decision.task
      if (existing) Object.assign(existing, payload)
      else state.agentReviewTasks.push(payload)
      save()
      return clone(payload)
    },

    claimAgentReviewExecution(userId, command) {
      const existing = state.agentReviewTasks.find((item) => item.id === command?.id)
      if (existing && existing.ownerId !== userId) return { kind: 'missing', changed: false }
      const decision = agentReviewExecutionClaimDecision(existing, {
        ...clone(command), observedAt: now(),
      })
      if (decision.changed) {
        Object.assign(existing, decision.task)
        save()
      }
      return clone(decision)
    },

    commitAgentReviewExecution(userId, command) {
      const existing = state.agentReviewTasks.find((item) => item.id === command?.id)
      if (existing && existing.ownerId !== userId) return { kind: 'missing', changed: false }
      const decision = committedAgentReviewExecution(existing, {
        ...clone(command), observedAt: now(),
      })
      if (decision.changed) {
        Object.assign(existing, decision.task)
        save()
      }
      return clone(decision)
    },

    requestAgentReviewCancellation(userId, command) {
      const existing = state.agentReviewTasks.find((item) => item.id === command?.id)
      if (!existing) return { kind: 'missing', changed: false }
      const project = state.projects.find((item) => item.id === existing.projectId)
      if (!project || existing.projectId !== command?.projectId) {
        return { kind: 'missing', changed: false }
      }
      assertProjectPermission(
        project.members.find((item) => item.userId === userId)?.role,
        'edit',
        'PROJECT_WRITE_FORBIDDEN',
      )
      const decision = agentReviewCancellationRequestDecision(existing, {
        ...clone(command), requestedBy: userId, observedAt: now(),
      })
      if (decision.changed) {
        Object.assign(existing, decision.task)
        audit({
          actorId: userId,
          action: decision.task.status === 'cancelled'
            ? 'agent-review.cancelled'
            : 'agent-review.cancelling',
          projectId: existing.projectId,
          targetId: existing.id,
        })
        save()
      }
      return clone(decision)
    },

    finalizeAgentReviewCancellation(userId, command) {
      const existing = state.agentReviewTasks.find((item) => item.id === command?.id)
      if (!existing || existing.ownerId !== userId || existing.projectId !== command?.projectId) {
        return { kind: 'missing', changed: false }
      }
      const observedAt = now()
      const decision = agentReviewCancellationFinalizeDecision(existing, {
        ...clone(command),
        observedAt,
        proof: { ...clone(command?.proof), observedAt },
      })
      if (decision.changed) {
        Object.assign(existing, decision.task)
        audit({
          actorId: userId,
          action: 'agent-review.cancelled',
          projectId: existing.projectId,
          targetId: existing.id,
        })
        save()
      }
      return clone(decision)
    },

    resolveAgentReviewOutcomeUnknown(userId, command) {
      const existing = state.agentReviewTasks.find((item) => item.id === command?.id)
      if (!existing) return { kind: 'missing', changed: false }
      const project = state.projects.find((item) => item.id === existing.projectId)
      if (!project || existing.projectId !== command?.projectId) {
        return { kind: 'missing', changed: false }
      }
      assertProjectPermission(
        project.members.find((item) => item.userId === userId)?.role,
        'edit',
        'PROJECT_WRITE_FORBIDDEN',
      )
      if (command?.action === 'retry_once') {
        assertProjectPermission(
          project.members.find((item) => item.userId === userId)?.role,
          'create-generation',
          'PROJECT_WRITE_FORBIDDEN',
        )
      }
      const decision = agentReviewOutcomeReconciliationDecision(existing, {
        ...clone(command), actorId: userId, observedAt: now(),
      })
      if (decision.changed) {
        Object.assign(existing, decision.task)
        audit({
          actorId: userId,
          action: 'agent-review.reconciled',
          projectId: existing.projectId,
          targetId: existing.id,
          detail: { action: command.action, status: existing.status },
        })
        save()
      }
      return clone(decision)
    },

    commitAgentReviewHumanDecisions(userId, command) {
      const existing = state.agentReviewTasks.find((item) => item.id === command?.id)
      if (!existing) return { kind: 'missing', changed: false }
      const project = state.projects.find((item) => item.id === existing.projectId)
      if (!project) return { kind: 'missing', changed: false }
      const role = project.members.find((item) => item.userId === userId)?.role
      assertProjectPermission(
        role,
        'edit',
        'PROJECT_WRITE_FORBIDDEN',
      )
      const retryRunCandidates = Array.isArray(command?.retryRunCandidates)
        ? command.retryRunCandidates
        : []
      const requestedDecisions = Array.isArray(command?.decisions) ? command.decisions : []
      if (requestedDecisions.some((entry) => entry?.decision === 'retry_requested')
        || retryRunCandidates.length) {
        assertProjectPermission(role, 'create-generation', 'PROJECT_WRITE_FORBIDDEN')
      }
      const candidateRunIds = [...new Set(retryRunCandidates
        .map((candidate) => candidate?.run?.id)
        .filter((id) => typeof id === 'string' && id))]
        .sort()
      const existingRunsById = new Map(candidateRunIds.flatMap((runId) => {
        const run = state.agentRuns.find((item) => item.id === runId)
        return run ? [[runId, run]] : []
      }))
      const decision = agentReviewRetryMaterializationDecision(existing, {
        ...clone(command), actorId: userId, observedAt: now(),
      }, existingRunsById)
      if (decision.changed) {
        state.agentRuns.push(...decision.runsToInsert
          .slice()
          .sort((left, right) => left.id.localeCompare(right.id))
          .map(clone))
        Object.assign(existing, decision.task)
        save()
      }
      const { runsToInsert: _runsToInsert, retryRuns, ...outcome } = decision
      return clone({ ...outcome, retryRuns })
    },

    readAgentReviewTask(userId, taskId) {
      const task = state.agentReviewTasks.find((item) => item.id === taskId)
      if (!task) return undefined
      const project = state.projects.find((item) => item.id === task.projectId)
      return project && canAccess(project, userId) ? clone(task) : undefined
    },

    readAgentReviewTaskForWorker(taskId) {
      const task = state.agentReviewTasks.find((item) => item.id === taskId)
      return task ? clone(task) : undefined
    },

    listAgentReviewTasksForRun(userId, projectId, runId) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, userId)) return undefined
      return state.agentReviewTasks
        .filter((item) => item.projectId === projectId && item.runId === runId)
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map(clone)
    },

    // Worker 侧：跨项目扫描未收口的评审任务。清扫是系统行为，没有发起它的用户。
    listPendingAgentReviewTasks(options = {}) {
      const { olderThan, after, limit } = normalizePendingAgentReviewRecoveryPage(options)
      const updatedAt = (task) => Number(task.updatedAt) || 0
      return state.agentReviewTasks
        .filter((item) => ['queued', 'running', 'cancelling'].includes(item.status)
          && updatedAt(item) <= olderThan)
        .filter((item) => after === null
          || updatedAt(item) > after.updatedAt
          || (updatedAt(item) === after.updatedAt && item.id.localeCompare(after.id) > 0))
        .sort((left, right) => updatedAt(left) - updatedAt(right) || left.id.localeCompare(right.id))
        .slice(0, limit)
        .map(clone)
    },

    putAgentReview(userId, review) {
      const project = state.projects.find((item) => item.id === review.projectId)
      if (!project) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'read', 'PROJECT_READ_FORBIDDEN')
      const existing = state.agentReviews.find((item) => item.id === review.id)
      if (existing && (existing.projectId !== review.projectId || existing.ownerId !== userId)) throw productError('Agent 评审标识已被其他项目使用。', 'AGENT_REVIEW_ID_CONFLICT')
      const payload = { ...clone(review), ownerId: userId, updatedAt: Number(review.updatedAt) || now() }
      if (existing) Object.assign(existing, payload)
      else state.agentReviews.push(payload)
      audit({ actorId: userId, action: existing ? 'agent-review.updated' : 'agent-review.created', projectId: review.projectId, targetId: review.id })
      save()
      return clone(payload)
    },

    readAgentReview(userId, projectId, runId, locale = 'zh-CN') {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, userId)) return undefined
      const review = state.agentReviews.find((item) => item.projectId === projectId && item.runId === runId && item.locale === locale)
      return review && review.ownerId === userId ? clone(review) : undefined
    },

    listAgentReviewsForRun(userId, projectId, runId) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, userId)) return undefined
      return state.agentReviews.filter((item) => item.projectId === projectId && item.runId === runId && item.ownerId === userId).sort((left, right) => right.updatedAt - left.updatedAt).map(clone)
    },

    putAgentReviewDecision(userId, projectId, reviewId, decision, decisionNote = '') {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project) throw productError('未找到项目。', 'PROJECT_NOT_FOUND')
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'edit', 'PROJECT_WRITE_FORBIDDEN')
      const review = state.agentReviews.find((item) => item.id === reviewId && item.projectId === projectId)
      if (!review) throw productError('未找到 Agent 评审。', 'AGENT_REVIEW_NOT_FOUND')
      if (!['pending', 'accepted', 'rejected', 'retry_requested'].includes(decision)) throw productError('评审决策无效。', 'AGENT_REVIEW_DECISION_INVALID')
      Object.assign(review, { status: decision, decisionNote: String(decisionNote ?? '').slice(0, 500), decidedBy: userId, updatedAt: now() })
      audit({ actorId: userId, action: `agent-review.${decision}`, projectId, targetId: reviewId })
      save()
      return clone(review)
    },

    readGenerationJob(userId, jobId) {
      const job = state.generationJobs.find((item) => item.id === jobId)
      return job && job.ownerId === userId ? clone(job) : undefined
    },

    listGenerationJobsForProject(userId, projectId, limit = 60) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, userId)) return undefined
      return state.generationJobs
        .filter((job) => job.ownerId === userId && job.projectId === projectId)
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, Math.max(1, Math.min(limit, 120)))
        .map(clone)
    },

    listGenerationJobsForAgentRunPage(userId, projectId, runId, options = {}) {
      const project = state.projects.find((item) => item.id === projectId)
      if (!project || !canAccess(project, userId)) return undefined
      const { afterId, limit } = normalizeAgentEntityIdPage(options)
      return state.generationJobs
        .filter((job) => job.ownerId === userId && job.projectId === projectId
          && job.agentRun?.runId === runId
          && (afterId === null || job.id.localeCompare(afterId) > 0))
        .sort((left, right) => left.id.localeCompare(right.id))
        .slice(0, limit)
        .map(clone)
    },

    // 仅显式本地原型队列使用；生产 Worker 使用 PostgreSQL Adapter 的同名方法。
    readGenerationJobForWorker(jobId) {
      const job = state.generationJobs.find((item) => item.id === jobId)
      return job ? clone(job) : undefined
    },

    listRecoverableGenerationJobs(options = {}) {
      const { after, limit } = normalizeUpdatedAtIdRecoveryPage(options)
      const updatedAt = (job) => Number(job.updatedAt) || 0
      return state.generationJobs
        .filter((job) => job.status === 'queued' || job.projectWritebackPending)
        .filter((job) => after === null
          || updatedAt(job) > after.updatedAt
          || (updatedAt(job) === after.updatedAt && job.id.localeCompare(after.id) > 0))
        .sort((left, right) => updatedAt(left) - updatedAt(right) || left.id.localeCompare(right.id))
        .slice(0, limit)
        .map(clone)
    },

    recoverGenerationJobs() {
      return state.generationJobs
        .filter((job) => job.status === 'queued' || job.projectWritebackPending)
        .map(clone)
    },

    recoverStaleGenerationJobs(staleAfterMs = 90_000) {
      const observedAt = now()
      const staleBefore = observedAt - Math.max(30_000, staleAfterMs)
      return state.generationJobs
        .filter((job) => job.status === 'running'
          && (job.execution
            ? Number(job.execution.leaseExpiresAt) <= observedAt
            : Number(job.updatedAt) <= staleBefore))
        .map(clone)
    },

    listAuditEvents(userId, projectId, limit = 100) {
      if (!projectId) throw productError('项目审计必须指定项目。', 'PROJECT_AUDIT_FORBIDDEN')
      const project = state.projects.find((item) => item.id === projectId)
      if (!project) return undefined
      assertProjectPermission(project.members.find((item) => item.userId === userId)?.role, 'read-audit', 'PROJECT_AUDIT_FORBIDDEN')
      return state.auditEvents
        .filter((event) => !projectId || event.projectId === projectId)
        .slice(-Math.max(1, Math.min(limit, 500)))
        .reverse()
        .map(clone)
    },

    listWorkspaceAuditEvents(userId, limit = 100) {
      const user = state.users.find((item) => item.id === userId)
      assertWorkspacePermission(user, 'read-audit', 'WORKSPACE_AUDIT_FORBIDDEN')
      return state.auditEvents
        .slice(-Math.max(1, Math.min(limit, 500)))
        .reverse()
        .map(clone)
    },

    recordSecurityAuditEvent(userId, action, detail = {}) {
      const user = state.users.find((item) => item.id === userId)
      if (!user || user.status === 'disabled') throw productError('登录状态无效。', 'AUTH_REQUIRED')
      const event = audit({ actorId: userId, action, detail })
      save()
      return clone(event)
    },
  }
}

function loadState(path) {
  if (!existsSync(path)) return initialState()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || parsed.schemaVersion !== schemaVersion) throw new Error('schema mismatch')
    return {
      ...initialState(),
      ...parsed,
      users: Array.isArray(parsed.users)
        ? parsed.users.map((user) => ({ ...user, status: user.status ?? 'active' }))
        : [],
    }
  } catch {
    throw new Error(`无法读取产品数据文件：${path}`)
  }
}

function persist(path, state) {
  const temporaryPath = `${path}.${process.pid}.tmp`
  writeFileSync(temporaryPath, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
  renameSync(temporaryPath, path)
}

function ensureBootstrapUser(state, accessToken, email) {
  const tokenHash = hashAccessToken(accessToken)
  if (state.accessTokens.some((item) => item.tokenHash === tokenHash && !item.revokedAt)) return
  let owner = state.users.find((item) => item.role === 'owner')
  if (!owner) {
    owner = { id: `usr_${randomUUID()}`, email, name: 'Botanic Owner', role: 'owner', status: 'active', createdAt: now() }
    state.users.push(owner)
  }
  state.accessTokens.push({ id: `token_${randomUUID()}`, userId: owner.id, tokenHash, createdAt: now() })
}
