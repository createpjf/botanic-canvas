// @ts-check
import { canonicalHash } from './canonicalHash.mjs'
import { createAgentTurnRecord, agentTurnIdForIdempotency } from './agent/turn/botanicAgentTurnRuntime.mjs'
import { validateAgentMessageEntity, validateAgentSessionEntity } from './botanicAgentPersistence.mjs'
import { SUBAGENT_LIMITS, SUBAGENT_OUTPUT_KINDS, SUBAGENT_ROLES } from './agentSubtask.mjs'

const terminalTurnStatuses = new Set(['completed', 'failed', 'cancelled'])
const terminalActivationStatuses = new Set(['completed', 'failed', 'cancelled'])
const descriptorStatuses = new Set(['active', 'cancelling', 'cancelled'])
const enqueueKinds = new Set(['start', 'followup'])
const descriptorKeys = new Set([
  'role',
  'model',
  'instructionsVersion',
  'outputKind',
  'outputSchema',
  'allowedTools',
  'budget',
  'capabilityHash',
])
const forbiddenClientKeys = new Set([
  'systemPrompt',
  'system_prompt',
  'instructions',
  'capabilities',
  'customCapabilities',
  'custom_capabilities',
  'tools',
])

export class AgentSubagentPersistenceError extends Error {
  /** @param {string} code @param {string} message @param {number} [statusCode] */
  constructor(code, message, statusCode = 422) {
    super(message)
    this.name = 'AgentSubagentPersistenceError'
    this.code = code
    this.statusCode = statusCode
  }
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function invalid(code, message, statusCode = 422) {
  throw new AgentSubagentPersistenceError(code, message, statusCode)
}

function text(value, name, maximum = 160) {
  if (typeof value !== 'string' || !value.trim()) invalid('AGENT_SUBAGENT_FIELD_INVALID', `${name}不能为空。`)
  const result = value.trim()
  if (result.length > maximum) invalid('AGENT_SUBAGENT_FIELD_INVALID', `${name}过长。`)
  return result
}

function integer(value, name, minimum, maximum) {
  const result = Number(value)
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    invalid('AGENT_SUBAGENT_LIMIT_INVALID', `${name}必须是 ${minimum} 到 ${maximum} 之间的整数。`)
  }
  return result
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid('AGENT_SUBAGENT_FIELD_INVALID', `${name}格式无效。`)
  }
  return value
}

function strictKeys(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (forbiddenClientKeys.has(key)) {
      invalid('AGENT_SUBAGENT_AUTHORITY_FORBIDDEN', `${name}不能提交系统提示词或自定义能力。`, 403)
    }
    if (!allowed.has(key)) invalid('AGENT_SUBAGENT_FIELD_INVALID', `${name}包含未声明字段：${key}。`)
  }
}

function normalizedBudget(value) {
  const budget = object(value, 'Subagent 预算')
  strictKeys(budget, new Set(['maxSteps', 'maxToolCalls', 'timeoutMs', 'maxActivations']), 'Subagent 预算')
  return {
    maxSteps: integer(budget.maxSteps, 'Subagent 步数预算', 2, SUBAGENT_LIMITS.maxSteps),
    maxToolCalls: integer(budget.maxToolCalls, 'Subagent 工具预算', 1, 24),
    timeoutMs: integer(
      budget.timeoutMs,
      'Subagent 超时预算',
      SUBAGENT_LIMITS.minTimeoutMs,
      SUBAGENT_LIMITS.maxTimeoutMs,
    ),
    maxActivations: integer(budget.maxActivations, 'Subagent Activation 预算', 1, 8),
  }
}

function normalizedDescriptor(value) {
  const descriptor = object(value, 'Subagent 描述')
  strictKeys(descriptor, descriptorKeys, 'Subagent 描述')
  const role = text(descriptor.role, 'Subagent 角色', 80)
  if (!SUBAGENT_ROLES.includes(role)) invalid('AGENT_SUBAGENT_ROLE_INVALID', `Subagent 角色「${role}」不受支持。`)
  const outputKind = text(descriptor.outputKind, 'Subagent 产出类型', 80)
  if (!SUBAGENT_OUTPUT_KINDS.includes(outputKind)) {
    invalid('AGENT_SUBAGENT_OUTPUT_KIND_INVALID', `Subagent 产出类型「${outputKind}」不受支持。`)
  }
  const outputSchema = object(descriptor.outputSchema, 'Subagent 输出 Schema')
  if (outputSchema.type !== 'object') invalid('AGENT_SUBAGENT_SCHEMA_INVALID', 'Subagent 输出 Schema 必须描述对象。')
  const rawTools = descriptor.allowedTools
  if (!Array.isArray(rawTools) || !rawTools.length || rawTools.length > 12) {
    invalid('AGENT_SUBAGENT_ALLOWLIST_INVALID', 'Subagent 工具白名单必须包含 1 到 12 个工具。')
  }
  const allowedTools = [...new Set(rawTools.map((name) => text(name, 'Subagent 工具', 120)))].sort()
  if (allowedTools.length !== rawTools.length) {
    invalid('AGENT_SUBAGENT_ALLOWLIST_INVALID', 'Subagent 工具白名单不能重复。')
  }
  const normalized = {
    role,
    model: text(descriptor.model, 'Subagent 模型', 160),
    instructionsVersion: text(descriptor.instructionsVersion, 'Subagent 指令版本', 160),
    outputKind,
    outputSchema: clone(outputSchema),
    allowedTools,
    budget: normalizedBudget(descriptor.budget),
  }
  const capabilityHash = text(descriptor.capabilityHash, 'Subagent 能力摘要', 200)
  if (!/^[A-Za-z0-9_-]{43}$/u.test(capabilityHash)) {
    invalid('AGENT_SUBAGENT_CAPABILITY_HASH_INVALID', 'Subagent 能力摘要格式无效。', 409)
  }
  // capabilityHash 由服务端 Registry 的真实 schema/governance 计算；Persistence 只绑定，
  // 不能拿 descriptor 自行重算，否则「落库能过、Runner 必拒绝」会成为永久漂移。
  return { ...normalized, capabilityHash }
}

