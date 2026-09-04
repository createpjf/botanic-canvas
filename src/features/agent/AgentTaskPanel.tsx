import { useEffect, useMemo, useRef, useState } from 'react'
import {
  botanicAgentBranchStatusLabel,
  filterBotanicAgentRunTimeline,
  presentBotanicAgentPlanSummary,
  type BotanicAgentArtifact,
  type BotanicAgentRun,
  type BotanicAgentRunTimelineFilter,
  type BotanicAgentRunTimelineItem,
} from '../../domain/agent'
import type { GenerationModelOption } from '../../domain/canvas'
import { AlertIcon, CheckIcon, ChecklistIcon, ClockIcon } from '../../components/BotanicIcons'
import { Task, TaskContent, TaskTrigger } from '../../components/ai-elements/task'
import { botanicMotion, scrollElementIntoView } from '../../components/gsapMotion'
import { localizeProductError } from '../../i18n/core'
import { useProductI18n } from '../../i18n/react'
import { AgentFailureRecoveryActions, agentRunFeedback } from './AgentWorkspaceParts'

type TaskSource = NonNullable<BotanicAgentRunTimelineItem['source']>

function TaskFilterIcon({ value }: { value: BotanicAgentRunTimelineFilter }) {
  if (value === 'completed') return <CheckIcon />
  if (value === 'attention') return <AlertIcon />
  if (value === 'active') return <ClockIcon />
  return <ChecklistIcon />
}

function branchSummary(run: BotanicAgentRun, locale: 'zh-CN' | 'en') {
  const count = (statuses: Array<BotanicAgentRun['branches'][number]['status']>) => run.branches.filter((branch) => statuses.includes(branch.status)).length
  const parts = [
    [count(['succeeded']), locale === 'en' ? 'complete' : '完成'],
    [count(['running']), locale === 'en' ? 'generating' : '生成中'],
    [count(['queued']), locale === 'en' ? 'queued' : '排队'],
    [count(['failed', 'cancelled']), locale === 'en' ? 'failed' : '失败'],
  ] as const
  return parts.filter(([value]) => value).map(([value, label]) => `${value} ${label}`).join(' · ')
    || `${run.branches.length} ${locale === 'en' ? 'branches' : '个分支'}`
}

