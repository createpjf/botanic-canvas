// @ts-check
import { randomUUID } from 'node:crypto'
import { outboundAgentTraceHeaders } from './agentTraceContext.mjs'
import { canonicalHash } from './canonicalHash.mjs'
import {
  AgentStructuredContractError,
  normalizeAgentStructuredObjectSchema,
  projectAgentStructuredObject,
} from './agentStructuredContract.mjs'

const NAME = /^[a-z][a-z0-9_-]{1,79}$/
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const CAPABILITY_HASH = /^[A-Za-z0-9_-]{32,128}$/
const ACTION_INTENT = /^[A-Za-z0-9_-]{16,128}$/
const DEFAULT_TIMEOUT_MS = 12_000
const DEFAULT_RESPONSE_BYTES = 256 * 1024
const MIN_RESPONSE_BYTES = 1024
const MAX_RESPONSE_BYTES = 1024 * 1024
const LEGACY_OPEN_OBJECT_SCHEMA = normalizeAgentStructuredObjectSchema({
  type: 'object',
  additionalProperties: true,
})

/** @typedef {import('./agentStructuredContract.mjs').AgentStructuredObjectSchema} AgentStructuredObjectSchema */

/**
 * @typedef {{
 *   key: string,
 *   server: string,
 *   tool: string,
 *   version: string,
 *   capabilityHash: string,
 *   inputSchema: AgentStructuredObjectSchema,
 *   outputSchema: AgentStructuredObjectSchema,
 *   url: string,
 *   authToken?: string,
 *   timeoutMs: number,
 *   maximumResponseBytes: number,
 * }} McpToolConfiguration
 */

/**
 * @typedef {{
 *   key: string,
 *   server: string,
 *   tool: string,
 *   version: string,
 *   capabilityHash: string,
 *   inputSchema: AgentStructuredObjectSchema,
 *   outputSchema: AgentStructuredObjectSchema,
 *   replayPolicy: 'never',
 * }} McpCatalogEntry
 */

/** @param {unknown} value */
function actionIntentHeader(value) {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return ACTION_INTENT.test(normalized) ? normalized : undefined
}

export class McpClientError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [statusCode]
   * @param {{ outcomeKnown?: boolean }} [options]
   */
  constructor(code, message, statusCode = 502, options) {
    super(message)
    this.name = 'McpClientError'
    this.code = code
    this.statusCode = statusCode
    // MCP 是 never-replay 行动。只有「请求发出前拒绝」才能证明没有产生副作用；
    // 远端 error、网络/协议/截断故障都交给 Receipt 收敛成 outcome_unknown。
    this.outcomeKnown = options?.outcomeKnown === true
    this.replayPolicy = 'never'
    this.outcome = this.outcomeKnown ? 'known_failure' : 'outcome_unknown'
  }
}

/** @param {unknown} value */
function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
    ? /** @type {Record<string, any>} */ (value)
    : undefined
}

/** @param {unknown} value @param {string} key */
function toolVersion(value, key) {
  const normalized = value === undefined ? '1' : String(value).trim()
  if (!VERSION.test(normalized)) throw new TypeError(`MCP 工具版本无效：${key}。`)
  return normalized
}

/** @param {unknown} value */
function boundedResponseBytes(value) {
  if (value === undefined) return DEFAULT_RESPONSE_BYTES
  const number = Number(value)
  if (!Number.isInteger(number) || number < MIN_RESPONSE_BYTES || number > MAX_RESPONSE_BYTES) {
    throw new TypeError(`MCP 响应上限必须是 ${MIN_RESPONSE_BYTES} 到 ${MAX_RESPONSE_BYTES} 字节。`)
  }
  return number
}

/** @param {unknown} value @param {string} label */
function structuredSchema(value, label) {
  if (value === undefined) return LEGACY_OPEN_OBJECT_SCHEMA
  try {
    return normalizeAgentStructuredObjectSchema(value, { label })
  } catch (caught) {
    if (caught instanceof AgentStructuredContractError) throw new TypeError(`${label}无效：${caught.message}`)
    throw caught
  }
}

