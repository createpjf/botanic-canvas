import { agentToolCallSummary, appendAgentReasoning, extractProviderReasoning } from '../semantic/botanicAgentReasoning.mjs'
import { presentationWebSources } from './agentWebResearch.mjs'
import {
  AGENT_TURN_TERMINAL_CONTENT_LIMIT,
  completeAgentTurnCheckpoint,
  agentTurnCheckpointStructuredSourceUrls,
  sanitizeAgentTurnCheckpointResultEnvelope,
  journalAgentTurnCheckpointCall,
  prepareAgentTurnCheckpoint,
  terminalAgentTurnCheckpoint,
  validateAgentTurnCheckpoint,
} from '../turn/agentTurnCheckpoint.mjs'
import { assertPublicHttpsUrl } from '../../providers/webEgressGuard.mjs'
import { canonicalHash } from '../../canonicalHash.mjs'
import { estimateAgentContextTokens, truncateAgentContextText } from '../context/agentContextBudget.mjs'
import { extractAgentEntityReferences, mergeAgentEntityReferences } from '../../agentEntityReferences.mjs'
import { normalizeProviderUsage } from '../semantic/botanicAgentStream.mjs'
import { withBotanicSpan } from '../../observability/executionTelemetry.mjs'
import { normalizeAgentToolCallId } from './agentToolCallIdentity.mjs'
import { AGENT_SEMANTIC_EVENT_NAMES, writeAgentSemanticEvent } from '../../observability/agentSemanticEvent.mjs'

const TOOL_NAME = /^[a-z][a-z0-9_]{1,63}$/
const TOOL_RECOVERY_MODES = new Set(['reexecute', 'receipt', 'never', 'journal'])
const MODEL_TOOL_CALL_LIMIT = 16
const MODEL_TOOL_CALL_TOTAL_LIMIT = 64
/** 连续相同工具签名达到此次数时发时间线警告；再打到终止阈值则停手。 */

import {
  AgentToolRuntimeError,
  createAgentToolNoProgressDetector,
  createToolOutputBudget,
  classifyAgentToolFailure,
  deepFreeze,
  isRecoverableToolFailure,
  isTerminalKnownToolFailure,
  knownPreEffectFailure,
  parseArguments,
  parseArgumentsSafe,
  safePresentationLabel,
  safeReportedToolPresentation,
  stableToolOutput,
  terminalModelContent,
  toolEventPresentation,
  withReasonParameter,
  withoutReason,
} from './agentToolOutput.mjs'

// 输出整形/展示投影/失败分类已拆至 agentToolOutput.mjs;re-export 兼容既有消费者。
export {
  AGENT_TOOL_NO_PROGRESS_WARNING,
  AGENT_TOOL_NO_PROGRESS_TERMINATE,
  AGENT_TOOL_OUTPUT_TOKEN_BUDGET,
  AGENT_TOOL_OUTPUT_TOTAL_TOKEN_BUDGET,
  AgentToolRuntimeError,
  agentToolObject,
  agentToolText,
  classifyAgentToolFailure,
  createAgentToolNoProgressDetector,
  toolEventPresentation,
} from './agentToolOutput.mjs'

export function createAgentToolRegistry(definitions) {
  const tools = new Map()
  for (const definition of definitions) {
    if (!definition || !TOOL_NAME.test(definition.name) || tools.has(definition.name)) {
      throw new TypeError('Agent 工具名称无效或重复。')
    }
    if (typeof definition.execute !== 'function' || typeof definition.validate !== 'function') {
      throw new TypeError(`Agent 工具 ${definition.name} 缺少校验器或执行器。`)
    }
    const risk = definition.risk ?? 'read'
    const recovery = definition.recovery ?? (risk === 'read' ? 'reexecute' : 'never')
    if (!TOOL_RECOVERY_MODES.has(recovery)) {
      throw new TypeError(`Agent 工具 ${definition.name} 的 recovery 模式无效。`)
    }
    if (definition.receipt !== undefined && typeof definition.receipt !== 'function') {
      throw new TypeError(`Agent 工具 ${definition.name} 的 receipt 身份解析器无效。`)
    }
    // 模型能看到的 schema 也是执行能力的一部分。只浅冻 definition 会让调用方在
    // Turn 开始后改写 parameters，造成模型快照与实际校验器漂移。
    const parameters = deepFreeze(structuredClone(definition.parameters))
    tools.set(definition.name, Object.freeze({
      ...definition,
      parameters,
      risk,
      recovery,
      requiresConfirmation: Boolean(definition.requiresConfirmation),
      terminal: Boolean(definition.terminal),
    }))
  }

  const capabilitySnapshot = Object.freeze([...tools.values()].map((tool) => Object.freeze({
    name: tool.name,
    risk: tool.risk,
    recovery: tool.recovery,
    requiresConfirmation: tool.requiresConfirmation,
    terminal: tool.terminal,
    // 不把整段 description/schema 塞进 Turn；哈希仍把模型实际看到的定义全部绑定。
    contentHash: canonicalHash({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
      risk: tool.risk,
      recovery: tool.recovery,
      requiresConfirmation: tool.requiresConfirmation,
      terminal: tool.terminal,
    }),
  })))

  return Object.freeze({
    openAITools() {
      return [...tools.values()].map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: withReasonParameter(tool.parameters),
        },
      }))
    },
    get(name) {
      return tools.get(name)
    },
    /** 已注册工具名。执行快照据此定格「这一次能用哪些工具」。 */
    names() {
      return [...tools.keys()]
    },
    capabilitySnapshot() {
      return capabilitySnapshot
    },
    async execute(name, rawArguments, context) {
      const tool = tools.get(name)
      if (!tool) throw knownPreEffectFailure(new AgentToolRuntimeError('TOOL_NOT_ALLOWED', `Agent 无权调用工具：${name}。`, 403))
      let input
      try {
        input = tool.validate(withoutReason(rawArguments), context)
      } catch (caught) {
        throw knownPreEffectFailure(caught)
      }
      return tool.execute(input, context)
    },
  })
}

