// @ts-check
import { applyWorkflowItemResult, generationArtifactId } from './productionWorkflow.mjs'

/**
 * 工作流的主动推进（Epic 7）。
 *
 * 在此之前，运行状态只在**有人打开页面发 GET** 时才被对账 —— 关掉页面，一批已经
 * 生成完的工作流会永远停在 `running`，质量门也永远等不到。这里把同一份对账放到
 * Worker 侧周期执行，因此「页面无人打开时 Workflow 仍能推进到终态」成立。
 *
 * 它只读 Job、只写工作流运行：生成任务的执行状态不由这里改写。
 */

const activeRunStatuses = new Set(['queued', 'running', 'paused', 'awaiting_review'])

/**
 * 按任务真实状态对账一次运行的所有项。
 *
 * @param {{ run: any, jobs: Map<string, any> | Record<string, any>, document?: any, now?: number }} input
 */
export function reconcileWorkflowRunItems({ run, jobs, document, now = Date.now() }) {
  const lookup = jobs instanceof Map ? jobs : new Map(Object.entries(jobs ?? {}))
  const nodes = Array.isArray(document?.nodes) ? document.nodes : []
  let next = run
  let changed = false
  for (const item of run?.items ?? []) {
    if (!item?.jobId) continue
    const job = lookup.get(item.jobId)
    if (!job) continue
    // 生成任务的 queued 在工作流里表示「已接管、等待 Worker」，不是未知状态。
    const workflowStatus = job.status === 'queued' ? 'running' : job.status
    if (item.status === workflowStatus) continue
    next = applyWorkflowItemResult(next, item.id, {
      status: workflowStatus,
      jobId: job.id,
      artifactIds: (job.outputs ?? []).map((output) => generationArtifactId(job.id, output.id)),
      canvasNodeIds: nodes.filter((node) => node?.type === 'result' && node?.data?.jobId === job.id).map((node) => node.id),
      ...(job.error ? { error: { code: 'GENERATION_FAILED', message: job.error } } : {}),
    }, { now })
    changed = true
  }
  return { run: next, changed }
}

/**
 * 一次推进。
 *
 * 运行状态与质量门的收敛**不在这里重算** —— `applyWorkflowItemResult` 已经拥有那套
 * 判定（含「全部成功且需要质量门时进 awaiting_review」）。这里再写一份迟早会和它
 * 漂移，因此本模块只负责「按真实任务状态对账」这一件此前缺失的事。
 */
/** @param {{ run: any, jobs: Map<string, any> | Record<string, any>, document?: any, now?: number }} input */
export function advanceProductionWorkflowRun({ run, jobs, document, now = Date.now() }) {
  // 暂停中与等待评审的运行不自动推进：用户按下暂停就是要它停在那里，等待评审要等人。
  if (run?.status === 'paused' || run?.status === 'awaiting_review') return { run, changed: false }
  return reconcileWorkflowRunItems({ run, jobs, document, now })
}

/**
 * 周期清扫：把所有未收口的工作流运行推进一轮。
 *
 * @param {{
 *   productStore: any,
 *   observe?: (event: any) => void,
 *   now?: () => number,
 * }} input
 */
export function createProductionWorkflowSweep({ productStore, observe = () => {}, now = () => Date.now() }) {
  if (!productStore) throw new TypeError('工作流推进缺少 ProductStore。')
  return async function sweepProductionWorkflows({ limit = 25 } = {}) {
    const projects = (await productStore.listProjectsWithActiveWorkflowRuns?.({ limit })) ?? []
    let advanced = 0
    for (const entry of projects) {
      try {
        const project = await productStore.readProject(entry.ownerId, entry.projectId)
        if (!project) continue
        const runs = project.document.productionWorkflowRuns ?? []
        const jobIds = [...new Set(runs.flatMap((run) => (run.items ?? []).map((item) => item.jobId).filter(Boolean)))]
        const jobs = new Map()
        for (const jobId of jobIds) {
          const job = await productStore.readGenerationJob(entry.ownerId, jobId)
          if (job) jobs.set(jobId, job)
        }
        let changedAny = false
        const nextRuns = runs.map((run) => {
          if (!activeRunStatuses.has(run.status)) return run
          const outcome = advanceProductionWorkflowRun({ run, jobs, document: project.document, now: now() })
          if (outcome.changed) changedAny = true
          return outcome.run
        })
        if (!changedAny) continue
        await productStore.writeProject(
          entry.ownerId,
          { ...project.document, productionWorkflowRuns: nextRuns },
          project.revision,
          project.graphRevision,
        )
        advanced += 1
        observe({ event: 'workflow.advanced', projectId: entry.projectId })
      } catch (caught) {
        // 一个项目推进失败不能挡住其他项目。
        observe({
          event: 'workflow.advance.failed',
          projectId: entry.projectId,
          message: caught instanceof Error ? caught.message : String(caught),
        })
      }
    }
    return { scanned: projects.length, advanced }
  }
}
