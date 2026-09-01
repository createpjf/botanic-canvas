import { useEffect, useId, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent, RefObject } from 'react'
import { botanicAgentExecutionModeLabel, type BotanicAgentMentionQuery, type BotanicAgentSession } from '../../domain/agent'
import type { AssetGroup } from '../../domain/canvas'
import { imageUploadAccept } from '../../domain/mediaFormats'
import { AgentPlannerProviderIcon } from '../../components/AgentPlannerProviderIcon'
import { BotanicSelect } from '../../components/BotanicSelect'
import { AutoRunIcon, ChecklistIcon, ChevronDownIcon, CloseIcon, PlusIcon, SparkleIcon, UploadIcon } from '../../components/BotanicIcons'
import {
  botanicMotion,
  Flip,
  gsap,
  prefersReducedMotion,
  sendArrowPath,
  sendStopPath,
  useGSAP,
} from '../../components/gsapMotion'
import { agentPlannerModelLabel, agentPlannerModelShortLabel } from '../../components/generationModelPresentation'
import type { AgentContextItem, AgentSkillOption } from './agentWorkspace.types'
import { nextAgentSuggestionIndex } from './agentComposerState'
import { BOTANIC_AGENT_MOUNTED_SKILL_LIMIT } from './agentSkillForm'
import { useProductI18n, useProductMessages } from '../../i18n/react'

type AgentComposerProps = {
  session?: BotanicAgentSession
  contextItems: AgentContextItem[]
  mentionQuery?: BotanicAgentMentionQuery
  mentionOptions: AgentContextItem[]
  skillOptions: AgentSkillOption[]
  mountedSkills: AgentSkillOption[]
  instruction: string
  intentHint?: string
  error: string
  canRetry: boolean
  retrying: boolean
  planning: boolean
  cancelling: boolean
  contextMenuOpen: boolean
  modeMenuOpen: boolean
  contextMenuId: string
  modeMenuId: string
  plannerModel: string
  plannerModels: string[]
  showRawReasoning: boolean
  groupId: string
  compatibleGroups: AssetGroup[]
  imageContextOptions: AgentContextItem[]
  textareaRef: RefObject<HTMLTextAreaElement | null>
  fileInputRef: RefObject<HTMLInputElement | null>
  contextMenuButtonRef: RefObject<HTMLButtonElement | null>
  modeMenuButtonRef: RefObject<HTMLButtonElement | null>
  onRemoveContext: (itemId: string) => void
  onRemoveMountedSkill: (skillId: string) => void
  onSelectMention: (item: AgentContextItem) => void
  onSelectSkill: (skill: AgentSkillOption) => void
  onCreateSkill: () => void
  onDismissMention: () => void
  onInstructionChange: (value: string, caret: number) => void
  onInstructionClick: (caret: number) => void
  onRetry: () => void
  onImportFiles: (files: File[]) => void
  onToggleContextMenu: () => void
  onCloseContextMenu: () => void
  onToggleModeMenu: () => void
  onPlannerModelChange: (model: string) => void
  onShowRawReasoningChange: (show: boolean) => void
  onGroupChange: (groupId: string) => void
  onSend: () => void
  onCancelPlanning: () => void
  onToggleImageContext: (itemId: string, selected: boolean) => void
  onExecutionModeChange: (mode: 'manual' | 'auto') => void
}