/**
 * 解析配置并冻结 capability identity。`url` 与 `authToken` 只留在服务端闭包内；
 * capability hash 仅由可公开的工具身份和结构化契约计算，配置重排不会漂移。
 *
 * @param {unknown} value
 * @returns {ReadonlyArray<Readonly<McpToolConfiguration>>}
 */
export function parseMcpToolConfigurations(value) {
  if (!value) return Object.freeze([])
  let parsed
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value
  } catch {
    throw new TypeError('MCP 工具配置不是有效 JSON。')
  }
  if (!Array.isArray(parsed) || parsed.length > 30) throw new TypeError('MCP 工具配置无效。')
  const keys = new Set()
  return Object.freeze(parsed.map((rawEntry) => {
    const entry = plainRecord(rawEntry)
    if (!entry || typeof entry.server !== 'string' || typeof entry.tool !== 'string'
      || !NAME.test(entry.server) || !NAME.test(entry.tool)) {
      throw new TypeError('MCP 服务或工具名称无效。')
    }
    const key = `${entry.server}.${entry.tool}`
    if (keys.has(key)) throw new TypeError(`MCP 工具配置重复：${key}。`)
    keys.add(key)
    if (typeof entry.url !== 'string') throw new TypeError(`MCP 工具地址无效：${key}。`)
    let url
    try { url = new URL(entry.url) } catch { throw new TypeError(`MCP 工具地址无效：${key}。`) }
    const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
    if (url.protocol !== 'https:' && !localHttp) throw new TypeError(`MCP 工具必须使用 HTTPS：${key}。`)
    const version = toolVersion(entry.version, key)
    const inputSchema = structuredSchema(entry.inputSchema, `MCP ${key} 输入 Schema`)
    const outputSchema = structuredSchema(entry.outputSchema, `MCP ${key} 输出 Schema`)
    const capabilityHash = canonicalHash({
      protocol: 'jsonrpc-2.0/tools-call',
      server: entry.server,
      tool: entry.tool,
      version,
      inputSchema,
      outputSchema,
      replayPolicy: 'never',
    })
    if (entry.capabilityHash !== undefined
      && (typeof entry.capabilityHash !== 'string'
        || !CAPABILITY_HASH.test(entry.capabilityHash)
        || entry.capabilityHash !== capabilityHash)) {
      throw new TypeError(`MCP 工具 capabilityHash 不匹配：${key}。`)
    }
    return Object.freeze({
      key,
      server: entry.server,
      tool: entry.tool,
      version,
      capabilityHash,
      inputSchema,
      outputSchema,
      url: url.toString(),
      authToken: typeof entry.authToken === 'string' && entry.authToken ? entry.authToken : undefined,
      timeoutMs: Number.isInteger(entry.timeoutMs)
        ? Math.min(30_000, Math.max(1_000, entry.timeoutMs))
        : DEFAULT_TIMEOUT_MS,
      maximumResponseBytes: boundedResponseBytes(entry.maxResponseBytes ?? entry.maximumResponseBytes),
    })
  }))
}

/** @param {McpToolConfiguration} configuration @returns {Readonly<McpCatalogEntry>} */
function catalogEntry(configuration) {
  return Object.freeze({
    key: configuration.key,
    server: configuration.server,
    tool: configuration.tool,
    version: configuration.version,
    capabilityHash: configuration.capabilityHash,
    inputSchema: configuration.inputSchema,
    outputSchema: configuration.outputSchema,
    replayPolicy: 'never',
  })
}

/** @param {unknown} signal */
function abortSignal(signal) {
  return signal && typeof signal === 'object'
    && typeof /** @type {any} */ (signal).aborted === 'boolean'
    && typeof /** @type {any} */ (signal).addEventListener === 'function'
    ? /** @type {AbortSignal} */ (signal)
    : undefined
}

/**
 * 先以字节流收口，再解码/JSON.parse；不会先把不受限响应完整载入字符串。
 *
 * @param {Response} response
 * @param {number} maximumBytes
 */
