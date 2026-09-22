import type { BotanicAgentMessage } from '../../domain/agent.ts'
import type { BotanicAgentTurnResult } from '../../domain/agentTurnContract.ts'
import { botanicAgentTurnGenerationContinuation, botanicAgentTurnProjectionMessageId } from '../../domain/agentTurnObservation.ts'
import { formatBotanicAgentCompositionSummary, normalizeBotanicAgentComposition } from '../../domain/agentCreativeComposition.ts'
import type { ProductLocale } from '../../i18n/core.ts'

type TurnProjection =
  | { kind: 'message'; phase: 'completed' | 'waiting_clarification'; message: Omit<BotanicAgentMessage, 'createdAt'> }
  | { kind: 'generation'; continuation: ReturnType<typeof botanicAgentTurnGenerationContinuation> }

/** 首次返回与刷新恢复共用的安全投影。reasoning/工具原始回包不属于持久消息。 */
export function projectAgentTurnResult(turn: BotanicAgentTurnResult, identity: {
  turnId?: string; messageId: string; locale: ProductLocale
}): TurnProjection {
  const { turnId, messageId, locale } = identity
  if (turn.kind === 'generation') return { kind: 'generation', continuation: botanicAgentTurnGenerationContinuation(turn, turnId ?? '') }
  const message: Omit<BotanicAgentMessage, 'createdAt'> = {
    id: turnId ? botanicAgentTurnProjectionMessageId(turnId) : messageId,
    ...(turnId ? { turnId } : {}), role: 'assistant', kind: 'text', status: 'answered', content: '',
  }
  if (turn.kind === 'chat') {
    const sourceNote = turn.sources?.length ? `\n\n${locale === 'en' ? 'Sources' : '来源'}: ${turn.sources.join(locale === 'en' ? ', ' : '、')}` : ''
    message.content = `${turn.answer}${sourceNote}`
  } else if (turn.kind === 'clarification') {
    const options = turn.options?.length ? `\n\n${turn.options.map((option, index) => `${index + 1}. ${option}`).join('\n')}` : ''
    message.content = `${turn.question}${options}`
  } else {
    const composition = normalizeBotanicAgentComposition({ theme: turn.theme, items: turn.items })
    if (composition) {
      message.kind = 'composition'
      message.composition = composition
      message.content = formatBotanicAgentCompositionSummary(composition, locale)
    } else {
      message.kind = 'notice'
      message.status = 'failed'
      message.content = locale === 'en'
        ? 'The request did not produce a usable composition. Describe the items you want to deliver again.'
        : '这次分解没有形成可用的成套方案，请再描述一次交付项。'
    }
  }
  return { kind: 'message', message, phase: turn.kind === 'clarification' ? 'waiting_clarification' : 'completed' }
}
