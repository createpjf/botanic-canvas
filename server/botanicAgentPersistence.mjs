const SESSION_LIMIT = 80
const MESSAGE_LIMIT = 500
const MEMORY_LIMIT = 30

const sessionModes = new Set(['manual', 'auto'])
const messageRoles = new Set(['user', 'assistant'])
const messageKinds = new Set(['text', 'question', 'plan', 'run', 'notice'])
const messageStatuses = new Set(['pending', 'answered', 'submitted', 'failed'])
const feedbackValues = new Set(['positive', 'negative'])
const memoryKinds = new Set(['rule', 'approved', 'avoid'])
const runStatuses = new Set(['awaiting_confirmation', 'queued', 'executing', 'running', 'completed', 'partial', 'failed', 'cancelled'])

const clone = (value) => structuredClone(value)

function invalid(message, code = 'INVALID_AGENT_ENTITY') {
  const error = new TypeError(message)
  error.code = code
  throw error
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${name}格式无效。`)
  return value
}

function text(value, name, maximumLength) {
  if (typeof value !== 'string' || !value.trim()) invalid(`${name}不能为空。`)
  const result = value.trim()
  if (result.length > maximumLength) invalid(`${name}过长。`)
  return result
}

function timestamp(value, fallback) {
  return Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : fallback
}

export function validateAgentEntityWriteTimestamp(value, { now = Date.now(), maximumFutureSkewMs = 5 * 60_000 } = {}) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > now + maximumFutureSkewMs) {
    invalid('Agent 实体时间戳无效。')
  }
  return value
}

function uniqueTextList(value, name, maximumItems, maximumLength = 160) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maximumItems) invalid(`${name}格式无效。`)
  return [...new Set(value.map((item) => text(item, name, maximumLength)))]
}

function newerById(items) {
  const byId = new Map()
  for (const item of items) {
    if (!item?.id) continue
    const existing = byId.get(item.id)
    if (!existing || Number(item.updatedAt ?? item.createdAt ?? 0) >= Number(existing.updatedAt ?? existing.createdAt ?? 0)) {
      byId.set(item.id, item)
    }
  }
  return byId
}

function comparableTimestamp(value) {
  if (typeof value === 'string') {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return Number.isFinite(Number(value)) ? Number(value) : 0
}

/**
 * 独立实体的 LWW 规则。Postgres SQL 与 Supabase Adapter 必须同步此语义：
 * 新时间戳覆盖旧值；普通实体同时刻允许幂等回放；Memory 墓碑永久胜出，
 * 显式重建必须使用新的实体 ID，避免旧设备或时钟漂移复活已删除数据。
 */
export function shouldApplyAgentEntityWrite(existing, incoming, { tombstoneWinsTie = false } = {}) {
  if (!existing) return true
  if (tombstoneWinsTie && (existing.deletedAt ?? existing.deleted_at)) return false
  const existingTimestamp = comparableTimestamp(existing.updatedAt ?? existing.updated_at)
  const incomingTimestamp = comparableTimestamp(incoming?.updatedAt ?? incoming?.updated_at)
  if (incomingTimestamp > existingTimestamp) return true
  if (incomingTimestamp < existingTimestamp) return false
  return true
}

export function validateAgentSessionEntity(value, { now = Date.now() } = {}) {
  const session = object(value, 'Agent 会话')
  const executionMode = session.executionMode ?? 'manual'
  if (!sessionModes.has(executionMode)) invalid('Agent 会话执行模式无效。')
  const createdAt = timestamp(session.createdAt, now)
  const updatedAt = Math.max(createdAt, timestamp(session.updatedAt, now))
  return {
    id: text(session.id, 'Agent 会话标识', 160),
    title: text(session.title || '新建对话', 'Agent 会话标题', 160),
    executionMode,
    contextNodeIds: uniqueTextList(session.contextNodeIds, 'Agent 上下文节点', 32),
    createdAt,
    updatedAt,
  }
}

export function validateAgentMessageEntity(value, { now = Date.now() } = {}) {
  const message = object(value, 'Agent 消息')
  if (!messageRoles.has(message.role)) invalid('Agent 消息角色无效。')
  if (!messageKinds.has(message.kind)) invalid('Agent 消息类型无效。')
  if (message.status !== undefined && !messageStatuses.has(message.status)) invalid('Agent 消息状态无效。')
  if (message.feedback !== undefined && !feedbackValues.has(message.feedback)) invalid('Agent 消息反馈无效。')
  if (typeof message.content !== 'string' || message.content.length > 64_000) invalid('Agent 消息内容无效或过长。')
  const createdAt = timestamp(message.createdAt, now)
  const result = {
    id: text(message.id, 'Agent 消息标识', 160),
    role: message.role,
    kind: message.kind,
    content: message.content,
    createdAt,
    updatedAt: Math.max(createdAt, timestamp(message.updatedAt, createdAt)),
  }
  if (message.plan !== undefined) result.plan = clone(object(message.plan, 'Agent 计划'))
  if (message.question !== undefined) result.question = clone(object(message.question, 'Agent 追问'))
  if (message.runId !== undefined) result.runId = text(message.runId, 'Agent Run 标识', 160)
  if (message.status !== undefined) result.status = message.status
  if (message.feedback !== undefined) result.feedback = message.feedback
  return result
}

export function validateAgentMemoryEntity(value, { now = Date.now() } = {}) {
  const memory = object(value, 'Agent 记忆')
  if (!memoryKinds.has(memory.kind)) invalid('Agent 记忆类型无效。')
  const createdAt = timestamp(memory.createdAt, now)
  return {
    id: text(memory.id, 'Agent 记忆标识', 160),
    kind: memory.kind,
    content: text(memory.content, 'Agent 记忆内容', 1000).replace(/\s+/g, ' '),
    sourceNodeIds: uniqueTextList(memory.sourceNodeIds, 'Agent 记忆来源节点', 12),
    createdAt,
    updatedAt: Math.max(createdAt, timestamp(memory.updatedAt, now)),
  }
}

export function agentStateFromDocument(document, { now = Date.now() } = {}) {
  const sessions = []
  const messages = []
  for (const rawSession of Array.isArray(document?.agentSessions) ? document.agentSessions.slice(0, SESSION_LIMIT) : []) {
    const session = validateAgentSessionEntity(rawSession, { now })
    sessions.push(session)
    for (const rawMessage of Array.isArray(rawSession?.messages) ? rawSession.messages.slice(-MESSAGE_LIMIT) : []) {
      const message = validateAgentMessageEntity(rawMessage, { now })
      messages.push({
        sessionId: session.id,
        updatedAt: message.updatedAt,
        message,
      })
    }
  }
  const memory = (Array.isArray(document?.agentMemory) ? document.agentMemory : [])
    .slice(0, MEMORY_LIMIT)
    .map((item) => validateAgentMemoryEntity(item, { now }))
  const runs = (Array.isArray(document?.agentRuns) ? document.agentRuns : [])
    .filter((run) => run?.id)
    .map((run) => ({
      ...clone(run),
      status: runStatuses.has(run.status) ? run.status : 'awaiting_confirmation',
    }))
  return { sessions, messages, memory, runs }
}

export function mergeAgentStateIntoDocument(document, state = {}) {
  const legacySessions = Array.isArray(document?.agentSessions) ? document.agentSessions : []
  const sessionById = newerById([
    ...legacySessions.map((session) => ({ ...clone(session), messages: undefined })),
    ...(Array.isArray(state.sessions) ? state.sessions.map(clone) : []),
  ])
  const legacyMessages = legacySessions.flatMap((session) =>
    (Array.isArray(session?.messages) ? session.messages : []).map((message) => ({
      sessionId: session.id,
      message: clone(message),
      updatedAt: Number(message?.updatedAt ?? message?.createdAt ?? 0),
    })),
  )
  const messageBySession = new Map()
  for (const entry of [...legacyMessages, ...(Array.isArray(state.messages) ? state.messages.map(clone) : [])]) {
    if (!entry?.sessionId || !entry?.message?.id || !sessionById.has(entry.sessionId)) continue
    const messages = messageBySession.get(entry.sessionId) ?? new Map()
    const existing = messages.get(entry.message.id)
    if (!existing || Number(entry.updatedAt ?? entry.message.createdAt ?? 0) >= Number(existing.updatedAt ?? existing.message.createdAt ?? 0)) {
      messages.set(entry.message.id, entry)
    }
    messageBySession.set(entry.sessionId, messages)
  }
  const sessions = [...sessionById.values()]
    .map((session) => ({
      ...session,
      messages: [...(messageBySession.get(session.id)?.values() ?? [])]
        .map((entry) => entry.message)
        .sort((left, right) => Number(left.createdAt ?? 0) - Number(right.createdAt ?? 0)),
    }))
    .sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0))
    .slice(0, SESSION_LIMIT)

  const deletedMemoryIds = new Set(Array.isArray(state.deletedMemoryIds) ? state.deletedMemoryIds : [])
  const memoryById = newerById([
    ...(Array.isArray(document?.agentMemory) ? document.agentMemory.map(clone) : []),
    ...(Array.isArray(state.memory) ? state.memory.map(clone) : []),
  ])
  for (const id of deletedMemoryIds) memoryById.delete(id)
  const memory = [...memoryById.values()]
    .sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0))
    .slice(0, MEMORY_LIMIT)

  const legacyRuns = Array.isArray(document?.agentRuns) ? document.agentRuns.map(clone) : []
  const runById = newerById(legacyRuns)
  for (const entityRun of Array.isArray(state.runs) ? state.runs.map(clone) : []) {
    const legacyRun = runById.get(entityRun.id)
    if (!legacyRun) {
      runById.set(entityRun.id, entityRun)
      continue
    }
    if (Number(entityRun.updatedAt ?? 0) < Number(legacyRun.updatedAt ?? 0)) continue
    // 服务端 Run 为安全执行快照，可能刻意省略 rootRecipe/references；兼容文档中的
    // 完整计划仍用于画布恢复，但状态、分支和错误以独立实体为准。
    runById.set(entityRun.id, legacyRun?.plan?.rootRecipe
      ? { ...legacyRun, ...entityRun, plan: legacyRun.plan }
      : entityRun)
  }
  const runs = [...runById.values()].sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0))
  const activeAgentSessionId = sessions.some((session) => session.id === document?.activeAgentSessionId)
    ? document.activeAgentSessionId
    : sessions[0]?.id

  return {
    ...clone(document),
    agentSessions: sessions,
    agentMemory: memory,
    agentRuns: runs,
    ...(activeAgentSessionId ? { activeAgentSessionId } : { activeAgentSessionId: undefined }),
  }
}

export const agentEntityLimits = Object.freeze({
  sessions: SESSION_LIMIT,
  messagesPerSession: MESSAGE_LIMIT,
  memory: MEMORY_LIMIT,
})