function normalizedInput(value) {
  const input = object(value, 'Subagent 输入')
  strictKeys(input, new Set(['content']), 'Subagent 输入')
  const content = text(input.content, 'Subagent 输入内容', 64_000)
  return { content }
}

function observedAt(value) {
  const timestamp = Number(value)
  return Number.isInteger(timestamp) && timestamp >= 0 ? timestamp : Date.now()
}

function normalizedRootExecution(value) {
  if (value === undefined) return undefined
  const execution = object(value, 'Subagent 根 Turn 执行围栏')
  strictKeys(execution, new Set(['generation', 'leaseToken']), 'Subagent 根 Turn 执行围栏')
  return {
    generation: integer(
      execution.generation,
      'Subagent 根 Turn execution generation',
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    leaseToken: text(execution.leaseToken, 'Subagent 根 Turn execution lease', 240),
  }
}

/** Adapter 必须在锁住 root Turn 后调用，避免旧 executor 在 takeover/cancel 后继续派发。 */
export function assertAgentSubagentRootTurnFence(rootTurn, rootExecution) {
  const execution = normalizedRootExecution(rootExecution)
  if (['failed', 'cancelling', 'cancelled'].includes(rootTurn?.status)) {
    invalid(
      'AGENT_TURN_DELEGATION_CANCELLED',
      'Agent Turn 已进入取消或失败状态，不能再派发 Subagent。',
      409,
    )
  }
  if (rootTurn?.status === 'queued') {
    invalid('AGENT_SUBAGENT_ROOT_TURN_NOT_READY', 'Agent Turn 尚未取得执行权，不能派发 Subagent。', 409)
  }
  if (rootTurn?.status === 'running') {
    if (!execution
      || Number(rootTurn.execution?.generation) !== execution.generation
      || rootTurn.execution?.leaseToken !== execution.leaseToken) {
      invalid('AGENT_SUBAGENT_ROOT_EXECUTION_STALE', 'Agent Turn 执行权已过期，不能派发 Subagent。', 409)
    }
    return execution
  }
  if (['completed', 'waiting_user'].includes(rootTurn?.status)) {
    if (execution) {
      invalid('AGENT_SUBAGENT_ROOT_EXECUTION_STALE', 'Agent Turn 已无活动执行租约。', 409)
    }
    return undefined
  }
  return invalid('AGENT_SUBAGENT_ROOT_TURN_NOT_READY', 'Agent Turn 当前状态不能派发 Subagent。', 409)
}

/** Stable public identity for a start idempotency binding. */
export function agentSubagentIdForIdempotency(ownerId, projectId, idempotencyKey) {
  return `agent_subagent_${canonicalHash({
    kind: 'agent_subagent',
    ownerId: text(ownerId, 'Subagent 所有者'),
    projectId: text(projectId, 'Subagent 项目'),
    idempotencyKey: text(idempotencyKey, 'Subagent 幂等键', 240),
  }).slice(0, 32)}`
}

export function agentSubagentSessionId(subagentId) {
  return `agent_subagent_session_${canonicalHash({
    kind: 'agent_subagent_session',
    subagentId: text(subagentId, 'Subagent 标识'),
  }).slice(0, 32)}`
}

export function agentSubagentActivationId(subagentId, sequence) {
  return `agent_subagent_activation_${canonicalHash({
    kind: 'agent_subagent_activation',
    subagentId: text(subagentId, 'Subagent 标识'),
    sequence: integer(sequence, 'Subagent Activation 序号', 1, Number.MAX_SAFE_INTEGER),
  }).slice(0, 32)}`
}

export function agentSubagentInputMessageId(activationId) {
  return `agent_subagent_input_${canonicalHash({
    kind: 'agent_subagent_input',
    activationId: text(activationId, 'Subagent Activation 标识'),
  }).slice(0, 32)}`
}

export function agentSubagentResultMessageId(turnId) {
  const id = `agent-turn-result-${text(turnId, 'Subagent Turn 标识', 130)}`
  if (id.length > 160) invalid('AGENT_SUBAGENT_FIELD_INVALID', 'Subagent 结果消息标识过长。')
  return id
}

/** Descriptor capabilities are bound independently from each activation input. */
export function agentSubagentDescriptorHash(descriptor) {
  return canonicalHash({
    version: 1,
    role: descriptor?.role,
    model: descriptor?.model,
    instructionsVersion: descriptor?.instructionsVersion,
    outputKind: descriptor?.outputKind,
    outputSchema: descriptor?.outputSchema,
    allowedTools: [...(descriptor?.allowedTools ?? [])].sort(),
    budget: descriptor?.budget,
  })
}

/** Semantic request binding; the idempotency key is deliberately a separate axis. */
export function agentSubagentEnqueueRequestHash(command) {
  const kind = command?.kind
  if (!enqueueKinds.has(kind)) invalid('AGENT_SUBAGENT_KIND_INVALID', 'Subagent Activation 类型无效。')
  const input = normalizedInput(command.input)
  const common = {
    version: 1,
    kind,
    projectId: text(command.projectId, 'Subagent 项目'),
    subagentId: text(command.subagentId, 'Subagent 标识'),
    sourceTurnId: text(command.sourceTurnId, 'Subagent 来源 Turn'),
    input,
  }
  if (kind === 'followup') return canonicalHash(common)
  const descriptor = normalizedDescriptor(command.descriptor)
  return canonicalHash({
    ...common,
    rootTurnId: text(command.rootTurnId, 'Subagent 根 Turn'),
    parentSessionId: command.parentSessionId === undefined
      ? null
      : text(command.parentSessionId, 'Subagent 父会话'),
    descriptor,
  })
}

function decision(kind, subagent, activation, changed, turn, extra = {}) {
  return {
    kind,
    subagent: clone(subagent),
    activation: clone(activation),
    ...(turn ? { turn: clone(turn) } : {}),
    changed,
    ...clone(extra),
  }
}

function assertBaseCommand(command) {
  const kind = command?.kind
  if (!enqueueKinds.has(kind)) invalid('AGENT_SUBAGENT_KIND_INVALID', 'Subagent Activation 类型无效。')
  for (const key of forbiddenClientKeys) {
    if (command?.[key] !== undefined) {
      invalid('AGENT_SUBAGENT_AUTHORITY_FORBIDDEN', '客户端不能提交 Subagent 系统提示词或自定义能力。', 403)
    }
  }
  const ownerId = text(command.ownerId, 'Subagent 所有者')
  const projectId = text(command.projectId, 'Subagent 项目')
  const subagentId = text(command.subagentId, 'Subagent 标识')
  const idempotencyKey = text(command.idempotencyKey, 'Subagent 幂等键', 240)
  const sourceTurnId = text(command.sourceTurnId, 'Subagent 来源 Turn')
  const input = normalizedInput(command.input)
  const expectedRequestHash = agentSubagentEnqueueRequestHash(command)
  if (text(command.requestHash, 'Subagent 请求摘要', 200) !== expectedRequestHash) {
    invalid('AGENT_SUBAGENT_REQUEST_HASH_MISMATCH', 'Subagent 请求摘要与输入不一致。', 409)
  }
  const timestamp = observedAt(command.observedAt)
  return { kind, ownerId, projectId, subagentId, idempotencyKey, sourceTurnId, input, requestHash: expectedRequestHash, timestamp }
}

/**
 * Materialize every value that is independent from DB state. A followup must supply the sequence
 * allocated under the Adapter lock; start is always sequence 1. SQL/RPC implementations can pass
 * this complete candidate through instead of reimplementing hashes in another language.
 */
export function materializeAgentSubagentEnqueueCommand(userId, rawCommand) {
  const ownerId = text(userId, 'Subagent 所有者')
  const command = clone(object(rawCommand, 'Subagent enqueue command'))
  for (const key of forbiddenClientKeys) {
    if (command[key] !== undefined) {
      invalid('AGENT_SUBAGENT_AUTHORITY_FORBIDDEN', '客户端不能提交 Subagent 系统提示词或自定义能力。', 403)
    }
  }
  strictKeys(command, new Set([
    'kind',
    'projectId',
    'subagentId',
    'rootTurnId',
    'sourceTurnId',
    'parentSessionId',
    'idempotencyKey',
    'requestHash',
    'input',
    'descriptor',
    'turn',
    'sequence',
    'cancelGeneration',
    'rootExecution',
    'observedAt',
  ]), 'Subagent enqueue command')
  const kind = command.kind
  if (!enqueueKinds.has(kind)) invalid('AGENT_SUBAGENT_KIND_INVALID', 'Subagent Activation 类型无效。')
  const projectId = text(command.projectId, 'Subagent 项目')
  const idempotencyKey = text(command.idempotencyKey, 'Subagent 幂等键', 240)
  const subagentId = kind === 'start'
    ? agentSubagentIdForIdempotency(ownerId, projectId, idempotencyKey)
    : text(command.subagentId, 'Subagent 标识')
  if (command.subagentId !== undefined && text(command.subagentId, 'Subagent 标识') !== subagentId) {
    invalid('AGENT_SUBAGENT_ID_MISMATCH', 'Subagent 标识与幂等键不一致。', 409)
  }
  const descriptor = kind === 'start' ? normalizedDescriptor(command.descriptor) : undefined
  const rootExecution = normalizedRootExecution(command.rootExecution)
  const input = normalizedInput(command.input)
  const normalized = {
    ...command,
    ownerId,
    projectId,
    subagentId,
    input,
    ...(rootExecution ? { rootExecution } : {}),
    ...(descriptor ? { descriptor } : {}),
  }
  normalized.requestHash = agentSubagentEnqueueRequestHash(normalized)
  if (command.requestHash !== undefined && text(command.requestHash, 'Subagent 请求摘要', 200) !== normalized.requestHash) {
    invalid('AGENT_SUBAGENT_REQUEST_HASH_MISMATCH', 'Subagent 请求摘要与输入不一致。', 409)
  }
  const sequence = kind === 'start'
    ? 1
    : integer(command.sequence, 'Subagent Activation 序号', 1, Number.MAX_SAFE_INTEGER)
  const sessionId = agentSubagentSessionId(subagentId)
  const activationId = agentSubagentActivationId(subagentId, sequence)
  const inputMessageId = agentSubagentInputMessageId(activationId)
  const cancelGeneration = kind === 'start'
    ? 0
    : integer(command.cancelGeneration, 'Subagent cancel generation', 0, Number.MAX_SAFE_INTEGER)
  const turnSource = object(command.turn, 'Subagent Turn')
  strictKeys(turnSource, new Set(['id', 'idempotencyKey', 'requestId', 'request']), 'Subagent Turn')
  const turnIdempotencyKey = text(turnSource.idempotencyKey, 'Subagent Turn 幂等键', 240)
  const rawRequest = object(turnSource.request, 'Subagent Turn 请求')
  const rawRequestInput = object(rawRequest.input, 'Subagent Turn 输入')
  strictKeys(rawRequest, new Set(['runtimeOperation', 'input']), 'Subagent Turn 请求')
  strictKeys(rawRequestInput, new Set([
    'subagentId',
    'activationId',
    'activationSequence',
    'cancelGeneration',
    'sessionId',
    'inputMessage',
    'sourceTurnId',
  ]), 'Subagent Turn 输入')
  const authoritativeInput = {
    subagentId,
    activationId,
    activationSequence: sequence,
    cancelGeneration,
    sessionId,
    inputMessage: { id: inputMessageId, content: input.content },
    sourceTurnId: text(command.sourceTurnId, 'Subagent 来源 Turn'),
  }
  for (const [key, value] of Object.entries(authoritativeInput)) {
    if (rawRequestInput[key] !== undefined
      && canonicalHash(rawRequestInput[key]) !== canonicalHash(value)) {
      invalid('AGENT_SUBAGENT_TURN_REQUEST_CONFLICT', `Subagent Turn 输入字段 ${key} 与权威序号不一致。`, 409)
    }
  }
  normalized.turn = {
    ...turnSource,
    id: agentTurnIdForIdempotency(ownerId, projectId, turnIdempotencyKey),
    idempotencyKey: turnIdempotencyKey,
    request: {
      ...rawRequest,
      runtimeOperation: 'subagent',
      input: authoritativeInput,
    },
  }
  const identity = {
    ownerId,
    projectId,
    subagentId,
    timestamp: observedAt(command.observedAt),
  }
  const turn = createTurn(normalized, identity, sessionId)
  return {
    ...normalized,
    sequence,
    cancelGeneration,
    candidate: {
      sessionId,
      activationId,
      inputMessageId,
      resultMessageId: agentSubagentResultMessageId(turn.id),
      turn,
    },
  }
}

function createTurn(command, identity, sessionId) {
  const source = object(command.turn, 'Subagent Turn')
  const idempotencyKey = text(source.idempotencyKey, 'Subagent Turn 幂等键', 240)
  const expectedId = agentTurnIdForIdempotency(identity.ownerId, identity.projectId, idempotencyKey)
  if (text(source.id, 'Subagent Turn 标识') !== expectedId) {
    invalid('AGENT_SUBAGENT_TURN_ID_MISMATCH', 'Subagent Turn 标识与幂等键不一致。', 409)
  }
  const request = object(source.request, 'Subagent Turn 请求')
  if (request.runtimeOperation !== 'subagent') {
    invalid('AGENT_SUBAGENT_TURN_REQUEST_INVALID', 'Subagent Turn 必须使用 subagent runtime operation。')
  }
  return createAgentTurnRecord({
    id: expectedId,
    ownerId: identity.ownerId,
    projectId: identity.projectId,
    sessionId,
    requestId: typeof source.requestId === 'string' && source.requestId.trim() ? source.requestId.trim() : undefined,
    idempotencyKey,
    request,
    now: identity.timestamp,
  })
}

function immutableSubagentBindingMatches(subagent, identity) {
  return subagent?.id === identity.subagentId
    && subagent?.ownerId === identity.ownerId
    && subagent?.projectId === identity.projectId
}

function replayMatches(activation, identity) {
  return activation?.subagentId === identity.subagentId
    && activation?.ownerId === identity.ownerId
    && activation?.projectId === identity.projectId
    && activation?.kind === identity.kind
    && activation?.sourceTurnId === identity.sourceTurnId
    && activation?.idempotencyKey === identity.idempotencyKey
    && activation?.requestHash === identity.requestHash
}

/**
 * Pure enqueue decision used inside each Adapter's transaction/lock.
 * `existingActivation` is the activation already bound to this idempotency key, if any.
 */
export function agentSubagentEnqueueDecision(existingSubagent, existingActivation, command) {
  const identity = assertBaseCommand(command)
  const existingTurn = command.existingTurn
  if (existingActivation) {
    if (!existingSubagent || !immutableSubagentBindingMatches(existingSubagent, identity)
      || !replayMatches(existingActivation, identity)) {
      return decision('conflict', existingSubagent, existingActivation, false, existingTurn)
    }
    return decision('replay', existingSubagent, existingActivation, false, existingTurn)
  }

  if (identity.kind === 'start') {
    const rootTurnId = text(command.rootTurnId, 'Subagent 根 Turn')
    if (rootTurnId !== identity.sourceTurnId) {
      invalid('AGENT_SUBAGENT_PROVENANCE_INVALID', 'Start Activation 的根 Turn 与来源 Turn 必须一致。')
    }
    const expectedSubagentId = agentSubagentIdForIdempotency(
      identity.ownerId,
      identity.projectId,
      identity.idempotencyKey,
    )
    if (identity.subagentId !== expectedSubagentId) {
      invalid('AGENT_SUBAGENT_ID_MISMATCH', 'Subagent 标识与幂等键不一致。', 409)
    }
    if (existingSubagent) return decision('conflict', existingSubagent, undefined, false)
    const descriptor = normalizedDescriptor(command.descriptor)
    const sessionId = agentSubagentSessionId(identity.subagentId)
    const sequence = 1
    const turn = createTurn(command, identity, sessionId)
    const activationId = agentSubagentActivationId(identity.subagentId, sequence)
    const inputMessageId = agentSubagentInputMessageId(activationId)
    const parentSessionId = command.parentSessionId === undefined
      ? undefined
      : text(command.parentSessionId, 'Subagent 父会话')
    const subagent = {
      id: identity.subagentId,
      version: 1,
      ownerId: identity.ownerId,
      projectId: identity.projectId,
      rootTurnId,
      ...(parentSessionId ? { parentSessionId } : {}),
      sessionId,
      ...descriptor,
      requestHash: identity.requestHash,
      idempotencyKey: identity.idempotencyKey,
      status: 'active',
      cancelGeneration: 0,
      lastEnqueuedSequence: sequence,
      settledThroughSequence: 0,
      createdAt: identity.timestamp,
      updatedAt: identity.timestamp,
    }
    const activation = {
      id: activationId,
      version: 1,
      ownerId: identity.ownerId,
      projectId: identity.projectId,
      subagentId: identity.subagentId,
      sessionId,
      sequence,
      kind: identity.kind,
      sourceTurnId: identity.sourceTurnId,
      idempotencyKey: identity.idempotencyKey,
      requestHash: identity.requestHash,
      inputMessageId,
      resultMessageId: agentSubagentResultMessageId(turn.id),
      turnId: turn.id,
      status: 'queued',
      cancelGeneration: 0,
      createdAt: identity.timestamp,
      updatedAt: identity.timestamp,
    }
    const session = validateAgentSessionEntity({
      id: sessionId,
      title: identity.kind === 'start' ? descriptor.role : 'Subagent',
      executionMode: 'manual',
      contextNodeIds: [],
      kind: 'subagent',
      subagentId: identity.subagentId,
      ...(parentSessionId ? { parentSessionId } : {}),
      plannerModel: descriptor.model,
      createdAt: identity.timestamp,
      updatedAt: identity.timestamp,
    }, { now: identity.timestamp })
    const inputMessage = validateAgentMessageEntity({
      id: inputMessageId,
      role: 'user',
      kind: 'text',
      content: identity.input.content,
      turnId: turn.id,
      status: 'submitted',
      createdAt: identity.timestamp,
      updatedAt: identity.timestamp,
    }, { now: identity.timestamp })
    return decision('enqueued', subagent, activation, true, turn, { session, inputMessage })
  }

  if (!existingSubagent) return decision('missing', undefined, undefined, false)
  if (!immutableSubagentBindingMatches(existingSubagent, identity)) {
    return decision('conflict', existingSubagent, undefined, false)
  }
  if (!descriptorStatuses.has(existingSubagent.status)) {
    return decision('conflict', existingSubagent, undefined, false)
  }
  if (existingSubagent.status !== 'active') {
    return decision('inactive', existingSubagent, undefined, false)
  }
  if (command.descriptor !== undefined || command.rootTurnId !== undefined || command.parentSessionId !== undefined) {
    invalid('AGENT_SUBAGENT_IMMUTABLE_DESCRIPTOR', 'Followup 不能修改 Subagent 描述或根来源。', 409)
  }
  const sequence = Number(existingSubagent.lastEnqueuedSequence) + 1
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    invalid('AGENT_SUBAGENT_SEQUENCE_INVALID', 'Subagent Activation 序号无效。', 409)
  }
  if (sequence > Number(existingSubagent.budget?.maxActivations)) {
    invalid('AGENT_SUBAGENT_ACTIVATION_LIMIT', 'Subagent 已达到 Activation 预算上限。', 409)
  }
  const sessionId = text(existingSubagent.sessionId, 'Subagent 会话')
  const turn = createTurn(command, identity, sessionId)
  const activationId = agentSubagentActivationId(identity.subagentId, sequence)
  const inputMessageId = agentSubagentInputMessageId(activationId)
  const activation = {
    id: activationId,
    version: 1,
    ownerId: identity.ownerId,
    projectId: identity.projectId,
    subagentId: identity.subagentId,
    sessionId,
    sequence,
    kind: identity.kind,
    sourceTurnId: identity.sourceTurnId,
    idempotencyKey: identity.idempotencyKey,
    requestHash: identity.requestHash,
    inputMessageId,
    resultMessageId: agentSubagentResultMessageId(turn.id),
    turnId: turn.id,
    status: 'queued',
    cancelGeneration: Number(existingSubagent.cancelGeneration) || 0,
    createdAt: identity.timestamp,
    updatedAt: identity.timestamp,
  }
  const subagent = {
    ...clone(existingSubagent),
    lastEnqueuedSequence: sequence,
    updatedAt: identity.timestamp,
  }
  const inputMessage = validateAgentMessageEntity({
    id: inputMessageId,
    role: 'user',
    kind: 'text',
    content: identity.input.content,
    turnId: turn.id,
    status: 'submitted',
    createdAt: identity.timestamp,
    updatedAt: identity.timestamp,
  }, { now: identity.timestamp })
  return decision('enqueued', subagent, activation, true, turn, { inputMessage })
}

