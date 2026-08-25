import { MEMORY_SUBJECTS } from './botanicAgentMemory.mjs'
import { createHash } from 'node:crypto'

const SESSION_LIMIT = 80
const MESSAGE_LIMIT = 500
const MEMORY_LIMIT = 30

const sessionModes = new Set(['manual', 'auto'])

/**
 * 计划是被原样持久化的，因此这里是原始推理进入项目记录的最后一道闸。
 * 提供方推理只允许随当轮响应下发用于实时展示，任何路径都不得把它写进会话消息。
 */
function persistedAgentPlan(rawPlan) {
  const { reasoning, ...plan } = clone(object(rawPlan, 'Agent 计划'))
  void reasoning
  return plan
}

/**
 * 方案消息只持久化主题与条目文本；不接收图片、媒体 URL 或提供方推理。
 * 归一化语义与 src/domain/agentCreativeComposition.ts 一致。
 */
function persistedAgentComposition(raw) {
  const composition = object(raw, 'Agent 成套方案')
  if (!Array.isArray(composition.items)) invalid('Agent 成套方案无效。')
  const items = []
  for (const item of composition.items.slice(0, 8)) {
    if (!item || typeof item !== 'object') continue
    const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : ''
    if (!prompt) continue
    const mediaKind = item.mediaKind === 'video' ? 'video' : 'image'
    const parsedCount = Number(item.count)
    const parsedDuration = Number(item.duration)
    const title = typeof item.title === 'string' && item.title.trim() ? item.title.trim() : `第 ${items.length + 1} 项`
    const purpose = typeof item.purpose === 'string' && item.purpose.trim() ? item.purpose.trim() : ''
    items.push({
      index: items.length + 1,
      title: title.slice(0, 80),
      ...(purpose ? { purpose: purpose.slice(0, 200) } : {}),
      mediaKind,
      prompt: prompt.slice(0, 6000),
      count: mediaKind === 'video'
        ? 1
        : Number.isFinite(parsedCount) ? Math.min(4, Math.max(1, Math.floor(parsedCount))) : 1,
      ...(mediaKind === 'video'
        ? { duration: [5, 10, 15].includes(parsedDuration) ? parsedDuration : 5 }
        : {}),
    })
  }
  if (items.length < 2) invalid('Agent 成套方案至少要有 2 个条目。')
  return {
    theme: text(composition.theme, '方案主题', 200),
    items,
  }
}
const messageRoles = new Set(['user', 'assistant'])
const messageKinds = new Set(['text', 'question', 'plan', 'run', 'notice', 'composition'])
const messageStatuses = new Set(['pending', 'answered', 'submitted', 'failed'])
const feedbackValues = new Set(['positive', 'negative'])
const reviewStatuses = new Set(['pending', 'accepted', 'rejected', 'retry_requested'])
const mentionKinds = new Set(['skill', 'reference'])
const MENTION_LIMIT = 24

/**
 * 消息引用只落 id + 展示名；图片字节/URL 由画布现况回填，不进消息实体。
 */
function persistAgentMentions(value) {
  if (!Array.isArray(value) || value.length > MENTION_LIMIT) invalid('Agent 消息引用格式无效。')
  const mentions = []
  const seen = new Set()
  for (const [index, item] of value.entries()) {
    const mention = object(item, `Agent 消息引用 ${index + 1}`)
    if (!mentionKinds.has(mention.kind)) invalid('Agent 消息引用类型无效。')
    const id = text(mention.id, `Agent 消息引用 ${index + 1}`, 160)
    const key = `${mention.kind}:${id}`
    if (seen.has(key)) continue
    seen.add(key)
    if (mention.kind === 'skill') {
      mentions.push({ kind: 'skill', id, name: text(mention.name, `Agent 消息 Skill 名称 ${index + 1}`, 80) })
      continue
    }
    mentions.push({ kind: 'reference', id, label: text(mention.label, `Agent 消息素材名称 ${index + 1}`, 80) })
  }
  return mentions
}

