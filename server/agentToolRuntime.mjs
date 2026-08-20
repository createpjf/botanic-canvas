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
 * 缺失时客户端领域映射仍会兜底，因此这里不改变工具执行协议。
 */
function toolEventPresentation(name, output) {
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

export async function runAgentToolLoop({
  registry,
  messages,
  callModel,
  toolChoice = 'auto',
  maximumSteps = 4,
  context,
  allowRawReasoning = false,
  onEvent,
}) {
  const conversation = [...messages]
  const toolCalls = []
  let reasoning = []
  const emit = (event) => {
    if (typeof onEvent !== 'function') return
    try { onEvent(event) } catch { /* 展示层异常不得中断工具循环。 */ }
  }
  for (let step = 0; step < maximumSteps; step += 1) {
    const response = await callModel({
      messages: conversation,
      tools: registry.openAITools(),
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
    if (!calls.length) return { output: message?.content, toolCalls, reasoning }

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
      if (tool.terminal) return { output, toolCalls, reasoning }
      conversation.push({ role: 'tool', tool_call_id: trace.id, content: JSON.stringify(output) })
    }
  }
  throw new AgentToolRuntimeError('TOOL_LOOP_LIMIT_REACHED', 'Agent 工具调用步骤过多，已停止执行。')
}
