import { AGENT_TURN_TERMINAL_CONTENT_LIMIT } from '../turn/agentTurnCheckpoint.mjs'
import { canonicalHash } from '../../canonicalHash.mjs'
import { presentationWebSources } from './agentWebResearch.mjs'
import { estimateAgentContextTokens, truncateAgentContextText } from '../context/agentContextBudget.mjs'

export const AGENT_TOOL_NO_PROGRESS_WARNING = 3
export const AGENT_TOOL_NO_PROGRESS_TERMINATE = 5
export const AGENT_TOOL_OUTPUT_TOKEN_BUDGET = 2_000
export const AGENT_TOOL_OUTPUT_TOTAL_TOKEN_BUDGET = 6_000

export function serializedOutput(output) {
  const serialized = JSON.stringify(output)
  return serialized === undefined ? 'null' : serialized
}

export function compactToolOutputEnvelope(entry, serialized, reason) {
  return JSON.stringify({
    _botanicTruncation: {
      truncated: true,
      reason,
      contentHash: canonicalHash(serialized),
      reread: 'preceding_assistant_tool_call',
    },
  })
}

export function detailedToolOutputEnvelope(entry, output, serialized, maximumTokens, reason) {
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

export function boundedToolOutput(entry, output, maximumTokens, reason) {
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

export function deepFreeze(value) {
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

export function withReasonParameter(parameters) {
  if (!parameters || typeof parameters !== 'object' || parameters.type !== 'object') return parameters
  return {
    ...parameters,
    properties: { ...(parameters.properties ?? {}), why: REASON_PARAMETER },
  }
}

/** why 只用于展示，不进入各工具自己的校验器。 */
export function withoutReason(rawArguments) {
  if (!rawArguments || typeof rawArguments !== 'object' || Array.isArray(rawArguments)) return rawArguments
  if (!('why' in rawArguments)) return rawArguments
  const { why, ...rest } = rawArguments
  void why
  return rest
}

/**
 * 注册的 volatile 输出字段（H4）：这些字段每次调用天然不同,参与签名会让「同一结果」
 * 永远判为新进展。只忽略注册字段,不做模糊文本删除。
 */
const AGENT_TOOL_VOLATILE_OUTPUT_FIELDS = Object.freeze(['timestamp', 'requestId', 'traceId', 'elapsedMs'])

export function stableToolOutput(value) {
  if (Array.isArray(value)) return value.map(stableToolOutput)
  if (!value || typeof value !== 'object') return value
  const result = {}
  for (const [key, entry] of Object.entries(value)) {
    if (AGENT_TOOL_VOLATILE_OUTPUT_FIELDS.includes(key)) continue
    result[key] = stableToolOutput(entry)
  }
  return result
}

/**
 * 检测连续相同工具调用（去掉 why、忽略注册 volatile 输出字段）与 A→B→A→B 双签名环，
 * 避免主 Turn 在空转路径上烧完步数。诊断只暴露哈希，不把参数或结果写入事件。
 */
export function createAgentToolNoProgressDetector({
  warningThreshold = AGENT_TOOL_NO_PROGRESS_WARNING,
  terminationThreshold = AGENT_TOOL_NO_PROGRESS_TERMINATE,
} = {}) {
  if (!Number.isInteger(warningThreshold) || warningThreshold < 2) {
    throw new TypeError('无进展警告阈值必须是至少为 2 的整数。')
  }
  if (!Number.isInteger(terminationThreshold) || terminationThreshold <= warningThreshold) {
    throw new TypeError('无进展终止阈值必须大于警告阈值。')
  }
  let lastSignature
  let repeatCount = 0
  // 最多 4 项的小环形窗口：识别 A→B→A→B 两轮循环。
  const window = []
  return {
    record(observation) {
      const signature = canonicalHash({
        name: observation?.name ?? '',
        arguments: withoutReason(observation?.arguments) ?? null,
        output: stableToolOutput(observation?.output ?? null),
        isError: Boolean(observation?.isError),
      })
      if (signature === lastSignature) repeatCount += 1
      else {
        lastSignature = signature
        repeatCount = 1
      }
      window.push(signature)
      if (window.length > 4) window.shift()
      const cycle = window.length === 4
        && window[0] === window[2]
        && window[1] === window[3]
        && window[0] !== window[1]
      return {
        signature,
        repeatCount: cycle ? Math.max(repeatCount, 2) : repeatCount,
        cycle,
        status: repeatCount >= terminationThreshold || cycle
          ? 'terminate'
          : repeatCount === warningThreshold
            ? 'warning'
            : 'progress',
      }
    },
  }
}

export class AgentToolRuntimeError extends Error {
  constructor(code, message, statusCode = 422) {
    super(message)
    this.name = 'AgentToolRuntimeError'
    this.code = code
    this.statusCode = statusCode
  }
}

export function terminalModelContent(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > AGENT_TURN_TERMINAL_CONTENT_LIMIT) {
    throw new AgentToolRuntimeError('INVALID_PROVIDER_RESPONSE', 'Agent 模型未返回有效的最终回答。', 502)
  }
  return value.trim()
}

export function knownPreEffectFailure(error) {
  if (error && (typeof error === 'object' || typeof error === 'function')) error.outcomeKnown = true
  return error
}

/** terminal-known 错误码（H4）：policy/approval、配额、取消、deadline、lease/checkpoint 边界,不得伪装成可修复。 */
const TERMINAL_KNOWN_TOOL_CODES = new Set([
  'TOOL_CONFIRMATION_REQUIRED',
  'WEB_QUOTA_EXCEEDED',
  'REQUEST_CANCELLED',
  'AGENT_TURN_DEADLINE_EXCEEDED',
])

export function isTerminalKnownToolFailure(caught) {
  const code = typeof caught?.code === 'string' ? caught.code : ''
  return TERMINAL_KNOWN_TOOL_CODES.has(code)
    || code.startsWith('AGENT_TURN_CHECKPOINT_')
    || code.startsWith('AGENT_TURN_')
    || code.startsWith('AGENT_SKILL_')
    || code.startsWith('AGENT_CONTEXT_')
}

/**
 * 工具失败三分法（H4）。分类同时看 dispatch lifecycle（phase）、outcomeKnown 与工具风险，
 * 不只按错误码前缀：
 * - repairable：整批无副作用（preflight 失败）,或已知失败的只读/WEB 工具 —— 结果回给模型;
 * - terminal-known：策略/配额/取消/deadline/lease,保留原错误码终止;
 * - outcome-unknown：write/costly/external 调用 dispatched 后无可靠结果,禁止自动重放。
 */
export function classifyAgentToolFailure(caught, { phase = 'execute', tool } = {}) {
  if (isTerminalKnownToolFailure(caught)) return 'terminal-known'
  if (phase === 'preflight') return 'repairable'
  if (caught instanceof AgentToolRuntimeError && typeof caught.code === 'string' && caught.code.startsWith('WEB_')) {
    return 'repairable'
  }
  // 只读工具的执行失败没有副作用之忧:失败结果本身就是已知终局。
  if (tool?.risk === 'read' || caught?.outcomeKnown === true) return 'repairable'
  return 'outcome-unknown'
}

export function isRecoverableToolFailure(caught, tool) {
  return classifyAgentToolFailure(caught, { phase: 'execute', tool }) === 'repairable'
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

export function parseArguments(value) {
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

export function parseArgumentsSafe(value) {
  try {
    return parseArguments(value)
  } catch {
    return typeof value === 'string' ? value.slice(0, 512) : null
  }
}

export function safePresentationLabel(value) {
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
  subagent_research: { kind: 'subagent', title: '并行调研' },
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

export function safeReportedToolPresentation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const kind = safePresentationLabel(value.kind)
  const title = safePresentationLabel(value.title)
  if (!kind || !title || !['search', 'fetch', 'read_skill', 'connect_runtime', 'subagent', 'read', 'write', 'other'].includes(kind)) return undefined
  const count = Number(value.count)
  return { kind, title, ...(Number.isInteger(count) && count >= 0 && count <= 10_000 ? { count } : {}) }
}

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

