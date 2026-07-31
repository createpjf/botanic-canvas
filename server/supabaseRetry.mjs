const defaultAttempts = 3
const defaultBaseDelayMs = 250
const defaultMaxDelayMs = 1_000

export function isRetryableSupabaseError(error) {
  if (!error) return false
  if (error.code === 'WORKSPACE_STORE_TIMEOUT') return true
  if (typeof error.status === 'number' && error.status >= 500) return true
  if (['AbortError', 'TimeoutError', 'FetchError'].includes(error.name)) return true
  return ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(error.code)
}

/**
 * 只重试可恢复的 Supabase 传输或 5xx 错误；退避时间有上限，避免让用户无限等待。
 */
export async function retrySupabaseOperation(operation, options = {}) {
  const attempts = Math.max(1, options.attempts ?? defaultAttempts)
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? defaultBaseDelayMs)
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? defaultMaxDelayMs)
  const sleep = options.sleep ?? ((delay) => new Promise((resolve) => setTimeout(resolve, delay)))
  let lastError

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt)
    } catch (caught) {
      lastError = caught
      if (!isRetryableSupabaseError(caught) || attempt === attempts) throw caught
      const delay = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)))
      await sleep(delay)
    }
  }

  throw lastError
}
