// @ts-check
import {
  AgentSubtaskError,
  SUBAGENT_LIMITS,
  acceptAgentSubtaskOutput,
  subtaskBudgetState,
  terminateAgentSubtask,
} from './agentSubtask.mjs'

/**
 * 子任务调度（Epic 11）。
 *
 * 三件事，每一件都是验收标准里点名的：
 *
 * - **最大并发**。不设上限的扇出会在一次编排里同时打满 Provider 配额，
 *   而配额是整个工作区共享的 —— 一次「并行探索 8 个创意方向」会让同时在跑的
 *   正常生成任务一起排队。
 * - **超时与预算的实际执行**。声明了上限却没人执行，等于没有上限。
 * - **重放不产生第二个结果**。同一父轮次的同一子任务重放时命中已有记录直接返回，
 *   因此不会重复外呼、也不会出现两个互相矛盾的提案。
 */

/**
 * 按并发上限分批。返回的是**批次**而不是一次性全给：调用方据此逐批 await，
 * 于是任何时刻在跑的子任务数都不超过上限。
 *
 * @param {any[]} subtasks
 * @param {{ maxConcurrent?: number }} [options]
 */
export function planSubtaskBatches(subtasks, { maxConcurrent = SUBAGENT_LIMITS.maxConcurrent } = {}) {
  const limit = Math.min(Math.max(1, Number(maxConcurrent) || 1), SUBAGENT_LIMITS.maxConcurrent)
  const list = subtasks ?? []
  if (list.length > SUBAGENT_LIMITS.maxSubtasksPerTurn) {
    throw new AgentSubtaskError(
      'SUBTASK_FANOUT_TOO_LARGE',
      `一次编排最多 ${SUBAGENT_LIMITS.maxSubtasksPerTurn} 个子任务，收到 ${list.length} 个。`,
      409,
    )
  }
  const batches = []
  for (let index = 0; index < list.length; index += limit) batches.push(list.slice(index, index + limit))
  return batches
}

/**
 * 同一父轮次内子任务标识必须唯一。
 *
 * 标识由 (父轮次, 角色, 输入, 白名单, Schema) 的指纹派生，因此重复标识意味着
 * **同一个子任务被派发了两次**。让它跑两遍会得到两份可能不同的提案，而根 Agent
 * 无从判断该采纳哪一份 —— 这正是「不产生第二个终态决定」要防的情况。
 *
 * @param {any[]} subtasks
 */
export function dedupeSubtasks(subtasks) {
  const byId = new Map()
  const duplicates = []
  for (const subtask of subtasks ?? []) {
    if (byId.has(subtask.id)) { duplicates.push(subtask.id); continue }
    byId.set(subtask.id, subtask)
  }
  return { subtasks: [...byId.values()], duplicates }
}

/**
 * 执行一个子任务，全程受治理。
 *
 * @param {{
 *   subtask: any,
 *   runSubagent: (input: { subtask: any, signal: AbortSignal, callTool: (name: string, args: any) => Promise<any> }) => Promise<any>,
 *   registry?: { execute?: (name: string, args: any, context: any) => Promise<any> },
 *   context?: any,
 *   now?: () => number,
 * }} input
 */
