import { useEffect, useMemo, useRef, useState } from 'react'
import {
  botanicAgentBranchStatusLabel,
  filterBotanicAgentRunTimeline,
  type BotanicAgentArtifact,
  type BotanicAgentRun,
  type BotanicAgentRunFeedbackTone,
  type BotanicAgentRunTimelineFilter,
  type BotanicAgentRunTimelineItem,
} from '../../domain/agent'
import type { GenerationModelOption } from '../../domain/canvas'
import { AlertIcon, CheckIcon, ChecklistIcon, ClockIcon } from '../../components/BotanicIcons'
import { Queue, QueueItem, QueueItemContent, QueueItemDescription, QueueItemIndicator, QueueList, QueueSection, QueueSectionContent, QueueSectionLabel, QueueSectionTrigger } from '../../components/ai-elements/queue'
import { Task, TaskContent, TaskItem, TaskTrigger } from '../../components/ai-elements/task'
import { botanicMotion, scrollElementIntoView } from '../../components/gsapMotion'
import { localizeProductError } from '../../i18n/core'
import { useProductI18n } from '../../i18n/react'
import { AgentFailureRecoveryActions, agentRunFeedback } from './AgentWorkspaceParts'
import type { useAgentRunOperations } from './useAgentRunOperations'
import { agentTaskDisplayName } from './agentDisplayNames'

type TaskSource = NonNullable<BotanicAgentRunTimelineItem['source']>

function TaskFilterIcon({ value }: { value: BotanicAgentRunTimelineFilter }) {
  if (value === 'completed') return <CheckIcon />
  if (value === 'attention') return <AlertIcon />
  if (value === 'active') return <ClockIcon />
  return <ChecklistIcon />
}

function isLiveRun(run: Pick<BotanicAgentRun, 'status'>) {
  return run.status === 'queued' || run.status === 'running' || run.status === 'executing'
}

function TaskStatusIcon({ active, tone }: { active: boolean; tone: BotanicAgentRunFeedbackTone }) {
  if (active) return <ClockIcon />
  if (tone === 'error' || tone === 'warning') return <AlertIcon />
  return <CheckIcon />
}

function branchSummary(run: BotanicAgentRun, locale: 'zh-CN' | 'en') {
  const count = (statuses: Array<BotanicAgentRun['branches'][number]['status']>) => run.branches.filter((branch) => statuses.includes(branch.status)).length
  const parts = [
    [count(['succeeded']), locale === 'en' ? 'complete' : '完成'],
    [count(['running']), locale === 'en' ? 'generating' : '生成中'],
    [count(['queued']), locale === 'en' ? 'queued' : '排队'],
    [count(['failed']), locale === 'en' ? 'failed' : '失败'],
    [count(['cancelled']), locale === 'en' ? 'cancelled' : '已取消'],
  ] as const
  return parts.filter(([value]) => value).map(([value, label]) => `${value} ${label}`).join(' · ')
    || `${run.branches.length} ${locale === 'en' ? 'branches' : '个分支'}`
}

