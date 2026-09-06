import { listPersistentBotanicAgentRuns } from './agentApi'
import { getGenerationJob } from './generationApi'

/** 取消回执不确定时只读同一 Run 及其活动 Job，不重发取消或生成。 */
export async function readAgentRunCancellation(projectId: string, runId: string) {
  const run = (await listPersistentBotanicAgentRuns(projectId)).find(run => run.id === runId)
  if (!run) throw new Error('未找到原任务，停止状态仍待确认。')
  const jobIds = [...new Set(run.branches.flatMap(branch => branch.activeJobId ? [branch.activeJobId] : []))]
  return { run, jobs: await Promise.all(jobIds.map(getGenerationJob)) }
}
