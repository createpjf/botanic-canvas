import { useId } from 'react'
import type { ChangeEvent, KeyboardEvent, RefObject } from 'react'
import { botanicAgentExecutionModeLabel, type BotanicAgentMentionQuery, type BotanicAgentSession } from '../../domain/agent'
import type { AssetGroup } from '../../domain/canvas'
import { AgentPlannerProviderIcon } from '../../components/AgentPlannerProviderIcon'
import { BotanicSelect } from '../../components/BotanicSelect'
import { ArrowUpIcon, AutoRunIcon, ChecklistIcon, ChevronDownIcon, CloseIcon, PlusIcon, SparkleIcon, UploadIcon } from '../../components/BotanicIcons'
import { agentPlannerModelLabel, agentPlannerModelShortLabel } from '../../components/generationModelPresentation'
import type { AgentContextItem, AgentSkillOption } from './agentWorkspace.types'
import { useProductI18n, useProductMessages } from '../../i18n/react'

type AgentComposerProps = {
  session?: BotanicAgentSession
  contextItems: AgentContextItem[]
  mentionQuery?: BotanicAgentMentionQuery
  mentionOptions: AgentContextItem[]
  skillOptions: AgentSkillOption[]
  mountedSkills: AgentSkillOption[]
  instruction: string
  error: string
  canRetry: boolean
  retrying: boolean
  planning: boolean
  contextMenuOpen: boolean
  modeMenuOpen: boolean
  contextMenuId: string
  modeMenuId: string
  plannerModel: string
  plannerModels: string[]
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
  onGroupChange: (groupId: string) => void
  onSend: () => void
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
  error,
  canRetry,
  retrying,
  planning,
  contextMenuOpen,
  modeMenuOpen,
  contextMenuId,
  modeMenuId,
  plannerModel,
  plannerModels,
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
  onGroupChange,
  onSend,
  onToggleImageContext,
  onExecutionModeChange,
}: AgentComposerProps) {
  const { locale } = useProductI18n()
  const copy = useProductMessages({
    'zh-CN': {
      input: 'Agent 输入', referenced: '已引用', remove: '移除', mounted: '已挂载', callSkill: '调用 Skill', systemSkill: '系统 Skill', projectSkill: '项目 Skill', createSkill: '创建项目 Skill', saveRules: '保存一组可复用规则', referenceCanvas: '引用画布内容', description: '补充描述', asset: '素材', noMatch: '没有匹配的素材，按 Esc 关闭', placeholder: '和 Agent 聊天、生成 Prompt 或描述创作需求，@ 引用画布内容', message: 'Agent 消息', retry: '重试', addImages: '添加图像素材', executionMode: '执行模式', manual: '计划模式', auto: '自动模式', manualTitle: '计划模式：先给出计划，你确认后再提交', autoTitle: '自动模式：补齐设置后直接提交生成任务', model: 'Agent 模型', assetGroup: '素材组', single: '单张', group: '组', send: '发送给 Agent', closeImages: '关闭添加图像素材', chooseImages: '从电脑选择图片', dragHint: '也可以直接拖入 Agent 面板', noImages: '暂无图像素材，可从电脑选择或直接拖入。', manualHelp: '确认计划后再生成', autoHelp: '直接生成，行动需确认', modeNote: '只影响之后的新计划', textKind: '文字',
    },
    en: {
      input: 'Agent input', referenced: 'Referenced', remove: 'Remove', mounted: 'Mounted', callSkill: 'Use Skill', systemSkill: 'System Skill', projectSkill: 'Project Skill', createSkill: 'Create project Skill', saveRules: 'Save a reusable set of rules', referenceCanvas: 'Reference canvas content', description: 'Description', asset: 'Asset', noMatch: 'No matching assets. Press Esc to close.', placeholder: 'Chat with Agent, create a prompt, or describe a creative task. Use @ to reference canvas content.', message: 'Agent message', retry: 'Retry', addImages: 'Add image assets', executionMode: 'Execution mode', manual: 'Plan mode', auto: 'Auto mode', manualTitle: 'Plan mode: review the plan before submitting generation', autoTitle: 'Auto mode: complete settings and submit generation directly', model: 'Agent model', assetGroup: 'Asset group', single: 'Single', group: 'Group', send: 'Send to Agent', closeImages: 'Close image picker', chooseImages: 'Choose images from computer', dragHint: 'You can also drag images into the Agent panel', noImages: 'No image assets yet. Choose files or drag images into the panel.', manualHelp: 'Generate after plan confirmation', autoHelp: 'Generate directly; actions still need approval', modeNote: 'Applies to future plans only', textKind: 'Text',
    },
  })
  const composerErrorId = useId()
  const executionModeLabel = locale === 'en'
    ? (session?.executionMode === 'auto' ? copy.auto : copy.manual)
    : botanicAgentExecutionModeLabel(session?.executionMode ?? 'manual')
  const executionModeAriaLabel = `${copy.executionMode}${locale === 'en' ? ': ' : '：'}${executionModeLabel}`
  const contextKindLabel = (kind: AgentContextItem['kind']) => locale === 'en'
    ? ({ '素材': 'Asset', '结果': 'Result', '文字': 'Text', '节点': 'Node' }[kind] ?? 'Item')
    : kind
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape' && mentionQuery) {
      event.preventDefault()
      onDismissMention()
      return
    }
    if (event.key === 'Enter' && mentionQuery && (skillOptions[0] || mentionOptions[0])) {
      event.preventDefault()
      if (skillOptions[0]) onSelectSkill(skillOptions[0])
      else onSelectMention(mentionOptions[0])
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      onSend()
    }
  }
  const handleFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
    onImportFiles(files)
  }

  return <div className="agent-composer" role="group" aria-label={copy.input} aria-busy={planning}>
    {contextItems.length ? <div className="agent-composer__context" aria-label={`${copy.referenced} ${contextItems.length}`}>{contextItems.map((item) => <button key={item.id} type="button" aria-label={`${copy.remove} ${item.label}`} title={item.kind === '文字' && item.content ? `${copy.description} “${item.label}”: ${item.content}` : `${copy.remove} ${item.label}`} onClick={() => onRemoveContext(item.id)}>{item.image ? <img src={item.image} alt="" /> : <span>{contextKindLabel(item.kind).slice(0, 1)}</span>}<i aria-hidden="true">×</i></button>)}</div> : null}
    {mountedSkills.length ? <div className="agent-composer__skills" aria-label={`${copy.mounted} ${mountedSkills.length} Skill`}><span>{copy.mounted}</span>{mountedSkills.map((skill) => <button key={skill.id} type="button" aria-label={`${copy.remove} Skill ${skill.name}`} title={`${copy.remove} ${skill.name}`} onClick={() => onRemoveMountedSkill(skill.id)}><SparkleIcon /><b>{skill.name}</b><i aria-hidden="true">×</i></button>)}</div> : null}
    {mentionQuery ? <div className="agent-composer__mention-menu" role="group" aria-label={copy.referenceCanvas} onPointerDown={(event) => event.stopPropagation()}>
      {skillOptions.length ? <div className="agent-composer__mention-section"><strong>{copy.callSkill}</strong>{skillOptions.map((skill) => <button key={`skill-${skill.id}`} type="button" role="option" aria-label={`${copy.callSkill} ${skill.name}`} onMouseDown={(event) => event.preventDefault()} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onSelectSkill(skill) }}><SparkleIcon /><b>{skill.name}</b><small>{skill.source === 'system' ? copy.systemSkill : copy.projectSkill}</small></button>)}</div> : null}
      <button type="button" role="option" className="agent-composer__create-skill" aria-label={copy.createSkill} onMouseDown={(event) => event.preventDefault()} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onCreateSkill() }}><PlusIcon /><b>{copy.createSkill}</b><small>{copy.saveRules}</small></button>
      {mentionOptions.length ? <div className="agent-composer__mention-section"><strong>{copy.referenceCanvas}</strong>{mentionOptions.map((item) => <button key={item.id} type="button" role="option" aria-label={`${copy.referenceCanvas} ${item.label}`} title={item.content ?? item.label} onMouseDown={(event) => event.preventDefault()} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onSelectMention(item) }}>{item.image ? <img src={item.image} alt="" /> : <span>{contextKindLabel(item.kind).slice(0, 1)}</span>}<b>{item.label}</b><small>{item.kind === '文字' ? copy.description : copy.asset}</small></button>)}</div> : null}
      {!mentionOptions.length && !skillOptions.length ? <p>{copy.noMatch}</p> : null}
    </div> : null}
    <textarea
      ref={textareaRef}
      value={instruction}
      onChange={(event) => onInstructionChange(event.target.value, event.target.selectionStart ?? event.target.value.length)}
      onClick={(event) => onInstructionClick(event.currentTarget.selectionStart ?? instruction.length)}
      onKeyDown={handleKeyDown}
      placeholder={copy.placeholder}
      aria-label={copy.message}
      aria-invalid={Boolean(error)}
      aria-describedby={error ? composerErrorId : undefined}
    />
    {error ? <div id={composerErrorId} className="agent-composer__error" role="alert"><span>{error}</span>{canRetry ? <button type="button" onClick={onRetry} disabled={retrying}>{copy.retry}</button> : null}</div> : null}
    <input ref={fileInputRef} className="asset-file-input" type="file" accept="image/png,image/jpeg,image/webp" multiple aria-label={copy.addImages} onChange={handleFiles} />
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
      <button type="button" className="agent-composer__send" disabled={!instruction.trim() || planning || !session} onClick={onSend} aria-label={copy.send} title={copy.send}>{planning ? <span className="agent-composer__spinner" /> : <ArrowUpIcon />}</button>
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
      <p className="agent-composer__mode-note">{copy.modeNote}</p>
    </div> : null}
  </div>
}