function claimActivation(activation, command, timestamp, generation, cancelGeneration) {
  const leaseDurationMs = Math.max(30_000, Math.min(Number(command.leaseDurationMs) || 120_000, 900_000))
  return {
    ...clone(activation),
    status: 'running',
    cancelGeneration,
    updatedAt: timestamp,
    execution: {
      generation,
      cancelGeneration,
      leaseToken: text(command.leaseToken, 'Subagent Activation 租约', 240),
      leaseDurationMs,
      leaseExpiresAt: timestamp + leaseDurationMs,
      claimedAt: timestamp,
      lastHeartbeatAt: timestamp,
    },
  }
}

function descriptorDispatchMatches(subagent, activation) {
  return subagent?.dispatch?.activationId === activation?.id
    && Number(subagent?.dispatch?.activationSequence) === Number(activation?.sequence)
    && subagent?.dispatch?.leaseToken === activation?.execution?.leaseToken
    && Number(subagent?.dispatch?.generation) === Number(activation?.execution?.generation)
    && Number(subagent?.dispatch?.cancelGeneration) === Number(activation?.execution?.cancelGeneration)
}

export function agentSubagentActivationClaimDecision(subagent, activation, command) {
  const timestamp = observedAt(command?.observedAt)
  const leaseToken = text(command?.leaseToken, 'Subagent Activation 租约', 240)
  void leaseToken
  if (!subagent || !activation) return decision('missing', subagent, activation, false)
  if (subagent.id !== command?.subagentId || activation.subagentId !== subagent.id
    || (command?.activationId && activation.id !== command.activationId)) {
    return decision('conflict', subagent, activation, false)
  }
  if (terminalActivationStatuses.has(activation.status)) {
    return decision('replay', subagent, activation, false)
  }
  if (subagent.status === 'cancelling' || activation.status === 'cancelling') {
    return decision('cancelling', subagent, activation, false)
  }
  if (subagent.status === 'cancelled') return decision('cancelled', subagent, activation, false)
  if (subagent.status !== 'active') return decision('conflict', subagent, activation, false)
  const headSequence = Number(subagent.settledThroughSequence) + 1
  if (activation.sequence !== headSequence) return decision('not_head', subagent, activation, false)
  const cancelGeneration = Number(subagent.cancelGeneration) || 0
  if (Number(activation.cancelGeneration) !== cancelGeneration) {
    return decision('stale', subagent, activation, false)
  }
  if (activation.status === 'queued') {
    const claimed = claimActivation(
      activation,
      command,
      timestamp,
      Math.max(0, Number(activation.execution?.generation) || 0) + 1,
      cancelGeneration,
    )
    const updatedSubagent = {
      ...clone(subagent),
      dispatch: {
        activationId: claimed.id,
        activationSequence: claimed.sequence,
        generation: claimed.execution.generation,
        cancelGeneration,
        leaseToken: claimed.execution.leaseToken,
        leaseExpiresAt: claimed.execution.leaseExpiresAt,
      },
      updatedAt: timestamp,
    }
    return decision('claimed', updatedSubagent, claimed, true)
  }
  if (activation.status !== 'running') return decision('conflict', subagent, activation, false)
  if (!descriptorDispatchMatches(subagent, activation)) {
    return decision('conflict', subagent, activation, false)
  }
  if (activation.execution?.leaseToken === command.leaseToken) {
    return decision('claimed', subagent, activation, false)
  }
  if (Number(activation.execution?.leaseExpiresAt) > timestamp) {
    return decision('in_progress', subagent, activation, false)
  }
  if (command.allowTakeover !== true) return decision('stale', subagent, activation, false)
  const claimed = claimActivation(
    activation,
    command,
    timestamp,
    Math.max(0, Number(activation.execution?.generation) || 0) + 1,
    cancelGeneration,
  )
  const updatedSubagent = {
    ...clone(subagent),
    dispatch: {
      activationId: claimed.id,
      activationSequence: claimed.sequence,
      generation: claimed.execution.generation,
      cancelGeneration,
      leaseToken: claimed.execution.leaseToken,
      leaseExpiresAt: claimed.execution.leaseExpiresAt,
    },
    updatedAt: timestamp,
  }
  return decision('claimed', updatedSubagent, claimed, true)
}

