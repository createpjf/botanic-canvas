import type { BotanicAgentMessage, BotanicAgentPlan, BotanicAgentRun } from './agent'

export type BotanicAgentMessageUtilityActions = {
  edit: boolean
  feedback: boolean
  copy: boolean
}

type UtilityMessage = Pick<
  BotanicAgentMessage,
  'id' | 'role' | 'kind' | 'content' | 'prompt' | 'composition' | 'runId' | 'plan' | 'question'
>

/** Run/notice 只是展示载体；结果能力只取决于消息是否绑定当前 Run。 */
export function botanicAgentMessageIsRunLinked(
  message: Pick<BotanicAgentMessage, 'runId'>,
  run?: Pick<BotanicAgentRun, 'id'>,
) {
  return Boolean(message.runId && run?.id === message.runId)
}

/** 完成分隔线只跟随已结束的回复；等待确认不是正在传输，也不是完成。 */
export function botanicAgentMessageIsSettled(
  message: Pick<BotanicAgentMessage, 'role' | 'status' | 'runId' | 'plan' | 'question' | 'content'>,
  run: Pick<BotanicAgentRun, 'id' | 'status'> | undefined,
  streaming = false,
) {
  if (message.role !== 'assistant' || streaming) return false
  if (message.runId) return Boolean(run?.id === message.runId && ['completed', 'partial', 'failed', 'cancelled'].includes(run.status))
  if (message.status === 'failed') return true
  return !message.plan && !message.question && message.status !== 'pending' && Boolean(message.content.trim())
}

/** 当前页读完不等于历史穷尽；读取状态不能覆盖已出现的结果。 */
export function botanicAgentRunResultReadState(
  run: { status: BotanicAgentRun['status']; plan: { output: { count: number } } } | undefined,
  hasResults: boolean,
  index: { pageReady: boolean; hasMore: boolean; failed: boolean },
) {
  if (!run || !['completed', 'partial'].includes(run.status) || run.plan.output.count <= 0 || hasResults) return 'none'
  if (index.failed) return 'error'
  if (!index.pageReady) return 'loading'
  return index.hasMore ? 'more' : 'missing'
}

/** 只用真实 Run/Turn 关联收口历史确认，不按时间或正文猜测用户已经回答。 */
export type AgentClarificationTurnState = {
  id: string; status: string; linkedRunIds?: string[]
  result?: { kind: string; runtimeOperation?: string; mediaKind?: string; prompt?: string; clarification?: { id: string; originalInstruction: string } }
}

export function botanicAgentClarificationTurnIds(message: Pick<BotanicAgentMessage, 'question' | 'turnId'>) {
  const questionId = message.question?.id ?? ''
  return [...new Set([message.turnId ?? message.question?.resolvedGeneration?.turnId,
    questionId.startsWith('plan-clarification:') ? questionId.slice('plan-clarification:'.length) : undefined].filter((id): id is string => Boolean(id)))]
}

export function botanicAgentClarificationProgress(
  message: Pick<BotanicAgentMessage, 'question' | 'status' | 'turnId' | 'runId' | 'sourceMessageId'>,
  runs: readonly { id: string; plan: Pick<BotanicAgentPlan, 'turnId'> }[],
  turn?: AgentClarificationTurnState | null,
): { state: 'pending' | 'answered' | 'continued' | 'unavailable'; runId?: string } {
  const turnId = message.turnId || message.question?.resolvedGeneration?.turnId
  if (message.runId) return { state: 'continued', runId: message.runId }
  const run = runs.find((item) => item.id === message.runId || Boolean(turnId && item.plan.turnId === turnId))
  if (run) return { state: 'continued', runId: run.id }
  if (turn !== undefined) {
    const ids = botanicAgentClarificationTurnIds(message)
    if (!turn || !ids.includes(turn.id)) return { state: 'unavailable' }
    const linkedRunId = turn.linkedRunIds?.find((id) => typeof id === 'string' && id.trim())
    if (linkedRunId) return { state: 'continued', runId: linkedRunId }
    const question = message.question
    const planTurnId = question?.id.startsWith('plan-clarification:') ? question.id.slice('plan-clarification:'.length) : undefined
    const sameQuestion = turn.status === 'waiting_user' && turn.result?.kind === 'clarification'
      && turn.result.clarification?.id === question?.id && turn.result.clarification?.originalInstruction === question?.originalInstruction
    const generation = question?.resolvedGeneration
    const sameGeneration = turn.status === 'completed' && turn.result?.kind === 'generation'
      && generation?.turnId === turn.id && generation.prompt === turn.result.prompt && generation.mediaKind === turn.result.mediaKind
    const valid = planTurnId && turn.id !== planTurnId ? turn.status === 'completed' : sameQuestion || (!planTurnId && sameGeneration)
    if (!valid) return { state: 'unavailable' }
  }
  if (message.status === 'failed' || (!turnId && !message.sourceMessageId)) return { state: 'unavailable' }
  return { state: message.status === 'answered' || message.status === 'submitted' ? 'answered' : 'pending' }
}

/** 每条有可读内容的消息都可复制；赞踩仍只服务创作回复。 */
export function botanicAgentMessageUtilityActions(message: UtilityMessage): BotanicAgentMessageUtilityActions {
  const hasCopyPayload = Boolean(
    message.content.trim()
    || message.prompt?.trim()
    || message.plan?.summary.trim()
    || message.question?.question.trim()
    || message.composition,
  )
  if (message.role === 'user') {
    return { edit: Boolean(message.content.trim()), feedback: false, copy: hasCopyPayload }
  }
  if (
    message.kind === 'notice'
    || message.kind === 'run'
    || message.kind === 'question'
    || message.kind === 'plan'
    || message.plan
    || message.question
  ) {
    return { edit: false, feedback: false, copy: hasCopyPayload }
  }
  // text + runId 会画「查看任务 / 查看结果」，按回执处理，不当成可评价回复。
  if (message.runId && message.kind !== 'composition') {
    return { edit: false, feedback: false, copy: hasCopyPayload }
  }
  return { edit: false, feedback: hasCopyPayload, copy: hasCopyPayload }
}

export function botanicAgentMessageHasUtilities(actions: BotanicAgentMessageUtilityActions) {
  return actions.edit || actions.feedback || actions.copy
}

export function botanicAgentLatestEvaluableMessageId(messages: UtilityMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const actions = botanicAgentMessageUtilityActions(messages[index])
    if (actions.feedback) return messages[index].id
  }
  return null
}
/** 评审回执仍可承载 Run 结果；只隐藏其评审正文，不移除消息或 Artifact。 */
export function botanicAgentMessageIsReview(message: Pick<BotanicAgentMessage, 'id' | 'role' | 'runId' | 'review'>) {
  return message.role === 'assistant' && (Boolean(message.review) || Boolean(message.runId && message.id === `agent-review-${message.runId}`))
}
