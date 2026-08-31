// @ts-check

import { canonicalHash } from './canonicalHash.mjs'
import { validateAgentEntityReferences } from './agentEntityReferences.mjs'

/**
 * 线程摘要检查点（Epic 8）。
 *
 * 回合请求只带最近一个窗口的消息，超出窗口的早期内容此前就**彻底消失**了 ——
 * 用户在第 3 条消息里确认的约束，到第 20 条时 Agent 已经不知道。这里把早期对话里
 * **结构化的**事实固化成检查点，随会话持久化，再作为独立上下文层注入。
 *
 * 摘要是**确定性派生**的，不是模型写的散文：目标、已确认决策、约束、开放问题和实体
 * 标识都来自消息本身的结构字段（`kind` / `plan` / `question` / `runId`）。这样
 * 「compaction 前后关键约束一致」才可能有固定回归集 —— 让模型复述一遍约束，就没有
 * 任何东西能保证它复述对了。
 */

/**
 * 四类上下文层。它们的生命周期与可信度都不同，必须分开：
 *
 * - `turn_context`：本回合的最近消息窗口，随时被挤出。
 * - `thread_summary`：本线程早期事实的检查点，持久化，只增不改写历史。
 * - `project_memory`：跨线程的项目规则，由 Memory 治理拥有（ADR 0006）。
 * - `artifact_reference`：结果的稳定标识，不是结果内容本身。
 *
 * 混成一坨会让「这条约束是这次说的还是上个月存的」无从判断。
 */
export const THREAD_CONTEXT_KINDS = Object.freeze([
  'turn_context',
  'thread_summary',
  'project_memory',
  'artifact_reference',
])

/** 超过这个消息数就该建检查点。窗口是 16，留一半余量让早期内容在被挤出前先被固化。 */
export const THREAD_SUMMARY_THRESHOLD = 8

const GOAL_LIMIT = 3
const DECISION_LIMIT = 12
const CONSTRAINT_LIMIT = 16
const QUESTION_LIMIT = 8
const ENTITY_LIMIT = 40
const ARTIFACT_LIMIT = 12
const PENDING_ACTION_LIMIT = 8
const ARTIFACT_LABEL_LIMIT = 60
const TEXT_LIMIT = 400
const COVERED_MESSAGE_LIMIT = 200
const FACT_CANDIDATE_LIMIT = COVERED_MESSAGE_LIMIT
const SUMMARY_ARTIFACT_KINDS = new Set(['image', 'video', 'text', 'workflow', 'asset_group', 'file'])
const SETTINGS_TEXT_LIMIT = 80

function creativeSettingsFromPlan(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return undefined
  const picked = {
    ...(typeof settings.model === 'string' && settings.model.trim()
      ? { model: settings.model.trim().slice(0, SETTINGS_TEXT_LIMIT) }
      : {}),
    ...(typeof settings.aspectRatio === 'string' && settings.aspectRatio.trim()
      ? { aspectRatio: settings.aspectRatio.trim().slice(0, SETTINGS_TEXT_LIMIT) }
      : {}),
    ...(typeof settings.resolution === 'string' && settings.resolution.trim()
      ? { resolution: settings.resolution.trim().slice(0, SETTINGS_TEXT_LIMIT) }
      : {}),
  }
  return Object.keys(picked).length ? picked : undefined
}

function pendingActionsFromPlan(plan) {
  if (!Array.isArray(plan?.actions)) return []
  return plan.actions
    .filter((action) => action?.status === 'awaiting_confirmation')
    .flatMap((action) => {
      const toolName = typeof action.toolName === 'string' ? action.toolName.trim().slice(0, SETTINGS_TEXT_LIMIT) : ''
      if (!toolName) return []
      return [{
        toolName,
        label: redactSummaryText(action.label ?? toolName).slice(0, ARTIFACT_LABEL_LIMIT) || toolName,
      }]
    })
    .slice(0, PENDING_ACTION_LIMIT)
}

/**
 * 摘要里的每一段文本都要过这里。
 *
 * 摘要会被注入进模型上下文并长期持久化，因此它是最不该出现私有媒体地址与凭据的地方 ——
 * 一旦写进检查点，之后每一轮都会重新带上。
 */
