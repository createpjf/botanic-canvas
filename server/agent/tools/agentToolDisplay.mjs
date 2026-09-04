import { withoutReason } from './agentToolOutput.mjs'

const MAX_CHARACTERS = 12_000
const MAX_TEXT = 2_000
const MAX_ENTRIES = 40
const PRIVATE_KEY = /(?:accesskey|apikey|authorization|cookie|credential|password|privatekey|secret|sessionkey|signingkey|token)/u
const HIDDEN_REASONING_KEY = /(?:analysis|chainofthought|providerbody|providerresponse|reasoning|thought)/u
const BINARY_KEY = /(?:base64|binary|blob|buffer|bytes)/u

function normalizedKey(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/gu, '')
}

function safeText(value) {
  return String(value)
    .replace(/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/giu, '[REDACTED_MEDIA]')
    .replace(/https?:\/\/[^\s"'<>）)]+/giu, '[REDACTED_URL]')
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/giu, '[REDACTED_KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/giu, 'Bearer [REDACTED_TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/gu, '[REDACTED_JWT]')
    .replace(/([?&](?:key|sig|signature|token|secret|expires)\s*=)[^&#\s"']+/giu, '$1[REDACTED]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ')
    .slice(0, MAX_TEXT)
}

function project(value, key, depth, seen) {
  const normalized = normalizedKey(key)
  if (PRIVATE_KEY.test(normalized)) return '[REDACTED]'
  if (HIDDEN_REASONING_KEY.test(normalized)) return '[REDACTED_REASONING]'
  if (BINARY_KEY.test(normalized)) return '[REDACTED_MEDIA]'
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string' || typeof value === 'bigint') return safeText(value)
  if (value === undefined) return undefined
  if (depth >= 6) return '[TRUNCATED_DEPTH]'
  if (typeof value !== 'object') return '[UNSUPPORTED]'
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ENTRIES)
      .map((entry) => project(entry, '', depth + 1, seen))
      .filter((entry) => entry !== undefined)
  }
  const projected = {}
  for (const [childKey, childValue] of Object.entries(value).slice(0, MAX_ENTRIES)) {
    const safe = project(childValue, childKey, depth + 1, seen)
    const displayKey = safeText(childKey).slice(0, 160) || '[EMPTY_KEY]'
    if (safe !== undefined) projected[displayKey] = safe
  }
  return projected
}

/** UI 可见的 Tool 参数/输出：保留结构，但去掉密钥、媒体字节、Provider body 与隐藏推理。 */
export function safeAgentToolDisplayValue(value) {
  if (value === undefined) return undefined
  try {
    const projected = project(value, '', 0, new WeakSet())
    const serialized = JSON.stringify(projected)
    if (serialized === undefined || serialized.length <= MAX_CHARACTERS) return projected
    return {
      _botanicTruncation: { truncated: true, originalCharacters: serialized.length },
      preview: serialized.slice(0, MAX_CHARACTERS - 120),
    }
  } catch {
    // 展示投影永远不能改变工具执行结果。
    return '[UNAVAILABLE]'
  }
}

export function agentToolDisplayTrace(entry, trace, options = {}) {
  const input = safeAgentToolDisplayValue(withoutReason(entry.rawArguments))
  const output = Object.hasOwn(options, 'output') ? safeAgentToolDisplayValue(options.output) : undefined
  return {
    ...trace,
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(entry.descriptor?.recovery ? { recovery: entry.descriptor.recovery } : {}),
    ...(entry.descriptor?.receiptId ? { receiptId: entry.descriptor.receiptId } : {}),
    ...(entry.recovering ? { recovered: true } : {}),
  }
}
