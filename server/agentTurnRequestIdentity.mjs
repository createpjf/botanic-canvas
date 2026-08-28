// @ts-check
import { canonicalHash } from './canonicalHash.mjs'

/** 当前 Turn 请求摘要规则。v1 绑定整份 request，v2 排除服务端派生的 messages 窗口。 */
export const currentAgentTurnRequestHashVersion = 2

/** @param {unknown} value */
function recordObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : undefined
}

/**
 * 旧数据没有独立 requestHashVersion，只能按当时 Turn 契约版本恢复；
 * 未知版本不猜测，由 claim fail closed。
 * @param {unknown} turn
 */
export function agentTurnRequestHashVersion(turn) {
  const record = recordObject(turn)
  if (!record) return undefined
  if (Object.hasOwn(record, 'requestHashVersion')) {
    const explicit = Number(record.requestHashVersion)
    return [1, 2].includes(explicit) ? explicit : undefined
  }
  if (record.version === 2) return 2
  if (record.version === undefined || record.version === 1) return 1
  return undefined
}

/**
 * @param {unknown} request
 * @param {number} version
 */
export function agentTurnRequestIntent(request, version) {
  if (version === 1) return request
  if (version !== 2) return undefined
  const snapshot = recordObject(request)
  if (
    !snapshot
    || typeof snapshot.sessionId !== 'string'
    || !snapshot.sessionId.trim()
    || !recordObject(snapshot.inputMessage)
    || typeof snapshot.inputMessage.id !== 'string'
    || !snapshot.inputMessage.id.trim()
  ) return request

  // messages 是服务端权威 Session/Message 实体的有界投影：同一输入重放时
  // 窗口可能滑动，但不能因此改变幂等意图。
  const intent = { ...snapshot }
  delete intent.messages
  return intent
}

/** @param {unknown} request @param {number} [version] */
export function agentTurnRequestHash(request, version = currentAgentTurnRequestHashVersion) {
  return canonicalHash(agentTurnRequestIntent(request, version) ?? null)
}

/**
 * 只从已持久 Turn 的不可变 request 派生。缺快照或版本未知时返回
 * undefined，调用方必须 fail closed，不得借用本次新输入回填。
 * @param {unknown} turn
 */
export function storedAgentTurnRequestBinding(turn) {
  const record = recordObject(turn)
  const version = agentTurnRequestHashVersion(record)
  if (!record || !version || !Object.hasOwn(record, 'request') || !recordObject(record.request)) return undefined
  return { requestHash: agentTurnRequestHash(record.request, version), requestHashVersion: version }
}
