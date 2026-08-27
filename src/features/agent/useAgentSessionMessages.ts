import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BotanicAgentMessage } from '../../domain/agent'
import { listPersistentBotanicAgentSessionMessages } from '../../lib/agentApi'
import { serverPersistenceEnabled } from '../../lib/productSession'

function mergeAgentMessages(apiMessages: BotanicAgentMessage[], storeMessages: BotanicAgentMessage[]) {
  const byId = new Map(apiMessages.map((message) => [message.id, message]))
  for (const message of storeMessages) {
    const existing = byId.get(message.id)
    const messageTime = Number(message.updatedAt ?? message.createdAt ?? 0)
    const existingTime = Number(existing?.updatedAt ?? existing?.createdAt ?? 0)
    if (!existing || messageTime >= existingTime) byId.set(message.id, message)
  }
  return [...byId.values()].sort((left, right) => Number(left.createdAt ?? 0) - Number(right.createdAt ?? 0) || left.id.localeCompare(right.id))
}

export function useAgentSessionMessages(
  projectId: string,
  sessionId: string | undefined,
  storeMessages: BotanicAgentMessage[],
  enabled = true,
) {
  const [apiMessages, setApiMessages] = useState<BotanicAgentMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [nextBefore, setNextBefore] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()

  const refresh = useCallback(async () => {
    if (!enabled || !sessionId || !serverPersistenceEnabled) {
      setApiMessages([])
      setNextBefore(undefined)
      return
    }
    setLoading(true)
    setError(undefined)
    try {
      const page = await listPersistentBotanicAgentSessionMessages(projectId, sessionId, { limit: 50 })
      setApiMessages(page.messages)
      setNextBefore(page.nextBefore)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }, [enabled, projectId, sessionId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const loadOlderMessages = useCallback(async () => {
    if (!enabled || !sessionId || !serverPersistenceEnabled || !nextBefore || loadingOlder) return
    setLoadingOlder(true)
    try {
      const page = await listPersistentBotanicAgentSessionMessages(projectId, sessionId, { limit: 50, before: nextBefore })
      setApiMessages((current) => mergeAgentMessages(current, page.messages))
      setNextBefore(page.nextBefore)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoadingOlder(false)
    }
  }, [enabled, loadingOlder, nextBefore, projectId, sessionId])

  const messages = useMemo(
    () => mergeAgentMessages(apiMessages, storeMessages),
    [apiMessages, storeMessages],
  )

  return {
    messages,
    loading,
    loadingOlder,
    hasOlderMessages: Boolean(nextBefore),
    loadOlderMessages,
    error,
    refresh,
  }
}
