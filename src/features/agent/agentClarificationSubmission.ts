import type { BotanicAgentMessage, BotanicAgentRun, BotanicAgentSession } from '../../domain/agent.ts'
import { applyBotanicCreativeBriefAnswers, botanicAgentClarificationAnswersComplete, botanicAgentClarificationFields, type BriefGenerationModel } from '../../domain/agentCreativeBrief.ts'
import { botanicAgentBriefWithVariationAnswers } from '../../domain/agentVariations.ts'
import { botanicAgentClarificationProgress, botanicAgentClarificationTurnIds, type AgentClarificationTurnState } from '../../domain/agentMessageUtilities.ts'
import type { BotanicAgentInstructionOptions } from '../../domain/agentInstructionRouting.ts'
import { resolveAgentPersistedExecutionSnapshot } from './agentComposerState.ts'
import type { AgentInstructionExecutionSnapshot } from './agentComposerQueue.ts'
import type { AgentContextItem } from './agentWorkspace.types.ts'

export type AgentClarificationContinuation = BotanicAgentInstructionOptions & {
  requestId: string
  appendUser: string
  appendUserMessageId: string
  appendUserCreatedAt: number
  clarificationMessageId: string
  clarificationId: string
  sourceMessageId: string
  sourceTurnId?: string
  executionSnapshot?: AgentInstructionExecutionSnapshot
}

/** 同一确认复用一个答案 Message；重试不是另一条输入，也不改变 Turn 的幂等算法。 */
async function answerMessageId(sessionId: string, message: BotanicAgentMessage) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([sessionId, message.id, message.question?.id])))
  return `agent-answer-${Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')}`
}

/** 展示与提交共同恢复原请求；按身份有界翻页，不借用当前 Composer。 */
export async function findAgentClarificationSource(message: BotanicAgentMessage, messages: readonly BotanicAgentMessage[],
  loadMessages?: (before?: string) => Promise<{ messages: BotanicAgentMessage[]; nextBefore?: string }>, isCurrent: () => boolean = () => true,
) {
  const turnId = message.turnId ?? message.question?.resolvedGeneration?.turnId
  const find = (items: readonly BotanicAgentMessage[]) => items.find((item) => item.role === 'user'
    && (message.sourceMessageId ? item.id === message.sourceMessageId : Boolean(turnId && item.turnId === turnId && item.turnRequestSnapshot)))
  let source = find(messages)
  if (!resolveAgentPersistedExecutionSnapshot({ sourceMessage: source, contextOptions: [] }) && loadMessages && (message.sourceMessageId || turnId)) {
    let before: string | undefined
    const cursors = new Set<string>()
    // ponytail: 最多 10 页；更旧请求由已有历史分页入口载入，不无界扫描。
    for (let index = 0; index < 10 && isCurrent(); index++) {
      const page = await loadMessages(before)
      if (!isCurrent()) return undefined
      const found = find(page.messages)
      if (found) { source = found; break }
      if (!page.nextBefore || cursors.has(page.nextBefore)) break
      before = page.nextBefore; cursors.add(before)
    }
  }
  return source
}

