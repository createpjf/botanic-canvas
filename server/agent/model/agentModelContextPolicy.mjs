// @ts-check

import { canonicalHash } from '../../canonicalHash.mjs'

const POLICY_KEYS = new Set([
  'id',
  'contextWindowTokens',
  'outputReserveTokens',
  'safetyMarginTokens',
  'autoCompactRatio',
  'retainRecentRatio',
  'mediaTokensPerItem',
  'toolResultPrune',
])
const PRUNE_KEYS = new Set(['thresholdCodePoints', 'headCodePoints', 'tailCodePoints'])
const CONFIG_KEYS = new Set(['default', 'models'])
const POLICY_SNAPSHOT_KEYS = new Set([
  'version',
  'id',
  'source',
  'model',
  'contextWindowTokens',
  'outputReserveTokens',
  'safetyMarginTokens',
  'maxInputTokens',
  'autoCompactRatio',
  'autoCompactAtTokens',
  'retainRecentRatio',
  'retainRecentTokens',
  'mediaTokensPerItem',
  'toolResultPrune',
  'hash',
])

const LEGACY_POLICY = Object.freeze({
  id: 'legacy-v1',
  contextWindowTokens: 12_000,
  outputReserveTokens: 3_000,
  safetyMarginTokens: 1_000,
  autoCompactRatio: 0.8,
  retainRecentRatio: 0.16,
  mediaTokensPerItem: 2_048,
  toolResultPrune: Object.freeze({
    thresholdCodePoints: 8_192,
    headCodePoints: 4_096,
    tailCodePoints: 1_024,
  }),
})

export class AgentModelContextPolicyError extends TypeError {
  constructor(message) {
    super(message)
    this.name = 'AgentModelContextPolicyError'
    this.code = 'AGENT_MODEL_CONTEXT_POLICY_INVALID'
  }
}

/** @returns {never} */
function invalid(message) {
  throw new AgentModelContextPolicyError(message)
}

function plainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${name}无效。`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid(`${name}必须是普通对象。`)
  return value
}

function exactKeys(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${name}包含不支持的字段：${key}。`)
  }
}

function optionalInteger(value, name, minimum, maximum) {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    invalid(`${name}必须是 ${minimum} 到 ${maximum} 之间的整数。`)
  }
  return parsed
}

function optionalRatio(value, name, minimum, maximum) {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    invalid(`${name}必须是 ${minimum} 到 ${maximum} 之间的数值。`)
  }
  return parsed
}

function optionalText(value, name, maximumLength) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximumLength) {
    invalid(`${name}无效。`)
  }
  return value.trim()
}

function normalizePruneInput(value, name) {
  if (value === undefined) return undefined
  const input = plainObject(value, name)
  exactKeys(input, PRUNE_KEYS, name)
  return {
    ...(input.thresholdCodePoints === undefined ? {} : {
      thresholdCodePoints: optionalInteger(input.thresholdCodePoints, `${name}.thresholdCodePoints`, 256, 1_000_000),
    }),
    ...(input.headCodePoints === undefined ? {} : {
      headCodePoints: optionalInteger(input.headCodePoints, `${name}.headCodePoints`, 0, 1_000_000),
    }),
    ...(input.tailCodePoints === undefined ? {} : {
      tailCodePoints: optionalInteger(input.tailCodePoints, `${name}.tailCodePoints`, 0, 1_000_000),
    }),
  }
}

function normalizePolicyInput(value, name) {
  const input = plainObject(value, name)
  exactKeys(input, POLICY_KEYS, name)
  return {
    ...(input.id === undefined ? {} : { id: optionalText(input.id, `${name}.id`, 120) }),
    ...(input.contextWindowTokens === undefined ? {} : {
      contextWindowTokens: optionalInteger(input.contextWindowTokens, `${name}.contextWindowTokens`, 2_048, 4_000_000),
    }),
    ...(input.outputReserveTokens === undefined ? {} : {
      outputReserveTokens: optionalInteger(input.outputReserveTokens, `${name}.outputReserveTokens`, 64, 1_000_000),
    }),
    ...(input.safetyMarginTokens === undefined ? {} : {
      safetyMarginTokens: optionalInteger(input.safetyMarginTokens, `${name}.safetyMarginTokens`, 0, 1_000_000),
    }),
    ...(input.autoCompactRatio === undefined ? {} : {
      autoCompactRatio: optionalRatio(input.autoCompactRatio, `${name}.autoCompactRatio`, 0.5, 0.95),
    }),
    ...(input.retainRecentRatio === undefined ? {} : {
      retainRecentRatio: optionalRatio(input.retainRecentRatio, `${name}.retainRecentRatio`, 0.05, 0.5),
    }),
    ...(input.mediaTokensPerItem === undefined ? {} : {
      mediaTokensPerItem: optionalInteger(input.mediaTokensPerItem, `${name}.mediaTokensPerItem`, 0, 65_536),
    }),
    ...(input.toolResultPrune === undefined ? {} : {
      toolResultPrune: normalizePruneInput(input.toolResultPrune, `${name}.toolResultPrune`),
    }),
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const entry of Object.values(value)) deepFreeze(entry)
  return Object.freeze(value)
}

