// @ts-check
import {
  AgentSubtaskError,
  SUBAGENT_LIMITS,
  SUBAGENT_OUTPUT_KINDS,
  validateSubtaskOutputShape,
} from './agentSubtask.mjs'
import { canonicalHash } from './canonicalHash.mjs'
import { outboundAgentTraceHeaders } from './agentTraceContext.mjs'
import {
  freezeAgentStepSnapshot,
  runAgentToolLoop as executeAgentToolLoop,
} from './agentToolRuntime.mjs'
import {
  agentSubagentCapabilitySnapshot,
  createAgentSubagentToolRegistry,
  createEmptyAgentSubagentToolRegistry,
} from './agentSubagentTools.mjs'

/**
 * 子 Agent 执行器（Epic 11）。
 *
 * 每个 activation 复用统一的 Agent Tool Loop，但进入循环前会把服务端工具注册表裁成
 * 子任务自己的只读白名单，并冻结能力快照。循环可以多步读取，最终仍只能交回结构化提案。
 */

const ROLE_BRIEFS = Object.freeze({
  brand_research: '你负责品牌调研：归纳该品牌已公开的视觉与语气特征。',
  audience_research: '你负责受众调研：归纳目标人群的偏好与常见反感点。',
  competitor_research: '你负责竞品调研：归纳同类品牌的视觉套路与差异点。',
  creative_direction: '你负责提出一个创意方向，只给方向本身，不写完整提示词。',
  prompt_review: '你负责审阅提示词：指出会导致画面歧义或与要求冲突的表述。',
  visual_review: '你负责视觉审阅：只依据给到的描述判断，不臆测画面。',
  compliance_review: '你负责合规审阅：指出可能违反平台规则或品牌禁用项的内容。',
  provider_comparison: '你负责比较候选方案的取舍，不做最终选择。',
})

function schemaOutline(schema, indent = '') {
  if (!schema || typeof schema !== 'object') return ''
  if (schema.type === 'object') {
    const required = new Set(schema.required ?? [])
    return Object.entries(schema.properties ?? {})
      .map(([key, value]) => {
        const mark = required.has(key) ? '必填' : '可选'
        const detail = value?.type === 'array'
          ? `数组，最多 ${value.maxItems ?? '若干'} 项`
          : Array.isArray(value?.enum)
            ? `取值限于 ${value.enum.join(' / ')}`
            : value?.maxLength ? `字符串，不超过 ${value.maxLength} 字` : String(value?.type ?? '字符串')
        return `${indent}- ${key}（${mark}）：${detail}`
      })
      .join('\n')
  }
  return ''
}

/**
 * 子任务的系统提示词。
 *
 * 最后两条是硬约束，必须写进提示词而不是只靠事后校验：事后校验能挡住违规输出，
 * 但挡不住模型**以为**自己可以直接改画布之后返回一份「我已经改好了」的描述 ——
 * 那种输出形状合法、内容却是谎话。
 */
export function subagentInstructions(subtask) {
  return [
    ROLE_BRIEFS[subtask?.role] ?? '你负责按要求产出一份结构化结论。',
    '你是一个子任务，不是主对话。你的产出会交给主 Agent 参考，由用户最终决定。',
    '只输出 JSON，字段如下：',
    schemaOutline(subtask?.outputSchema),
    '不要输出 JSON 之外的任何文字，也不要用代码块包裹。',
    '你无权修改画布、提交生成、调用外部系统或做出最终决定；不要在结论里声称你已经做过这些事。',
    '不确定就如实说明不确定，不要编造来源或数据。',
  ].filter(Boolean).join('\n')
}

