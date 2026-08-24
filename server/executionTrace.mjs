// @ts-check

/**
 * 执行阶段词表。ARCHITECTURE 的「失败可定位原则」要求错误能定位到具体阶段，
 * 这里是该原则的唯一词表来源。
 *
 * 阶段必须由生产方显式声明。不允许从错误文案反推 —— 文案一改分类就会静默漂移，
 * 而且会绑定语言（旧实现用 `error.includes('队列')` 区分 queue 与 provider，
 * 任何措辞调整都会把队列失败误报成 Provider 失败）。判不出来就用 `unknown`，
 * 明确的「不知道」比错误的确定分类有用。
 */
export const EXECUTION_STAGES = Object.freeze([
  'turn',
  'planning',
  'compile',
  'approval',
  'tool',
  'queue',
  'provider',
  'media',
  'canvas',
  'artifact',
  'writeback',
  'review',
  'delivery',
  'unknown',
])

const stageSet = new Set(EXECUTION_STAGES)

export function isExecutionStage(value) {
  return typeof value === 'string' && stageSet.has(value)
}

const STAGE_ERROR_MESSAGE_LIMIT = 500

/**
 * 会把敏感内容带进日志的模式。错误消息经常由 Provider 回包或内部字符串拼接而来，
 * 因此这里做兜底脱敏，而不是指望每个抛错点都记得不要拼。
 */
/** @type {Array<{ pattern: RegExp, replacement: string }>} */
const redactions = [
  { pattern: /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/giu, replacement: '[redacted-inline-media]' },
  { pattern: /https?:\/\/[^\s"'<>）)]+/giu, replacement: '[redacted-url]' },
  { pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/giu, replacement: '[redacted-key]' },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/giu, replacement: '[redacted-token]' },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/gu, replacement: '[redacted-jwt]' },
]

/** 对外可见的错误摘要脱敏。返回值可以安全进日志、HTTP 响应与事件载荷。 */
export function redactSensitive(value) {
  if (typeof value !== 'string' || !value) return ''
  return redactions
    .reduce((text, { pattern, replacement }) => text.replace(pattern, replacement), value)
    .slice(0, STAGE_ERROR_MESSAGE_LIMIT)
}

/**
 * 构造阶段化错误摘要。未知阶段收敛为 `unknown` 而不是抛错 —— 可观测性不得
 * 改变业务状态，一个分类不出来的错误不应该再引发第二个错误。
 *
 * @param {{ stage?: string, code?: string, message?: string, recoverable?: boolean }} input
 */
export function stageError(input = {}) {
  const stage = isExecutionStage(input.stage) ? input.stage : 'unknown'
  const code = typeof input.code === 'string' && input.code.trim()
    ? input.code.trim().slice(0, 120)
    : 'UNSPECIFIED_ERROR'
  const message = redactSensitive(input.message ?? '')
  return {
    stage,
    code,
    ...(message ? { message } : {}),
    ...(typeof input.recoverable === 'boolean' ? { recoverable: input.recoverable } : {}),
  }
}

/**
 * 贯穿 Turn / Run / Job / Artifact / Review 的关联标识。
 *
 * 已经传播过来的 `traceId` 永远优先：trace 的正确模型是「起始实体生成一次、
 * 下游携带」，而不是「各处从自己的 ID 推一个」。派生式 ID 结构上无法跨实体 ——
 * 没创建 Run 的 Turn 就没有 trace，创建多个 Run 的 Turn 会得到多个互不关联的 trace。
 *
 * 当前 Turn / Run / Job 都还没有持久化 traceId 字段，因此下面保留既有派生形式作为
 * 兜底，保证本次改动不改变任何现有 ID。字段落库后调用方只需把 traceId 传进来，
 * 这里不必再改。
 */
export function executionTraceId(source) {
  const { traceId, turnId, runId, jobId } = source ?? {}
  if (typeof traceId === 'string' && traceId) return traceId
  if (typeof turnId === 'string' && turnId) return `agent-trace:turn:${turnId}`
  if (typeof runId === 'string' && runId) return `agent-trace:${runId}`
  if (typeof jobId === 'string' && jobId) return `agent-trace:job:${jobId}`
  return undefined
}
