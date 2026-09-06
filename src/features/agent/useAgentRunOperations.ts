import { useEffect, useMemo, useRef, useState } from 'react'
import { localizeProductError, type ProductLocale } from '../../i18n/core.ts'
import type { BotanicAgentMessage, BotanicAgentRun } from '../../domain/agent.ts'
import { agentPlanCancellationPending, agentPlanCancellationRun, isAgentRunStopMessage, preserveAgentPlanStop } from '../../domain/agentPlanCancellation.ts'
import type { GenerationJob } from '../../domain/canvas.ts'
import { generationCancellationPending, type GenerationCancelRecord } from '../../domain/generationCancelCopy.ts'
import { agentBranchCanRetry } from '../../domain/generationRecovery.ts'

export async function executeAgentRunOperation(pending: Set<string>, runId: string, execute: () => Promise<boolean>) {
  if (pending.has(runId)) return 'busy'
  pending.add(runId)
  try { return await execute() ? 'succeeded' : 'failed' }
  finally { pending.delete(runId) }
}

/** 先可靠入本地消息队列；只有取消及状态刷新均确认，才标记请求已处理。 */
export async function executeAgentRunCancellation(message: BotanicAgentMessage, save: (message: BotanicAgentMessage) => void | Promise<void>, cancel: () => Promise<boolean>) {
  await save(message)
  const confirmed = await cancel()
  if (confirmed) await save({ ...message, status: 'answered', updatedAt: Math.max(Date.now(), (message.updatedAt ?? message.createdAt) + 1) })
  return confirmed
}

export type AgentRunOperation = { kind: 'cancel' | 'retry'; branchId?: string; pending: boolean; error?: string }

