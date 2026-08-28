// @ts-check
import { canonicalHash } from './canonicalHash.mjs'
import { SUBAGENT_ROLES } from './agentSubtask.mjs'
import { agentSubagentIdForIdempotency } from './agentSubagentPersistence.mjs'
import { agentSubagentCapabilityHash } from './agentSubagentTools.mjs'

const START_KEYS = new Set(['userId', 'projectId', 'rootTurnId', 'idempotencyKey', 'content', 'role', 'requestId'])
const FOLLOWUP_KEYS = new Set(['userId', 'subagentId', 'sourceTurnId', 'idempotencyKey', 'content', 'requestId'])

export const AGENT_SUBAGENT_INSTRUCTIONS_VERSION = 'botanic-subagent-v2'
export const AGENT_SUBAGENT_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  required: ['summary'],
  properties: {
    summary: { type: 'string', maxLength: 600 },
    findings: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 240 } },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    uncertainties: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 240 } },
  },
})

const TOOL_PRIORITY = Object.freeze([
  'canvas_read',
  'artifact_search',
  'agent_run_read',
  'generation_job_read',
  'review_read',
  'workflow_run_read',
  'delivery_read',
  'web_search',
  'web_fetch',
])

export class AgentSubagentServiceError extends Error {
  constructor(code, message, statusCode = 422) {
    super(message)
    this.name = 'AgentSubagentServiceError'
    this.code = code
    this.statusCode = statusCode
  }
}

function fail(code, message, statusCode = 422) {
  throw new AgentSubagentServiceError(code, message, statusCode)
}

function text(value, name, maximum = 160) {
  if (typeof value !== 'string' || !value.trim()) fail('AGENT_SUBAGENT_FIELD_INVALID', `${name}不能为空。`)
  const clean = value.trim()
  if (clean.length > maximum) fail('AGENT_SUBAGENT_FIELD_INVALID', `${name}过长。`)
  return clean
}

function strictInput(input, allowed, name) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('AGENT_SUBAGENT_REQUEST_INVALID', `${name}格式无效。`, 400)
  }
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      const authority = /prompt|instruction|capabilit|tool|model|schema|budget/iu.test(key)
      fail(
        authority ? 'AGENT_SUBAGENT_AUTHORITY_FORBIDDEN' : 'AGENT_SUBAGENT_REQUEST_INVALID',
        authority ? '客户端不能提交 Subagent 系统指令、模型或能力定义。' : `${name}包含未声明字段：${key}。`,
        authority ? 403 : 400,
      )
    }
  }
  return input
}

function turnIdempotencyKey(kind, input) {
  return `agent-subagent-turn-${canonicalHash({ kind, ...input })}`
}

/**
 * @param {{
 *   productStore?: any,
 *   config?: any,
 *   createRegistry?: (input: { userId: string, projectId: string }) => Promise<{ registry: any }>,
 *   dispatchActivation?: (input: { subagentId: string, activationId: string }) => Promise<any>,
 *   cancellation?: { request: (input: any) => Promise<any>, converge?: (descriptor: any) => Promise<any> },
 * }} [input]
 */
