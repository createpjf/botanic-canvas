import type { BotanicAgentMessage, BotanicAgentRun } from './agent.ts'
import type { GenerationJob } from './canvas.ts'
import { botanicAgentBranchId, botanicAgentSubmissionKey } from './agentRuntimeFeed.ts'
import { generationCancellationPending } from './generationCancelCopy.ts'

/** 只读核对停止事实；Run 终态或刷新成功本身不代表 Worker 已释放。 */
export function agentRunStopConfirmed(run: Pick<BotanicAgentRun, 'status' | 'branches'> | undefined, jobs: readonly GenerationJob[]) {
  if (!run || !['completed', 'partial', 'failed', 'cancelled'].includes(run.status) || !run.branches) return false
  return run.branches.every(branch => {
    if (!['succeeded', 'failed', 'cancelled'].includes(branch.status)) return false
    if (!branch.activeJobId) return branch.jobIds.length === 0
    const job = jobs.find(job => job.id === branch.activeJobId)
    if (!job || generationCancellationPending(job.cancel)) return false
    return job.status === 'succeeded' || job.status === 'failed'
      || job.status === 'cancelled' && Boolean(job.cancel)
  })
}

/** 旧计划没有 Turn 时，仍只按已冻结的提交身份寻找 Run，不按提示词或“最新任务”猜测。 */
export function agentPlanCancellationRun(message: BotanicAgentMessage, runs: readonly BotanicAgentRun[]) {
  if (message.runId) return runs.find((run) => run.id === message.runId)
  if (!message.plan) return undefined
  const branchId = botanicAgentBranchId(botanicAgentSubmissionKey(message.id, message.plan), 0)
  const matches = runs.filter((run) => run.branches.some((branch) => branch.id === branchId))
  return matches.length === 1 ? matches[0] : undefined
}

export function isAgentRunStopMessage(message: BotanicAgentMessage) {
  return message.id.startsWith('agent-run-stop-') && message.kind === 'notice' && Boolean(message.runId)
    && Number.isFinite(message.turnCancellationRequestedAt)
}

export function agentPlanCancellationPending(message: BotanicAgentMessage, run: BotanicAgentRun, jobs: readonly GenerationJob[], messages: readonly BotanicAgentMessage[] = []) {
  const requestedAt = message.turnCancellationRequestedAt
  if (!Number.isFinite(requestedAt)) return false
  // 请求是否已处理与 Run 是否终态分开；恢复只重复同一取消接口。
  if (isAgentRunStopMessage(message)) return message.status !== 'answered'
  if (messages.some((receipt) => isAgentRunStopMessage(receipt) && receipt.runId === run.id
    && receipt.status === 'answered')) return false
  const jobById = new Map(jobs.map((job) => [job.id, job]))
  // 已确认取消后显式重试的分支仍保留原 Job；旧停止意图不能取消新 attempt。
  const acknowledged = run.branches.length > 0 && run.branches.every((branch) =>
    branch.jobIds.some((id) => {
      const cancel = jobById.get(id)?.cancel
      return cancel && cancel.requestedAt >= requestedAt! && !generationCancellationPending(cancel)
    }) || ['succeeded', 'failed', 'cancelled'].includes(branch.status) && branch.updatedAt < requestedAt!)
  if (acknowledged) return false
  const activeJobs = run.branches.flatMap((branch) => branch.activeJobId ? [jobById.get(branch.activeJobId)] : [])
  if (activeJobs.some((job) => !job || generationCancellationPending(job.cancel)
    || !['succeeded', 'failed', 'cancelled'].includes(job.status))) return true
  return !['completed', 'partial', 'failed', 'cancelled'].includes(run.status)
}

export function preserveAgentPlanStop(message: BotanicAgentMessage, sources: readonly BotanicAgentMessage[]) {
  const times = [message, ...sources.filter((source) => source.id === message.id)]
    .flatMap((source) => Number.isFinite(source.turnCancellationRequestedAt) ? [source.turnCancellationRequestedAt!] : [])
  return times.length ? { ...message, turnCancellationRequestedAt: Math.min(...times) } : message
}

/** 取消发生在媒体准备期间时，不再发起创建；已接受的 Run 交由取消接口处理。 */
export function assertAgentPlanSubmissionActive(messages: readonly BotanicAgentMessage[], submissionKey?: string) {
  if (submissionKey && messages.some((message) => message.plan && Number.isFinite(message.turnCancellationRequestedAt)
    && botanicAgentSubmissionKey(message.id, message.plan) === submissionKey)) {
    throw Object.assign(new Error('已请求停止此计划，请查看原任务。'), { code: 'AGENT_PLAN_STOP_REQUESTED', status: 409 })
  }
}