export async function executeConfirmedAgentAction({
  registry,
  name,
  arguments: argumentsValue,
  toolCallId,
  confirmed,
  context,
}) {
  const tool = registry?.get?.(name)
  if (!tool) throw knownPreEffectFailure(new AgentToolRuntimeError('TOOL_NOT_ALLOWED', `Agent 无权调用工具：${name ?? 'unknown'}。`, 403))
  const id = typeof toolCallId === 'string' && toolCallId.trim() ? toolCallId.trim() : undefined
  if (!id) throw knownPreEffectFailure(new AgentToolRuntimeError('INVALID_TOOL_CALL_ID', '工具调用标识无效。'))
  if (tool.requiresConfirmation && confirmed !== true) {
    throw knownPreEffectFailure(new AgentToolRuntimeError('TOOL_CONFIRMATION_REQUIRED', `${tool.label}需要用户确认。`, 409))
  }
  const output = await registry.execute(name, argumentsValue, {
    ...context,
    toolCallId: id,
    approvedToolCallIds: new Set([...(context?.approvedToolCallIds ?? []), id]),
  })
  const summary = agentToolCallSummary(argumentsValue)
  const entityReferences = extractAgentEntityReferences(name, output)
  return {
    output,
    ...(entityReferences.length ? { entityReferences: structuredClone(entityReferences) } : {}),
    toolCall: {
      id,
      name,
      label: tool.label,
      risk: tool.risk,
      status: 'succeeded',
      requiresConfirmation: tool.requiresConfirmation,
      ...(summary ? { summary } : {}),
      ...(entityReferences.length ? { entityReferences: structuredClone(entityReferences) } : {}),
    },
  }
}

/**
 * 冻结一次执行的能力快照（Epic 8）。
 *
 * 工具集在**进入循环前**取一次并全程复用：中途重建注册表或改配置都不该改变已经开始
 * 的这一次执行 —— 模型在第 1 步看到的工具与第 3 步能调用的工具必须是同一套，否则
 * 它会按一份已经不存在的能力清单做计划。
 *
 * 快照本身深拷贝并冻结：调用方之后修改自己的对象也影响不到它。
 */
export function freezeAgentStepSnapshot({ registry, model, skillBindings, memoryBindings, contextPolicyHash, role } = {}) {
  return Object.freeze({
    model: model ?? undefined,
    toolNames: Object.freeze((registry?.names?.() ?? []).slice()),
    toolBindings: registry?.capabilitySnapshot?.() ?? Object.freeze([]),
    skillBindings: Object.freeze((skillBindings ?? []).map((binding) => Object.freeze({
      id: binding?.id, version: binding?.version, contentHash: binding?.contentHash,
    }))),
    memoryBindings: Object.freeze((memoryBindings ?? []).map((binding) => Object.freeze({
      id: binding?.id, version: binding?.version, contentHash: binding?.contentHash,
    }))),
    ...(contextPolicyHash === undefined ? {} : { contextPolicyHash }),
    role: role ?? undefined,
  })
}

