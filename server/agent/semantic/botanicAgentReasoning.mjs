/**
 * Agent 运行说明的安全边界。
 *
 * 两类内容必须区分开：
 * - **摘要级步骤说明**：模型通过工具参数 `why` 自述的一句话目的。它是模型主动对
 *   用户说的话，可以展示，也可以随计划持久化。
 * - **提供方原始推理**（OpenAI 兼容接口上的 `reasoning_content` / `reasoning`）：
 *   这是完整思维链，不是摘要。默认不下发、不持久化；只有显式打开原始开关时才
 *   随当轮响应下发，供面板实时展示，轮次结束即丢弃。
 *
 * 这与主流 harness 的做法一致：Anthropic 的 extended thinking 由接口返回摘要、
 * 完整思维链加密在 signature 里；Codex CLI 默认只展示 reasoning summary，原始推理
 * 需要单独打开 show_raw_agent_reasoning。
 */

/** 单条步骤说明的长度上限。 */
export const agentReasoningSummaryLimit = 160
/** 单条原始推理片段的长度上限。 */
export const agentReasoningRawLimit = 600
/** 一轮里最多保留的推理片段数。 */
export const agentReasoningStepLimit = 8

const controlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

function normalize(value, limit) {
  if (typeof value !== 'string') return ''
  const clean = value.replace(controlCharacters, ' ').replace(/\s+/g, ' ').trim()
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean
}

/** 归一化模型自述的一句话调用目的。 */
export function normalizeAgentReasoningSummary(value) {
  return normalize(value, agentReasoningSummaryLimit)
}

/** 从工具原始参数里取出模型自述的调用目的；取不到就返回空串。 */
export function agentToolCallSummary(rawArguments) {
  if (!rawArguments || typeof rawArguments !== 'object' || Array.isArray(rawArguments)) return ''
  return normalizeAgentReasoningSummary(rawArguments.why)
}

/**
 * 读取提供方原始推理字段。allowRaw 关闭时一律返回空串——
 * 不能因为提供方回传了完整思维链，就默认把它下发给浏览器。
 */
export function extractProviderReasoning(message, { allowRaw = false } = {}) {
  if (!allowRaw) return ''
  if (!message || typeof message !== 'object') return ''
  const raw = typeof message.reasoning_content === 'string'
    ? message.reasoning_content
    : typeof message.reasoning === 'string' ? message.reasoning : ''
  return normalize(raw, agentReasoningRawLimit)
}

/**
 * 收集一轮里的推理片段。同一段文本不重复堆叠，超过上限后只保留最近的片段，
 * 保证运行轨迹不会变成日志墙。
 */
export function appendAgentReasoning(reasoning, entry) {
  const text = typeof entry?.text === 'string' ? entry.text : ''
  if (!text) return reasoning
  if (reasoning.some((item) => item.text === text)) return reasoning
  const next = [...reasoning, {
    step: Number.isInteger(entry.step) && entry.step >= 0 ? entry.step : reasoning.length,
    source: entry.source === 'raw' ? 'raw' : 'summary',
    text,
  }]
  return next.length > agentReasoningStepLimit ? next.slice(next.length - agentReasoningStepLimit) : next
}
