// @ts-check

import { canonicalHash } from '../../canonicalHash.mjs'
import { estimateAgentContextTokens } from '../context/agentContextBudget.mjs'

const INTERNAL_FIELDS = new Set([
  'id',
  'revision',
  'messageId',
  'createdAt',
  'updatedAt',
  'reasoning',
  'reasoning_content',
  'analysis',
])
const PREFIX_ROLES = new Set(['system', 'developer'])
const MESSAGE_ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool'])
const MEDIA_PART_TYPES = new Set([
  'image',
  'image_url',
  'input_image',
  'audio',
  'input_audio',
  'video',
  'video_url',
  'input_video',
  'file',
  'input_file',
])
const MAX_CHECKPOINT_CODE_POINTS = 32_000

/** @type {WeakMap<object, any>} */
const SURFACE_INTERNALS = new WeakMap()

export class AgentModelContextSurfaceError extends TypeError {
  constructor(message) {
    super(message)
    this.name = 'AgentModelContextSurfaceError'
    this.code = 'AGENT_MODEL_CONTEXT_SURFACE_INVALID'
  }
}

function invalid(message) {
  throw new AgentModelContextSurfaceError(message)
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const entry of Object.values(value)) deepFreeze(entry)
  return Object.freeze(value)
}

function plainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${name}无效。`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid(`${name}必须是普通对象。`)
  return value
}

function boundedText(value, name, maximumLength = 512) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximumLength) {
    invalid(`${name}无效。`)
  }
  return value.trim()
}

function safeInteger(value, name, minimum = 0) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum) invalid(`${name}无效。`)
  return parsed
}

/**
 * Provider payload 必须是可复现的 JSON 值；函数、BigInt、自定义原型和循环引用
 * 不应悄悄丢字段后进入哈希或模型请求。
 *
 * @param {any} value
 * @param {string} name
 * @param {Set<object>} [ancestors]
 * @returns {any}
 */
function cloneJson(value, name, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(`${name}包含非有限数值。`)
    return value
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) invalid(`${name}包含循环引用。`)
    ancestors.add(value)
    const result = value.map((entry, index) => cloneJson(entry, `${name}[${index}]`, ancestors))
    ancestors.delete(value)
    return result
  }
  if (value && typeof value === 'object') {
    plainObject(value, name)
    if (ancestors.has(value)) invalid(`${name}包含循环引用。`)
    ancestors.add(value)
    /** @type {Record<string, any>} */
    const result = {}
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue
      result[key] = cloneJson(entry, `${name}.${key}`, ancestors)
    }
    ancestors.delete(value)
    return result
  }
  invalid(`${name}包含不可序列化值。`)
}

function providerMessage(message) {
  const result = cloneJson(message, 'Agent Model Context 消息')
  for (const key of INTERNAL_FIELDS) delete result[key]
  return result
}

function isMediaPart(part) {
  if (!part || typeof part !== 'object' || Array.isArray(part)) return false
  if (MEDIA_PART_TYPES.has(String(part.type ?? '').toLowerCase())) return true
  return Object.values(part).some((value) => (
    typeof value === 'string' && /^data:(?:image|audio|video|application)\//i.test(value)
  ))
}

function meterContent(content) {
  if (typeof content === 'string') return { content, mediaCount: 0 }
  if (content === null || content === undefined) return { content, mediaCount: 0 }
  if (!Array.isArray(content)) return { content, mediaCount: 0 }
  let mediaCount = 0
  const projected = content.map((part) => {
    if (isMediaPart(part)) {
      mediaCount += 1
      return { type: part?.type ?? 'media', content: '[media]' }
    }
    return part
  })
  return { content: projected, mediaCount }
}

function meterMessage(message) {
  const projected = providerMessage(message)
  const metered = meterContent(projected.content)
  projected.content = metered.content
  return {
    text: JSON.stringify(projected),
    mediaCount: metered.mediaCount,
  }
}

function messageRevision(message, messageIndex) {
  const id = typeof message.id === 'string' && message.id.trim()
    ? message.id.trim()
    : `message:${canonicalHash(providerMessage(message))}`
  const revision = Number.isSafeInteger(Number(message.revision)) && Number(message.revision) >= 0
    ? Number(message.revision)
    : null
  return { id, revision, messageIndex }
}

function normalizeMessages(value) {
  if (!Array.isArray(value)) invalid('Agent Model Context messages 必须是数组。')
  return value.map((raw, index) => {
    const message = cloneJson(plainObject(raw, `Agent Model Context 消息 ${index}`), `Agent Model Context 消息 ${index}`)
    message.role = boundedText(message.role, `Agent Model Context 消息 ${index}.role`, 32)
    if (!MESSAGE_ROLES.has(message.role)) invalid(`Agent Model Context 消息 ${index}.role 不受支持。`)
    if (!Object.hasOwn(message, 'content')) message.content = null
    if (!(message.content === null || typeof message.content === 'string' || Array.isArray(message.content))) {
      invalid(`Agent Model Context 消息 ${index}.content 无效。`)
    }
    return message
  })
}

function validateToolCalls(message, messageIndex, knownCallIds) {
  if (!Array.isArray(message.tool_calls) || !message.tool_calls.length) return []
  if (message.role !== 'assistant') invalid(`Agent Model Context 消息 ${messageIndex} 的 tool_calls 只能属于 assistant。`)
  return message.tool_calls.map((rawCall, callIndex) => {
    const call = plainObject(rawCall, `Agent Model Context tool_call ${messageIndex}.${callIndex}`)
    const id = boundedText(call.id, `Agent Model Context tool_call ${messageIndex}.${callIndex}.id`, 512)
    if (knownCallIds.has(id)) invalid(`Agent Model Context tool_call id 重复：${id}。`)
    knownCallIds.add(id)
    return id
  })
}

function makeUnit(kind, messages, firstMessageIndex) {
  const metered = messages.map(meterMessage)
  const providerMessages = messages.map(providerMessage)
  const contentHash = canonicalHash(providerMessages)
  const mediaCount = metered.reduce((total, entry) => total + entry.mediaCount, 0)
  const estimatedTokens = metered.reduce(
    (total, entry) => total + estimateAgentContextTokens(entry.text) + 8,
    0,
  )
  const revisions = messages.map((message, offset) => messageRevision(message, firstMessageIndex + offset))
  const safe = {
    kind,
    unitHash: canonicalHash({ kind, contentHash, roles: messages.map((message) => message.role) }),
    firstMessageIndex,
    messageCount: messages.length,
    roles: messages.map((message) => message.role),
    estimatedTokens,
    mediaCount,
  }
  return { safe, messages, providerMessages, meterTexts: metered.map((entry) => entry.text), revisions }
}

function groupMessages(messages) {
  /** @type {any[]} */
  const units = []
  const knownCallIds = new Set()
  let prefix = true
  let prefixUnitCount = 0
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (PREFIX_ROLES.has(message.role)) {
      if (!prefix) invalid('system/developer 消息只能位于 Agent Model Context 前缀。')
      validateToolCalls(message, index, knownCallIds)
      units.push(makeUnit('instruction', [message], index))
      prefixUnitCount += 1
      continue
    }
    prefix = false
    if (message.role === 'tool') invalid(`Agent Model Context 存在孤立 tool 消息：${index}。`)
    const callIds = validateToolCalls(message, index, knownCallIds)
    if (!callIds.length) {
      units.push(makeUnit('message', [message], index))
      continue
    }
    /** @type {any[]} */
    const toolMessages = []
    const results = new Set()
    let cursor = index + 1
    while (cursor < messages.length && messages[cursor].role === 'tool') {
      const toolMessage = messages[cursor]
      const callId = boundedText(toolMessage.tool_call_id, `Agent Model Context tool 消息 ${cursor}.tool_call_id`, 512)
      if (!callIds.includes(callId)) invalid(`Agent Model Context tool 消息 ${cursor} 未匹配前一 assistant。`)
      if (results.has(callId)) invalid(`Agent Model Context tool_call ${callId} 存在重复结果。`)
      results.add(callId)
      toolMessages.push(toolMessage)
      cursor += 1
    }
    const missing = callIds.filter((callId) => !results.has(callId))
    if (missing.length) invalid(`Agent Model Context tool_call 缺少结果：${missing.join(', ')}。`)
    units.push(makeUnit('tool_exchange', [message, ...toolMessages], index))
    index = cursor - 1
  }
  return { units, prefixUnitCount }
}

function buildSurface(input) {
  const model = boundedText(input?.model, 'Agent Model Context model', 160)
  const policyHash = input?.policyHash === undefined
    ? null
    : boundedText(input.policyHash, 'Agent Model Context policyHash', 256)
  const outputReserveTokens = input?.outputReserveTokens === undefined
    ? 0
    : safeInteger(input.outputReserveTokens, 'Agent Model Context outputReserveTokens')
  const messages = normalizeMessages(input?.messages)
  const tools = input?.tools === undefined ? [] : cloneJson(input.tools, 'Agent Model Context tools')
  if (!Array.isArray(tools)) invalid('Agent Model Context tools 必须是数组。')
  const { units, prefixUnitCount } = groupMessages(messages)
  const toolsHash = canonicalHash(tools)
  const staticHash = canonicalHash({
    version: 1,
    model,
    policyHash,
    outputReserveTokens,
    instructionUnitHashes: units.slice(0, prefixUnitCount).map((unit) => unit.safe.unitHash),
    toolsHash,
  })
  const surfaceHash = canonicalHash({
    version: 1,
    staticHash,
    unitHashes: units.map((unit) => unit.safe.unitHash),
  })
  const publicSurface = deepFreeze({
    version: 1,
    model,
    policyHash,
    outputReserveTokens,
    staticHash,
    surfaceHash,
    toolsHash,
    messageCount: messages.length,
    toolCount: tools.length,
    mediaCount: units.reduce((total, unit) => total + unit.safe.mediaCount, 0),
    estimatedMessageTokens: units.reduce((total, unit) => total + unit.safe.estimatedTokens, 0),
    units: units.map((unit) => unit.safe),
  })
  const systemMeterTexts = units.slice(0, prefixUnitCount).flatMap((unit) => unit.meterTexts)
  const messageMeterTexts = units.slice(prefixUnitCount).flatMap((unit) => unit.meterTexts)
  SURFACE_INTERNALS.set(publicSurface, {
    messages,
    tools,
    units,
    prefixUnitCount,
    meterProjection: deepFreeze({
      systemTexts: systemMeterTexts,
      messageTexts: messageMeterTexts,
      toolsText: JSON.stringify(tools),
      messageCount: messages.length,
      toolCount: tools.length,
      mediaCount: publicSurface.mediaCount,
    }),
  })
  return publicSurface
}

function internals(surface) {
  const state = surface && typeof surface === 'object' ? SURFACE_INTERNALS.get(surface) : undefined
  if (!state) invalid('Agent Model Context Surface 不是由本模块创建的实例。')
  return state
}

/**
 * 构造可安全持久化的 Model Context Surface。公开对象只包含计数和哈希；
 * 完整 provider messages/tools 留在进程内 WeakMap，避免被运行日志或 ledger 意外序列化。
 *
 * @param {{model:string,messages:any[],tools?:any[],policyHash?:string,outputReserveTokens?:number}} input
 */
export function createAgentModelContextSurface(input) {
  return buildSurface(input)
}

/** @param {object} surface */
export function agentModelContextProviderMessages(surface) {
  return internals(surface).messages.map(providerMessage)
}

/** @param {object} surface */
export function agentModelContextTools(surface) {
  return cloneJson(internals(surface).tools, 'Agent Model Context tools')
}

/**
 * 仅供 Token Meter 进程内消费；不要把返回值写入 Run、ledger 或日志。
 *
 * @param {object} surface
 */
export function agentModelContextMeterProjection(surface) {
  return internals(surface).meterProjection
}

function codePoints(value) {
  return Array.from(value)
}

function pruneSettings(policy) {
  const raw = plainObject(policy?.toolResultPrune, 'Agent tool result prune policy')
  const thresholdCodePoints = safeInteger(raw.thresholdCodePoints, 'thresholdCodePoints', 1)
  const headCodePoints = safeInteger(raw.headCodePoints, 'headCodePoints')
  const tailCodePoints = safeInteger(raw.tailCodePoints, 'tailCodePoints')
  if (headCodePoints + tailCodePoints >= thresholdCodePoints) invalid('Agent tool result prune policy 头尾保留量无效。')
  return { thresholdCodePoints, headCodePoints, tailCodePoints }
}

/**
 * 对长 tool result 做 DeepSeek 风格确定性 head/tail 裁剪。只改变 ephemeral surface，
 * 原始 Message 与原 surface 不变；operation 只含哈希和长度。
 *
 * @param {object} surface
 * @param {{toolResultPrune:any}} policy
 */
export function pruneAgentModelContextSurface(surface, policy) {
  const state = internals(surface)
  const settings = pruneSettings(policy)
  const messages = state.messages.map((message) => cloneJson(message, 'Agent Model Context 消息'))
  /** @type {any[]} */
  const replacements = []
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.role !== 'tool' || typeof message.content !== 'string') continue
    const points = codePoints(message.content)
    if (points.length <= settings.thresholdCodePoints) continue
    const contentHash = canonicalHash(message.content)
    const head = points.slice(0, settings.headCodePoints).join('')
    const tail = settings.tailCodePoints
      ? points.slice(points.length - settings.tailCodePoints).join('')
      : ''
    const replacement = JSON.stringify({
      _botanicPruning: {
        version: 1,
        pruned: true,
        reason: 'tool_result_size',
        contentHash,
        originalCodePoints: points.length,
        headCodePoints: codePoints(head).length,
        tailCodePoints: codePoints(tail).length,
      },
      head,
      tail,
    })
    message.content = replacement
    replacements.push({
      message: messageRevision(state.messages[index], index),
      sourceContentHash: contentHash,
      resultContentHash: canonicalHash(replacement),
      originalCodePoints: points.length,
      retainedCodePoints: codePoints(head).length + codePoints(tail).length,
    })
  }
  if (!replacements.length) return deepFreeze({ kind: 'no_change', reason: 'below_threshold', surface })
  const resultSurface = buildSurface({
    model: surface.model,
    policyHash: surface.policyHash ?? undefined,
    outputReserveTokens: surface.outputReserveTokens,
    messages,
    tools: state.tools,
  })
  return deepFreeze({
    kind: 'pruned',
    surface: resultSurface,
    operation: {
      version: 1,
      type: 'tool_result_prune',
      sourceSurfaceHash: surface.surfaceHash,
      resultSurfaceHash: resultSurface.surfaceHash,
      replacements,
    },
  })
}

export function sanitizeAgentModelContextCheckpoint(value) {
  let text = typeof value === 'string' ? value : String(value ?? '')
  text = text
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_SECRET]')
    .replace(/\b(api[_-]?key|access[_-]?token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/data:(?:image|audio|video|application)\/[^\s)'"<>]+/gi, '[已省略内联媒体]')
    .replace(/\/api\/media\/[^\s)'"<>]+/gi, '[已省略媒体引用]')
    .replace(/https?:\/\/[^\s)'"<>]+/gi, '[已省略外部链接]')
    .trim()
  const points = codePoints(text)
  if (points.length > MAX_CHECKPOINT_CODE_POINTS) {
    text = `${points.slice(0, MAX_CHECKPOINT_CODE_POINTS).join('')}\n…[checkpoint 已截断]`
  }
  if (!text) invalid('Agent compaction checkpoint 不能为空。')
  return text
}

function checkpointInput(value) {
  if (typeof value === 'string') return { content: sanitizeAgentModelContextCheckpoint(value), threadSummaryHash: null }
  const raw = plainObject(value, 'Agent compaction checkpoint')
  return {
    content: sanitizeAgentModelContextCheckpoint(raw.content),
    threadSummaryHash: raw.threadSummaryHash === undefined
      ? null
      : boundedText(raw.threadSummaryHash, 'Agent compaction checkpoint.threadSummaryHash', 256),
  }
}

function comparableInputTokens(surface, mediaTokensPerItem) {
  const state = internals(surface)
  return surface.estimatedMessageTokens
    + estimateAgentContextTokens(state.meterProjection.toolsText)
    + surface.mediaCount * mediaTokensPerItem
}

/**
 * 以一个确定性 checkpoint 替换旧历史。近期消息按完整 unit（含 tool exchange）保留，
 * 当前用户消息及其后的全部内容永不被本次压缩丢弃。
 *
 * @param {object} surface
 * @param {{checkpoint:string|{content:string,threadSummaryHash?:string},policy?:any,retainRecentTokens?:number,mediaTokensPerItem?:number,trigger?:'auto'|'overflow'|'manual'}} input
 */
export function compactAgentModelContextSurface(surface, input) {
  const state = internals(surface)
  const checkpoint = checkpointInput(input?.checkpoint)
  const retainRecentTokens = safeInteger(
    input?.retainRecentTokens ?? input?.policy?.retainRecentTokens,
    'Agent compaction retainRecentTokens',
  )
  const mediaTokensPerItem = safeInteger(
    input?.mediaTokensPerItem ?? input?.policy?.mediaTokensPerItem ?? 2_048,
    'Agent compaction mediaTokensPerItem',
  )
  const trigger = input?.trigger ?? 'auto'
  if (!['auto', 'overflow', 'manual'].includes(trigger)) invalid('Agent compaction trigger 无效。')
  const history = state.units.slice(state.prefixUnitCount)
  if (!history.length) return deepFreeze({ kind: 'no_change', reason: 'no_history', surface })
  let protectedIndex = history.findLastIndex((unit) => unit.messages.some((message) => message.role === 'user'))
  if (protectedIndex < 0) protectedIndex = history.length - 1
  let retainedStart = protectedIndex
  let retainedTokens = history.slice(retainedStart).reduce((total, unit) => total + unit.safe.estimatedTokens, 0)
  while (retainedStart > 0) {
    const candidate = history[retainedStart - 1]
    if (retainedTokens + candidate.safe.estimatedTokens > retainRecentTokens) break
    retainedStart -= 1
    retainedTokens += candidate.safe.estimatedTokens
  }
  const replaced = history.slice(0, retainedStart)
  if (!replaced.length) return deepFreeze({ kind: 'no_change', reason: 'no_replaceable_history', surface })
  const retained = history.slice(retainedStart)
  const checkpointHash = canonicalHash(checkpoint.content)
  const checkpointMessage = {
    id: `compaction:${checkpointHash}`,
    revision: 1,
    role: 'user',
    content: checkpoint.content,
  }
  const messages = [
    ...state.units.slice(0, state.prefixUnitCount).flatMap((unit) => unit.messages),
    checkpointMessage,
    ...retained.flatMap((unit) => unit.messages),
  ]
  const resultSurface = buildSurface({
    model: surface.model,
    policyHash: surface.policyHash ?? undefined,
    outputReserveTokens: surface.outputReserveTokens,
    messages,
    tools: state.tools,
  })
  if (resultSurface.surfaceHash === surface.surfaceHash) {
    return deepFreeze({ kind: 'no_change', reason: 'same_surface', surface })
  }
  if (comparableInputTokens(resultSurface, mediaTokensPerItem) >= comparableInputTokens(surface, mediaTokensPerItem)) {
    return deepFreeze({ kind: 'no_change', reason: 'not_smaller', surface })
  }
  return deepFreeze({
    kind: 'compacted',
    surface: resultSurface,
    operation: {
      version: 1,
      type: 'checkpoint_replace',
      trigger,
      sourceSurfaceHash: surface.surfaceHash,
      resultSurfaceHash: resultSurface.surfaceHash,
      checkpoint: {
        contentHash: checkpointHash,
        threadSummaryHash: checkpoint.threadSummaryHash,
      },
      replacedUnitHashes: replaced.map((unit) => unit.safe.unitHash),
      retainedUnitHashes: retained.map((unit) => unit.safe.unitHash),
      replacedMessageRevisions: replaced.flatMap((unit) => unit.revisions),
    },
  })
}
