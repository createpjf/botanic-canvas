import { useState } from 'react'
import {
  buildBotanicAgentPromptDiff,
  botanicAgentRunFeedback,
  type BotanicAgentArtifact,
  type BotanicAgentClarification,
  type BotanicAgentClarificationField,
  type BotanicAgentMemoryKind,
  type BotanicAgentPlan,
  type BotanicAgentPromptDiffSegment,
  type BotanicAgentRun,
  type BotanicAgentRuntimeStep,
} from '../../domain/agent'
import {
  botanicAgentClarificationAnswersComplete,
  botanicAgentCustomDirectionPlaceholder,
} from '../../domain/agentCreativeBrief'
import type { GenerationModelOption } from '../../domain/canvas'
import { modelDisplayLabel, modelProviderLogo } from '../../components/generationModelPresentation'
import { AlertIcon, CheckIcon, ChevronLeftIcon, ClockIcon, CloseIcon, EditIcon, RefreshIcon, SlidersIcon } from '../../components/BotanicIcons'
import { useProductI18n, useProductMessages } from '../../i18n/react'
import type { ProductLocale } from '../../i18n/core'

export function agentToolStatusLabel(status: NonNullable<BotanicAgentPlan['toolCalls']>[number]['status'], locale: ProductLocale = 'zh-CN') {
  if (status === 'succeeded') return locale === 'en' ? 'Completed' : '已完成'
  if (status === 'failed') return locale === 'en' ? 'Failed' : '失败'
  if (status === 'awaiting_confirmation') return locale === 'en' ? 'Awaiting approval' : '待确认'
  if (status === 'running') return locale === 'en' ? 'Running' : '执行中'
  return locale === 'en' ? 'Pending' : '待执行'
}

export function agentRuntimeStepStatusLabel(status: BotanicAgentRuntimeStep['status'], locale: ProductLocale = 'zh-CN') {
  if (status === 'succeeded') return locale === 'en' ? 'Completed' : '已完成'
  if (status === 'failed') return locale === 'en' ? 'Failed' : '失败'
  if (status === 'running') return locale === 'en' ? 'Running' : '执行中'
  return locale === 'en' ? 'Pending' : '待执行'
}

export function agentRuntimeStepMarker(step: BotanicAgentRuntimeStep) {
  if (step.status === 'succeeded') return '✓'
  if (step.status === 'failed') return '!'
  if (step.status === 'running') return '·'
  if (step.kind === 'search') return '⌕'
  if (step.kind === 'write') return '↗'
  return '○'
}

export function AgentPanelBackButton({ onClick, label }: { onClick: () => void; label?: string }) {
  const { locale } = useProductI18n()
  return <button type="button" className="agent-panel-back" onClick={onClick}>
    <ChevronLeftIcon />
    <span>{label ?? (locale === 'en' ? 'Back to conversation' : '返回对话')}</span>
  </button>
}

export function AgentBranchStatusIcon({ status }: { status: BotanicAgentRun['branches'][number]['status'] }) {
  const icon = status === 'succeeded'
    ? <CheckIcon />
    : status === 'running'
      ? <span className="agent-branch-status-icon__spinner" />
      : status === 'queued'
        ? <ClockIcon />
        : status === 'cancelled'
          ? <CloseIcon />
          : <AlertIcon />
  return <span className={`agent-branch-status-icon is-${status}`} aria-hidden="true">{icon}</span>
}

export function agentMemoryKindLabel(kind: BotanicAgentMemoryKind, locale: ProductLocale = 'zh-CN') {
  if (kind === 'approved') return locale === 'en' ? 'Approved direction' : '已确认方向'
  if (kind === 'avoid') return locale === 'en' ? 'Avoid' : '避免事项'
  return locale === 'en' ? 'Long-term rule' : '长期规则'
}

export function agentArtifactKindLabel(artifact: BotanicAgentArtifact, locale: ProductLocale = 'zh-CN') {
  if (artifact.kind === 'image') return locale === 'en' ? 'Image' : '图片'
  if (artifact.kind === 'video') return locale === 'en' ? 'Video' : '视频'
  if (artifact.kind === 'workflow') return locale === 'en' ? 'Workflow' : '工作流'
  if (artifact.kind === 'asset_group') return locale === 'en' ? 'Asset group' : '素材组'
  if (artifact.kind === 'file') return locale === 'en' ? 'File' : '文件'
  return locale === 'en' ? 'Text' : '文本'
}

