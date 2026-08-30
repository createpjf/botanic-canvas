import type { BotanicAgentMessage } from '../domain/agent'

export type AgentMessageQueueStatus = 'queued' | 'sending' | 'failed'

export type AgentMessageQueueInput = {
  projectId: string
  sessionId: string
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
  quarantine?: (value: string) => void
}

type QueueError = Error & { status?: number; code?: string }

type AgentMessageQueueOptions = {
  storage?: AgentMessageQueueStorage
  deliver: (item: AgentMessageQueueItem) => Promise<void>
  now?: () => number
  isRetryableError?: (error: unknown) => boolean
}

const storageKey = 'botanic:agent-message-queue:v1'

function itemKey(input: Pick<AgentMessageQueueInput, 'projectId' | 'sessionId' | 'message'>) {
  return `${input.projectId}\u0000${input.sessionId}\u0000${input.message.id}`
}

function storageFailure() {
  const error = new Error('消息本地持久化失败，已停止提交以避免刷新后丢失。') as QueueError
  error.status = 0
  error.code = 'AGENT_MESSAGE_QUEUE_STORAGE_FAILED'
  return error
}

export function createLocalStorageAgentMessageQueueStorage(namespace = 'workspace'): AgentMessageQueueStorage {
  const scopedKey = `${storageKey}:${namespace}`
  return {
    read: () => globalThis.localStorage?.getItem(scopedKey) ?? null,
    write: (value) => globalThis.localStorage?.setItem(scopedKey, value),
    quarantine: (value) => globalThis.localStorage?.setItem(`${scopedKey}:quarantine:${Date.now()}`, value),
  }
}

function load(storage: AgentMessageQueueStorage): { items: AgentMessageQueueItem[]; error?: QueueError } {
  try {
    const raw = storage.read() || '[]'
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      storage.quarantine?.(raw)
      return { items: [], error: storageFailure() }
    }
    const rejected: unknown[] = []
    const items = parsed.flatMap((value) => {
      if (!value || typeof value !== 'object') {
        rejected.push(value)
        return []
      }
      const item = value as Partial<AgentMessageQueueItem> & { session?: { id?: unknown } }
      const sessionId = typeof item.sessionId === 'string' && item.sessionId
        ? item.sessionId
        : typeof item.session?.id === 'string'
          ? item.session.id
          : ''
      if (!item.projectId || !sessionId || !item.message?.id || !item.idempotencyKey) {
        rejected.push(value)
        return []
      }
      const input: AgentMessageQueueInput = {
        projectId: item.projectId,
        sessionId,
        message: item.message,
        idempotencyKey: item.idempotencyKey,
      }
      return [{
        ...input,
        key: itemKey(input),
        status: item.status === 'failed' ? 'failed' : 'queued',
        attempts: Number.isFinite(item.attempts) ? Math.max(0, Number(item.attempts)) : 0,
        queuedAt: Number.isFinite(item.queuedAt) ? Number(item.queuedAt) : Number(item.message.createdAt) || 0,
      } as AgentMessageQueueItem]
    })
    if (rejected.length) storage.quarantine?.(JSON.stringify(rejected))
    return { items }
  } catch {
    return { items: [], error: storageFailure() }
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
  const loaded = load(storage)
  let items = loaded.items
  let storageError = loaded.error
  let flushPromise: Promise<AgentMessageQueueFlushResult> | undefined
  const listeners = new Set<(items: AgentMessageQueueItem[]) => void>()

  const snapshot = () => items
    .slice()
    .sort(compareQueueItems)
    .map((item) => structuredClone(item))

  const persist = () => {
    try {
      if (storageError) throw storageError
      storage.write(JSON.stringify(items))
    } catch {
      storageError = storageFailure()
      for (const item of items) {
        if (item.status === 'failed') continue
        item.status = 'failed'
        item.error = storageError.message
        item.errorCode = storageError.code
        item.errorStatus = storageError.status
      }
    }
    const next = snapshot()
    for (const listener of listeners) listener(next)
    return !storageError
  }

  const enqueue = (input: AgentMessageQueueInput) => {
    if (storageError) throw storageError
    const key = itemKey(input)
    const existing = items.find((item) => item.key === key || item.idempotencyKey === input.idempotencyKey)
    if (existing) {
      // 发送中的快照可能只是 running；后续终态必须留在同一队列项中，
      // 当前请求完成后再补送新版，刷新也能从本地队列恢复最后状态。
      existing.message = structuredClone(input.message)
      existing.sessionId = input.sessionId
      existing.idempotencyKey = input.idempotencyKey
      if (!persist()) throw storageError
      return structuredClone(existing)
    }
    const item: AgentMessageQueueItem = {
      projectId: input.projectId,
      sessionId: input.sessionId,
      message: structuredClone(input.message),
      idempotencyKey: input.idempotencyKey,
      key,
      status: 'queued',
      attempts: 0,
      queuedAt: now(),
    }
    items.push(item)
    if (!persist()) throw storageError
    return structuredClone(item)
  }

  const flush = () => {
    if (flushPromise) return flushPromise
    flushPromise = (async () => {
      const delivered: string[] = []
      const ordered = items
        .filter((item) => item.status !== 'failed')
        .sort(compareQueueItems)

      const blockedSessions = new Set<string>()
      for (const current of ordered) {
        if (storageError || blockedSessions.has(current.sessionId)) continue
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
          if (!persist()) break
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
              blockedSessions.add(latest.sessionId)
              break
            }
            latest.status = 'failed'
            persist()
          }
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
  error.code = pending.errorCode === 'AGENT_MESSAGE_QUEUE_STORAGE_FAILED'
    ? pending.errorCode
    : error.status === 0
      ? 'AGENT_MESSAGE_NOT_DURABLE'
      : pending.errorCode || 'AGENT_MESSAGE_NOT_DURABLE'
  throw error
}
