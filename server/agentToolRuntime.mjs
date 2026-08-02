const TOOL_NAME = /^[a-z][a-z0-9_]{1,63}$/

export class AgentToolRuntimeError extends Error {
  constructor(code, message, statusCode = 422) {
    super(message)
    this.name = 'AgentToolRuntimeError'
    this.code = code
    this.statusCode = statusCode
  }
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
          parameters: tool.parameters,
        },
      }))
    },
    get(name) {
      return tools.get(name)
    },
    async execute(name, rawArguments, context) {
      const tool = tools.get(name)
      if (!tool) throw new AgentToolRuntimeError('TOOL_NOT_ALLOWED', `Agent 无权调用工具：${name}。`, 403)
      const input = tool.validate(rawArguments, context)
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
  return {
    output,
    toolCall: {
      id,
      name,
      label: tool.label,
      risk: tool.risk,
      status: 'succeeded',
      requiresConfirmation: tool.requiresConfirmation,
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
}) {
  const conversation = [...messages]
  const toolCalls = []
  for (let step = 0; step < maximumSteps; step += 1) {
    const response = await callModel({
      messages: conversation,
      tools: registry.openAITools(),
      tool_choice: toolChoice,
    })
    const message = response?.choices?.[0]?.message
    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : []
    if (!calls.length) return { output: message?.content, toolCalls }

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
      const trace = {
        id: typeof call.id === 'string' && call.id ? call.id : `tool-call-${step + 1}`,
        name,
        label: tool.label,
        risk: tool.risk,
        status: 'succeeded',
        requiresConfirmation: tool.requiresConfirmation,
      }
      if (tool.requiresConfirmation && !context?.approvedToolCallIds?.has(trace.id)) {
        throw new AgentToolRuntimeError('TOOL_CONFIRMATION_REQUIRED', `${tool.label}需要用户确认。`, 409)
      }
      const output = await registry.execute(name, rawArguments, { ...context, toolCallId: trace.id })
      toolCalls.push(trace)
      if (tool.terminal) return { output, toolCalls }
      conversation.push({ role: 'tool', tool_call_id: trace.id, content: JSON.stringify(output) })
    }
  }
  throw new AgentToolRuntimeError('TOOL_LOOP_LIMIT_REACHED', 'Agent 工具调用步骤过多，已停止执行。')
}