function persistedAgentReview(raw) {
  const review = object(raw, 'Agent 评审')
  if (!Array.isArray(review.items) || review.items.length > 20) invalid('Agent 评审条目无效。')
  const items = review.items.map((item, index) => {
    const entry = object(item, `Agent 评审条目 ${index + 1}`)
    if (!['pass', 'adjust'].includes(entry.verdict)) invalid('Agent 评审结论无效。')
    return {
      nodeId: text(entry.nodeId, `Agent 评审结果节点 ${index + 1}`, 160),
      branchLabel: text(entry.branchLabel, `Agent 评审分支 ${index + 1}`, 160),
      verdict: entry.verdict,
      note: typeof entry.note === 'string' ? entry.note.trim().slice(0, 240) : '',
    }
  })
  const result = {
    summary: text(review.summary, 'Agent 评审总结', 400),
    items,
  }
  if (review.bestNodeId !== undefined) result.bestNodeId = text(review.bestNodeId, 'Agent 评审推荐结果', 160)
  if (review.id !== undefined) result.id = text(review.id, 'Agent 评审标识', 160)
  if (review.version !== undefined && Number(review.version) !== 2) invalid('Agent 评审版本无效。')
  if (review.version !== undefined) result.version = 2
  if (review.runId !== undefined) result.runId = text(review.runId, 'Agent 评审 Run', 160)
  if (review.projectId !== undefined) result.projectId = text(review.projectId, 'Agent 评审项目', 160)
  if (review.locale !== undefined && !['zh-CN', 'en'].includes(review.locale)) invalid('Agent 评审语言无效。')
  if (review.locale !== undefined) result.locale = review.locale
  if (review.status !== undefined && !reviewStatuses.has(review.status)) invalid('Agent 评审状态无效。')
  if (review.status !== undefined) result.status = review.status
  if (review.requiredCriteria !== undefined) result.requiredCriteria = uniqueTextList(review.requiredCriteria, 'Agent 评审标准', 20, 80)
  if (review.decisionNote !== undefined) result.decisionNote = String(review.decisionNote).slice(0, 500)
  if (review.decidedBy !== undefined) result.decidedBy = text(review.decidedBy, 'Agent 评审操作者', 160)
  if (review.createdAt !== undefined) result.createdAt = timestamp(review.createdAt, Date.now())
  if (review.updatedAt !== undefined) result.updatedAt = timestamp(review.updatedAt, result.createdAt ?? Date.now())
  return result
}
const memoryKinds = new Set(['rule', 'approved', 'avoid'])
const memoryScopes = new Set(['project', 'workspace', 'run'])
const memorySources = new Set(['human', 'review', 'conversation', 'import'])
const memoryConfidences = new Set(['confirmed', 'provisional'])
/**
 * 激活态。与 `confidence`（可信程度）是两个概念，不能互相顶替（ADR 0006）：
 * 「未确认但很可信」是 `status: 'proposed'` + `confidence: 'confirmed'`。
 */
const memoryStatuses = new Set(['proposed', 'active', 'superseded', 'deleted'])
/** 证据来源。active 规则必须有人工来源或至少一条已确认证据。 */
const memoryEvidenceKinds = new Set(['artifact', 'review', 'message', 'human'])
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

/**
 * Agent Run 的显式实体写入规则。独立 Run 一旦进入执行态，迟到的兼容文档
 * 不得把它回退到待确认；其余状态迁移仍遵守统一 LWW 语义。
 */
export function shouldApplyAgentRunWrite(existing, incoming) {
  if (!existing) return true
  const existingStatus = existing.status ?? existing.payload?.status
  const incomingStatus = incoming?.status ?? incoming?.payload?.status
  if (existingStatus !== 'awaiting_confirmation' && incomingStatus === 'awaiting_confirmation') return false
  return shouldApplyAgentEntityWrite(existing, incoming)
}

