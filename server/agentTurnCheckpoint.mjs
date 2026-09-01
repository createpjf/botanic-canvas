// @ts-check
import { canonicalHash } from './canonicalHash.mjs'
import { validateAgentToolEntityReferences } from './agentEntityReferences.mjs'

const CHECKPOINT_VERSION = 1
const MAX_STEPS = 8
const MAX_CALLS_PER_STEP = 16
const MAX_CHECKPOINT_BYTES = 64 * 1024
const MAX_TERMINAL_CONTENT = 12_000
const TOOL_NAME = /^[a-z][a-z0-9_]{1,63}$/
const RISKS = new Set(['read', 'write', 'costly', 'external'])
const RECOVERY_MODES = new Set(['reexecute', 'receipt', 'never'])

const CHECKPOINT_KEYS = new Set(['version', 'attempt', 'completedSteps', 'pendingStep', 'terminalContent'])
const ATTEMPT_KEYS = new Set(['id', 'model', 'snapshotHash'])
const STEP_KEYS = new Set(['step', 'calls'])
const CALL_BASE_KEYS = ['id', 'name', 'risk', 'recovery', 'terminal']

/** @typedef {{ id: string, model: string, snapshotHash: string }} AgentTurnCheckpointAttempt */
/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   risk: string,
 *   recovery: string,
 *   terminal: boolean,
 *   arguments?: Record<string, unknown>,
 *   receiptId?: string,
 *   intentHash?: string,
 *   entityReferences?: Array<{ type: string, id: string }>,
 * }} AgentTurnCheckpointCall
 */
/** @typedef {{ step: number, calls: AgentTurnCheckpointCall[] }} AgentTurnCheckpointStep */
/**
 * @typedef {{
 *   version: 1,
 *   attempt: AgentTurnCheckpointAttempt,
 *   completedSteps: AgentTurnCheckpointStep[],
 *   pendingStep?: AgentTurnCheckpointStep,
 *   terminalContent?: string,
 * }} AgentTurnCheckpoint
 */

// Checkpoint 只保存可重放意图。以下字段属于媒体载荷、完整思维链或执行结果，
// 即使被嵌套进工具参数也不能绕过边界。
const FORBIDDEN_ARGUMENT_KEYS = new Set([
  'analysis',
  'base64',
  'binary',
  'blob',
  'buffer',
  'bytes',
  'chainofthought',
  'file',
  'image',
  'imagedata',
  'imageurl',
  'output',
  'providerresponse',
  'proto',
  'prototype',
  'rawresponse',
  'reasoning',
  'reasoningcontent',
  'result',
  'constructor',
  'thoughts',
  'videodata',
  'videourl',
  'audiodata',
  'audiourl',
])

function checkpointError(message, code = 'AGENT_TURN_CHECKPOINT_INVALID') {
  return Object.assign(new TypeError(message), { code })
}

/** @returns {never} */
function invalid(message, code) {
  throw checkpointError(message, code)
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${name}无效。`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid(`${name}必须是普通对象。`)
  return /** @type {Record<string, any>} */ (value)
}

function exactKeys(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${name}包含不允许的字段：${key}。`)
  }
}

function text(value, name, maximumLength) {
  if (typeof value !== 'string' || !value.trim()) invalid(`${name}无效。`)
  const normalized = value.trim()
  if (normalized.length > maximumLength) invalid(`${name}过长。`)
  return normalized
}

function normalizeAttempt(value) {
  const raw = object(value, 'Checkpoint attempt')
  exactKeys(raw, ATTEMPT_KEYS, 'Checkpoint attempt')
  return {
    id: text(raw.id, 'Checkpoint attempt 标识', 80),
    model: text(raw.model, 'Checkpoint 模型', 160),
    snapshotHash: text(raw.snapshotHash, 'Checkpoint snapshot hash', 160),
  }
}

function normalizedKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, '')
}

