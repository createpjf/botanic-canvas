// @ts-check
import { buildDeliveryManifest } from '../workflow/deliveryManifest.mjs'

export class AgentOutcomeStoreReadError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'AgentOutcomeStoreReadError'
    this.code = code
  }
}

const time = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return numeric
  const parsed = Date.parse(String(value))
  if (Number.isFinite(parsed)) return parsed
  throw new AgentOutcomeStoreReadError('AGENT_OUTCOME_WINDOW_INVALID', `无法解析时间：${value}`)
}

function inWindow(value, since, until) {
  const timestamp = Number(value)
  return Number.isFinite(timestamp) && timestamp >= since && timestamp < until
}

async function collectPages(readPage, label) {
  const result = []
  let afterId = null
  for (;;) {
    const page = await readPage({ ...(afterId ? { afterId } : {}), limit: 200 })
    if (!Array.isArray(page)) {
      throw new AgentOutcomeStoreReadError('AGENT_OUTCOME_PROJECT_FORBIDDEN', `无法读取项目的${label}。`)
    }
    if (!page.length) return result
    result.push(...page)
    if (page.length < 200) return result
    const next = page.at(-1)?.id
    if (typeof next !== 'string' || !next || next === afterId) {
      throw new AgentOutcomeStoreReadError('AGENT_OUTCOME_PAGE_INVALID', `${label}分页没有推进。`)
    }
    afterId = next
  }
}

function uniqueById(values) {
  return [...new Map(values.filter((value) => value?.id).map((value) => [value.id, value])).values()]
}

/**
 * 从真实 ProductStore 读取一个成员在项目时间窗口内发起的 Agent 请求及完整下游事实。
 * 时间窗口以 Turn.createdAt 为准；一旦 Turn 入窗，它关联的 Run/Job/Review/Delivery
 * 即使稍后完成也完整纳入，避免把跨窗口完成的任务截成“仍在执行”。
 *
 * @param {{
 *   productStore: any, userId: string, projectId: string,
 *   since?: number|string, until?: number|string, now?: number,
 * }} input
 */
export async function readAgentOutcomeSnapshot(input) {
  const { productStore, userId, projectId } = input ?? {}
  if (!productStore || typeof productStore !== 'object') throw new TypeError('AgentOutcome Store Reader 缺少 ProductStore。')
  if (!userId || !projectId) throw new TypeError('AgentOutcome Store Reader 缺少用户或项目标识。')
  const requiredMethods = [
    'readProject', 'listAgentTurnsForProjectPage', 'listAgentRunsForTurnPage',
    'listGenerationJobsForAgentRunPage', 'listAgentReviewTasksForRunPage',
  ]
  const missing = requiredMethods.filter((method) => typeof productStore[method] !== 'function')
  if (missing.length) {
    throw new AgentOutcomeStoreReadError('AGENT_OUTCOME_STORE_CAPABILITY_MISSING', `ProductStore 缺少只读能力：${missing.join('、')}`)
  }

  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now()
  const since = time(input.since, 0)
  const until = time(input.until, now + 1)
  if (since < 0 || until <= since) {
    throw new AgentOutcomeStoreReadError('AGENT_OUTCOME_WINDOW_INVALID', 'AgentOutcome 时间窗口必须满足 0 ≤ since < until。')
  }

  const project = await productStore.readProject(userId, projectId)
  if (!project?.document) {
    throw new AgentOutcomeStoreReadError('AGENT_OUTCOME_PROJECT_FORBIDDEN', '项目不存在或当前用户没有读取权限。')
  }
  const allTurns = await collectPages(
    (page) => productStore.listAgentTurnsForProjectPage(userId, projectId, { ...page, since, until }),
    'Agent Turn',
  )
  const turns = allTurns.filter((turn) => inWindow(turn?.createdAt, since, until))
  const runs = uniqueById((await Promise.all(turns.map((turn) => collectPages(
    (page) => productStore.listAgentRunsForTurnPage(userId, projectId, turn.id, page),
    `Turn ${turn.id} 的 Agent Run`,
  )))).flat())
  const jobs = uniqueById((await Promise.all(runs.map((run) => collectPages(
    (page) => productStore.listGenerationJobsForAgentRunPage(userId, projectId, run.id, page),
    `Run ${run.id} 的 Generation Job`,
  )))).flat())
  const reviewTasks = uniqueById((await Promise.all(runs.map((run) => collectPages(
    (page) => productStore.listAgentReviewTasksForRunPage(userId, projectId, run.id, page),
    `Run ${run.id} 的 Review Task`,
  )))).flat())

  const selectedJobIds = new Set(jobs.map((job) => job.id))
  const workflowRuns = Array.isArray(project.document.productionWorkflowRuns)
    ? project.document.productionWorkflowRuns : []
  const jobsById = new Map(jobs.map((job) => [job.id, job]))
  const reviewsByRun = new Map()
  for (const task of reviewTasks) {
    const group = reviewsByRun.get(task.runId) ?? []
    group.push(task)
    reviewsByRun.set(task.runId, group)
  }
  const manifests = workflowRuns
    .filter((run) => (run?.items ?? []).some((item) => selectedJobIds.has(item?.jobId)))
    .map((run) => {
      const runJobs = (run.items ?? []).map((item) => jobsById.get(item?.jobId)).filter(Boolean)
      const runReviews = runJobs.flatMap((job) => reviewsByRun.get(job?.agentRun?.runId) ?? [])
      return buildDeliveryManifest({ run, jobs: runJobs, reviewTasks: uniqueById(runReviews), now })
    })

  return {
    version: 1,
    projectId,
    userId,
    window: { since, until },
    turns,
    runs,
    jobs,
    reviewTasks,
    manifests,
  }
}
