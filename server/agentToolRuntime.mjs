import { agentToolCallSummary, appendAgentReasoning, extractProviderReasoning } from './botanicAgentReasoning.mjs'

const TOOL_NAME = /^[a-z][a-z0-9_]{1,63}$/

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
    return count !== undefined
      ? { kind: 'search', title: `已搜索 ${count} 个网站`, count }
      : { kind: 'search', title: '正在搜索网站' }
  }
  if (normalizedName === 'web_fetch') {
    const hostname = safePresentationLabel(output?.hostname)
    return hostname
      ? { kind: 'fetch', title: `网页获取 ${hostname}` }
      : { kind: 'fetch', title: '正在获取网页' }
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
    tools.set(definition.name, Object.freeze({
      ...definition,
      risk: definition.risk ?? 'read',
      requiresConfirmation: Boolean(definition.requiresConfirmation),
      terminal: Boolean(definition.terminal),
    }))
  }

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
    async execute(name, rawArguments, context) {
      const tool = tools.get(name)
      if (!tool) throw new AgentToolRuntimeError('TOOL_NOT_ALLOWED', `Agent 无权调用工具：${name}。`, 403)
      const input = tool.validate(withoutReason(rawArguments), context)
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
  if (!tool) throw new AgentToolRuntimeError('TOOL_NOT_ALLOWED', `Agent 无权调用工具：${name ?? 'unknown'}。`, 403)
  const id = typeof toolCallId === 'string' && toolCallId.trim() ? toolCallId.trim() : undefined
  if (!id) throw new AgentToolRuntimeError('INVALID_TOOL_CALL_ID', '工具调用标识无效。')
  if (tool.requiresConfirmation && confirmed !== true) {
    throw new AgentToolRuntimeError('TOOL_CONFIRMATION_REQUIRED', `${tool.label}需要用户确认。`, 409)
  }
  const output = await registry.execute(name, argumentsValue, {
    ...context,
    toolCallId: id,
    approvedToolCallIds: new Set([...(context?.approvedToolCallIds ?? []), id]),
  })
  const summary = agentToolCallSummary(argumentsValue)
  return {
    output,
    toolCall: {
      id,
      name,
      label: tool.label,
      risk: tool.risk,
      status: 'succeeded',
      requiresConfirmation: tool.requiresConfirmation,
      ...(summary ? { summary } : {}),
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
export function freezeAgentStepSnapshot({ registry, model, skillBindings, memoryBindings, role } = {}) {
  return Object.freeze({
    model: model ?? undefined,
    toolNames: Object.freeze((registry?.names?.() ?? []).slice()),
    skillBindings: Object.freeze((skillBindings ?? []).map((binding) => Object.freeze({
      id: binding?.id, version: binding?.version, contentHash: binding?.contentHash,
    }))),
    memoryBindings: Object.freeze((memoryBindings ?? []).map((binding) => Object.freeze({
      id: binding?.id, version: binding?.version, contentHash: binding?.contentHash,
    }))),
    role: role ?? undefined,
  })
}

export async function runAgentToolLoop({
  registry,
  messages,
  callModel,
  toolChoice = 'auto',
  maximumSteps = 4,
  context,
  allowRawReasoning = false,
  onEvent,
  snapshot,
}) {
  const conversation = [...messages]
  // 工具定义在循环开始前定格一次，之后每一步都用同一份。
  const frozenTools = registry.openAITools()
  const frozenSnapshot = snapshot ?? freezeAgentStepSnapshot({ registry })
  const steps = []
  const toolCalls = []
  let reasoning = []
  const emit = (event) => {
    if (typeof onEvent !== 'function') return
    try { onEvent(event) } catch { /* 展示层异常不得中断工具循环。 */ }
  }
  for (let step = 0; step < maximumSteps; step += 1) {
    steps.push({ step, snapshot: frozenSnapshot })
    const response = await callModel({
      messages: conversation,
      tools: frozenTools,
      tool_choice: toolChoice,
      step,
    })
    const message = response?.choices?.[0]?.message
    reasoning = appendAgentReasoning(reasoning, {
      step,
      source: 'raw',
      text: extractProviderReasoning(message, { allowRaw: allowRawReasoning }),
    })
    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : []
    if (!calls.length) return { output: message?.content, toolCalls, reasoning, steps }

    conversation.push({
      role: 'assistant',
      content: message.content ?? null,
      tool_calls: calls,
    })
    for (const call of calls) {
      const name = call?.function?.name
      const tool = registry.get(name)
      if (!tool) throw new AgentToolRuntimeError('TOOL_NOT_ALLOWED', `Agent 无权调用工具：${name ?? 'unknown'}。`, 403)
      const rawArguments = parseArguments(call?.function?.arguments)
      const summary = agentToolCallSummary(rawArguments)
      const trace = {
        id: typeof call.id === 'string' && call.id ? call.id : `tool-call-${step + 1}`,
        name,
        label: tool.label,
        risk: tool.risk,
        status: 'succeeded',
        requiresConfirmation: tool.requiresConfirmation,
        ...(summary ? { summary } : {}),
      }
      reasoning = appendAgentReasoning(reasoning, { step, source: 'summary', text: summary })
      if (tool.requiresConfirmation && !context?.approvedToolCallIds?.has(trace.id)) {
        throw new AgentToolRuntimeError('TOOL_CONFIRMATION_REQUIRED', `${tool.label}需要用户确认。`, 409)
      }
      const runningPresentation = toolEventPresentation(name)
      emit({
        type: 'tool', step, toolCall: { ...trace, status: 'running' },
        ...(runningPresentation ? { presentation: runningPresentation } : {}),
      })
      let output
      try {
        output = await registry.execute(name, rawArguments, { ...context, toolCallId: trace.id })
      } catch (caught) {
        const error = caught instanceof Error ? caught.message : '工具执行失败。'
        const failed = { ...trace, status: 'failed', error }
        emit({
          type: 'tool', step, toolCall: failed,
          ...(runningPresentation ? { presentation: runningPresentation } : {}),
        })
        if (!isRecoverableToolFailure(caught)) throw caught
        toolCalls.push(failed)
        conversation.push({
          role: 'tool',
          tool_call_id: trace.id,
          content: JSON.stringify({
            ok: false,
            error,
            code: caught.code,
          }),
        })
        continue
      }
      const succeededPresentation = toolEventPresentation(name, output)
      emit({
        type: 'tool', step, toolCall: trace,
        ...(succeededPresentation ? { presentation: succeededPresentation } : {}),
      })
      toolCalls.push(trace)
      if (tool.terminal) return { output, toolCalls, reasoning, steps }
      conversation.push({ role: 'tool', tool_call_id: trace.id, content: JSON.stringify(output) })
    }
  }
  throw new AgentToolRuntimeError('TOOL_LOOP_LIMIT_REACHED', 'Agent 工具调用步骤过多，已停止执行。')
}
