import { useState } from 'react'
import {
  buildBotanicAgentPromptDiff,
  type BotanicAgentArtifact,
  type BotanicAgentClarification,
  type BotanicAgentClarificationField,
  type BotanicAgentMemoryKind,
  type BotanicAgentPlan,
  type BotanicAgentPromptDiffSegment,
  type BotanicAgentRun,
  type BotanicAgentRuntimeStep,
} from '../../domain/agent'
import type { GenerationModelOption } from '../../domain/canvas'
import { modelDisplayLabel, modelProviderLogo } from '../../components/generationModelPresentation'
import { RefreshIcon } from '../../components/BotanicIcons'

export function agentToolStatusLabel(status: NonNullable<BotanicAgentPlan['toolCalls']>[number]['status']) {
  if (status === 'succeeded') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'awaiting_confirmation') return '待确认'
  if (status === 'running') return '执行中'
  return '待执行'
}

export function agentRuntimeStepStatusLabel(status: BotanicAgentRuntimeStep['status']) {
  if (status === 'succeeded') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'running') return '执行中'
  return '待执行'
}

export function agentRuntimeStepMarker(step: BotanicAgentRuntimeStep) {
  if (step.status === 'succeeded') return '✓'
  if (step.status === 'failed') return '!'
  if (step.status === 'running') return '·'
  if (step.kind === 'search') return '⌕'
  if (step.kind === 'write') return '↗'
  return '○'
}

export function agentMemoryKindLabel(kind: BotanicAgentMemoryKind) {
  if (kind === 'approved') return '已确认方向'
  if (kind === 'avoid') return '避免事项'
  return '长期规则'
}

export function agentArtifactKindLabel(artifact: BotanicAgentArtifact) {
  if (artifact.kind === 'image') return '图片'
  if (artifact.kind === 'video') return '视频'
  if (artifact.kind === 'workflow') return '工作流'
  if (artifact.kind === 'asset_group') return '素材组'
  if (artifact.kind === 'file') return '文件'
  return '文本'
}

export function agentRunOutputCount(run: BotanicAgentRun, artifacts: BotanicAgentArtifact[]) {
  const persistedCount = artifacts.filter((artifact) => artifact.provenance.runId === run.id).length
  const branchCount = run.branches.reduce((total, branch) => total + branch.outputCount, 0)
  return Math.max(persistedCount, branchCount)
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
      ? values.map((value) => ({ value, label: value, description: value === field.defaultValue ? '推荐' : undefined }))
      : field.options
    return { ...field, options }
  })
  const complete = fields.every((field) => !field.required || Boolean(answers[field.id]) && field.options.some((option) => option.value === answers[field.id]))
  const selectionSummary = fields
    .map((field) => field.options.find((option) => option.value === answers[field.id])?.label)
    .filter(Boolean)
    .join(' · ')
  const selectOption = (fieldId: BotanicAgentClarificationField['id'], value: string) => {
    setAnswers((current: Record<string, string>) => {
      const next: Record<string, string> = { ...current, [fieldId]: value }
      if (fieldId !== 'model') return next
      const model = generationModels.find((item) => item.id === value)
      for (const dependent of fields.filter((field) => field.id === 'aspect_ratio' || field.id === 'resolution')) {
        const supported = dependent.id === 'aspect_ratio' ? model?.aspectRatios : model?.resolutions
        if (supported?.length && !supported.some((item) => item === next[dependent.id])) next[dependent.id] = supported[0]
      }
      return next
    })
  }
  if (state === 'completed') {
    return (
      <section className="agent-clarification-card is-complete" aria-label="已确认的输出设置" aria-live="polite">
        <span className="agent-clarification-card__complete-mark" aria-hidden="true">✓</span>
        <span className="agent-clarification-card__complete-copy">
          <strong>输出设置已确认</strong>
          {selectionSummary ? <small>{selectionSummary}</small> : null}
        </span>
      </section>
    )
  }
  const disabled = state === 'submitting'
  return (
    <section className="agent-clarification-card" aria-label="生成前参数确认">
      <div className="agent-clarification-card__intro">
        <header><strong>确认输出设置</strong><small>确认后继续规划，不会立即生成</small></header>
        <p>{clarification.question}</p>
      </div>
      <div className="agent-clarification-card__fields">
        {fields.map((field) => <fieldset key={field.id} data-field={field.id}>
          <legend>{field.label}</legend>
          <div role="group" aria-label={field.label}>
            {field.options.map((option) => <button
              key={option.value}
              type="button"
              aria-pressed={answers[field.id] === option.value}
              className={answers[field.id] === option.value ? 'is-selected' : ''}
              disabled={disabled}
              onClick={() => selectOption(field.id, option.value)}
            ><span>{option.label}</span>{option.description ? <small>{option.description}</small> : null}</button>)}
          </div>
        </fieldset>)}
      </div>
      <footer className="agent-clarification-card__footer">
        {clarification.helper ? <small className="agent-clarification-card__helper">{clarification.helper}</small> : <span />}
        <button type="button" className="agent-clarification-card__submit" disabled={disabled || !complete} onClick={() => onSubmit(answers)}>{disabled ? '正在规划…' : '继续规划'}</button>
      </footer>
    </section>
  )
}