function validateSafeJson(value, path = 'arguments', depth = 0, ancestors = new Set()) {
  if (depth > 16) invalid(`${path}嵌套过深。`)
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(`${path}包含非有限数字。`)
    return value
  }
  if (typeof value === 'string') {
    if (/^data:/iu.test(value.trim())) invalid(`${path}不得包含媒体 Data URL。`)
    return value
  }
  if (!value || typeof value !== 'object') invalid(`${path}不是可持久化 JSON。`)
  if (ancestors.has(value)) invalid(`${path}不得循环引用。`)
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => {
        if (!(index in value)) invalid(`${path}不得包含稀疏数组。`)
        return validateSafeJson(entry, `${path}[${index}]`, depth + 1, ancestors)
      })
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) invalid(`${path}必须是普通 JSON 对象。`)
    const result = {}
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_ARGUMENT_KEYS.has(normalizedKey(key))) {
        invalid(`${path}.${key}属于禁止持久化的媒体、推理或结果字段。`)
      }
      result[key] = validateSafeJson(entry, `${path}.${key}`, depth + 1, ancestors)
    }
    return result
  } finally {
    ancestors.delete(value)
  }
}

function normalizeCall(value, name = 'Checkpoint 工具调用', allowEntityReferences = false) {
  const raw = object(value, name)
  const recovery = text(raw.recovery, `${name} recovery`, 24)
  if (!RECOVERY_MODES.has(recovery)) invalid(`${name} recovery 无效。`)
  const allowed = new Set(CALL_BASE_KEYS)
  if (recovery === 'reexecute') allowed.add('arguments')
  if (recovery === 'receipt') {
    allowed.add('receiptId')
    allowed.add('intentHash')
  }
  if (allowEntityReferences) allowed.add('entityReferences')
  exactKeys(raw, allowed, name)

  const callName = text(raw.name, `${name}名称`, 64)
  if (!TOOL_NAME.test(callName)) invalid(`${name}名称无效。`)
  const risk = text(raw.risk, `${name}风险`, 24)
  if (!RISKS.has(risk)) invalid(`${name}风险无效。`)
  if (typeof raw.terminal !== 'boolean') invalid(`${name} terminal 无效。`)

  const result = {
    id: text(raw.id, `${name}标识`, 160),
    name: callName,
    risk,
    recovery,
    terminal: raw.terminal,
  }
  if (recovery === 'reexecute') {
    if (!raw.arguments || typeof raw.arguments !== 'object' || Array.isArray(raw.arguments)) {
      invalid(`${name}缺少可重放参数。`)
    }
    result.arguments = validateSafeJson(raw.arguments)
  } else if (recovery === 'receipt') {
    result.receiptId = text(raw.receiptId, `${name} receipt`, 240)
    result.intentHash = text(raw.intentHash, `${name} intent hash`, 160)
  }
  if (raw.entityReferences !== undefined) {
    result.entityReferences = validateAgentToolEntityReferences(callName, raw.entityReferences)
  }
  return result
}

function normalizeCalls(value, name, seenCallIds, allowEntityReferences = false) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CALLS_PER_STEP) {
    invalid(`${name}工具调用数量无效。`)
  }
  const calls = value.map((call, index) => normalizeCall(
    call,
    `${name}第 ${index + 1} 个工具调用`,
    allowEntityReferences,
  ))
  let terminalSeen = false
  for (const [index, call] of calls.entries()) {
    if (seenCallIds.has(call.id)) invalid(`Checkpoint 工具调用标识重复：${call.id}。`)
    seenCallIds.add(call.id)
    if (terminalSeen) invalid(`${name}的 terminal 工具必须是最后一个调用。`)
    if (call.terminal) {
      terminalSeen = true
      if (index !== calls.length - 1) invalid(`${name}的 terminal 工具必须是最后一个调用。`)
    }
  }
  return calls
}

function normalizeStep(value, expectedStep, name, seenCallIds, allowEntityReferences = false) {
  const raw = object(value, name)
  exactKeys(raw, STEP_KEYS, name)
  if (!Number.isInteger(raw.step) || raw.step !== expectedStep || raw.step < 0 || raw.step >= MAX_STEPS) {
    invalid(`${name}步骤不连续。`)
  }
  return {
    step: raw.step,
    calls: normalizeCalls(raw.calls, name, seenCallIds, allowEntityReferences),
  }
}