/**
 * 解析运维提供的模型上下文策略。仅支持精确模型名，不接受模糊匹配：
 * 策略是恢复契约的一部分，一个过宽的通配符会让新模型在无人审核时继承错误窗口。
 *
 * @param {string | Record<string, any> | undefined | null} value
 */
export function parseAgentModelContextPolicies(value) {
  if (value === undefined || value === null || value === '') {
    return deepFreeze({ version: 1, models: {} })
  }
  let parsed = value
  if (typeof value === 'string') {
    if (value.length > 64 * 1024) invalid('Agent 模型上下文策略配置过大。')
    try { parsed = JSON.parse(value) } catch { invalid('Agent 模型上下文策略不是有效 JSON。') }
  }
  const input = plainObject(parsed, 'Agent 模型上下文策略')
  exactKeys(input, CONFIG_KEYS, 'Agent 模型上下文策略')
  const result = { version: 1, models: {} }
  if (input.default !== undefined) result.default = normalizePolicyInput(input.default, 'Agent 默认上下文策略')
  if (input.models !== undefined) {
    const models = plainObject(input.models, 'Agent 模型上下文策略目录')
    const entries = Object.entries(models)
    if (entries.length > 100) invalid('Agent 模型上下文策略数量过多。')
    for (const [rawModel, policy] of entries) {
      const model = optionalText(rawModel, 'Agent 模型名称', 160)
      result.models[model] = normalizePolicyInput(policy, `Agent 模型 ${model} 上下文策略`)
    }
  }
  return deepFreeze(result)
}

/**
 * 把经过审核的策略冻结成一次执行快照。
 * 未配置模型不猜测官方规格，而是回到与现有 8k input 行为对齐的 legacy 安全值。
 *
 * @param {string} model
 * @param {string | Record<string, any> | undefined | null} [policies]
 */
export function resolveAgentModelContextPolicy(model, policies) {
  const normalizedModel = optionalText(model, 'Agent 模型', 160)
  if (!normalizedModel) invalid('Agent 模型无效。')
  const catalog = policies && typeof policies === 'object' && policies.version === 1 && policies.models
    ? policies
    : parseAgentModelContextPolicies(policies)
  const configuredDefault = catalog.default ?? {}
  const configuredModel = catalog.models?.[normalizedModel] ?? {}
  const source = catalog.models?.[normalizedModel]
    ? 'model'
    : catalog.default ? 'default' : 'legacy'
  const merged = {
    ...LEGACY_POLICY,
    ...configuredDefault,
    ...configuredModel,
    toolResultPrune: {
      ...LEGACY_POLICY.toolResultPrune,
      ...(configuredDefault.toolResultPrune ?? {}),
      ...(configuredModel.toolResultPrune ?? {}),
    },
  }
  if (merged.outputReserveTokens + merged.safetyMarginTokens > merged.contextWindowTokens - 512) {
    invalid('Agent 模型上下文策未给输入保留至少 512 token。')
  }
  if (merged.retainRecentRatio >= merged.autoCompactRatio) {
    invalid('Agent 近期原文保留比例必须小于自动压缩阈值。')
  }
  const prune = merged.toolResultPrune
  if (prune.headCodePoints + prune.tailCodePoints >= prune.thresholdCodePoints) {
    invalid('Agent 工具结果头尾保留量必须小于裁剪阈值。')
  }
  const policyWithoutHash = {
    version: 1,
    id: merged.id ?? (source === 'model' ? `model:${normalizedModel}` : source),
    source,
    model: normalizedModel,
    contextWindowTokens: merged.contextWindowTokens,
    outputReserveTokens: merged.outputReserveTokens,
    safetyMarginTokens: merged.safetyMarginTokens,
    maxInputTokens: merged.contextWindowTokens - merged.outputReserveTokens - merged.safetyMarginTokens,
    autoCompactRatio: merged.autoCompactRatio,
    autoCompactAtTokens: Math.floor(merged.contextWindowTokens * merged.autoCompactRatio),
    retainRecentRatio: merged.retainRecentRatio,
    retainRecentTokens: Math.min(
      merged.contextWindowTokens - merged.outputReserveTokens - merged.safetyMarginTokens,
      Math.floor(merged.contextWindowTokens * merged.retainRecentRatio),
    ),
    mediaTokensPerItem: merged.mediaTokensPerItem,
    toolResultPrune: { ...prune },
  }
  return deepFreeze({ ...policyWithoutHash, hash: canonicalHash(policyWithoutHash) })
}

