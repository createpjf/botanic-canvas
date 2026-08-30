import { useEffect, useRef, useState } from 'react'
import type { BotanicAgentMessage, BotanicAgentRun, BotanicAgentSession } from '../../domain/agent'
import { botanicAgentRunReviewMessageId } from '../../domain/agentReviewContract'
import { formatAgentReviewTaskProjectionMessage } from '../../domain/agentReviewPresentation'
import type { ProductLocale } from '../../i18n/core'
import { fetchAgentReviewTasks } from '../../lib/agentApi'
import { serverPersistenceEnabled } from '../../lib/productSession'
import { loadAgentReviewProjection } from './agentReviewProjection'

type AppendMessage = (
  message: Omit<BotanicAgentMessage, 'id' | 'createdAt'> & { id?: string; createdAt?: number },
) => string

export function useAgentReviewProjection(input: {
  session?: BotanicAgentSession
  latestRun?: BotanicAgentRun
  locale: ProductLocale
  isCurrentProject: () => boolean
  appendMessage: AppendMessage
}) {
  const [retryEpoch, setRetryEpoch] = useState(0)
  const [failedRunId, setFailedRunId] = useState('')
  const requested = useRef(new Set<string>())
  const attempts = useRef(new Map<string, number>())
  const { appendMessage, isCurrentProject, latestRun, locale, session } = input

  useEffect(() => {
    if (!serverPersistenceEnabled || !session || !latestRun) return
    if (!['completed', 'partial'].includes(latestRun.status)) return
    if (!session.messages.some((message) => message.runId === latestRun.id)) return
    const messageId = botanicAgentRunReviewMessageId(latestRun.id)
    if (session.messages.some((message) => message.id === messageId)) return
    const requestKey = `${latestRun.id}:${latestRun.status}:${latestRun.updatedAt}`
    let active = true
    let timer: number | undefined
    const retryLater = (delay: number) => {
      timer = window.setTimeout(() => setRetryEpoch((value) => value + 1), delay)
    }
    void loadAgentReviewProjection({
      requestKey,
      requested: requested.current,
      read: () => fetchAgentReviewTasks(latestRun.id),
    }).then((result) => {
      if (!active || !isCurrentProject()) return
      if (result.kind === 'ready') {
        attempts.current.delete(requestKey)
        setFailedRunId((current) => current === latestRun.id ? '' : current)
        appendMessage({
          id: messageId, role: 'assistant', kind: 'text', runId: latestRun.id,
          content: formatAgentReviewTaskProjectionMessage(result.task, locale),
        })
        return
      }
      if (result.kind === 'duplicate') return
      if (result.kind === 'pending' && result.task) return retryLater(2_500)
      const count = (attempts.current.get(requestKey) ?? 0) + 1
      attempts.current.set(requestKey, count)
      if ((result.kind === 'pending' && count <= 3) || (result.kind === 'retry' && count < 3)) {
        return retryLater(500 * (2 ** (count - 1)))
      }
      requested.current.add(requestKey)
      if (result.kind !== 'pending') setFailedRunId(latestRun.id)
    })
    return () => { active = false; if (timer) window.clearTimeout(timer) }
  }, [appendMessage, isCurrentProject, latestRun, locale, retryEpoch, session])

  return {
    failed: failedRunId === latestRun?.id,
    retry() {
      if (!latestRun) return
      const key = `${latestRun.id}:${latestRun.status}:${latestRun.updatedAt}`
      requested.current.delete(key)
      attempts.current.delete(key)
      setFailedRunId('')
      setRetryEpoch((value) => value + 1)
    },
  }
}