function assertCheckpointSize(checkpoint) {
  const serialized = JSON.stringify(checkpoint)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CHECKPOINT_BYTES) {
    invalid('Agent Turn Checkpoint 超过 64KB 上限。', 'AGENT_TURN_CHECKPOINT_TOO_LARGE')
  }
}

/**
 * 验证并投影一份 Agent Turn 步骤 Checkpoint。返回值是新对象，
 * 不保留输入的原型、多余字段或引用。
 *
 * @param {unknown} value
 * @returns {AgentTurnCheckpoint}
 */
export function validateAgentTurnCheckpoint(value) {
  const raw = object(value, 'Agent Turn Checkpoint')
  exactKeys(raw, CHECKPOINT_KEYS, 'Agent Turn Checkpoint')
  if (raw.version !== CHECKPOINT_VERSION) invalid('Agent Turn Checkpoint 版本无效。')
  /** @type {AgentTurnCheckpoint} */
  const checkpoint = {
    version: CHECKPOINT_VERSION,
    attempt: normalizeAttempt(raw.attempt),
    completedSteps: [],
  }
  if (!Array.isArray(raw.completedSteps) || raw.completedSteps.length > MAX_STEPS) {
    invalid('Agent Turn Checkpoint 已完成步骤无效。')
  }
  const seenCallIds = new Set()
  checkpoint.completedSteps = raw.completedSteps.map((step, index) => (
    normalizeStep(step, index, `Checkpoint 已完成步骤 ${index}`, seenCallIds, true)
  ))
  if (raw.pendingStep !== undefined) {
    if (checkpoint.completedSteps.length >= MAX_STEPS) invalid('Agent Turn Checkpoint 已达步骤上限。')
    checkpoint.pendingStep = normalizeStep(
      raw.pendingStep,
      checkpoint.completedSteps.length,
      'Checkpoint pending 步骤',
      seenCallIds,
    )
  }
  if (raw.terminalContent !== undefined) {
    if (checkpoint.pendingStep) invalid('Terminal Checkpoint 不能同时包含 pending 步骤。')
    // terminal cursor 允许等于 MAX_STEPS（H4 final synthesis）:它只写 terminalContent,
    // 不创建第 MAX_STEPS+1 个 tool step;工具步骤校验仍严格 < MAX_STEPS。
    if (checkpoint.completedSteps.length > MAX_STEPS) invalid('Terminal Checkpoint 步骤超出上限。')
    checkpoint.terminalContent = text(raw.terminalContent, 'Terminal Checkpoint 内容', MAX_TERMINAL_CONTENT)
  }
  assertCheckpointSize(checkpoint)
  return structuredClone(checkpoint)
}

function initialCheckpoint(attempt) {
  return validateAgentTurnCheckpoint({
    version: CHECKPOINT_VERSION,
    attempt,
    completedSteps: [],
  })
}

function assertSameAttempt(previous, attempt) {
  const current = normalizeAttempt(attempt)
  if (canonicalHash(previous.attempt) !== canonicalHash(current)) {
    invalid(
      'Agent Turn Checkpoint 的执行尝试或能力快照已变更。',
      'AGENT_TURN_CHECKPOINT_SNAPSHOT_MISMATCH',
    )
  }
  return current
}

/**
 * 模型已返回 tool calls、但工具尚未执行时的 prepared 边界。
 * 该函数必须在任何工具副作用之前被 await 持久化。
 */
