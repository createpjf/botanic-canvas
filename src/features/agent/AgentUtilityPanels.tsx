import { useEffect, useMemo, useState } from 'react'
import {
  botanicAgentArtifactModel,
  botanicAgentArtifactPrompt,
  botanicAgentArtifactTimestamp,
  botanicAgentResultGroupTitle,
  botanicAgentSkillBody,
  botanicAgentSkillSummary,
  clipBotanicAgentNodeTitle,
  resolveBotanicAgentResultSelection,
  type BotanicAgentArtifact,
  type BotanicAgentMemoryItem,
  type BotanicAgentMemoryKind,
  type BotanicAgentRun,
} from '../../domain/agent'
import { BotanicSelect } from '../../components/BotanicSelect'
import { modelDisplayLabel } from '../../components/generationModelPresentation'
import type { GenerationModelOption } from '../../domain/canvas'
import { CopyIcon, DeleteIcon, FocusIcon, SparkleIcon } from '../../components/BotanicIcons'
import type { CollaborationActivity, CollaborationDocumentChange } from '../../domain/collaborationActivity'
import { downloadMedia } from '../../lib/mediaDownload'
import { agentArtifactKindLabel, agentMemoryKindLabel, agentRunFeedback, AgentPanelBackButton } from './AgentWorkspaceParts'
import type { AgentArtifactIndexState, AgentContextItem } from './agentWorkspace.types'

function collaborationTime(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(timestamp))
}

export function AgentCollaborationPanel({
  activities,
  conflictChanges,
  persistenceStatus,
  onLocate,
  onMarkRead,
  onClear,
  onKeepLocal,
  onUseRemote,
  historyStatus,
  historyHasMore,
  historyErrorAction,
  onLoadMore,
  onReload,
  onBackToConversation,
}: {
  activities: CollaborationActivity[]
  conflictChanges: CollaborationDocumentChange[]
  persistenceStatus: 'saved' | 'saving' | 'offline' | 'conflict' | 'error'
  onLocate: (activity: CollaborationActivity) => void
  onMarkRead: () => Promise<void>
  onClear: () => Promise<void>
  onKeepLocal: () => void
  onUseRemote: () => void
  historyStatus: 'idle' | 'loading' | 'loading-more' | 'saving' | 'error'
  historyHasMore: boolean
  historyErrorAction?: 'load' | 'load-more' | 'read' | 'clear'
  onLoadMore: () => Promise<void>
  onReload: () => Promise<void>
  onBackToConversation: () => void
}) {
  return <section className="agent-collaboration-panel" aria-label="协作动态">
    <header><AgentPanelBackButton onClick={onBackToConversation} /><div><small>COLLABORATION</small><h2>协作动态</h2></div><span>{activities.length} 条</span></header>
    <p>查看成员最近修改，并直接定位到相关节点、对话或任务。</p>
    {persistenceStatus === 'conflict' ? <div className="agent-collaboration-panel__conflict" role="alert">
      <span><strong>画布有新的云端版本</strong><small>本地草稿仍保留。先查看变更，再决定使用哪一版。</small></span>
      {conflictChanges.length ? <details className="agent-collaboration-panel__conflict-details">
        <summary>查看 {conflictChanges.length} 项变更</summary>
        <ul>{conflictChanges.map((change, index) => <li key={`${change.summary}-${index}`}>
          <button type="button" onClick={() => onLocate({ id: `conflict-${index}`, actorName: '云端版本', occurredAt: Date.now(), unread: false, count: 1, ...change })}>{change.summary}{change.target?.kind === 'node' ? <FocusIcon /> : null}</button>
        </li>)}</ul>
      </details> : <small>正在读取云端变更…</small>}
      <div><button type="button" onClick={onKeepLocal}>暂留本地</button><button type="button" className="is-primary" onClick={onUseRemote}>使用云端版本</button></div>
    </div> : null}
    {historyStatus === 'error' ? <button type="button" className="agent-collaboration-panel__sync-error" onClick={() => void onReload().catch(() => undefined)}>{historyErrorAction === 'read' ? '已读状态同步失败，点击重试' : historyErrorAction === 'clear' ? '清空状态同步失败，点击重试' : '协作动态同步失败，点击重试'}</button> : null}
    <div className="agent-collaboration-panel__toolbar">
      <button type="button" disabled={historyStatus === 'saving' || !activities.some((activity) => activity.unread)} onClick={() => void onMarkRead().catch(() => undefined)}>全部已读</button>
      <button type="button" disabled={historyStatus === 'saving' || !activities.length} onClick={() => void onClear().catch(() => undefined)}>清空记录</button>
    </div>
    <div className="agent-collaboration-panel__list">
      {activities.map((activity) => <button key={activity.id} type="button" className={activity.unread ? 'is-unread' : ''} onClick={() => onLocate(activity)}>
        <i aria-hidden="true" />
        <span><strong>{activity.actorName}</strong><small>{activity.summary}{activity.count > 1 ? ` · ${activity.count} 次` : ''}</small></span>
        <time dateTime={new Date(activity.occurredAt).toISOString()}>{collaborationTime(activity.occurredAt)}</time>
        {activity.target && activity.target.kind !== 'project' ? <FocusIcon /> : null}
      </button>)}
      {!activities.length && historyStatus !== 'loading' ? <div className="agent-panel__empty">还没有协作变更。</div> : null}
      {historyStatus === 'loading' ? <div className="agent-panel__empty" role="status">正在读取协作动态…</div> : null}
      {historyHasMore ? <button type="button" className="agent-collaboration-panel__load-more" disabled={historyStatus === 'loading-more'} onClick={() => void onLoadMore().catch(() => undefined)}>{historyStatus === 'loading-more' ? '加载中…' : '加载更早动态'}</button> : null}
    </div>
  </section>
}