export function agentRunOutputCount(run: BotanicAgentRun, artifacts: BotanicAgentArtifact[]) {
  const persistedCount = agentRunArtifacts(run, artifacts).length
  const branchCount = run.branches.reduce((total, branch) => total + branch.outputCount, 0)
  return Math.max(persistedCount, branchCount)
}

export function agentRunArtifacts(run: BotanicAgentRun, artifacts: BotanicAgentArtifact[]) {
  return artifacts.filter((artifact) => artifact.provenance.runId === run.id)
}

export function agentRunCanvasOutputCount(run: BotanicAgentRun, artifacts: BotanicAgentArtifact[], nodeIds: Set<string>) {
  return agentRunArtifacts(run, artifacts).filter((artifact) => artifact.provenance.sourceNodeIds?.some((nodeId) => nodeIds.has(nodeId))).length
}

export function agentRunFeedback(
  run: BotanicAgentRun,
  artifacts: BotanicAgentArtifact[],
  nodeIds: Set<string>,
  locale: ProductLocale = 'zh-CN',
) {
  const outputCount = agentRunOutputCount(run, artifacts)
  const result = botanicAgentRunFeedback(run.status, outputCount, run.error, {
    artifactCount: agentRunArtifacts(run, artifacts).length,
    canvasOutputCount: agentRunCanvasOutputCount(run, artifacts, nodeIds),
    activeBranchCount: run.branches.filter((branch) => branch.status === 'queued' || branch.status === 'running').length,
  })
  if (locale !== 'en') return result
  const labels = { awaiting_confirmation: 'Awaiting approval', queued: 'Queued', executing: 'Generating', running: 'Generating', completed: 'Completed', partial: 'Partially completed', failed: /timeout|timed out/i.test(run.error ?? '') ? 'Timed out' : 'Generation failed', cancelled: 'Cancelled' } as const
  const actionLabels = { view_task: 'View task', view_results: 'View results', adjust: 'Adjust and retry', none: '' } as const
  const detail = run.status === 'awaiting_confirmation' ? 'Generation starts after approval.'
    : run.status === 'queued' ? 'Queued and waiting to generate.'
      : run.status === 'executing' || run.status === 'running' ? 'Generating now; results will be added to the canvas.'
        : run.status === 'completed' ? (outputCount ? `${outputCount} result${outputCount === 1 ? '' : 's'} available.` : 'Completed with no available results yet.')
          : run.status === 'partial' ? `${outputCount} result${outputCount === 1 ? '' : 's'} available; some branches failed.`
            : run.status === 'cancelled' ? `Cancelled; ${outputCount} result${outputCount === 1 ? '' : 's'} kept.`
              : /timeout|timed out/i.test(run.error ?? '') ? 'Generation timed out. Adjust the settings and retry.' : (outputCount ? `Not completed; ${outputCount} result${outputCount === 1 ? '' : 's'} kept.` : 'The task did not complete. Adjust the settings and retry.')
  return { ...result, label: labels[run.status], detail, actionLabel: actionLabels[result.action] }
}

