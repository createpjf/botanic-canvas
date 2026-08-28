// @ts-check
import { canonicalHash } from './canonicalHash.mjs'

export const AGENT_TOOL_CALL_ID_MAX_LENGTH = 160

/**
 * Provider 的工具调用标识可能超过持久化契约上限。短标识保持原样；长标识保留可读前缀并附带
 * 完整原值的稳定摘要，避免直接截断让共享前缀的两个调用碰撞。
 *
 * @param {unknown} value
 */
export function normalizeAgentToolCallId(value) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (normalized.length <= AGENT_TOOL_CALL_ID_MAX_LENGTH) return normalized
  const suffix = canonicalHash(normalized)
  const prefixLength = AGENT_TOOL_CALL_ID_MAX_LENGTH - suffix.length - 1
  return `${normalized.slice(0, prefixLength)}.${suffix}`
}
