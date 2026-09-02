// @ts-check
import { canonicalHash } from './canonicalHash.mjs'
import { generationIdempotencyKey } from './generation/generationIdempotency.mjs'
import { planBotanicGeneration } from './botanicAgentPlanner.mjs'
import { chatWithBotanicAgent } from './botanicAgentChat.mjs'
import { resolveBotanicAgentTurn } from './agent/turn/botanicAgentTurn.mjs'
import { bindAgentModelContextOptions } from './agentModelContextBinding.mjs'
import { pinnedBotanicAgentProjectSkills } from './botanicAgentTools.mjs'

const COMPATIBILITY_OPERATIONS = new Set(['plan', 'chat', 'intent'])

function plannerSkillInput(skill) {
  return {
    id: skill.id,
    name: skill.name,
    instructions: skill.instructions,
    status: skill.status,
    ...(Number.isInteger(skill.version) ? { version: skill.version } : {}),
    ...(typeof skill.contentHash === 'string' ? { contentHash: skill.contentHash } : {}),
    ...(Array.isArray(skill.capabilities) ? { capabilities: skill.capabilities } : {}),
  }
}

function runtimeInput(request, options) {
  const source = request?.runtimeOperation ? request.input : request
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw Object.assign(new TypeError('Agent Runtime 请求快照无效。'), {
      code: 'AGENT_RUNTIME_REQUEST_INVALID',
      statusCode: 409,
    })
  }
  // Skill Loader V2（H5）：pin 必须发生在 plannerSkillInput 裁剪之前——完整 Store 对象
  // 才带 versions 历史;冻结 binding 与当前版本漂移时从历史读取,缺失/hash 不一致
  // fail closed(AGENT_SKILL_SNAPSHOT_MISMATCH),不得用当前 catalog 静默替换。
  const pinned = pinnedBotanicAgentProjectSkills(source.skillCatalogSnapshot, options?.projectSkills ?? [])
  const projectSkills = pinned.map(plannerSkillInput)
  return {
    ...structuredClone(source),
    ...(projectSkills.length ? { projectSkills } : {}),
  }
}

/**
 * 旧 plan/chat/intent HTTP 形状只保留为 Adapter；执行身份、租约、Checkpoint、取消与
 * 恢复全部进入同一个 Turn Runtime。请求快照显式记录 operation，Worker 才能在原
 * HTTP 连接消失后选择同一个解析器，而不是把 Planner Turn 错当成普通对话 Turn。
 */
export function createAgentCompatibilityRuntimeRequest(operation, input) {
  if (!COMPATIBILITY_OPERATIONS.has(operation)) {
    throw new TypeError(`不支持的 Agent Runtime operation：${String(operation)}`)
  }
  return {
    runtimeOperation: operation,
    input: structuredClone(input),
  }
}

/**
 * 客户端必须显式提供提交键；operation 进入命名空间，避免调用方误把相同 key
 * 用在 plan/chat 时绑定到同一 Turn。没有稳定 key 就不能安全重试 Provider 调用。
 */
export function agentCompatibilityIdempotencyKey(operation, _input, provided, _fallbackKey) {
  const explicit = generationIdempotencyKey(provided)
  if (!COMPATIBILITY_OPERATIONS.has(operation)) {
    throw new TypeError(`不支持的 Agent Runtime operation：${String(operation)}`)
  }
  if (explicit) return `agent-${operation}-${canonicalHash(explicit)}`
  throw Object.assign(new Error('Agent 请求缺少稳定提交标识。'), {
    code: 'INVALID_IDEMPOTENCY_KEY',
    statusCode: 400,
  })
}

/**
 * 所有 Runtime 请求的单一解析 seam。主 Turn 没有 runtimeOperation；兼容 Adapter 则
 * 只改变输入/输出形状。reasoning 始终提升到顶层，让 Turn Runtime 的持久化过滤器
 * 能统一剥离，避免藏在 response/plan 内写入数据库。
 */
export async function resolveBotanicAgentRuntimeRequest(request, runtimeConfig, options = {}) {
  const operation = request?.runtimeOperation
  const input = runtimeInput(request, options)
  const runtimeOptions = bindAgentModelContextOptions(input, runtimeConfig, options)
  if (!operation) return resolveBotanicAgentTurn(input, runtimeConfig, runtimeOptions)

  if (operation === 'plan') {
    const result = await planBotanicGeneration(input, runtimeConfig, runtimeOptions)
    const { reasoning, ...safe } = result ?? {}
    return result?.kind === 'clarification'
      ? {
          kind: 'clarification',
          runtimeOperation: 'plan',
          clarification: result.clarification,
          ...(reasoning?.length ? { reasoning } : {}),
        }
      : {
          kind: 'plan',
          runtimeOperation: 'plan',
          plan: safe,
          ...(reasoning?.length ? { reasoning } : {}),
        }
  }

  if (operation === 'chat') {
    const result = await chatWithBotanicAgent(input, runtimeConfig, runtimeOptions)
    const { reasoning, ...response } = result ?? {}
    return {
      kind: 'chat',
      runtimeOperation: 'chat',
      response,
      ...(reasoning?.length ? { reasoning } : {}),
    }
  }

  if (operation === 'intent') return resolveBotanicAgentTurn(input, runtimeConfig, runtimeOptions)

  throw Object.assign(new TypeError('Agent Runtime operation 无效。'), {
    code: 'AGENT_RUNTIME_OPERATION_INVALID',
    statusCode: 409,
  })
}

/** 把 Runtime 的统一结果还原为兼容 HTTP 形状；不复制任何执行逻辑。 */
export function agentCompatibilityResult(operation, result) {
  if (operation === 'plan') {
    if (result?.kind === 'clarification' && result?.runtimeOperation === 'plan') {
      return { clarification: result.clarification, ...(result.reasoning?.length ? { reasoning: result.reasoning } : {}) }
    }
    if (result?.kind === 'plan' && result?.runtimeOperation === 'plan') {
      return { plan: result.plan, ...(result.reasoning?.length ? { reasoning: result.reasoning } : {}) }
    }
  }
  if (operation === 'chat' && result?.kind === 'chat' && result?.runtimeOperation === 'chat') {
    return {
      response: {
        ...result.response,
        ...(result.reasoning?.length ? { reasoning: result.reasoning } : {}),
      },
    }
  }
  if (operation === 'intent' && result && typeof result === 'object') return { turn: result }
  throw Object.assign(new Error('Agent Runtime 已结束，但兼容结果不可用。'), {
    code: 'AGENT_RUNTIME_RESULT_MISSING',
    statusCode: 502,
  })
}
