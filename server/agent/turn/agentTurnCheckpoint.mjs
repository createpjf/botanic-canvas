// @ts-check
import { canonicalHash } from '../../canonicalHash.mjs'
import { validateAgentToolEntityReferences } from '../../agentEntityReferences.mjs'
import { classifyPublicHttpUrl } from '../tools/agentWebResearch.mjs'

const CHECKPOINT_VERSION = 1
/** Checkpoint V2（H6A，ADR 0004/0008 2026-09-01 修订）：每 call lifecycle 与安全 result envelope。 */
const CHECKPOINT_VERSION_V2 = 2
const MAX_STEPS = 8
const MAX_CALLS_PER_STEP = 16
const MAX_CHECKPOINT_BYTES = 64 * 1024
/** H6G 批准的 result 预算：单 call 8KiB、全 Turn 24KiB；总 checkpoint 仍 64KiB。 */
const MAX_RESULT_ENVELOPE_BYTES = 8 * 1024
const MAX_TURN_RESULT_BYTES = 24 * 1024
export const AGENT_TURN_TERMINAL_CONTENT_LIMIT = 12_000
const TOOL_NAME = /^[a-z][a-z0-9_]{1,63}$/
const RISKS = new Set(['read', 'write', 'costly', 'external'])
const RECOVERY_MODES = new Set(['reexecute', 'receipt', 'never', 'journal'])
/** V2 每 call lifecycle。prepared/dispatched 只出现在 pendingStep;终态出现在两处。 */
const CALL_PHASES = new Set(['prepared', 'dispatched', 'completed', 'failed', 'aborted', 'unknown'])

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
 *   phase?: string,
 *   resultEnvelope?: string,
 *   resultRef?: { kind: string, id: string },
 *   entityReferences?: Array<{ type: string, id: string }>,
 * }} AgentTurnCheckpointCall
 */