export async function runAgentToolLoop({
  registry,
  messages,
  callModel,
  toolChoice = 'auto',
  maximumSteps = 4,
  maximumToolCalls = MODEL_TOOL_CALL_TOTAL_LIMIT,
  context,
  allowRawReasoning = false,
  onEvent,
  snapshot,
  attempt,
  resumeCheckpoint,
  saveCheckpoint,
  recoverToolCall,
  recoverJournalResult,
  checkpointUrlLookup = /** @type {((hostname: string) => Promise<string[]>) | undefined} */ (undefined),
  modelContext = undefined,
  maxOutputTokens = undefined,
  trigger = 'pre_step',
  genAiTelemetry = false,
  signal = /** @type {AbortSignal | undefined} */ (undefined),
  deadlineAt = /** @type {number | undefined} */ (undefined),
}) {
  if (!Number.isInteger(maximumToolCalls) || maximumToolCalls < 1 || maximumToolCalls > MODEL_TOOL_CALL_TOTAL_LIMIT) {
    throw new TypeError(`Agent 工具调用上限必须是 1 到 ${MODEL_TOOL_CALL_TOTAL_LIMIT} 之间的整数。`)
  }
  if (modelContext !== undefined && (
    !modelContext
    || typeof modelContext.prepare !== 'function'
    || typeof modelContext.observe !== 'function'
  )) {
    throw new TypeError('Agent Model Context 必须实现 prepare 与 observe。')
  }
  const conversation = [...messages]
  // 冻结的取消/期限边界（H2）：根 signal 与 Turn deadline 贯穿模型调用、preflight、
  // 每个 tool.execute 与写终态。取消在派发前发现时是 terminal-known，不是 Provider 错。
  const assertExecutionAlive = () => {
    if (signal?.aborted) {
      throw knownPreEffectFailure(new AgentToolRuntimeError('REQUEST_CANCELLED', 'Agent 请求已取消。', 499))
    }
    if (typeof deadlineAt === 'number' && Date.now() >= deadlineAt) {
      throw knownPreEffectFailure(new AgentToolRuntimeError('AGENT_TURN_DEADLINE_EXCEEDED', 'Agent Turn 已超过本轮时限。', 504))
    }
  }
  const withinExecutionBoundary = async (operation) => {
    assertExecutionAlive()
    const deadlineController = typeof deadlineAt === 'number' ? new AbortController() : undefined
    const deadlineTimer = deadlineController
      ? setTimeout(() => deadlineController.abort(), Math.max(1, deadlineAt - Date.now()))
      : undefined
    const signals = [signal, deadlineController?.signal].filter(Boolean)
    const activeSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]
    let onAbort
    const aborted = activeSignal && new Promise((_, reject) => {
      onAbort = () => reject(signal?.aborted
        ? new AgentToolRuntimeError('REQUEST_CANCELLED', 'Agent 请求已取消。', 499)
        : new AgentToolRuntimeError('AGENT_TURN_DEADLINE_EXCEEDED', 'Agent Turn 已超过本轮时限。', 504))
      if (activeSignal.aborted) onAbort()
      else activeSignal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      const pending = Promise.resolve().then(() => operation(activeSignal))
      const result = await (aborted ? Promise.race([pending, aborted]) : pending)
      assertExecutionAlive()
      return result
    } catch (caught) {
      if (signal?.aborted) throw new AgentToolRuntimeError('REQUEST_CANCELLED', 'Agent 请求已取消。', 499)
      if (deadlineController?.signal.aborted || (typeof deadlineAt === 'number' && Date.now() >= deadlineAt)) {
        throw new AgentToolRuntimeError('AGENT_TURN_DEADLINE_EXCEEDED', 'Agent Turn 已超过本轮时限。', 504)
      }
      throw caught
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer)
      if (onAbort) activeSignal.removeEventListener('abort', onAbort)
    }
  }
  assertExecutionAlive()
  // 工具定义在循环开始前定格一次，之后每一步都用同一份。
  const frozenTools = registry.openAITools()
  const frozenSnapshot = snapshot ?? freezeAgentStepSnapshot({ registry })
  const invokeModel = (request) => withinExecutionBoundary((activeSignal) => withBotanicSpan(
    genAiTelemetry ? `chat ${frozenSnapshot.model ?? 'unknown-model'}` : 'botanic.provider.request',
    {
      kind: 'client',
      attributes: {
        ...(genAiTelemetry ? {
          'gen_ai.operation.name': 'chat',
          'gen_ai.provider.name': 'flock',
          'gen_ai.request.model': frozenSnapshot.model,
        } : {}),
        'botanic.component': 'worker',
        'botanic.phase': 'provider',
      },
    },
    async (span) => {
      const response = await callModel(request, { signal: activeSignal, deadlineAt })
      if (genAiTelemetry && span) {
        try {
          const usage = normalizeProviderUsage(response?.usage)
          if (Number.isSafeInteger(usage?.inputTokens)) span.setAttribute('gen_ai.usage.input_tokens', usage.inputTokens)
          if (Number.isSafeInteger(usage?.outputTokens)) span.setAttribute('gen_ai.usage.output_tokens', usage.outputTokens)
        } catch { /* usage telemetry 不得改变 Provider 结果 */ }
      }
      return response
    },
  ))
  const steps = []
  const toolCalls = []
  let reasoning = []
  const checkpointing = resumeCheckpoint !== undefined || typeof saveCheckpoint === 'function'
  if (resumeCheckpoint !== undefined && typeof saveCheckpoint !== 'function') {
    throw new TypeError('Agent Turn 恢复缺少 saveCheckpoint。')
  }
  if (checkpointing && (!attempt || typeof attempt !== 'object')) {
    throw new TypeError('Agent Turn Checkpoint 缺少 attempt。')
  }
  let checkpoint = resumeCheckpoint === undefined
    ? undefined
    : validateAgentTurnCheckpoint(resumeCheckpoint)
  if (checkpoint && (
    checkpoint.attempt.id !== attempt?.id
    || checkpoint.attempt.model !== attempt?.model
    || checkpoint.attempt.snapshotHash !== attempt?.snapshotHash
  )) {
    throw new AgentToolRuntimeError(
      'AGENT_TURN_CHECKPOINT_SNAPSHOT_MISMATCH',
      'Agent Turn Checkpoint 的执行尝试或能力快照已变更。',
      409,
    )
  }
  // Checkpoint 里的调用同样已经消费预算。恢复时如果只从本进程新产生的
  // `toolCalls` 开始计数，重启一次就能把同一轮的额度清零。
  let plannedToolCallCount = (checkpoint?.completedSteps ?? [])
    .reduce((sum, completedStep) => sum + completedStep.calls.length, 0)
    + (checkpoint?.pendingStep?.calls.length ?? 0)
  if (plannedToolCallCount > maximumToolCalls) {
    throw knownPreEffectFailure(new AgentToolRuntimeError(
      'TOOL_CALL_LIMIT_REACHED',
      'Agent 工具调用已超过本轮预算，已在恢复执行前停止。',
    ))
  }
  let entityReferences = mergeAgentEntityReferences(
    ...(checkpoint?.completedSteps ?? []).flatMap((completedStep) => (
      completedStep.calls.map((call) => call.entityReferences ?? [])
    )),
  )
  const emit = (event) => {
    if (typeof onEvent !== 'function') return
    try { onEvent(event) } catch { /* 展示层异常不得中断工具循环。 */ }
  }
  // Harness 语义事件（H7）:低基数旁路,fail-open;label 不含用户文本/URL/Skill ID/参数。
  const emitHarness = (kind, outcome, extra = {}) => {
    writeAgentSemanticEvent(AGENT_SEMANTIC_EVENT_NAMES.HARNESS_LIFECYCLE, { kind, outcome, ...extra })
  }
  // 无进展检测只覆盖本 attempt 新执行的工具；恢复历史步骤不计入。
  const noProgress = createAgentToolNoProgressDetector()
  // duplicate_dispatch guard（H7 0B）:本次 loop 执行内已到达派发边界的 journal call id。
  const dispatchedJournalCallIds = new Set()

  const persistCheckpoint = async (next) => {
    if (!checkpointing) return
    await withinExecutionBoundary(() => saveCheckpoint(next))
    checkpoint = next
  }

  // 输出预算整形已拆至 agentToolOutput.mjs 的 createToolOutputBudget（H6G 规则 4 seam）。
  const outputBudget = createToolOutputBudget(conversation)
  const prepareToolOutput = (entry, output) => outputBudget.prepare(entry, output)
  const appendPreparedToolOutput = (entry, bounded) => outputBudget.append(entry, bounded)
  const appendToolOutput = (entry, output) => outputBudget.appendOutput(entry, output)

  const traceFor = (tool, call, step, index, rawArguments) => {
    const summary = rawArguments ? agentToolCallSummary(rawArguments) : undefined
    const rawId = typeof call?.id === 'string' && call.id ? call.id : `tool-call-${step + 1}-${index + 1}`
    const resolvedId = normalizeAgentToolCallId(rawId)
    return {
      id: resolvedId,
      name: tool.name,
      label: tool.label,
      risk: tool.risk,
      status: 'succeeded',
      requiresConfirmation: tool.requiresConfirmation,
      ...(summary ? { summary } : {}),
    }
  }

  const receiptIdentity = (tool, call, trace, rawArguments) => {
    let identity
    if (typeof tool.receipt === 'function') {
      try {
        identity = tool.receipt({
          id: trace.id,
          name: trace.name,
          arguments: structuredClone(rawArguments),
          context,
        })
      } catch (caught) {
        throw knownPreEffectFailure(caught)
      }
      // receipt 解析只能是纯同步身份计算；Promise 可能已启动 I/O，
      // 不能在 checkpoint 边界前接受它。
      if (identity && typeof identity.then === 'function') {
        throw knownPreEffectFailure(new AgentToolRuntimeError(
          'AGENT_TURN_CHECKPOINT_RECEIPT_REQUIRED',
          `${tool.label}的回执身份必须在执行前同步确定。`,
          409,
        ))
      }
    } else if (typeof call?.receiptId === 'string' && typeof call?.intentHash === 'string') {
      // 仅供旧的服务端 tool-call envelope 迁移；新工具必须用 definition.receipt
      // 从服务端事实派生，不应让 Provider 决定回执归属。
      identity = { receiptId: call.receiptId, intentHash: call.intentHash }
    }
    const receiptId = typeof identity?.receiptId === 'string' ? identity.receiptId.trim() : ''
    const intentHash = typeof identity?.intentHash === 'string' ? identity.intentHash.trim() : ''
    if (!receiptId || !intentHash) {
      throw knownPreEffectFailure(new AgentToolRuntimeError(
        'AGENT_TURN_CHECKPOINT_RECEIPT_REQUIRED',
        `${tool.label}无法在执行前确定可信回执身份，已拒绝执行。`,
        409,
      ))
    }
    return { receiptId, intentHash }
  }

  const preflightModelCall = (call, step, index) => {
    const name = call?.function?.name
    const tool = registry.get(name)
    if (!tool) throw knownPreEffectFailure(new AgentToolRuntimeError('TOOL_NOT_ALLOWED', `Agent 无权调用工具：${name ?? 'unknown'}。`, 403))
    const rawArguments = parseArguments(call?.function?.arguments)
    const trace = traceFor(tool, call, step, index, rawArguments)
    if (tool.requiresConfirmation && !context?.approvedToolCallIds?.has(trace.id)) {
      throw knownPreEffectFailure(new AgentToolRuntimeError('TOOL_CONFIRMATION_REQUIRED', `${tool.label}需要用户确认。`, 409))
    }
    let validatedInput
    try {
      validatedInput = tool.validate(withoutReason(rawArguments), { ...context, toolCallId: trace.id })
    } catch (caught) {
      throw knownPreEffectFailure(caught)
    }
    const descriptor = {
      id: trace.id,
      name,
      risk: tool.risk,
      recovery: tool.recovery,
      terminal: tool.terminal,
      ...(tool.recovery === 'reexecute' || tool.recovery === 'journal' ? { arguments: structuredClone(rawArguments) } : {}),
      ...(tool.recovery === 'receipt' ? receiptIdentity(tool, call, trace, rawArguments) : {}),
      ...(tool.recovery === 'journal' ? { phase: 'prepared' } : {}),
    }
    return { call, tool, rawArguments, validatedInput, trace, descriptor }
  }

  // 整批 preflight（H4）：逐 call 收集结果而不是第一处失败即抛。任一 call 无效时,
  // 本批全部无副作用;terminal-known 立即终止,repairable 给每个原 call id 配对结果,
  // 同一规范化批签名最多一次模型 repair。
  const preflightRepairSignatures = new Set()
  const preflightModelCalls = (calls, step) => {
    const outcomes = calls.map((call, index) => {
      try {
        return { entry: preflightModelCall(call, step, index) }
      } catch (caught) {
        return { error: caught, call, index }
      }
    })
    const failures = outcomes.filter((outcome) => outcome.error)
    if (!failures.length) return { entries: outcomes.map((outcome) => outcome.entry) }
    const terminal = failures.find((outcome) => classifyAgentToolFailure(outcome.error, { phase: 'preflight' }) === 'terminal-known')
    if (terminal) throw terminal.error
    const signature = canonicalHash(calls.map((call) => ({
      name: call?.function?.name ?? '',
      arguments: withoutReason(parseArgumentsSafe(call?.function?.arguments)) ?? null,
    })))
    if (preflightRepairSignatures.has(signature)) throw failures[0].error
    preflightRepairSignatures.add(signature)
    writeAgentSemanticEvent(AGENT_SEMANTIC_EVENT_NAMES.HARNESS_LIFECYCLE, { kind: 'tool', outcome: 'repair', step })
    return { repair: { outcomes, failures } }
  }

  const respondPreflightRepair = (calls, outcomes, step) => {
    // 无任何副作用发生。给每个原 call id 恰好一个结果:invalid call 返回具体失败,
    // 已通过 preflight 的 call 返回稳定 BATCH_PREFLIGHT_ABORTED。
    const callId = (call, index) => normalizeAgentToolCallId(
      typeof call?.id === 'string' && call.id ? call.id : `tool-call-${step + 1}-${index + 1}`,
    )
    conversation.push({
      role: 'assistant',
      tool_calls: calls.map((call, index) => ({
        id: callId(call, index),
        type: 'function',
        function: { name: call?.function?.name ?? 'unknown', arguments: typeof call?.function?.arguments === 'string' ? call.function.arguments : '{}' },
      })),
    })
    for (const [index, outcome] of outcomes.entries()) {
      const id = callId(calls[index], index)
      const name = calls[index]?.function?.name ?? 'unknown'
      const payload = outcome.error
        ? { ok: false, code: outcome.error.code ?? 'INVALID_TOOL_ARGUMENTS', error: outcome.error instanceof Error ? outcome.error.message : '工具调用无效。' }
        : { ok: false, code: 'BATCH_PREFLIGHT_ABORTED', error: '同批存在无效调用,本批全部未执行。' }
      conversation.push({ role: 'tool', tool_call_id: id, name, content: JSON.stringify(payload) })
      const failedTrace = {
        id, name, label: outcome.entry?.tool?.label ?? name, risk: outcome.entry?.tool?.risk ?? 'read',
        status: 'failed', requiresConfirmation: Boolean(outcome.entry?.tool?.requiresConfirmation),
        error: payload.error,
      }
      toolCalls.push(failedTrace)
      emit({ type: 'tool', step, toolCall: failedTrace })
    }
  }

  const assertRecoverableStep = (stepCheckpoint) => {
    for (const call of stepCheckpoint.calls) {
      const tool = registry.get(call.name)
      if (!tool || tool.recovery !== call.recovery || tool.risk !== call.risk || tool.terminal !== call.terminal) {
        throw new AgentToolRuntimeError(
          'AGENT_TURN_CHECKPOINT_SNAPSHOT_MISMATCH',
          `Agent 工具 ${call.name} 的恢复能力已变更。`,
          409,
        )
      }
      if (call.recovery === 'never') {
        throw new AgentToolRuntimeError(
          'AGENT_TURN_NOT_REPLAYABLE',
          `Agent 工具 ${call.name} 不允许在中断后重放。`,
          409,
        )
      }
      if (call.recovery === 'receipt' && typeof recoverToolCall !== 'function') {
        throw new AgentToolRuntimeError(
          'AGENT_TURN_NOT_REPLAYABLE',
          `Agent 工具 ${call.name} 缺少回执恢复能力。`,
          409,
        )
      }
      if (call.recovery === 'journal' && call.phase === 'completed' && call.resultRef && typeof recoverJournalResult !== 'function') {
        throw new AgentToolRuntimeError(
          'AGENT_TURN_NOT_REPLAYABLE',
          `Agent 工具 ${call.name} 缺少结果引用恢复能力。`,
          409,
        )
      }
    }
  }

  const recoveryEntries = (stepCheckpoint, referencesFromCheckpoint = false) => {
    // 先检查整步的能力；不能先重执行前面的 read，才发现后面有 never。
    assertRecoverableStep(stepCheckpoint)
    return stepCheckpoint.calls.map((call, index) => {
      const tool = registry.get(call.name)
      // journal（H6B）：durable lifecycle 决定恢复方式,不用进程内记忆猜测。
      // - completed:直接复用安全 envelope,不联网、不重新扣配额;
      // - prepared:有证据未 dispatch,允许按参数重执行;
      // - dispatched/unknown:已派发无可靠结果,禁止自动重放。
      if (call.recovery === 'journal') {
        if (call.phase === 'completed' && typeof call.resultEnvelope === 'string') {
          const trace = traceFor(tool, { id: call.id }, stepCheckpoint.step, index, call.arguments)
          return { tool, rawArguments: call.arguments, trace, descriptor: call, recovering: true, referencesFromCheckpoint, reuseEnvelope: call.resultEnvelope }
        }
        if (call.phase === 'completed' && call.resultRef) {
          const trace = traceFor(tool, { id: call.id }, stepCheckpoint.step, index, call.arguments)
          return { tool, rawArguments: call.arguments, trace, descriptor: call, recovering: true, referencesFromCheckpoint, recoverResultRef: true }
        }
        if (call.phase === 'failed' || call.phase === 'aborted') {
          const trace = traceFor(tool, { id: call.id }, stepCheckpoint.step, index, call.arguments)
          const aborted = call.phase === 'aborted'
          return {
            tool, rawArguments: call.arguments, trace, descriptor: call, recovering: true, referencesFromCheckpoint,
            reuseEnvelope: JSON.stringify({ ok: false, code: aborted ? 'AGENT_TOOL_ABORTED' : 'AGENT_TOOL_FAILED', error: aborted ? '工具调用已中止。' : '工具执行失败。' }),
            reuseStatus: call.phase,
          }
        }
        if (call.phase === undefined || call.phase === 'prepared') {
          const rawArguments = structuredClone(call.arguments)
          const trace = traceFor(tool, { id: call.id }, stepCheckpoint.step, index, rawArguments)
          let validatedInput
          try {
            validatedInput = tool.validate(withoutReason(rawArguments), { ...context, toolCallId: call.id })
          } catch (caught) {
            throw knownPreEffectFailure(caught)
          }
          return { tool, rawArguments, validatedInput, trace, descriptor: call, recovering: true, referencesFromCheckpoint }
        }
        writeAgentSemanticEvent(AGENT_SEMANTIC_EVENT_NAMES.HARNESS_LIFECYCLE, { kind: 'recovery', outcome: 'unknown' })
        throw new AgentToolRuntimeError(
          'AGENT_TOOL_OUTCOME_UNKNOWN',
          `Agent 工具 ${call.name} 已派发但结果未知，系统不会自动重放。`,
          409,
        )
      }
      const rawArguments = call.recovery === 'reexecute' ? structuredClone(call.arguments) : undefined
      const trace = traceFor(tool, { id: call.id }, stepCheckpoint.step, index, rawArguments)
      let validatedInput
      if (call.recovery === 'reexecute') {
        try {
          validatedInput = tool.validate(withoutReason(rawArguments), { ...context, toolCallId: call.id })
        } catch (caught) {
          throw knownPreEffectFailure(caught)
        }
        writeAgentSemanticEvent(AGENT_SEMANTIC_EVENT_NAMES.HARNESS_LIFECYCLE, { kind: 'recovery', outcome: 'reexecuted' })
      }
      return {
        tool, rawArguments, validatedInput, trace, descriptor: call, recovering: true,
        referencesFromCheckpoint,
      }
    })
  }

  const assistantCalls = (entries) => entries.map((entry) => ({
    id: entry.trace.id,
    type: 'function',
    function: {
      name: entry.trace.name,
      arguments: entry.rawArguments ? JSON.stringify(entry.rawArguments) : '{}',
    },
  }))

  const noteToolProgress = (entry, output, { isError, emitEvents }) => {
    if (!emitEvents) return
    const progress = noProgress.record({
      name: entry.trace.name,
      arguments: entry.rawArguments,
      output,
      isError,
    })
    if (progress.status === 'warning') {
      emit({
        type: 'tool',
        step: entry.progressStep,
        toolCall: {
          id: entry.trace.id,
          name: entry.trace.name,
          label: entry.trace.label,
          risk: entry.trace.risk,
          status: isError ? 'failed' : 'succeeded',
          requiresConfirmation: entry.trace.requiresConfirmation,
          summary: `连续 ${progress.repeatCount} 次相同结果，疑似原地打转`,
        },
        presentation: { kind: 'no_progress', title: '工具在原地打转' },
      })
    }
    if (progress.status === 'terminate') {
      emitHarness('loop', 'loop_stop', { reason: 'TOOL_NO_PROGRESS' })
      throw new AgentToolRuntimeError(
        'TOOL_NO_PROGRESS',
        `工具 ${entry.trace.label} 连续 ${progress.repeatCount} 次返回相同结果，已停止执行。`,
      )
    }
  }

  const executeStep = async (entries, step, { emitEvents = true } = {}) => {
    conversation.push({ role: 'assistant', tool_calls: assistantCalls(entries) })
    let terminalOutput
    let terminalSucceeded = false
    for (const entry of entries) {
      // 下一个 call 启动前的取消边界：第一项运行中取消后，第二项不得启动。
      assertExecutionAlive()
      const { tool, trace } = entry
      entry.completedDescriptor = entry.descriptor
      entry.progressStep = step
      const summary = entry.rawArguments ? agentToolCallSummary(entry.rawArguments) : undefined
      reasoning = appendAgentReasoning(reasoning, { step, source: 'summary', text: summary })
      const runningPresentation = toolEventPresentation(trace.name)
      if (emitEvents) {
        emit({
          type: 'tool', step, toolCall: { ...trace, status: 'running' },
          ...(runningPresentation ? { presentation: runningPresentation } : {}),
        })
      }
      if (signal?.aborted) emitHarness('cancel', 'started_after_cancel', { step })
      emitHarness('tool', 'started', { step })
      // journal completed 恢复:复用 durable envelope,不再执行工具、不重新扣配额。
      if (entry.reuseEnvelope !== undefined) {
        // DNS 级复检只针对结构化来源 URL（结果的 `url` 字段）。正文自由文本里的
        // 链接不是出口目标——恢复不会抓取它们,一条死链不该让已成功的结果失效。
        for (const url of agentTurnCheckpointStructuredSourceUrls(entry.reuseEnvelope)) {
          const classified = await withinExecutionBoundary(() => assertPublicHttpsUrl(
            url,
            checkpointUrlLookup ? { lookup: checkpointUrlLookup } : {},
          ))
          if (!classified.ok) {
            throw new AgentToolRuntimeError('AGENT_TURN_CHECKPOINT_INVALID', classified.message, 409)
          }
        }
        const reused = { ...trace, status: entry.reuseStatus ?? 'succeeded' }
        toolCalls.push(reused)
        emitHarness('recovery', 'reused', { step })
        appendPreparedToolOutput(entry, {
          content: entry.reuseEnvelope,
          tokens: estimateAgentContextTokens(entry.reuseEnvelope),
          compact: false,
          serialized: entry.reuseEnvelope,
        })
        if (emitEvents) emit({
          type: 'tool', step, toolCall: reused,
          ...(runningPresentation ? { presentation: runningPresentation } : {}),
        })
        continue
      }
      if (entry.recoverResultRef) {
        const output = await withinExecutionBoundary(() => recoverJournalResult({
          step,
          resultRef: structuredClone(entry.descriptor.resultRef),
          toolCall: structuredClone(entry.descriptor),
          context,
        }))
        const recovered = { ...trace, status: 'succeeded' }
        toolCalls.push(recovered)
        appendToolOutput(entry, output)
        const recoveredPresentation = toolEventPresentation(trace.name, output)
        if (emitEvents) emit({
          type: 'tool', step, toolCall: recovered,
          ...(recoveredPresentation ? { presentation: recoveredPresentation } : {}),
        })
        continue
      }
      // journal（H6B）:请求交给 client 前先 durable 写 dispatched;此后不能再假设「没执行」。
      if (entry.descriptor.recovery === 'journal') {
        // duplicate_dispatch guard（H7 0B）:同一 call id 在本次执行内第二次到达派发
        // 边界说明恢复/编排出错。先 emit 零容忍事件再具名失败,绝不二次外呼。
        if (dispatchedJournalCallIds.has(trace.id)) {
          emitHarness('recovery', 'duplicate_dispatch', { step, reason: 'AGENT_TOOL_DUPLICATE_DISPATCH' })
          throw new AgentToolRuntimeError(
            'AGENT_TOOL_DUPLICATE_DISPATCH',
            `Agent 工具 ${trace.name} 的同一调用被重复派发，已停止执行。`,
            409,
          )
        }
        dispatchedJournalCallIds.add(trace.id)
      }
      if (checkpointing && entry.descriptor.recovery === 'journal' && !entry.recovering) {
        await persistCheckpoint(journalAgentTurnCheckpointCall(checkpoint, { callId: trace.id, phase: 'dispatched' }))
      }
      let output
      try {
        output = await withinExecutionBoundary((activeSignal) => withBotanicSpan(`execute_tool ${trace.name}`, {
          kind: 'internal',
          attributes: {
            ...(genAiTelemetry ? {
              'gen_ai.operation.name': 'execute_tool',
              'gen_ai.tool.name': trace.name,
            } : {}),
            'botanic.component': 'worker',
            'botanic.phase': 'tool',
            'botanic.tool_call.id': trace.id,
          },
        }, async () => {
          if (entry.recovering && entry.descriptor.recovery === 'receipt') {
            return recoverToolCall({
              step,
              toolCall: structuredClone(entry.descriptor),
              context,
            })
          }
          return tool.execute(entry.validatedInput, {
            ...context,
            toolCallId: trace.id,
            // 同一call id的安全进度投影;只更新UI/Turn Event,不进入模型tool output。
            reportProgress: emitEvents ? (progress = {}) => {
              const progressSummary = safePresentationLabel(progress.summary)
              const presentation = safeReportedToolPresentation(progress.presentation)
              emit({
                type: 'tool', step,
                toolCall: { ...trace, status: 'running', ...(progressSummary ? { summary: progressSummary } : {}) },
                ...(presentation ? { presentation } : {}),
              })
            } : undefined,
            // 根 signal 直达工具；子任务等自带 timeout 的 context 已在各自 seam 组合过。
            ...(activeSignal ? { signal: activeSignal } : {}),
            ...(typeof deadlineAt === 'number' ? { deadlineAt } : {}),
          })
        }))
      } catch (caught) {
        // 根取消优先归因为取消：工具因中止抛出的任何错误（含自身 timeout）不再伪装成工具失败。
        // 该 call 已 dispatched，不标记 outcomeKnown —— 不能假设「取消 = 没执行」。
        const terminalFailure = signal?.aborted
          ? new AgentToolRuntimeError('REQUEST_CANCELLED', 'Agent 请求已取消。', 499)
          : (isRecoverableToolFailure(caught, tool) ? undefined : caught)
        if (terminalFailure) {
          // 整批 pairing（H4）:当前 call 按证据收口为 failed,尚未启动的 call 收口为
          // aborted + BATCH_NOT_STARTED;已 completed 的 call 不改写。
          const failedNow = { ...trace, status: 'failed', error: terminalFailure instanceof Error ? terminalFailure.message : '工具执行失败。' }
          toolCalls.push(failedNow)
          if (emitEvents) emit({ type: 'tool', step, toolCall: failedNow })
          const failureKind = classifyAgentToolFailure(terminalFailure, { phase: 'execute', tool })
          emitHarness('tool', failureKind === 'outcome-unknown' ? 'unknown' : 'failed', { step, reason: typeof terminalFailure?.code === 'string' ? terminalFailure.code : undefined })
          const startedIndex = entries.indexOf(entry)
          for (const notStarted of entries.slice(startedIndex + 1)) {
            const abortedTrace = { ...notStarted.trace, status: 'aborted', error: 'BATCH_NOT_STARTED' }
            toolCalls.push(abortedTrace)
            if (emitEvents) emit({ type: 'tool', step, toolCall: abortedTrace })
            emitHarness('tool', 'aborted', { step, reason: 'BATCH_NOT_STARTED' })
          }
          throw terminalFailure
        }
        const error = caught instanceof Error ? caught.message : '工具执行失败。'
        const failed = { ...trace, status: 'failed', error }
        if (emitEvents) {
          emit({
            type: 'tool', step, toolCall: failed,
            ...(runningPresentation ? { presentation: runningPresentation } : {}),
          })
        }
        const failedOutput = { ok: false, error, code: caught.code }
        toolCalls.push(failed)
        emitHarness('tool', 'failed', { step, reason: typeof caught?.code === 'string' ? caught.code : undefined })
        if (checkpointing && entry.descriptor.recovery === 'journal' && !entry.recovering) {
          // 已知失败也是终局:durable 记 failed,恢复不再重放这次调用。
          await persistCheckpoint(journalAgentTurnCheckpointCall(checkpoint, { callId: trace.id, phase: 'failed' }))
          entry.completedDescriptor = { ...entry.completedDescriptor, phase: 'failed' }
        }
        appendToolOutput(entry, failedOutput)
        noteToolProgress(entry, failedOutput, { isError: true, emitEvents })
        continue
      }
      const succeededPresentation = toolEventPresentation(trace.name, output)
      const outputEntityReferences = entry.referencesFromCheckpoint
        ? (entry.descriptor.entityReferences ?? [])
        : extractAgentEntityReferences(trace.name, output)
      entityReferences = mergeAgentEntityReferences(entityReferences, outputEntityReferences)
      const succeededTrace = outputEntityReferences.length
        ? { ...trace, entityReferences: structuredClone(outputEntityReferences) }
        : trace
      entry.completedDescriptor = outputEntityReferences.length
        ? { ...entry.descriptor, entityReferences: structuredClone(outputEntityReferences) }
        : entry.descriptor
      if (emitEvents) {
        emit({
          type: 'tool', step, toolCall: succeededTrace,
          ...(succeededPresentation ? { presentation: succeededPresentation } : {}),
        })
      }
      toolCalls.push(succeededTrace)
      emitHarness('tool', 'succeeded', { step })
      if (signal?.aborted) emitHarness('cancel', 'completed_after_cancel', { step })
      noteToolProgress(entry, output, { isError: false, emitEvents })
      if (tool.terminal) {
        terminalOutput = output
        terminalSucceeded = true
        continue
      }
      if (checkpointing && entry.descriptor.recovery === 'journal') {
        // H6G 规则 4:先按剩余预算生成最终 envelope,同一字符串先 durable 进 checkpoint,
        // commit 成功后才进入模型 history/下一次 sampling。
        // 规则 1 的「规范化脱敏」在写入侧完成:页面正文里的 http 链接、非公开 URL、
        // data: 字样是内容而不是出口目标,替换为占位符;校验器只作 backstop。
        const bounded = prepareToolOutput(entry, output)
        const sanitized = sanitizeAgentTurnCheckpointResultEnvelope(bounded.content)
        const boundedSafe = sanitized === bounded.content
          ? bounded
          : { ...bounded, content: sanitized, tokens: estimateAgentContextTokens(sanitized) }
        let journaled
        try {
          journaled = journalAgentTurnCheckpointCall(checkpoint, {
            callId: trace.id,
            phase: 'completed',
            resultEnvelope: boundedSafe.content,
          })
        } catch (caught) {
          if (typeof caught?.code !== 'string' || !caught.code.startsWith('AGENT_TURN_CHECKPOINT_')) throw caught
          // backstop 拒绝该结果:降级为 durable failed,绝不让 call 滞留在 dispatched
          // （那会把整轮卡死在 AGENT_TOOL_OUTCOME_UNKNOWN）。结果不进入模型,
          // 失败作为已知终局回给模型换个来源。
          await persistCheckpoint(journalAgentTurnCheckpointCall(checkpoint, { callId: trace.id, phase: 'failed' }))
          entry.completedDescriptor = { ...entry.completedDescriptor, phase: 'failed' }
          const error = '工具结果不符合持久化安全边界，已丢弃。'
          const failed = { ...trace, status: 'failed', error }
          toolCalls[toolCalls.length - 1] = failed
          if (emitEvents) emit({ type: 'tool', step, toolCall: failed })
          emitHarness('tool', 'failed', { step, reason: caught.code })
          appendToolOutput(entry, { ok: false, error, code: 'AGENT_TOOL_RESULT_REJECTED' })
          continue
        }
        await persistCheckpoint(journaled)
        entry.completedDescriptor = {
          ...entry.completedDescriptor,
          phase: 'completed',
          resultEnvelope: boundedSafe.content,
        }
        appendPreparedToolOutput(entry, boundedSafe)
        continue
      }
      appendToolOutput(entry, output)
    }
    return {
      terminalOutput,
      terminalSucceeded,
      completedCalls: entries.map((entry) => entry.completedDescriptor),
    }
  }

  // 无工具最终回答已成为私有终态 Checkpoint；无需为返回它重建早前的
  // 工具输出，更不能再调模型。
  if (checkpoint?.terminalContent !== undefined) {
    return {
      output: checkpoint.terminalContent,
      toolCalls,
      entityReferences: structuredClone(entityReferences),
      reasoning,
      steps: [
        ...checkpoint.completedSteps.map((entry) => ({ step: entry.step, snapshot: frozenSnapshot })),
        { step: checkpoint.completedSteps.length, snapshot: frozenSnapshot },
      ],
    }
  }

  // completed 步骤不再调模型。read 重执行仅为内存重建，receipt 仅读回执，
  // 两者都不重复 emit 已经持久化过的步骤事件。
  for (const completedStep of checkpoint?.completedSteps ?? []) {
    steps.push({ step: completedStep.step, snapshot: frozenSnapshot })
    const recovered = await executeStep(recoveryEntries(completedStep, true), completedStep.step, { emitEvents: false })
    if (recovered.terminalSucceeded) {
      return {
        output: recovered.terminalOutput, toolCalls,
        entityReferences: structuredClone(entityReferences), reasoning, steps,
      }
    }
  }

  // prepared 已证明该步模型输出持久化成功；恢复只收束工具，不再调模型。
  if (checkpoint?.pendingStep) {
    const pending = checkpoint.pendingStep
    steps.push({ step: pending.step, snapshot: frozenSnapshot })
    const recovered = await executeStep(recoveryEntries(pending), pending.step)
    const completed = completeAgentTurnCheckpoint(checkpoint, { calls: recovered.completedCalls })
    await persistCheckpoint(completed)
    if (recovered.terminalSucceeded) {
      return {
        output: recovered.terminalOutput, toolCalls,
        entityReferences: structuredClone(entityReferences), reasoning, steps,
      }
    }
  }

  const prepareModelCall = async (step, prepareTrigger, force = false) => {
    const preparation = await withinExecutionBoundary(() => modelContext.prepare({
      attempt,
      step,
      messages: conversation,
      tools: frozenTools,
      maxOutputTokens,
      trigger: prepareTrigger,
      ...(force ? { force: true } : {}),
    }))
    if (preparation !== undefined && (
      !preparation
      || typeof preparation !== 'object'
      || Array.isArray(preparation)
    )) {
      throw new TypeError('Agent Model Context prepare 返回值无效。')
    }
    if (
      (preparation?.messages !== undefined && !Array.isArray(preparation.messages))
      || (preparation?.tools !== undefined && !Array.isArray(preparation.tools))
    ) {
      throw new TypeError('Agent Model Context prepare 必须返回消息与工具数组。')
    }
    return {
      preparation,
      request: {
        messages: preparation?.messages === undefined ? conversation : preparation.messages,
        tools: preparation?.tools === undefined ? frozenTools : preparation.tools,
        tool_choice: toolChoice,
        step,
      },
    }
  }

  const startStep = checkpoint?.completedSteps.length ?? 0
  for (let step = startStep; step < maximumSteps; step += 1) {
    // 模型调用前的取消/期限边界：取消后不再启动下一次 sampling。
    assertExecutionAlive()
    steps.push({ step, snapshot: frozenSnapshot })
    let response
    if (modelContext === undefined) {
      // legacy 路径保持调用参数与对象引用不变。
      response = await invokeModel({
        messages: conversation,
        tools: frozenTools,
        tool_choice: toolChoice,
        step,
      })
    } else {
      let preparedCall = await prepareModelCall(step, trigger)
      try {
        response = await invokeModel(preparedCall.request)
      } catch (caught) {
        if (caught?.code !== 'AGENT_CONTEXT_OVERFLOW') throw caught
        const retryCall = await prepareModelCall(step, 'overflow', true)
        if (retryCall.preparation?.changed !== true) {
          try {
            modelContext.observeOverflow?.({
              outcome: 'not_retried', retryCount: 0,
              error: { code: 'AGENT_CONTEXT_OVERFLOW', retryable: false },
            })
          } catch { /* 可观测性不得改变原始 overflow */ }
          throw caught
        }
        preparedCall = retryCall
        // 同一步最多只重试一次；第二次失败直接冒泡，不再压缩或调用模型。
        try {
          response = await invokeModel(preparedCall.request)
          try { modelContext.observeOverflow?.({ outcome: 'recovered', retryCount: 1 }) } catch { /* noop */ }
        } catch (retryCaught) {
          if (retryCaught?.code === 'AGENT_CONTEXT_OVERFLOW') {
            try {
              modelContext.observeOverflow?.({
                outcome: 'failed', retryCount: 1,
                error: { code: 'AGENT_CONTEXT_OVERFLOW', retryable: false },
              })
            } catch { /* 可观测性不得改变原始 overflow */ }
          }
          throw retryCaught
        }
      }
      await withinExecutionBoundary(() => modelContext.observe({
        attempt,
        step,
        prepared: preparedCall.preparation?.prepared,
        responseUsage: normalizeProviderUsage(response?.usage),
      }))
    }
    const message = response?.choices?.[0]?.message
    reasoning = appendAgentReasoning(reasoning, {
      step,
      source: 'raw',
      text: extractProviderReasoning(message, { allowRaw: allowRawReasoning }),
    })
    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : []
    if (!calls.length) {
      const content = terminalModelContent(message?.content)
      if (!checkpointing) {
        return {
          output: content, toolCalls,
          entityReferences: structuredClone(entityReferences), reasoning, steps,
        }
      }
      const terminal = terminalAgentTurnCheckpoint(checkpoint, { attempt, step, content })
      await persistCheckpoint(terminal)
      return {
        output: terminal.terminalContent, toolCalls,
        entityReferences: structuredClone(entityReferences), reasoning, steps,
      }
    }

    if (calls.length > MODEL_TOOL_CALL_LIMIT || plannedToolCallCount + calls.length > maximumToolCalls) {
      throw knownPreEffectFailure(new AgentToolRuntimeError(
        'TOOL_CALL_LIMIT_REACHED',
        'Agent 单步或单轮返回的工具调用过多，已在执行前停止。',
      ))
    }
    plannedToolCallCount += calls.length

    // 模型响应落地后、整批 preflight 前的取消边界：取消后不进入副作用准备。
    assertExecutionAlive()
    // 必须先完成这一步全部 call 的存在性、参数、确认与回执身份校验。
    // 不能执行完第一个工具后，才发现第二个 call 是坏的。
    const preflighted = preflightModelCalls(calls, step)
    if (preflighted.repair) {
      // repairable 批次（H4）：整批无副作用,每个原 call id 恰好一个配对结果,
      // 同一规范化批签名最多一次 repair;下一次迭代由模型自行修复。
      respondPreflightRepair(calls, preflighted.repair.outcomes, step)
      continue
    }
    const planned = preflighted.entries
    if (checkpointing) {
      const prepared = prepareAgentTurnCheckpoint(checkpoint, {
        attempt,
        step,
        calls: planned.map((entry) => entry.descriptor),
      })
      // 这个 await 是副作用边界：失败时下面任何 tool.execute 都不得发生。
      await persistCheckpoint(prepared)
    }
    const executed = await executeStep(planned, step)
    if (checkpointing) {
      const completed = completeAgentTurnCheckpoint(checkpoint, {
        calls: executed.completedCalls,
      })
      await persistCheckpoint(completed)
    }
    if (executed.terminalSucceeded) {
      return {
        output: executed.terminalOutput, toolCalls,
        entityReferences: structuredClone(entityReferences), reasoning, steps,
      }
    }
  }

  // Final synthesis（H4）：action budget 耗尽后不再执行工具,额外一次禁用工具的
  // 最终综合回答。maximumSteps 只计 action steps;terminal checkpoint 允许
  // cursor == MAX_STEPS,因为它只写 terminalContent,不创建新的 tool step。
  assertExecutionAlive()
  try {
    const synthesisRequest = {
      messages: conversation,
      tools: [],
      tool_choice: 'none',
      step: maximumSteps,
    }
    let response
    if (modelContext === undefined) {
      response = await invokeModel(synthesisRequest)
    } else {
      const preparedCall = await prepareModelCall(maximumSteps, 'final_synthesis')
      response = await invokeModel({ ...preparedCall.request, tools: [], tool_choice: 'none' })
      await withinExecutionBoundary(() => modelContext.observe({
        attempt,
        step: maximumSteps,
        prepared: preparedCall.preparation?.prepared,
        responseUsage: normalizeProviderUsage(response?.usage),
      }))
    }
    const message = response?.choices?.[0]?.message
    const content = terminalModelContent(message?.content)
    emitHarness('loop', 'final_synthesis', { step: maximumSteps })
    reasoning = appendAgentReasoning(reasoning, {
      step: maximumSteps,
      source: 'raw',
      text: extractProviderReasoning(message, { allowRaw: allowRawReasoning }),
    })
    if (!checkpointing) {
      return {
        output: content, toolCalls,
        entityReferences: structuredClone(entityReferences), reasoning, steps,
      }
    }
    const terminal = terminalAgentTurnCheckpoint(checkpoint, { attempt, step: maximumSteps, content })
    await persistCheckpoint(terminal)
    return {
      output: terminal.terminalContent, toolCalls,
      entityReferences: structuredClone(entityReferences), reasoning, steps,
    }
  } catch (caught) {
    // 综合失败回退原错误码,保留已完成工具摘要在 toolCalls 中;取消/deadline 原样透传。
    emitHarness('loop', 'final_synthesis', { step: maximumSteps, reason: typeof caught?.code === 'string' ? caught.code : 'FAILED' })
    if (caught?.code === 'REQUEST_CANCELLED' || caught?.code === 'AGENT_TURN_DEADLINE_EXCEEDED') throw caught
    if (caught?.code === 'INVALID_PROVIDER_RESPONSE') throw caught
    if (caught?.code === 'TOOL_LOOP_LIMIT_REACHED') throw caught
    throw new AgentToolRuntimeError('TOOL_LOOP_LIMIT_REACHED', 'Agent 工具调用步骤过多，已停止执行。')
  }
}
