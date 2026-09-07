import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BotanicAgentMessage, BotanicAgentRun } from '../../domain/agent'
import { mergeAgentMessages } from '../../domain/agentMessageReadModel'
import { listPersistentBotanicAgentSessionMessages } from '../../lib/agentApi'
import { serverPersistenceEnabled } from '../../lib/productSession'

type MessageCache = { key: string; messages: BotanicAgentMessage[]; nextBefore?: string }
type MessageRead = { key: string; controller: AbortController; promise: Promise<void>; dirty: boolean }

export function useAgentSessionMessages(
  projectId: string,
  sessionId: string | undefined,
  source: { messages: BotanicAgentMessage[]; runs: BotanicAgentRun[]; prepare?: (projectId: string, sessionId: string) => Promise<void> },
  enabled = true,
) {
  const { messages: storeMessages, runs, prepare } = source
  const key = sessionId ? projectId + '\u0000' + sessionId : ''
  const currentKey = useRef(key)
  currentKey.current = key
  const [cache, setCache] = useState<MessageCache>({ key: '', messages: [] })
  const cached = useRef(cache)
  const [loading, setLoading] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [failure, setFailure] = useState<unknown>()
  const reading = useRef<MessageRead | null>(null)
  const readingOlder = useRef<MessageRead | null>(null)
  const publish = useCallback((next: MessageCache) => {
    cached.current = next
    setCache(next)
  }, [])

  const refresh = useCallback((signal?: AbortSignal, invalidated = false): Promise<void> => {
    if (!enabled || !sessionId || !serverPersistenceEnabled || signal?.aborted || currentKey.current !== key) return Promise.resolve()
    const pending = reading.current
    if (pending?.key === key && !pending.controller.signal.aborted) {
      if (invalidated) pending.dirty = true
      return pending.promise
    }
    pending?.controller.abort()
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    const request: MessageRead = { key, controller, dirty: false, promise: Promise.resolve() }
    reading.current = request
    const active = () => currentKey.current === key && !controller.signal.aborted && reading.current === request
    setLoading(true)
    setFailure(undefined)
    request.promise = (async () => {
      try {
        if (prepare) await prepare(projectId, sessionId)
        if (!active()) return
        do {
          request.dirty = false
          const baseline = cached.current.key === key ? cached.current : undefined
          const known = new Map(baseline?.messages.map(message => [message.id, message]))
          let page = await listPersistentBotanicAgentSessionMessages(projectId, sessionId, { limit: 50, signal: controller.signal })
          let incoming = page.messages
          const overlaps = () => page.messages.some(message => {
            const previous = known.get(message.id)
            return previous && (message.updatedAt ?? message.createdAt) <= (previous.updatedAt ?? previous.createdAt)
          })
          // 离线期间可能新增超过一页；接回未变化的历史边界，不能跳过中间消息。
          const cursors = new Set<string>()
          while (active() && known.size && !overlaps() && page.nextBefore) {
            if (cursors.has(page.nextBefore)) throw new Error('消息分页未推进，请重试。')
            cursors.add(page.nextBefore)
            page = await listPersistentBotanicAgentSessionMessages(projectId, sessionId, { limit: 50, before: page.nextBefore, signal: controller.signal })
            incoming = mergeAgentMessages(incoming, page.messages)
          }
          if (!active()) return
          const current = cached.current.key === key ? cached.current : undefined
          publish({
            key,
            messages: mergeAgentMessages(current?.messages ?? [], incoming),
            nextBefore: baseline && known.size && overlaps() ? current?.nextBefore : page.nextBefore,
          })
        } while (active() && request.dirty)
      } catch (caught) {
        if (!active() || (caught instanceof Error && caught.name === 'AbortError')) return
        setFailure(caught)
        throw caught
      } finally {
        signal?.removeEventListener('abort', abort)
        if (reading.current === request) {
          reading.current = null
          setLoading(false)
        }
      }
    })()
    return request.promise
  }, [enabled, key, prepare, projectId, publish, sessionId])

  const invalidate = useCallback(() => refresh(undefined, true), [refresh])
  const refreshFromRemote = useCallback((invalidated = false) => refresh(undefined, invalidated), [refresh])

  useEffect(() => {
    if (cached.current.key !== key) publish({ key: '', messages: [] })
    setFailure(undefined)
    setLoading(false)
    setLoadingOlder(false)
    const controller = new AbortController()
    void refresh(controller.signal).catch(() => undefined)
    const retry = () => { if (document.visibilityState === 'visible') void refresh(controller.signal).catch(() => undefined) }
    window.addEventListener('online', retry)
    window.addEventListener('focus', retry)
    document.addEventListener('visibilitychange', retry)
    return () => {
      controller.abort()
      reading.current?.controller.abort()
      readingOlder.current?.controller.abort()
      reading.current = null
      readingOlder.current = null
      window.removeEventListener('online', retry)
      window.removeEventListener('focus', retry)
      document.removeEventListener('visibilitychange', retry)
    }
  }, [key, publish, refresh])

  const loadOlderMessages = useCallback((): Promise<void> => {
    const before = cached.current.key === key ? cached.current.nextBefore : undefined
    if (!enabled || !sessionId || !serverPersistenceEnabled || !before || currentKey.current !== key) return Promise.resolve()
    if (readingOlder.current?.key === key) return readingOlder.current.promise
    readingOlder.current?.controller.abort()
    const controller = new AbortController()
    const request: MessageRead = { key, controller, dirty: false, promise: Promise.resolve() }
    readingOlder.current = request
    const active = () => currentKey.current === key && !controller.signal.aborted && readingOlder.current === request
    setLoadingOlder(true)
    request.promise = (async () => {
      try {
        const page = await listPersistentBotanicAgentSessionMessages(projectId, sessionId, { limit: 50, before, signal: controller.signal })
        if (!active()) return
        const current = cached.current
        publish({ key, messages: mergeAgentMessages(current.messages, page.messages),
          nextBefore: current.nextBefore === before ? page.nextBefore : current.nextBefore })
        setFailure(undefined)
      } catch (caught) {
        if (active() && !(caught instanceof Error && caught.name === 'AbortError')) setFailure(caught)
      } finally {
        if (readingOlder.current === request) {
          readingOlder.current = null
          setLoadingOlder(false)
        }
      }
    })()
    return request.promise
  }, [enabled, key, projectId, publish, sessionId])

  const messages = useMemo(
    () => mergeAgentMessages(cache.key === key ? cache.messages : [], storeMessages, runs),
    [cache, key, storeMessages, runs],
  )

  return {
    messages, loading, loadingOlder,
    hasOlderMessages: cache.key === key && Boolean(cache.nextBefore),
    loadOlderMessages,
    error: failure === undefined ? undefined : failure instanceof Error ? failure.message : String(failure),
    failure, refresh, invalidate, refreshFromRemote,
  }
}