export function redactSummaryText(value) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, '[媒体已省略]')
    .replace(/\/api\/media\/[A-Za-z0-9_-]+/g, '[媒体标识已省略]')
    .replace(/https?:\/\/\S+/gi, '[链接已省略]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[凭据已省略]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, '[凭据已省略]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TEXT_LIMIT)
}

function uniqueList(values, limit) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()))].slice(0, limit)
}

/**
 * 计划被确认执行后的消息状态。
 *
 * 不是 `'confirmed'` —— 持久化词表里根本没有这个值（`pending`/`answered`/
 * `submitted`/`failed`）。用户点确认后计划会被提交，消息状态落到 `submitted`，
 * 那才是「这条决策已经生效」的标志。
 */
const CONFIRMED_PLAN_STATUS = 'submitted'

/**
 * 同一消息实体会原地从 pending 更新为 answered/submitted，ID 不会变化。
 * 因此增量检查点必须跟踪实体版本，不能把「见过这个 ID」误当成「见过它的最新状态」。
 * 这里只记录时间戳和状态，不复制 Prompt、媒体或消息内容。
 */
export function messageSummaryRevision(message) {
  const updatedAt = Number(message?.updatedAt ?? message?.createdAt) || 0
  const status = typeof message?.status === 'string' ? message.status : ''
  return `${updatedAt}:${status}:${summaryRelevantDigest(message)}`
}

/**
 * 从一条已确认的计划消息里取出决策事实。
 *
 * 只取结构字段，不取 Prompt 原文：Prompt 可能很长，而且它是执行细节，不是「用户决定了
 * 什么」。真正需要重放 Prompt 的地方读的是 Run 的编译快照（ADR 0005）。
 */
function decisionFromMessage(message) {
  const plan = message?.plan
  if (!plan) return undefined
  const settings = creativeSettingsFromPlan(plan.settings)
  return {
    messageId: message.id,
    intent: plan.intent,
    summary: redactSummaryText(plan.summary ?? message.content),
    ...(message.runId ? { runId: message.runId } : {}),
    ...(plan.output?.count ? { outputCount: Number(plan.output.count) } : {}),
    ...(settings ? { settings } : {}),
    decidedAt: message.updatedAt ?? message.createdAt,
  }
}

function artifactReferencesFromMessage(message) {
  return [
    ...(Array.isArray(message?.artifacts) ? message.artifacts : []),
    ...(Array.isArray(message?.plan?.actions)
      ? message.plan.actions.flatMap((action) => (Array.isArray(action?.result?.artifacts) ? action.result.artifacts : []))
      : []),
  ]
}

function sanitizedArtifactReferences(message) {
  return artifactReferencesFromMessage(message)
    .filter((artifact) => typeof artifact?.id === 'string' && artifact.id.trim())
    .map((artifact) => ({
      id: artifact.id.trim().slice(0, 200),
      kind: SUMMARY_ARTIFACT_KINDS.has(artifact.kind) ? artifact.kind : 'file',
      label: redactSummaryText(artifact.label ?? '').slice(0, ARTIFACT_LABEL_LIMIT),
    }))
}

function trustedEntityReferencesFromMessage(message) {
  if (
    message?.role !== 'assistant'
    || typeof message?.turnId !== 'string'
    || message.id !== `agent-turn-result-${message.turnId}`
    || message.entityReferences === undefined
  ) return []
  return validateAgentEntityReferences(message.entityReferences)
}

function summaryFactsFromMessage(message) {
  const confirmedPlan = message?.kind === 'plan' && message?.status === CONFIRMED_PLAN_STATUS
  const goal = message?.role === 'user' && message?.kind === 'text'
    ? redactSummaryText(message.content)
    : ''
  const decision = confirmedPlan ? decisionFromMessage(message) : undefined
  const openQuestion = message?.kind === 'question' && message?.status === 'pending'
    ? {
        messageId: message.id,
        question: redactSummaryText(message.question?.question ?? message.content),
      }
    : undefined
  const pendingActions = pendingActionsFromPlan(message?.plan)
  return {
    goals: goal ? [goal] : [],
    decisions: decision ? [decision] : [],
    constraints: confirmedPlan
      ? (message.plan?.constraints ?? []).map((constraint) => `${constraint.dimension}:${constraint.mode}`)
      : [],
    openQuestions: openQuestion?.question ? [openQuestion] : [],
    pendingActions,
    entityIds: uniqueList([
      message?.runId,
      ...(message?.mentions ?? []).map((mention) => mention?.nodeId ?? mention?.id),
    ], ENTITY_LIMIT),
    artifacts: sanitizedArtifactReferences(message),
    entityReferences: trustedEntityReferencesFromMessage(message),
  }
}

