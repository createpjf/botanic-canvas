// @ts-check
import { stageError } from './executionTrace.mjs'

/** 非终态 Turn 状态。终态 Turn 不参与回收。 */
const NON_TERMINAL = new Set(['queued', 'running', 'waiting_user', 'cancelling'])

/** 可以安全重放的工具能力。其余能力（含未知）一律不可重放。 */
const REPLAYABLE_RISKS = new Set(['read'])

/**
 * 判定一个超过租约未推进的 Turn 该怎么处理。ADR 0004 的可重放性规则在这里落地：
 *
 * - `read` 工具幂等且不计费，恢复时重新执行即可，因此不阻碍恢复。
 * - `write` / `costly` / `external` 已执行过就不能重放 —— 重跑一个 costly 工具
 *   就是重复计费，而这正是恢复机制要避免的事。
 * - 能力查不到时按最高风险处理（与 Skill 治理对未知能力的处理一致），
 *   即视为不可重放，而不是乐观地当成只读。
 *
 * 判不出来能否安全恢复时收敛为失败并说明原因。**明确的不可恢复优于静默重跑。**
 *
 * @param {{
 *   turn: { id?: string, status?: string, updatedAt?: number },
 *   events?: Array<{ type?: string, payload?: { toolName?: string, status?: string } }>,
 *   toolRisk?: (toolName: string) => string | undefined,
 *   now?: number,
 *   leaseMs?: number,
 * }} input
 */
export function turnReclaimDecision(input) {
  const { turn, events = [], toolRisk, now = Date.now(), leaseMs = 120_000 } = input ?? {}
  if (!turn?.id) return { action: 'skip', reason: 'missing_turn' }
  if (!NON_TERMINAL.has(String(turn.status))) return { action: 'skip', reason: 'terminal' }

  const updatedAt = Number(turn.updatedAt) || 0
  // 还在租约内说明可能仍有实例在推进它，不抢。
  if (now - updatedAt < leaseMs) return { action: 'skip', reason: 'within_lease' }

  // 只有「已成功执行完」的工具才构成重放障碍。running 状态的工具没有产生
  // 副作用保证，按未完成处理；failed 的也没有成功副作用。
  const completedTools = events.flatMap((event) => {
    if (event?.type !== 'turn.tool' || event.payload?.status !== 'succeeded') return []
    const name = event.payload?.toolName
    return typeof name === 'string' && name ? [name] : []
  })

  const blocking = completedTools.filter((name) => !REPLAYABLE_RISKS.has(
    (typeof toolRisk === 'function' ? toolRisk(name) : undefined) ?? 'unknown',
  ))

  if (blocking.length) {
    return {
      action: 'fail',
      ...stageError({
        stage: 'turn',
        code: 'AGENT_TURN_NOT_REPLAYABLE',
        // 只报工具名，不报参数或输出。
        message: `该回合已执行不可重放的工具（${[...new Set(blocking)].join('、')}），无法自动恢复，请重新发起。`,
        recoverable: false,
      }),
    }
  }
  return { action: 'resume', replayedToolCount: completedTools.length }
}
