// @ts-check
import { stageError } from './executionTrace.mjs'
import { validateAgentTurnCheckpoint } from './agent/turn/agentTurnCheckpoint.mjs'

/** 非终态 Turn 状态。终态 Turn 不参与回收。 */
const RESUMABLE = new Set(['queued', 'running'])

/** 可以安全重放的工具能力。其余能力（含未知）一律不可重放。 */
const REPLAYABLE_RISKS = new Set(['read'])

/**
 * 判定结果必须是可判别联合，否则调用方在 `action === 'skip'` 之后无法窄化到
 * `fail` 分支 —— 对象字面量在 return 位置会被推成 `action: string`，判别失效。
 *
 * @typedef {{ action: 'skip', reason: 'missing_turn' | 'terminal' | 'within_lease' | 'waiting_user' }} TurnReclaimSkip
 * @typedef {{ action: 'cancel' }} TurnReclaimCancel
 * @typedef {{ action: 'resume', replayedToolCount: number }} TurnReclaimResume
 * @typedef {{ action: 'fail', stage: string, code: string, message?: string, recoverable?: boolean }} TurnReclaimFail
 * @typedef {TurnReclaimSkip | TurnReclaimCancel | TurnReclaimResume | TurnReclaimFail} TurnReclaimDecision
 */

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
 *   turn: { id?: string, status?: string, updatedAt?: number, checkpoint?: unknown },
 *   events?: Array<{ type?: string, payload?: { toolName?: string, status?: string, risk?: string } }>,
 *   toolRisk?: (toolName: string) => string | undefined,
 *   now?: number,
 *   leaseMs?: number,
 * }} input
 * @returns {TurnReclaimDecision}
 */
export function turnReclaimDecision(input) {
  const { turn, events = [], toolRisk, now = Date.now(), leaseMs = 120_000 } = input ?? {}
  if (!turn?.id) return { action: 'skip', reason: 'missing_turn' }
  if (turn.status === 'waiting_user') return { action: 'skip', reason: 'waiting_user' }
  if (turn.status === 'cancelling') return { action: 'cancel' }
  if (!RESUMABLE.has(String(turn.status))) return { action: 'skip', reason: 'terminal' }

  const updatedAt = Number(turn.updatedAt) || 0
  // 还在租约内说明可能仍有实例在推进它，不抢。
  if (now - updatedAt < leaseMs) return { action: 'skip', reason: 'within_lease' }

  // 新 Turn 的 checkpoint 已把「这一次调用实际采用的恢复模式」固定下来；它比
  // risk 更精确：generate_images/videos 虽标 costly，但这里只产规划结构，明确可
  // reexecute。只有没有 checkpoint 的历史 Turn 才回退到下方事件风险启发式。
  if (Object.hasOwn(turn, 'checkpoint') && turn.checkpoint !== undefined) {
    let checkpoint
    try {
      checkpoint = validateAgentTurnCheckpoint(turn.checkpoint)
    } catch {
      return {
        action: 'fail',
        ...stageError({
          stage: 'turn',
          code: 'AGENT_TURN_CHECKPOINT_INVALID',
          message: '该回合的恢复检查点已损坏，无法安全自动恢复，请重新发起。',
          recoverable: false,
        }),
      }
    }
    const calls = [
      ...checkpoint.completedSteps.flatMap((step) => step.calls),
      ...(checkpoint.pendingStep?.calls ?? []),
    ]
    // receipt 由 Worker resumer 严格读取持久化回执后恢复；它不是重放。只有 never
    // 没有恢复 seam，必须在取得 Turn 执行权前直接收敛为不可恢复。
    const never = calls.filter((call) => call.recovery === 'never')
    const blocking = [...new Set(never.map((call) => call.name))]
    if (blocking.length) {
      return {
        action: 'fail',
        ...stageError({
          stage: 'turn',
          code: 'AGENT_TURN_NOT_REPLAYABLE',
          message: `该回合包含当前恢复器无法安全处理的工具（${blocking.join('、')}），无法自动恢复，请重新发起。`,
          recoverable: false,
        }),
      }
    }
    return {
      action: 'resume',
      replayedToolCount: calls.filter((call) => call.recovery === 'reexecute').length,
    }
  }

  // 非读工具从 running 起结果就可能未知：进程可能在副作用生效后、成功回执前退出。
  // 没有 Receipt 能证明结果时，不能把 running 乐观当成“尚未执行”。
  const completedTools = events.flatMap((event) => {
    const status = event?.payload?.status
    if (event?.type !== 'turn.tool' || (status !== 'running' && status !== 'succeeded')) return []
    const name = event.payload?.toolName
    if (typeof name !== 'string' || !name) return []
    const toolName = /** @type {string} */ (name)
    // 事件自带的 risk 优先：它是该次调用实际适用的能力。工具名查找只作为
    // 早于该字段落地的历史事件的兜底，查不到时按未知处理（即不可重放）。
    const risk = typeof event.payload?.risk === 'string'
      ? event.payload.risk
      : (typeof toolRisk === 'function' ? toolRisk(toolName) : undefined)
    return [{ name: toolName, risk: risk ?? 'unknown' }]
  })

  const blocking = completedTools
    .filter((tool) => !REPLAYABLE_RISKS.has(tool.risk))
    .map((tool) => tool.name)

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