export function AgentClarificationCard({
  clarification,
  generationModels,
  state,
  onSubmit,
}: {
  clarification: BotanicAgentClarification
  generationModels: GenerationModelOption[]
  state: 'idle' | 'submitting' | 'completed'
  onSubmit: (answers: Record<string, string>) => void
}) {
  const { locale } = useProductI18n()
  const copy = useProductMessages({
    'zh-CN': { recommended: '推荐', confirmedAria: '已确认的创作设置', confirmed: '创作设置已确认', aria: '创作设置确认', title: '确认创作设置', custom: '自定义优化方向', planning: '正在规划…', continue: '继续规划' },
    en: { recommended: 'Recommended', confirmedAria: 'Confirmed creative settings', confirmed: 'Creative settings confirmed', aria: 'Creative settings confirmation', title: 'Confirm creative settings', custom: 'Custom direction', planning: 'Planning…', continue: 'Continue planning' },
  })
  const [answers, setAnswers] = useState<Record<string, string>>(() => Object.fromEntries(
    clarification.fields.flatMap((field) => field.defaultValue ? [[field.id, field.defaultValue]] : []),
  ))
  const selectedModel = generationModels.find((model) => model.id === answers.model)
  const fields = clarification.fields.map((field) => {
    const values = field.id === 'aspect_ratio' && selectedModel?.aspectRatios?.length
      ? selectedModel.aspectRatios
      : field.id === 'resolution' && selectedModel?.resolutions?.length
        ? selectedModel.resolutions
        : undefined
    const options = values
      ? values.map((value) => ({ value, label: value, description: value === field.defaultValue ? copy.recommended : undefined }))
      : field.options
    return { ...field, options }
  })
  const complete = botanicAgentClarificationAnswersComplete(fields, answers)
  const customDirection = answers.custom_direction?.trim()
  const selectionSummary = [
    ...fields.map((field) => field.control === 'text'
      ? answers[field.id]?.trim()
      : field.options.find((option) => option.value === answers[field.id])?.label),
    fields.some((field) => field.id === 'custom_direction') ? undefined : customDirection,
  ].filter(Boolean)
    .join(' · ')
  const asksCustomText = fields.some((field) => field.id === 'custom_direction')
  const disabled = state === 'submitting'
  const selectOption = (fieldId: BotanicAgentClarificationField['id'], value: string) => {
    setAnswers((current: Record<string, string>) => {
      const next: Record<string, string> = { ...current, [fieldId]: value }
      if (fieldId === 'prompt_direction' && value !== 'custom') delete next.custom_direction
      if (fieldId !== 'model') return next
      const model = generationModels.find((item) => item.id === value)
      for (const dependent of fields.filter((field) => field.id === 'aspect_ratio' || field.id === 'resolution')) {
        const supported = dependent.id === 'aspect_ratio' ? model?.aspectRatios : model?.resolutions
        if (supported?.length && !supported.some((item) => item === next[dependent.id])) next[dependent.id] = supported[0]
      }
      return next
    })
  }
  const renderChoice = (field: (typeof fields)[number], option: (typeof fields)[number]['options'][number]) => (
    <button
      key={option.value}
      type="button"
      aria-pressed={answers[field.id] === option.value}
      className={answers[field.id] === option.value ? 'is-selected' : ''}
      disabled={disabled}
      title={option.description}
      onClick={() => selectOption(field.id, option.value)}
    >
      <span>{option.label}</span>
      {field.id !== 'prompt_direction' && option.description ? <small>{option.description}</small> : null}
    </button>
  )
  if (state === 'completed') {
    return (
      <section className="agent-clarification-card is-complete" aria-label={copy.confirmedAria} aria-live="polite">
        <span className="agent-clarification-card__complete-mark" aria-hidden="true">✓</span>
        <span className="agent-clarification-card__complete-copy">
          <strong>{copy.confirmed}</strong>
          {selectionSummary ? <small>{selectionSummary}</small> : null}
        </span>
      </section>
    )
  }
  return (
    <section className="agent-clarification-card" aria-label={copy.aria}>
      <div className="agent-clarification-card__intro">
        <header>
          <strong>{copy.title}</strong>
          {clarification.question ? <small>{clarification.question}</small> : null}
        </header>
      </div>
      <div className="agent-clarification-card__fields">
        {fields.map((field) => {
          const directionPresets = field.id === 'prompt_direction'
            ? field.options.filter((option) => option.value !== 'custom')
            : []
          const customDirectionOption = field.id === 'prompt_direction'
            ? field.options.find((option) => option.value === 'custom')
            : undefined
          return <fieldset key={field.id} data-field={field.id}>
            <legend>{field.label}</legend>
            {field.control === 'text' ? <textarea
              aria-label={field.label}
              value={answers[field.id] ?? ''}
              placeholder={field.placeholder}
              disabled={disabled}
              maxLength={500}
              onChange={(event) => setAnswers((current) => ({ ...current, [field.id]: event.target.value }))}
            /> : field.id === 'prompt_direction' ? <>
              <div role="group" aria-label={field.label} className="agent-clarification-card__choices">
                {directionPresets.map((option) => renderChoice(field, option))}
              </div>
              {customDirectionOption ? <button
                type="button"
                className={`agent-clarification-card__custom-link${answers.prompt_direction === 'custom' ? ' is-selected' : ''}`}
                aria-pressed={answers.prompt_direction === 'custom'}
                disabled={disabled}
                onClick={() => selectOption('prompt_direction', 'custom')}
              >{customDirectionOption.label}</button> : null}
              {answers.prompt_direction === 'custom' && !asksCustomText ? <textarea
                aria-label={copy.custom}
                value={answers.custom_direction ?? ''}
                placeholder={locale === 'en' ? 'Describe the visual direction to strengthen' : botanicAgentCustomDirectionPlaceholder}
                disabled={disabled}
                maxLength={500}
                onChange={(event) => setAnswers((current) => ({ ...current, custom_direction: event.target.value }))}
              /> : null}
            </> : <div role="group" aria-label={field.label}>
              {field.options.map((option) => renderChoice(field, option))}
            </div>}
          </fieldset>
        })}
      </div>
      <footer className={`agent-clarification-card__footer${clarification.helper ? '' : ' is-actions-only'}`}>
        {clarification.helper ? <small className="agent-clarification-card__helper">{clarification.helper}</small> : null}
        <button type="button" className="agent-clarification-card__submit" disabled={disabled || !complete} onClick={() => onSubmit(answers)}>{disabled ? copy.planning : copy.continue}</button>
      </footer>
    </section>
  )
}

