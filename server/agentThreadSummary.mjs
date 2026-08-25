// @ts-check

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
const TEXT_LIMIT = 400

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
 * 从一条已确认的计划消息里取出决策事实。
 *
 * 只取结构字段，不取 Prompt 原文：Prompt 可能很长，而且它是执行细节，不是「用户决定了
 * 什么」。真正需要重放 Prompt 的地方读的是 Run 的编译快照（ADR 0005）。
 */
function decisionFromMessage(message) {
  const plan = message?.plan
  if (!plan) return undefined
  return {
    messageId: message.id,
    intent: plan.intent,
    summary: redactSummaryText(plan.summary ?? message.content),
    ...(message.runId ? { runId: message.runId } : {}),
    ...(plan.output?.count ? { outputCount: Number(plan.output.count) } : {}),
    decidedAt: message.updatedAt ?? message.createdAt,
  }
}

/**
 * 建立/刷新线程摘要检查点。
 *
 * `previous` 存在时做增量：已覆盖的消息不再重复扫描，且旧检查点里的事实不被丢弃 ——
 * 检查点只增不改写历史，否则「早期决策」会随着新一轮压缩而悄悄消失。
 *
 * @param {{ messages?: any[], previous?: any, now?: number }} input
 */
export function buildThreadSummaryCheckpoint({ messages = [], previous, now = Date.now() } = {}) {
  const covered = new Set(previous?.coveredMessageIds ?? [])
  const fresh = messages.filter((message) => message?.id && !covered.has(message.id))
  if (!fresh.length) return previous
  const goals = uniqueList([
    ...(previous?.goals ?? []),
    ...fresh.filter((message) => message.role === 'user' && message.kind === 'text')
      .slice(0, GOAL_LIMIT)
      .map((message) => redactSummaryText(message.content)),
  ], GOAL_LIMIT)
  const decisions = [
    ...(previous?.decisions ?? []),
    ...fresh.filter((message) => message.kind === 'plan' && message.status === CONFIRMED_PLAN_STATUS)
      .map(decisionFromMessage)
      .filter(Boolean),
  ].slice(-DECISION_LIMIT)
  const constraints = [
    ...(previous?.constraints ?? []),
    ...fresh.flatMap((message) => (message.kind === 'plan' && message.status === CONFIRMED_PLAN_STATUS
      ? (message.plan?.constraints ?? []).map((constraint) => `${constraint.dimension}:${constraint.mode}`)
      : [])),
  ]
  const openQuestions = [
    // 已经答过的追问不再是开放问题：上一轮的 pending 在这一轮可能已经 answered。
    ...(previous?.openQuestions ?? []).filter((entry) => !fresh.some((message) => (
      message.id === entry.messageId && message.status !== 'pending'
    ))),
    ...fresh.filter((message) => message.kind === 'question' && message.status === 'pending')
      .map((message) => ({
        messageId: message.id,
        question: redactSummaryText(message.question?.question ?? message.content),
      })),
  ].slice(-QUESTION_LIMIT)
  const entityIds = uniqueList([
    ...(previous?.entityIds ?? []),
    ...fresh.map((message) => message.runId).filter(Boolean),
    ...fresh.flatMap((message) => (message.mentions ?? []).map((mention) => mention?.nodeId ?? mention?.id)),
  ], ENTITY_LIMIT)
  return {
    version: 1,
    goals,
    decisions,
    constraints: uniqueList(constraints, CONSTRAINT_LIMIT),
    openQuestions,
    entityIds,
    coveredMessageIds: [...covered, ...fresh.map((message) => message.id)].slice(-200),
    coveredThrough: Math.max(
      Number(previous?.coveredThrough ?? 0),
      ...fresh.map((message) => Number(message.updatedAt ?? message.createdAt) || 0),
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
    const rendered = summary.decisions.map((decision) => `${decision.summary}${decision.runId ? `（${decision.runId}）` : ''}`)
    lines.push(en ? `Confirmed decisions: ${rendered.join(' / ')}` : `已确认决策：${rendered.join('；')}`)
  }
  if (summary.constraints?.length) {
    lines.push(en ? `Locked constraints: ${summary.constraints.join(', ')}` : `已锁定约束：${summary.constraints.join('、')}`)
  }
  if (summary.openQuestions?.length) {
    const rendered = summary.openQuestions.map((entry) => entry.question)
    lines.push(en ? `Open questions: ${rendered.join(' / ')}` : `尚未回答的问题：${rendered.join('；')}`)
  }
  if (summary.entityIds?.length) {
    lines.push(en ? `Referenced entities: ${summary.entityIds.join(', ')}` : `涉及实体：${summary.entityIds.join('、')}`)
  }
  if (!lines.length) return ''
  const header = en
    ? 'Earlier in this thread (summary of facts already settled, not new user input):'
    : '本线程早前已经定下的事实（不是用户这一轮的新输入）：'
  return [header, ...lines.map((line) => `- ${line}`)].join('\n')
}
