// @ts-check

/**
 * 判断 queued Run 是否真的缺少下游 Job。已有 activeJobId / jobIds 的分支由
 * Generation Job 恢复器负责；这里只修复「Run 已落库，进程在首个 Job 前崩溃」
 * 以及多分支中尚未落 Job 的窗口。
 *
 * @param {any} run
 */
export function agentRunNeedsSubmissionRecovery(run) {
  return run?.status === 'queued' && (run.branches ?? []).some((branch) => {
    const jobIds = Array.isArray(branch?.jobIds) ? branch.jobIds : []
    return branch?.status === 'queued' && !branch.activeJobId && jobIds.length === 0
  })
}

/**
 * 恢复已持久化但尚未完成提交的 Agent Run。
 *
 * Store 按 id 稳定分页，避免固定 limit 前的「已有 Job queued Run」饥饿后续真孤儿。
 * submitGeneration 自身仍拥有配额、幂等 Job ID、Turn fence 和画布写回；清扫器
 * 只编排，不复制领域规则。
 *
 * @param {{
 *   productStore: any,
 *   submitGeneration: (userId: string, projectId: string, runId: string) => Promise<any>,
 *   cancelAgentRun?: (input: { userId: string, projectId: string, runId: string, requestedBy: string }) => Promise<any>,
 *   pageSize?: number,
 *   maximumPages?: number,
 *   observe?: (event: any) => void,
 * }} input
 */
export function createAgentRunSubmissionSweep({
  productStore,
  submitGeneration,
  cancelAgentRun,
  pageSize = 50,
  maximumPages = 20,
  observe,
}) {
  if (typeof productStore?.listQueuedAgentRunsForRecovery !== 'function'
    || typeof productStore?.readAgentTurn !== 'function') {
    throw new TypeError('Agent Run 提交恢复缺少 ProductStore 能力。')
  }
  if (typeof submitGeneration !== 'function') throw new TypeError('Agent Run 提交恢复缺少提交器。')
  const limit = Math.max(1, Math.min(200, Number(pageSize) || 50))
  const pages = Math.max(1, Math.min(100, Number(maximumPages) || 20))
  const report = (event) => {
    try { observe?.(event) } catch { /* 可观测性不得改变恢复结果。 */ }
  }
  // 跨 sweep 保留扫描位置。单轮 maximumPages 只是工作预算，不能让前缀中的
  // poison rows 每 30 秒都重新占满预算、永久饿死更大 id 的孤儿 Run。
  let recoveryCursor

  return async function sweepQueuedAgentRuns() {
    const summary = { scanned: 0, candidates: 0, submitted: 0, cancelled: 0, skipped: 0, failed: 0 }
    for (let page = 0; page < pages; page += 1) {
      const runs = await productStore.listQueuedAgentRunsForRecovery({ afterId: recoveryCursor, limit }) ?? []
      if (!runs.length) {
        recoveryCursor = undefined
        break
      }
      summary.scanned += runs.length
      for (const run of runs) {
        if (!agentRunNeedsSubmissionRecovery(run)) {
          summary.skipped += 1
          continue
        }
        summary.candidates += 1
        try {
          if (run.turnId) {
            const turn = await productStore.readAgentTurn(run.ownerId, run.turnId)
            if (!turn || turn.projectId !== run.projectId) {
              summary.failed += 1
              report({ event: 'agent.run.submit.invalid-turn', runId: run.id, projectId: run.projectId })
              continue
            }
            if (['cancelling', 'cancelled', 'failed'].includes(turn.status)) {
              if (typeof cancelAgentRun !== 'function') {
                summary.skipped += 1
                report({ event: 'agent.run.submit.cancellation-pending', runId: run.id, projectId: run.projectId })
                continue
              }
              await cancelAgentRun({
                userId: run.ownerId,
                projectId: run.projectId,
                runId: run.id,
                requestedBy: run.ownerId,
              })
              summary.cancelled += 1
              report({ event: 'agent.run.submit.cancelled', runId: run.id, projectId: run.projectId })
              continue
            }
            if (turn.status !== 'completed') {
              summary.skipped += 1
              continue
            }
          }
          await submitGeneration(run.ownerId, run.projectId, run.id)
          summary.submitted += 1
          report({ event: 'agent.run.submit.recovered', runId: run.id, projectId: run.projectId })
        } catch (caught) {
          summary.failed += 1
          report({
            event: 'agent.run.submit.failed',
            runId: run.id,
            projectId: run.projectId,
            code: /** @type {any} */ (caught)?.code ?? 'AGENT_RUN_SUBMISSION_RECOVERY_FAILED',
          })
        }
      }
      const nextCursor = runs.at(-1)?.id
      if (!nextCursor || nextCursor === recoveryCursor) {
        recoveryCursor = undefined
        report({ event: 'agent.run.submit.cursor-stalled', afterId: nextCursor })
        break
      }
      recoveryCursor = nextCursor
      if (runs.length < limit) {
        recoveryCursor = undefined
        break
      }
    }
    return summary
  }
}