export function validateAgentSessionEntity(value, { now = Date.now() } = {}) {
  const session = object(value, 'Agent 会话')
  const executionMode = session.executionMode ?? 'manual'
  if (!sessionModes.has(executionMode)) invalid('Agent 会话执行模式无效。')
  const createdAt = timestamp(session.createdAt, now)
  const updatedAt = Math.max(createdAt, timestamp(session.updatedAt, now))
  const result = {
    id: text(session.id, 'Agent 会话标识', 160),
    title: text(session.title || '新建对话', 'Agent 会话标题', 160),
    executionMode,
    contextNodeIds: uniqueTextList(session.contextNodeIds, 'Agent 上下文节点', 32),
    createdAt,
    updatedAt,
  }
  if (session.plannerModel !== undefined) result.plannerModel = text(session.plannerModel, 'Agent 模型', 160)
  if (session.mountedSkillIds !== undefined) result.mountedSkillIds = uniqueTextList(session.mountedSkillIds, 'Agent 已挂载 Skill', 16)
  if (session.readingAnchorMessageId !== undefined) {
    result.readingAnchorMessageId = text(session.readingAnchorMessageId, 'Agent 阅读位置', 160)
    result.readingAnchorUpdatedAt = Math.min(updatedAt, timestamp(session.readingAnchorUpdatedAt, updatedAt))
  }
  // 线程摘要检查点（Epic 8）。它是服务端确定性派生的，因此这里只做形状与边界校验，
  // 不接受客户端提交任意内容 —— 摘要会长期进模型上下文，客户端可写等于可注入。
  if (session.threadSummary !== undefined) {
    const summary = object(session.threadSummary, 'Agent 线程摘要')
    result.threadSummary = {
      version: 1,
      goals: uniqueTextList(summary.goals, '线程目标', 3),
      decisions: (Array.isArray(summary.decisions) ? summary.decisions : []).slice(0, 12).map((entry) => ({
        messageId: text(entry?.messageId, '决策消息标识', 160),
        ...(entry?.intent ? { intent: text(entry.intent, '决策意图', 80) } : {}),
        summary: text(entry?.summary ?? '(无摘要)', '决策摘要', 400),
        ...(entry?.runId ? { runId: text(entry.runId, '决策 Run', 160) } : {}),
        ...(Number.isInteger(entry?.outputCount) ? { outputCount: entry.outputCount } : {}),
        ...(entry?.decidedAt === undefined ? {} : { decidedAt: timestamp(entry.decidedAt, updatedAt) }),
      })),
      constraints: uniqueTextList(summary.constraints, '线程约束', 16),
      openQuestions: (Array.isArray(summary.openQuestions) ? summary.openQuestions : []).slice(0, 8).map((entry) => ({
        messageId: text(entry?.messageId, '追问消息标识', 160),
        question: text(entry?.question ?? '(无内容)', '追问内容', 400),
      })),
      entityIds: uniqueTextList(summary.entityIds, '线程实体', 40),
      coveredMessageIds: uniqueTextList(summary.coveredMessageIds, '已覆盖消息', 200),
      coveredThrough: timestamp(summary.coveredThrough, updatedAt),
      updatedAt: timestamp(summary.updatedAt, updatedAt),
    }
  }
  return result
}

/**
 * 阅读回执属于“成员 × 项目 × 会话”，不是共享 Session 的内容。
 * Adapter 只持久化这个最小实体，读取时再投影成 UI 兼容的 readingAnchor 字段。
 */
export function validateAgentSessionReadReceipt(value, { now = Date.now() } = {}) {
  const receipt = object(value, 'Agent 阅读回执')
  return {
    sessionId: text(receipt.sessionId, 'Agent 会话标识', 160),
    messageId: text(receipt.messageId, 'Agent 阅读位置', 160),
    updatedAt: validateAgentEntityWriteTimestamp(receipt.updatedAt, { now }),
  }
}

