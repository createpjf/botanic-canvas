// @ts-check

import { estimateAgentContextTokens } from './agent/context/agentContextBudget.mjs'
import { agentModelContextMeterProjection } from './agent/model/agentModelContextSurface.mjs'

export class AgentTokenMeterError extends TypeError {
  constructor(message) {
    super(message)
    this.name = 'AgentTokenMeterError'
    this.code = 'AGENT_TOKEN_METER_INVALID'
  }
}

function invalid(message) {
  throw new AgentTokenMeterError(message)
}

function optionalCount(value, name) {
  if (value === undefined || value === null) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) invalid(`${name}无效。`)
  return parsed
}

function firstCount(value, keys, name) {
  for (const key of keys) {
    if (value[key] !== undefined) return optionalCount(value[key], `${name}.${key}`)
  }
  return undefined
}

/**
 * 统一 OpenAI/DeepSeek snake_case 与常见 camelCase usage。
 * 无 input 信息时返回 undefined；有 total + output 时可安全反推 input。
 *
 * @param {any} usage
 */
export function normalizeAgentProviderUsage(usage) {
  if (usage === undefined || usage === null) return undefined
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) invalid('Provider usage 无效。')
  let inputTokens = firstCount(usage, [
    'input_tokens', 'prompt_tokens', 'inputTokens', 'promptTokens', 'promptTokenCount',
  ], 'Provider usage')
  const outputTokens = firstCount(usage, [
    'output_tokens', 'completion_tokens', 'outputTokens', 'completionTokens', 'candidatesTokenCount',
  ], 'Provider usage')
  const totalTokens = firstCount(usage, ['total_tokens', 'totalTokens', 'totalTokenCount'], 'Provider usage')
  if (inputTokens === undefined && totalTokens !== undefined && outputTokens !== undefined) {
    if (outputTokens > totalTokens) invalid('Provider usage output 超过 total。')
    inputTokens = totalTokens - outputTokens
  }
  if (inputTokens === undefined) return undefined
  if (totalTokens !== undefined && inputTokens > totalTokens) invalid('Provider usage input 超过 total。')
  return Object.freeze({
    inputTokens,
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  })
}

function validatePolicy(surface, policy) {
  if (!policy || typeof policy !== 'object') invalid('Agent Token Meter policy 无效。')
  if (policy.model !== surface.model) invalid('Agent Token Meter policy 与 surface model 不一致。')
  if (surface.policyHash && policy.hash !== surface.policyHash) invalid('Agent Token Meter policy hash 与 surface 不一致。')
  const fields = [
    'contextWindowTokens', 'outputReserveTokens', 'safetyMarginTokens',
    'maxInputTokens', 'autoCompactAtTokens', 'mediaTokensPerItem',
  ]
  for (const field of fields) optionalCount(policy[field], `Agent Token Meter policy.${field}`)
  if (surface.outputReserveTokens !== policy.outputReserveTokens) {
    invalid('Agent Token Meter output reserve 与 surface 不一致。')
  }
}

function usableAnchor(surface, anchor) {
  if (!anchor || typeof anchor !== 'object') return undefined
  if (anchor.version !== 1 || anchor.model !== surface.model || anchor.staticHash !== surface.staticHash) return undefined
  const inputTokens = optionalCount(anchor.inputTokens, 'Token usage anchor.inputTokens')
  const heuristicInputTokens = optionalCount(anchor.heuristicInputTokens, 'Token usage anchor.heuristicInputTokens')
  if (inputTokens === undefined || heuristicInputTokens === undefined) return undefined
  return { ...anchor, inputTokens, heuristicInputTokens }
}

/**
 * Provider 无 usage 时用确定性保守估算；有 usage anchor 时，以 provider 已观测输入为锚，
 * 对锚点后的 surface 变化追加 heuristic delta，避免每轮回退为纯字符计数。
 *
 * @param {object} surface
 * @param {{policy:any,usageAnchor?:any}} input
 */
