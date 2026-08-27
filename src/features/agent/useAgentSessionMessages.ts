import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BotanicAgentMessage } from '../../domain/agent'
import { mergeAgentMessages } from '../../domain/agentMessageReadModel'
import { listPersistentBotanicAgentSessionMessages } from '../../lib/agentApi'
import { serverPersistenceEnabled } from '../../lib/productSession'

export function useAgentSessionMessages(
  projectId: string,
  sessionId: string | undefined,
  storeMessages: BotanicAgentMessage[],
  enabled = true,
) {
  const [apiMessages, setApiMessages] = useState<BotanicAgentMessage[]>([])
  const [loadedSessionId, setLoadedSessionId] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [nextBefore, setNextBefore] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const sessionIdRef = useRef(sessionId)
  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!enabled || !sessionId || !serverPersistenceEnabled) {
      setApiMessages([])
      setLoadedSessionId(undefined)
      setNextBefore(undefined)
      return
    }
    setLoading(true)
    setError(undefined)
    try {
      const page = await listPersistentBotanicAgentSessionMessages(projectId, sessionId, { limit: 50, signal })
      if (signal?.aborted || sessionIdRef.current !== sessionId) return
      setApiMessages(page.messages)
      setLoadedSessionId(sessionId)
      setNextBefore(page.nextBefore)
    } catch (caught) {
      if (signal?.aborted || (caught instanceof Error && caught.name === 'AbortError')) return
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [enabled, projectId, sessionId])

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [refresh])

  const loadOlderMessages = useCallback(async () => {
    if (!enabled || !sessionId || !serverPersistenceEnabled || !nextBefore || loadingOlder) return
    const requestedSessionId = sessionId
    setLoadingOlder(true)
    try {
      const page = await listPersistentBotanicAgentSessionMessages(projectId, requestedSessionId, { limit: 50, before: nextBefore })
      if (sessionIdRef.current !== requestedSessionId) return
      setApiMessages((current) => mergeAgentMessages(current, page.messages))
      setNextBefore(page.nextBefore)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoadingOlder(false)
    }
  }, [enabled, loadingOlder, nextBefore, projectId, sessionId])

  const messages = useMemo(
    () => mergeAgentMessages(loadedSessionId === sessionId ? apiMessages : [], storeMessages),
    [apiMessages, loadedSessionId, sessionId, storeMessages],
  )

  return {
    messages,
    loading,
    loadingOlder,
    hasOlderMessages: Boolean(nextBefore) && loadedSessionId === sessionId,
    loadOlderMessages,
    error,
    refresh,
  }
}