async function readBoundedResponseText(response, maximumBytes) {
  const reader = response.body?.getReader?.()
  if (!reader) {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > maximumBytes) {
      throw new McpClientError('MCP_RESPONSE_TOO_LARGE', 'MCP 工具响应超过允许大小。')
    }
    return text
  }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let total = 0
  let text = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      const bytes = chunk.value
      total += bytes.byteLength
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw new McpClientError('MCP_RESPONSE_TOO_LARGE', 'MCP 工具响应超过允许大小。')
      }
      text += decoder.decode(bytes, { stream: true })
    }
    return text + decoder.decode()
  } catch (caught) {
    if (caught instanceof McpClientError) throw caught
    throw new McpClientError('MCP_INVALID_RESPONSE', 'MCP 工具响应无效。')
  } finally {
    reader.releaseLock()
  }
}

/** @param {unknown} value */
function requestId(value) {
  if ((typeof value !== 'string' && typeof value !== 'number')
    || (typeof value === 'string' && (!value || value.length > 160))
    || (typeof value === 'number' && !Number.isSafeInteger(value))) {
    throw new McpClientError('MCP_REQUEST_INVALID', 'MCP 请求标识无效。', 500, { outcomeKnown: true })
  }
  return value
}

/** @param {unknown} body @param {string | number} expectedId @param {Response} response */
function jsonRpcResult(body, expectedId, response) {
  const envelope = plainRecord(body)
  if (!envelope || envelope.jsonrpc !== '2.0' || envelope.id !== expectedId) {
    throw new McpClientError('MCP_INVALID_RESPONSE', 'MCP 工具响应无效。')
  }
  const hasResult = Object.hasOwn(envelope, 'result')
  const hasError = Object.hasOwn(envelope, 'error')
  if (hasResult === hasError) throw new McpClientError('MCP_INVALID_RESPONSE', 'MCP 工具响应无效。')
  if (hasError) {
    const error = plainRecord(envelope.error)
    if (!error || !Number.isInteger(error.code)
      || typeof error.message !== 'string' || !error.message.trim() || error.message.length > 1000) {
      throw new McpClientError('MCP_INVALID_RESPONSE', 'MCP 工具响应无效。')
    }
    // 通用 MCP 工具可能在返回 application error 前已经产生部分副作用。除非未来协议
    // 提供可验证的「未执行」收据，否则 never-replay 行动仍按 outcome_unknown 收口。
    throw new McpClientError(
      'MCP_TOOL_FAILED',
      'MCP 工具执行失败。',
      response.status >= 400 && response.status <= 599 ? response.status : 502,
    )
  }
  if (!response.ok) throw new McpClientError('MCP_INVALID_RESPONSE', 'MCP 工具响应无效。')
  return envelope.result
}

/** @param {unknown} expected @param {string} actual @param {string} field */
function assertExpectedCapability(expected, actual, field) {
  if (expected === undefined) return
  if (typeof expected !== 'string' || expected !== actual) {
    throw new McpClientError(
      'MCP_CAPABILITY_STALE',
      `MCP 工具${field}已变化，请重新确认行动。`,
      409,
      { outcomeKnown: true },
    )
  }
}

/**
 * MCP Runtime V2：只公开 `catalog()` 与 `invoke()`。catalog 是可冻结进 Turn/Action 的
 * 安全能力快照；URL、token 和传输参数不进入快照。
 *
 * @param {ReadonlyArray<McpToolConfiguration>} configurations
 * @param {{ fetchImpl?: typeof fetch, idFactory?: () => unknown }} [options]
 */
