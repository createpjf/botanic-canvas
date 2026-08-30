import { agentToolCallSummary, appendAgentReasoning, extractProviderReasoning } from './botanicAgentReasoning.mjs'
import { presentationWebSources } from './agentWebResearch.mjs'
import {
  completeAgentTurnCheckpoint,
  prepareAgentTurnCheckpoint,
  terminalAgentTurnCheckpoint,
  validateAgentTurnCheckpoint,
} from './agentTurnCheckpoint.mjs'
import { canonicalHash } from './canonicalHash.mjs'
import { estimateAgentContextTokens, truncateAgentContextText } from './agentContextBudget.mjs'
import { extractAgentEntityReferences, mergeAgentEntityReferences } from './agentEntityReferences.mjs'
import { normalizeProviderUsage } from './botanicAgentStream.mjs'
import { withBotanicSpan } from './executionTelemetry.mjs'
import { normalizeAgentToolCallId } from './agentToolCallIdentity.mjs'

const TOOL_NAME = /^[a-z][a-z0-9_]{1,63}$/
const TOOL_RECOVERY_MODES = new Set(['reexecute', 'receipt', 'never'])
const MODEL_TOOL_CALL_LIMIT = 16
const MODEL_TOOL_CALL_TOTAL_LIMIT = 64
export const AGENT_TOOL_OUTPUT_TOKEN_BUDGET = 2_000
export const AGENT_TOOL_OUTPUT_TOTAL_TOKEN_BUDGET = 6_000

function serializedOutput(output) {
  const serialized = JSON.stringify(output)
  return serialized === undefined ? 'null' : serialized
}

function compactToolOutputEnvelope(entry, serialized, reason) {
  return JSON.stringify({
    _botanicTruncation: {
      truncated: true,
      reason,
      contentHash: canonicalHash(serialized),
      reread: 'preceding_assistant_tool_call',
    },
  })
}

function detailedToolOutputEnvelope(entry, output, serialized, maximumTokens, reason) {
  const originalTokens = estimateAgentContextTokens(serialized)
  const metadata = {
    truncated: true,
    reason,
    contentHash: canonicalHash(serialized),
    originalCharacters: serialized.length,
    originalTokens,
    omittedCharacters: serialized.length,
    budgetTokens: maximumTokens,
    reread: {
      source: 'preceding_assistant_tool_call',
      tool: entry.trace.name,
      argumentsHash: canonicalHash(entry.rawArguments ?? {}),
    },
  }
  const withoutPreview = JSON.stringify({ _botanicTruncation: metadata })
  if (estimateAgentContextTokens(withoutPreview) > maximumTokens) {
    return compactToolOutputEnvelope(entry, serialized, reason)
  }

  // JSON escaping 会让 preview 的实际 token 数高于原文。以预算为上界
  // 做确定性二分，选能装入 envelope 的最大 preview。
  let low = 0
  let high = maximumTokens
  let best = withoutPreview
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const preview = truncateAgentContextText(serialized, middle, { marker: '…' })
    const candidate = JSON.stringify({
      _botanicTruncation: {
        ...metadata,
        omittedCharacters: preview.omittedCharacters,
      },
      preview: preview.text,
    })
    if (estimateAgentContextTokens(candidate) <= maximumTokens) {
      best = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return best
}

function boundedToolOutput(entry, output, maximumTokens, reason) {
  const serialized = serializedOutput(output)
  const originalTokens = estimateAgentContextTokens(serialized)
  if (originalTokens <= maximumTokens) {
    return { content: serialized, tokens: originalTokens, compact: false, serialized }
  }
  const content = detailedToolOutputEnvelope(entry, output, serialized, maximumTokens, reason)
  return {
    content,
    tokens: estimateAgentContextTokens(content),
    compact: false,
    serialized,
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const entry of Object.values(value)) deepFreeze(entry)
  return Object.freeze(value)
}

/**
 * 每个工具都额外接受一个 why 参数：模型用一句话自述本次调用的目的。
 * 它是模型主动说给用户听的摘要，不是隐藏思维链，因此可以展示也可以持久化。
 */
const REASON_PARAMETER = {
  type: 'string',
  maxLength: 120,
  description: '用一句话说明你为什么要进行这次调用；这句话会直接展示给用户，不要包含隐藏推理。',
}

function withReasonParameter(parameters) {
  if (!parameters || typeof parameters !== 'object' || parameters.type !== 'object') return parameters
  return {
    ...parameters,
    properties: { ...(parameters.properties ?? {}), why: REASON_PARAMETER },
  }
}

/** why 只用于展示，不进入各工具自己的校验器。 */
function withoutReason(rawArguments) {
  if (!rawArguments || typeof rawArguments !== 'object' || Array.isArray(rawArguments)) return rawArguments
  if (!('why' in rawArguments)) return rawArguments
  const { why, ...rest } = rawArguments
  void why
  return rest
}

export class AgentToolRuntimeError extends Error {
  constructor(code, message, statusCode = 422) {
    super(message)
    this.name = 'AgentToolRuntimeError'
    this.code = code
    this.statusCode = statusCode
  }
}

function knownPreEffectFailure(error) {
  if (error && (typeof error === 'object' || typeof error === 'function')) error.outcomeKnown = true
  return error
}

function isRecoverableToolFailure(caught) {
  return caught instanceof AgentToolRuntimeError && typeof caught.code === 'string' && caught.code.startsWith('WEB_')
}

/**
 * 工具参数由模型产出，写坏了属于「Provider 返回了非法参数」，不是用户请求非法。
 * 校验必须抛工具级错误，调用方才能把它归一成 502 并降级；用请求级 400 会把
 * 「生成 Prompt 不能为空」这类内部文案当成用户的错展示出去。
 */
export function agentToolText(value, name, maximumLength) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentToolRuntimeError('INVALID_TOOL_ARGUMENTS', `${name}不能为空。`)
  }
  const result = value.trim()
  if (result.length > maximumLength) {
    throw new AgentToolRuntimeError('INVALID_TOOL_ARGUMENTS', `${name}过长。`)
  }
  return result
}

