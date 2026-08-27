// @ts-check
import { resolveBotanicAgentTurn } from './botanicAgentTurn.mjs'
import { validateAgentTurnCheckpoint } from './agentTurnCheckpoint.mjs'

const RECEIPT_TEXT_KEYS = new Set(['message', 'status', 'kind', 'type', 'label', 'name'])
const RECEIPT_BOOLEAN_KEYS = new Set(['ok', 'reused', 'created', 'updated', 'deleted', 'cancelled'])
const RECEIPT_PRIVATE_KEYS = new Set(['receiptid', 'intenthash', 'leasetoken', 'token'])
const RECEIPT_UNSAFE_KEY = /(analysis|audio|base64|binary|blob|buffer|bytes|canvaspatch|content|file|image|media|output|prompt|provider|raw|reasoning|response|result|thought|url|video)/u

function normalizedKey(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/gu, '')
}

function boundedText(value, maximumLength) {
  if (typeof value !== 'string') return undefined
  const clean = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim()
  if (!clean || /^data:/iu.test(clean)) return undefined
  return clean.slice(0, maximumLength)
}

function safeReference(value) {
  const reference = boundedText(value, 240)
  if (!reference || /^(?:https?:)?\/\//iu.test(reference)) return undefined
  return reference
}

function unsafeReceiptKey(key) {
  const normalized = normalizedKey(key)
  return RECEIPT_PRIVATE_KEYS.has(normalized) || RECEIPT_UNSAFE_KEY.test(normalized)
}

/**
 * Action Receipt 的 result 可能带 Provider 回包、媒体地址或工具 wrapper。恢复只沿用
 * 可导航的业务引用与短展示字段，不把原 output 原样塞回 Turn result / 模型上下文。
 */
function safeReceiptValue(value, key = '', depth = 0) {
  if (depth > 6 || unsafeReceiptKey(key)) return undefined
  const normalized = normalizedKey(key)
  if (typeof value === 'string') {
    if (normalized === 'id' || normalized.endsWith('id')) return safeReference(value)
    if (RECEIPT_TEXT_KEYS.has(normalized)) return boundedText(value, normalized === 'message' ? 500 : 120)
    return undefined
  }
  if (typeof value === 'boolean') {
    return RECEIPT_BOOLEAN_KEYS.has(normalized) ? value : undefined
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && (normalized === 'count' || normalized.endsWith('count'))
      ? value
      : undefined
  }
  if (!value || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    if (normalized.endsWith('ids')) {
      const references = value.slice(0, 64).map(safeReference).filter(Boolean)
      return references.length ? references : undefined
    }
    const entries = value.slice(0, 64)
      .map((entry) => safeReceiptValue(entry, '', depth + 1))
      .filter((entry) => entry !== undefined)
    return entries.length ? entries : undefined
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const projected = {}
  for (const [childKey, childValue] of Object.entries(value)) {
    const safe = safeReceiptValue(childValue, childKey, depth + 1)
    if (safe !== undefined) projected[childKey] = safe
  }
  return Object.keys(projected).length ? projected : undefined
}

function safeReceiptResult(result) {
  // `executeConfirmedAgentAction` 返回 `{ output, toolCall }`；只展开这一层 wrapper，
  // 随后仍按白名单投影，绝不沿用 raw output 本身。
  const source = result && typeof result === 'object' && !Array.isArray(result)
    && Object.hasOwn(result, 'output')
    ? result.output
    : result
  const safe = safeReceiptValue(source)
  if (safe === undefined) {
    throw new AgentTurnResumeError(
      'AGENT_ACTION_RECEIPT_RESULT_UNSAFE',
      '行动已完成，但回执没有可安全恢复的业务引用。',
    )
  }
  return safe
}

function receiptKey(call) {
  return `${call.id}\u0000${call.receiptId}\u0000${call.intentHash}`
}

function receiptCallsFromCheckpoint(checkpointValue) {
  if (checkpointValue === undefined) return []
  const checkpoint = validateAgentTurnCheckpoint(checkpointValue)
  return [
    ...checkpoint.completedSteps.flatMap((step) => step.calls),
    ...(checkpoint.pendingStep?.calls ?? []),
  ].filter((call) => call.recovery === 'receipt')
}

/** 与路由层同一份映射：Skill 只把可解释字段交给规划器，不交内部记录。 */
function plannerSkillInput(skill) {
  return {
    id: skill.id,
    name: skill.name,
    instructions: skill.instructions,
    status: skill.status,
    ...(Number.isInteger(skill.version) ? { version: skill.version } : {}),
    ...(typeof skill.contentHash === 'string' ? { contentHash: skill.contentHash } : {}),
    ...(Array.isArray(skill.capabilities) ? { capabilities: skill.capabilities } : {}),
  }
}

export class AgentTurnResumeError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message)
    this.name = 'AgentTurnResumeError'
    this.code = code
    this.statusCode = statusCode
  }
}

