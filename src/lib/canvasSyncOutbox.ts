export type CanvasSyncMutation = {
  id: string
  projectId: string
  mutationId: string
  update: string
  createdAt: number
  /** 入队时会话已知的同步协议 epoch；缺省表示旧版本条目或入队时 epoch 未知。 */
  syncProtocolEpoch?: number
  blocked?: CanvasSyncBlockedState
}

export type CanvasSyncFailure = { code: string; status?: number }
export type CanvasSyncBlockedState = CanvasSyncFailure & { at: number }

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
  classifyPermanentFailure?: (error: unknown) => CanvasSyncFailure | undefined
  createMutationId?: () => string
  now?: () => number
  onPendingChanged?: (count: number, blocked?: CanvasSyncBlockedState) => void
  /** 当前会话已知的同步协议 epoch；入队时盖章，重放时用于隔离旧 epoch 队列。 */
  expectedEpoch?: () => number | undefined
  /** 返回 false 时 flush 不发包（如权威快照握手未完成），条目原样保留。 */
  sendReady?: () => boolean
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
    const valid = pending.filter(validMutation)
    options.onPendingChanged?.(valid.length, valid.find((mutation) => mutation.blocked)?.blocked)
    return pending
  }

  const blockMutation = async (mutation: CanvasSyncMutation, failure: CanvasSyncFailure) => {
    await storage.put({ ...mutation, blocked: { ...failure, at: now() } })
    await listPending()
  }

  const flush = async () => {
    // 权威快照握手完成前不发包：本地 Y.Doc 里的旧几何在此时重放会
    // 覆盖服务端权威布局（Epoch 2 Canary 布局漂移事故的重放源）。
    if (options.sendReady && !options.sendReady()) return { sent: 0, pending: (await listPending()).length }
    const pending = await listPending()
    const epoch = options.expectedEpoch?.()
    let sent = 0
    for (const mutation of pending) {
      if (!validMutation(mutation)) continue
      // 旧 epoch 时代排队的条目对重建后的图谱已无意义，重放只会污染布局
      // （Epoch 2 Canary 漂移事故）；切换有活动写入门禁，残留条目直接丢弃。
      // 无 epoch 戳的条目按 epoch 1 对待：只可能是本修复上线前排队的遗留。
      // 不能走 blocked 隔离：retryBlocked 会把旧几何盖上新 epoch 原样重发。
      if (epoch !== undefined && (mutation.syncProtocolEpoch ?? 1) < epoch) {
        await storage.delete(mutation.id)
        await listPending()
        continue
      }
      if (mutation.blocked) break
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
      } catch (error) {
        const failure = options.classifyPermanentFailure?.(error)
        if (failure) await blockMutation(mutation, failure)
        break
      }
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
        const epoch = options.expectedEpoch?.()
        const mutation = {
          id: `${projectId}:${mutationId}`,
          projectId,
          mutationId,
          update,
          createdAt: now(),
          ...(epoch !== undefined ? { syncProtocolEpoch: epoch } : {}),
        }
        await storage.put(mutation)
        return structuredClone(mutation)
      })
      return persisted.then(async (mutation) => {
        await serializeFlush(flush)
        return mutation
      })
    },
    pendingUpdates: () => serializePersistence(async () => {
      const epoch = options.expectedEpoch?.()
      return (await listPending())
        .filter(validMutation)
        // 旧 epoch 条目不再进本地 Y.Doc：应用后 diff 会把旧几何再生成新增量。
        .filter((mutation) => !(epoch !== undefined && (mutation.syncProtocolEpoch ?? 1) < epoch))
        .map((mutation) => mutation.update)
    }),
    flush: () => serializeFlush(flush),
    ack(mutationId: string) {
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(mutationId)) return Promise.resolve()
      return serializePersistence(async () => {
        await storage.delete(`${projectId}:${mutationId}`)
        await listPending()
      })
    },
    block(mutationId: string, failure: CanvasSyncFailure) {
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(mutationId)) return Promise.resolve()
      return serializePersistence(async () => {
        const mutation = (await storage.list(projectId)).find((candidate) => candidate.mutationId === mutationId)
        if (mutation) await blockMutation(mutation, failure)
      })
    },
    retryBlocked() {
      return serializePersistence(async () => {
        const mutation = (await listPending()).find((candidate) => validMutation(candidate) && candidate.blocked)
        if (!mutation) return
        const retry = { ...mutation }
        delete retry.blocked
        await storage.put(retry)
        await listPending()
      }).then(() => serializeFlush(flush))
    },
  }
}
