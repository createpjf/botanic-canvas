// @ts-check

const SERIALIZED_PROVIDERS = new Set(['flock'])
let serializedProviderActive = false
const serializedProviderQueue = []

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason
  const error = new Error('Provider admission aborted')
  error.name = 'AbortError'
  return error
}

function dispatchSerializedProvider() {
  if (serializedProviderActive) return
  const entry = serializedProviderQueue.shift()
  if (!entry) return
  if (entry.signal?.aborted) {
    entry.reject(abortError(entry.signal))
    dispatchSerializedProvider()
    return
  }
  serializedProviderActive = true
  entry.signal?.removeEventListener('abort', entry.onAbort)
  let released = false
  entry.resolve(() => {
    if (released) return
    released = true
    serializedProviderActive = false
    dispatchSerializedProvider()
  })
}

/**
 * 在解析生成输入媒体之前取得高内存 Provider 的进程级许可。
 *
 * Worker concurrency 可以提高普通任务吞吐，但 Flock 图生图会同时持有原始媒体、
 * 流式请求和 Provider 回包。许可必须覆盖「媒体解析 → Provider → 输出持久化」整个
 * 区间，否则排队任务仍会各自物化最多 48MB 输入。
 */
export async function acquireGenerationProviderAdmission(input) {
  const providers = Array.isArray(input?.providers) ? input.providers : []
  if (!providers.some((provider) => SERIALIZED_PROVIDERS.has(provider))) return () => undefined
  const signal = input?.signal
  if (signal?.aborted) throw abortError(signal)
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, signal, onAbort: () => undefined }
    entry.onAbort = () => {
      const index = serializedProviderQueue.indexOf(entry)
      if (index < 0) return
      serializedProviderQueue.splice(index, 1)
      reject(abortError(signal))
    }
    signal?.addEventListener('abort', entry.onAbort, { once: true })
    serializedProviderQueue.push(entry)
    dispatchSerializedProvider()
  })
}
