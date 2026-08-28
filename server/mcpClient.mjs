import { randomUUID } from 'node:crypto'
import { outboundAgentTraceHeaders } from './agentTraceContext.mjs'

const NAME = /^[a-z][a-z0-9_-]{1,79}$/
const ACTION_INTENT = /^[A-Za-z0-9_-]{16,128}$/

function actionIntentHeader(value) {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return ACTION_INTENT.test(normalized) ? normalized : undefined
}

export class McpClientError extends Error {
  constructor(code, message, statusCode = 502) {
    super(message)
    this.code = code
    this.statusCode = statusCode
  }
}

export function parseMcpToolConfigurations(value) {
  if (!value) return []
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new TypeError('MCP 工具配置不是有效 JSON。')
  }
  if (!Array.isArray(parsed) || parsed.length > 30) throw new TypeError('MCP 工具配置无效。')
  const keys = new Set()
  return parsed.map((entry) => {
    if (!entry || typeof entry !== 'object' || !NAME.test(entry.server) || !NAME.test(entry.tool)) {
      throw new TypeError('MCP 服务或工具名称无效。')
    }
    const key = `${entry.server}.${entry.tool}`
    if (keys.has(key)) throw new TypeError(`MCP 工具配置重复：${key}。`)
    keys.add(key)
    let url
    try { url = new URL(entry.url) } catch { throw new TypeError(`MCP 工具地址无效：${key}。`) }
    const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
    if (url.protocol !== 'https:' && !localHttp) throw new TypeError(`MCP 工具必须使用 HTTPS：${key}。`)
    return {
      key,
      server: entry.server,
      tool: entry.tool,
      url: url.toString(),
      authToken: typeof entry.authToken === 'string' && entry.authToken ? entry.authToken : undefined,
      timeoutMs: Number.isInteger(entry.timeoutMs) ? Math.min(30_000, Math.max(1_000, entry.timeoutMs)) : 12_000,
    }
  })
}

export function createConfiguredMcpTools(configurations, {
  fetchImpl = fetch,
  idFactory = randomUUID,
} = {}) {
  return Object.fromEntries(configurations.map((configuration) => [configuration.key, async (argumentsValue, context = {}) => {
    const timeoutSignal = AbortSignal.timeout(configuration.timeoutMs)
    const outerSignal = context?.signal instanceof AbortSignal ? context.signal : undefined
    const signal = outerSignal ? AbortSignal.any([outerSignal, timeoutSignal]) : timeoutSignal
    const actionIntent = actionIntentHeader(context?.actionIntentHash)
    let response
    try {
      response = await fetchImpl(configuration.url, {
        method: 'POST',
        headers: {
          ...outboundAgentTraceHeaders(),
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(configuration.authToken ? { Authorization: `Bearer ${configuration.authToken}` } : {}),
          ...(actionIntent ? { 'X-Botanic-Action-Intent': actionIntent } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0', id: idFactory(), method: 'tools/call',
          params: { name: configuration.tool, arguments: argumentsValue },
        }),
        signal,
      })
    } catch (caught) {
      if (outerSignal?.aborted) throw new McpClientError('REQUEST_CANCELLED', 'MCP 工具调用已取消。', 499)
      throw new McpClientError('MCP_UNAVAILABLE', timeoutSignal.aborted ? 'MCP 工具调用超时。' : 'MCP 工具暂时不可用。')
    }
    let body
    try { body = await response.json() } catch { throw new McpClientError('MCP_INVALID_RESPONSE', 'MCP 工具响应无效。') }
    if (!response.ok || body?.error) {
      throw new McpClientError('MCP_TOOL_FAILED', 'MCP 工具执行失败。', response.status >= 400 ? response.status : 502)
    }
    if (!body || typeof body !== 'object' || body.result === undefined) {
      throw new McpClientError('MCP_INVALID_RESPONSE', 'MCP 工具响应无效。')
    }
    return structuredClone(body.result)
  }]))
}
