/**
 * 受控并发执行一组异步任务。
 *
 * 批量生图既要同时发起多个子任务，又必须给供应商和 Worker 留出
 * 可配置的并发上限，避免一次文件夹任务打爆上游。
 */
export async function mapWithConcurrency(items, concurrency, worker) {
  const values = Array.from(items)
  if (!values.length) return []
  const limit = Math.max(1, Math.min(values.length, Math.floor(Number(concurrency) || 1)))
  const results = new Array(values.length)
  let cursor = 0

  async function consume() {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= values.length) return
      results[index] = await worker(values[index], index)
    }
  }

  await Promise.all(Array.from({ length: limit }, () => consume()))
  return results
}
