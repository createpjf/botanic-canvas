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
