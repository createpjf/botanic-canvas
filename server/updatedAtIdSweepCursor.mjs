// @ts-check

/** 周期清扫统一使用的小页上限，避免单轮恢复挤占 Worker。 */
export function boundedSweepPageSize(value, fallback = 25) {
  return Math.max(1, Math.min(Number(value) || fallback, 200))
}

function entryCursor(entry) {
  const updatedAt = Number(entry?.updatedAt)
  const id = typeof entry?.id === 'string' && entry.id
    ? entry.id
    : typeof entry?.runId === 'string' ? entry.runId : ''
  return Number.isFinite(updatedAt) && id ? { updatedAt, id } : undefined
}

function compareCursor(left, right) {
  return left.updatedAt - right.updatedAt || left.id.localeCompare(right.id)
}

/**
 * 一页扫描完成后的跨 sweep 游标决策。
 *
 * - 未满页代表到达尾部，下轮从头 wrap；
 * - 满页只向严格更大的 `(updatedAt,id)` 推进；
 * - Adapter 忽略 after、返回坏游标或重复页时 fail-safe wrap，避免永久卡死。
 */
export function nextUpdatedAtIdSweepCursor({ after, page, limit }) {
  if (!Array.isArray(page) || page.length < limit) {
    return { after: null, wrapped: true, stalled: false }
  }
  const candidate = entryCursor(page.at(-1))
  if (!candidate || (after && compareCursor(candidate, after) <= 0)) {
    return { after: null, wrapped: true, stalled: true }
  }
  return { after: candidate, wrapped: false, stalled: false }
}