/** 确认的可靠交付与接续。状态归 Message/Run；集合仅防止本页同一操作重入。 */
export async function submitAgentClarification(input: {
  session: BotanicAgentSession
  message: BotanicAgentMessage
  answers: Record<string, string>
  generationModels: readonly BriefGenerationModel[]
  contextOptions: readonly AgentContextItem[]
  plannerModel: string
  runs: readonly Pick<BotanicAgentRun, 'id' | 'plan'>[]
  locale: 'zh-CN' | 'en'
  inFlight: Set<string>
  isCurrent: () => boolean
  readTurn?: (id: string) => Promise<AgentClarificationTurnState | undefined>
  loadMessages?: (before?: string) => Promise<{ messages: BotanicAgentMessage[]; nextBefore?: string }>
  ensureMessageDurable: (message: BotanicAgentMessage) => Promise<BotanicAgentMessage>
  retryMessage: (id: string) => void
  onUpdateMessage: (sessionId: string, messageId: string, patch: Pick<BotanicAgentMessage, 'status' | 'question' | 'runId'>) => void
  continueInstruction: (instruction: string, options: AgentClarificationContinuation) => Promise<void>
}) {
  const { session, message, inFlight, isCurrent } = input
  const question = message.question
  const key = `${session.id}:${message.id}`
  if (!question || !isCurrent() || inFlight.has(key)
    || botanicAgentClarificationProgress(message, input.runs).state === 'continued') return
  if (botanicAgentClarificationProgress(message, input.runs).state === 'unavailable') {
    throw new Error(input.locale === 'en' ? 'The original request cannot continue. Start a new draft.' : '原请求无法接续，请重新填写。')
  }
  inFlight.add(key)
  try {
    const current = session.messages.find((item) => item.id === message.id)
    if (current && (current.kind !== 'question' || current.question?.id !== question.id)) {
      throw new Error(input.locale === 'en' ? 'This confirmation has changed. Reload the conversation.' : '确认内容已变化，请重新加载对话。')
    }
    const sourceTurnId = message.turnId ?? question.resolvedGeneration?.turnId
    const planTurnId = question.id.startsWith('plan-clarification:') ? question.id.slice('plan-clarification:'.length) : undefined
    const turnIds = botanicAgentClarificationTurnIds(message)
    for (const turnId of input.readTurn ? turnIds : planTurnId ? [planTurnId] : []) {
      const turn = await input.readTurn?.(turnId)
      if (!isCurrent()) return
      const progress = botanicAgentClarificationProgress(message, input.runs, turn?.id === turnId ? turn : null)
      if (progress.runId) {
        const accepted = await input.ensureMessageDurable({ ...message, status: 'submitted', runId: progress.runId, updatedAt: Date.now() })
        if (isCurrent()) input.onUpdateMessage(session.id, message.id, { status: accepted.status, question: accepted.question, runId: accepted.runId })
        return
      }
      if (progress.state === 'unavailable') throw Object.assign(new Error(input.locale === 'en'
        ? 'The original confirmation is no longer available. Start a new draft.'
        : '原确认已失效，请重新填写。'), { code: 'AGENT_CLARIFICATION_UNAVAILABLE' })
    }
    const sourceMessage = await findAgentClarificationSource(message, session.messages, input.loadMessages, isCurrent)
    if (!isCurrent()) return
    if (sourceTurnId && sourceMessage?.turnId !== undefined && sourceMessage.turnId !== sourceTurnId) {
      throw new Error(input.locale === 'en' ? 'The original request does not match this confirmation.' : '原请求与当前确认不匹配。')
    }
    const executionSnapshot = resolveAgentPersistedExecutionSnapshot({ ...input, sourceMessage })
    if (!executionSnapshot) {
      throw new Error(input.locale === 'en'
        ? sourceMessage ? 'The original request settings are incomplete. Start a new request.' : 'Load earlier messages and retry this confirmation.'
        : sourceMessage ? '原请求设置不完整，请重新发起请求。' : '原请求尚未载入，请加载更早的消息后重试。')
    }
    // 缩略图不是媒体权威；接续入口按原 targetNodeId 解析节点/Job，无法恢复则停止。
    // answered 后恢复只采用已保存答案，不能用另一设备的旧选择覆盖它。
    const alreadyAnswered = message.status === 'answered' || message.status === 'submitted'
    const answers = alreadyAnswered
      ? Object.fromEntries(question.fields.flatMap((field) => field.defaultValue ? [[field.id, field.defaultValue]] : []))
      : structuredClone(input.answers)
    if (alreadyAnswered && question.brief?.creative.customDirection) answers.custom_direction = question.brief.creative.customDirection
    const fields = botanicAgentClarificationFields(question.fields, input.generationModels, answers)
    if (!botanicAgentClarificationAnswersComplete(fields, answers)) {
      throw new Error(input.locale === 'en' ? 'Complete the required settings.' : '请补全必要设置。')
    }
    const brief = botanicAgentBriefWithVariationAnswers(applyBotanicCreativeBriefAnswers(question.brief, answers, input.generationModels), answers)
    const answered: BotanicAgentMessage = {
      ...message, status: 'answered', updatedAt: Date.now(),
      question: { ...question, brief, fields: fields.map((field) => answers[field.id] ? { ...field, defaultValue: answers[field.id] } : field) },
    }
    const id = await answerMessageId(session.id, message)
    if (!isCurrent()) return
    input.retryMessage(message.id)
    const accepted = await input.ensureMessageDurable(answered)
    if (!isCurrent()) return
    // PUT 可能返回另一设备已经推进的计划/失败，而不是本页提交的 question。
    // 回执由交付模块完整投影；这里只继续同一问题实际采用的答案。
    if (accepted.kind !== 'question' || accepted.question?.id !== question.id
      || (accepted.status !== 'answered' && accepted.status !== 'submitted')) return
    const acceptedQuestion = accepted.question
    const acceptedAnswers = Object.fromEntries(acceptedQuestion.fields.flatMap((field) => field.defaultValue ? [[field.id, field.defaultValue]] : []))
    if (acceptedQuestion.brief?.creative.customDirection) acceptedAnswers.custom_direction = acceptedQuestion.brief.creative.customDirection
    input.onUpdateMessage(session.id, message.id, { status: accepted.status, question: acceptedQuestion })
    const summary = [
      ...acceptedQuestion.fields.map((field) => `${field.label}${input.locale === 'en' ? ': ' : '：'}${field.options.find((option) => option.value === acceptedAnswers[field.id])?.label ?? acceptedAnswers[field.id]}`),
      acceptedAnswers.custom_direction?.trim() && !acceptedQuestion.fields.some((field) => field.id === 'custom_direction')
        ? `${input.locale === 'en' ? 'Custom direction: ' : '自定义方向：'}${acceptedAnswers.custom_direction.trim()}` : '',
    ].filter(Boolean).join(input.locale === 'en' ? '; ' : '；')
    const answer: BotanicAgentMessage = {
      ...(session.messages.find((item) => item.id === id)
        ?? { id, role: 'user', kind: 'text', content: summary, createdAt: accepted.updatedAt ?? answered.updatedAt! }),
      sourceMessageId: sourceMessage!.id, ...(sourceTurnId ? { turnId: sourceTurnId } : {}),
    }
    input.retryMessage(id)
    const acceptedAnswer = await input.ensureMessageDurable(answer)
    if (!isCurrent()) return
    await input.continueInstruction(acceptedQuestion.originalInstruction, {
      requestId: `agent-plan-${acceptedAnswer.id}`,
      appendUser: acceptedAnswer.content, appendUserMessageId: id, appendUserCreatedAt: acceptedAnswer.createdAt,
      clarificationMessageId: message.id, clarificationId: acceptedQuestion.id, sourceMessageId: sourceMessage!.id,
      clarificationAnswers: acceptedAnswers, creativeBrief: acceptedQuestion.brief,
      sourcePromptMessageId: acceptedQuestion.sourcePromptMessageId,
      resolvedGeneration: acceptedQuestion.resolvedGeneration,
      sourceTurnId, executionSnapshot,
      generationOverrides: {
        ...(acceptedAnswers.model ? { model: acceptedAnswers.model } : {}),
        ...(acceptedAnswers.aspect_ratio ? { aspectRatio: acceptedAnswers.aspect_ratio as NonNullable<BotanicAgentInstructionOptions['generationOverrides']>['aspectRatio'] } : {}),
        ...(acceptedAnswers.resolution ? { resolution: acceptedAnswers.resolution as NonNullable<BotanicAgentInstructionOptions['generationOverrides']>['resolution'] } : {}),
      },
    })
  } finally {
    inFlight.delete(key)
  }
}