export function AgentComposer({
  session,
  contextItems,
  mentionQuery,
  mentionOptions,
  skillOptions,
  mountedSkills,
  instruction,
  intentHint,
  error,
  canRetry,
  retrying,
  planning,
  cancelling,
  contextMenuOpen,
  modeMenuOpen,
  contextMenuId,
  modeMenuId,
  plannerModel,
  plannerModels,
  showRawReasoning,
  groupId,
  compatibleGroups,
  imageContextOptions,
  textareaRef,
  fileInputRef,
  contextMenuButtonRef,
  modeMenuButtonRef,
  onRemoveContext,
  onRemoveMountedSkill,
  onSelectMention,
  onSelectSkill,
  onCreateSkill,
  onDismissMention,
  onInstructionChange,
  onInstructionClick,
  onRetry,
  onImportFiles,
  onToggleContextMenu,
  onCloseContextMenu,
  onToggleModeMenu,
  onPlannerModelChange,
  onShowRawReasoningChange,
  onGroupChange,
  onSend,
  onCancelPlanning,
  onToggleImageContext,
  onExecutionModeChange,
}: AgentComposerProps) {
  const { locale } = useProductI18n()
  const copy = useProductMessages({
    'zh-CN': {
      input: 'Agent 输入', referenced: '已引用', remove: '移除', mounted: '已挂载', callSkill: '挂载 Skill', systemSkill: '系统 Skill', projectSkill: '项目 Skill', createSkill: '创建项目 Skill', saveRules: '保存一组可复用规则', referenceCanvas: '引用画布节点或图片视频', description: '补充描述', asset: '素材', result: '结果', video: '视频', noMatch: '没有匹配项，按 Esc 关闭', noSkillMatch: '没有匹配的 Skill，按 Esc 关闭', placeholder: '例如：更冷的晨光，服装和商品保持', message: 'Agent 消息', promptField: '提示词', retry: '重试', addImages: '添加图像素材', executionMode: '执行模式', manual: '计划模式', auto: '自动模式', manualTitle: '计划模式：出图先给计划，确认后再提交', autoTitle: '自动模式：单张设置完整后直接提交，多张或外部行动仍需确认', model: 'Agent 模型', assetGroup: '素材组', single: '单张', group: '组', send: '发送给 Agent', stop: '停止', closeImages: '关闭添加图像素材', chooseImages: '从电脑选择图片', dragHint: '也可以直接拖入 Agent 面板', noImages: '暂无图像素材，可从电脑选择或直接拖入。', manualHelp: '出图需确认后再提交', autoHelp: '单张可直接提交；多张仍需确认', rawReasoning: '模型推理原文（实验）', rawReasoningHelp: '当前会话 · 不保存 · 取决于模型支持', textKind: '文字',
    },
    en: {
      input: 'Agent input', referenced: 'Referenced', remove: 'Remove', mounted: 'Mounted', callSkill: 'Mount Skill', systemSkill: 'System Skill', projectSkill: 'Project Skill', createSkill: 'Create project Skill', saveRules: 'Save a reusable set of rules', referenceCanvas: 'Reference canvas nodes or media', description: 'Description', asset: 'Asset', result: 'Result', video: 'Video', noMatch: 'No matches. Press Esc to close.', noSkillMatch: 'No matching Skill. Press Esc to close.', placeholder: 'e.g. Cooler morning light — keep clothes and product', message: 'Agent message', promptField: 'Prompt', retry: 'Retry', addImages: 'Add images', executionMode: 'Execution mode', manual: 'Plan mode', auto: 'Auto mode', manualTitle: 'Plan mode: review image plans before generating', autoTitle: 'Auto mode: submit one complete image job directly; batches and external actions still need confirmation', model: 'Agent model', assetGroup: 'Asset group', single: 'Single', group: 'Group', send: 'Send to Agent', stop: 'Stop', closeImages: 'Close image picker', chooseImages: 'Choose images', dragHint: 'Or drop images into the Agent panel', noImages: 'No images yet. Choose files or drop them here.', manualHelp: 'Confirm image plans before submit', autoHelp: 'Single images submit directly; batches still need confirmation', rawReasoning: 'Model reasoning text (experimental)', rawReasoningHelp: 'Current session · not saved · model dependent', textKind: 'Text',
    },
  })
  const composerErrorId = useId()
  const suggestionListId = useId()
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0)
  const executionModeLabel = locale === 'en'
    ? (session?.executionMode === 'auto' ? copy.auto : copy.manual)
    : botanicAgentExecutionModeLabel(session?.executionMode ?? 'manual')
  const executionModeAriaLabel = `${copy.executionMode}${locale === 'en' ? ': ' : '：'}${executionModeLabel}`
  const contextKindLabel = (kind: AgentContextItem['kind']) => locale === 'en'
    ? ({ '素材': 'Asset', '结果': 'Result', '文字': 'Text', '节点': 'Node' }[kind] ?? 'Item')
    : kind
  const mentionBadge = (item: AgentContextItem) => {
    if (item.image) return <img src={item.image} alt="" />
    if (item.mediaKind === 'video') return <span aria-label={copy.video}>{locale === 'en' ? 'V' : '视'}</span>
    return <span>{contextKindLabel(item.kind).slice(0, 1)}</span>
  }
  const mentionMeta = (item: AgentContextItem) => {
    if (item.kind === '文字') return copy.description
    if (item.kind === '结果') return copy.result
    if (item.mediaKind === 'video') return copy.video
    return copy.asset
  }
  const skillMenuOpen = mentionQuery?.trigger === '/'
  const canvasMenuOpen = mentionQuery?.trigger === '@'
  const mountedSkillIds = new Set(mountedSkills.map((skill) => skill.id))
  const skillLimitReached = mountedSkills.length >= BOTANIC_AGENT_MOUNTED_SKILL_LIMIT
  const skillOptionUnavailable = (skill: AgentSkillOption) => skillLimitReached && !mountedSkillIds.has(skill.id)
  // Composite listbox:方向键只走可用 option;active(键盘高亮)与 selected(已挂载)是两件事。
  const selectableSuggestionIndexes = skillMenuOpen
    ? [
        ...skillOptions.flatMap((skill, index) => skillOptionUnavailable(skill) ? [] : [index]),
        ...(skillLimitReached ? [] : [skillOptions.length]),
      ]
    : canvasMenuOpen
      ? mentionOptions.map((_, index) => index)
      : []
  const selectedSuggestionIndex = selectableSuggestionIndexes.includes(activeSuggestionIndex)
    ? activeSuggestionIndex
    : (selectableSuggestionIndexes[0] ?? -1)
  const activeSuggestionId = selectedSuggestionIndex >= 0
    ? `${suggestionListId}-option-${selectedSuggestionIndex}`
    : undefined
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape' && mentionQuery) {
      event.preventDefault()
      onDismissMention()
      return
    }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && mentionQuery && selectableSuggestionIndexes.length) {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 'ArrowDown' : 'ArrowUp'
      const currentPosition = Math.max(0, selectableSuggestionIndexes.indexOf(selectedSuggestionIndex))
      const nextPosition = nextAgentSuggestionIndex(currentPosition, selectableSuggestionIndexes.length, direction)
      setActiveSuggestionIndex(selectableSuggestionIndexes[nextPosition])
      return
    }
    if (event.key === 'Enter' && mentionQuery) {
      if (skillMenuOpen && skillOptions[selectedSuggestionIndex]) {
        event.preventDefault()
        const selected = skillOptions[selectedSuggestionIndex]
        if (!skillOptionUnavailable(selected)) onSelectSkill(selected)
        return
      }
      if (skillMenuOpen && selectedSuggestionIndex === skillOptions.length) {
        event.preventDefault()
        if (!skillLimitReached) onCreateSkill()
        return
      }
      if (canvasMenuOpen && mentionOptions[selectedSuggestionIndex]) {
        event.preventDefault()
        onSelectMention(mentionOptions[selectedSuggestionIndex])
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      if (planning) return
      onSend()
    }
  }
  const handleFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
    onImportFiles(files)
  }

  const canSend = Boolean(instruction.trim() || contextItems.length || mountedSkills.length)
  const composerRef = useRef<HTMLDivElement>(null)
  const chipFlipState = useRef<Flip.FlipState | undefined>(undefined)
  const chipSignature = [...contextItems.map((item) => item.id), ...mountedSkills.map((skill) => skill.id)].join('|')
  const mentionMenuKey = mentionQuery?.trigger ?? ''

  useEffect(() => setActiveSuggestionIndex(0), [mentionQuery?.query, mentionQuery?.trigger])

  useEffect(() => {
    if (!activeSuggestionId) return
    document.getElementById(activeSuggestionId)?.scrollIntoView({ block: 'nearest' })
  }, [activeSuggestionId])

  useGSAP(() => {
    const chips = gsap.utils.toArray<HTMLElement>('[data-flip-id]', composerRef.current)
    const previous = chipFlipState.current
    chipFlipState.current = Flip.getState(chips)
    if (prefersReducedMotion()) return
    if (!previous) {
      if (chips.length) gsap.from(chips, { autoAlpha: 0, y: 4, scale: 0.96, stagger: 0.03, duration: botanicMotion.duration.chip })
      return
    }
    Flip.from(previous, {
      duration: botanicMotion.duration.chip,
      ease: botanicMotion.ease,
      nested: true,
      absolute: false,
      onEnter: (elements) => gsap.fromTo(elements, { autoAlpha: 0, scale: 0.94 }, {
        autoAlpha: 1,
        scale: 1,
        duration: botanicMotion.duration.chip,
        ease: botanicMotion.ease,
      }),
    })
  }, { scope: composerRef, dependencies: [chipSignature] })

  useGSAP(() => {
    const menus = gsap.utils.toArray<HTMLElement>('.agent-composer__mention-menu', composerRef.current)
    if (!menus.length || prefersReducedMotion()) return
    gsap.from(menus, { autoAlpha: 0, y: 6, duration: botanicMotion.duration.toast })
  }, { scope: composerRef, dependencies: [mentionMenuKey] })

  return <div ref={composerRef} className="agent-composer" role="group" aria-label={copy.input} aria-busy={planning}>
    {contextItems.length || mountedSkills.length ? <div className="agent-composer__attachments">
      {contextItems.length ? <div className="agent-composer__attach-row" aria-label={`${copy.referenced} ${contextItems.length}`}>
        <span className="agent-composer__attach-label">{copy.referenced}</span>
        <div className="agent-composer__attach-chips">
          {contextItems.map((item) => <button key={item.id} data-flip-id={item.id} type="button" className="agent-composer__chip is-media" aria-label={`${copy.remove} ${item.label}`} title={item.kind === '文字' && item.content ? `${copy.description} “${item.label}”: ${item.content}` : `${copy.remove} ${item.label}`} onClick={() => onRemoveContext(item.id)}>
            {item.image ? <img src={item.image} alt="" /> : <span>{contextKindLabel(item.kind).slice(0, 1)}</span>}
            <i aria-hidden="true">×</i>
          </button>)}
        </div>
      </div> : null}
      {mountedSkills.length ? <div className="agent-composer__attach-row" aria-label={`${copy.mounted} ${mountedSkills.length} Skill`}>
        <span className="agent-composer__attach-label">{`${copy.mounted} ${mountedSkills.length}/{BOTANIC_AGENT_MOUNTED_SKILL_LIMIT}`}</span>
        <div className="agent-composer__attach-chips">
          {mountedSkills.map((skill) => <button key={skill.id} data-flip-id={skill.id} type="button" className="agent-composer__chip is-skill" aria-label={`${copy.remove} Skill ${skill.name}`} title={`${copy.remove} ${skill.name}`} onClick={() => onRemoveMountedSkill(skill.id)}>
            <SparkleIcon /><b>{skill.name}</b><i aria-hidden="true">×</i>
          </button>)}
        </div>
      </div> : null}
    </div> : null}
    {skillMenuOpen ? <div id={suggestionListId} className="agent-composer__mention-menu" role="listbox" aria-multiselectable="true" aria-label={copy.callSkill} onPointerDown={(event) => event.stopPropagation()}>
      {skillOptions.length ? <div className="agent-composer__mention-section" role="group" aria-label={copy.callSkill}><strong>{copy.callSkill}<span className="agent-composer__mention-count">{mountedSkills.length}/{BOTANIC_AGENT_MOUNTED_SKILL_LIMIT}</span></strong>{skillOptions.map((skill, index) => {
        const mounted = mountedSkillIds.has(skill.id)
        const unavailable = skillOptionUnavailable(skill)
        return <button id={`${suggestionListId}-option-${index}`} key={`skill-${skill.id}`} type="button" role="option" tabIndex={-1} disabled={unavailable} aria-disabled={unavailable} aria-selected={mounted} className={selectedSuggestionIndex === index ? 'is-active' : undefined} aria-label={`${copy.callSkill} ${skill.name}`} onMouseEnter={() => { if (!unavailable) setActiveSuggestionIndex(index) }} onMouseDown={(event) => event.preventDefault()} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); if (!unavailable) onSelectSkill(skill) }}><SparkleIcon /><b>{skill.name}</b><small>{skill.source === 'system' ? copy.systemSkill : copy.projectSkill}{mounted ? ' · ✓' : ''}</small></button>
      })}</div> : null}
      <button id={`${suggestionListId}-option-${skillOptions.length}`} type="button" role="option" tabIndex={-1} disabled={skillLimitReached} aria-disabled={skillLimitReached} aria-selected={false} className={`agent-composer__create-skill${selectedSuggestionIndex === skillOptions.length ? ' is-active' : ''}`} aria-label={copy.createSkill} onMouseEnter={() => { if (!skillLimitReached) setActiveSuggestionIndex(skillOptions.length) }} onMouseDown={(event) => event.preventDefault()} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); if (!skillLimitReached) onCreateSkill() }}><PlusIcon /><b>{copy.createSkill}</b><small>{copy.saveRules}</small></button>
      {!skillOptions.length ? <p>{copy.noSkillMatch}</p> : null}
    </div> : null}
    {canvasMenuOpen ? <div id={suggestionListId} className="agent-composer__mention-menu" role="listbox" aria-label={copy.referenceCanvas} onPointerDown={(event) => event.stopPropagation()}>
      {mentionOptions.length ? <div className="agent-composer__mention-section" role="group" aria-label={copy.referenceCanvas}><strong>{copy.referenceCanvas}</strong>{mentionOptions.map((item, index) => <button id={`${suggestionListId}-option-${index}`} key={item.id} type="button" role="option" tabIndex={-1} aria-selected={selectedSuggestionIndex === index} aria-label={`${copy.referenceCanvas} ${item.label}`} title={item.content ?? item.label} onMouseEnter={() => setActiveSuggestionIndex(index)} onMouseDown={(event) => event.preventDefault()} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onSelectMention(item) }}>{mentionBadge(item)}<b>{item.label}</b><small>{mentionMeta(item)}</small></button>)}</div> : <p>{copy.noMatch}</p>}
    </div> : null}
    <textarea
      ref={textareaRef}
      value={instruction}
      onChange={(event) => onInstructionChange(event.target.value, event.target.selectionStart ?? event.target.value.length)}
      onClick={(event) => onInstructionClick(event.currentTarget.selectionStart ?? instruction.length)}
      onKeyDown={handleKeyDown}
      placeholder={copy.placeholder}
      role="combobox"
      aria-autocomplete="list"
      aria-haspopup="listbox"
      aria-expanded={Boolean(mentionQuery)}
      aria-controls={mentionQuery ? suggestionListId : undefined}
      aria-activedescendant={mentionQuery ? activeSuggestionId : undefined}
      aria-label={copy.promptField}
      aria-invalid={Boolean(error)}
      aria-describedby={error ? composerErrorId : undefined}
    />
    {error ? <div id={composerErrorId} className="agent-composer__error" role="alert"><span>{error}</span>{canRetry ? <button type="button" onClick={onRetry} disabled={retrying}>{copy.retry}</button> : null}</div> : intentHint ? <p className="agent-composer__intent" role="status">{intentHint}</p> : null}
    <input ref={fileInputRef} className="asset-file-input" type="file" accept={imageUploadAccept()} multiple aria-label={copy.addImages} onChange={handleFiles} />
    <div className="agent-composer__toolbar">
      <div>
        <button ref={contextMenuButtonRef} type="button" className="agent-composer__add" onClick={onToggleContextMenu} aria-controls={contextMenuId} aria-expanded={contextMenuOpen} aria-label={copy.addImages} title={copy.addImages}><PlusIcon /></button>
        <button ref={modeMenuButtonRef} type="button" className="agent-composer__mode" onClick={onToggleModeMenu} aria-controls={modeMenuId} aria-expanded={modeMenuOpen} aria-label={executionModeAriaLabel} title={session?.executionMode === 'auto' ? copy.autoTitle : copy.manualTitle}>
          {session?.executionMode === 'auto' ? <AutoRunIcon /> : <ChecklistIcon />}<span className="agent-composer__mode-label" aria-hidden="true">{executionModeLabel}</span><ChevronDownIcon className="agent-composer__mode-chevron" />
        </button>
        <BotanicSelect
          className="agent-composer__model-select"
          value={plannerModel}
          ariaLabel={`${copy.model}: ${agentPlannerModelLabel(plannerModel)}`}
          menuWidth={220}
          options={plannerModels.map((model) => ({ value: model, label: agentPlannerModelLabel(model) }))}
          onChange={onPlannerModelChange}
          renderTrigger={(selected) => <span className="agent-model-trigger" title={agentPlannerModelShortLabel(selected?.value ?? plannerModel)}><AgentPlannerProviderIcon model={selected?.value ?? plannerModel} /><span className="agent-model-trigger__label">{agentPlannerModelShortLabel(selected?.value ?? plannerModel)}</span></span>}
          renderOption={(option, selected) => <span className="agent-model-option"><span className="agent-model-option__main"><AgentPlannerProviderIcon model={option.value} /><span>{option.label}</span></span>{selected ? <b aria-hidden="true">✓</b> : null}</span>}
        />
        {compatibleGroups.length ? <BotanicSelect className="agent-composer__group-select" value={groupId} placeholder={copy.assetGroup} ariaLabel={copy.assetGroup} options={[{ value: '', label: copy.single }, ...compatibleGroups.map((group) => ({ value: group.id, label: `${group.name} · ${group.assetIds.length}` }))]} onChange={onGroupChange} renderTrigger={(selected) => <span className="agent-group-trigger" title={selected?.label ?? copy.single}><strong>{selected?.value ? copy.group : '1'}</strong></span>} /> : null}
      </div>
      <ComposerSendButton
        planning={planning}
        cancelling={cancelling}
        disabled={!canSend || !session}
        sendLabel={copy.send}
        stopLabel={copy.stop}
        onSend={onSend}
        onCancel={onCancelPlanning}
      />
    </div>
    {contextMenuOpen ? <div id={contextMenuId} className="agent-composer__context-menu" role="menu" aria-label={copy.addImages} onPointerDown={(event) => event.stopPropagation()}>
      <header><strong>{copy.addImages}</strong><button type="button" aria-label={copy.closeImages} onClick={onCloseContextMenu}><CloseIcon /></button></header>
      <div className="agent-composer__context-upload">
        <button type="button" role="menuitem" onClick={() => fileInputRef.current?.click()}><UploadIcon /><span><b>{copy.chooseImages}</b><small>{copy.dragHint}</small></span></button>
      </div>
      {imageContextOptions.length ? imageContextOptions.map((item) => {
        const selected = session?.contextNodeIds.includes(item.id) ?? false
        return <button key={item.id} type="button" role="menuitemcheckbox" className={selected ? 'is-selected' : ''} aria-checked={selected} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onToggleImageContext(item.id, selected) }}>{item.image ? <img src={item.image} alt="" /> : null}<span><b>{item.label}</b><small>{contextKindLabel(item.kind)}</small></span>{selected ? <i aria-hidden="true">✓</i> : null}</button>
      }) : <p>{copy.noImages}</p>}
    </div> : null}
    {modeMenuOpen ? <div id={modeMenuId} className="agent-composer__mode-menu" role="group" aria-label={copy.executionMode}>
      <button type="button" aria-label={copy.manual} aria-pressed={session?.executionMode === 'manual'} className={session?.executionMode === 'manual' ? 'is-selected' : ''} title={copy.manualTitle} onClick={() => onExecutionModeChange('manual')}><ChecklistIcon /><span><strong>{copy.manual}</strong><small>{copy.manualHelp}</small></span></button>
      <button type="button" aria-label={copy.auto} aria-pressed={session?.executionMode === 'auto'} className={session?.executionMode === 'auto' ? 'is-selected' : ''} title={copy.autoTitle} onClick={() => onExecutionModeChange('auto')}><AutoRunIcon /><span><strong>{copy.auto}</strong><small>{copy.autoHelp}</small></span></button>
      <label className="agent-composer__reasoning-toggle">
        <input type="checkbox" checked={showRawReasoning} disabled={planning} onChange={(event) => onShowRawReasoningChange(event.target.checked)} />
        <span><strong>{copy.rawReasoning}</strong><small>{copy.rawReasoningHelp}</small></span>
      </label>
    </div> : null}
  </div>
}