/**
 * 校验 durable request 中冻结的完整策略。恢复不能拿当前环境重新解释主模型窗口；
 * 所有派生预算与 hash 都必须仍能由快照本身证明。
 *
 * @param {unknown} value
 * @param {{ model?: string }} [expected]
 */
export function validateAgentModelContextPolicySnapshot(value, expected = {}) {
  const input = plainObject(value, 'Agent 模型上下文策略快照')
  exactKeys(input, POLICY_SNAPSHOT_KEYS, 'Agent 模型上下文策略快照')
  if (input.version !== 1) invalid('Agent 模型上下文策略快照版本无效。')
  const source = optionalText(input.source, 'Agent 模型上下文策略快照.source', 32)
  if (!source || !['legacy', 'default', 'model'].includes(source)) {
    invalid('Agent 模型上下文策略快照来源无效。')
  }
  const model = optionalText(input.model, 'Agent 模型上下文策略快照.model', 160)
  if (expected.model !== undefined && model !== expected.model) {
    invalid('Agent 模型上下文策略快照与冻结模型不匹配。')
  }
  const id = optionalText(input.id, 'Agent 模型上下文策略快照.id', 120)
  const contextWindowTokens = optionalInteger(
    input.contextWindowTokens,
    'Agent 模型上下文策略快照.contextWindowTokens',
    2_048,
    4_000_000,
  )
  const outputReserveTokens = optionalInteger(
    input.outputReserveTokens,
    'Agent 模型上下文策略快照.outputReserveTokens',
    64,
    1_000_000,
  )
  const safetyMarginTokens = optionalInteger(
    input.safetyMarginTokens,
    'Agent 模型上下文策略快照.safetyMarginTokens',
    0,
    1_000_000,
  )
  const autoCompactRatio = optionalRatio(
    input.autoCompactRatio,
    'Agent 模型上下文策略快照.autoCompactRatio',
    0.5,
    0.95,
  )
  const retainRecentRatio = optionalRatio(
    input.retainRecentRatio,
    'Agent 模型上下文策略快照.retainRecentRatio',
    0.05,
    0.5,
  )
  const mediaTokensPerItem = optionalInteger(
    input.mediaTokensPerItem,
    'Agent 模型上下文策略快照.mediaTokensPerItem',
    0,
    65_536,
  )
  const toolResultPrune = normalizePruneInput(
    input.toolResultPrune,
    'Agent 模型上下文策略快照.toolResultPrune',
  )
  if (
    id === undefined
    || model === undefined
    || contextWindowTokens === undefined
    || outputReserveTokens === undefined
    || safetyMarginTokens === undefined
    || autoCompactRatio === undefined
    || retainRecentRatio === undefined
    || mediaTokensPerItem === undefined
    || toolResultPrune?.thresholdCodePoints === undefined
    || toolResultPrune.headCodePoints === undefined
    || toolResultPrune.tailCodePoints === undefined
  ) invalid('Agent 模型上下文策略快照缺少必填字段。')
  const maxInputTokens = contextWindowTokens - outputReserveTokens - safetyMarginTokens
  const autoCompactAtTokens = Math.floor(contextWindowTokens * autoCompactRatio)
  const retainRecentTokens = Math.min(
    maxInputTokens,
    Math.floor(contextWindowTokens * retainRecentRatio),
  )
  if (
    input.maxInputTokens !== maxInputTokens
    || input.autoCompactAtTokens !== autoCompactAtTokens
    || input.retainRecentTokens !== retainRecentTokens
    || maxInputTokens < 512
    || retainRecentRatio >= autoCompactRatio
    || toolResultPrune.headCodePoints + toolResultPrune.tailCodePoints >= toolResultPrune.thresholdCodePoints
  ) invalid('Agent 模型上下文策略快照派生预算不一致。')
  const policyWithoutHash = {
    version: 1,
    id,
    source,
    model,
    contextWindowTokens,
    outputReserveTokens,
    safetyMarginTokens,
    maxInputTokens,
    autoCompactRatio,
    autoCompactAtTokens,
    retainRecentRatio,
    retainRecentTokens,
    mediaTokensPerItem,
    toolResultPrune,
  }
  const hash = optionalText(input.hash, 'Agent 模型上下文策略快照.hash', 200)
  if (hash !== canonicalHash(policyWithoutHash)) {
    invalid('Agent 模型上下文策略快照哈希不匹配。')
  }
  return deepFreeze({ ...policyWithoutHash, hash })
}
