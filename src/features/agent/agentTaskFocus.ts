import type { BotanicAgentRunSnapshot } from '../../domain/agent.ts'

/** 定位只读取既有 Run；缺失/越权/切项目不投影，更不能调用生成来“恢复”。 */
export async function loadAgentTaskForFocus(input: {
  projectId: string; runId: string; signal: AbortSignal
  read: (projectId: string, signal: AbortSignal) => Promise<BotanicAgentRunSnapshot[]>
  isCurrent: () => boolean; apply: (run: BotanicAgentRunSnapshot) => void
}) {
  const runs = await input.read(input.projectId, input.signal)
  if (input.signal.aborted || !input.isCurrent()) return
  const run = runs.find((run) => run.id === input.runId)
  if (!run) throw Object.assign(new Error('未找到该任务，请重试读取。'), { code: 'AGENT_RUN_NOT_FOUND' })
  if (run.projectId !== input.projectId) throw Object.assign(new Error('任务不属于当前项目。'), { code: 'AGENT_RUN_PROJECT_MISMATCH' })
  input.apply(run)
}