function ComposerSendButton({
  planning,
  cancelling,
  disabled,
  sendLabel,
  stopLabel,
  onSend,
  onCancel,
}: {
  planning: boolean
  cancelling: boolean
  disabled: boolean
  sendLabel: string
  stopLabel: string
  onSend: () => void
  onCancel: () => void
}) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const pathRef = useRef<SVGPathElement>(null)
  const knownPlanning = useRef<boolean | undefined>(undefined)

  useGSAP(() => {
    const path = pathRef.current
    const button = buttonRef.current
    if (!path || !button) return
    const nextPath = planning ? sendStopPath : sendArrowPath
    if (knownPlanning.current === undefined || knownPlanning.current === planning || prefersReducedMotion()) {
      gsap.set(path, { morphSVG: nextPath })
      knownPlanning.current = planning
      return
    }
    const tl = gsap.timeline({ defaults: { ease: botanicMotion.ease } })
    tl.to(button, { scale: 0.92, duration: botanicMotion.duration.press }, 0)
      .to(path, { morphSVG: nextPath, duration: botanicMotion.duration.chip }, 0)
      .to(button, { scale: 1, duration: botanicMotion.duration.toast })
    knownPlanning.current = planning
  }, { scope: buttonRef, dependencies: [planning] })

  return <button
    ref={buttonRef}
    type="button"
    className={planning ? `agent-composer__send is-stop${cancelling ? ' is-cancelling' : ''}` : 'agent-composer__send'}
    disabled={planning ? cancelling : disabled}
    onClick={planning ? onCancel : onSend}
    aria-label={planning ? `${stopLabel}${cancelling ? '…' : ''}` : sendLabel}
    title={planning ? `${stopLabel}${cancelling ? '…' : ''}` : sendLabel}
  >
    {cancelling ? <span className="agent-composer__spinner" aria-hidden="true" /> : <svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path ref={pathRef} d={planning ? sendStopPath : sendArrowPath} />
    </svg>}
  </button>
}
