// @ts-check

/**
 * 本实例正在执行的 Turn 的中止句柄。
 *
 * 它必须是一个跨模块共享的具名 seam，而不是路由处理器内部的裸 Map：取消请求
 * 可能落在任意 API 实例，收到跨实例取消信号的订阅方需要能问「这个 Turn 是不是
 * 我在跑」并就地中止。两者拿不到同一个表，跨实例取消就只能事后丢弃结果。
 *
 * 只登记本实例的执行；不是权威状态。权威状态在 ProductStore 的 Turn 记录上。
 */
export function createLocalCancelRegistry() {
  /** @type {Map<string, { abort: () => void }>} */
  const handles = new Map()

  return {
    /**
     * 登记一个执行句柄。同一 Turn 的并发幂等重放会复用首个句柄 —— 后来的请求
     * 覆盖它会导致明确取消只中断一个无效的重复控制器。
     * @returns {boolean} 是否成为该 Turn 的活动句柄
     */
    register(turnId, handle) {
      if (!turnId || typeof handle?.abort !== 'function') return false
      if (handles.has(turnId)) return false
      handles.set(turnId, handle)
      return true
    },
    /** 只在句柄仍是自己登记的那个时才注销，避免误删后来者的句柄。 */
    release(turnId, handle) {
      if (handles.get(turnId) !== handle) return false
      handles.delete(turnId)
      return true
    },
    /**
     * 中止本实例上该 Turn 的执行。
     * @returns {boolean} 该 Turn 是否由本实例执行（false 表示在别的实例上）
     */
    abort(turnId) {
      const handle = handles.get(turnId)
      if (!handle) return false
      try {
        handle.abort()
      } catch {
        // 句柄已失效不影响判定：它确实曾属于本实例。
      }
      return true
    },
    /** 该 Turn 是否正在本实例执行。 */
    has(turnId) {
      return handles.has(turnId)
    },
    get size() {
      return handles.size
    },
  }
}