function resultContent(turn) {
  const result = turn?.result
  if (typeof result?.answer === 'string' && result.answer.trim()) return result.answer.trim().slice(0, 64_000)
  if (typeof result?.summary === 'string' && result.summary.trim()) return result.summary.trim().slice(0, 64_000)
  if (typeof result?.output === 'string' && result.output.trim()) return result.output.trim().slice(0, 64_000)
  if (result?.output !== undefined) {
    const serialized = JSON.stringify(result.output)
    if (serialized) return serialized.slice(0, 64_000)
  }
  if (turn?.status === 'cancelled') return 'Subagent 已取消。'
  if (turn?.status === 'failed') return String(turn?.error?.message ?? 'Subagent 未完成。').slice(0, 64_000)
  return 'Subagent 已完成。'
}

function resultMessageForTurn(activation, turn, timestamp) {
  const completed = turn.status === 'completed'
  const entityReferences = completed && Array.isArray(turn.result?.entityReferences)
    ? clone(turn.result.entityReferences)
    : undefined
  return validateAgentMessageEntity({
    id: agentSubagentResultMessageId(turn.id),
    role: 'assistant',
    kind: completed ? 'text' : 'notice',
    content: resultContent(turn),
    turnId: turn.id,
    status: completed ? 'submitted' : 'failed',
    ...(entityReferences ? { entityReferences } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
  }, { now: timestamp })
}

function settledActivation(activation, turn, timestamp, executionGeneration) {
  return {
    ...clone(activation),
    status: turn.status,
    resultMessageId: agentSubagentResultMessageId(turn.id),
    settledAt: timestamp,
    updatedAt: timestamp,
    settlement: {
      turnStatus: turn.status,
      executionGeneration,
      cancelGeneration: Number(activation.cancelGeneration) || 0,
    },
    execution: undefined,
  }
}

export function agentSubagentActivationSettleDecision(subagent, activation, turn, command) {
  const timestamp = observedAt(command?.observedAt)
  if (!subagent || !activation || !turn) return decision('missing', subagent, activation, false, turn)
  if (subagent.id !== command?.subagentId || activation.id !== command?.activationId
    || activation.subagentId !== subagent.id || activation.turnId !== turn.id) {
    return decision('conflict', subagent, activation, false, turn)
  }
  if (terminalActivationStatuses.has(activation.status)) {
    return decision('replay', subagent, activation, false, turn)
  }
  const headSequence = Number(subagent.settledThroughSequence) + 1
  if (activation.sequence !== headSequence) return decision('not_head', subagent, activation, false, turn)
  if (subagent.status === 'cancelling' || activation.status === 'cancelling') {
    return decision('cancelling', subagent, activation, false, turn)
  }
  if (subagent.status !== 'active' || activation.status !== 'running') {
    return decision('conflict', subagent, activation, false, turn)
  }
  const commandGeneration = Number(command.executionGeneration)
  const commandCancelGeneration = Number(command.cancelGeneration)
  const sameFence = activation.execution?.leaseToken === command.leaseToken
    && Number(activation.execution?.generation) === commandGeneration
    && Number(activation.execution?.cancelGeneration) === commandCancelGeneration
    && Number(activation.cancelGeneration) === commandCancelGeneration
    && Number(subagent.cancelGeneration) === commandCancelGeneration
    && descriptorDispatchMatches(subagent, activation)
  if (!sameFence) return decision('stale', subagent, activation, false, turn)
  if (turn.ownerId !== subagent.ownerId || turn.projectId !== subagent.projectId
    || !terminalTurnStatuses.has(turn.status)) {
    return decision('not_ready', subagent, activation, false, turn)
  }
  const updatedActivation = settledActivation(activation, turn, timestamp, commandGeneration)
  const updatedSubagent = {
    ...clone(subagent),
    settledThroughSequence: activation.sequence,
    dispatch: undefined,
    updatedAt: timestamp,
  }
  const resultMessage = resultMessageForTurn(activation, turn, timestamp)
  return decision('settled', updatedSubagent, updatedActivation, true, turn, { resultMessage })
}

export function agentSubagentCancellationRequestDecision(subagent, activation, command) {
  const timestamp = observedAt(command?.observedAt)
  if (!subagent) return decision('missing', undefined, activation, false)
  if (subagent.id !== command?.subagentId || subagent.projectId !== command?.projectId) {
    return decision('conflict', subagent, activation, false)
  }
  const signalId = text(command.signalId, 'Subagent 取消信号', 240)
  const currentGeneration = Number(subagent.cancelGeneration) || 0
  if (command.expectedCancelGeneration !== undefined
    && Number(command.expectedCancelGeneration) !== currentGeneration) {
    return decision('stale', subagent, activation, false)
  }
  if (subagent.status === 'cancelled') return decision('replay', subagent, activation, false)
  if (subagent.status === 'cancelling') {
    return subagent.cancellation?.signalId === signalId
      ? decision('replay', subagent, activation, false)
      : decision('conflict', subagent, activation, false)
  }
  if (subagent.status !== 'active') return decision('conflict', subagent, activation, false)
  const generation = currentGeneration + 1
  const reason = typeof command.reason === 'string' && command.reason.trim()
    ? command.reason.trim().slice(0, 500)
    : '用户取消了 Subagent。'
  const hasUnsettledActivation = Number(subagent.settledThroughSequence) < Number(subagent.lastEnqueuedSequence)
  const updatedSubagent = {
    ...clone(subagent),
    status: hasUnsettledActivation ? 'cancelling' : 'cancelled',
    cancelGeneration: generation,
    cancellation: {
      generation,
      signalId,
      reason,
      requestedAt: timestamp,
      ...(!hasUnsettledActivation ? { finalizedAt: timestamp } : {}),
    },
    dispatch: undefined,
    updatedAt: timestamp,
  }
  const updatedActivation = activation && !terminalActivationStatuses.has(activation.status)
    ? { ...clone(activation), status: 'cancelling', updatedAt: timestamp }
    : activation
  return decision('requested', updatedSubagent, updatedActivation, true)
}

/**
 * Final cancellation decision accepts every unsettled activation because cancellation closes the
 * whole FIFO, not just the current head. Adapters call it after loading the rows under one lock.
 */
export function agentSubagentCancellationFinalizeDecision(subagent, activations, turns, command) {
  const timestamp = observedAt(command?.observedAt)
  const list = Array.isArray(activations) ? activations.slice().sort((left, right) => left.sequence - right.sequence) : []
  const turnById = new Map((Array.isArray(turns) ? turns : []).map((turn) => [turn.id, turn]))
  const head = list[0]
  const headTurn = head ? turnById.get(head.turnId) : undefined
  if (!subagent) return decision('missing', undefined, head, false, headTurn)
  if (subagent.id !== command?.subagentId || subagent.projectId !== command?.projectId) {
    return decision('conflict', subagent, head, false, headTurn)
  }
  if (subagent.status === 'cancelled') return decision('replay', subagent, head, false, headTurn)
  if (subagent.status !== 'cancelling') return decision('conflict', subagent, head, false, headTurn)
  const signalId = text(command.signalId, 'Subagent 取消信号', 240)
  const generation = Number(command.cancelGeneration)
  if (subagent.cancellation?.signalId !== signalId
    || Number(subagent.cancellation?.generation) !== generation
    || Number(subagent.cancelGeneration) !== generation) {
    return decision('stale', subagent, head, false, headTurn)
  }
  let expectedSequence = Number(subagent.settledThroughSequence) + 1
  const updatedActivations = []
  const resultMessages = []
  for (const activation of list) {
    if (activation.sequence !== expectedSequence || activation.subagentId !== subagent.id) {
      return decision('conflict', subagent, activation, false, turnById.get(activation.turnId))
    }
    const turn = turnById.get(activation.turnId)
    if (!turn || turn.ownerId !== subagent.ownerId || turn.projectId !== subagent.projectId
      || !terminalTurnStatuses.has(turn.status)) {
      return decision('not_ready', subagent, activation, false, turn)
    }
    const updated = settledActivation(activation, turn, timestamp, Number(activation.execution?.generation) || 0)
    updated.cancelGeneration = generation
    updated.settlement.cancelGeneration = generation
    updatedActivations.push(updated)
    resultMessages.push(resultMessageForTurn(activation, turn, timestamp))
    expectedSequence += 1
  }
  if (expectedSequence - 1 !== Number(subagent.lastEnqueuedSequence)) {
    return decision('not_ready', subagent, head, false, headTurn)
  }
  const updatedSubagent = {
    ...clone(subagent),
    status: 'cancelled',
    settledThroughSequence: Number(subagent.lastEnqueuedSequence),
    cancellation: { ...clone(subagent.cancellation), finalizedAt: timestamp },
    dispatch: undefined,
    updatedAt: timestamp,
  }
  const lastActivation = updatedActivations.at(-1)
  const lastTurn = lastActivation ? turnById.get(lastActivation.turnId) : undefined
  return decision('finalized', updatedSubagent, lastActivation, true, lastTurn, {
    activations: updatedActivations,
    resultMessages,
  })
}

export function normalizeAgentSubagentActivationPage(options = {}) {
  const raw = options ?? {}
  const afterSequence = Number(raw.afterSequence)
  return {
    afterSequence: Number.isInteger(afterSequence) && afterSequence >= 0 ? afterSequence : 0,
    limit: Math.max(1, Math.min(Number(raw.limit) || 50, 200)),
  }
}

export function normalizeRunnableAgentSubagentPage(options = {}) {
  const raw = options ?? {}
  const updatedAt = Number(raw.after?.updatedAt)
  const id = typeof raw.after?.id === 'string' ? raw.after.id.trim() : ''
  return {
    now: observedAt(raw.now),
    after: Number.isInteger(updatedAt) && updatedAt >= 0 && id ? { updatedAt, id } : null,
    limit: Math.max(1, Math.min(Number(raw.limit) || 25, 200)),
  }
}

export function publicAgentSubagent(subagent) {
  if (!subagent) return undefined
  const {
    ownerId: _ownerId,
    idempotencyKey: _idempotencyKey,
    requestHash: _requestHash,
    cancellation,
    dispatch,
    ...safe
  } = clone(subagent)
  return {
    ...safe,
    ...(dispatch ? {
      dispatch: {
        activationId: dispatch.activationId,
        activationSequence: dispatch.activationSequence,
        generation: dispatch.generation,
        cancelGeneration: dispatch.cancelGeneration,
        leaseExpiresAt: dispatch.leaseExpiresAt,
      },
    } : {}),
    ...(cancellation ? {
      cancellation: {
        generation: cancellation.generation,
        ...(cancellation.reason ? { reason: cancellation.reason } : {}),
        requestedAt: cancellation.requestedAt,
        ...(cancellation.finalizedAt !== undefined ? { finalizedAt: cancellation.finalizedAt } : {}),
      },
    } : {}),
  }
}

export function publicAgentSubagentActivation(activation) {
  if (!activation) return undefined
  const {
    ownerId: _ownerId,
    idempotencyKey: _idempotencyKey,
    requestHash: _requestHash,
    execution,
    ...safe
  } = clone(activation)
  return {
    ...safe,
    ...(execution ? {
      execution: {
        generation: execution.generation,
        cancelGeneration: execution.cancelGeneration,
        leaseExpiresAt: execution.leaseExpiresAt,
        claimedAt: execution.claimedAt,
        lastHeartbeatAt: execution.lastHeartbeatAt,
      },
    } : {}),
  }
}
