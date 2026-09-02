// @ts-check
import { publicAgentRun } from './botanicAgentRun.mjs'
import { publicAgentReviewTask } from './agent/review/agentReviewTask.mjs'

/**
 * Agent 运维只读工具的单一数据源。API 首次执行与 Worker 恢复必须复用同一实现，
 * 否则断点恢复后可用工具会漂移；所有读取都重新校验项目归属且不返回受控媒体地址。
 */
export function createAgentOperationalReaders({ productStore, userId, projectId, document }) {
  return {
    readRun: async (runId) => {
      const run = await productStore.readAgentRun(userId, runId)
      return run && run.projectId === projectId ? publicAgentRun(run) : undefined
    },
    readJob: async (jobId) => {
      const job = await productStore.readGenerationJob(userId, jobId)
      return job && job.projectId === projectId ? job : undefined
    },
    searchArtifacts: async ({ query, kind, limit }) => {
      const artifacts = await productStore.listAgentArtifacts(userId, projectId, {
        limit: Math.min(limit * 4, 200),
      }) ?? []
      const needle = String(query ?? '').trim().toLocaleLowerCase('zh-CN')
      return artifacts
        .filter((artifact) => (!kind || artifact.kind === kind)
          && (!needle || `${artifact.label ?? ''} ${artifact.id ?? ''}`.toLocaleLowerCase('zh-CN').includes(needle)))
        .slice(0, limit)
    },
    readReviews: async (runId) => {
      const run = await productStore.readAgentRun(userId, runId)
      if (!run || run.projectId !== projectId) return []
      return ((await productStore.listAgentReviewTasksForRun(userId, projectId, runId)) ?? [])
        .map(publicAgentReviewTask)
    },
    readWorkflowRun: async (runId) => (document?.productionWorkflowRuns ?? []).find((entry) => entry?.id === runId),
    readDeliveries: async () => document?.deliveries ?? [],
  }
}
