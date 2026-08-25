// @ts-check
import { createHash } from 'node:crypto'

/**
 * 结构化值的规范化哈希。**唯一实现**。
 *
 * 此前 `botanicCreativePlanCompiler` 与 `agentActionGovernance` 各有一份逐字节相同的
 * 副本，`brandKit` 又需要第三份。指纹是跨模块比对用的（「重试是否漂移」「审批与参数
 * 是否匹配」），三份实现里任何一份被单独调整，比对就会在无人察觉的情况下永远不等。
 *
 * 键序无关：同一份内容的不同书写顺序得到同一哈希，否则字段顺序这种无意义差异
 * 会被当成语义变化。
 */

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
  }
  return value
}

/** @param {unknown} value */
export function canonicalHash(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('base64url')
}