export function AgentPromptDiff({ original, revised }: { original: string; revised: string }) {
  const { locale } = useProductI18n()
  const segments = buildBotanicAgentPromptDiff(original, revised)
  const changed = segments.some((segment) => segment.kind !== 'same')
  const renderSegment = (segment: BotanicAgentPromptDiffSegment, index: number) => {
    if (segment.kind === 'added') return <ins key={`${segment.kind}-${index}`}>{segment.text}</ins>
    if (segment.kind === 'removed') return <del key={`${segment.kind}-${index}`}>{segment.text}</del>
    return <span key={`${segment.kind}-${index}`}>{segment.text}</span>
  }
  return <p className="agent-prompt-review__diff-body" aria-label={changed ? (locale === 'en' ? 'Original and revised prompt differences' : '原文与润色差异') : (locale === 'en' ? 'Original and revised prompts match' : '原文与润色一致')}>
    {segments.length ? segments.map(renderSegment) : (locale === 'en' ? 'No prompt content yet' : '暂无提示词内容')}
  </p>
}

export function AgentFailureRecoveryActions({
  branch,
  generationModels,
  retrying,
  menuOpen,
  onToggleModelMenu,
  onRetry,
  onPrepare,
}: {
  branch: BotanicAgentRun['branches'][number]
  generationModels: GenerationModelOption[]
  retrying: boolean
  menuOpen: boolean
  onToggleModelMenu: () => void
  onRetry: () => void
  onPrepare: (mode: 'settings' | 'model', model?: GenerationModelOption) => void
}) {
  const { locale } = useProductI18n()
  const recovery = locale === 'en' ? {
    aria: `${branch.label} recovery actions`, retry: 'Retry current branch', retryTitle: 'Retry current branch · reuses the same task and does not create a duplicate', settings: 'Edit settings', settingsTitle: 'Edit settings · prefills the change request without submitting', model: 'Change model', modelTitle: 'Change model · prefills the model without submitting', select: 'Select recovery model', empty: 'No models available',
  } : {
    aria: `${branch.label} 恢复操作`, retry: '重试当前分支', retryTitle: '重试当前分支 · 复用同一任务，不会创建重复任务', settings: '修改参数', settingsTitle: '修改参数 · 只预填修改要求，不会立即提交', model: '更换模型', modelTitle: '更换模型 · 只预填模型，不会立即提交', select: '选择恢复模型', empty: '暂无可用模型',
  }
  return (
    <div className="agent-recovery-actions" aria-label={recovery.aria}>
      <button type="button" className="is-retry" aria-label={recovery.retry} disabled={retrying} onClick={onRetry} title={recovery.retryTitle}>
        {retrying ? <span className="agent-workspace__mini-spinner" /> : <RefreshIcon />}
      </button>
      <button type="button" aria-label={recovery.settings} onClick={() => onPrepare('settings')} title={recovery.settingsTitle}><EditIcon /></button>
      <span className="agent-recovery-model-picker">
        <button type="button" aria-label={recovery.model} aria-expanded={menuOpen} onClick={onToggleModelMenu} title={recovery.modelTitle}><SlidersIcon /></button>
        {menuOpen ? <div className="agent-recovery-model-menu" role="group" aria-label={recovery.select} onPointerDown={(event) => event.stopPropagation()}>
          {generationModels.map((model) => <button key={model.id} type="button" onClick={() => onPrepare('model', model)}>
            <span>{modelProviderLogo(model) ? <img src={modelProviderLogo(model)} alt="" /> : null}<b>{modelDisplayLabel(model)}</b></span>
          </button>)}
          {!generationModels.length ? <small>{recovery.empty}</small> : null}
        </div> : null}
      </span>
    </div>
  )
}
