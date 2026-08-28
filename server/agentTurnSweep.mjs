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
 *   settleTurn?: (turn: any, error: any) => Promise<unknown>,
 *   cancelTurn?: (turn: any) => Promise<unknown>,
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
  settleTurn,
  cancelTurn,
  toolRisk,
  leaseMs = 120_000,
  limit = 25,
  now = () => Date.now(),
  observe,
}) {
  if (!productStore) throw new TypeError('Turn 清扫缺少 ProductStore。')

  // Cursor 必须跨 sweep 保留。若每轮都从最老的一页重新开始，一条持续损坏、
  // 因而无法推进 updatedAt 的 poison Turn 会永久挡住后面的孤儿。
  /** @type {{ updatedAt: number, id: string } | undefined} */
  let after

  const report = (event) => {
    try { observe?.(event) } catch { /* 可观测性不得改变清扫结果。 */ }
  }

  async function failTurn(turn, error) {
    if (settleTurn) return settleTurn(turn, error)
    const saved = { ...turn, status: 'failed', updatedAt: now(), error }
    await productStore.putAgentTurn(turn.ownerId, saved)
    return saved
  }

  function settlementStatus(value) {
    return value?.turn?.status ?? value?.status
  }

  async function recordFailureSettlement(summary, turn, error, successEvent) {
    const settled = await failTurn(turn, error)
    let status = settlementStatus(settled)
    if (!status && typeof productStore.readAgentTurn === 'function') {
      status = (await productStore.readAgentTurn(turn.ownerId, turn.id))?.status
    }
    if (status === 'failed') {
      summary.failed += 1
      report(successEvent)
      return
    }
    if (status === 'cancelled') {
      summary.cancelled += 1
      report({ event: 'agent.turn.reclaim.cancelled', turnId: turn.id, projectId: turn.projectId })
      return
    }
    // takeover / cancellation fence 先胜出时，失败收口没有成功。保持真实状态，
    // 不把一次尝试误报为 durable failed。
    summary.skipped += 1
    report({
      event: 'agent.turn.reclaim.settle-raced',
      turnId: turn.id,
      projectId: turn.projectId,
      status,
    })
  }

  return async function sweepStaleAgentTurns() {
    const query = async () => productStore.listStaleAgentTurns({
      now: now(),
      leaseMs,
      limit,
      ...(after ? { after } : {}),
    })
    let stale = await query() ?? []

    // 走到尾部后立即 wrap，省掉一个空转周期；下一轮则继续从最老的一页开始。
    // 查询失败时不会走到这里，因此旧 cursor 会保留，重试不会悄悄跳过数据。
    if (stale.length === 0 && after) {
      after = undefined
      stale = await query() ?? []
    }
    const summary = { scanned: stale.length, resumed: 0, failed: 0, cancelled: 0, skipped: 0 }

    for (const turn of stale) {
      // 单个 Turn 失败不能中断整批清扫，否则一条坏数据会让所有孤儿永远得不到回收。
      try {
        if (['queued', 'running'].includes(turn?.status)
          && (!turn?.request || typeof turn.request !== 'object' || Array.isArray(turn.request))) {
          const error = stageError({
            stage: 'turn',
            code: 'AGENT_TURN_REQUEST_MISSING',
            message: '该回合没有可重放的请求快照，无法恢复，已安全收敛为失败。',
            recoverable: false,
          })
          await recordFailureSettlement(summary, turn, error, {
            event: 'agent.turn.reclaim.failed',
            turnId: turn.id,
            projectId: turn.projectId,
            code: error.code,
          })
          continue
        }
        // Subagent activation 的 FIFO、取消 generation 与 descriptor lease 由专用
        // Runtime 拥有。通用 Turn 清扫若直接 resume/cancel，会绕过 head fence，让
        // 后续 follow-up 抢跑；这里只让专用 runnable sweep 重新投递。
        if (turn?.request?.runtimeOperation === 'subagent') {
          summary.skipped += 1
          report({
            event: 'agent.turn.reclaim.deferred',
            owner: 'subagent-runtime',
            turnId: turn.id,
            projectId: turn.projectId,
          })
          continue
        }
        const events = await productStore.listAgentTurnEvents(turn.ownerId, turn.projectId, turn.id) ?? []
        const decision = turnReclaimDecision({ turn, events, toolRisk, now: now(), leaseMs })

        if (decision.action === 'skip') {
          summary.skipped += 1
          continue
        }
        if (decision.action === 'cancel') {
          if (cancelTurn) {
            const cancelled = await cancelTurn(turn)
            let status = settlementStatus(cancelled)
            if (!status && typeof productStore.readAgentTurn === 'function') {
              status = (await productStore.readAgentTurn(turn.ownerId, turn.id))?.status
            }
            if (status === 'cancelled') {
              summary.cancelled += 1
              report({ event: 'agent.turn.reclaim.cancelled', turnId: turn.id, projectId: turn.projectId })
            } else {
              summary.skipped += 1
              report({
                event: 'agent.turn.reclaim.cancellation-pending',
                turnId: turn.id,
                projectId: turn.projectId,
                status,
              })
            }
          } else {
            summary.skipped += 1
            report({ event: 'agent.turn.reclaim.cancellation-pending', turnId: turn.id, projectId: turn.projectId })
          }
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
          const error = stageError({
            stage: 'turn',
            code: 'AGENT_TURN_ABANDONED',
            message: '该回合可以恢复，但当前部署没有启用回合恢复，已收敛为失败，请重新发起。',
            recoverable: true,
          })
          await recordFailureSettlement(summary, turn, error, {
            event: 'agent.turn.reclaim.abandoned', turnId: turn.id, projectId: turn.projectId,
          })
          continue
        }
        // decision.action === 'fail'：判定自带 stage/code/message，直接落库。
        const error = {
          stage: decision.stage,
          code: decision.code,
          ...(decision.message ? { message: decision.message } : {}),
          ...(typeof decision.recoverable === 'boolean' ? { recoverable: decision.recoverable } : {}),
        }
        await recordFailureSettlement(summary, turn, error, {
          event: 'agent.turn.reclaim.failed', turnId: turn.id, projectId: turn.projectId, code: decision.code,
        })
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

    if (stale.length > 0) {
      const last = stale.at(-1)
      // 与 Store 的 legacy effective timestamp 同源：旧 Turn 可能只有 createdAt。
      const updatedAt = Number(last?.updatedAt ?? last?.createdAt) || 0
      // 满页说明后面可能还有数据；短页已经到尾部，下轮从头 wrap。
      after = stale.length >= limit && last?.id
        ? { updatedAt, id: String(last.id) }
        : undefined
    } else {
      after = undefined
    }
    return summary
  }
}
