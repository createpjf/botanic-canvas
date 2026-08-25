// @ts-check
import { canonicalHash } from './canonicalHash.mjs'

/**
 * Subagent 治理契约（Epic 11）。
 *
 * 这个模块解决的不是「怎么并行跑几个模型」，而是**并行之后谁说了算**。多 Agent 的
 * 危险不在于慢，在于两处：
 *
 * - 子任务直接落地。一个子 Agent 提交了 Canvas 变更、另一个提交了相冲突的变更，
 *   或者两个都宣布同一个候选是终稿 —— 之后没有任何记录能说清哪一个才是决定。
 * - 子任务绕开审批。`write` / `costly` / `external` 的门禁绑定的是**用户**的确认，
 *   而子 Agent 没有用户。让它持有写工具，等于给了一条不需要任何人点头的写入路径。
 *
 * 对第二点，本模块选择的不是「子任务的写操作也走审批」，而是**子任务根本不能持有
 * 写工具**：`assertSubtaskToolAllowlist` 在创建时就拒绝任何非只读工具。理由是审批
 * 凭据签给 (userId, toolCallId, 参数摘要)，子 Agent 三样都没有；硬塞一个「代持」
 * 身份进去，就等于凭空造了一个可以自我审批的主体。
 *
 * 子任务只能产出 Proposal 或 ArtifactCandidate，由 Root Orchestrator 转成一次正常的
 * 工具调用，再走既有的用户审批。慢一步，但没有任何一条路径能绕过人。
 */

/** 子任务角色。取自 Epic 11「适合 Subagent」一节；未列出的角色不允许创建。 */
export const SUBAGENT_ROLES = Object.freeze([
  'brand_research',
  'audience_research',
  'competitor_research',
  'creative_direction',
  'prompt_review',
  'visual_review',
  'compliance_review',
  'provider_comparison',
])

/**
 * 子任务**只有这两种**产出。
 *
 * 刻意不留「其他」这一档：留了之后，第一个不好归类的返回值就会走进去，
 * 而「子 Agent 只能返回结构化提案」这条验收标准从那一刻起不再成立。
 */
export const SUBAGENT_OUTPUT_KINDS = Object.freeze(['proposal', 'artifact_candidate'])

/** 终止原因。每一条都必须能被追踪到 —— 「就是停了」不是可运维的状态。 */
export const SUBAGENT_TERMINATION_REASONS = Object.freeze([
  'budget_exhausted',
  'timeout',
  'tool_denied',
  'output_invalid',
  'parent_cancelled',
  'failed',
])

export const SUBAGENT_STATUSES = Object.freeze(['queued', 'running', 'completed', 'terminated'])

/** 硬上限。它们不是配置项：这是「一次编排最多能花多少」的天花板。 */
export const SUBAGENT_LIMITS = Object.freeze({
  maxConcurrent: 4,
  maxSubtasksPerTurn: 12,
  maxSteps: 6,
  maxTimeoutMs: 120_000,
  minTimeoutMs: 1_000,
})

export class AgentSubtaskError extends Error {
  /** @param {string} code @param {string} message @param {number} [statusCode] */
  constructor(code, message, statusCode = 422) {
    super(message)
    this.name = 'AgentSubtaskError'
    this.code = code
    this.statusCode = statusCode
  }
}

function text(value, name, maximum) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentSubtaskError('SUBTASK_FIELD_MISSING', `${name}不能为空。`)
  }
  const result = value.trim()
  if (result.length > maximum) throw new AgentSubtaskError('SUBTASK_FIELD_TOO_LONG', `${name}过长。`)
  return result
}

function positiveInteger(value, name, { min, max }) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new AgentSubtaskError('SUBTASK_LIMIT_INVALID', `${name}必须是 ${min} 到 ${max} 之间的整数。`)
  }
  return number
}