function parseJsonPayload(content) {
  if (typeof content !== 'string' || !content.trim()) return undefined
  try {
    // 只接受完整 JSON；代码块和前后解释都表示模型没有遵守结构化输出契约。
    const parsed = JSON.parse(content.trim())
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function outputText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
  return ''
}

function activationMessages(messages, activation, descriptor) {
  if (Array.isArray(messages) && messages.length) {
    const transcript = messages
      .filter((message) => ['user', 'assistant'].includes(message?.role) && typeof message?.content === 'string')
      .slice(-16)
      .map((message) => ({ role: message.role, content: message.content.slice(0, 4_000) }))
    if (transcript.length) return transcript
  }
  const input = activation?.input ?? activation?.message?.content ?? descriptor?.input ?? {}
  return [{
    role: 'user',
    content: (typeof input === 'string' ? input : JSON.stringify(input ?? {})).slice(0, 4_000),
  }]
}

const FORBIDDEN_OUTPUT_KEYS = new Set(['canvasCommands', 'writeback', 'artifacts', 'approval', 'toolCalls'])

function assertProposalOnly(value, path = 'output') {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertProposalOnly(entry, `${path}[${index}]`))
    return
  }
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_OUTPUT_KEYS.has(key)) {
      throw new AgentSubtaskError(
        'SUBTASK_OUTPUT_NOT_PROPOSAL',
        `子 Agent 只能返回结构化提案，不能包含落地或审批字段（${path}.${key}）。`,
        409,
      )
    }
    assertProposalOnly(entry, `${path}.${key}`)
  }
}

function resolvedBudget(subtask) {
  const requestedSteps = subtask?.budget?.maxSteps
  // 旧的 ephemeral 调用曾声明 maxSteps=1。它没有工具时仍是一轮调用；升级后给它两轮
  // 的兼容下限，才能完成「读取工具 → 最终 JSON」。新 descriptor 只允许显式 2–6。
  const maximumSteps = requestedSteps === undefined || requestedSteps === 1 ? 2 : Number(requestedSteps)
  if (!Number.isInteger(maximumSteps) || maximumSteps < 2 || maximumSteps > SUBAGENT_LIMITS.maxSteps) {
    throw new AgentSubtaskError('SUBTASK_LIMIT_INVALID', '子 Agent 步数预算必须是 2 到 6 之间的整数。')
  }
  const maximumToolCalls = subtask?.budget?.maxToolCalls === undefined
    ? 24
    : Number(subtask.budget.maxToolCalls)
  if (!Number.isInteger(maximumToolCalls) || maximumToolCalls < 1 || maximumToolCalls > 24) {
    throw new AgentSubtaskError('SUBTASK_LIMIT_INVALID', '子 Agent 工具调用预算必须是 1 到 24 之间的整数。')
  }
  const requestedTimeout = subtask?.timeoutMs ?? subtask?.budget?.timeoutMs
  const timeoutMs = requestedTimeout === undefined ? 45_000 : Number(requestedTimeout)
  if (!Number.isInteger(timeoutMs)
    || timeoutMs < SUBAGENT_LIMITS.minTimeoutMs
    || timeoutMs > SUBAGENT_LIMITS.maxTimeoutMs) {
    throw new AgentSubtaskError(
      'SUBTASK_LIMIT_INVALID',
      `子 Agent 超时必须是 ${SUBAGENT_LIMITS.minTimeoutMs} 到 ${SUBAGENT_LIMITS.maxTimeoutMs} 毫秒。`,
    )
  }
  return { maximumSteps, maximumToolCalls, timeoutMs }
}

function abortReason(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error('子 Agent 请求已取消。')
}

/** 即使 fake Provider 忽略 signal，调用方也能按时收回 activation 的控制权。 */
function abortable(factory, signal) {
  if (signal?.aborted) return Promise.reject(abortReason(signal))
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      signal?.removeEventListener?.('abort', onAbort)
      callback(value)
    }
    const onAbort = () => finish(reject, abortReason(signal))
    signal?.addEventListener?.('abort', onAbort, { once: true })
    Promise.resolve().then(factory).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    )
  })
}

function createTimeoutSignal(outerSignal, timeoutMs) {
  const timeoutController = new AbortController()
  const timer = setTimeout(() => {
    timeoutController.abort(new AgentSubtaskError('SUBTASK_TIMEOUT', `子 Agent 超过 ${timeoutMs}ms。`, 408))
  }, timeoutMs)
  return {
    timeoutController,
    timer,
    signal: outerSignal
      ? AbortSignal.any([outerSignal, timeoutController.signal])
      : timeoutController.signal,
  }
}