export function agentToolObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentToolRuntimeError('INVALID_TOOL_ARGUMENTS', `${name}无效。`)
  }
  return value
}

function parseArguments(value) {
  if (typeof value !== 'string' || value.length > 64 * 1024) {
    throw new AgentToolRuntimeError('INVALID_TOOL_ARGUMENTS', '工具参数无效。')
  }
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('invalid')
    return parsed
  } catch {
    throw new AgentToolRuntimeError('INVALID_TOOL_ARGUMENTS', '工具参数不是有效 JSON。')
  }
}

function safePresentationLabel(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 80) : ''
}

function presentationCount(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return undefined
  const direct = [output.hitCount, output.sourceCount, output.count, output.total]
    .map(Number)
    .find((value) => Number.isInteger(value) && value >= 0)
  if (direct !== undefined) return direct
  const collection = [output.hits, output.sources, output.results].find(Array.isArray)
  return collection?.length
}

function withWebSources(presentation, output) {
  const sources = presentationWebSources(output)
  return sources.length > 0 ? { ...presentation, sources } : presentation
}

/**
 * 工具展示元数据只从工具名和安全结果摘要中提取，不复制参数或完整返回值。
 * 标题像真实日志（「检索项目记忆」「起草生成计划」），不是装饰文案。
 * 缺失时客户端领域映射仍会兜底；禁止客户端预插「成功」——running/终态只由 execute 前后 emit。
 */
const knownToolPresentations = Object.freeze({
  ontology_read: { kind: 'read', title: '读取本体上下文' },
  project_memory_search: { kind: 'search', title: '检索项目记忆' },
  asset_group_search: { kind: 'search', title: '搜索素材组' },
  skill_search: { kind: 'search', title: '检索技能' },
  canvas_read: { kind: 'read', title: '读取画布上下文' },
  asset_search: { kind: 'search', title: '搜索素材' },
  skill_run: { kind: 'read_skill', title: '调用创作 Skill' },
  skill_create_propose: { kind: 'write', title: '提议创建项目 Skill' },
  mcp_propose: { kind: 'other', title: '提议 MCP 调用' },
  generation_ask_clarification: { kind: 'other', title: '确认生成参数' },
  generation_create_plan: { kind: 'write', title: '起草生成计划' },
  generate_images: { kind: 'write', title: '准备图片生成' },
  generate_videos: { kind: 'write', title: '准备视频生成' },
  decompose_creative_brief: { kind: 'other', title: '分解创意方案' },
  ask_clarification: { kind: 'other', title: '向用户提问' },
  workflow_create: { kind: 'write', title: '创建画布工作流' },
  generation_submit: { kind: 'write', title: '提交生成任务' },
  skill_apply: { kind: 'write', title: '应用项目 Skill' },
  skill_create: { kind: 'write', title: '创建项目 Skill' },
  mcp_call: { kind: 'other', title: '调用外部工具' },
})

