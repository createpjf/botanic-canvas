// @ts-check
import { stageError } from './executionTrace.mjs'
import { turnReclaimDecision } from './turnReclaim.mjs'

/**
 * 孤儿 Turn 清扫。策略判定在 `turnReclaim.mjs`（纯、已测），这里只负责 I/O 编排：
 * 捞出陈旧 Turn、取事件、按判定写回。
 *
 * `resumeTurn` 与 `toolRisk` 都是可选注入：
 * - 没有 `toolRisk` 时所有工具都判不出能力，按最高风险处理 → 一律不可重放。
 * - 没有 `resumeTurn` 时即使判定可恢复也无人恢复。此时仍收敛为失败，但用
 *   `AGENT_TURN_ABANDONED` 与真正不可重放的 `AGENT_TURN_NOT_REPLAYABLE` 区分开。
 *   把它留在 running 不动才是更糟的选择 —— 那正是要修的孤儿问题，而且没有任何
 *   信号说明它为什么不动。
 *
 * @param {{
 *   productStore: any,
 *   resumeTurn?: (turn: any) => Promise<unknown>,
 *   toolRisk?: (toolName: string) => string | undefined,
 *   leaseMs?: number,
 *   limit?: number,
 *   now?: () => number,
 *   observe?: (event: any) => void,
 * }} deps
 */
export function createAgentTurnSweep({
  productStore,
  resumeTurn,
  toolRisk,
  leaseMs = 120_000,
  limit = 25,
  now = () => Date.now(),
  observe,
}) {
  if (!productStore) throw new TypeError('Turn 清扫缺少 ProductStore。')

  const report = (event) => {
    try { observe?.(event) } catch { /* 可观测性不得改变清扫结果。 */ }
  }

  async function failTurn(turn, error) {
    const saved = { ...turn, status: 'failed', updatedAt: now(), error }
    await productStore.putAgentTurn(turn.ownerId, saved)
    return saved
  }

  return async function sweepStaleAgentTurns() {
    const stale = await productStore.listStaleAgentTurns({ now: now(), leaseMs, limit }) ?? []
    const summary = { scanned: stale.length, resumed: 0, failed: 0, skipped: 0 }

    for (const turn of stale) {
      // 单个 Turn 失败不能中断整批清扫，否则一条坏数据会让所有孤儿永远得不到回收。
      try {
        const events = await productStore.listAgentTurnEvents(turn.ownerId, turn.projectId, turn.id) ?? []
        const decision = turnReclaimDecision({ turn, events, toolRisk, now: now(), leaseMs })

        if (decision.action === 'skip') {
          summary.skipped += 1
          continue
        }
        if (decision.action === 'resume') {
          if (resumeTurn) {
            await resumeTurn(turn)
            summary.resumed += 1
            report({ event: 'agent.turn.reclaim.resumed', turnId: turn.id, projectId: turn.projectId })
            continue
          }
          // 可重放但当前没有恢复能力：仍然收敛，但原因与真正不可重放区分开。
          await failTurn(turn, stageError({
            stage: 'turn',
            code: 'AGENT_TURN_ABANDONED',
            message: '该回合可以恢复，但当前部署没有启用回合恢复，已收敛为失败，请重新发起。',
            recoverable: true,
          }))
          summary.failed += 1
          report({ event: 'agent.turn.reclaim.abandoned', turnId: turn.id, projectId: turn.projectId })
          continue
        }
        // decision.action === 'fail'：判定自带 stage/code/message，直接落库。
        await failTurn(turn, {
          stage: decision.stage,
          code: decision.code,
          ...(decision.message ? { message: decision.message } : {}),
          ...(typeof decision.recoverable === 'boolean' ? { recoverable: decision.recoverable } : {}),
        })
        summary.failed += 1
        report({ event: 'agent.turn.reclaim.failed', turnId: turn.id, projectId: turn.projectId, code: decision.code })
      } catch (caught) {
        summary.skipped += 1
        report({
          event: 'agent.turn.reclaim.error',
          turnId: turn?.id,
          projectId: turn?.projectId,
          code: /** @type {any} */ (caught)?.code ?? 'AGENT_TURN_RECLAIM_FAILED',
        })
      }
    }
    return summary
  }
}