/**
 * 只覆盖会改变 summary 事实的字段。同一 updatedAt/status 下发生内容改写时，digest
 * 仍会让增量检查点识别到 revision；Prompt、URL、raw output 不进入哈希输入。
 */
export function summaryRelevantDigest(message) {
  return canonicalHash(summaryFactsFromMessage(message))
}

function factCandidateFromMessage(message) {
  const facts = summaryFactsFromMessage(message)
  return {
    messageId: message.id,
    revision: messageSummaryRevision(message),
    occurredAt: Number(message.updatedAt ?? message.createdAt) || 0,
    ...(facts.goals.length ? { goals: facts.goals } : {}),
    ...(facts.decisions.length ? { decisions: facts.decisions } : {}),
    ...(facts.constraints.length ? { constraints: facts.constraints } : {}),
    ...(facts.openQuestions.length ? { openQuestions: facts.openQuestions } : {}),
    ...(facts.pendingActions.length ? { pendingActions: facts.pendingActions } : {}),
    ...(facts.entityIds.length ? { entityIds: facts.entityIds } : {}),
    ...(facts.artifacts.length ? { artifacts: facts.artifacts } : {}),
    ...(facts.entityReferences.length ? { entityReferences: facts.entityReferences } : {}),
  }
}

function hasCandidateFacts(candidate) {
  return [
    'goals', 'decisions', 'constraints', 'openQuestions', 'pendingActions',
    'entityIds', 'artifacts', 'entityReferences',
  ].some((field) => Array.isArray(candidate?.[field]) && candidate[field].length > 0)
}

/** legacy v1 没有逐 Message provenance，不能安全做撤回/修订。 */
export function hasThreadSummaryFactProvenance(summary) {
  if (!Array.isArray(summary?.factCandidates) || !Array.isArray(summary?.coveredMessageRevisions)) return false
  const revisions = new Map()
  for (const entry of summary.coveredMessageRevisions) {
    if (
      typeof entry?.messageId !== 'string'
      || typeof entry?.revision !== 'string'
      || revisions.has(entry.messageId)
    ) return false
    revisions.set(entry.messageId, entry.revision)
  }
  const candidates = new Set()
  return summary.factCandidates.every((candidate) => {
    if (
      typeof candidate?.messageId !== 'string'
      || typeof candidate?.revision !== 'string'
      || candidates.has(candidate.messageId)
      || (revisions.has(candidate.messageId) && revisions.get(candidate.messageId) !== candidate.revision)
    ) return false
    candidates.add(candidate.messageId)
    return true
  })
}

function newestCandidateValues(candidates, field, keyOf, limit) {
  const selected = []
  const seen = new Set()
  outer: for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const values = Array.isArray(candidates[index]?.[field]) ? candidates[index][field] : []
    for (let valueIndex = values.length - 1; valueIndex >= 0; valueIndex -= 1) {
      const value = values[valueIndex]
      const key = keyOf(value)
      if (!key || seen.has(key)) continue
      seen.add(key)
      selected.push(value)
      if (selected.length >= limit) break outer
    }
  }
  return selected.reverse()
}

function stableMessageOrder(left, right) {
  const timeDifference = (Number(left?.occurredAt ?? left?.updatedAt ?? left?.createdAt) || 0)
    - (Number(right?.occurredAt ?? right?.updatedAt ?? right?.createdAt) || 0)
  if (timeDifference) return timeDifference
  const leftId = String(left?.messageId ?? left?.id ?? '')
  const rightId = String(right?.messageId ?? right?.id ?? '')
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0
}