export function AgentTaskPanel({
  timeline,
  artifacts,
  availableCanvasNodeIds,
  generationModels,
  focusedRunId,
  retryingBranchId,
  cancellingRunId,
  recoveryModelMenuKey,
  onFocusedRunHandled,
  onLocateSource,
  onOpenFeedback,
  onPrepareRecovery,
  onRetryBranch,
  onCancelRun,
  onRetryingBranchChange,
  onCancellingRunChange,
  onRecoveryModelMenuChange,
}: {
  timeline: BotanicAgentRunTimelineItem[]
  artifacts: BotanicAgentArtifact[]
  availableCanvasNodeIds: Set<string>
  generationModels: GenerationModelOption[]
  focusedRunId: string
  retryingBranchId: string
  cancellingRunId: string
  recoveryModelMenuKey: string
  onFocusedRunHandled: () => void
  onLocateSource: (source: TaskSource) => void
  onOpenFeedback: (run: BotanicAgentRun) => void
  onPrepareRecovery: (run: BotanicAgentRun, mode: 'settings' | 'model', model?: GenerationModelOption) => void
  onRetryBranch: (runId: string, branchId: string) => Promise<unknown>
  onCancelRun: (runId: string) => Promise<unknown>
  onRetryingBranchChange: (branchId: string) => void
  onCancellingRunChange: (runId: string) => void
  onRecoveryModelMenuChange: (key: string) => void
}) {
  const { locale } = useProductI18n()
  const copy = locale === 'en' ? {
    aria: 'Agent tasks and results', description: 'Tasks started by Agent. Open one only when you need its actions or branch details.', filters: 'Filter by task status', all: 'All', active: 'Active', completed: 'Completed', attention: 'Needs attention', source: 'Source conversation', cancel: 'Cancel task', cancelling: 'Cancelling…', branchStatus: 'Branch status', branchIncomplete: 'This branch did not complete.', noMatch: 'No tasks match this filter.', empty: 'No Agent tasks yet.', details: 'Task details', items: (count: number) => `${count} ${count === 1 ? 'item' : 'items'}`,
  } : {
    aria: 'Agent 任务与结果', description: '仅显示 Agent 发起的任务；需要操作或查看分支时再展开。', filters: '按任务状态筛选', all: '全部', active: '进行中', completed: '已完成', attention: '需处理', source: '来源对话', cancel: '取消任务', cancelling: '取消中…', branchStatus: '分支状态', branchIncomplete: '该分支未完成', noMatch: '当前筛选下没有任务。', empty: '还没有 Agent 任务。', details: '任务详情', items: (count: number) => `${count} 项`,
  }
  const [filter, setFilter] = useState<BotanicAgentRunTimelineFilter>('all')
  const [expandedRunId, setExpandedRunId] = useState('')
  const nodesRef = useRef(new Map<string, HTMLElement>())
  const filtered = useMemo(() => filterBotanicAgentRunTimeline(timeline, filter), [filter, timeline])
  const counts = useMemo(() => ({
    all: timeline.length,
    active: filterBotanicAgentRunTimeline(timeline, 'active').length,
    completed: filterBotanicAgentRunTimeline(timeline, 'completed').length,
    attention: filterBotanicAgentRunTimeline(timeline, 'attention').length,
  }), [timeline])

  useEffect(() => {
    if (!focusedRunId) return
    setFilter('all')
    setExpandedRunId(focusedRunId)
    let timer: number | undefined
    const frame = requestAnimationFrame(() => {
      const node = nodesRef.current.get(focusedRunId)
      const viewport = node?.closest<HTMLElement>('.agent-workspace__messages')
      if (node && viewport) scrollElementIntoView(viewport, node, { duration: botanicMotion.duration.panel, block: 'center' })
      node?.focus({ preventScroll: true })
      timer = window.setTimeout(onFocusedRunHandled, 1800)
    })
    return () => { cancelAnimationFrame(frame); if (timer) window.clearTimeout(timer) }
  }, [focusedRunId, onFocusedRunHandled])

  return <section className="agent-task-panel" aria-label={copy.aria}>
    <p>{copy.description}</p>
    <div className="agent-task-panel__filters" aria-label={copy.filters}>
      {([
        ['all', copy.all], ['active', copy.active], ['completed', copy.completed], ['attention', copy.attention],
      ] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} aria-label={`${label} · ${copy.items(counts[value])}`} onClick={() => setFilter(value)}>
        <TaskFilterIcon value={value} /><span>{label}</span><b>{counts[value]}</b>
      </button>)}
    </div>
    <div className="agent-task-panel__list">
      {filtered.map(({ run, source }) => {
        const feedback = agentRunFeedback(run, artifacts, availableCanvasNodeIds, locale)
        const active = run.status === 'queued' || run.status === 'running' || run.status === 'executing'
        const expanded = expandedRunId === run.id
        const failedBranches = run.branches.filter((branch) => branch.status === 'failed' || branch.status === 'cancelled')
        const detailId = `agent-task-detail-${run.id}`
        return <Task key={run.id} asChild open={expanded} onOpenChange={(open) => setExpandedRunId(open ? run.id : '')}>
          <article
            ref={(node) => { if (node) nodesRef.current.set(run.id, node); else nodesRef.current.delete(run.id) }}
            tabIndex={-1}
            className={`is-${run.status} is-${feedback.tone}${focusedRunId === run.id ? ' is-located' : ''}`}
          >
            <TaskTrigger title={presentBotanicAgentPlanSummary(run.plan.summary) || feedback.label}>
              <button type="button" className="agent-task-panel__disclosure" aria-controls={detailId}>
                <span><strong>{presentBotanicAgentPlanSummary(run.plan.summary) || feedback.label}</strong><small>{feedback.label} · <time dateTime={new Date(run.updatedAt).toISOString()}>{new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(run.updatedAt))}</time></small></span>
                <b>{run.completedBranchCount}/{run.branches.length}</b><i aria-hidden="true">{expanded ? '−' : '＋'}</i>
              </button>
            </TaskTrigger>
            {active ? <div className="agent-run-card__track" aria-hidden="true"><i style={{ width: `${run.branches.length ? Math.round(run.completedBranchCount / run.branches.length * 100) : 0}%` }} /></div> : null}
            <TaskContent id={detailId} aria-label={copy.details}><div className="agent-task-panel__body">
            <p className="agent-task-panel__feedback">{feedback.detail}</p>
            <div className="agent-task-panel__actions">
              {source ? <button type="button" onClick={() => onLocateSource(source)}>{copy.source}</button> : null}
              {!active && feedback.action !== 'none' ? <button type="button" onClick={() => onOpenFeedback(run)}>{feedback.actionLabel}</button> : null}
              {active ? <button type="button" className="is-danger" disabled={cancellingRunId === run.id} onClick={() => { onCancellingRunChange(run.id); void onCancelRun(run.id).finally(() => onCancellingRunChange('')) }}>{cancellingRunId === run.id ? copy.cancelling : copy.cancel}</button> : null}
            </div>
            {run.branches.length >= 2 ? <details className="agent-task-panel__details">
              <summary>{branchSummary(run, locale)}</summary>
              <div className="agent-task-panel__branch-list" aria-label={copy.branchStatus}>
                {run.branches.map((branch) => <div className={`agent-task-panel__branch-row is-${branch.status}`} key={branch.id}><strong>{branch.label}</strong><small>{locale === 'en' ? ({ succeeded: 'Completed', running: 'Generating', queued: 'Queued', cancelled: 'Cancelled', failed: 'Failed' } as const)[branch.status] : botanicAgentBranchStatusLabel(branch.status)}</small></div>)}
              </div>
            </details> : null}
            {failedBranches.map((branch) => <div className="agent-task-panel__branch" key={branch.id}><span><strong>{branch.label}</strong><small>{branch.error ? localizeProductError(new Error(branch.error), locale, { 'zh-CN': copy.branchIncomplete, en: copy.branchIncomplete }) : copy.branchIncomplete}</small></span><AgentFailureRecoveryActions
              branch={branch}
              generationModels={generationModels}
              retrying={retryingBranchId === branch.id}
              menuOpen={recoveryModelMenuKey === `${run.id}:${branch.id}`}
              onToggleModelMenu={() => onRecoveryModelMenuChange(recoveryModelMenuKey === `${run.id}:${branch.id}` ? '' : `${run.id}:${branch.id}`)}
              onPrepare={(mode, model) => onPrepareRecovery(run, mode, model)}
              onRetry={() => { onRetryingBranchChange(branch.id); void onRetryBranch(run.id, branch.id).finally(() => onRetryingBranchChange('')) }}
            /></div>)}
            </div></TaskContent>
          </article>
        </Task>
      })}
      {!filtered.length ? <div className="agent-panel__empty">{timeline.length ? copy.noMatch : copy.empty}</div> : null}
    </div>
  </section>
}