export function applyAgentSessionReadReceipts(sessions, receipts = []) {
  const receiptBySessionId = new Map(receipts.map((receipt) => [receipt.sessionId, receipt]))
  return sessions.map((session) => {
    const { readingAnchorMessageId: _legacyMessageId, readingAnchorUpdatedAt: _legacyUpdatedAt, ...shared } = session
    const receipt = receiptBySessionId.get(session.id)
    return receipt ? {
      ...shared,
      readingAnchorMessageId: receipt.messageId,
      readingAnchorUpdatedAt: receipt.updatedAt,
    } : shared
  })
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
  if (message.prompt !== undefined) result.prompt = text(message.prompt, 'Agent Prompt', 12_000)
  if (message.mentions !== undefined) {
    const mentions = persistAgentMentions(message.mentions)
    if (mentions.length) result.mentions = mentions
  }
  if (message.plan !== undefined) result.plan = persistedAgentPlan(message.plan)
  if (message.question !== undefined) result.question = clone(object(message.question, 'Agent 追问'))
  if (message.kind === 'composition' || message.composition !== undefined) {
    if (message.composition === undefined) invalid('方案消息必须包含成套方案。')
    result.composition = persistedAgentComposition(message.composition)
  }
  if (message.runId !== undefined) result.runId = text(message.runId, 'Agent Run 标识', 160)
  if (message.status !== undefined) result.status = message.status
  if (message.feedback !== undefined) result.feedback = message.feedback
  if (message.review !== undefined) result.review = persistedAgentReview(message.review)
  return result
}