/**
 * 建立/刷新线程摘要检查点。
 *
 * `previous` 存在且带逐 Message provenance 时做增量：revision 变化会先移除该 Message
 * 的旧 candidate，再用新版本重建。这样修订/撤回不会留下幽灵事实，重复事实的较新来源
 * 撤回后，较旧来源又能确定性回退。
 *
 * legacy v1 没有 factCandidates，只有调用方证明 `fullHistory` 后才允许从零升级；否则
 * 原样沿用旧摘要且不写回，避免拿不完整分页覆盖早期事实。
 *
 * @param {{ messages?: any[], previous?: any, now?: number, fullHistory?: boolean }} input
 */
export function buildThreadSummaryCheckpoint({ messages = [], previous, now = Date.now(), fullHistory = false } = {}) {
  if (previous && !hasThreadSummaryFactProvenance(previous)) {
    if (!fullHistory) return previous
    previous = undefined
  }
  const covered = new Set([
    ...(previous?.coveredMessageIds ?? []),
    ...(previous?.factCandidates ?? []).map((candidate) => candidate?.messageId).filter(Boolean),
  ])
  const previousRevisions = new Map(
    [
      ...(previous?.coveredMessageRevisions ?? []),
      ...(previous?.factCandidates ?? []).map((candidate) => ({
        messageId: candidate?.messageId,
        revision: candidate?.revision,
      })),
    ]
      .filter((entry) => typeof entry?.messageId === 'string' && typeof entry?.revision === 'string')
      .map((entry) => [entry.messageId, entry.revision]),
  )
  const fresh = messages.filter((message) => (
    message?.id
    && (!covered.has(message.id) || previousRevisions.get(message.id) !== messageSummaryRevision(message))
  ))
  if (!fresh.length) return previous
  const orderedFresh = [...fresh].sort(stableMessageOrder)
  const candidateByMessageId = new Map(
    (previous?.factCandidates ?? []).map((candidate) => [candidate.messageId, candidate]),
  )
  for (const message of orderedFresh) {
    candidateByMessageId.delete(message.id)
    const candidate = factCandidateFromMessage(message)
    if (hasCandidateFacts(candidate)) candidateByMessageId.set(message.id, candidate)
  }
  const factCandidates = [...candidateByMessageId.values()]
    .sort(stableMessageOrder)
    .slice(-FACT_CANDIDATE_LIMIT)
  const goals = newestCandidateValues(factCandidates, 'goals', (value) => value, GOAL_LIMIT)
  const decisions = newestCandidateValues(
    factCandidates, 'decisions', (value) => value?.messageId, DECISION_LIMIT,
  )
  const constraints = newestCandidateValues(
    factCandidates,
    'constraints',
    (value) => typeof value === 'string' ? value.split(':', 1)[0] : '',
    CONSTRAINT_LIMIT,
  )
  const openQuestions = newestCandidateValues(
    factCandidates, 'openQuestions', (value) => value?.messageId, QUESTION_LIMIT,
  )
  const pendingActions = newestCandidateValues(
    factCandidates,
    'pendingActions',
    (value) => value?.toolName && value?.label ? `${value.toolName}:${value.label}` : value?.toolName,
    PENDING_ACTION_LIMIT,
  )
  const entityIds = newestCandidateValues(factCandidates, 'entityIds', (value) => value, ENTITY_LIMIT)
  const artifacts = newestCandidateValues(factCandidates, 'artifacts', (value) => value?.id, ARTIFACT_LIMIT)
  const entityReferences = newestCandidateValues(
    factCandidates,
    'entityReferences',
    (value) => value?.type && value?.id ? `${value.type}:${value.id}` : '',
    24,
  )
  for (const message of orderedFresh) previousRevisions.set(message.id, messageSummaryRevision(message))
  const freshMessageIds = [...new Set(orderedFresh.map((message) => message.id))]
  const freshMessageIdSet = new Set(freshMessageIds)
  const coveredMessageIds = [
    ...(previous?.coveredMessageIds ?? []).filter((messageId) => !freshMessageIdSet.has(messageId)),
    ...freshMessageIds,
  ].slice(-COVERED_MESSAGE_LIMIT)
  return {
    version: 1,
    goals,
    decisions,
    constraints,
    openQuestions,
    ...(pendingActions.length ? { pendingActions } : {}),
    entityIds,
    ...(artifacts.length ? { artifacts } : {}),
    ...(entityReferences.length ? { entityReferences } : {}),
    factCandidates,
    coveredMessageIds,
    coveredMessageRevisions: coveredMessageIds.flatMap((messageId) => {
      const revision = previousRevisions.get(messageId)
      return revision === undefined ? [] : [{ messageId, revision }]
    }),
    coveredThrough: Math.max(
      Number(previous?.coveredThrough ?? 0),
      ...orderedFresh.map((message) => Number(message.updatedAt ?? message.createdAt) || 0),
    ),
    updatedAt: now,
  }
}

