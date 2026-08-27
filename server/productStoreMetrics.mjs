// @ts-check
/**
 * ProductStore 读路径结构化耗时日志。挂在现有 JSON 日志通道上，供 Railway 日志与后续 Sentry 采集。
 */
export function observeProductStoreRead(operation, detail = {}) {
  console.log(JSON.stringify({
    event: 'product_store.read',
    operation,
    ...detail,
  }))
}

export async function timedProductStoreRead(operation, detail, run) {
  const startedAt = Date.now()
  try {
    const result = await run()
    const readMetrics = result && typeof result === 'object' && 'readMetrics' in result
      ? result.readMetrics
      : undefined
    observeProductStoreRead(operation, {
      ...detail,
      durationMs: Date.now() - startedAt,
      ok: true,
      ...(readMetrics ?? {}),
    })
    if (result && typeof result === 'object' && 'readMetrics' in result) {
      const { readMetrics: _metrics, ...rest } = result
      return rest
    }
    return result
  } catch (error) {
    observeProductStoreRead(operation, {
      ...detail,
      durationMs: Date.now() - startedAt,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}