/**
 * 恢复一个被判定为可重放的孤儿 Turn。
 *
 * 派生上下文（项目文档、项目 Skill）在这里**重新读取**而不是从快照恢复：重放一份
 * 过期的画布或 Skill 列表，会让恢复出的回合与当前项目不一致。只有用户请求本身
 * 来自不可变快照。
 *
 * 不自己判断能否重放 —— 那是 `turnReclaimDecision` 的职责，调用方判完再交给它。
 *
 * @param {{
 *   productStore: any,
 *   config: any,
 *   mediaService?: any,
 *   turnRuntime: { execute: (input: any) => Promise<any> },
 *   observe?: (event: any) => void,
 * }} deps
 */
export function createAgentTurnResumer({ productStore, config, mediaService, turnRuntime, observe }) {
  if (!productStore) throw new TypeError('Turn 恢复缺少 ProductStore。')
  if (!turnRuntime?.execute) throw new TypeError('Turn 恢复缺少 Turn Runtime。')

  const report = (event) => {
    try { observe?.(event) } catch { /* 可观测性不得改变恢复结果。 */ }
  }

  return async function resumeAgentTurn(turn) {
    if (!turn?.request) {
      // 早于请求快照落地的 Turn 无从重建输入。明确报错而不是静默跳过，
      // 否则调用方会以为恢复成功了。
      throw new AgentTurnResumeError('AGENT_TURN_REQUEST_MISSING', '该回合没有可重放的请求快照，无法恢复。')
    }

    const receiptCalls = receiptCallsFromCheckpoint(turn.checkpoint)
    const receipts = new Map()
    if (receiptCalls.length && typeof productStore.readAgentActionReceipt !== 'function') {
      throw new AgentTurnResumeError(
        'AGENT_ACTION_RECEIPT_READ_UNAVAILABLE',
        '当前部署缺少行动回执读取能力，请稍后恢复。',
        503,
      )
    }
    for (const call of receiptCalls) {
      let receipt
      try {
        receipt = await productStore.readAgentActionReceipt(turn.ownerId, call.receiptId)
      } catch {
        // Store 暂时不可读时不要取得 Turn lease 后再把它错误收口为 failed；保留给
        // 下一轮 Sweep。只有持久化回执的明确状态才可以决定后续命运。
        throw new AgentTurnResumeError(
          'AGENT_ACTION_RECEIPT_READ_FAILED',
          '行动回执暂时无法读取，请稍后恢复。',
          503,
        )
      }
      const matches = Boolean(receipt
        && receipt.id === call.receiptId
        && receipt.ownerId === turn.ownerId
        && receipt.projectId === turn.projectId
        && receipt.intentHash === call.intentHash)
      const outcome = !receipt
        ? { kind: 'missing' }
        : (!matches ? { kind: 'scope_mismatch' } : { kind: 'receipt', receipt })
      receipts.set(receiptKey(call), outcome)
    }

    // running 表示另一个持租约行动执行者仍可能提交终态。必须在取得 Turn 执行权前
    // 停下，否则 Runtime catch 会把一个仍在推进的行动误写成 failed。
    if ([...receipts.values()].some((outcome) => (
      outcome.kind === 'receipt' && outcome.receipt.status === 'running'
    ))) {
      throw new AgentTurnResumeError('AGENT_ACTION_IN_PROGRESS', '该行动仍在执行，请稍后恢复。')
    }

    const recoverToolCall = async ({ toolCall }) => {
      const outcome = toolCall ? receipts.get(receiptKey(toolCall)) : undefined
      if (!outcome || outcome.kind === 'scope_mismatch') {
        throw new AgentTurnResumeError(
          'AGENT_ACTION_RECEIPT_SCOPE_MISMATCH',
          '行动回执与当前用户、项目或执行意图不匹配。',
        )
      }
      if (outcome.kind === 'missing') {
        throw new AgentTurnResumeError('AGENT_ACTION_RECEIPT_NOT_FOUND', '未找到该行动的持久化回执，无法安全恢复。')
      }
      const receipt = outcome.receipt
      if (receipt.status === 'succeeded') return safeReceiptResult(receipt.result)
      if (receipt.status === 'running') {
        throw new AgentTurnResumeError('AGENT_ACTION_IN_PROGRESS', '该行动仍在执行，请稍后恢复。')
      }
      if (receipt.status === 'uncertain') {
        throw new AgentTurnResumeError(
          'AGENT_ACTION_OUTCOME_UNKNOWN',
          '行动可能已经生效，但持久化回执无法确认；系统不会自动重放。',
        )
      }
      if (receipt.status === 'failed') {
        // 不沿用 receipt.error.message：它可能含 Provider 原文或私有地址。
        throw new AgentTurnResumeError('AGENT_ACTION_FAILED', '持久化回执显示该行动失败，Turn 无法自动恢复。')
      }
      throw new AgentTurnResumeError('AGENT_ACTION_RECEIPT_STATE_INVALID', '行动回执状态无效，Turn 无法安全恢复。')
    }

    const project = await productStore.readProject(turn.ownerId, turn.projectId)
    if (!project?.document) {
      throw new AgentTurnResumeError('AGENT_TURN_PROJECT_MISSING', '来源项目已不存在，无法恢复该回合。')
    }
    const projectSkills = await productStore.listAgentSkills(turn.ownerId, turn.projectId) ?? []

    // 恢复自带独立的取消控制器：它与原请求的 HTTP 连接无关，那条连接早已断开。
    const controller = new AbortController()
    const input = { ...turn.request, projectSkills: projectSkills.map(plannerSkillInput) }
    const threadContextSnapshot = turn.request.threadContextSnapshot
    const immutableThreadSummary = threadContextSnapshot?.version === 1
      && threadContextSnapshot.threadSummary
      && typeof threadContextSnapshot.threadSummary === 'object'
      && !Array.isArray(threadContextSnapshot.threadSummary)
      ? structuredClone(threadContextSnapshot.threadSummary)
      : undefined

    report({ event: 'agent.turn.resume.started', turnId: turn.id, projectId: turn.projectId })
    const execution = await turnRuntime.execute({
      userId: turn.ownerId,
      projectId: turn.projectId,
      ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
      id: turn.id,
      // 复用原幂等键：恢复是同一次逻辑请求的续跑，不是新的一次提交。
      idempotencyKey: turn.idempotencyKey,
      request: turn.request,
      allowTakeover: true,
      resolve: (resolveOptions) => resolveBotanicAgentTurn(input, config, resolveOptions),
      resolveOptions: {
        document: project.document,
        projectSkills,
        ...(immutableThreadSummary ? { threadSummary: immutableThreadSummary } : {}),
        signal: controller.signal,
        recoverToolCall,
        // 看图只读当前项目内的媒体；图片字节不离开服务端与模型网关。
        resolveVisionMedia: mediaService?.enabled
          ? (mediaId) => mediaService.readGenerationInput(turn.ownerId, mediaId, turn.projectId)
          : undefined,
      },
    })
    report({
      event: 'agent.turn.resume.completed',
      turnId: turn.id,
      projectId: turn.projectId,
      status: execution?.turn?.status,
    })
    return execution
  }
}