/** 会话是否长到需要检查点。 */
export function shouldCompactThread(messages = [], { threshold = THREAD_SUMMARY_THRESHOLD } = {}) {
  return messages.filter((message) => message?.id).length > threshold
}

/**
 * 把检查点渲染成注入模型的一段文本。
 *
 * 明确标注它是「早期结论」而不是本轮输入 —— 不标注的话模型会把它当成用户刚说的话，
 * 于是把早就定好的约束又问一遍。
 */
export function renderThreadSummary(summary, { locale = 'zh-CN' } = {}) {
  if (!summary) return ''
  const lines = []
  const en = locale === 'en'
  if (summary.goals?.length) {
    lines.push(en ? `Stated goals: ${summary.goals.join(' / ')}` : `已表达目标：${summary.goals.join('；')}`)
  }
  if (summary.decisions?.length) {
    const rendered = summary.decisions.map((decision) => {
      const settingsText = decision.settings
        ? [decision.settings.model, decision.settings.aspectRatio, decision.settings.resolution]
          .filter(Boolean)
          .join(' · ')
        : ''
      return `${decision.summary}${settingsText ? ` [${settingsText}]` : ''}${decision.runId ? `（${decision.runId}）` : ''}`
    })
    lines.push(en ? `Confirmed decisions: ${rendered.join(' / ')}` : `已确认决策：${rendered.join('；')}`)
  }
  if (summary.constraints?.length) {
    lines.push(en ? `Locked constraints: ${summary.constraints.join(', ')}` : `已锁定约束：${summary.constraints.join('、')}`)
  }
  if (summary.openQuestions?.length) {
    const rendered = summary.openQuestions.map((entry) => entry.question)
    lines.push(en ? `Open questions: ${rendered.join(' / ')}` : `尚未回答的问题：${rendered.join('；')}`)
  }
  if (summary.pendingActions?.length) {
    const rendered = summary.pendingActions.map((action) => `${action.label || action.toolName}（${action.toolName}）`)
    lines.push(en ? `Pending confirmations: ${rendered.join(' / ')}` : `待确认行动：${rendered.join('；')}`)
  }
  if (summary.entityIds?.length) {
    lines.push(en ? `Referenced entities: ${summary.entityIds.join(', ')}` : `涉及实体：${summary.entityIds.join('、')}`)
  }
  if (summary.artifacts?.length) {
    // 必须写明「只有标识、内容要用工具回读」：不写的话模型会拿标签当成它看过的内容，
    // 直接据此描述画面 —— 那比不给这份目录更糟。
    const rendered = summary.artifacts.map((artifact) => `${artifact.label || artifact.kind}（${artifact.id}）`)
    lines.push(en
      ? `Earlier results (identifiers only — read details with the artifact lookup tool, do not describe them from memory): ${rendered.join(' / ')}`
      : `早前的产出（**只有标识**，内容需用结果检索工具回读，不要凭这行描述画面）：${rendered.join('；')}`)
  }
  if (summary.entityReferences?.length) {
    const rendered = summary.entityReferences.map((reference) => `${reference.type}:${reference.id}`)
    lines.push(en
      ? `Earlier entity references (identifiers only — use the matching read tool): ${rendered.join(', ')}`
      : `早前业务引用（仅标识，需用对应只读工具回读）：${rendered.join('、')}`)
  }
  if (!lines.length) return ''
  const header = en
    ? 'Earlier in this thread (summary of facts already settled, not new user input):'
    : '本线程早前已经定下的事实（不是用户这一轮的新输入）：'
  return [header, ...lines.map((line) => `- ${line}`)].join('\n')
}
