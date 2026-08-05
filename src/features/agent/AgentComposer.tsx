import type { ChangeEvent, KeyboardEvent, RefObject } from 'react'
import type { BotanicAgentMentionQuery, BotanicAgentSession } from '../../domain/agent'
import type { AssetGroup } from '../../domain/canvas'
import { AgentPlannerProviderIcon } from '../../components/AgentPlannerProviderIcon'
import { BotanicSelect } from '../../components/BotanicSelect'
import { ArrowUpIcon, AutoRunIcon, ChecklistIcon, CloseIcon, PlusIcon, UploadIcon } from '../../components/BotanicIcons'
import { agentPlannerModelLabel, agentPlannerModelShortLabel } from '../../components/generationModelPresentation'
import type { AgentContextItem } from './agentWorkspace.types'

type AgentComposerProps = {
  session?: BotanicAgentSession
  contextItems: AgentContextItem[]
  mentionQuery?: BotanicAgentMentionQuery
  mentionOptions: AgentContextItem[]
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
  onSelectMention: (item: AgentContextItem) => void
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
  onSelectMention,
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
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape' && mentionQuery) {
      event.preventDefault()
      onDismissMention()
      return
    }
    if (event.key === 'Enter' && mentionQuery && mentionOptions[0]) {
      event.preventDefault()
      onSelectMention(mentionOptions[0])
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

  return <div className="agent-composer">
    {contextItems.length ? <div className="agent-composer__context">{contextItems.map((item) => <button key={item.id} type="button" aria-label={`移除 ${item.label}`} title={`移除 ${item.label}`} onClick={() => onRemoveContext(item.id)}>{item.image ? <img src={item.image} alt="" /> : <span>{item.kind.slice(0, 1)}</span>}<i aria-hidden="true">×</i></button>)}</div> : null}
    {mentionQuery ? <div className="agent-composer__mention-menu" role="group" aria-label="引用画布内容" onPointerDown={(event) => event.stopPropagation()}>
      {mentionOptions.map((item) => <button key={item.id} type="button" onMouseDown={(event) => event.preventDefault()} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onSelectMention(item) }}>{item.image ? <img src={item.image} alt="" /> : <span>{item.kind.slice(0, 1)}</span>}<b>{item.label}</b><small>{item.kind}</small></button>)}
      {!mentionOptions.length ? <p>没有匹配的素材</p> : null}
    </div> : null}
    <textarea
      ref={textareaRef}
      value={instruction}
      onChange={(event) => onInstructionChange(event.target.value, event.target.selectionStart ?? event.target.value.length)}
      onClick={(event) => onInstructionClick(event.currentTarget.selectionStart ?? instruction.length)}
      onKeyDown={handleKeyDown}
      placeholder="和 Agent 聊天、生成 Prompt 或描述创作需求，@ 引用画布内容"
      aria-label="Agent 消息"
    />
    {error ? <div className="agent-composer__error" role="alert"><span>{error}</span>{canRetry ? <button type="button" onClick={onRetry} disabled={retrying}>重试</button> : null}</div> : null}
    <input ref={fileInputRef} className="asset-file-input" type="file" accept="image/png,image/jpeg,image/webp" multiple aria-label="从电脑添加图片素材" onChange={handleFiles} />
    <div className="agent-composer__toolbar">
      <div>
        <button ref={contextMenuButtonRef} type="button" className="agent-composer__add" onClick={onToggleContextMenu} aria-controls={contextMenuId} aria-expanded={contextMenuOpen} aria-label="添加图像素材" title="添加图像素材"><PlusIcon /></button>
        <button ref={modeMenuButtonRef} type="button" className="agent-composer__mode" onClick={onToggleModeMenu} aria-controls={modeMenuId} aria-expanded={modeMenuOpen} aria-label={session?.executionMode === 'auto' ? '自动执行' : '手动确认'} title={session?.executionMode === 'auto' ? '自动执行' : '手动确认'}>
          {session?.executionMode === 'auto' ? <AutoRunIcon /> : <ChecklistIcon />}<span className="agent-composer__mode-label" aria-hidden="true">{session?.executionMode === 'auto' ? '自动生成' : '手动确认'}</span><span className="agent-composer__mode-chevron" aria-hidden="true">⌄</span>
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
      <button type="button" className="agent-composer__send" disabled={!instruction.trim() || planning || !session} onClick={onSend} aria-label="发送给 Agent">{planning ? <span className="agent-composer__spinner" /> : <ArrowUpIcon />}</button>
    </div>
    {contextMenuOpen ? <div id={contextMenuId} className="agent-composer__context-menu" role="group" aria-label="添加图像素材" onPointerDown={(event) => event.stopPropagation()}>
      <header><strong>添加图像素材</strong><button type="button" aria-label="关闭添加图像素材" onClick={onCloseContextMenu}><CloseIcon /></button></header>
      <div className="agent-composer__context-upload">
        <button type="button" onClick={() => fileInputRef.current?.click()}><UploadIcon /><span><b>从电脑选择图片</b><small>也可以直接拖入 Agent 面板</small></span></button>
      </div>
      {imageContextOptions.length ? imageContextOptions.map((item) => {
        const selected = session?.contextNodeIds.includes(item.id) ?? false
        return <button key={item.id} type="button" className={selected ? 'is-selected' : ''} aria-pressed={selected} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onToggleImageContext(item.id, selected) }}>{item.image ? <img src={item.image} alt="" /> : null}<span><b>{item.label}</b><small>{item.kind}</small></span>{selected ? <i aria-hidden="true">✓</i> : null}</button>
      }) : <p>暂无图像素材，可从电脑选择或直接拖入。</p>}
    </div> : null}
    {modeMenuOpen ? <div id={modeMenuId} className="agent-composer__mode-menu" role="group" aria-label="执行模式">
      <button type="button" className={session?.executionMode === 'manual' ? 'is-selected' : ''} onClick={() => onExecutionModeChange('manual')}><ChecklistIcon /><span><strong>手动确认</strong><small>执行生成前先确认锁定项</small></span></button>
      <button type="button" className={session?.executionMode === 'auto' ? 'is-selected' : ''} onClick={() => onExecutionModeChange('auto')}><AutoRunIcon /><span><strong>自动执行</strong><small>规划完成后直接创建任务</small></span></button>
    </div> : null}
  </div>
}
