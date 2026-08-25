// @ts-check

/**
 * 数据库连接抖动的进程级兜底。
 *
 * 起因是一次真实观察：Postgres 连接超时会抛出**未捕获异常**，直接终止整个 API 进程。
 *
 *     Error: write CONNECT_TIMEOUT undefined:undefined
 *         at connectTimedOut (postgres/src/connection.js:262)
 *         triggerUncaughtException(...)  → exit 1
 *
 * 这类错误来自连接层的后台重连，**不属于任何一次请求** —— 没有 5xx 可以返回，
 * 也没有调用方可以 catch。于是一次几秒钟的网络抖动会让整个服务下线，而连接池
 * 其实只要下一次查询就能自愈。
 *
 * 但「吞掉未捕获异常」本身是危险的：它会把真正的 bug 藏起来，让进程带着已经损坏的
 * 状态继续跑。所以这里有两条硬约束：
 *
 * 1. **只容忍一个明确的错误码清单**，其余一律照原样抛出，保持 fail-fast。
 * 2. **短时间内反复发生就退出。** 持续容忍一个已经彻底断掉的数据库，只会让服务
 *    「活着但每个请求都 500」—— 那比直接退出让编排器重启更糟，因为健康检查会
 *    一直显示正常。
 */

/**
 * 可容忍的连接层错误码。
 *
 * 全部是**连接建立/保持**阶段的瞬时故障，重连即可恢复。刻意不包含任何查询级错误
 * （语法错误、约束冲突、权限不足）—— 那些是代码或数据的问题，藏起来只会更难查。
 */
export const TRANSIENT_DATABASE_ERROR_CODES = Object.freeze([
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
])

const transientCodes = new Set(TRANSIENT_DATABASE_ERROR_CODES)

/**
 * 是否是可容忍的数据库连接抖动。
 *
 * 只认 `code`/`errno`，**不做消息文本匹配**：文本会随驱动版本变化，而按文本匹配的
 * 容忍清单迟早会在某次升级后悄悄放行一类本不该放行的错误。
 *
 * @param {any} error
 */
export function isTransientDatabaseError(error) {
  if (!error || typeof error !== 'object') return false
  return transientCodes.has(error.code) || transientCodes.has(error.errno)
}

/**
 * 抖动计数器。
 *
 * @param {{
 *   windowMs?: number,
 *   threshold?: number,
 *   now?: () => number,
 * }} [options]
 *   `threshold` 次以上发生在 `windowMs` 内即判定为「持续故障」，此时不再容忍。
 */
export function createDatabaseResilience({ windowMs = 60_000, threshold = 5, now = () => Date.now() } = {}) {
  /** @type {number[]} */
  let recent = []
  return {
    /**
     * 判定一个未捕获错误该容忍还是该终止。
     *
     * @param {any} error
     * @returns {{ action: 'rethrow' | 'tolerate' | 'exit', reason: string, recentCount?: number }}
     */
    classify(error) {
      if (!isTransientDatabaseError(error)) {
        return { action: 'rethrow', reason: '不是数据库连接层的瞬时故障，按原样抛出以免藏住真正的 bug。' }
      }
      const at = now()
      recent = [...recent.filter((time) => at - time < windowMs), at]
      if (recent.length >= threshold) {
        // 持续容忍一个彻底断掉的数据库，会让服务「活着但每个请求都 500」——
        // 健康检查还一直显示正常，比直接退出让编排器重启更难被发现。
        return {
          action: 'exit',
          reason: `${Math.round(windowMs / 1000)} 秒内发生 ${recent.length} 次数据库连接故障，判定为持续故障而非抖动。`,
          recentCount: recent.length,
        }
      }
      return { action: 'tolerate', reason: '数据库连接瞬时故障，连接池会在下一次查询时重连。', recentCount: recent.length }
    },
    /** 供测试与运维读取当前窗口内的计数。 */
    recentCount() {
      const at = now()
      recent = recent.filter((time) => at - time < windowMs)
      return recent.length
    },
  }
}

/**
 * 把兜底装到进程上。
 *
 * `uncaughtException` 与 `unhandledRejection` 都要接：连接层的错误既可能以 socket
 * error 的形式冒出来，也可能是一个没人 await 的重连 Promise。
 *
 * @param {{
 *   observe?: (event: any) => void,
 *   onFatal?: (error: any) => void,
 *   windowMs?: number, threshold?: number, now?: () => number,
 *   process?: NodeJS.Process,
 * }} [options]
 */
export function installDatabaseResilience({
  observe = (event) => console.log(JSON.stringify(event)),
  onFatal,
  windowMs,
  threshold,
  now,
  process: target = process,
} = {}) {
  const resilience = createDatabaseResilience({ windowMs, threshold, now })
  const handle = (kind) => (error) => {
    const decision = resilience.classify(error)
    if (decision.action === 'rethrow') {
      // 交回默认行为：进程按原样崩溃，堆栈完整保留。
      throw error
    }
    observe({
      event: decision.action === 'exit' ? 'database.connection.fatal' : 'database.connection.tolerated',
      kind,
      code: error?.code ?? error?.errno,
      reason: decision.reason,
      recentCount: decision.recentCount,
    })
    if (decision.action === 'exit') {
      if (onFatal) onFatal(error)
      else target.exit(1)
    }
  }
  target.on('uncaughtException', handle('uncaughtException'))
  target.on('unhandledRejection', handle('unhandledRejection'))
  return resilience
}