export function AgentPromptDiff({ original, revised }: { original: string; revised: string }) {
  const segments = buildBotanicAgentPromptDiff(original, revised)
  const changed = segments.some((segment) => segment.kind !== 'same')
  const renderSegment = (segment: BotanicAgentPromptDiffSegment, index: number) => {
    if (segment.kind === 'added') return <ins key={`${segment.kind}-${index}`}>{segment.text}</ins>
    if (segment.kind === 'removed') return <del key={`${segment.kind}-${index}`}>{segment.text}</del>
    return <span key={`${segment.kind}-${index}`}>{segment.text}</span>
  }
  return (
    <section className="agent-prompt-review__diff" aria-label="提示词变化">
      <header><span>原文与润色差异</span><b>{changed ? '已突出变化' : '未改动'}</b></header>
      <p>{segments.length ? segments.map(renderSegment) : '暂无提示词内容'}</p>
    </section>
  )
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
  return (
    <div className="agent-recovery-actions" aria-label={`${branch.label} 恢复操作`}>
      <button type="button" className="is-retry" disabled={retrying} onClick={onRetry} title="复用同一任务，不会创建重复任务">
        {retrying ? <span className="agent-workspace__mini-spinner" /> : <RefreshIcon />}<span>重试当前分支</span>
      </button>
      <button type="button" onClick={() => onPrepare('settings')} title="只预填修改要求，不会立即提交">修改参数</button>
      <span className="agent-recovery-model-picker">
        <button type="button" aria-expanded={menuOpen} onClick={onToggleModelMenu} title="只预填模型，不会立即提交">更换模型</button>
        {menuOpen ? <div className="agent-recovery-model-menu" role="group" aria-label="选择恢复模型" onPointerDown={(event) => event.stopPropagation()}>
          {generationModels.map((model) => <button key={model.id} type="button" onClick={() => onPrepare('model', model)}>
            <span>{modelProviderLogo(model) ? <img src={modelProviderLogo(model)} alt="" /> : null}<b>{modelDisplayLabel(model)}</b></span>
          </button>)}
          {!generationModels.length ? <small>暂无可用模型</small> : null}
        </div> : null}
      </span>
    </div>
  )
}

export function createInitialAgentClarification(instruction: string, models: GenerationModelOption[]): BotanicAgentClarification {
  const available = models.length ? models : [{ id: 'gpt-image-2', label: 'GPT Image 2' }]
  const current = available[0]
  const ratios = current.aspectRatios?.length ? current.aspectRatios : ['1:1', '3:4', '4:3', '16:9', '9:16']
  const resolutions = current.resolutions?.length ? current.resolutions : ['1K', '2K']
  return {
    id: `clarification-local-${crypto.randomUUID()}`,
    question: '为了让第一张图更接近你的目标，先确认一下输出设置。',
    helper: '不确定时可以保留推荐值，之后仍可在生成节点里修改。',
    originalInstruction: instruction,
    fields: [
      { id: 'model', label: '生成模型', required: true, defaultValue: current.id, options: available.map((model) => ({ value: model.id, label: model.label, description: model.mediaKind === 'video' ? '视频生成' : '图片生成' })) },
      { id: 'aspect_ratio', label: '画面比例', required: true, defaultValue: ratios[0], options: ratios.map((value) => ({ value, label: value })) },
      { id: 'resolution', label: '分辨率', required: true, defaultValue: resolutions[0], options: resolutions.map((value) => ({ value, label: value })) },
    ],
  }
}