export function toolEventPresentation(name, output) {
  const normalizedName = typeof name === 'string' ? name.toLowerCase() : ''
  if (normalizedName === 'web_search' || normalizedName.startsWith('search_')) {
    const count = presentationCount(output)
    return withWebSources(count !== undefined
      ? { kind: 'search', title: `已搜索 ${count} 个网站`, count }
      : { kind: 'search', title: '正在搜索网站' }, output)
  }
  if (normalizedName === 'web_fetch') {
    const hostname = safePresentationLabel(output?.hostname)
    return withWebSources(hostname
      ? { kind: 'fetch', title: `网页获取 ${hostname}` }
      : { kind: 'fetch', title: '正在获取网页' }, output)
  }
  if (/^(?:skill_read|read_skill)$/u.test(normalizedName)) {
    const skillName = safePresentationLabel(output?.skillName ?? output?.skill?.name)
    return { kind: 'read_skill', title: skillName ? `读取${skillName}技能指南` : '读取技能指南' }
  }
  if (/^(?:browser_connect|playwright_connect|cdp_attach)$/u.test(normalizedName)) {
    return { kind: 'connect_runtime', title: '连接浏览器 runtime' }
  }
  const known = knownToolPresentations[normalizedName]
  if (known) {
    if (normalizedName === 'skill_run') {
      const skillName = safePresentationLabel(output?.skillName ?? output?.skill?.name ?? output?.name)
      if (skillName) return { kind: 'read_skill', title: `调用${skillName}` }
    }
    if (normalizedName === 'asset_search' || normalizedName === 'asset_group_search' || normalizedName === 'project_memory_search') {
      const count = presentationCount(output)
      if (count !== undefined) return { ...known, count, title: `${known.title} · ${count} 条` }
    }
    return { ...known }
  }
  return undefined
}

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
  modelContext = undefined,
  maxOutputTokens = undefined,
  trigger = 'pre_step',
  genAiTelemetry = false,
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
  // 工具定义在循环开始前定格一次，之后每一步都用同一份。
  const frozenTools = registry.openAITools()
  const frozenSnapshot = snapshot ?? freezeAgentStepSnapshot({ registry })
  const invokeModel = (request) => withBotanicSpan(
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
      const response = await callModel(request)
      if (genAiTelemetry && span) {
        try {
          const usage = normalizeProviderUsage(response?.usage)
          if (Number.isSafeInteger(usage?.inputTokens)) span.setAttribute('gen_ai.usage.input_tokens', usage.inputTokens)
          if (Number.isSafeInteger(usage?.outputTokens)) span.setAttribute('gen_ai.usage.output_tokens', usage.outputTokens)
        } catch { /* usage telemetry 不得改变 Provider 结果 */ }
      }
      return response
    },
  )
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

  const persistCheckpoint = async (next) => {
    if (!checkpointing) return
    await saveCheckpoint(next)
    checkpoint = next
  }

  let toolOutputTokens = 0
  const toolOutputRecords = []

  const compactRecord = (record) => {
    const content = compactToolOutputEnvelope(record.entry, record.serialized, 'cumulative_budget')
    const tokens = estimateAgentContextTokens(content)
    if (tokens >= record.tokens) return false
    conversation[record.conversationIndex].content = content
    toolOutputTokens -= record.tokens - tokens
    record.content = content
    record.tokens = tokens
    record.compact = true
    return true
  }

  const appendToolOutput = (entry, output) => {
    const serialized = serializedOutput(output)
    const compactContent = compactToolOutputEnvelope(entry, serialized, 'cumulative_budget')
    const compactTokens = estimateAgentContextTokens(compactContent)
    while (toolOutputTokens + compactTokens > AGENT_TOOL_OUTPUT_TOTAL_TOKEN_BUDGET) {
      const candidate = toolOutputRecords.find((record) => !record.compact && record.tokens > compactTokens)
      if (!candidate || !compactRecord(candidate)) break
    }
    const available = Math.max(0, AGENT_TOOL_OUTPUT_TOTAL_TOKEN_BUDGET - toolOutputTokens)
    const maximumTokens = Math.min(AGENT_TOOL_OUTPUT_TOKEN_BUDGET, available)
    const reason = maximumTokens < AGENT_TOOL_OUTPUT_TOKEN_BUDGET
      ? 'cumulative_budget'
      : 'per_output_budget'
    let bounded = boundedToolOutput(entry, output, maximumTokens, reason)
    if (bounded.tokens > available) {
      bounded = {
        content: compactContent,
        tokens: compactTokens,
        compact: true,
        serialized,
      }
    }
    if (bounded.tokens > available) {
      // 每步/整轮 tool-call 数已受限，正常不会走到这里。
      // 仍保留一个有效 JSON tool message，避免破坏 assistant↔tool 配对。
      const minimal = '{"_botanicTruncation":{"truncated":true,"reason":"cumulative_budget"}}'
      bounded = {
        content: minimal,
        tokens: estimateAgentContextTokens(minimal),
        compact: true,
        serialized,
      }
    }
    const conversationIndex = conversation.length
    conversation.push({ role: 'tool', tool_call_id: entry.trace.id, name: entry.trace.name, content: bounded.content })
    toolOutputTokens += bounded.tokens
    toolOutputRecords.push({ ...bounded, entry, conversationIndex })
  }

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

  const preflightModelCalls = (calls, step) => calls.map((call, index) => {
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
      ...(tool.recovery === 'reexecute' ? { arguments: structuredClone(rawArguments) } : {}),
      ...(tool.recovery === 'receipt' ? receiptIdentity(tool, call, trace, rawArguments) : {}),
    }
    return { call, tool, rawArguments, validatedInput, trace, descriptor }
  })

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
    }
  }

  const recoveryEntries = (stepCheckpoint, referencesFromCheckpoint = false) => {
    // 先检查整步的能力；不能先重执行前面的 read，才发现后面有 never。
    assertRecoverableStep(stepCheckpoint)
    return stepCheckpoint.calls.map((call, index) => {
      const tool = registry.get(call.name)
      const rawArguments = call.recovery === 'reexecute' ? structuredClone(call.arguments) : undefined
      const trace = traceFor(tool, { id: call.id }, stepCheckpoint.step, index, rawArguments)
      let validatedInput
      if (call.recovery === 'reexecute') {
        try {
          validatedInput = tool.validate(withoutReason(rawArguments), { ...context, toolCallId: call.id })
        } catch (caught) {
          throw knownPreEffectFailure(caught)
        }
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

  const executeStep = async (entries, step, { emitEvents = true } = {}) => {
    conversation.push({ role: 'assistant', tool_calls: assistantCalls(entries) })
    let terminalOutput
    let terminalSucceeded = false
    for (const entry of entries) {
      const { tool, trace } = entry
      entry.completedDescriptor = entry.descriptor
      const summary = entry.rawArguments ? agentToolCallSummary(entry.rawArguments) : undefined
      reasoning = appendAgentReasoning(reasoning, { step, source: 'summary', text: summary })
      const runningPresentation = toolEventPresentation(trace.name)
      if (emitEvents) {
        emit({
          type: 'tool', step, toolCall: { ...trace, status: 'running' },
          ...(runningPresentation ? { presentation: runningPresentation } : {}),
        })
      }
      let output
      try {
        output = await withBotanicSpan(`execute_tool ${trace.name}`, {
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
          return tool.execute(entry.validatedInput, { ...context, toolCallId: trace.id })
        })
      } catch (caught) {
        const error = caught instanceof Error ? caught.message : '工具执行失败。'
        const failed = { ...trace, status: 'failed', error }
        if (emitEvents) {
          emit({
            type: 'tool', step, toolCall: failed,
            ...(runningPresentation ? { presentation: runningPresentation } : {}),
          })
        }
        if (!isRecoverableToolFailure(caught)) throw caught
        toolCalls.push(failed)
        appendToolOutput(entry, { ok: false, error, code: caught.code })
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
      if (tool.terminal) {
        terminalOutput = output
        terminalSucceeded = true
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
    const preparation = await modelContext.prepare({
      attempt,
      step,
      messages: conversation,
      tools: frozenTools,
      maxOutputTokens,
      trigger: prepareTrigger,
      ...(force ? { force: true } : {}),
    })
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
      await modelContext.observe({
        attempt,
        step,
        prepared: preparedCall.preparation?.prepared,
        responseUsage: normalizeProviderUsage(response?.usage),
      })
    }
    const message = response?.choices?.[0]?.message
    reasoning = appendAgentReasoning(reasoning, {
      step,
      source: 'raw',
      text: extractProviderReasoning(message, { allowRaw: allowRawReasoning }),
    })
    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : []
    if (!calls.length) {
      if (!checkpointing) {
        return {
          output: message?.content, toolCalls,
          entityReferences: structuredClone(entityReferences), reasoning, steps,
        }
      }
      const terminal = terminalAgentTurnCheckpoint(checkpoint, { attempt, step, content: message?.content })
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

    // 必须先完成这一步全部 call 的存在性、参数、确认与回执身份校验。
    // 不能执行完第一个工具后，才发现第二个 call 是坏的。
    const planned = preflightModelCalls(calls, step)
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
  throw new AgentToolRuntimeError('TOOL_LOOP_LIMIT_REACHED', 'Agent 工具调用步骤过多，已停止执行。')
}