/** 任务面板和对话共用操作反馈，不把 HTTP 成功当成任务终态。 */
export function useAgentRunOperations(input: {
  projectId: string
  locale: ProductLocale
  runs: BotanicAgentRun[]
  jobs: GenerationJob[]
  messages?: readonly BotanicAgentMessage[]
  onSaveStopMessage: (message: BotanicAgentMessage) => void
  onCancelRun: (runId: string) => Promise<boolean>
  onCheckRunStop?: (runId: string) => Promise<boolean>
  onRetryBranch: (runId: string, branchId: string) => Promise<boolean>
}) {
  const [states, setStates] = useState<Record<string, AgentRunOperation>>({})
  const pending = useMemo(() => new Set<string>(), [input.projectId])
  const stoppedPlans = useMemo(() => new Map<string, BotanicAgentMessage>(), [input.projectId])
  const latestMessages = useRef(input.messages)
  latestMessages.current = input.messages
  const saveStopMessage = (message: BotanicAgentMessage) => {
    const latest = latestMessages.current?.find((item) => item.id === message.id)
    const saved = { ...message, updatedAt: Math.max(message.updatedAt ?? message.createdAt, (latest?.updatedAt ?? latest?.createdAt ?? 0) + 1) }
    input.onSaveStopMessage(saved)
    stoppedPlans.set(saved.id, saved)
  }
  const withPlanStop = (message: BotanicAgentMessage) => preserveAgentPlanStop(message, [...(input.messages ?? []), ...stoppedPlans.values()])
  const stoppedRuns = useMemo(() => new Set((input.messages ?? []).flatMap((message) => {
    const stopped = withPlanStop(message)
    if (!Number.isFinite(stopped.turnCancellationRequestedAt)) return []
    const run = agentPlanCancellationRun(stopped, input.runs)
    return run && agentPlanCancellationPending(stopped, run, input.jobs, input.messages) ? [run.id] : []
  })), [input.messages, input.runs, input.jobs, stoppedPlans])
  const epoch = useRef<symbol | null>(null)
  const cancellations = useMemo(() => {
    const records = new Map<string, GenerationCancelRecord>()
    const jobs = new Map(input.jobs.map((job) => [job.id, job]))
    for (const run of input.runs) for (const branch of run.branches) {
      const record = branch.activeJobId ? jobs.get(branch.activeJobId)?.cancel : undefined
      const current = records.get(run.id)
      if (record && (!current || generationCancellationPending(record) || !generationCancellationPending(current) && record.billing === 'possible')) records.set(run.id, record)
    }
    return records
  }, [input.runs, input.jobs])
  const stopping = useMemo(() => new Set(input.runs.filter((run) => stoppedRuns.has(run.id) || generationCancellationPending(cancellations.get(run.id))
    || states[run.id]?.kind === 'cancel' && (states[run.id].pending || states[run.id].error)).map((run) => run.id)), [input.runs, stoppedRuns, cancellations, states])
  useEffect(() => {
    epoch.current = Symbol()
    setStates({})
    return () => { epoch.current = null }
  }, [input.projectId])

  const perform = async (runId: string, branchId?: string) => {
    if (pending.has(runId)) return
    const currentEpoch = epoch.current
    const operation: AgentRunOperation = { kind: branchId ? 'retry' : 'cancel', branchId, pending: true }
    const publish = (error?: string) => {
      if (epoch.current !== currentEpoch) return
      setStates((current) => ({ ...current, [runId]: { ...operation, pending: false, ...(error ? { error } : {}) } }))
    }
  const failure = input.locale === 'en'
      ? branchId ? 'Retry failed. Try again.' : 'Stop status is pending confirmation.'
      : branchId ? '重试失败，请再试一次。' : '停止状态待确认。'
    const run = input.runs.find(run => run.id === runId)
    if (branchId && (stopping.has(runId) || !run || !agentBranchCanRetry(run, branchId, input.jobs))) {
      return
    }
    setStates((current) => ({ ...current, [runId]: operation }))
    try {
      const result = await executeAgentRunOperation(pending, runId, async () => {
        if (branchId) return input.onRetryBranch(runId, branchId)
        const previous = [...(input.messages ?? []), ...stoppedPlans.values()].find((message) => isAgentRunStopMessage(message) && message.runId === runId && message.status !== 'answered')
        const now = Date.now()
        const message: BotanicAgentMessage = previous ?? { id: `agent-run-stop-${crypto.randomUUID()}`, role: 'assistant', kind: 'notice',
          runId, content: input.locale === 'en' ? 'Stopping…' : '正在停止…', status: 'pending', createdAt: now, updatedAt: now, turnCancellationRequestedAt: now }
        return executeAgentRunCancellation(message, (saved) => {
          if (epoch.current !== currentEpoch) throw new Error('停止请求保留在原项目，请返回原项目核对。')
          saveStopMessage(saved)
        }, () => input.onCancelRun(runId))
      })
      publish(result === 'failed' ? failure : undefined)
    } catch (caught) {
      publish(localizeProductError(caught, input.locale, { 'zh-CN': failure, en: failure }))
    }
  }
  useEffect(() => {
    for (const runId of stoppedRuns) if (!states[runId]) void perform(runId)
  })
  // 回执丢失/ACK 迟到只读核对；不靠用户再次点击取消，也不自动重放生成。
  const unsettled = [...new Set([
    ...Object.entries(states).filter(([, state]) => state.kind === 'cancel' && !state.pending && state.error).map(([id]) => id),
    ...[...cancellations].filter(([id, record]) => generationCancellationPending(record) && !states[id]?.pending).map(([id]) => id),
  ])].sort().join(',')
  const latestInput = useRef(input)
  latestInput.current = input
  useEffect(() => {
    if (!unsettled || !latestInput.current.onCheckRunStop) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    let attempts = 0
    const check = async () => {
      for (const runId of unsettled.split(',')) {
        const confirmed = await latestInput.current.onCheckRunStop!(runId).catch(() => false)
        if (stopped) return
        if (!confirmed) continue
        const message = latestInput.current.messages?.find(message => isAgentRunStopMessage(message) && message.runId === runId && message.status !== 'answered')
        try {
          if (message) latestInput.current.onSaveStopMessage({ ...message, status: 'answered', updatedAt: Math.max(Date.now(), (message.updatedAt ?? message.createdAt) + 1) })
          setStates(current => ({ ...current, [runId]: { kind: 'cancel', pending: false } }))
        } catch { /* 保留停止意图和恢复入口，不能把消息保存失败变成已处理。 */ }
      }
      if (!stopped && ++attempts < 5) timer = setTimeout(check, 2000)
    }
    timer = setTimeout(check, 1000)
    return () => { stopped = true; clearTimeout(timer) }
  }, [input.projectId, unsettled])
  return { states, cancellations, stopping, withPlanStop,
    planStopped: (message: BotanicAgentMessage) => Number.isFinite(withPlanStop(message).turnCancellationRequestedAt),
    stopPlan: (message: BotanicAgentMessage) => {
      const stopped = withPlanStop({ ...message, turnCancellationRequestedAt: message.turnCancellationRequestedAt ?? Date.now() })
      saveStopMessage({ ...stopped, updatedAt: Math.max(Date.now(), (stopped.updatedAt ?? stopped.createdAt) + 1) })
    },
    cancel: (runId: string) => perform(runId), retry: (runId: string, branchId: string) => perform(runId, branchId) }
}