/**
 * 子任务不得持有的工具。
 *
 * 判定口径是**「根 Agent 自己调它需不需要用户点头」**，不是工具的 `risk` 名字：
 *
 * - `requiresConfirmation`：需要人点头的，子 Agent 一律不能持有。审批凭据签给
 *   (userId, toolCallId, 参数摘要)，子 Agent 三样都没有；硬塞一个「代持」身份进去，
 *   等于凭空造了一个可以自我审批的主体。这就是「不能借 Subagent 绕过审批」的落点。
 * - `terminal`：会结束整轮的工具。子任务不允许产出终态。
 * - `risk` 为 `write` / `costly`：即便某个工具忘了声明 `requiresConfirmation`，
 *   也不该因为这个疏忽就对子 Agent 开放。
 *
 * 反过来，`web_search` 这类**外呼但只读、根 Agent 调用时也不需要确认**的工具是允许
 * 的：那里没有任何控制可供绕过，禁掉它只会让调研子任务退化成凭记忆瞎编。
 * 第一版按 `risk !== 'read'` 一刀切正是这个错误。
 *
 * 依据一律取自注册表里工具**自己的声明**，这里不另列名单 —— 另列一份的话，
 * 新增写工具时没人会想起来同步它。
 *
 * @param {any} tool
 */
function subtaskToolRefusal(tool) {
  if (tool.requiresConfirmation) return '需要用户确认'
  if (tool.terminal) return '会结束整轮并产生终态'
  if (tool.risk === 'write' || tool.risk === 'costly') return '会写入或产生费用'
  return ''
}

/**
 * 校验子任务的工具白名单。
 *
 * @param {string[]} allowedTools
 * @param {{ get?: (name: string) => any }} registry
 */
export function assertSubtaskToolAllowlist(allowedTools, registry) {
  if (!Array.isArray(allowedTools) || !allowedTools.length) {
    // 空白名单不等于「随便用」。不声明就是不给用，因此必须显式报错而不是默默放行全部。
    throw new AgentSubtaskError('SUBTASK_ALLOWLIST_REQUIRED', '子任务必须显式声明允许使用的工具。')
  }
  if (allowedTools.length > 12) {
    throw new AgentSubtaskError('SUBTASK_ALLOWLIST_TOO_LARGE', '子任务允许的工具过多。')
  }
  const resolved = []
  for (const name of allowedTools) {
    const tool = registry?.get?.(name)
    if (!tool) {
      throw new AgentSubtaskError('SUBTASK_TOOL_UNKNOWN', `子任务声明了不存在的工具：${name}。`, 403)
    }
    const refusal = subtaskToolRefusal(tool)
    if (refusal) {
      throw new AgentSubtaskError(
        'SUBTASK_TOOL_FORBIDDEN',
        `工具「${name}」${refusal}，子任务不能持有它；请让根 Agent 依据子任务的提案自行发起并由用户确认。`,
        403,
      )
    }
    resolved.push(name)
  }
  return resolved
}

/**
 * 子任务的输出 Schema。
 *
 * 只支持一小撮形状（对象、必填字段、字段类型、字符串长度、数组长度），够描述
 * Proposal 就行。**不引入通用 JSON Schema 校验器**：子任务输出是模型产出的、
 * 不可信的，校验器越通用，出现「校验通过但形状不是我要的」的空间越大。
 *
 * @param {any} schema
 * @param {any} value
 * @param {string} path
 */
function validateAgainstSchema(schema, value, path = 'output') {
  if (!schema || typeof schema !== 'object') return value
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new AgentSubtaskError('SUBTASK_OUTPUT_INVALID', `${path} 必须是对象。`)
    }
    for (const key of schema.required ?? []) {
      if (value[key] === undefined || value[key] === null || value[key] === '') {
        throw new AgentSubtaskError('SUBTASK_OUTPUT_INVALID', `${path}.${key} 缺失。`)
      }
    }
    const properties = schema.properties ?? {}
    // 未声明的字段直接丢弃，不透传：模型多给的东西没有被任何人审过。
    return Object.fromEntries(Object.keys(properties)
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, validateAgainstSchema(properties[key], value[key], `${path}.${key}`)]))
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new AgentSubtaskError('SUBTASK_OUTPUT_INVALID', `${path} 必须是数组。`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      throw new AgentSubtaskError('SUBTASK_OUTPUT_INVALID', `${path} 最多 ${schema.maxItems} 项。`)
    }
    return value.map((item, index) => validateAgainstSchema(schema.items, item, `${path}[${index}]`))
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') throw new AgentSubtaskError('SUBTASK_OUTPUT_INVALID', `${path} 必须是字符串。`)
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      throw new AgentSubtaskError('SUBTASK_OUTPUT_INVALID', `${path} 超过 ${schema.maxLength} 字。`)
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      throw new AgentSubtaskError('SUBTASK_OUTPUT_INVALID', `${path} 不在允许取值内。`)
    }
    return value
  }
  if (schema.type === 'number') {
    const number = Number(value)
    if (!Number.isFinite(number)) throw new AgentSubtaskError('SUBTASK_OUTPUT_INVALID', `${path} 必须是数字。`)
    return number
  }
  return value
}

