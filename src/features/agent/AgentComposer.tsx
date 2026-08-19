import { useId } from 'react'
import type { ChangeEvent, KeyboardEvent, RefObject } from 'react'
import { botanicAgentExecutionModeLabel, type BotanicAgentMentionQuery, type BotanicAgentSession } from '../../domain/agent'
import type { AssetGroup } from '../../domain/canvas'
import { AgentPlannerProviderIcon } from '../../components/AgentPlannerProviderIcon'
import { BotanicSelect } from '../../components/BotanicSelect'
import { ArrowUpIcon, AutoRunIcon, ChecklistIcon, CloseIcon, PlusIcon, SparkleIcon, UploadIcon } from '../../components/BotanicIcons'
import { agentPlannerModelLabel, agentPlannerModelShortLabel } from '../../components/generationModelPresentation'
import type { AgentContextItem, AgentSkillOption } from './agentWorkspace.types'

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
  const composerErrorId = useId()
  const executionModeLabel = botanicAgentExecutionModeLabel(session?.executionMode ?? 'manual')
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

  return <div className="agent-composer" role="group" aria-label="Agent 输入" aria-busy={planning}>
    {contextItems.length ? <div className="agent-composer__context" aria-label={`已引用 ${contextItems.length} 项上下文`}>{contextItems.map((item) => <button key={item.id} type="button" aria-label={`移除 ${item.label}`} title={item.kind === '文字' && item.content ? `补充描述「${item.label}」：${item.content}（点击移除）` : `移除 ${item.label}`} onClick={() => onRemoveContext(item.id)}>{item.image ? <img src={item.image} alt="" /> : <span>{item.kind.slice(0, 1)}</span>}<i aria-hidden="true">×</i></button>)}</div> : null}
    {mountedSkills.length ? <div className="agent-composer__skills" aria-label={`已挂载 ${mountedSkills.length} 个 Skill`}><span>已挂载</span>{mountedSkills.map((skill) => <button key={skill.id} type="button" aria-label={`移除已挂载 Skill ${skill.name}`} title={`移除 ${skill.name}`} onClick={() => onRemoveMountedSkill(skill.id)}><SparkleIcon /><b>{skill.name}</b><i aria-hidden="true">×</i></button>)}</div> : null}
    {mentionQuery ? <div className="agent-composer__mention-menu" role="group" aria-label="引用画布内容" onPointerDown={(event) => event.stopPropagation()}>
      {skillOptions.length ? <div className="agent-composer__mention-section"><strong>调用 Skill</strong>{skillOptions.map((skill) => <button key={`skill-${skill.id}`} type="button" role="option" aria-label={`调用 Skill ${skill.name}`} onMouseDown={(event) => event.preventDefault()} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onSelectSkill(skill) }}><SparkleIcon /><b>{skill.name}</b><small>{skill.source === 'system' ? '系统 Skill' : '项目 Skill'}</small></button>)}</div> : null}
      <button type="button" role="option" className="agent-composer__create-skill" aria-label="创建项目 Skill" onMouseDown={(event) => event.preventDefault()} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onCreateSkill() }}><PlusIcon /><b>创建项目 Skill</b><small>保存一组可复用规则</small></button>
      {mentionOptions.length ? <div className="agent-composer__mention-section"><strong>引用画布</strong>{mentionOptions.map((item) => <button key={item.id} type="button" role="option" aria-label={`引用${item.kind} ${item.label}`} title={item.content ?? item.label} onMouseDown={(event) => event.preventDefault()} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onSelectMention(item) }}>{item.image ? <img src={item.image} alt="" /> : <span>{item.kind.slice(0, 1)}</span>}<b>{item.label}</b><small>{item.kind === '文字' ? '补充描述' : '素材'}</small></button>)}</div> : null}
      {!mentionOptions.length && !skillOptions.length ? <p>没有匹配的素材，按 Esc 关闭</p> : null}
    </div> : null}
    <textarea
      ref={textareaRef}
      value={instruction}
      onChange={(event) => onInstructionChange(event.target.value, event.target.selectionStart ?? event.target.value.length)}
      onClick={(event) => onInstructionClick(event.currentTarget.selectionStart ?? instruction.length)}
      onKeyDown={handleKeyDown}
      placeholder="和 Agent 聊天、生成 Prompt 或描述创作需求，@ 引用画布内容"
      aria-label="Agent 消息"
      aria-invalid={Boolean(error)}
      aria-describedby={error ? composerErrorId : undefined}
    />
    {error ? <div id={composerErrorId} className="agent-composer__error" role="alert"><span>{error}</span>{canRetry ? <button type="button" onClick={onRetry} disabled={retrying}>重试</button> : null}</div> : null}
    <input ref={fileInputRef} className="asset-file-input" type="file" accept="image/png,image/jpeg,image/webp" multiple aria-label="从电脑添加图片素材" onChange={handleFiles} />
    <div className="agent-composer__toolbar">
      <div>
        <button ref={contextMenuButtonRef} type="button" className="agent-composer__add" onClick={onToggleContextMenu} aria-controls={contextMenuId} aria-expanded={contextMenuOpen} aria-label="添加图像素材" title="添加图像素材"><PlusIcon /></button>
        <button ref={modeMenuButtonRef} type="button" className="agent-composer__mode" onClick={onToggleModeMenu} aria-controls={modeMenuId} aria-expanded={modeMenuOpen} aria-label={`执行模式：${executionModeLabel}`} title={session?.executionMode === 'auto' ? '自动模式：补齐设置后直接提交生成任务' : '计划模式：先给出计划，你确认后再提交'}>
          {session?.executionMode === 'auto' ? <AutoRunIcon /> : <ChecklistIcon />}<span className="agent-composer__mode-label" aria-hidden="true">{executionModeLabel}</span><span className="agent-composer__mode-chevron" aria-hidden="true">⌄</span>
        </button>
        <BotanicSelect
          className="agent-composer__model-select"
          value={plannerModel}
          ariaLabel={`Agent 模型：${agentPlannerModelLabel(plannerModel)}`}
          menuWidth={220}
          options={plannerModels.map((model) => ({ value: model, label: agentPlannerModelLabel(model) }))}
          onChange={onPlannerModelChange}
          renderTrigger={(selected) => <span className="agent-model-trigger" title={agentPlannerModelShortLabel(selected?.value ?? plannerModel)}><AgentPlannerProviderIcon model={selected?.value ?? plannerModel} /><span className="agent-model-trigger__label">{agentPlannerModelShortLabel(selected?.value ?? plannerModel)}</span></span>}
          renderOption={(option, selected) => <span className="agent-model-option"><span className="agent-model-option__main"><AgentPlannerProviderIcon model={option.value} /><span>{option.label}</span></span>{selected ? <b aria-hidden="true">✓</b> : null}</span>}
        />
        {compatibleGroups.length ? <BotanicSelect className="agent-composer__group-select" value={groupId} placeholder="素材组" ariaLabel="批量素材组" options={[{ value: '', label: '单张' }, ...compatibleGroups.map((group) => ({ value: group.id, label: `${group.name} · ${group.assetIds.length}` }))]} onChange={onGroupChange} renderTrigger={(selected) => <span className="agent-group-trigger" title={selected?.label ?? '单张'}><strong>{selected?.value ? '组' : '1'}</strong></span>} /> : null}
      </div>
      <button type="button" className="agent-composer__send" disabled={!instruction.trim() || planning || !session} onClick={onSend} aria-label="发送给 Agent" title="发送给 Agent">{planning ? <span className="agent-composer__spinner" /> : <ArrowUpIcon />}</button>
    </div>
    {contextMenuOpen ? <div id={contextMenuId} className="agent-composer__context-menu" role="menu" aria-label="添加图像素材" onPointerDown={(event) => event.stopPropagation()}>
      <header><strong>添加图像素材</strong><button type="button" aria-label="关闭添加图像素材" onClick={onCloseContextMenu}><CloseIcon /></button></header>
      <div className="agent-composer__context-upload">
        <button type="button" role="menuitem" onClick={() => fileInputRef.current?.click()}><UploadIcon /><span><b>从电脑选择图片</b><small>也可以直接拖入 Agent 面板</small></span></button>
      </div>
      {imageContextOptions.length ? imageContextOptions.map((item) => {
        const selected = session?.contextNodeIds.includes(item.id) ?? false
        return <button key={item.id} type="button" role="menuitemcheckbox" className={selected ? 'is-selected' : ''} aria-checked={selected} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onToggleImageContext(item.id, selected) }}>{item.image ? <img src={item.image} alt="" /> : null}<span><b>{item.label}</b><small>{item.kind}</small></span>{selected ? <i aria-hidden="true">✓</i> : null}</button>
      }) : <p>暂无图像素材，可从电脑选择或直接拖入。</p>}
    </div> : null}
    {modeMenuOpen ? <div id={modeMenuId} className="agent-composer__mode-menu" role="group" aria-label="执行模式">
      <button type="button" aria-label="计划模式" aria-pressed={session?.executionMode === 'manual'} className={session?.executionMode === 'manual' ? 'is-selected' : ''} title="缺参数会询问；确认后才提交生成任务。只影响之后的新计划。" onClick={() => onExecutionModeChange('manual')}><ChecklistIcon /><span><strong>计划模式</strong><small>确认计划后再生成</small></span></button>
      <button type="button" aria-label="自动模式" aria-pressed={session?.executionMode === 'auto'} className={session?.executionMode === 'auto' ? 'is-selected' : ''} title="自动补齐设置并提交；外部行动仍会停下来确认。只影响之后的新计划。" onClick={() => onExecutionModeChange('auto')}><AutoRunIcon /><span><strong>自动模式</strong><small>直接生成，行动需确认</small></span></button>
      <p className="agent-composer__mode-note">只影响之后的新计划</p>
    </div> : null}
  </div>
}