export function validateAgentMemoryEntity(value, { now = Date.now() } = {}) {
  const memory = object(value, 'Agent 记忆')
  if (!memoryKinds.has(memory.kind)) invalid('Agent 记忆类型无效。')
  const createdAt = timestamp(memory.createdAt, now)
  const content = text(memory.content, 'Agent 记忆内容', 1000).replace(/\s+/g, ' ')
  const version = memory.version === undefined ? 1 : Number(memory.version)
  if (!Number.isInteger(version) || version < 1 || version > 10_000) invalid('Agent 记忆版本无效。')
  const scope = memory.scope === undefined ? 'project' : memory.scope
  const source = memory.source === undefined ? 'human' : memory.source
  const confidence = memory.confidence === undefined ? 'confirmed' : memory.confidence
  if (!memoryScopes.has(scope)) invalid('Agent 记忆作用域无效。')
  if (!memorySources.has(source)) invalid('Agent 记忆来源无效。')
  if (!memoryConfidences.has(confidence)) invalid('Agent 记忆可信度无效。')
  const evidence = (Array.isArray(memory.evidence) ? memory.evidence : []).slice(0, 12).map((entry) => {
    const item = object(entry, 'Agent 记忆证据')
    if (!memoryEvidenceKinds.has(item.kind)) invalid('Agent 记忆证据类型无效。')
    return {
      kind: item.kind,
      ref: text(item.ref, 'Agent 记忆证据引用', 240),
      ...(item.confirmedAt === undefined ? {} : { confirmedAt: timestamp(item.confirmedAt, now) }),
    }
  })
  // 只有人工保存或已确认证据能支撑 active。模型建议保持建议态 —— 否则一次对话里的
  // 猜测会立刻变成品牌事实，之后每一轮生成都按它执行。
  const humanBacked = source === 'human' || evidence.some((item) => item.confirmedAt !== undefined)
  const status = memory.status === undefined
    ? (humanBacked ? 'active' : 'proposed')
    : memory.status
  if (!memoryStatuses.has(status)) invalid('Agent 记忆状态无效。')
  if (status === 'active' && !humanBacked) {
    invalid('Agent 记忆需要人工来源或已确认证据才能生效。')
  }
  const supersededBy = memory.supersededBy === undefined
    ? undefined
    : text(memory.supersededBy, 'Agent 记忆替代者', 160)
  if (status === 'superseded' && !supersededBy) invalid('被替代的 Agent 记忆必须指明替代者。')
  const computedContentHash = createHash('sha256').update(content).digest('base64url')
  const contentHash = memory.contentHash === undefined
    ? computedContentHash
    : text(memory.contentHash, 'Agent 记忆内容摘要', 200)
  if (contentHash !== computedContentHash) invalid('Agent 记忆内容摘要与内容不一致。')
  const id = text(memory.id, 'Agent 记忆标识', 160)
  const conflictsWith = uniqueTextList(memory.conflictsWith, 'Agent 记忆冲突关系', 12)
  if (conflictsWith.includes(id)) invalid('Agent 记忆不能与自身冲突。')
  // 适用主体（Epic 6 §8.6）。与 `scope` 是两个轴：scope 是包含范围、影响排序；
  // subject 是适用条件、决定这条规则参不参与某一次生成。
  const subject = memory.subject === undefined ? 'project' : memory.subject
  if (!MEMORY_SUBJECTS.includes(subject)) invalid('Agent 记忆适用主体无效。')
  // 限定了主体却不给取值，规则是残缺的：它永远不会匹配任何一次执行，
  // 而用户以为自己存了一条生效的规则。写入时就拒绝，不留到读取时才发现。
  const subjectValue = memory.subjectValue === undefined
    ? undefined
    : text(memory.subjectValue, 'Agent 记忆适用取值', 160)
  if (subject !== 'project' && !subjectValue) invalid('限定适用主体的 Agent 记忆必须指定具体取值。')
  if (subject === 'project' && subjectValue) invalid('全项目生效的 Agent 记忆不应指定适用取值。')
  const confidenceScore = memory.confidenceScore === undefined ? undefined : Number(memory.confidenceScore)
  if (confidenceScore !== undefined && (!Number.isFinite(confidenceScore) || confidenceScore < 0 || confidenceScore > 1)) {
    invalid('Agent 记忆可信程度必须是 0 到 1 之间的数值。')
  }
  return {
    id,
    kind: memory.kind,
    content,
    sourceNodeIds: uniqueTextList(memory.sourceNodeIds, 'Agent 记忆来源节点', 12),
    createdAt,
    updatedAt: Math.max(createdAt, timestamp(memory.updatedAt, now)),
    scope,
    source,
    confidence,
    status,
    ...(subject !== 'project' ? { subject, subjectValue } : {}),
    ...(confidenceScore === undefined ? {} : { confidenceScore }),
    ...(evidence.length ? { evidence } : {}),
    ...(conflictsWith.length ? { conflictsWith } : {}),
    ...(supersededBy ? { supersededBy } : {}),
    version,
    contentHash,
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
  const projectedSessionById = new Map((Array.isArray(state.sessions) ? state.sessions : []).map((session) => [session.id, session]))
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
    .map((session) => {
      const projected = projectedSessionById.get(session.id)
      if (!projected) return {
        ...session,
        messages: [...(messageBySession.get(session.id)?.values() ?? [])]
          .map((entry) => entry.message)
          .sort((left, right) => Number(left.createdAt ?? 0) - Number(right.createdAt ?? 0)),
      }
      const { readingAnchorMessageId: _legacyMessageId, readingAnchorUpdatedAt: _legacyUpdatedAt, ...shared } = session
      return {
        ...shared,
        ...(projected?.readingAnchorMessageId ? {
          readingAnchorMessageId: projected.readingAnchorMessageId,
          readingAnchorUpdatedAt: projected.readingAnchorUpdatedAt,
        } : {}),
        messages: [...(messageBySession.get(session.id)?.values() ?? [])]
          .map((entry) => entry.message)
          .sort((left, right) => Number(left.createdAt ?? 0) - Number(right.createdAt ?? 0)),
      }
    })
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
    // 服务端 Run 为安全执行快照，可能刻意省略 rootRecipe/references；兼容文档中的
    // 完整计划仍用于画布恢复，但独立实体无条件提供状态、分支和错误。
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
