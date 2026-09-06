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
  onUpsertMessage,
}: {
  projectId: string
  session?: BotanicAgentSession
  isCurrentProject: () => boolean
  onAppendMessage: (sessionId: string, message: BotanicAgentMessage) => void
  onUpdateMessage: (sessionId: string, messageId: string, patch: AgentMessagePatch) => void
  onUpsertMessage: (sessionId: string, message: BotanicAgentMessage) => void
}) {
  const { locale } = useProductI18n()
  const localeRef = useRef(locale)
  const currentSessionId = useRef(session?.id)
  currentSessionId.current = session?.id
  useEffect(() => { localeRef.current = locale }, [locale])
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine)
  const queue = useMemo(() => createAgentMessageQueue({
    storage: createLocalStorageAgentMessageQueueStorage(projectId),
    deliver: async (item) => {
      try {
        return await submitPersistentBotanicAgentMessage(item)
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
      const receipt = result.receipts?.find((item) => item.sessionId === sessionId && item.message.id === messageId)
      // 旧会话的异步回执不切换当前会话；再次进入时由独立 Message API 加载。
      if (receipt && sessionId === currentSessionId.current) onUpsertMessage(receipt.sessionId, { ...receipt.message, deliveryStatus: 'synced' })
      else if (sessionId) onUpdateMessage(sessionId, messageId, { deliveryStatus: 'synced' })
    }
    for (const messageId of result.failed) {
      const sessionId = queued.get(messageId)
      if (sessionId) onUpdateMessage(sessionId, messageId, { deliveryStatus: 'failed' })
    }
    return result
  }, [isCurrentProject, onUpdateMessage, onUpsertMessage, queue])

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

  /**
   * enqueue 的唯一入口：本地持久化失败返回错误而不是抛出。
   * 消息此前已进 UI，这里把它标记为 failed，让用户走现有重试入口；
   * 抛出会变成事件处理器里的未捕获异常，消息则永远停在「排队中」。
   */
  const enqueueSafely = useCallback((sessionId: string, message: BotanicAgentMessage): Error | undefined => {
    try {
      queue.enqueue({
        projectId,
        sessionId,
        message,
        idempotencyKey: `agent-message-${message.id}`,
      })
      return undefined
    } catch (caught) {
      if (isCurrentProject()) onUpdateMessage(sessionId, message.id, { deliveryStatus: 'failed' })
      return caught instanceof Error ? caught : new Error('消息本地持久化失败，请重试。')
    }
  }, [isCurrentProject, onUpdateMessage, projectId, queue])

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
    // 入队失败时消息已标记 failed 且可重试；仍返回 messageId，调用方语义不变。
    if (!enqueueSafely(session.id, queuedMessage) && navigator.onLine) void flush()
    return messageId
  }, [enqueueSafely, flush, isCurrentProject, onAppendMessage, online, session])

  const persistMessage = useCallback((message: BotanicAgentMessage) => {
    if (!session || !isCurrentProject() || !serverPersistenceEnabled) return
    const queuedMessage: BotanicAgentMessage = {
      ...message,
      deliveryStatus: online ? 'queued' : 'waiting_network',
    }
    const failure = enqueueSafely(session.id, queuedMessage)
    if (!failure && navigator.onLine) void flush()
    return failure
  }, [enqueueSafely, flush, isCurrentProject, online, session])

  const retryMessage = useCallback((messageId: string) => {
    const item = queue.retry(messageId)
    if (!item || !isCurrentProject()) return
    onUpdateMessage(item.sessionId, messageId, { deliveryStatus: online ? 'queued' : 'waiting_network' })
    if (online) void flush()
  }, [flush, isCurrentProject, onUpdateMessage, online, queue])

  const discardMessage = useCallback((messageId: string) => {
    const item = queue.discard(messageId)
    if (!item || !isCurrentProject()) return
    onUpdateMessage(item.sessionId, messageId, { deliveryStatus: undefined })
  }, [isCurrentProject, onUpdateMessage, queue])

  const ensureMessageDurable = useCallback(async (message: BotanicAgentMessage) => {
    // 恢复路径重新 enqueue 同一 Message 操作，不依赖上次本地队列恰好还在。
    // enqueue 失败必须在此冒泡：消息不在队列里时，下面的送达断言会因
    // 「找不到 pending 项」误判为已送达，放行一个输入并未持久化的 Turn。
    if (!session) throw new Error('会话不存在，无法持久化消息。')
    if (!isCurrentProject()) throw new Error('项目已切换，已停止提交。')
    if (!serverPersistenceEnabled) return message
    const failure = enqueueSafely(session.id, {
      ...message,
      deliveryStatus: online ? 'queued' : 'waiting_network',
    })
    if (failure) throw failure
    const result = await flush()
    assertAgentMessageQueueItemDelivered(queue, message.id)
    const accepted = result?.receipts?.find((item) => item.sessionId === session.id && item.message.id === message.id)?.message
    if (!accepted) throw Object.assign(new Error('未收到消息保存回执，请重试。'), { code: 'AGENT_MESSAGE_NOT_DURABLE', status: 0 })
    return accepted
  }, [enqueueSafely, flush, isCurrentProject, online, queue, session])

  return { appendMessage, persistMessage, retryMessage, discardMessage, ensureMessageDurable }
}
