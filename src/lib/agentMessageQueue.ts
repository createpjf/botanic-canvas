import type { BotanicAgentMessage, BotanicAgentSession } from '../domain/agent'

export type AgentMessageQueueStatus = 'queued' | 'sending' | 'failed'

export type AgentMessageQueueInput = {
  projectId: string
  session: BotanicAgentSession
  message: BotanicAgentMessage
  idempotencyKey: string
}

export type AgentMessageQueueItem = AgentMessageQueueInput & {
  key: string
  status: AgentMessageQueueStatus
  attempts: number
  queuedAt: number
  lastAttemptAt?: number
  error?: string
  errorCode?: string
}

export type AgentMessageQueueFlushResult = {
  delivered: string[]
  failed: string[]
  pending: string[]
}

export type AgentMessageQueueStorage = {
  read: () => string | null
  write: (value: string) => void
}

type QueueError = Error & { status?: number; code?: string }

type AgentMessageQueueOptions = {
  storage?: AgentMessageQueueStorage
  deliver: (item: AgentMessageQueueItem) => Promise<void>
  now?: () => number
  isRetryableError?: (error: unknown) => boolean
}

const storageKey = 'botanic:agent-message-queue:v1'

function itemKey(input: Pick<AgentMessageQueueInput, 'projectId' | 'session' | 'message'>) {
  return `${input.projectId}\u0000${input.session.id}\u0000${input.message.id}`
}

export function createLocalStorageAgentMessageQueueStorage(namespace = 'workspace'): AgentMessageQueueStorage {
  const scopedKey = `${storageKey}:${namespace}`
  return {
    read: () => globalThis.localStorage?.getItem(scopedKey) ?? null,
    write: (value) => globalThis.localStorage?.setItem(scopedKey, value),
  }
}

function load(storage: AgentMessageQueueStorage): AgentMessageQueueItem[] {
  try {
    const parsed = JSON.parse(storage.read() || '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((value) => {
      if (!value || typeof value !== 'object') return []
      const item = value as Partial<AgentMessageQueueItem>
      if (!item.projectId || !item.session?.id || !item.message?.id || !item.idempotencyKey) return []
      return [{
        ...item,
        key: itemKey(item as AgentMessageQueueInput),
        status: item.status === 'failed' ? 'failed' : 'queued',
        attempts: Number.isFinite(item.attempts) ? Math.max(0, Number(item.attempts)) : 0,
        queuedAt: Number.isFinite(item.queuedAt) ? Number(item.queuedAt) : Number(item.message.createdAt) || 0,
      } as AgentMessageQueueItem]
    })
  } catch {
    return []
  }
}

function defaultRetryableError(error: unknown) {
  const candidate = error as Partial<QueueError> | undefined
  const status = Number(candidate?.status)
  return status === 0
    || status === 408
    || status === 425
    || status === 429
    || status >= 500
    || candidate?.code === 'REQUEST_TIMEOUT'
}

export function createAgentMessageQueue(options: AgentMessageQueueOptions) {
  const storage = options.storage ?? createLocalStorageAgentMessageQueueStorage()
  const now = options.now ?? Date.now
  const isRetryableError = options.isRetryableError ?? defaultRetryableError
  let items = load(storage)
  let flushPromise: Promise<AgentMessageQueueFlushResult> | undefined
  const listeners = new Set<(items: AgentMessageQueueItem[]) => void>()

  const snapshot = () => items
    .slice()
    .sort((left, right) => left.queuedAt - right.queuedAt || left.message.createdAt - right.message.createdAt)
    .map((item) => structuredClone(item))

  const persist = () => {
    try { storage.write(JSON.stringify(items)) } catch { /* Indexed/browser quota failures must not block the live chat. */ }
    const next = snapshot()
    for (const listener of listeners) listener(next)
  }

  const enqueue = (input: AgentMessageQueueInput) => {
    const key = itemKey(input)
    const existing = items.find((item) => item.key === key || item.idempotencyKey === input.idempotencyKey)
    if (existing) return structuredClone(existing)
    const item: AgentMessageQueueItem = {
      ...structuredClone(input),
      key,
      status: 'queued',
      attempts: 0,
      queuedAt: now(),
    }
    items.push(item)
    persist()
    return structuredClone(item)
  }

  const flush = () => {
    if (flushPromise) return flushPromise
    flushPromise = (async () => {
      const delivered: string[] = []
      const ordered = items
        .filter((item) => item.status !== 'failed')
        .sort((left, right) => left.queuedAt - right.queuedAt || left.message.createdAt - right.message.createdAt)

      for (const current of ordered) {
        const item = items.find((candidate) => candidate.key === current.key)
        if (!item || item.status === 'failed') continue
        item.status = 'sending'
        item.attempts += 1
        item.lastAttemptAt = now()
        item.error = undefined
        item.errorCode = undefined
        persist()
        try {
          await options.deliver(structuredClone(item))
          delivered.push(item.message.id)
          items = items.filter((candidate) => candidate.key !== item.key)
          persist()
        } catch (error) {
          const candidate = error as Partial<QueueError> | undefined
          item.error = error instanceof Error ? error.message : '消息发送失败。'
          item.errorCode = candidate?.code
          if (isRetryableError(error)) {
            item.status = 'queued'
            persist()
            break
          }
          item.status = 'failed'
          persist()
        }
      }

      const result: AgentMessageQueueFlushResult = {
        delivered,
        failed: snapshot().filter((item) => item.status === 'failed').map((item) => item.message.id),
        pending: snapshot().filter((item) => item.status !== 'failed').map((item) => item.message.id),
      }
      return result
    })().finally(() => { flushPromise = undefined })
    return flushPromise
  }

  return {
    enqueue,
    flush,
    list: snapshot,
    subscribe(listener: (items: AgentMessageQueueItem[]) => void) {
      listeners.add(listener)
      listener(snapshot())
      return () => { listeners.delete(listener) }
    },
  }
}

export type AgentMessageQueue = ReturnType<typeof createAgentMessageQueue>