export function measureAgentModelContextSurface(surface, input) {
  const policy = input?.policy
  validatePolicy(surface, policy)
  const projection = agentModelContextMeterProjection(surface)
  const systemTokens = projection.systemTexts.reduce(
    (total, text) => total + estimateAgentContextTokens(text), 0,
  )
  const messageTokens = projection.messageTexts.reduce(
    (total, text) => total + estimateAgentContextTokens(text), 0,
  )
  const toolDefinitionTokens = estimateAgentContextTokens(projection.toolsText)
  const mediaTokens = projection.mediaCount * policy.mediaTokensPerItem
  const structureTokens = projection.messageCount * 8 + projection.toolCount * 12 + 16
  const heuristicInputTokens = systemTokens + messageTokens + toolDefinitionTokens + mediaTokens + structureTokens
  const anchor = usableAnchor(surface, input?.usageAnchor)
  let source = 'heuristic'
  let anchoredInputTokens
  if (anchor) {
    if (anchor.surfaceHash === surface.surfaceHash) {
      source = 'provider_anchor'
      anchoredInputTokens = anchor.inputTokens
    } else {
      source = 'provider_anchor_delta'
      anchoredInputTokens = Math.max(0, anchor.inputTokens + heuristicInputTokens - anchor.heuristicInputTokens)
    }
  }
  const inputTokens = anchoredInputTokens === undefined
    ? heuristicInputTokens
    : Math.max(heuristicInputTokens, anchoredInputTokens)
  const projectedContextTokens = inputTokens + surface.outputReserveTokens + policy.safetyMarginTokens
  const overLimit = inputTokens > policy.maxInputTokens
  const shouldCompact = projectedContextTokens >= policy.autoCompactAtTokens || overLimit
  return Object.freeze({
    version: 1,
    model: surface.model,
    policyHash: policy.hash,
    surfaceHash: surface.surfaceHash,
    staticHash: surface.staticHash,
    source,
    inputTokens,
    heuristicInputTokens,
    ...(anchoredInputTokens === undefined ? {} : { anchoredInputTokens }),
    outputReserveTokens: surface.outputReserveTokens,
    safetyMarginTokens: policy.safetyMarginTokens,
    projectedContextTokens,
    contextWindowTokens: policy.contextWindowTokens,
    maxInputTokens: policy.maxInputTokens,
    remainingInputTokens: Math.max(0, policy.maxInputTokens - inputTokens),
    utilizationRatio: projectedContextTokens / policy.contextWindowTokens,
    shouldCompact,
    overLimit,
    breakdown: Object.freeze({
      systemTokens,
      messageTokens,
      toolDefinitionTokens,
      mediaTokens,
      structureTokens,
    }),
  })
}

/**
 * 从一次 provider 回执建立安全锚点。锚点只保存 usage 数值与 surface 哈希，
 * 不保存 prompt、tool payload 或媒体。
 *
 * @param {{surface:any,meter:any,usage:any,provider?:string,turnId?:string,step?:number,observedAt?:number}} input
 */
export function createAgentTokenUsageAnchor(input) {
  const usage = normalizeAgentProviderUsage(input?.usage)
  if (!usage) return undefined
  const surface = input?.surface
  const meter = input?.meter
  if (!surface || meter?.surfaceHash !== surface.surfaceHash || meter?.staticHash !== surface.staticHash) {
    invalid('Token usage anchor 的 meter 与 surface 不一致。')
  }
  const provider = input?.provider === undefined ? undefined : String(input.provider).trim()
  const turnId = input?.turnId === undefined ? undefined : String(input.turnId).trim()
  const observedAt = input?.observedAt === undefined
    ? undefined
    : optionalCount(input.observedAt, 'Token usage anchor.observedAt')
  const step = input?.step === undefined ? undefined : optionalCount(input.step, 'Token usage anchor.step')
  return Object.freeze({
    version: 1,
    ...(provider ? { provider } : {}),
    model: surface.model,
    surfaceHash: surface.surfaceHash,
    staticHash: surface.staticHash,
    inputTokens: usage.inputTokens,
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    heuristicInputTokens: meter.heuristicInputTokens,
    ...(observedAt === undefined ? {} : { observedAt }),
    ...(turnId ? { turnId } : {}),
    ...(step === undefined ? {} : { step }),
  })
}
