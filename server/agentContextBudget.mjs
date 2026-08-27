// @ts-check

/** Thread Summary + recent Message window share this deterministic budget. */
export const AGENT_THREAD_CONTEXT_TOKEN_BUDGET = 8_000
export const AGENT_THREAD_SUMMARY_TOKEN_BUDGET = 2_000
export const AGENT_CONTEXT_MESSAGE_OVERHEAD_TOKENS = 8

function tokenWeight(value) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  let weight = 0
  let asciiRun = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code <= 0x7f) {
      asciiRun += 1
      continue
    }
    if (asciiRun) {
      weight += Math.ceil(asciiRun / 3)
      asciiRun = 0
    }
    // CJK 按 1 token/字估算；代理对的两个 UTF-16 code unit 各计 1，
    // 对 emoji 也保持保守。
    weight += 1
  }
  if (asciiRun) weight += Math.ceil(asciiRun / 3)
  return weight
}

/**
 * 保守、无 tokenizer 依赖的稳定估算。ASCII 最多 3 字符/token，
 * 非 ASCII 每 UTF-16 code unit 至少 1 token。
 */
export function estimateAgentContextTokens(value) {
  return tokenWeight(value)
}

function prefixWithinWeight(text, maximumWeight) {
  let end = 0
  let finalizedWeight = 0
  let asciiRun = 0
  while (end < text.length) {
    const code = text.charCodeAt(end)
    if (code <= 0x7f) {
      const nextAsciiRun = asciiRun + 1
      if (finalizedWeight + Math.ceil(nextAsciiRun / 3) > maximumWeight) break
      asciiRun = nextAsciiRun
      end += 1
      continue
    }
    const codeUnits = code >= 0xd800 && code <= 0xdbff && end + 1 < text.length ? 2 : 1
    const nextWeight = finalizedWeight + Math.ceil(asciiRun / 3) + codeUnits
    if (nextWeight > maximumWeight) break
    finalizedWeight = nextWeight
    asciiRun = 0
    end += codeUnits
  }
  return end
}

function suffixWithinWeight(text, maximumWeight) {
  let start = text.length
  let finalizedWeight = 0
  let asciiRun = 0
  while (start > 0) {
    let nextStart = start - 1
    const code = text.charCodeAt(nextStart)
    // 不在代理对中间截断。
    if (code >= 0xdc00 && code <= 0xdfff && nextStart > 0) nextStart -= 1
    const codeUnits = start - nextStart
    if (code <= 0x7f) {
      const nextAsciiRun = asciiRun + 1
      if (finalizedWeight + Math.ceil(nextAsciiRun / 3) > maximumWeight) break
      asciiRun = nextAsciiRun
      start = nextStart
      continue
    }
    const nextWeight = finalizedWeight + Math.ceil(asciiRun / 3) + codeUnits
    if (nextWeight > maximumWeight) break
    finalizedWeight = nextWeight
    asciiRun = 0
    start = nextStart
  }
  return start
}

/**
 * 以可复现的 head/tail 方式裁剪长文本，并返回精确的截断元数据。
 */
export function truncateAgentContextText(value, maximumTokens, options = {}) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  const limit = Math.max(0, Math.floor(Number(maximumTokens) || 0))
  const originalTokens = estimateAgentContextTokens(text)
  if (originalTokens <= limit) {
    return {
      text,
      truncated: false,
      estimatedTokens: originalTokens,
      originalTokens,
      omittedCharacters: 0,
    }
  }
  const marker = typeof options.marker === 'string' && options.marker
    ? options.marker
    : '\n…[已按 token 预算截断]…\n'
  const markerTokens = estimateAgentContextTokens(marker)
  if (limit <= markerTokens) {
    const end = prefixWithinWeight(marker, limit)
    const boundedMarker = marker.slice(0, end)
    return {
      text: boundedMarker,
      truncated: true,
      estimatedTokens: estimateAgentContextTokens(boundedMarker),
      originalTokens,
      omittedCharacters: text.length,
    }
  }
  const available = limit - markerTokens
  const headBudget = Math.ceil(available * 0.6)
  const tailBudget = available - headBudget
  const headEnd = prefixWithinWeight(text, headBudget)
  const tailStart = suffixWithinWeight(text.slice(headEnd), tailBudget) + headEnd
  const bounded = `${text.slice(0, headEnd)}${marker}${text.slice(tailStart)}`
  return {
    text: bounded,
    truncated: true,
    estimatedTokens: estimateAgentContextTokens(bounded),
    originalTokens,
    omittedCharacters: Math.max(0, tailStart - headEnd),
  }
}

export function agentContextMessageTokens(message) {
  return AGENT_CONTEXT_MESSAGE_OVERHEAD_TOKENS
    + estimateAgentContextTokens(message?.content ?? '')
}
