import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BotanicAgentMessage, BotanicAgentSession } from '../../domain/agent'
import { submitPersistentBotanicAgentMessage } from '../../lib/agentApi'
import { assertAgentMessageQueueItemDelivered, createAgentMessageQueue, createLocalStorageAgentMessageQueueStorage } from '../../lib/agentMessageQueue'
import { serverPersistenceEnabled } from '../../lib/productSession'
import { localizeProductError, type ProductLocale } from '../../i18n/core'
import { useProductI18n } from '../../i18n/react'

type AgentMessagePatch = Partial<Pick<BotanicAgentMessage, 'kind' | 'content' | 'runId' | 'status' | 'feedback' | 'plan' | 'question' | 'composition' | 'deliveryStatus' | 'turnId' | 'turnCancellationRequestedAt' | 'turnRequestSnapshot' | 'sourceMessageId' | 'sourceNodeIds' | 'targetArtifactVersionId' | 'planFingerprint'>>
type AgentDeliveryError = Error & { status?: number; code?: string }

function localizedAgentDeliveryError(error: unknown, locale: ProductLocale): AgentDeliveryError {
  const source = error && typeof error === 'object' ? error as Partial<AgentDeliveryError> : undefined
  const localized = new Error(localizeProductError(error, locale, {
    'zh-CN': '消息同步失败，请重试。',
    en: 'Unable to sync the message. Try again.',
  })) as AgentDeliveryError
  if (typeof source?.status === 'number') localized.status = source.status
  if (typeof source?.code === 'string') localized.code = source.code
  return localized
}

/**
 * Agent 消息的本地追加、离线排队与联网重放模块。
 * UI 只追加消息；队列状态与持久化重试不会泄漏到工作区组件。
 */
export function useAgentMessageDelivery({
  projectId,
  session,
  isCurrentProject,
  onAppendMessage,
  onUpdateMessage,
}: {
  projectId: string
  session?: BotanicAgentSession
  isCurrentProject: () => boolean
  onAppendMessage: (sessionId: string, message: BotanicAgentMessage) => void
  onUpdateMessage: (sessionId: string, messageId: string, patch: AgentMessagePatch) => void
}) {
  const { locale } = useProductI18n()
  const localeRef = useRef(locale)
  useEffect(() => { localeRef.current = locale }, [locale])
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine)
  const queue = useMemo(() => createAgentMessageQueue({
    storage: createLocalStorageAgentMessageQueueStorage(projectId),
    deliver: async (item) => {
      try {
        await submitPersistentBotanicAgentMessage(item)
      } catch (caught) {
        throw localizedAgentDeliveryError(caught, localeRef.current)
      }
    },
  }), [projectId])

  const flush = useCallback(async () => {
    const queued = new Map(queue.list().map((item) => [item.message.id, item.sessionId]))
    const result = await queue.flush()
    if (!isCurrentProject()) return
    for (const messageId of result.delivered) {
      const sessionId = queued.get(messageId)
      if (sessionId) onUpdateMessage(sessionId, messageId, { deliveryStatus: 'synced' })
    }
    for (const messageId of result.failed) {
      const sessionId = queued.get(messageId)
      if (sessionId) onUpdateMessage(sessionId, messageId, { deliveryStatus: 'failed' })
    }
    return result
  }, [isCurrentProject, onUpdateMessage, queue])

  useEffect(() => {
    if (!serverPersistenceEnabled) return
    return queue.subscribe((items) => {
      for (const item of items) {
        onUpdateMessage(item.sessionId, item.message.id, {
          deliveryStatus: item.status === 'failed'
            ? 'failed'
            : item.status === 'sending'
              ? 'syncing'
              : online
                ? 'queued'
                : 'waiting_network',
        })
      }
    })
  }, [onUpdateMessage, online, queue])

  useEffect(() => {
    if (!serverPersistenceEnabled) return
    const replay = () => {
      const isOnline = navigator.onLine
      setOnline(isOnline)
      if (isOnline) void flush()
    }
    const markOffline = () => setOnline(false)
    if (navigator.onLine) replay()
    else markOffline()
    window.addEventListener('online', replay)
    window.addEventListener('offline', markOffline)
    window.addEventListener('focus', replay)
    return () => {
      window.removeEventListener('online', replay)
      window.removeEventListener('offline', markOffline)
      window.removeEventListener('focus', replay)
    }
  }, [flush])

  const appendMessage = useCallback((message: Omit<BotanicAgentMessage, 'id' | 'createdAt'> & { id?: string; createdAt?: number }) => {
    if (!session || !isCurrentProject()) return ''
    const messageId = message.id?.trim() || `agent-message-${crypto.randomUUID()}`
    const queuedMessage: BotanicAgentMessage = {
      ...message,
      id: messageId,
      createdAt: message.createdAt ?? Date.now(),
      deliveryStatus: serverPersistenceEnabled ? online ? 'queued' : 'waiting_network' : 'synced',
    }
    onAppendMessage(session.id, queuedMessage)
    if (!serverPersistenceEnabled) return messageId
    queue.enqueue({
      projectId,
      sessionId: session.id,
      message: queuedMessage,
      idempotencyKey: `agent-message-${messageId}`,
    })
    if (navigator.onLine) void flush()
    return messageId
  }, [flush, isCurrentProject, onAppendMessage, online, projectId, queue, session])

  const persistMessage = useCallback((message: BotanicAgentMessage) => {
    if (!session || !isCurrentProject() || !serverPersistenceEnabled) return
    const queuedMessage: BotanicAgentMessage = {
      ...message,
      deliveryStatus: online ? 'queued' : 'waiting_network',
    }
    queue.enqueue({
      projectId,
      sessionId: session.id,
      message: queuedMessage,
      idempotencyKey: `agent-message-${queuedMessage.id}`,
    })
    if (navigator.onLine) void flush()
  }, [flush, isCurrentProject, online, projectId, queue, session])

  const retryMessage = useCallback((messageId: string) => {
    const item = queue.retry(messageId)
    if (!item || !isCurrentProject()) return
    onUpdateMessage(item.sessionId, messageId, { deliveryStatus: online ? 'queued' : 'waiting_network' })
    if (online) void flush()
  }, [flush, isCurrentProject, onUpdateMessage, online, queue])

  const ensureMessageDurable = useCallback(async (message: BotanicAgentMessage) => {
    // 恢复路径重新 enqueue 同一 Message 操作，不依赖上次本地队列恰好还在。
    persistMessage(message)
    await flush()
    assertAgentMessageQueueItemDelivered(queue, message.id)
  }, [flush, persistMessage, queue])

  return { appendMessage, persistMessage, retryMessage, ensureMessageDurable }
}