export function createConfiguredMcpRuntime(configurations, options) {
  const fetchImpl = options?.fetchImpl ?? fetch
  const idFactory = options?.idFactory ?? randomUUID
  const byKey = new Map(configurations.map((configuration) => [configuration.key, configuration]))
  const catalog = Object.freeze(configurations.map(catalogEntry))

  return Object.freeze({
    /** @returns {ReadonlyArray<Readonly<McpCatalogEntry>>} */
    catalog() {
      return catalog
    },

    /**
     * @param {string} key
     * @param {unknown} argumentsValue
     * @param {{
     *   signal?: AbortSignal,
     *   actionIntentHash?: string,
     *   expectedCapabilityHash?: string,
     *   expectedVersion?: string,
     * }} [context]
     */
    async invoke(key, argumentsValue, context) {
      const configuration = byKey.get(key)
      if (!configuration) {
        throw new McpClientError('MCP_TOOL_NOT_ALLOWED', 'MCP 工具不在允许列表。', 403, { outcomeKnown: true })
      }
      assertExpectedCapability(context?.expectedCapabilityHash, configuration.capabilityHash, '能力契约')
      assertExpectedCapability(context?.expectedVersion, configuration.version, '版本')

      let projectedArguments
      try {
        projectedArguments = projectAgentStructuredObject(
          configuration.inputSchema,
          argumentsValue,
          { label: 'MCP input' },
        )
      } catch (caught) {
        if (caught instanceof AgentStructuredContractError) {
          throw new McpClientError('MCP_INPUT_INVALID', 'MCP 工具输入不符合能力契约。', 422, { outcomeKnown: true })
        }
        throw caught
      }

      const outerSignal = abortSignal(context?.signal)
      if (outerSignal?.aborted) {
        throw new McpClientError('REQUEST_CANCELLED', 'MCP 工具调用已取消。', 499, { outcomeKnown: true })
      }
      const timeoutSignal = AbortSignal.timeout(configuration.timeoutMs)
      const signal = outerSignal ? AbortSignal.any([outerSignal, timeoutSignal]) : timeoutSignal
      const actionIntent = actionIntentHeader(context?.actionIntentHash)
      const id = requestId(idFactory())
      let response
      try {
        response = await fetchImpl(configuration.url, {
          method: 'POST',
          // MCP 地址来自受控配置；禁止 Provider 重定向到内网、metadata 或不同信任域。
          redirect: 'error',
          headers: {
            ...outboundAgentTraceHeaders(),
            Accept: 'application/json',
            'Content-Type': 'application/json',
            ...(configuration.authToken ? { Authorization: `Bearer ${configuration.authToken}` } : {}),
            ...(actionIntent ? { 'X-Botanic-Action-Intent': actionIntent } : {}),
          },
          body: JSON.stringify({
            jsonrpc: '2.0', id, method: 'tools/call',
            params: { name: configuration.tool, arguments: projectedArguments },
          }),
          signal,
        })
      } catch {
        if (outerSignal?.aborted) throw new McpClientError('REQUEST_CANCELLED', 'MCP 工具调用已取消。', 499)
        throw new McpClientError('MCP_UNAVAILABLE', timeoutSignal.aborted ? 'MCP 工具调用超时。' : 'MCP 工具暂时不可用。')
      }

      let text
      try {
        text = await readBoundedResponseText(response, configuration.maximumResponseBytes)
      } catch (caught) {
        if (outerSignal?.aborted) throw new McpClientError('REQUEST_CANCELLED', 'MCP 工具调用已取消。', 499)
        if (caught instanceof McpClientError) throw caught
        throw new McpClientError('MCP_INVALID_RESPONSE', 'MCP 工具响应无效。')
      }
      let body
      try { body = JSON.parse(text) } catch { throw new McpClientError('MCP_INVALID_RESPONSE', 'MCP 工具响应无效。') }
      const result = jsonRpcResult(body, id, response)
      try {
        return projectAgentStructuredObject(configuration.outputSchema, result, { label: 'MCP output' })
      } catch (caught) {
        if (caught instanceof AgentStructuredContractError) {
          throw new McpClientError('MCP_OUTPUT_INVALID', 'MCP 工具输出不符合能力契约。')
        }
        throw caught
      }
    },
  })
}

/**
 * 旧调用方兼容层：仍返回 `{ "server.tool": async fn }`，实际执行统一进入 Runtime V2。
 *
 * @param {ReadonlyArray<McpToolConfiguration>} configurations
 * @param {{ fetchImpl?: typeof fetch, idFactory?: () => unknown }} [options]
 */
export function createConfiguredMcpTools(configurations, options) {
  const runtime = createConfiguredMcpRuntime(configurations, options)
  return Object.fromEntries(runtime.catalog().map((entry) => [
    entry.key,
    (argumentsValue, context) => runtime.invoke(entry.key, argumentsValue, context),
  ]))
}