/**
 * 构建子 Agent 执行器。
 *
 * 未配置模型时返回 `undefined` —— 调用方据此**不注册**派发工具，而不是注册一个
 * 一调就失败的工具。模型看不到的工具不会被它拿去向用户承诺。
 *
 * @param {{
 *   runtimeConfig?: any,
 *   callModel?: (input: { model: string, messages: any[], tools?: any[], tool_choice?: string, step?: number, signal: AbortSignal }) => Promise<any>,
 *   fetchImpl?: typeof fetch,
 *   toolRegistry?: any,
 *   runAgentToolLoop?: typeof executeAgentToolLoop,
 * }} input
 */
export function createAgentSubagentRunner(input) {
  const {
    runtimeConfig,
    callModel,
    fetchImpl = fetch,
    toolRegistry,
    runAgentToolLoop = executeAgentToolLoop,
  } = input ?? {}
  // 模型**必须显式配置**，不从主 Agent 模型隐式继承：隐式继承意味着任何一次配置
  // 调整都可能在无人察觉的情况下把并行调研打开，而它每次派发都要多花 2–3 次调用。
  const configuredModel = typeof runtimeConfig?.agentSubagentModel === 'string'
    ? runtimeConfig.agentSubagentModel.trim()
    : ''
  // 注入 fake/provider adapter 时给 Checkpoint 一个稳定模型身份；生产默认仍要求显式配置。
  const fallbackModel = configuredModel || (typeof callModel === 'function' ? 'injected-subagent-model' : '')
  const apiKey = typeof runtimeConfig?.flockApiKey === 'string' ? runtimeConfig.flockApiKey.trim() : ''
  const invoke = typeof callModel === 'function' ? callModel : (configuredModel && apiKey
    ? async ({ model, messages, tools, tool_choice: toolChoice, signal }) => {
      const baseUrl = typeof runtimeConfig?.flockApiBaseUrl === 'string' && runtimeConfig.flockApiBaseUrl.trim()
        ? runtimeConfig.flockApiBaseUrl.trim().replace(/\/+$/, '')
        : 'https://api.flock.io/v1'
      const requestBody = { model, messages, max_tokens: 900, temperature: 0.3 }
      if (Array.isArray(tools) && tools.length) {
        requestBody.tools = tools
        requestBody.tool_choice = toolChoice ?? 'auto'
      }
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          ...outboundAgentTraceHeaders(),
          Authorization: `Bearer ${apiKey}`,
          'x-litellm-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal,
      })
      if (!response.ok) {
        throw new AgentSubtaskError('SUBAGENT_MODEL_UNAVAILABLE', `子 Agent 模型返回 ${response.status}。`, 502)
      }
      return response.json().catch(() => null)
    }
    : undefined)
  if (!invoke) return undefined

  return async function runSubagent(runInput) {
    const {
      subtask,
      descriptor,
      activation,
      messages,
      signal: outerSignal,
      callTool,
      registry: activationRegistry,
      context,
      onEvent,
      attempt,
      resumeCheckpoint,
      saveCheckpoint,
      recoverToolCall,
      recoverJournalResult,
    } = runInput ?? {}
    const contract = descriptor ?? subtask
    const descriptorModel = typeof descriptor?.model === 'string' ? descriptor.model.trim() : ''
    const model = descriptorModel || fallbackModel
    if (!model) {
      throw new AgentSubtaskError('SUBAGENT_MODEL_UNAVAILABLE', '子 Agent 缺少可执行模型。', 503)
    }
    if (contract?.outputKind !== undefined && !SUBAGENT_OUTPUT_KINDS.includes(contract.outputKind)) {
      throw new AgentSubtaskError('SUBTASK_OUTPUT_KIND_INVALID', '子 Agent 产出类型无效。')
    }
    if (!contract?.outputSchema || typeof contract.outputSchema !== 'object' || contract.outputSchema.type !== 'object') {
      throw new AgentSubtaskError('SUBTASK_SCHEMA_REQUIRED', '子 Agent 必须绑定服务端对象输出 Schema。')
    }
    const budget = resolvedBudget(contract)
    const sourceRegistry = activationRegistry ?? toolRegistry
    const registry = sourceRegistry
      ? createAgentSubagentToolRegistry({
        registry: sourceRegistry,
        allowedTools: contract?.allowedTools,
        executeTool: typeof callTool === 'function'
          ? (name, value) => callTool(name, value)
          : undefined,
      })
      : createEmptyAgentSubagentToolRegistry()
    const snapshot = descriptor && sourceRegistry
      ? agentSubagentCapabilitySnapshot({ descriptor: contract, registry: sourceRegistry, fallbackModel: model })
      : freezeAgentStepSnapshot({ registry, model, role: contract?.role })
    const snapshotHash = canonicalHash(snapshot)
    if (descriptor && descriptor.capabilityHash !== snapshotHash) {
      throw new AgentSubtaskError(
        'SUBTASK_CAPABILITY_SNAPSHOT_MISMATCH',
        '子 Agent 的持久化能力摘要与当前服务端工具定义不一致。',
        409,
      )
    }
    if (attempt && (attempt.model !== model || attempt.snapshotHash !== snapshotHash)) {
      throw new AgentSubtaskError(
        'SUBTASK_CAPABILITY_SNAPSHOT_MISMATCH',
        '子 Agent 的模型或工具能力快照与执行尝试不一致。',
        409,
      )
    }
    const loopAttempt = attempt ?? {
      id: String(activation?.turnId ?? activation?.id ?? contract?.id ?? contract?.fingerprint ?? 'subagent-activation').slice(0, 80),
      model,
      snapshotHash,
    }
    const request = createTimeoutSignal(outerSignal, budget.timeoutMs)
    try {
      const result = await abortable(() => runAgentToolLoop({
        registry,
        snapshot,
        attempt: loopAttempt,
        resumeCheckpoint,
        saveCheckpoint,
        recoverToolCall,
        recoverJournalResult,
        messages: [
          { role: 'system', content: subagentInstructions(contract) },
          ...activationMessages(messages, activation, contract),
        ],
        callModel: (modelInput, runtime) => abortable(() => invoke({
          ...modelInput,
          model,
          signal: runtime?.signal ?? request.signal,
        }), runtime?.signal ?? request.signal),
        toolChoice: 'auto',
        maximumSteps: budget.maximumSteps,
        maximumToolCalls: budget.maximumToolCalls,
        allowRawReasoning: false,
        genAiTelemetry: runtimeConfig?.telemetry?.genAiDevelopmentSemconv === true,
        onEvent,
        signal: request.signal,
        context: {
          ...context,
          subagentId: descriptor?.id,
          activationId: activation?.id,
          activationSequence: activation?.sequence,
          subtaskId: subtask?.id,
          traceId: contract?.traceId ?? contract?.rootTurnId ?? contract?.parentTurnId,
          signal: request.signal,
        },
      }), request.signal)
      if (request.signal.aborted) throw abortReason(request.signal)
      const parsed = parseJsonPayload(outputText(result?.output))
      if (!parsed) {
        // 解析不出来是**可诊断的失败**，不是空结果：空结果会让「模型没答」看起来像
        // 「模型说没发现问题」。
        throw new AgentSubtaskError('SUBTASK_OUTPUT_INVALID', '子 Agent 的输出不是预期的 JSON。')
      }
      assertProposalOnly(parsed)
      const output = validateSubtaskOutputShape(contract?.outputSchema, parsed)
      // V2 Processor 需要把安全工具轨迹与实体引用一起写进 AgentTurn result；完整推理
      // 无论开关如何都不跨出 Runner。Legacy scheduler 仍只接收原始提案对象。
      if (descriptor) {
        return {
          output,
          toolCalls: structuredClone(Array.isArray(result?.toolCalls) ? result.toolCalls : []),
          ...(Array.isArray(result?.entityReferences) && result.entityReferences.length
            ? { entityReferences: structuredClone(result.entityReferences) }
            : {}),
        }
      }
      return output
    } catch (caught) {
      if (outerSignal?.aborted) {
        throw new AgentSubtaskError('SUBTASK_ABORTED', '子 Agent 请求已取消。', 499)
      }
      if (request.timeoutController.signal.aborted) {
        throw new AgentSubtaskError('SUBTASK_TIMEOUT', `子 Agent 超过 ${budget.timeoutMs}ms。`, 408)
      }
      throw caught
    } finally {
      clearTimeout(request.timer)
    }
  }
}
