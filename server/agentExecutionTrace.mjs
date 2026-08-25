// @ts-check
import { executionTraceId, isExecutionStage, stageError } from './executionTrace.mjs'

const unique = (values) => [...new Set(values.filter((value) => typeof value === 'string' && value))]

export function agentExecutionTraceId(runId) {
  return executionTraceId({ runId })
}

function failureSummary(run, jobs) {
  const pending = jobs.find((job) => job?.projectWritebackPending)
  if (pending) return stageError({ stage: 'writeback', code: 'PROJECT_WRITEBACK_PENDING', recoverable: true })
  const failedJob = jobs.find((job) => job?.status === 'failed')
  if (failedJob) {
    // 阶段由任务自己声明。旧实现用 `error.includes('队列')` 区分 queue 与 provider，
    // 措辞一改就会把队列失败误报成 Provider 失败，且绑定中文文案；判不出来时用
    // unknown，不猜。
    return stageError({
      stage: isExecutionStage(failedJob.stage) ? failedJob.stage : 'unknown',
      code: failedJob.code || 'GENERATION_FAILED',
      message: failedJob.error,
      recoverable: true,
    })
  }
  const failedTool = run?.plan?.toolCalls?.find((call) => call?.status === 'failed')
  if (failedTool) return stageError({ stage: 'tool', code: 'AGENT_TOOL_FAILED', recoverable: true })
  if (run?.status === 'failed') return stageError({ stage: 'planning', code: 'AGENT_RUN_FAILED', recoverable: true })
  return undefined
}

/**
 * 面向管理员的安全执行快照。只暴露稳定标识和运维指标，不返回 Prompt、媒体地址、
 * Provider 原始请求或用户消息正文。
 */
export function buildAgentExecutionTrace(input) {
  const { run, jobs = [], artifacts = [], sessionId, messageId } = input ?? {}
  if (!run?.id) throw new TypeError('Agent 执行链路缺少 Run。')
  const runJobs = jobs.filter((job) => !job?.agentRun || job.agentRun.runId === run.id)
  const runArtifacts = artifacts.filter((artifact) => artifact?.provenance?.runId === run.id)
  const startedAt = Number(run.createdAt) || 0
  const updatedAt = Number(run.updatedAt) || startedAt
  const retryCount = (run.branches ?? []).reduce((total, branch) => total + Math.max(0, Number(branch.attempt) || 0), 0)
  const outputCount = runJobs.reduce((total, job) => total + (Array.isArray(job.outputs) ? job.outputs.length : 0), 0)
  const projectWritebackPending = runJobs.some((job) => Boolean(job.projectWritebackPending))
  return {
    traceId: agentExecutionTraceId(run.id),
    projectId: run.projectId,
    runId: run.id,
    status: run.status,
    links: {
      ...(sessionId ? { sessionId } : {}),
      ...(messageId ? { messageId } : {}),
      ...(run.plan?.plannerModel ? { plannerModel: run.plan.plannerModel } : {}),
      toolCallIds: unique((run.plan?.toolCalls ?? []).map((call) => call?.id)),
      skillIds: unique((run.plan?.toolCalls ?? []).filter((call) => call?.name === 'skill_apply').map((call) => call?.id)),
      jobIds: unique(runJobs.map((job) => job?.id)),
      artifactIds: unique(runArtifacts.map((artifact) => artifact?.id)),
    },
    metrics: {
      durationMs: Math.max(0, updatedAt - startedAt),
      retryCount,
      outputCount,
      expectedOutputCount: (run.branches ?? []).reduce((total, branch) => total + Math.max(0, Number(branch.outputCount) || 0), 0),
      writebackComplete: !projectWritebackPending,
      recoveryState: projectWritebackPending ? 'pending' : run.status === 'completed' || run.status === 'partial' ? 'settled' : 'not_required',
    },
    ...(failureSummary(run, runJobs) ? { failure: failureSummary(run, runJobs) } : {}),
  }
}
