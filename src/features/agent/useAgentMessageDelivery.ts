import { useCallback, useEffect, useMemo, useState } from 'react'
import { appendBotanicAgentMessage, type BotanicAgentMessage, type BotanicAgentSession } from '../../domain/agent'
import { submitPersistentBotanicAgentMessage } from '../../lib/agentApi'
import { createAgentMessageQueue, createLocalStorageAgentMessageQueueStorage } from '../../lib/agentMessageQueue'
import { serverPersistenceEnabled } from '../../lib/productSession'

type AgentMessagePatch = Partial<Pick<BotanicAgentMessage, 'content' | 'runId' | 'status' | 'feedback' | 'plan' | 'question' | 'deliveryStatus'>>

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
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine)
  const queue = useMemo(() => createAgentMessageQueue({
    storage: createLocalStorageAgentMessageQueueStorage(projectId),
    deliver: async (item) => { await submitPersistentBotanicAgentMessage(item) },
  }), [projectId])

  const flush = useCallback(async () => {
    const queued = new Map(queue.list().map((item) => [item.message.id, item.session.id]))
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
  }, [isCurrentProject, onUpdateMessage, queue])

  useEffect(() => {
    if (!serverPersistenceEnabled) return
    return queue.subscribe((items) => {
      for (const item of items) {
        onUpdateMessage(item.session.id, item.message.id, {
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

  const appendMessage = useCallback((message: Omit<BotanicAgentMessage, 'id' | 'createdAt'> & { id?: string }) => {
    if (!session || !isCurrentProject()) return ''
    const messageId = message.id?.trim() || `agent-message-${crypto.randomUUID()}`
    const queuedMessage: BotanicAgentMessage = {
      ...message,
      id: messageId,
      createdAt: Date.now(),
      deliveryStatus: serverPersistenceEnabled ? online ? 'queued' : 'waiting_network' : 'synced',
    }
    const queuedSession = appendBotanicAgentMessage(session, queuedMessage)
    onAppendMessage(session.id, queuedMessage)
    if (!serverPersistenceEnabled) return messageId
    queue.enqueue({
      projectId,
      session: queuedSession,
      message: queuedMessage,
      idempotencyKey: `agent-message-${messageId}`,
    })
    if (navigator.onLine) void flush()
    return messageId
  }, [flush, isCurrentProject, onAppendMessage, online, projectId, queue, session])

  const retryMessage = useCallback((messageId: string) => {
    const item = queue.retry(messageId)
    if (!item || !isCurrentProject()) return
    onUpdateMessage(item.session.id, messageId, { deliveryStatus: online ? 'queued' : 'waiting_network' })
    if (online) void flush()
  }, [flush, isCurrentProject, onUpdateMessage, online, queue])

  return { appendMessage, retryMessage }
}