export { validateAgainstSchema as validateSubtaskOutputShape }

/**
 * 输入指纹。重放安全的依据：同一父轮次、同一角色、同一输入 ⇒ 同一个子任务标识。
 *
 * 重放时命中已有结果直接返回，因此不会重复外呼，也不会产出第二个终态决定
 * （Epic 11 验收第 4 条）。
 */
export function subtaskFingerprint({ parentTurnId, role, input, allowedTools, outputSchema }) {
  return canonicalHash({ parentTurnId, role, input, allowedTools: [...(allowedTools ?? [])].sort(), outputSchema })
}

/**
 * 创建一个受治理的子任务。
 *
 * 预算、超时、工具白名单、输出 Schema 四样**全部必填**。任何一样缺省，就意味着存在
 * 一条「没有上限」的子任务路径 —— 而超支和挂死总是从那条路径上发生的。
 *
 * @param {{
 *   parentTurnId: string, projectId: string, ownerId: string, role: string,
 *   input: any, allowedTools: string[], outputSchema: any, registry: any,
 *   budget: { maxSteps?: number, maxToolCalls?: number },
 *   timeoutMs: number, outputKind?: string, now?: number,
 * }} config
 */
export function createAgentSubtask({
  parentTurnId, projectId, ownerId, role, input, allowedTools, outputSchema, registry,
  budget, timeoutMs, outputKind = 'proposal', now = Date.now(),
}) {
  const parent = text(parentTurnId, '父轮次标识', 160)
  if (!SUBAGENT_ROLES.includes(role)) {
    throw new AgentSubtaskError('SUBTASK_ROLE_INVALID', `子任务角色「${role}」不在允许列表。`)
  }
  if (!SUBAGENT_OUTPUT_KINDS.includes(outputKind)) {
    throw new AgentSubtaskError('SUBTASK_OUTPUT_KIND_INVALID', `子任务产出类型「${outputKind}」不被允许。`)
  }
  if (!outputSchema || typeof outputSchema !== 'object' || outputSchema.type !== 'object') {
    // 没有 Schema 的子任务等于让模型自由发挥返回什么都行，之后根 Agent 只能靠猜去读。
    throw new AgentSubtaskError('SUBTASK_SCHEMA_REQUIRED', '子任务必须声明对象形状的输出 Schema。')
  }
  const tools = assertSubtaskToolAllowlist(allowedTools, registry)
  const resolvedBudget = {
    maxSteps: positiveInteger(budget?.maxSteps ?? 0, '子任务步数预算', { min: 1, max: SUBAGENT_LIMITS.maxSteps }),
    maxToolCalls: positiveInteger(budget?.maxToolCalls ?? 0, '子任务工具调用预算', { min: 1, max: 24 }),
  }
  const resolvedTimeout = positiveInteger(timeoutMs, '子任务超时', {
    min: SUBAGENT_LIMITS.minTimeoutMs, max: SUBAGENT_LIMITS.maxTimeoutMs,
  })
  const fingerprint = subtaskFingerprint({ parentTurnId: parent, role, input, allowedTools: tools, outputSchema })
  return {
    // 标识由指纹派生，因此同一父轮次的同一子任务重放时命中同一条记录。
    id: `subtask_${fingerprint.slice(0, 32)}`,
    fingerprint,
    parentTurnId: parent,
    projectId: text(projectId, '项目标识', 160),
    ownerId: text(ownerId, '所有者标识', 160),
    role,
    outputKind,
    input: structuredClone(input ?? {}),
    allowedTools: tools,
    outputSchema: structuredClone(outputSchema),
    budget: resolvedBudget,
    timeoutMs: resolvedTimeout,
    status: 'queued',
    spent: { steps: 0, toolCalls: 0 },
    // 与父轮次同一 trace：失败、超时与重试必须能串成一条线（验收第 4 条）。
    traceId: parent,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * 预算判定。返回**为什么**超了，不只是超没超 —— 「步数用完」与「工具调用用完」
 * 对应的修法完全不同。
 *
 * @param {any} subtask
 */
export function subtaskBudgetState(subtask) {
  const spent = subtask?.spent ?? {}
  if ((spent.steps ?? 0) >= (subtask?.budget?.maxSteps ?? 0)) {
    return { exhausted: true, reason: 'budget_exhausted', detail: `步数已达上限 ${subtask?.budget?.maxSteps}。` }
  }
  if ((spent.toolCalls ?? 0) >= (subtask?.budget?.maxToolCalls ?? 0)) {
    return { exhausted: true, reason: 'budget_exhausted', detail: `工具调用已达上限 ${subtask?.budget?.maxToolCalls}。` }
  }
  return { exhausted: false }
}

/**
 * 可追踪地终止一个子任务。
 *
 * 终止后**不清空已花费的额度**：超支记录是运维要看的东西，清掉之后
 * 「这次编排为什么这么贵」就再也答不上来了。
 *
 * @param {any} subtask
 * @param {{ reason: string, detail?: string, now?: number }} input
 */
export function terminateAgentSubtask(subtask, { reason, detail, now = Date.now() }) {
  if (!SUBAGENT_TERMINATION_REASONS.includes(reason)) {
    throw new AgentSubtaskError('SUBTASK_TERMINATION_REASON_INVALID', `终止原因「${reason}」未声明。`)
  }
  return {
    ...subtask,
    status: 'terminated',
    termination: { reason, ...(detail ? { detail } : {}), at: now },
    updatedAt: now,
  }
}

/**
 * 收下子任务的产出。
 *
 * 三道关卡缺一不可：产出类型在词表内、形状符合声明的 Schema、**不含任何落地指令**。
 * 第三道是关键 —— 子任务返回 `canvasCommands` 之类的东西时不能只是忽略它，
 * 要当成违约终止：一个试图直接改画布的子 Agent 说明编排出了问题，静默丢弃会让这个
 * 问题一直藏着，直到某天有人「顺手」把它接上。
 *
 * @param {any} subtask
 * @param {any} rawOutput
 * @param {{ now?: number }} [options]
 */
export function acceptAgentSubtaskOutput(subtask, rawOutput, { now = Date.now() } = {}) {
  const forbiddenKeys = ['canvasCommands', 'writeback', 'artifacts', 'toolCalls', 'approval']
  const present = forbiddenKeys.filter((key) => rawOutput && typeof rawOutput === 'object' && key in rawOutput)
  if (present.length) {
    throw new AgentSubtaskError(
      'SUBTASK_OUTPUT_NOT_PROPOSAL',
      `子任务只能返回结构化提案，不能直接提交落地指令（出现了：${present.join('、')}）。`,
      409,
    )
  }
  const output = validateAgainstSchema(subtask?.outputSchema, rawOutput)
  return {
    ...subtask,
    status: 'completed',
    result: {
      kind: subtask.outputKind,
      // 提案带上它由谁产出、依据什么输入 —— 根 Agent 采纳时要能说清来源。
      role: subtask.role,
      subtaskId: subtask.id,
      fingerprint: subtask.fingerprint,
      output,
    },
    completedAt: now,
    updatedAt: now,
  }
}

/**
 * 根 Orchestrator 采纳一份提案时的落地检查。
 *
 * 它**不执行**任何东西，只回答「这份提案能不能被当作一次正常的工具调用发起」。
 * 真正的执行仍走既有的 `executeConfirmedAgentAction` + 用户审批。
 *
 * @param {any} subtask
 * @param {{ rootTurnId: string }} input
 */
export function proposalForRootOrchestrator(subtask, { rootTurnId }) {
  if (subtask?.status !== 'completed' || !subtask.result) {
    throw new AgentSubtaskError('SUBTASK_NOT_COMPLETED', '子任务尚未产出可采纳的提案。', 409)
  }
  if (subtask.parentTurnId !== rootTurnId) {
    // 跨轮次采纳会让一份提案在两条编排里各落地一次，产生两个终态决定。
    throw new AgentSubtaskError('SUBTASK_PARENT_MISMATCH', '提案不属于当前编排轮次。', 409)
  }
  return {
    ...subtask.result,
    // 采纳仍需用户确认：这里只是把提案整理成待确认的形状，不是批准它。
    requiresUserApproval: true,
  }
}
