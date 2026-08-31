export type CanvasSyncMutation = {
  id: string
  projectId: string
  mutationId: string
  update: string
  createdAt: number
}

export type CanvasSyncOutboxStorage = {
  put: (mutation: CanvasSyncMutation) => Promise<void>
  list: (projectId: string) => Promise<CanvasSyncMutation[]>
  delete: (id: string) => Promise<void>
}

type CanvasSyncUpdateEvent = {
  type: 'canvas.crdt.update'
  projectId: string
  mutationId: string
  update: string
}

export function createCanvasSyncOutbox(options: {
  projectId: string
  storage: CanvasSyncOutboxStorage
  publish: (event: CanvasSyncUpdateEvent) => boolean
  fallback?: (event: CanvasSyncUpdateEvent) => Promise<{ mutationId: string }>
  createMutationId?: () => string
  now?: () => number
  onPendingChanged?: (count: number) => void
}) {
  const { projectId, storage, publish, fallback } = options
  if (!projectId) throw new TypeError('Canvas Sync Outbox 缺少项目标识。')
  const createMutationId = options.createMutationId ?? (() => globalThis.crypto.randomUUID())
  const now = options.now ?? Date.now
  let persistenceTail: Promise<unknown> = Promise.resolve()
  let flushTail: Promise<unknown> = Promise.resolve()

  const serializePersistence = <T>(operation: () => Promise<T>) => {
    const running = persistenceTail.then(operation)
    persistenceTail = running.catch(() => undefined)
    return running
  }

  const serializeFlush = <T>(operation: () => Promise<T>) => {
    const running = flushTail.then(operation)
    flushTail = running.catch(() => undefined)
    return running
  }

  const validMutation = (mutation: CanvasSyncMutation) => /^[A-Za-z0-9._:-]{1,200}$/.test(mutation.mutationId)
    && Boolean(mutation.update)
    && mutation.update.length <= 700_000
    && /^[A-Za-z0-9+/]*={0,2}$/.test(mutation.update)

  const listPending = async () => {
    const pending = (await storage.list(projectId))
      .filter((mutation) => mutation.projectId === projectId)
      .sort((left, right) => left.createdAt - right.createdAt || left.mutationId.localeCompare(right.mutationId))
    options.onPendingChanged?.(pending.filter(validMutation).length)
    return pending
  }

  const flush = async () => {
    const pending = await listPending()
    let sent = 0
    for (const mutation of pending) {
      if (!validMutation(mutation)) continue
      const event = {
        type: 'canvas.crdt.update' as const,
        projectId,
        mutationId: mutation.mutationId,
        update: mutation.update,
      }
      let published = false
      try {
        published = publish(event)
      } catch { /* HTTP fallback below */ }
      if (published) {
        sent += 1
        continue
      }
      if (!fallback) break
      try {
        const committed = await fallback(event)
        if (committed.mutationId !== mutation.mutationId) break
        await storage.delete(mutation.id)
        await listPending()
        sent += 1
      } catch { break }
    }
    return { sent, pending: pending.length }
  }

  return {
    enqueue(update: string) {
      const persisted = serializePersistence(async () => {
        if (!update || update.length > 700_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(update)) {
          throw new TypeError('Canvas Sync update 无效。')
        }
        const mutationId = createMutationId()
        if (!/^[A-Za-z0-9._:-]{1,200}$/.test(mutationId)) throw new TypeError('Canvas Sync mutationId 无效。')
        const mutation = { id: `${projectId}:${mutationId}`, projectId, mutationId, update, createdAt: now() }
        await storage.put(mutation)
        return structuredClone(mutation)
      })
      return persisted.then(async (mutation) => {
        await serializeFlush(flush)
        return mutation
      })
    },
    pendingUpdates: () => serializePersistence(async () => (await listPending())
      .filter(validMutation)
      .map((mutation) => mutation.update)),
    flush: () => serializeFlush(flush),
    ack(mutationId: string) {
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(mutationId)) return Promise.resolve()
      return serializePersistence(async () => {
        await storage.delete(`${projectId}:${mutationId}`)
        await listPending()
      })
    },
  }
}