function isMediaArtifact(artifact: BotanicAgentArtifact) {
  return (artifact.kind === 'image' || artifact.kind === 'video') && Boolean(artifact.url)
}

function AgentResultPrompt({ prompt }: { prompt: string }) {
  const [copied, setCopied] = useState(false)
  return <details className="agent-result-panel__prompt">
    <summary>对照 Prompt</summary>
    <pre>{prompt}</pre>
    <button type="button" onClick={() => {
      if (!navigator.clipboard?.writeText) return
      void navigator.clipboard.writeText(prompt).then(() => setCopied(true)).catch(() => setCopied(false))
    }}><CopyIcon /><span>{copied ? '已复制' : '复制 Prompt'}</span></button>
  </details>
}

function artifactShortLabel(artifact: BotanicAgentArtifact) {
  return clipBotanicAgentNodeTitle(artifact.label) || artifact.label || '生成结果'
}

export function AgentResultPanel({
  artifacts,
  runs,
  latestRun,
  contextOptions,
  generationModels,
  artifactIndexStatus,
  artifactIndexHasMore,
  conversationRunIds,
  onLocateNode,
  onSaveArtifact,
  onContinue,
  onStartNextRound,
  onLoadMoreArtifacts,
  onLocateConversation,
  onBackToConversation,
}: {
  artifacts: BotanicAgentArtifact[]
  runs: BotanicAgentRun[]
  latestRun?: BotanicAgentRun
  contextOptions: AgentContextItem[]
  generationModels: GenerationModelOption[]
  artifactIndexStatus: AgentArtifactIndexState['status']
  artifactIndexHasMore: boolean
  conversationRunIds: string[]
  onLocateNode: (nodeId: string) => void
  onSaveArtifact: (artifact: BotanicAgentArtifact) => void
  onContinue: (artifact: BotanicAgentArtifact) => void
  onStartNextRound: (sourceNodeIds: string[], artifactCount: number) => void
  onLoadMoreArtifacts: () => Promise<void>
  onLocateConversation: (runId: string) => void
  onBackToConversation: () => void
}) {
  // 一级直接看画面；点图才进入该项的操作层。Skill / MCP 文本产物仍在次级页签。
  const [tab, setTab] = useState<'media' | 'tool'>('media')
  const [kindFilter, setKindFilter] = useState<'all' | 'image' | 'video'>('all')
  const [modelFilter, setModelFilter] = useState('')
  const [libraryFilter, setLibraryFilter] = useState<'all' | 'saved' | 'unsaved'>('all')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [previewId, setPreviewId] = useState<string | null>(null)

  const mediaArtifacts = useMemo(() => artifacts.filter(isMediaArtifact), [artifacts])
  const toolArtifacts = useMemo(() => artifacts.filter((artifact) => !isMediaArtifact(artifact)), [artifacts])
  const modelOptions = useMemo(() => [...new Set(mediaArtifacts
    .map((artifact) => botanicAgentArtifactModel(artifact))
    .filter((model): model is string => Boolean(model)))], [mediaArtifacts])

  const filteredArtifacts = useMemo(() => {
    if (tab === 'tool') return toolArtifacts
    return mediaArtifacts.filter((artifact) => {
      if (kindFilter !== 'all' && artifact.kind !== kindFilter) return false
      if (modelFilter && botanicAgentArtifactModel(artifact) !== modelFilter) return false
      const saved = artifact.metadata?.savedToLibrary === true
      if (libraryFilter === 'saved' && !saved) return false
      if (libraryFilter === 'unsaved' && saved) return false
      return true
    })
  }, [kindFilter, libraryFilter, mediaArtifacts, modelFilter, tab, toolArtifacts])

  const groups = useMemo(() => {
    const grouped = new Map<string, { id: string; label: string; artifacts: BotanicAgentArtifact[]; updatedAt: number }>()
    for (const artifact of filteredArtifacts) {
      const runId = artifact.provenance.runId
      const id = runId ?? `action:${artifact.provenance.actionId}`
      const plan = runId ? runs.find((run) => run.id === runId)?.plan : undefined
      const label = runId ? botanicAgentResultGroupTitle(plan) : '工具产物'
      const group = grouped.get(id) ?? { id, label, artifacts: [], updatedAt: 0 }
      group.artifacts.push(artifact)
      group.updatedAt = Math.max(group.updatedAt, botanicAgentArtifactTimestamp(artifact))
      grouped.set(id, group)
    }
    return [...grouped.values()]
      .map((group) => ({
        ...group,
        artifacts: [...group.artifacts].sort((left, right) => botanicAgentArtifactTimestamp(right) - botanicAgentArtifactTimestamp(left)),
      }))
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }, [filteredArtifacts, runs])

  const selectedBatch = useMemo(() => resolveBotanicAgentResultSelection(artifacts, selectedIds), [artifacts, selectedIds])
  const availableNodeIds = useMemo(() => new Set(contextOptions.map((item) => item.id)), [contextOptions])
  const resultNodeIds = useMemo(() => new Set(contextOptions.filter((item) => item.kind === '结果').map((item) => item.id)), [contextOptions])
  const selectedResultNodeIds = selectedBatch.sourceNodeIds.filter((nodeId) => resultNodeIds.has(nodeId))
  const latestFeedback = latestRun
    ? agentRunFeedback(latestRun, artifacts, availableNodeIds)
    : undefined
  const preview = previewId ? artifacts.find((artifact) => artifact.id === previewId) : undefined

  useEffect(() => {
    setSelectedIds((current) => current.filter((id) => artifacts.some((artifact) => artifact.id === id)))
  }, [artifacts])

  useEffect(() => {
    if (modelFilter && !modelOptions.includes(modelFilter)) setModelFilter('')
  }, [modelFilter, modelOptions])

  useEffect(() => {
    if (previewId && !artifacts.some((artifact) => artifact.id === previewId)) setPreviewId(null)
  }, [artifacts, previewId])

  const toggleSelection = (artifactId: string) => {
    setSelectedIds((current) => current.includes(artifactId)
      ? current.filter((id) => id !== artifactId)
      : [...current, artifactId])
  }

  const toggleGroup = (groupArtifacts: BotanicAgentArtifact[]) => {
    const groupIds = groupArtifacts.map((artifact) => artifact.id)
    setSelectedIds((current) => groupIds.every((id) => current.includes(id))
      ? current.filter((id) => !groupIds.includes(id))
      : [...current, ...groupIds.filter((id) => !current.includes(id))])
  }

  const openTab = (next: 'media' | 'tool') => {
    setTab(next)
    setPreviewId(null)
  }

  if (preview) {
    const locatableNodeId = preview.provenance.sourceNodeIds?.find((nodeId) => availableNodeIds.has(nodeId))
    const media = isMediaArtifact(preview)
    const canContinue = Boolean(locatableNodeId || media)
    const prompt = botanicAgentArtifactPrompt(preview)
    const model = botanicAgentArtifactModel(preview)
    const shortLabel = artifactShortLabel(preview)
    const modelLabel = model
      ? modelDisplayLabel(generationModels.find((option) => option.id === model)) || model
      : preview.provenance.toolName
    return <section className="agent-result-panel is-detail" aria-label={`${shortLabel} 详情`}>
      <header>
        <AgentPanelBackButton label="返回结果" onClick={() => setPreviewId(null)} />
        <div><small>ARTIFACT</small><h2>{shortLabel}</h2></div>
      </header>
      <div className="agent-result-panel__detail">
        {media ? <div className="agent-result-panel__hero">
          {preview.kind === 'image' ? <img src={preview.url} alt={shortLabel} /> : <video src={preview.url} controls playsInline />}
        </div> : <div className="agent-result-panel__document is-detail"><span>{preview.kind === 'workflow' ? '⌘' : 'Aa'}</span><p>{preview.content ?? preview.label}</p></div>}
        <p className="agent-result-panel__detail-meta">
          {agentArtifactKindLabel(preview)}
          {modelLabel ? ` · ${modelLabel}` : ''}
          {locatableNodeId ? ' · 已回填画布' : ''}
        </p>
        <div className="agent-result-panel__detail-actions">
          {locatableNodeId ? <button type="button" onClick={() => onLocateNode(locatableNodeId)}>定位画布</button> : null}
          {canContinue ? <button type="button" onClick={() => onContinue(preview)}>继续改</button> : null}
          {media ? <button type="button" disabled={preview.metadata?.savedToLibrary === true} onClick={() => onSaveArtifact(preview)}>{preview.metadata?.savedToLibrary === true ? '已入库' : '入库'}</button> : null}
          {media ? <button type="button" onClick={() => void downloadMedia(preview.url!, preview.label, preview.kind === 'video' ? 'video' : 'image')}>下载</button> : preview.url ? <a href={preview.url} target="_blank" rel="noreferrer">打开</a> : null}
        </div>
        {prompt ? <AgentResultPrompt prompt={prompt} /> : null}
      </div>
    </section>
  }

  return <section className="agent-result-panel" aria-label="Agent 结果与文件">
    <header><AgentPanelBackButton onClick={onBackToConversation} /><div><small>AGENT OUTPUTS</small><h2>结果与文件</h2></div><span>{mediaArtifacts.length} 项</span></header>
    {artifactIndexStatus === 'loading' ? <div className="agent-result-panel__index-status" role="status">正在读取历史 Artifact Index…</div> : null}
    {artifactIndexStatus === 'error' ? <div className="agent-result-panel__index-status is-warning" role="status">历史索引暂不可用，已显示当前画布结果。</div> : null}
    {latestFeedback ? <div className={`agent-result-panel__run-status is-${latestFeedback.tone}`} role="status"><strong>{latestFeedback.label}</strong><span>{latestFeedback.detail}</span></div> : null}
    <div className="agent-result-panel__tabs" role="group" aria-label="结果分区">
      <button type="button" aria-pressed={tab === 'media'} className={tab === 'media' ? 'is-active' : ''} onClick={() => openTab('media')}>生成结果<b>{mediaArtifacts.length}</b></button>
      <button type="button" aria-pressed={tab === 'tool'} className={tab === 'tool' ? 'is-active' : ''} onClick={() => openTab('tool')}>工具产物<b>{toolArtifacts.length}</b></button>
    </div>
    {tab === 'media' ? <div className="agent-result-panel__filters" role="group" aria-label="结果筛选">
      {([['all', '全部'], ['image', '图片'], ['video', '视频']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={kindFilter === value} className={kindFilter === value ? 'is-active' : ''} onClick={() => setKindFilter(value)}>{label}</button>)}
      <BotanicSelect
        className="agent-result-panel__library-select"
        value={libraryFilter}
        ariaLabel="按入库状态筛选"
        options={[
          { value: 'all', label: '不限入库' },
          { value: 'unsaved', label: '未入库' },
          { value: 'saved', label: '已入库' },
        ]}
        onChange={(value) => setLibraryFilter(value as 'all' | 'saved' | 'unsaved')}
      />
      {modelOptions.length > 1 ? <BotanicSelect
        className="agent-result-panel__model-select"
        value={modelFilter}
        ariaLabel="按生成模型筛选"
        options={[{ value: '', label: '全部模型' }, ...modelOptions.map((model) => ({
          value: model,
          label: modelDisplayLabel(generationModels.find((option) => option.id === model)) || model,
        }))]}
        onChange={setModelFilter}
      /> : null}
    </div> : null}
    {selectedBatch.artifacts.length ? <div className="agent-result-panel__selection" aria-label="批量操作">
      <strong>已选 {selectedBatch.artifacts.length} 项</strong>
      <div>
        {selectedBatch.mediaArtifacts.length ? <>
          <button type="button" disabled={selectedBatch.mediaArtifacts.every((artifact) => artifact.metadata?.savedToLibrary === true)} onClick={() => selectedBatch.mediaArtifacts.filter((artifact) => artifact.metadata?.savedToLibrary !== true).forEach(onSaveArtifact)}>入库</button>
          <button type="button" onClick={() => void (async () => {
            for (const artifact of selectedBatch.mediaArtifacts) await downloadMedia(artifact.url!, artifact.label, artifact.kind === 'video' ? 'video' : 'image')
          })()}>下载</button>
        </> : null}
        <button type="button" className="is-primary" disabled={!selectedResultNodeIds.length} onClick={() => onStartNextRound(selectedResultNodeIds, selectedBatch.artifacts.length)}>创建下一轮</button>
        <button type="button" onClick={() => setSelectedIds([])}>取消</button>
      </div>
    </div> : null}
    <div className="agent-result-panel__groups">
      {groups.map((group) => {
        const backfilled = group.artifacts.some((artifact) => artifact.provenance.sourceNodeIds?.some((nodeId) => availableNodeIds.has(nodeId)))
        return <section key={group.id} className="agent-result-group">
          <header>
            <span><strong>{group.label}</strong><small>{group.artifacts.length} 项</small></span>
            <em>{backfilled ? '已回填画布' : '未入画布'}</em>
            {conversationRunIds.includes(group.id) ? <button type="button" onClick={() => onLocateConversation(group.id)}>来源对话</button> : null}
            <button type="button" onClick={() => toggleGroup(group.artifacts)}>{group.artifacts.every((artifact) => selectedIds.includes(artifact.id)) ? '取消全选' : '全选'}</button>
          </header>
          <div className={`agent-result-panel__grid${tab === 'tool' ? ' is-documents' : ''}`}>
            {group.artifacts.map((artifact) => {
              const media = isMediaArtifact(artifact)
              const selected = selectedIds.includes(artifact.id)
              const shortLabel = artifactShortLabel(artifact)
              return <article key={artifact.id} className={selected ? 'is-selected' : ''}>
                <button type="button" className="agent-result-panel__select" aria-pressed={selected} aria-label={`${selected ? '取消选择' : '选择'} ${shortLabel}`} title={selected ? '取消选择' : '选择'} onClick={() => toggleSelection(artifact.id)}>{selected ? '✓' : ''}</button>
                <button type="button" className="agent-result-panel__open" aria-label={`查看 ${shortLabel}`} onClick={() => setPreviewId(artifact.id)}>
                  {media ? <span className="agent-result-panel__preview">
                    {artifact.kind === 'image' ? <img src={artifact.url} alt="" /> : <video src={artifact.url} muted playsInline />}
                  </span> : <span className="agent-result-panel__document"><span>{artifact.kind === 'workflow' ? '⌘' : 'Aa'}</span><b>{shortLabel}</b></span>}
                </button>
              </article>
            })}
          </div>
        </section>
      })}
      {!filteredArtifacts.length ? <div className="agent-panel__empty">{tab === 'tool' ? '还没有 Skill / MCP 产物。' : '还没有该条件下的生成结果。'}</div> : null}
      {artifactIndexHasMore ? <button type="button" className="agent-result-panel__load-more" disabled={artifactIndexStatus === 'loading-more'} onClick={() => void onLoadMoreArtifacts()}>{artifactIndexStatus === 'loading-more' ? '加载中…' : '加载更早结果'}</button> : null}
    </div>
  </section>
}

export function AgentMemoryPanel({ memory, sourceNodeIds, onAddMemory, onRemoveMemory, onLocateNode, onBackToConversation }: {
  memory: BotanicAgentMemoryItem[]
  sourceNodeIds: string[]
  onAddMemory: (kind: BotanicAgentMemoryKind, content: string, sourceNodeIds?: string[]) => string | null
  onRemoveMemory: (memoryId: string) => void
  onLocateNode: (nodeId: string) => void
  onBackToConversation: () => void
}) {
  const [kind, setKind] = useState<BotanicAgentMemoryKind>('rule')
  const [draft, setDraft] = useState('')
  const save = () => {
    if (!draft.trim()) return
    if (onAddMemory(kind, draft, sourceNodeIds)) setDraft('')
  }

  return <section className="agent-memory-panel" aria-label="项目创作记忆">
    <header><AgentPanelBackButton onClick={onBackToConversation} /><div><small>PROJECT MEMORY</small><h2>项目记忆</h2></div><span>{memory.length} 条</span></header>
    <p>仅用于当前项目的后续规划；保存品牌规则、认可方向与禁区。</p>
    <div className="agent-memory-panel__form">
      <BotanicSelect value={kind} ariaLabel="记忆类型" options={[
        { value: 'rule', label: '长期规则' },
        { value: 'approved', label: '已确认方向' },
        { value: 'avoid', label: '避免事项' },
      ]} onChange={(value) => setKind(value as BotanicAgentMemoryKind)} />
      <textarea value={draft} maxLength={500} onChange={(event) => setDraft(event.target.value)} placeholder="例如：商品包装与品牌色不可改变" aria-label="项目记忆内容" />
      <button type="button" disabled={!draft.trim()} onClick={save}>保存记忆</button>
    </div>
    <div className="agent-memory-panel__list">
      {memory.map((item) => <article key={item.id} className={`is-${item.kind}`}><span><small>{agentMemoryKindLabel(item.kind)}</small><p>{item.content}</p></span><div>{item.sourceNodeIds[0] ? <button type="button" aria-label={`在画布定位记忆 ${item.content}`} title="在画布定位" onClick={() => onLocateNode(item.sourceNodeIds[0])}><FocusIcon /></button> : null}<button type="button" className="is-delete" aria-label={`删除记忆 ${item.content}`} title="删除记忆" onClick={() => onRemoveMemory(item.id)}><DeleteIcon /></button></div></article>)}
      {!memory.length ? <div className="agent-panel__empty">还没有项目记忆。</div> : null}
    </div>
  </section>
}

export function AgentSkillCard({
  id,
  name,
  instructions,
  source,
  expanded,
  onToggle,
}: {
  id: string
  name: string
  instructions: string
  source: 'system' | 'project'
  expanded: boolean
  onToggle: (id: string) => void
}) {
  const summary = botanicAgentSkillSummary(instructions)
  const body = botanicAgentSkillBody(instructions)
  return <article className={`agent-skill-card${expanded ? ' is-expanded' : ''}`}>
    <button type="button" aria-expanded={expanded} aria-controls={`skill-body-${id}`} onClick={() => onToggle(id)}>
      <span>
        {source === 'system' ? <SparkleIcon /> : null}
        <b>{name}</b>
      </span>
      <small>{source === 'system' ? '系统' : '项目'} · @调用</small>
      {!expanded && summary ? <p>{summary}</p> : null}
    </button>
    {expanded ? <pre id={`skill-body-${id}`} className="agent-skill-card__body">{body}</pre> : null}
  </article>
}
