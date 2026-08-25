// @ts-check
import { buildReviewTaskForRun, runAgentReviewTask } from './agentReviewRunner.mjs'
import { settleAgentReviewTask } from './agentReviewTask.mjs'

/**
 * 评审任务的持久化编排。
 *
 * 与执行状态的边界在这里守住：本模块只读 Run/Job，只写评审任务 —— 评审失败或等待
 * 人工都不得把已成功持久化的 Run 改回失败（ADR 0006）。
 */

const terminalRunStatuses = new Set(['completed', 'partial'])

/**
 * @param {{
 *   productStore: any,
 *   reviewCandidate?: (input: { candidate: any, task: any }) => Promise<any>,
 *   observe?: (event: any) => void,
 *   now?: () => number,
 * }} input
 */
export function createAgentReviewService({ productStore, reviewCandidate, observe = () => {}, now = () => Date.now() }) {
  if (!productStore) throw new TypeError('评审服务缺少 ProductStore。')

  async function jobsForRun(userId, run) {
    const jobIds = [...new Set((run.branches ?? []).flatMap((branch) => branch.jobIds ?? []).filter(Boolean))]
    const jobs = await Promise.all(jobIds.map((jobId) => productStore.readGenerationJob(userId, jobId)))
    return jobs.filter(Boolean)
  }

  /**
   * Run 到执行终态后建立评审任务。已存在则原样返回 —— 任务标识由
   * (runId, qualityPolicyFingerprint) 决定，重复调用不会产生第二份。
   */
  async function ensureReviewTaskForRun(userId, runId) {
    const run = await productStore.readAgentRun(userId, runId)
    if (!run || !terminalRunStatuses.has(run.status)) return undefined
    const existing = (await productStore.listAgentReviewTasksForRun(userId, run.projectId, run.id)) ?? []
    if (existing.length) return existing[0]
    const built = buildReviewTaskForRun({ run, jobs: await jobsForRun(userId, run), now: now() })
    if (!built) {
      // 没有编译快照或没有成功候选：不建任务，也不伪造一份 rubric。
      observe({ event: 'agent.review.skipped', runId, projectId: run.projectId })
      return undefined
    }
    const stored = await productStore.putAgentReviewTask(userId, built.task)
    observe({ event: 'agent.review.created', runId, projectId: run.projectId, taskId: stored.id, coverage: stored.coverage })
    return stored
  }

  /** 执行一个评审任务并落库。任务本身的失败是可诊断、可重试的失败。 */
  async function executeReviewTask(userId, taskId) {
    const task = await productStore.readAgentReviewTask(userId, taskId)
    if (!task || task.status === 'completed') return task
    const run = await productStore.readAgentRun(task.ownerId ?? userId, task.runId)
    if (!run) {
      const failed = settleAgentReviewTask(task, {
        status: 'failed',
        error: { code: 'AGENT_RUN_NOT_FOUND', message: '评审任务对应的 Run 已不存在。' },
        now: now(),
      })
      return productStore.putAgentReviewTask(userId, failed)
    }
    const built = buildReviewTaskForRun({ run, jobs: await jobsForRun(task.ownerId ?? userId, run), now: now() })
    const outcome = await runAgentReviewTask({
      task,
      candidates: built?.candidates ?? [],
      // 断点续评：已产出的结论不重评，避免重复调用视觉模型。
      existingResults: task.results ?? [],
      reviewCandidate,
      now,
    })
    const stored = await productStore.putAgentReviewTask(userId, outcome.task)
    observe({
      event: 'agent.review.settled',
      taskId: stored.id,
      runId: stored.runId,
      projectId: stored.projectId,
      status: stored.status,
      reviewed: outcome.results.length,
      skipped: stored.coverage?.skippedCandidates ?? 0,
      failures: outcome.failures.length,
    })
    return stored
  }

  /**
   * 清扫未收口的评审任务。浏览器关掉后评审仍要推进，靠的就是这条路径。
   */
  /** @param {{ olderThan?: number, limit?: number }} [input] */
  async function sweepPendingReviewTasks({ olderThan, limit = 25 } = {}) {
    const pending = (await productStore.listPendingAgentReviewTasks({ olderThan: olderThan ?? now(), limit })) ?? []
    const settled = []
    for (const task of pending) {
      try {
        settled.push(await executeReviewTask(task.ownerId, task.id))
      } catch (caught) {
        // 一个坏任务不能挡住整批清扫。
        observe({
          event: 'agent.review.sweep.failed',
          taskId: task.id,
          message: caught instanceof Error ? caught.message : String(caught),
        })
      }
    }
    return { scanned: pending.length, settled: settled.filter(Boolean).length }
  }

  return { ensureReviewTaskForRun, executeReviewTask, sweepPendingReviewTasks }
}
