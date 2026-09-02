// @ts-check
import { branchesEligibleForRetry } from './agentBranchRetryPolicy.mjs'
import { generationIdempotencyKey } from './generation/generationIdempotency.mjs'
import { boundedSweepPageSize, nextUpdatedAtIdSweepCursor } from './updatedAtIdSweepCursor.mjs'

/**
 * 失败分支自动重试的周期清扫（Epic 5）。
 *
 * 关掉浏览器后失败分支仍能重试，靠的就是这条路径。它**只做策略允许的事**：
 * 不可重试的错误、高成本重试和预算不足都会停下等用户，并把原因记进日志 ——
 * 「为什么它没自动重试」必须能回答。
 *
 * 重试本身走共享的分支重试服务，因此与手动重试共用同一套幂等键，不会重复扣费。
 */

/**
 * 自动重试的幂等键。
 *
 * 由 `(runId, branchId, attempt)` 派生而不是随机生成：同一次清扫被重复投递、
 * 或多个 Worker 实例同时扫到同一个分支时，它们算出同一个键 → 同一个 Job，
 * 因此只会有一次真实提交。
 */
export function automaticRetryIdempotencyKey(runId, branchId, attempt) {
  return generationIdempotencyKey(`auto-retry__${runId}__${branchId}__attempt-${Number(attempt) || 0}`)
}

/**
 * @param {{
 *   productStore: any,
 *   retryAgentBranch: (input: any) => Promise<any>,
 *   policy?: any,
 *   observe?: (event: any) => void,
 *   now?: () => number,
 * }} input
 */
export function createAgentBranchRetrySweep({ productStore, retryAgentBranch, policy, observe = () => {}, now = () => Date.now() }) {
  if (!productStore) throw new TypeError('分支重试清扫缺少 ProductStore。')
  if (typeof retryAgentBranch !== 'function') throw new TypeError('分支重试清扫缺少重试实现。')

  /**
   * 已记录过的 held 原因：`${runId}:${branchId}` → reason。
   *
   * 清扫每 90 秒跑一次，而 `error_not_retryable` 这类原因**永远不会变** ——
   * 生产上同一个死分支连刷了 40 分钟以上，每 90 秒一条。原因未变就不再重记。
   *
   * 只在进程内存里：Worker 重启后会再记一次当前状态，这是想要的行为
   * （新进程该把它看到的状态说一次），不是缺陷。
   */
  const loggedHeldReasons = new Map()
  let after = null

  return async function sweepFailedBranches({ limit = 25 } = {}) {
    const pageLimit = boundedSweepPageSize(limit)
    const requestedAfter = after
    const runs = (await productStore.listRunsWithFailedBranches({ after: requestedAfter, limit: pageLimit })) ?? []
    const progression = nextUpdatedAtIdSweepCursor({ after: requestedAfter, page: runs, limit: pageLimit })
    after = progression.after
    if (progression.stalled) {
      observe({ event: 'agent.branch.retry.sweep.cursor_stalled', after: requestedAfter })
    }
    let retried = 0
    let held = 0
    for (const entry of runs) {
      try {
        const run = await productStore.readAgentRunForWorker(entry.runId) ?? await productStore.readAgentRun(entry.ownerId, entry.runId)
        if (!run) continue
        const jobs = new Map()
        for (const branch of run.branches ?? []) {
          if (!branch?.activeJobId) continue
          const job = await productStore.readGenerationJobForWorker(branch.activeJobId)
            ?? await productStore.readGenerationJob(run.ownerId, branch.activeJobId)
          if (job) jobs.set(branch.activeJobId, job)
        }
        const outcome = branchesEligibleForRetry({ run, jobs, policy, now: now() })
        for (const entryHeld of outcome.held) {
          held += 1
          // 分支被手动重试（清扫之外）会推进 attempt；键里带上它，否则同一分支
          // 「换一次尝试、又撞上同一个 held 原因」会被误当成没变化而漏记。
          const heldBranch = run.branches.find((item) => item.id === entryHeld.branchId)
          const key = `${run.id}:${entryHeld.branchId}:${heldBranch?.attempt ?? 0}`
          if (loggedHeldReasons.get(key) === entryHeld.reason) continue
          loggedHeldReasons.set(key, entryHeld.reason)
          // 停下的原因进日志：用户与运维都要能回答「为什么它没自动重试」。
          // 但只在原因**变化**时记 —— 重复同一条不增加任何信息。
          observe({ event: 'agent.branch.retry.held', runId: run.id, branchId: entryHeld.branchId, reason: entryHeld.reason })
        }
        for (const candidate of outcome.eligible) {
          const branch = run.branches.find((item) => item.id === candidate.branchId)
          // 这一支要重跑了，之前的 held 记录作废；下次再停下要重新记一条。
          loggedHeldReasons.delete(`${run.id}:${candidate.branchId}:${branch?.attempt ?? 0}`)
          const result = await retryAgentBranch({
            userId: run.ownerId,
            runId: run.id,
            branchId: candidate.branchId,
            idempotencyKey: automaticRetryIdempotencyKey(run.id, candidate.branchId, branch?.attempt ?? 0),
            requestId: 'auto-retry',
          })
          if (result?.kind === 'error') {
            observe({ event: 'agent.branch.retry.failed', runId: run.id, branchId: candidate.branchId, code: result.code })
            continue
          }
          retried += result?.kind === 'queued' ? 1 : 0
          observe({
            event: 'agent.branch.retry.automatic',
            runId: run.id,
            branchId: candidate.branchId,
            reused: result?.kind === 'reused',
          })
        }
      } catch (caught) {
        // 一个 Run 出错不能挡住整批清扫。
        observe({
          event: 'agent.branch.retry.sweep.failed',
          runId: entry.runId,
          message: caught instanceof Error ? caught.message : String(caught),
        })
      }
    }
    return { scanned: runs.length, retried, held }
  }
}
