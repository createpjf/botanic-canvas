/**
 * 局部重绘选区：以基准图为坐标系的归一化矩形（0–1）。
 * 位图蒙版由 Worker 在拿到基准图字节时按真实像素生成；选区本身只是纯数据，
 * 可以进 recipe、计划与持久化记录，不受“计划 JSON 禁止图片负载”的约束。
 */
export type RegionRect = {
  x: number
  y: number
  width: number
  height: number
}

/** 选区小于此比例视为误触，不构成有效局部重绘。 */
export const minimumRegionSpan = 0.02

export function clampRegionRect(rect: RegionRect): RegionRect | null {
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return null
  const x = Math.min(Math.max(rect.x, 0), 1)
  const y = Math.min(Math.max(rect.y, 0), 1)
  const width = Math.min(Math.max(rect.width, 0), 1 - x)
  const height = Math.min(Math.max(rect.height, 0), 1 - y)
  if (width < minimumRegionSpan || height < minimumRegionSpan) return null
  return { x, y, width, height }
}

export function regionRectFromPoints(start: { x: number; y: number }, end: { x: number; y: number }): RegionRect | null {
  return clampRegionRect({
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  })
}

const horizontalBands = ['左', '中', '右'] as const
const verticalBands = ['上', '中', '下'] as const

function bandIndex(center: number) {
  if (center < 1 / 3) return 0
  if (center > 2 / 3) return 2
  return 1
}

/** 给规划器与确认卡用的中文位置描述；覆盖大半画面时按整体处理。 */
export function describeRegionRect(rect: RegionRect): string {
  const area = rect.width * rect.height
  if (area >= 0.85) return '整个画面'
  const vertical = verticalBands[bandIndex(rect.y + rect.height / 2)]
  const horizontal = horizontalBands[bandIndex(rect.x + rect.width / 2)]
  const position = vertical === '中' && horizontal === '中'
    ? '画面中部'
    : `画面${vertical === '中' ? '' : vertical}${horizontal === '中' ? (vertical === '中' ? '中部' : '部') : horizontal}`
  const scale = area >= 0.45 ? '大范围区域' : area >= 0.12 ? '区域' : '小块区域'
  return `${position}的${scale}（约占 ${Math.round(area * 100)}%）`
}
