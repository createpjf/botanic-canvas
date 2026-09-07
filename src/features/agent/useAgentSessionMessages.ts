import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BotanicAgentMessage, BotanicAgentRun } from '../../domain/agent'
import { mergeAgentMessages } from '../../domain/agentMessageReadModel'
import { createLatestOperation } from '../../domain/latestOperation'
import { listPersistentBotanicAgentSessionMessages } from '../../lib/agentApi'
import { serverPersistenceEnabled } from '../../lib/productSession'

export function useAgentSessionMessages(
  projectId: string,
  sessionId: string | undefined,
  source: { messages: BotanicAgentMessage[]; runs: BotanicAgentRun[] },
  enabled = true,
) {
  const { messages: storeMessages, runs } = source
  const [apiMessages, setApiMessages] = useState<BotanicAgentMessage[]>([])
  const [loadedSessionId, setLoadedSessionId] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [nextBefore, setNextBefore] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const reads = useRef(createLatestOperation())
  const sessionIdRef = useRef(sessionId)
  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const token = reads.current.begin()
    if (!enabled || !sessionId || !serverPersistenceEnabled) {
      setApiMessages([])
      setLoadedSessionId(undefined)
      setNextBefore(undefined)
      setLoading(false)
      setError(undefined)
      return
    }
    setLoading(true)
    setError(undefined)
    try {
      const page = await listPersistentBotanicAgentSessionMessages(projectId, sessionId, { limit: 50, signal })
      if (signal?.aborted || !reads.current.isCurrent(token)) return
      setApiMessages(page.messages)
      setLoadedSessionId(sessionId)
      setNextBefore(page.nextBefore)
    } catch (caught) {
      if (signal?.aborted || !reads.current.isCurrent(token) || (caught instanceof Error && caught.name === 'AbortError')) return
      setError(caught instanceof Error ? caught.message : String(caught))
      throw caught
    } finally {
      if (reads.current.isCurrent(token)) setLoading(false)
    }
  }, [enabled, projectId, sessionId])

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal).catch(() => undefined)
    const retry = () => { if (document.visibilityState === 'visible') void refresh(controller.signal).catch(() => undefined) }
    window.addEventListener('online', retry)
    window.addEventListener('focus', retry)
    document.addEventListener('visibilitychange', retry)
    return () => {
      controller.abort()
      reads.current.invalidate()
      window.removeEventListener('online', retry)
      window.removeEventListener('focus', retry)
      document.removeEventListener('visibilitychange', retry)
    }
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
    () => mergeAgentMessages(loadedSessionId === sessionId ? apiMessages : [], storeMessages, runs),
    [apiMessages, loadedSessionId, sessionId, storeMessages, runs],
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