export function createAgentSubagentService({
  productStore,
  config,
  createRegistry,
  dispatchActivation,
  cancellation,
} = {}) {
  if (typeof productStore?.enqueueAgentSubagentActivation !== 'function'
    || typeof productStore?.readAgentSubagent !== 'function'
    || typeof productStore?.listAgentSubagentActivations !== 'function') {
    throw new TypeError('Subagent Service 缺少 ProductStore 契约。')
  }
  if (typeof createRegistry !== 'function') throw new TypeError('Subagent Service 缺少 Registry 工厂。')
  if (typeof dispatchActivation !== 'function') throw new TypeError('Subagent Service 缺少 dispatch seam。')
  const registryFactory = createRegistry
  const dispatch = dispatchActivation

  function ensureConfigured() {
    const model = typeof config?.agentSubagentModel === 'string' ? config.agentSubagentModel.trim() : ''
    if (!model || !config?.flockApiKey) {
      fail('AGENT_SUBAGENT_NOT_CONFIGURED', 'Subagent 模型服务尚未配置。', 503)
    }
    return model
  }

  async function handoff(outcome) {
    const activation = outcome?.activation?.activation ?? outcome?.activation
    if (!activation?.id || !['queued', 'running'].includes(activation.status)) return false
    if (outcome?.subagent?.status !== 'active') return false
    await dispatch({ subagentId: outcome.subagent.id, activationId: activation.id })
    return true
  }

  async function sourceTurn(userId, projectId, turnId, { root = false } = {}) {
    const turn = await productStore.readAgentTurn(userId, turnId)
    if (!turn || turn.projectId !== projectId) {
      fail('AGENT_SUBAGENT_SOURCE_TURN_NOT_FOUND', 'Subagent 来源 Turn 不存在。', 404)
    }
    if (root && turn.request?.runtimeOperation === 'subagent') {
      fail('AGENT_SUBAGENT_RECURSION_FORBIDDEN', 'Subagent 不能再创建下级 Subagent。', 409)
    }
    return turn
  }

  async function enqueueActivation(userId, command) {
    try {
      return await productStore.enqueueAgentSubagentActivation(userId, command)
    } catch (caught) {
      const storeError = /** @type {{ code?: unknown }} */ (caught)
      if (storeError?.code === 'AGENT_SUBAGENT_ROOT_TURN_NOT_FOUND') {
        fail(storeError.code, 'Subagent 根 Turn 不存在。', 404)
      }
      if (storeError?.code === 'AGENT_TURN_DELEGATION_CANCELLED') {
        fail(storeError.code, 'Agent Turn 已进入取消或失败状态，不能再派发 Subagent。', 409)
      }
      if (storeError?.code === 'AGENT_SUBAGENT_ROOT_EXECUTION_STALE') {
        fail(storeError.code, '根 Turn 执行权已变化，旧执行者不能派发 Subagent。', 409)
      }
      if (storeError?.code === 'AGENT_SUBAGENT_ROOT_TURN_NOT_READY') {
        fail(storeError.code, '根 Turn 当前状态不能派发 Subagent。', 409)
      }
      throw caught
    }
  }

  async function startWithAuthority(rawInput, authority, rootExecution) {
    const input = strictInput(rawInput, START_KEYS, 'Subagent start 请求')
    const userId = text(input.userId, '用户')
    const projectId = text(input.projectId, '项目')
    const rootTurnId = text(input.rootTurnId, '根 Turn')
    const idempotencyKey = text(input.idempotencyKey, '提交标识', 240)
    const content = text(input.content, 'Subagent 输入', 64_000)
    const role = text(input.role, 'Subagent 角色', 80)
    if (!SUBAGENT_ROLES.includes(role)) fail('AGENT_SUBAGENT_ROLE_INVALID', 'Subagent 角色不受支持。')
    const model = ensureConfigured()
    const rootTurn = await sourceTurn(userId, projectId, rootTurnId, { root: true })
    if (authority === 'runtime') {
      if (rootTurn.status !== 'running') {
        fail('AGENT_SUBAGENT_ROOT_TURN_NOT_RUNNING', '只有正在执行的根 Turn 才能内部派发 Subagent。', 409)
      }
      if (!Number.isInteger(rootExecution?.executionGeneration)
        || rootExecution.executionGeneration < 1
        || typeof rootExecution?.leaseToken !== 'string'
        || !rootExecution.leaseToken.trim()
        || Number(rootTurn.execution?.generation) !== rootExecution.executionGeneration
        || rootTurn.execution?.leaseToken !== rootExecution.leaseToken) {
        fail('AGENT_SUBAGENT_ROOT_EXECUTION_STALE', '根 Turn 执行权已变化，旧执行者不能派发 Subagent。', 409)
      }
    } else if (!['completed', 'waiting_user'].includes(rootTurn.status)) {
      fail('AGENT_SUBAGENT_ROOT_TURN_ACTIVE', '根 Turn 尚未结束，不能从外部追加 Subagent。', 409)
    }
    const { registry } = await registryFactory({ userId, projectId })
    const registryNames = new Set(registry?.names?.() ?? [])
    const allowedTools = TOOL_PRIORITY.filter((name) => registryNames.has(name)).sort()
    if (!allowedTools.length) fail('AGENT_SUBAGENT_TOOLS_UNAVAILABLE', 'Subagent 没有可用的只读工具。', 503)
    const descriptor = {
      role,
      model,
      instructionsVersion: AGENT_SUBAGENT_INSTRUCTIONS_VERSION,
      outputKind: 'proposal',
      outputSchema: structuredClone(AGENT_SUBAGENT_OUTPUT_SCHEMA),
      allowedTools,
      budget: { maxSteps: 4, maxToolCalls: 12, timeoutMs: 90_000, maxActivations: 8 },
    }
    descriptor.capabilityHash = agentSubagentCapabilityHash({ descriptor, registry })
    const subagentId = agentSubagentIdForIdempotency(userId, projectId, idempotencyKey)
    const outcome = await enqueueActivation(userId, {
      kind: 'start',
      projectId,
      subagentId,
      rootTurnId,
      sourceTurnId: rootTurnId,
      ...(authority === 'runtime' ? {
        rootExecution: {
          generation: rootExecution.executionGeneration,
          leaseToken: rootExecution.leaseToken,
        },
      } : {}),
      ...(rootTurn.sessionId ? { parentSessionId: rootTurn.sessionId } : {}),
      idempotencyKey,
      input: { content },
      descriptor,
      turn: {
        idempotencyKey: turnIdempotencyKey('start', { userId, projectId, subagentId, idempotencyKey }),
        ...(typeof input.requestId === 'string' && input.requestId.trim() ? { requestId: input.requestId.trim() } : {}),
        request: { runtimeOperation: 'subagent', input: {} },
      },
    })
    if (['enqueued', 'replay'].includes(outcome?.kind)) await handoff(outcome)
    return outcome
  }

  async function start(rawInput) {
    return startWithAuthority(rawInput, 'external')
  }

  // 只暴露给 Root Turn Resolver 组合根。HTTP 路由仅调用 start，因此客户端无法把
  // 任意 running Turn 当作自己的派发宿主；真正落库前 Store 仍会原子检查取消 fence。
  async function startFromRuntime(rawInput, rootExecution) {
    return startWithAuthority(rawInput, 'runtime', rootExecution)
  }

  async function followup(rawInput) {
    const input = strictInput(rawInput, FOLLOWUP_KEYS, 'Subagent followup 请求')
    ensureConfigured()
    const userId = text(input.userId, '用户')
    const subagentId = text(input.subagentId, 'Subagent')
    const sourceTurnId = text(input.sourceTurnId, '来源 Turn')
    const idempotencyKey = text(input.idempotencyKey, '提交标识', 240)
    const content = text(input.content, 'Subagent 输入', 64_000)
    const descriptor = await productStore.readAgentSubagent(userId, subagentId)
    if (!descriptor) fail('AGENT_SUBAGENT_NOT_FOUND', 'Subagent 不存在。', 404)
    if (descriptor.status !== 'active') fail('AGENT_SUBAGENT_INACTIVE', 'Subagent 已停止，不能继续追加消息。', 409)
    await sourceTurn(userId, descriptor.projectId, sourceTurnId)
    const outcome = await enqueueActivation(userId, {
      kind: 'followup',
      projectId: descriptor.projectId,
      subagentId,
      sourceTurnId,
      idempotencyKey,
      input: { content },
      turn: {
        idempotencyKey: turnIdempotencyKey('followup', { userId, subagentId, idempotencyKey }),
        ...(typeof input.requestId === 'string' && input.requestId.trim() ? { requestId: input.requestId.trim() } : {}),
        request: { runtimeOperation: 'subagent', input: {} },
      },
    })
    if (['enqueued', 'replay'].includes(outcome?.kind)) await handoff(outcome)
    return outcome
  }

  async function read(userIdValue, subagentIdValue, options = {}) {
    const userId = text(userIdValue, '用户')
    const subagentId = text(subagentIdValue, 'Subagent')
    let subagent = await productStore.readAgentSubagent(userId, subagentId)
    if (!subagent) return undefined
    if (subagent.status === 'cancelling' && typeof cancellation?.converge === 'function') {
      await cancellation.converge(await productStore.readAgentSubagentForWorker?.(subagentId) ?? subagent)
      subagent = await productStore.readAgentSubagent(userId, subagentId) ?? subagent
    }
    const activations = await productStore.listAgentSubagentActivations(userId, subagentId, options) ?? []
    // Subagent Session 默认从普通会话列表隐藏；专用资源必须显式读取它，调用方才能
    // 看到真实提案，而不是只拿到 resultMessageId 这个无法解引用的指针。
    const messagePage = typeof productStore.listAgentSessionMessages === 'function'
      ? await productStore.listAgentSessionMessages(userId, subagent.projectId, subagent.sessionId, {
          includeSubagents: true,
          limit: 32,
        })
      : undefined
    return { subagent, activations, messages: messagePage?.messages ?? [] }
  }

  async function cancel(input) {
    if (typeof cancellation?.request !== 'function') throw new TypeError('Subagent Service 缺少取消编排。')
    return cancellation.request(input)
  }

  return { start, startFromRuntime, followup, read, cancel }
}