export async function runAgentSubtask({ subtask, runSubagent, registry, context, now = () => Date.now() }) {
  let current = { ...subtask, status: 'running', startedAt: now(), updatedAt: now() }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), current.timeoutMs)
  // Node 里未 unref 的定时器会拖住进程退出；子任务提前完成时必须清掉。
  if (typeof timer.unref === 'function') timer.unref()

  /** 工具调用要同时受白名单与预算约束，两者都在这里执行而不是靠子 Agent 自觉。 */
  const callTool = async (name, argumentsValue) => {
    if (!current.allowedTools.includes(name)) {
      current = terminateAgentSubtask(current, {
        reason: 'tool_denied', detail: `子任务尝试调用未授权工具：${name}。`, now: now(),
      })
      throw new AgentSubtaskError('SUBTASK_TOOL_DENIED', `子任务无权调用工具：${name}。`, 403)
    }
    const budget = subtaskBudgetState(current)
    if (budget.exhausted) {
      throw new AgentSubtaskError('SUBTASK_BUDGET_EXHAUSTED', budget.detail ?? '子任务预算已用尽。', 429)
    }
    current = { ...current, spent: { ...current.spent, toolCalls: current.spent.toolCalls + 1 }, updatedAt: now() }
    return registry?.execute?.(name, argumentsValue, {
      ...context,
      // 子任务的工具调用带上自己的身份，日志里能区分是哪个子 Agent 发起的。
      subtaskId: current.id,
      traceId: current.traceId,
      signal: controller.signal,
    })
  }

  try {
    const raw = await runSubagent({ subtask: current, signal: controller.signal, callTool })
    current = { ...current, spent: { ...current.spent, steps: current.spent.steps + 1 } }
    return acceptAgentSubtaskOutput(current, raw, { now: now() })
  } catch (caught) {
    // 已经因为工具越权终止过的，保留那个更具体的原因，不要被外层覆盖成泛化的 failed。
    if (current.status === 'terminated') return current
    if (controller.signal.aborted) {
      return terminateAgentSubtask(current, { reason: 'timeout', detail: `超过 ${current.timeoutMs}ms。`, now: now() })
    }
    const code = /** @type {any} */ (caught)?.code
    if (code === 'SUBTASK_BUDGET_EXHAUSTED') {
      return terminateAgentSubtask(current, {
        reason: 'budget_exhausted', detail: caught instanceof Error ? caught.message : undefined, now: now(),
      })
    }
    if (code === 'SUBTASK_OUTPUT_INVALID' || code === 'SUBTASK_OUTPUT_NOT_PROPOSAL') {
      return terminateAgentSubtask(current, {
        reason: 'output_invalid', detail: caught instanceof Error ? caught.message : undefined, now: now(),
      })
    }
    return terminateAgentSubtask(current, {
      reason: 'failed', detail: caught instanceof Error ? caught.message : String(caught), now: now(),
    })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 跑完一整次扇出。
 *
 * 重放安全：`existingResults` 里已有终态记录的子任务**直接复用**，不重新执行。
 * 这是「重放不会重复外部写入或产生第二个终态决定」的实现 —— 恢复一次中断的编排时，
 * 已经跑完的研究不会再花一次钱，也不会给出一份和上次不同的提案。
 *
 * 一个子任务失败**不取消其余**：并行探索里有一路失败是正常的，全组作废会让另外三路
 * 已经花掉的钱白费。失败的那一路以 `terminated` 出现在结果里，由根 Agent 决定怎么办。
 *
 * @param {{
 *   subtasks: any[],
 *   runSubagent: any,
 *   registry?: any,
 *   context?: any,
 *   existingResults?: any[],
 *   maxConcurrent?: number,
 *   now?: () => number,
 * }} input
 */
export async function runAgentSubtaskFanout({
  subtasks, runSubagent, registry, context, existingResults = [], maxConcurrent, now = () => Date.now(),
}) {
  const { subtasks: unique, duplicates } = dedupeSubtasks(subtasks)
  const settled = new Map(existingResults
    .filter((item) => item?.status === 'completed' || item?.status === 'terminated')
    .map((item) => [item.id, item]))
  const batches = planSubtaskBatches(unique, { maxConcurrent })
  /** @type {any[]} */
  const results = []
  let reused = 0
  for (const batch of batches) {
    const outcomes = await Promise.all(batch.map(async (subtask) => {
      const existing = settled.get(subtask.id)
      if (existing) { reused += 1; return existing }
      return runAgentSubtask({ subtask, runSubagent, registry, context, now })
    }))
    results.push(...outcomes)
  }
  return {
    results,
    reused,
    /** 重复派发的子任务标识。静默去重会让「我明明派了 5 个」变成无从查证的问题。 */
    duplicates,
    completed: results.filter((item) => item.status === 'completed'),
    terminated: results.filter((item) => item.status === 'terminated'),
  }
}

/**
 * 扇出摘要。**终止的数量必须与完成的并列出现** —— 只报「拿到 3 份提案」会让人以为
 * 全部跑成功了，而实际可能有 2 路超时，结论是在残缺输入上得出的。
 *
 * @param {{ completed?: any[], terminated?: any[], reused?: number }} outcome
 * @param {string} [locale]
 */
export function subtaskFanoutSummary(outcome, locale = 'zh-CN') {
  const completed = outcome?.completed?.length ?? 0
  const terminated = outcome?.terminated?.length ?? 0
  const reused = outcome?.reused ?? 0
  const en = locale === 'en'
  const parts = [en ? `${completed} proposal(s)` : `${completed} 份提案`]
  if (terminated) {
    const reasons = [...new Set((outcome?.terminated ?? []).map((item) => item?.termination?.reason).filter(Boolean))]
    parts.push(en
      ? `${terminated} subtask(s) stopped early (${reasons.join(', ')})`
      : `${terminated} 个子任务提前终止（${reasons.join('、')}）`)
  }
  if (reused) parts.push(en ? `${reused} reused from a previous attempt` : `${reused} 个复用了上一次的结果`)
  return en ? `${parts.join('; ')}.` : `${parts.join('；')}。`
}
