import type { BotanicAgentMessage } from './agent'

export type BotanicAgentMessageUtilityActions = {
  edit: boolean
  feedback: boolean
  copy: boolean
}

type UtilityMessage = Pick<
  BotanicAgentMessage,
  'id' | 'role' | 'kind' | 'content' | 'prompt' | 'composition' | 'runId' | 'plan' | 'question'
>

/**
 * 赞踩和复制只服务创作回复。系统通知、任务回执、计划卡和追问卡已经有主操作，不再并排元操作。
 */
export function botanicAgentMessageUtilityActions(message: UtilityMessage): BotanicAgentMessageUtilityActions {
  if (message.role === 'user') {
    return { edit: Boolean(message.content.trim()), feedback: false, copy: false }
  }
  if (
    message.kind === 'notice'
    || message.kind === 'run'
    || message.kind === 'question'
    || message.kind === 'plan'
    || message.plan
    || message.question
  ) {
    return { edit: false, feedback: false, copy: false }
  }
  // text + runId 会画「查看任务 / 查看结果」，按回执处理，不当成可评价回复。
  if (message.runId && message.kind !== 'composition') {
    return { edit: false, feedback: false, copy: false }
  }
  const hasCreativePayload = Boolean(message.content.trim() || message.prompt?.trim() || message.composition)
  return { edit: false, feedback: hasCreativePayload, copy: hasCreativePayload }
}

export function botanicAgentMessageHasUtilities(actions: BotanicAgentMessageUtilityActions) {
  return actions.edit || actions.feedback || actions.copy
}

export function botanicAgentLatestEvaluableMessageId(messages: UtilityMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const actions = botanicAgentMessageUtilityActions(messages[index])
    if (actions.feedback || actions.copy) return messages[index].id
  }
  return null
}