export function AgentTaskPanel({
  projectId, onLoadRun,
  timeline,
  artifacts,
  availableCanvasNodeIds,
  generationModels,
  focusedRunId,
  operations,
  recoveryModelMenuKey,
  onFocusedRunHandled,
  onLocateSource,
  onOpenFeedback,
  onPrepareRecovery,
  onRecoveryModelMenuChange,
}: {
  projectId: string; onLoadRun: (runId: string, signal: AbortSignal) => Promise<void>
  timeline: BotanicAgentRunTimelineItem[]
  artifacts: BotanicAgentArtifact[]
  availableCanvasNodeIds: Set<string>
  generationModels: GenerationModelOption[]
  focusedRunId: string
  operations: ReturnType<typeof useAgentRunOperations>
  recoveryModelMenuKey: string
  onFocusedRunHandled: () => void
  onLocateSource: (source: TaskSource) => void
  onOpenFeedback: (run: BotanicAgentRun) => void
  onPrepareRecovery: (run: BotanicAgentRun, mode: 'settings' | 'model', model?: GenerationModelOption) => void
  onRecoveryModelMenuChange: (key: string) => void
}) {
  const { locale } = useProductI18n()
  const copy = locale === 'en' ? {
    aria: 'Agent tasks and results', queue: 'active tasks', filters: 'Filter by task status', all: 'All', active: 'Active', completed: 'Completed', attention: 'Needs attention', source: 'Source conversation', cancel: 'Cancel task', cancelling: 'Cancelling…', branchStatus: 'Branch status', branchIncomplete: 'This branch did not complete.', noMatch: 'No tasks match this filter.', empty: 'No Agent tasks yet.', details: 'Task details', items: (count: number) => `${count} ${count === 1 ? 'item' : 'items'}`,
  } : {
    aria: 'Agent 任务与结果', queue: '个进行中任务', filters: '按任务状态筛选', all: '全部', active: '进行中', completed: '已完成', attention: '需处理', source: '来源对话', cancel: '取消任务', cancelling: '取消中…', branchStatus: '分支状态', branchIncomplete: '该分支未完成', noMatch: '当前筛选下没有任务。', empty: '还没有 Agent 任务。', details: '任务详情', items: (count: number) => `${count} 项`,
  }
  const [filter, setFilter] = useState<BotanicAgentRunTimelineFilter>('all')
  const [expandedRunId, setExpandedRunId] = useState('')
  const autoExpandedRunId = useRef('')
  const nodesRef = useRef(new Map<string, HTMLElement>())
  const [loadFailure, setLoadFailure] = useState<{ projectId: string; runId: string; error: string }>()
  const [loadRetry, setLoadRetry] = useState(0)
  const loadRunRef = useRef(onLoadRun)
  loadRunRef.current = onLoadRun
  const focusedPresent = timeline.some(({ run }) => run.id === focusedRunId)
  const missingFocused = Boolean(focusedRunId && !focusedPresent)
  const focusedError = loadFailure?.projectId === projectId && loadFailure.runId === focusedRunId ? loadFailure.error : undefined
  useEffect(() => {
    if (!focusedRunId || focusedPresent) return
    const controller = new AbortController()
    setLoadFailure(undefined)
    void loadRunRef.current(focusedRunId, controller.signal).catch((caught) => {
      if (!controller.signal.aborted) setLoadFailure({ projectId, runId: focusedRunId, error: localizeProductError(caught, locale, { 'zh-CN': '任务读取失败，请重试。', en: 'Could not load this task. Try again.' }) })
    })
    return () => controller.abort()
  }, [projectId, focusedRunId, focusedPresent, loadRetry, locale])
  const groups = useMemo(() => {
    const stoppingIds = operations.stopping
    const activeIds = new Set(filterBotanicAgentRunTimeline(timeline, 'active').map(({ run }) => run.id))
    return {
      all: timeline,
      active: timeline.filter(({ run }) => activeIds.has(run.id) || stoppingIds.has(run.id)),
      completed: filterBotanicAgentRunTimeline(timeline, 'completed').filter(({ run }) => !stoppingIds.has(run.id)),
      attention: filterBotanicAgentRunTimeline(timeline, 'attention').filter(({ run }) => !stoppingIds.has(run.id)),
    }
  }, [timeline, operations.stopping])
  const filtered = groups[filter]
  const liveRuns = groups.active.filter(({ run }) => run.status !== 'awaiting_confirmation')
  const autoExpandRunId = timeline.find(({ run }) => {
    const tone = agentRunFeedback(run, artifacts, availableCanvasNodeIds, locale, operations.cancellations.get(run.id), operations.stopping.has(run.id)).tone
    return isLiveRun(run) || operations.stopping.has(run.id) || tone === 'error' || tone === 'warning'
  })?.run.id ?? ''
  const counts = { all: groups.all.length, active: groups.active.length, completed: groups.completed.length, attention: groups.attention.length }

  useEffect(() => {
    if (focusedRunId || expandedRunId || !autoExpandRunId || autoExpandedRunId.current === autoExpandRunId) return
    autoExpandedRunId.current = autoExpandRunId
    setExpandedRunId(autoExpandRunId)
  }, [autoExpandRunId, expandedRunId, focusedRunId])

  useEffect(() => {
    if (!focusedRunId) return
    setFilter('all')
    setExpandedRunId(focusedRunId)
    if (!focusedPresent) return
    let timer: number | undefined
    const frame = requestAnimationFrame(() => {
      const node = nodesRef.current.get(focusedRunId)
      if (!node) return
      const viewport = node?.closest<HTMLElement>('.agent-workspace__messages')
      if (node && viewport) scrollElementIntoView(viewport, node, { duration: botanicMotion.duration.panel, block: 'center' })
      node?.focus({ preventScroll: true })
      timer = window.setTimeout(onFocusedRunHandled, 1800)
    })
    return () => { cancelAnimationFrame(frame); if (timer) window.clearTimeout(timer) }
  }, [focusedRunId, focusedPresent, onFocusedRunHandled])

  return <section className="agent-task-panel" aria-label={copy.aria}>
    {missingFocused ? <div className="agent-run-message__result-state" role={focusedError ? 'alert' : 'status'}>
      <span>{focusedError ?? (locale === 'en' ? 'Loading task…' : '正在读取任务…')}</span>
      {focusedError ? <button type="button" onClick={() => setLoadRetry((value) => value + 1)}>{locale === 'en' ? 'Retry' : '重试'}</button> : null}
    </div> : null}
    {liveRuns.length > 1 ? <Queue className="agent-task-panel__queue" aria-label={copy.queue}>
      <QueueSection defaultOpen={false}>
        <QueueSectionTrigger><QueueSectionLabel count={liveRuns.length} label={copy.queue} icon={<ClockIcon aria-hidden="true" />} /></QueueSectionTrigger>
        <QueueSectionContent><QueueList className="agent-task-panel__queue-list"><ul>{liveRuns.map(({ run }) => {
          const feedback = agentRunFeedback(run, artifacts, availableCanvasNodeIds, locale, operations.cancellations.get(run.id), operations.stopping.has(run.id))
          return <QueueItem key={run.id} className="agent-task-panel__queue-item"><QueueItemIndicator /><QueueItemContent>{agentTaskDisplayName(run, locale)}</QueueItemContent><QueueItemDescription>{feedback.label}</QueueItemDescription></QueueItem>
        })}</ul></QueueList></QueueSectionContent>
      </QueueSection>
    </Queue> : null}
    <div className="agent-task-panel__filters" aria-label={copy.filters}>
      {([
        ['all', copy.all], ['active', copy.active], ['completed', copy.completed], ['attention', copy.attention],
      ] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} aria-label={`${label} · ${copy.items(counts[value])}`} onClick={() => setFilter(value)}>
        <TaskFilterIcon value={value} /><span>{label}</span><b>{counts[value]}</b>
      </button>)}
    </div>
    <div className="agent-task-panel__list">
      {filtered.map(({ run, source }) => {
        const feedback = agentRunFeedback(run, artifacts, availableCanvasNodeIds, locale, operations.cancellations.get(run.id), operations.stopping.has(run.id))
        const stopping = operations.stopping.has(run.id)
        const active = isLiveRun(run) || stopping
        const operation = operations.states[run.id]
        const expanded = expandedRunId === run.id
        const failedBranches = run.branches.filter((branch) => branch.status === 'failed' || branch.status === 'cancelled')
        const detailId = `agent-task-detail-${run.id}`
        return <Task key={run.id} asChild open={expanded} onOpenChange={(open) => setExpandedRunId(open ? run.id : '')}>
          <article
            ref={(node) => { if (node) nodesRef.current.set(run.id, node); else nodesRef.current.delete(run.id) }}
            tabIndex={-1}
            className={`is-${run.status} is-${feedback.tone}${focusedRunId === run.id ? ' is-located' : ''}`}
          >
            <TaskTrigger title={agentTaskDisplayName(run, locale)}>
              <button type="button" className="agent-task-panel__disclosure" aria-controls={detailId}>
                <span className={`agent-task-panel__status-icon is-${active ? 'progress' : feedback.tone}`} aria-hidden="true"><TaskStatusIcon active={active} tone={feedback.tone} /></span>
                <span><strong>{agentTaskDisplayName(run, locale)}</strong><small>{feedback.label} · <time dateTime={new Date(run.updatedAt).toISOString()}>{new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(run.updatedAt))}</time></small></span>
                <b>{run.completedBranchCount}/{run.branches.length}</b><i aria-hidden="true">{expanded ? '−' : '＋'}</i>
              </button>
            </TaskTrigger>
            {active ? <div className="agent-run-card__track" aria-hidden="true"><i style={{ width: `${run.branches.length ? Math.round(run.completedBranchCount / run.branches.length * 100) : 0}%` }} /></div> : null}
            <TaskContent id={detailId} aria-label={copy.details}><div className="agent-task-panel__body">
            <TaskItem className={`agent-task-panel__item is-${feedback.tone}`}><span className="agent-task-panel__item-icon" aria-hidden="true"><TaskStatusIcon active={active} tone={feedback.tone} /></span><span>{feedback.detail}</span></TaskItem>
            <div className="agent-task-panel__actions">
              {source ? <button type="button" onClick={() => onLocateSource(source)}>{copy.source}</button> : null}
              {!active && feedback.action !== 'none' ? <button type="button" onClick={() => onOpenFeedback(run)}>{feedback.actionLabel}</button> : null}
              {active || stopping || operation?.kind === 'cancel' && operation.error ? <button type="button" className="is-danger" disabled={operation?.pending} onClick={() => void operations.cancel(run.id)}>{operation?.kind === 'cancel' && operation.pending ? copy.cancelling : stopping ? locale === 'en' ? 'Retry stop' : '重试停止' : copy.cancel}</button> : null}
            </div>
            {operation?.error ? <p className="agent-task-panel__operation-error" role="alert">{operation.error}</p> : null}
            {run.branches.length >= 2 ? <details className="agent-task-panel__details">
              <summary>{branchSummary(run, locale)}</summary>
              <div className="agent-task-panel__branch-list" aria-label={copy.branchStatus}>
                {run.branches.map((branch) => <TaskItem className={`agent-task-panel__branch-row is-${branch.status}`} key={branch.id}><strong>{branch.label}</strong><small>{locale === 'en' ? ({ succeeded: 'Completed', running: 'Generating', queued: 'Queued', cancelled: 'Cancelled', failed: 'Failed' } as const)[branch.status] : botanicAgentBranchStatusLabel(branch.status)}</small></TaskItem>)}
              </div>
            </details> : null}
            {failedBranches.map((branch) => <div className="agent-task-panel__branch" key={branch.id}><span><strong>{branch.label}</strong><small>{branch.error ? localizeProductError(new Error(branch.error), locale, { 'zh-CN': copy.branchIncomplete, en: copy.branchIncomplete }) : copy.branchIncomplete}</small></span><AgentFailureRecoveryActions
              branch={branch}
              generationModels={generationModels}
              retrying={Boolean(operation?.pending && operation.branchId === branch.id)}
              disabled={Boolean(operation?.pending) || stopping}
              menuOpen={recoveryModelMenuKey === `${run.id}:${branch.id}`}
              onToggleModelMenu={() => onRecoveryModelMenuChange(recoveryModelMenuKey === `${run.id}:${branch.id}` ? '' : `${run.id}:${branch.id}`)}
              onPrepare={(mode, model) => onPrepareRecovery(run, mode, model)}
              onRetry={() => void operations.retry(run.id, branch.id)}
            /></div>)}
            </div></TaskContent>
          </article>
        </Task>
      })}
      {!filtered.length && !missingFocused ? <div className="agent-panel__empty">{timeline.length ? copy.noMatch : copy.empty}</div> : null}
    </div>
  </section>
}
