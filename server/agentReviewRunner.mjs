// @ts-check
import { reviewDeterministicLayer, shouldRunModelLayer } from './agentReviewDeterministic.mjs'
import {
  agentReviewTaskCompletion,
  createAgentReviewResult,
  createAgentReviewTask,
  planReviewCoverage,
  settleAgentReviewTask,
} from './agentReviewTask.mjs'
import { generationArtifactId } from './productionWorkflow.mjs'
import { compiledBranchFromRun } from './creativePlanResolver.mjs'

/**
 * 评审执行器：把一个已到执行终态的 Run 评完（ADR 0006）。
 *
 * 它**从不**改写 Run 或 Job 的状态。评审失败只阻止候选进入「可交付」，不能把已经
 * 成功持久化的 Run 改回失败 —— 把执行状态和评审状态压进一个字段，一次评审模型超时
 * 就会看起来像生成失败。
 *
 * 模型层由 `reviewCandidate` 注入，因此本模块可以在没有 Provider 的情况下测试；
 * 缺注入时模型层判「无法验证」而不是默认通过。
 */

/** 从 Run 与它的 Job 里列出全部最终候选。视频与图片一视同仁，不按媒体类型隐式排除。 */
/** @param {any} run @param {any[]} [jobs] */
export function reviewCandidatesFromRun(run, jobs = []) {
  const branchByJobId = new Map()
  for (const branch of run?.branches ?? []) {
    for (const jobId of branch.jobIds ?? []) branchByJobId.set(jobId, branch.id)
    if (branch.activeJobId) branchByJobId.set(branch.activeJobId, branch.id)
  }
  return jobs
    .filter((job) => job?.agentRun?.runId === run?.id && job.status === 'succeeded')
    .flatMap((job) => (job.outputs ?? [])
      .filter((output) => output?.id)
      .map((output) => ({
        artifactId: generationArtifactId(job.id, output.id),
        branchId: job.agentRun?.branchId ?? branchByJobId.get(job.id),
        jobId: job.id,
        output,
        settings: job.settings,
        branchFingerprint: job.branchFingerprint,
      })))
}

/**
 * 为一个终态 Run 建立评审任务。质量策略来自 Run 的编译快照 —— 取不到就不建任务，
 * 而不是退回硬编码 rubric。
 */
/** @param {{ run: any, jobs?: any[], coverage?: any, now?: number }} input */
export function buildReviewTaskForRun({ run, jobs = [], coverage, now = Date.now() }) {
  const candidates = reviewCandidatesFromRun(run, jobs)
  if (!candidates.length) return undefined
  const compiledBranch = compiledBranchFromRun(run, candidates[0].branchId)
  const qualityPolicy = compiledBranch?.qualityPolicy
  if (!qualityPolicy) return undefined
  return {
    task: createAgentReviewTask({
      runId: run.id,
      projectId: run.projectId,
      ownerId: run.ownerId,
      qualityPolicy,
      planFingerprint: run.compiledPlan?.planFingerprint,
      coverage: coverage ?? planReviewCoverage({ candidates }),
      now,
    }),
    candidates,
  }
}

/**
 * 执行一次评审任务。
 *
 * @param {{
 *   task: any,
 *   candidates?: Array<any>,
 *   existingResults?: Array<any>,
 *   reviewCandidate?: (input: { candidate: any, task: any }) => Promise<{ criteria?: Array<any>, revisionProposal?: any }>,
 *   now?: () => number,
 * }} input
 */
export async function runAgentReviewTask({
  task, candidates = [], existingResults = [], reviewCandidate, now = () => Date.now(),
}) {
  const started = settleAgentReviewTask(task, { status: 'running', now: now() })
  const byArtifactId = new Map(candidates.map((candidate) => [candidate.artifactId, candidate]))
  /** @type {any[]} */
  const results = [...existingResults.filter((item) => item.taskId === task.id)]
  const done = new Set(results.map((item) => item.artifactId))
  /** @type {Array<{ artifactId: string, code: string, message: string }>} */
  const failures = []

  for (const artifactId of started.coverage?.artifactIds ?? []) {
    if (done.has(artifactId)) continue
    const candidate = byArtifactId.get(artifactId)
    if (!candidate) {
      // 覆盖清单里有、候选里没有：说明结果被删或对不上，照实记为无法验证而不是跳过。
      results.push(createAgentReviewResult({
        taskId: started.id, projectId: started.projectId, artifactId,
        qualityPolicyFingerprint: started.qualityPolicyFingerprint,
        criteria: [{ id: 'file_integrity', layer: 'deterministic', verdict: 'unverifiable', evidence: '找不到对应的输出记录。' }],
        now: now(),
      }))
      continue
    }
    const deterministic = reviewDeterministicLayer({ output: candidate.output, settings: candidate.settings })
    /** @type {Array<{ id: string, layer: string, verdict: string, evidence?: string }>} */
    const criteria = [...deterministic.criteria]
    let revisionProposal
    if (shouldRunModelLayer(deterministic)) {
      if (typeof reviewCandidate !== 'function') {
        // 没有模型层可用时照实说，不把「没评」当成「评过且通过」。
        criteria.push({ id: 'semantic_review', layer: 'model', verdict: 'unverifiable', evidence: '未配置视觉评审模型。' })
      } else {
        try {
          const judged = await reviewCandidate({ candidate, task: started })
          criteria.push(...(judged?.criteria ?? []))
          revisionProposal = judged?.revisionProposal
        } catch (caught) {
          // 区分「模型不可用」与「输出不可解析」：两者都要能被诊断，不能收敛成空结果。
          const code = /** @type {any} */ (caught)?.code === 'REVIEW_OUTPUT_UNPARSABLE'
            ? 'REVIEW_OUTPUT_UNPARSABLE'
            : 'REVIEW_MODEL_UNAVAILABLE'
          failures.push({ artifactId, code, message: caught instanceof Error ? caught.message : String(caught) })
          criteria.push({ id: 'semantic_review', layer: 'model', verdict: 'unverifiable', evidence: `${code}` })
        }
      }
    }
    results.push(createAgentReviewResult({
      taskId: started.id,
      projectId: started.projectId,
      artifactId,
      branchFingerprint: candidate.branchFingerprint,
      qualityPolicyFingerprint: started.qualityPolicyFingerprint,
      criteria,
      ...(revisionProposal ? { revisionProposal } : {}),
      now: now(),
    }))
  }

  const completion = agentReviewTaskCompletion(started, results)
  // 只有覆盖范围内每个候选都产出结论才收 completed；否则是可诊断、可重试的 failed。
  const settled = completion.complete
    ? settleAgentReviewTask(started, { status: 'completed', now: now() })
    : settleAgentReviewTask(started, {
      status: 'failed',
      error: { code: 'REVIEW_INCOMPLETE', message: `仍有 ${completion.missing.length} 个候选没有评审结论。` },
      now: now(),
    })
  return { task: { ...settled, results }, results, failures, completion }
}
