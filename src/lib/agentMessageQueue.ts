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
  errorStatus?: number
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

function compareQueueItems(left: AgentMessageQueueItem, right: AgentMessageQueueItem) {
  return left.message.createdAt - right.message.createdAt
    || left.queuedAt - right.queuedAt
    || left.key.localeCompare(right.key)
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
    .sort(compareQueueItems)
    .map((item) => structuredClone(item))

  const persist = () => {
    try { storage.write(JSON.stringify(items)) } catch { /* Indexed/browser quota failures must not block the live chat. */ }
    const next = snapshot()
    for (const listener of listeners) listener(next)
  }

  const enqueue = (input: AgentMessageQueueInput) => {
    const key = itemKey(input)
    const existing = items.find((item) => item.key === key || item.idempotencyKey === input.idempotencyKey)
    if (existing) {
      // 发送中的快照可能只是 running；后续终态必须留在同一队列项中，
      // 当前请求完成后再补送新版，刷新也能从本地队列恢复最后状态。
      existing.message = structuredClone(input.message)
      existing.session = structuredClone(input.session)
      existing.idempotencyKey = input.idempotencyKey
      persist()
      return structuredClone(existing)
    }
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
        .sort(compareQueueItems)

      let stopFlush = false
      for (const current of ordered) {
        let sendLatest = true
        while (sendLatest) {
          sendLatest = false
          const item = items.find((candidate) => candidate.key === current.key)
          if (!item || item.status === 'failed') break
          item.status = 'sending'
          item.attempts += 1
          item.lastAttemptAt = now()
          item.error = undefined
          item.errorCode = undefined
          persist()
          const deliverySnapshot = structuredClone(item)
          try {
            await options.deliver(deliverySnapshot)
            const latest = items.find((candidate) => candidate.key === item.key)
            if (!latest) break
            if (JSON.stringify(latest.message) !== JSON.stringify(deliverySnapshot.message)) {
              latest.status = 'queued'
              persist()
              sendLatest = true
              continue
            }
            delivered.push(latest.message.id)
            items = items.filter((candidate) => candidate.key !== latest.key)
            persist()
          } catch (error) {
            const latest = items.find((candidate) => candidate.key === item.key) ?? item
            const candidate = error as Partial<QueueError> | undefined
            latest.error = error instanceof Error ? error.message : '消息发送失败。'
            latest.errorCode = candidate?.code
            latest.errorStatus = typeof candidate?.status === 'number' ? candidate.status : undefined
            if (isRetryableError(error)) {
              latest.status = 'queued'
              persist()
              stopFlush = true
              break
            }
            latest.status = 'failed'
            persist()
          }
        }
        if (stopFlush) break
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

  const retry = (messageId: string) => {
    const item = items.find((candidate) => candidate.message.id === messageId)
    if (!item) return undefined
    if (item.status === 'failed') {
      item.status = 'queued'
      item.error = undefined
      item.errorCode = undefined
      item.errorStatus = undefined
      persist()
    }
    return structuredClone(item)
  }

  return {
    enqueue,
    flush,
    retry,
    list: snapshot,
    subscribe(listener: (items: AgentMessageQueueItem[]) => void) {
      listeners.add(listener)
      listener(snapshot())
      return () => { listeners.delete(listener) }
    },
  }
}

export type AgentMessageQueue = ReturnType<typeof createAgentMessageQueue>

/** Turn POST 的 durable 栅栏：只有目标 Message 已从队列移除才表示 PUT 成功。 */
export function assertAgentMessageQueueItemDelivered(queue: AgentMessageQueue, messageId: string) {
  const pending = queue.list().find((item) => item.message.id === messageId)
  if (!pending) return
  const error = new Error(pending.error || 'Agent 消息尚未持久化，已暂停提交 Turn。') as QueueError
  error.status = pending.errorStatus ?? 0
  error.code = error.status === 0
    ? 'AGENT_MESSAGE_NOT_DURABLE'
    : pending.errorCode || 'AGENT_MESSAGE_NOT_DURABLE'
  throw error
}
