// @ts-check
import { AgentSubtaskError } from './agentSubtask.mjs'

/**
 * 子 Agent 执行器（Epic 11）。
 *
 * 一个子 Agent 就是一次受限的模型调用：给定角色、输入与输出 Schema，返回一份结构化
 * 提案。它**没有工具循环**——工具调用由 `agentSubtaskScheduler` 的 `callTool` 显式
 * 授予，且只在白名单内。
 *
 * 为什么不复用 `runAgentToolLoop`：那条循环的语义是「模型自己决定调什么工具，直到
 * 产出终态」。子任务恰恰不允许产出终态，也不允许它自行扩张工具面 —— 复用会把这两条
 * 限制变成需要在循环里到处补的特例，而不是结构上做不到。
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
  const text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function providerText(payload) {
  const content = payload?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
  return ''
}

/**
 * 构建子 Agent 执行器。
 *
 * 未配置模型时返回 `undefined` —— 调用方据此**不注册**派发工具，而不是注册一个
 * 一调就失败的工具。模型看不到的工具不会被它拿去向用户承诺。
 *
 * @param {{
 *   runtimeConfig?: any,
 *   callModel?: (input: { model: string, messages: any[], signal: AbortSignal }) => Promise<any>,
 *   fetchImpl?: typeof fetch,
 * }} input
 */
export function createAgentSubagentRunner({ runtimeConfig, callModel, fetchImpl = fetch } = {}) {
  // 模型**必须显式配置**，不从主 Agent 模型隐式继承：隐式继承意味着任何一次配置
  // 调整都可能在无人察觉的情况下把并行调研打开，而它每次派发都要多花 2–3 次调用。
  const model = typeof runtimeConfig?.agentSubagentModel === 'string' ? runtimeConfig.agentSubagentModel.trim() : ''
  const apiKey = typeof runtimeConfig?.flockApiKey === 'string' ? runtimeConfig.flockApiKey.trim() : ''
  const invoke = callModel ?? (model && apiKey
    ? async ({ messages, signal }) => {
      const baseUrl = typeof runtimeConfig?.flockApiBaseUrl === 'string' && runtimeConfig.flockApiBaseUrl.trim()
        ? runtimeConfig.flockApiBaseUrl.trim().replace(/\/+$/, '')
        : 'https://api.flock.io/v1'
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'x-litellm-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, messages, max_tokens: 900, temperature: 0.3 }),
        signal,
      })
      if (!response.ok) {
        throw new AgentSubtaskError('SUBAGENT_MODEL_UNAVAILABLE', `子 Agent 模型返回 ${response.status}。`, 502)
      }
      return response.json().catch(() => null)
    }
    : undefined)
  if (!invoke) return undefined

  return async function runSubagent({ subtask, signal }) {
    const payload = await invoke({
      model,
      messages: [
        { role: 'system', content: subagentInstructions(subtask) },
        { role: 'user', content: JSON.stringify(subtask.input).slice(0, 4_000) },
      ],
      signal,
    })
    const parsed = parseJsonPayload(providerText(payload))
    if (!parsed) {
      // 解析不出来是**可诊断的失败**，不是空结果：空结果会让「模型没答」看起来像
      // 「模型说没发现问题」。
      throw new AgentSubtaskError('SUBTASK_OUTPUT_INVALID', '子 Agent 的输出不是预期的 JSON。')
    }
    return parsed
  }
}
