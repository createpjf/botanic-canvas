// @ts-check

const CONTEXT_OVERFLOW_STATUSES = new Set([400, 413, 422])
const FAILURE_BODY_LIMIT = 16_000
const EXPLICIT_CONTEXT_OVERFLOW = /(?:context[_ -]?length[_ -]?exceeded|maximum context length|context window[^\n]{0,80}(?:too (?:large|long)|exceed)|too many (?:input )?tokens|prompt (?:is )?too long|input (?:is )?too long)/iu

/** Provider 原始失败正文不得进入错误、日志或持久化实体。 */
export class AgentProviderContextOverflowError extends Error {
  constructor() {
    super('Agent 模型上下文超过提供方限制。')
    this.name = 'AgentProviderContextOverflowError'
    this.code = 'AGENT_CONTEXT_OVERFLOW'
    this.statusCode = 422
  }
}

/**
 * 仅根据状态码和失败正文前 16k 判断明确的上下文溢出；不匹配时保持静默，
 * 由调用方继续既有 Provider 错误归一。原始正文永不挂到抛出的 Error 上。
 */
export function throwIfAgentProviderContextOverflow(status, body) {
  if (!CONTEXT_OVERFLOW_STATUSES.has(Number(status))) return
  const boundedBody = typeof body === 'string' ? body.slice(0, FAILURE_BODY_LIMIT) : ''
  if (EXPLICIT_CONTEXT_OVERFLOW.test(boundedBody)) {
    throw new AgentProviderContextOverflowError()
  }
}
