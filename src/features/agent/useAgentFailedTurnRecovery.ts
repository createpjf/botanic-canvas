import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { listPersistentBotanicAgentRuns, readPersistentBotanicAgentTurnEvents } from '../../lib/agentApi'
import { localizeProductError, type ProductLocale } from '../../i18n/core'
import type { BotanicAgentMessage } from '../../domain/agent'
import type { resolveAgentPersistedFailedTurnRetry } from './agentComposerState'
import { failedAgentTurnRecoveryDecision } from './agentTurnRecovery'

type Retry = NonNullable<ReturnType<typeof resolveAgentPersistedFailedTurnRetry>>

/** 只协调恢复入口；运行状态仍由原 Turn/Run 和已有 observer 拥有。 */
export function useAgentFailedTurnRecovery(input: {
  projectId: string
  sessionId?: string
  locale: ProductLocale
  busy: boolean
  sending: MutableRefObject<boolean>
  onTask: (runId: string) => void
  onRetry: (retry: Retry) => Promise<unknown>
  onError: (message: string) => void
}) {
  const controllerRef = useRef<AbortController | null>(null)
  const [pending, setPending] = useState(false)
  const [observation, setObservation] = useState<{ scope: string; message: BotanicAgentMessage }>()
  const [issue, setIssue] = useState<{ scope: string; messageId: string; message: string; steps: string[] }>()
  const scope = `${input.projectId}:${input.sessionId ?? ''}`
  useEffect(() => () => {
    if (!controllerRef.current) return
    controllerRef.current.abort()
    controllerRef.current = null
    input.sending.current = false
  }, [scope, input.sending])
  useEffect(() => { setPending(false); setObservation(undefined); setIssue(undefined) }, [scope])

  const recover = async (retry: Retry) => {
    if (input.busy || input.sending.current || observation?.scope === scope || !retry.message.turnId) return
    const controller = new AbortController()
    controllerRef.current = controller
    input.sending.current = true
    setPending(true)
    setIssue(undefined)
    input.onError('')
    try {
      const [read, runs] = await Promise.all([
        readPersistentBotanicAgentTurnEvents(retry.message.turnId, input.projectId, { signal: controller.signal }),
        listPersistentBotanicAgentRuns(input.projectId, controller.signal),
      ])
      if (controller.signal.aborted) return
      const runId = read.turn?.linkedRunIds?.[0] ?? runs.find((run) => run.projectId === input.projectId
        && (run.id === retry.message.runId || run.turnId === retry.message.turnId))?.id ?? retry.message.runId
      const action = failedAgentTurnRecoveryDecision(read, runId)
      if (action === 'task') input.onTask(runId!)
      else if (action === 'observe') setObservation({ scope, message: { ...retry.sourceMessage, turnId: read.turn!.id } })
      else if (action === 'retry') await input.onRetry(retry)
      else setIssue({ scope, messageId: retry.message.id,
        message: action === 'inspect'
          ? input.locale === 'en' ? 'Outcome unknown. Verify the original task or target system before retrying.' : '结果未知，请先核对原任务或目标系统，暂不重试。'
          : input.locale === 'en' ? 'This turn cannot be replayed. Check the original action.' : '本轮不能直接重试，请核对原操作。',
        steps: [...new Set(read.events.flatMap((event) => event.type === 'tool' ? [event.toolCall.label] : []))].slice(-12),
      })
    } catch (caught) {
      if (!controller.signal.aborted) input.onError(localizeProductError(caught, input.locale, {
        'zh-CN': '无法读取原任务，请稍后重试。', en: 'Could not read the original task. Try again.',
      }))
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null
        input.sending.current = false
        if (!controller.signal.aborted) setPending(false)
      }
    }
  }
  return {
    recover, pending, issue: issue?.scope === scope ? issue : undefined,
    message: observation?.scope === scope ? observation.message : undefined,
    settled: (messageId: string) => setObservation((current) => current?.scope === scope && current.message.id === messageId ? undefined : current),
  }
}