export function prepareAgentTurnCheckpoint(previous, input) {
  const checkpoint = previous === undefined
    ? initialCheckpoint(input?.attempt)
    : validateAgentTurnCheckpoint(previous)
  const currentAttempt = assertSameAttempt(checkpoint, input?.attempt)
  if (checkpoint.terminalContent !== undefined) invalid('已有终态内容的 Checkpoint 不能再准备新步骤。')
  if (!Number.isInteger(input?.step) || input.step !== checkpoint.completedSteps.length || input.step >= MAX_STEPS) {
    invalid('Checkpoint prepared 步骤与已完成游标不匹配。')
  }
  const calls = normalizeCalls(input?.calls, 'Checkpoint prepared 步骤', new Set(
    checkpoint.completedSteps.flatMap((step) => step.calls.map((call) => call.id)),
  ))
  if (checkpoint.pendingStep) {
    if (checkpoint.pendingStep.step === input.step
      && canonicalHash(checkpoint.pendingStep.calls) === canonicalHash(calls)) return checkpoint
    invalid('Checkpoint 已有不同的 pending 步骤。', 'AGENT_TURN_CHECKPOINT_MISMATCH')
  }
  return validateAgentTurnCheckpoint({
    version: CHECKPOINT_VERSION,
    attempt: currentAttempt,
    completedSteps: checkpoint.completedSteps,
    pendingStep: { step: input.step, calls },
  })
}

/**
 * 当前 prepared 步骤的全部工具已收束。不保存任何工具输出；
 * calls 只用来确认完成的仍是之前固定的同一批调用。
 */
export function completeAgentTurnCheckpoint(prepared, input) {
  const checkpoint = validateAgentTurnCheckpoint(prepared)
  // 传输重试可能在 completed 已落盘后再调一次。此时允许传入
  // 最后一步的同一批 calls，但仍要阻止它们与更早步骤撞 ID。
  const identitySteps = checkpoint.pendingStep
    ? checkpoint.completedSteps
    : checkpoint.completedSteps.slice(0, -1)
  const previousIds = new Set(identitySteps.flatMap((step) => step.calls.map((call) => call.id)))
  const calls = normalizeCalls(input?.calls, 'Checkpoint completed 步骤', previousIds, true)
  if (!checkpoint.pendingStep) {
    const latest = checkpoint.completedSteps.at(-1)
    if (latest && canonicalHash(latest.calls) === canonicalHash(calls)) return checkpoint
    invalid('Checkpoint 没有可完成的 pending 步骤。', 'AGENT_TURN_CHECKPOINT_MISMATCH')
  }
  const callIdentity = (call) => {
    const { entityReferences, ...identity } = call
    void entityReferences
    return identity
  }
  if (canonicalHash(checkpoint.pendingStep.calls) !== canonicalHash(calls.map(callIdentity))) {
    invalid('Checkpoint completed 调用与 prepared 调用不一致。', 'AGENT_TURN_CHECKPOINT_MISMATCH')
  }
  return validateAgentTurnCheckpoint({
    version: CHECKPOINT_VERSION,
    attempt: checkpoint.attempt,
    completedSteps: [
      ...checkpoint.completedSteps,
      { step: checkpoint.pendingStep.step, calls },
    ],
  })
}

/** 无工具最终回答的私有 Checkpoint。内容后续可直接落为 Turn result。 */
export function terminalAgentTurnCheckpoint(previous, input) {
  const checkpoint = previous === undefined
    ? initialCheckpoint(input?.attempt)
    : validateAgentTurnCheckpoint(previous)
  const currentAttempt = assertSameAttempt(checkpoint, input?.attempt)
  const content = text(input?.content, 'Terminal Checkpoint 内容', MAX_TERMINAL_CONTENT)
  if (checkpoint.pendingStep) invalid('Pending 工具步骤尚未完成，不能写入终态内容。')
  if (!Number.isInteger(input?.step) || input.step !== checkpoint.completedSteps.length || input.step > MAX_STEPS) {
    invalid('Terminal Checkpoint 步骤与已完成游标不匹配。')
  }
  if (checkpoint.terminalContent !== undefined) {
    if (checkpoint.terminalContent === content) return checkpoint
    invalid('Checkpoint 已有不同的终态内容。', 'AGENT_TURN_CHECKPOINT_MISMATCH')
  }
  return validateAgentTurnCheckpoint({
    version: CHECKPOINT_VERSION,
    attempt: currentAttempt,
    completedSteps: checkpoint.completedSteps,
    terminalContent: content,
  })
}

/** @param {unknown} checkpoint */
export function agentTurnCheckpointHash(checkpoint) {
  return canonicalHash(validateAgentTurnCheckpoint(checkpoint))
}