/** @typedef {{ step: number, calls: AgentTurnCheckpointCall[] }} AgentTurnCheckpointStep */
/**
 * @typedef {{
 *   version: 1 | 2,
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

export function agentTurnCheckpointResultEnvelopeUrls(value) {
  if (typeof value !== 'string') return []
  const decoded = value.replace(/\\\//gu, '/')
  return [...decoded.matchAll(/\bhttps?:\/\/[^\s"'<>\\{}]+/giu)].map((match) => match[0])
}

/** 与 envelope URL 提取同源的原文匹配：额外容忍 JSON 转义的 `\/`，用于原地替换。 */
const ENVELOPE_URL_PATTERN = /\bhttps?:(?:\\?\/){2}(?:[^\s"'<>{}\\]|\\\/)+/giu
const ENVELOPE_MEDIA_DATA_URL_PATTERN = /data:(?:image|video|audio|application)\/[a-z0-9.+-]*(?:;[a-z0-9=+-]*)*(?:,[a-z0-9+/=_%.~-]*)?/giu

/**
 * H6G 规则 1 的「规范化脱敏」写入侧。envelope 就是抓取回来的页面正文，
 * 天然可能包含 http 链接、非 443 端口 URL 或 `data:` 字样；这些是内容而不是
 * 出口目标，写入前替换为占位符，validateResultEnvelope 仍是最终 backstop。
 *
 * @param {string} value
 * @returns {string}
 */
export function sanitizeAgentTurnCheckpointResultEnvelope(value) {
  if (typeof value !== 'string') return value
  return value
    .replace(ENVELOPE_MEDIA_DATA_URL_PATTERN, '[removed:data-url]')
    .replace(ENVELOPE_URL_PATTERN, (match) => (
      classifyPublicHttpUrl(match.replace(/\\\//gu, '/')).ok ? match : '[removed:non-public-url]'
    ))
}

/**
 * 复用恢复时需要 DNS 级复检的结构化来源 URL：只取 JSON 里 `url` 字段的值。
 * 正文自由文本里的链接不是出口目标（恢复不会抓取它们），已在 checkpoint
 * 校验时做过语法级校验，不做 DNS 复检——一条死链不该让已成功的结果失效。
 *
 * @param {string} value
 * @returns {string[]}
 */
export function agentTurnCheckpointStructuredSourceUrls(value) {
  if (typeof value !== 'string') return []
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    return []
  }
  const urls = new Set()
  const visit = (node, depth) => {
    if (depth > 8 || !node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 32)) visit(item, depth + 1)
      return
    }
    if (typeof node.url === 'string' && /^https?:\/\//iu.test(node.url.trim())) urls.add(node.url.trim())
    for (const item of Object.values(node)) visit(item, depth + 1)
  }
  visit(parsed, 0)
  return [...urls]
}

/** V2 result envelope：与实际送给模型的字符串完全一致;拒绝 raw/reasoning/媒体/Data URL/非公开 URL。 */
function validateResultEnvelope(value, name) {
  if (typeof value !== 'string' || !value.trim()) invalid(`${name} result envelope 无效。`)
  if (Buffer.byteLength(value, 'utf8') > MAX_RESULT_ENVELOPE_BYTES) {
    invalid(`${name} result envelope 超过 8KiB。`, 'AGENT_TURN_CHECKPOINT_TOO_LARGE')
  }
  if (/data:(?:image|video|audio|application)\//iu.test(value)) invalid(`${name} result envelope 不得包含媒体 Data URL。`)
  if (/"(?:reasoning|reasoning_content|analysis)"\s*:/iu.test(value)) invalid(`${name} result envelope 不得包含原始推理。`)
  for (const url of agentTurnCheckpointResultEnvelopeUrls(value)) {
    const classified = classifyPublicHttpUrl(url)
    if (!classified.ok) invalid(`${name} result envelope ${classified.message}`)
  }
  return value
}

function normalizeCall(value, name = 'Checkpoint 工具调用', allowEntityReferences = false, version = CHECKPOINT_VERSION) {
  const raw = object(value, name)
  const recovery = text(raw.recovery, `${name} recovery`, 24)
  if (!RECOVERY_MODES.has(recovery)) invalid(`${name} recovery 无效。`)
  if (recovery === 'journal' && version !== CHECKPOINT_VERSION_V2) invalid(`${name} journal recovery 需要 Checkpoint V2。`)
  const allowed = new Set(CALL_BASE_KEYS)
  if (recovery === 'reexecute') allowed.add('arguments')
  if (recovery === 'receipt') {
    allowed.add('receiptId')
    allowed.add('intentHash')
  }
  if (version === CHECKPOINT_VERSION_V2) {
    allowed.add('phase')
    if (recovery === 'journal') {
      allowed.add('arguments')
      allowed.add('resultEnvelope')
      allowed.add('resultRef')
    }
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
  } else if (recovery === 'journal') {
    // journal（H6B writer 使用,H6A reader 先支持）:外部读取的每 call lifecycle。
    if (raw.arguments !== undefined) result.arguments = validateSafeJson(raw.arguments)
    if (raw.resultEnvelope !== undefined) result.resultEnvelope = validateResultEnvelope(raw.resultEnvelope, name)
    if (raw.resultRef !== undefined) {
      const ref = object(raw.resultRef, `${name} resultRef`)
      exactKeys(ref, new Set(['kind', 'id']), `${name} resultRef`)
      const kind = text(ref.kind, `${name} resultRef kind`, 24)
      if (!['receipt', 'artifact'].includes(kind)) invalid(`${name} resultRef 只能指向 Receipt 或 Artifact。`)
      result.resultRef = { kind, id: text(ref.id, `${name} resultRef id`, 240) }
    }
  }
  if (version === CHECKPOINT_VERSION_V2 && raw.phase !== undefined) {
    const phase = text(raw.phase, `${name} phase`, 24)
    if (!CALL_PHASES.has(phase)) invalid(`${name} phase 无效。`)
    if (phase === 'completed' && recovery === 'journal' && raw.resultEnvelope === undefined && raw.resultRef === undefined) {
      invalid(`${name} completed journal call 缺少安全结果。`)
    }
    result.phase = phase
  }
  if (raw.entityReferences !== undefined) {
    result.entityReferences = validateAgentToolEntityReferences(callName, raw.entityReferences)
  }
  return result
}

function normalizeCalls(value, name, seenCallIds, allowEntityReferences = false, version = CHECKPOINT_VERSION) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CALLS_PER_STEP) {
    invalid(`${name}工具调用数量无效。`)
  }
  const calls = value.map((call, index) => normalizeCall(
    call,
    `${name}第 ${index + 1} 个工具调用`,
    allowEntityReferences,
    version,
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

function normalizeStep(value, expectedStep, name, seenCallIds, allowEntityReferences = false, version = CHECKPOINT_VERSION) {
  const raw = object(value, name)
  exactKeys(raw, STEP_KEYS, name)
  if (!Number.isInteger(raw.step) || raw.step !== expectedStep || raw.step < 0 || raw.step >= MAX_STEPS) {
    invalid(`${name}步骤不连续。`)
  }
  return {
    step: raw.step,
    calls: normalizeCalls(raw.calls, name, seenCallIds, allowEntityReferences, version),
  }
}

/** V2 全 Turn result 预算：completed envelope 合计 ≤24KiB。 */
function assertTurnResultBudget(checkpoint) {
  let total = 0
  const steps = [...checkpoint.completedSteps, ...(checkpoint.pendingStep ? [checkpoint.pendingStep] : [])]
  for (const step of steps) {
    for (const call of step.calls) {
      if (typeof call.resultEnvelope === 'string') total += Buffer.byteLength(call.resultEnvelope, 'utf8')
    }
  }
  if (total > MAX_TURN_RESULT_BYTES) {
    invalid('Checkpoint result envelope 合计超过 24KiB。', 'AGENT_TURN_CHECKPOINT_TOO_LARGE')
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
  // V1 reader 保留;V2 reader（H6A）先上线,writer（H6B）后启用。
  if (raw.version !== CHECKPOINT_VERSION && raw.version !== CHECKPOINT_VERSION_V2) invalid('Agent Turn Checkpoint 版本无效。')
  const version = raw.version
  /** @type {AgentTurnCheckpoint} */
  const checkpoint = {
    version,
    attempt: normalizeAttempt(raw.attempt),
    completedSteps: [],
  }
  if (!Array.isArray(raw.completedSteps) || raw.completedSteps.length > MAX_STEPS) {
    invalid('Agent Turn Checkpoint 已完成步骤无效。')
  }
  const seenCallIds = new Set()
  checkpoint.completedSteps = raw.completedSteps.map((step, index) => (
    normalizeStep(step, index, `Checkpoint 已完成步骤 ${index}`, seenCallIds, true, version)
  ))
  if (raw.pendingStep !== undefined) {
    if (checkpoint.completedSteps.length >= MAX_STEPS) invalid('Agent Turn Checkpoint 已达步骤上限。')
    checkpoint.pendingStep = normalizeStep(
      raw.pendingStep,
      checkpoint.completedSteps.length,
      'Checkpoint pending 步骤',
      seenCallIds,
      version === CHECKPOINT_VERSION_V2,
      version,
    )
  }
  if (version === CHECKPOINT_VERSION_V2) {
    // V2 终态 call 只能出现在 completedSteps;pendingStep 允许 prepared/dispatched/终态混合。
    for (const step of checkpoint.completedSteps) {
      for (const call of step.calls) {
        if (call.phase !== undefined && ['prepared', 'dispatched'].includes(call.phase)) {
          invalid('Checkpoint 已完成步骤不得包含未收束的 call。')
        }
      }
    }
    assertTurnResultBudget(checkpoint)
  }
  if (raw.terminalContent !== undefined) {
    if (checkpoint.pendingStep) invalid('Terminal Checkpoint 不能同时包含 pending 步骤。')
    // terminal cursor 允许等于 MAX_STEPS（H4 final synthesis）:它只写 terminalContent,
    // 不创建第 MAX_STEPS+1 个 tool step;工具步骤校验仍严格 < MAX_STEPS。
    if (checkpoint.completedSteps.length > MAX_STEPS) invalid('Terminal Checkpoint 步骤超出上限。')
    checkpoint.terminalContent = text(raw.terminalContent, 'Terminal Checkpoint 内容', AGENT_TURN_TERMINAL_CONTENT_LIMIT)
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
  // journal call（H6B）进入 pendingStep 即写 V2;一旦升到 V2 不再降回 V1。
  const requestedVersion = (Array.isArray(input?.calls) && input.calls.some((call) => call?.recovery === 'journal'))
    || checkpoint.version === CHECKPOINT_VERSION_V2
    ? CHECKPOINT_VERSION_V2
    : CHECKPOINT_VERSION
  const calls = normalizeCalls(input?.calls, 'Checkpoint prepared 步骤', new Set(
    checkpoint.completedSteps.flatMap((step) => step.calls.map((call) => call.id)),
  ), false, requestedVersion)
  if (checkpoint.pendingStep) {
    if (checkpoint.pendingStep.step === input.step
      && canonicalHash(checkpoint.pendingStep.calls.map(journalCallIdentity)) === canonicalHash(calls.map(journalCallIdentity))) return checkpoint
    invalid('Checkpoint 已有不同的 pending 步骤。', 'AGENT_TURN_CHECKPOINT_MISMATCH')
  }
  return validateAgentTurnCheckpoint({
    version: requestedVersion,
    attempt: currentAttempt,
    completedSteps: checkpoint.completedSteps,
    pendingStep: { step: input.step, calls },
  })
}

/** journal lifecycle 字段不参与 prepared↔completed 的调用一致性比较。 */
function journalCallIdentity(call) {
  const { entityReferences, phase, resultEnvelope, resultRef, ...identity } = call
  void entityReferences; void phase; void resultEnvelope; void resultRef
  return identity
}

/**
 * H6B：pendingStep 中单个 journal call 的 lifecycle 提交。
 * dispatched 在请求交给 client 前持久化;completed 携带与模型 history 完全一致的
 * envelope（写入侧先做 H6G 规则 1 的规范化脱敏,调用方应读回本函数返回的
 * durable 字符串再进入模型 history）。逐 call 提交,不等整步收束。
 */
export function journalAgentTurnCheckpointCall(previous, input) {
  const checkpoint = validateAgentTurnCheckpoint(previous)
  if (!checkpoint.pendingStep) invalid('Checkpoint 没有 pending 步骤，无法提交 journal lifecycle。', 'AGENT_TURN_CHECKPOINT_MISMATCH')
  const callId = text(input?.callId, 'journal call 标识', 160)
  const phase = text(input?.phase, 'journal phase', 24)
  if (!CALL_PHASES.has(phase) || phase === 'prepared') invalid('journal phase 无效。')
  const index = checkpoint.pendingStep.calls.findIndex((call) => call.id === callId)
  if (index < 0) invalid('journal call 不在 pending 步骤中。', 'AGENT_TURN_CHECKPOINT_MISMATCH')
  const target = checkpoint.pendingStep.calls[index]
  if (target.recovery !== 'journal') invalid('只有 journal call 可以提交逐调用 lifecycle。')
  const updated = {
    ...target,
    phase,
    ...(input?.resultEnvelope !== undefined
      ? { resultEnvelope: sanitizeAgentTurnCheckpointResultEnvelope(input.resultEnvelope) }
      : {}),
    ...(input?.resultRef !== undefined ? { resultRef: input.resultRef } : {}),
  }
  const calls = checkpoint.pendingStep.calls.map((call, callIndex) => (callIndex === index ? updated : call))
  return validateAgentTurnCheckpoint({
    version: CHECKPOINT_VERSION_V2,
    attempt: checkpoint.attempt,
    completedSteps: checkpoint.completedSteps,
    pendingStep: { step: checkpoint.pendingStep.step, calls },
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
  const calls = normalizeCalls(input?.calls, 'Checkpoint completed 步骤', previousIds, true, checkpoint.version)
  if (!checkpoint.pendingStep) {
    const latest = checkpoint.completedSteps.at(-1)
    if (latest && canonicalHash(latest.calls) === canonicalHash(calls)) return checkpoint
    invalid('Checkpoint 没有可完成的 pending 步骤。', 'AGENT_TURN_CHECKPOINT_MISMATCH')
  }
  if (canonicalHash(checkpoint.pendingStep.calls.map(journalCallIdentity)) !== canonicalHash(calls.map(journalCallIdentity))) {
    invalid('Checkpoint completed 调用与 prepared 调用不一致。', 'AGENT_TURN_CHECKPOINT_MISMATCH')
  }
  // journal call 的终态必须在收束前提交:completed 步骤不允许仍处 prepared/dispatched 的 call。
  for (const call of calls) {
    if (call.recovery === 'journal' && (call.phase === undefined || ['prepared', 'dispatched'].includes(call.phase))) {
      invalid('journal call 尚未收束，不能完成该步骤。', 'AGENT_TURN_CHECKPOINT_MISMATCH')
    }
  }
  return validateAgentTurnCheckpoint({
    version: checkpoint.version,
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
  const content = text(input?.content, 'Terminal Checkpoint 内容', AGENT_TURN_TERMINAL_CONTENT_LIMIT)
  if (checkpoint.pendingStep) invalid('Pending 工具步骤尚未完成，不能写入终态内容。')
  if (!Number.isInteger(input?.step) || input.step !== checkpoint.completedSteps.length || input.step > MAX_STEPS) {
    invalid('Terminal Checkpoint 步骤与已完成游标不匹配。')
  }
  if (checkpoint.terminalContent !== undefined) {
    if (checkpoint.terminalContent === content) return checkpoint
    invalid('Checkpoint 已有不同的终态内容。', 'AGENT_TURN_CHECKPOINT_MISMATCH')
  }
  return validateAgentTurnCheckpoint({
    // 保留既有版本:V2 checkpoint 带 journal call,降级到 V1 会让终态校验拒绝自己。
    version: checkpoint.version,
    attempt: currentAttempt,
    completedSteps: checkpoint.completedSteps,
    terminalContent: content,
  })
}

/** @param {unknown} checkpoint */
export function agentTurnCheckpointHash(checkpoint) {
  return canonicalHash(validateAgentTurnCheckpoint(checkpoint))
}
