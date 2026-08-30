import { useEffect, useRef, useState } from 'react'
import {
  botanicAgentActionFailureStatus,
  botanicAgentActionReceiptMessageId,
  botanicAgentActionReconciliationPatch,
  botanicAgentCanResumeManualRetry,
  botanicAgentCanUseManualRetryAuthorization,
  botanicAgentPreparedRetryIdempotencyKey,
  type BotanicAgentActionProposal,
  type BotanicAgentActionResult,
  type BotanicAgentActionUserIntent,
  type BotanicAgentManualRetryAuthorization,
  type BotanicAgentMessage,
  type BotanicAgentRuntimePhase,
} from '../../domain/agent'
import {
  ProjectAgentActionClientError,
  projectAgentActionIdempotencyKey,
  readProjectAgentActionStatus,
  resolveProjectAgentAction,
} from '../../lib/agentApi'
import { ProductApiError } from '../../lib/productSession'
import { localizeProductError, type ProductLocale } from '../../i18n/core'

function authorizationKey(sessionId: string, messageId: string, actionId: string) {
  return `${sessionId}:${messageId}:${actionId}`
}

/** 行动确认、状态观察与一次性人工重试的唯一前端生命周期 seam。 */
export function useAgentActionLifecycle({
  projectId,
  session,
  locale,
  copy,
  isCurrentProject,
  persistActionUpdate,
  appendMessage,
  onConfirmAction,
  setRuntimePhase,
  setError,
  clearFailedPlan,
}: {
  projectId: string
  session?: { id: string }
  locale: ProductLocale
  copy: { actionFailed: string; canvasWritten: string }
  isCurrentProject: () => boolean
  persistActionUpdate: (
    message: BotanicAgentMessage,
    actionId: string,
    patch: Partial<BotanicAgentActionProposal>,
  ) => BotanicAgentMessage
  appendMessage: (
    message: Omit<BotanicAgentMessage, 'id' | 'createdAt'> & { id?: string },
  ) => string | undefined
  onConfirmAction: (
    action: BotanicAgentActionProposal,
    context: { sessionId: string; messageId: string },
    options?: {
      manualRetryAuthorization?: BotanicAgentManualRetryAuthorization
      resumeManualRetry?: { retryIdempotencyKey: string }
      observedResult?: BotanicAgentActionResult
    },
  ) => Promise<BotanicAgentActionResult>
  setRuntimePhase: (phase: BotanicAgentRuntimePhase) => void
  setError: (message: string) => void
  clearFailedPlan: () => void
}) {
  const [executingActionId, setExecutingActionId] = useState('')
  const executingActionIdRef = useRef('')
  const [manualRetryAuthorizations, setManualRetryAuthorizations] = useState<Record<string, BotanicAgentManualRetryAuthorization>>({})
  useEffect(() => setManualRetryAuthorizations({}), [projectId, session?.id])

  const manualRetryAuthorization = (message: BotanicAgentMessage, action: BotanicAgentActionProposal) => (
    session ? manualRetryAuthorizations[authorizationKey(session.id, message.id, action.id)] : undefined
  )

  const confirmAction = async (
    message: BotanicAgentMessage,
    action: BotanicAgentActionProposal,
    intent: BotanicAgentActionUserIntent,
  ) => {
    if (!session || executingActionIdRef.current || action.status === 'succeeded' || action.status === 'dismissed') return
    const key = authorizationKey(session.id, message.id, action.id)
    const retryAuthorization = manualRetryAuthorizations[key]
    if (intent === 'execute' && action.status !== 'awaiting_confirmation') return
    if (intent === 'check_status' && action.status !== 'running') return
    if ((intent === 'confirmed_applied' || intent === 'confirmed_not_applied') && action.status !== 'uncertain') return
    const canResumeManualRetry = botanicAgentCanResumeManualRetry(action)
    if (intent === 'manual_retry'
      && !canResumeManualRetry
      && !botanicAgentCanUseManualRetryAuthorization(action, retryAuthorization)) {
      setError(locale === 'en'
        ? 'The one-time retry authorization expired. Start a new action.'
        : '一次性重试授权已过期，请重新发起行动。')
      return
    }
    executingActionIdRef.current = action.id
    setExecutingActionId(action.id)
    setRuntimePhase('executing')
    setError('')
    clearFailedPlan()
    const context = { sessionId: session.id, messageId: message.id }
    let actionMessage = message
    const receiptKey = action.receiptIdempotencyKey ?? retryAuthorization?.retryIdempotencyKey
    try {
      if (intent === 'check_status') {
        const observation = await readProjectAgentActionStatus({
          projectId,
          action,
          ...context,
          receiptIdempotencyKey: receiptKey,
        })
        if (!isCurrentProject()) return
        let result = observation.execution?.output
        let writebackError = ''
        if (result) {
          try {
            result = await onConfirmAction(action, context, { observedResult: result })
          } catch (caught) {
            writebackError = localizeProductError(caught, locale, { 'zh-CN': copy.actionFailed, en: copy.actionFailed })
          }
        }
        persistActionUpdate(message, action.id, {
          ...botanicAgentActionReconciliationPatch(observation.status),
          ...(result ? { result } : {}),
        })
        if (observation.status.status === 'succeeded' || observation.status.status === 'failed') {
          setManualRetryAuthorizations((current) => {
            if (!current[key]) return current
            const next = { ...current }
            delete next[key]
            return next
          })
        }
        if (observation.status.status === 'succeeded') appendMessage({
          id: botanicAgentActionReceiptMessageId(action.id),
          role: 'assistant',
          kind: 'notice',
          content: result?.message ?? (locale === 'en'
            ? 'The action is confirmed as applied. The status check did not replay the tool or fabricate an output.'
            : '已确认行动生效；本次状态查询没有重放工具，也没有伪造输出。'),
        })
        setRuntimePhase(observation.status.status === 'running'
          ? 'executing'
          : observation.status.status === 'succeeded' ? 'completed' : 'failed')
        if (writebackError) setError(writebackError)
        return
      }

      if (intent === 'confirmed_applied' || intent === 'confirmed_not_applied') {
        const resolvingOriginalAsNotApplied = intent === 'confirmed_not_applied' && !action.receiptIdempotencyKey
        const deterministicRetryKey = botanicAgentPreparedRetryIdempotencyKey({
          projectId,
          sessionId: session.id,
          messageId: message.id,
          actionId: action.id,
          originalIdempotencyKey: projectAgentActionIdempotencyKey(action),
        })
        const preparedRetryKey = resolvingOriginalAsNotApplied
          ? action.preparedRetryIdempotencyKey ?? deterministicRetryKey
          : undefined
        if (preparedRetryKey && action.preparedRetryIdempotencyKey !== preparedRetryKey) {
          actionMessage = persistActionUpdate(actionMessage, action.id, { preparedRetryIdempotencyKey: preparedRetryKey })
        }
        const resolution = await resolveProjectAgentAction({
          projectId,
          action,
          ...context,
          decision: intent,
          receiptIdempotencyKey: receiptKey,
          preparedRetryIdempotencyKey: preparedRetryKey,
        })
        if (!isCurrentProject()) return
        actionMessage = persistActionUpdate(actionMessage, action.id, {
          ...botanicAgentActionReconciliationPatch(resolution.status),
          preparedRetryIdempotencyKey: undefined,
          ...(resolution.manualRetryReservation ? {
            receiptIdempotencyKey: resolution.manualRetryReservation.retryIdempotencyKey,
            manualRetryResumeAvailable: true,
          } : {}),
        })
        if (resolution.manualRetryReservation) {
          setManualRetryAuthorizations((current) => {
            if (!current[key]) return current
            const next = { ...current }
            delete next[key]
            return next
          })
        } else if (intent === 'confirmed_not_applied'
          && resolution.manualRetryAuthorization
          && !retryAuthorization) {
          setManualRetryAuthorizations((current) => ({
            ...current,
            [key]: {
              ...resolution.manualRetryAuthorization!,
              retryIdempotencyKey: preparedRetryKey ?? deterministicRetryKey,
            },
          }))
        } else {
          setManualRetryAuthorizations((current) => {
            if (!current[key]) return current
            const next = { ...current }
            delete next[key]
            return next
          })
        }
        if (intent === 'confirmed_applied') appendMessage({
          id: botanicAgentActionReceiptMessageId(action.id),
          role: 'assistant',
          kind: 'notice',
          content: locale === 'en'
            ? 'Marked as applied after your verification. No tool output or artifact was fabricated.'
            : '已按你的核对标记为生效；系统未伪造工具输出或 Artifact。',
        })
        setRuntimePhase('completed')
        return
      }

      actionMessage = persistActionUpdate(actionMessage, action.id, {
        status: 'running',
        manualRetryResumeAvailable: intent === 'manual_retry' && canResumeManualRetry ? true : undefined,
        error: undefined,
        ...(intent === 'manual_retry' && retryAuthorization
          ? { receiptIdempotencyKey: retryAuthorization.retryIdempotencyKey }
          : {}),
      })
      const result = await onConfirmAction(
        action,
        context,
        intent === 'manual_retry'
          ? retryAuthorization
            ? { manualRetryAuthorization: retryAuthorization }
            : { resumeManualRetry: { retryIdempotencyKey: receiptKey! } }
          : undefined,
      )
      if (!isCurrentProject()) return
      actionMessage = persistActionUpdate(actionMessage, action.id, {
        status: 'succeeded',
        result,
        error: undefined,
        preparedRetryIdempotencyKey: undefined,
        manualRetryResumeAvailable: undefined,
      })
      if (intent === 'manual_retry') setManualRetryAuthorizations((current) => {
        const next = { ...current }
        delete next[key]
        return next
      })
      setRuntimePhase('completed')
      appendMessage({
        id: botanicAgentActionReceiptMessageId(action.id),
        role: 'assistant',
        kind: 'notice',
        content: `${result.message}${result.canvasNodeId ? copy.canvasWritten : ''}`,
      })
    } catch (caught) {
      if (!isCurrentProject()) return
      const actionError = localizeProductError(caught, locale, { 'zh-CN': copy.actionFailed, en: copy.actionFailed })
      const actionStatus = botanicAgentActionFailureStatus(caught instanceof ProductApiError ? caught.code : undefined)
      const approvalFailed = caught instanceof ProjectAgentActionClientError && caught.stage === 'approval'
      const manualRetryRejected = intent === 'manual_retry'
        && caught instanceof ProductApiError
        && [
          'AGENT_ACTION_MANUAL_RETRY_EXPIRED',
          'AGENT_ACTION_MANUAL_RETRY_ALREADY_CONSUMED',
          'AGENT_ACTION_MANUAL_RETRY_INVALID',
          'AGENT_ACTION_MANUAL_RETRY_IDEMPOTENCY_INVALID',
          'AGENT_ACTION_MANUAL_RETRY_IDEMPOTENCY_REUSED',
          'AGENT_ACTION_MANUAL_RETRY_UNAVAILABLE',
          'AGENT_ACTION_MANUAL_RETRY_REQUIRED',
          'AGENT_ACTION_MANUAL_RETRY_EXHAUSTED',
          'AGENT_ACTION_MANUAL_RETRY_SCOPE_MISMATCH',
          'AGENT_ACTION_RECONCILIATION_SCOPE_MISMATCH',
        ].includes(caught.code ?? '')
      const retryReceiptPending = intent === 'check_status'
        && caught instanceof ProductApiError
        && (caught.code === 'AGENT_ACTION_MANUAL_RETRY_RECEIPT_PENDING'
          || (action.manualRetryResumeAvailable === true
            && ['AGENT_ACTION_MANUAL_RETRY_REQUIRED', 'AGENT_ACTION_MANUAL_RETRY_UNAVAILABLE'].includes(caught.code ?? '')))
        && Boolean(receiptKey)
      if (retryReceiptPending) {
        persistActionUpdate(actionMessage, action.id, {
          status: 'failed',
          receiptIdempotencyKey: receiptKey,
          manualRetryResumeAvailable: true,
          error: locale === 'en'
            ? 'The one-time retry was authorized but did not start. Continue with the same attempt.'
            : '一次性重试已授权但尚未开始，请用同一次尝试继续执行。',
        })
        setRuntimePhase('failed')
        setError('')
        return
      }
      const originalReceiptNotStarted = intent === 'check_status'
        && caught instanceof ProductApiError
        && caught.code === 'AGENT_ACTION_RECONCILIATION_NOT_FOUND'
        && !action.receiptIdempotencyKey
      if (originalReceiptNotStarted) {
        persistActionUpdate(actionMessage, action.id, {
          status: 'awaiting_confirmation',
          manualRetryResumeAvailable: undefined,
          error: locale === 'en'
            ? 'The previous attempt did not start. Approve it again to continue.'
            : '上次尝试尚未开始，请重新确认执行。',
        })
        setRuntimePhase('failed')
        setError('')
        return
      }
      if (approvalFailed && (intent === 'execute' || intent === 'manual_retry')) {
        persistActionUpdate(actionMessage, action.id, {
          status: action.status,
          error: undefined,
          ...(action.receiptIdempotencyKey ? { receiptIdempotencyKey: action.receiptIdempotencyKey } : {}),
          ...(action.manualRetryResumeAvailable ? { manualRetryResumeAvailable: true } : {}),
        })
      } else if (intent === 'execute' || intent === 'manual_retry') {
        persistActionUpdate(actionMessage, action.id, {
          status: actionStatus,
          error: actionError,
          ...(manualRetryRejected ? { manualRetryResumeAvailable: undefined } : {}),
        })
      }
      if (intent === 'manual_retry' && !approvalFailed) setManualRetryAuthorizations((current) => {
        if (!current[key]) return current
        const next = { ...current }
        delete next[key]
        return next
      })
      setRuntimePhase(!approvalFailed && actionStatus === 'running' ? 'executing' : 'failed')
      setError(actionError)
    } finally {
      if (executingActionIdRef.current === action.id) executingActionIdRef.current = ''
      setExecutingActionId('')
    }
  }

  return { executingActionId, confirmAction, manualRetryAuthorization }
}
