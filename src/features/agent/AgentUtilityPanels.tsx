import { useEffect, useMemo, useState } from 'react'
import {
  botanicAgentRunFeedback,
  resolveBotanicAgentResultSelection,
  type BotanicAgentArtifact,
  type BotanicAgentMemoryItem,
  type BotanicAgentMemoryKind,
  type BotanicAgentRun,
} from '../../domain/agent'
import { BotanicSelect } from '../../components/BotanicSelect'
import { ArrowUpRightIcon, DeleteIcon, DownloadIcon, FocusIcon, FolderOutlineIcon, SparkleIcon } from '../../components/BotanicIcons'
import type { CollaborationActivity, CollaborationDocumentChange } from '../../domain/collaborationActivity'
import { downloadMedia } from '../../lib/mediaDownload'
import { agentArtifactKindLabel, agentMemoryKindLabel, agentRunOutputCount } from './AgentWorkspaceParts'
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
}) {
  return <section className="agent-collaboration-panel" aria-label="协作动态">
    <header><div><small>COLLABORATION</small><h2>协作动态</h2></div><span>{activities.length} 条</span></header>
    <p>查看成员最近修改，并直接定位到相关节点、对话或任务。</p>
    {persistenceStatus === 'conflict' ? <div className="agent-collaboration-panel__conflict" role="alert">
      <span><strong>画布有新的云端版本</strong><small>本地草稿仍保留。先查看变更，再决定使用哪一版。</small></span>
      {conflictChanges.length ? <ul>{conflictChanges.map((change, index) => <li key={`${change.summary}-${index}`}>
        <button type="button" onClick={() => onLocate({ id: `conflict-${index}`, actorName: '云端版本', occurredAt: Date.now(), unread: false, count: 1, ...change })}>{change.summary}{change.target?.kind === 'node' ? <FocusIcon /> : null}</button>
      </li>)}</ul> : <small>正在读取云端变更…</small>}
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
      {!activities.length && historyStatus !== 'loading' ? <div className="agent-skill-panel__empty">还没有协作变更。</div> : null}
      {historyStatus === 'loading' ? <div className="agent-skill-panel__empty" role="status">正在读取协作动态…</div> : null}
      {historyHasMore ? <button type="button" className="agent-collaboration-panel__load-more" disabled={historyStatus === 'loading-more'} onClick={() => void onLoadMore().catch(() => undefined)}>{historyStatus === 'loading-more' ? '加载中…' : '加载更早动态'}</button> : null}
    </div>
  </section>
}

export function AgentResultPanel({
  artifacts,
  runs,
  latestRun,
  contextOptions,
  artifactIndexStatus,
  artifactIndexHasMore,
  conversationRunIds,
  onLocateNode,
  onSaveArtifact,
  onContinue,
  onStartNextRound,
  onLoadMoreArtifacts,
  onLocateConversation,
}: {
  artifacts: BotanicAgentArtifact[]
  runs: BotanicAgentRun[]
  latestRun?: BotanicAgentRun
  contextOptions: AgentContextItem[]
  artifactIndexStatus: AgentArtifactIndexState['status']
  artifactIndexHasMore: boolean
  conversationRunIds: string[]
  onLocateNode: (nodeId: string) => void
  onSaveArtifact: (artifact: BotanicAgentArtifact) => void
  onContinue: (artifact: BotanicAgentArtifact) => void
  onStartNextRound: (sourceNodeIds: string[], artifactCount: number) => void
  onLoadMoreArtifacts: () => Promise<void>
  onLocateConversation: (runId: string) => void
}) {
  const [filter, setFilter] = useState<'all' | 'image' | 'video' | 'file'>('all')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const filteredArtifacts = useMemo(() => artifacts.filter((artifact) => {
    if (filter === 'all') return true
    if (filter === 'file') return artifact.kind !== 'image' && artifact.kind !== 'video'
    return artifact.kind === filter
  }), [artifacts, filter])
  const groups = useMemo(() => {
    const grouped = new Map<string, { id: string; label: string; artifacts: BotanicAgentArtifact[] }>()
    for (const artifact of filteredArtifacts) {
      const runId = artifact.provenance.runId
      const id = runId ?? `action:${artifact.provenance.actionId}`
      const label = runId ? runs.find((run) => run.id === runId)?.plan.summary ?? '生成批次' : '工具产物'
      const group = grouped.get(id) ?? { id, label, artifacts: [] }
      group.artifacts.push(artifact)
      grouped.set(id, group)
    }
    return [...grouped.values()]
  }, [filteredArtifacts, runs])
  const selectedBatch = useMemo(() => resolveBotanicAgentResultSelection(artifacts, selectedIds), [artifacts, selectedIds])
  const availableNodeIds = useMemo(() => new Set(contextOptions.map((item) => item.id)), [contextOptions])
  const resultNodeIds = useMemo(() => new Set(contextOptions.filter((item) => item.kind === '结果').map((item) => item.id)), [contextOptions])
  const selectedResultNodeIds = selectedBatch.sourceNodeIds.filter((nodeId) => resultNodeIds.has(nodeId))
  const latestFeedback = latestRun
    ? botanicAgentRunFeedback(latestRun.status, agentRunOutputCount(latestRun, artifacts), latestRun.error)
    : undefined

  useEffect(() => {
    setSelectedIds((current) => current.filter((id) => artifacts.some((artifact) => artifact.id === id)))
  }, [artifacts])

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

  return <section className="agent-result-panel" aria-label="Agent 结果与文件">
    <header><div><small>AGENT OUTPUTS</small><h2>结果与文件</h2></div><span>{artifacts.length} 项</span></header>
    <p>生成图与 Skill / MCP 产物统一按任务分组；画布节点和版本血缘不变。</p>
    {artifactIndexStatus === 'loading' ? <div className="agent-result-panel__index-status" role="status">正在读取历史 Artifact Index…</div> : null}
    {artifactIndexStatus === 'error' ? <div className="agent-result-panel__index-status is-warning" role="status">历史索引暂不可用，已显示当前画布结果。</div> : null}
    {latestFeedback ? <div className={`agent-result-panel__run-status is-${latestFeedback.tone}`} role="status"><strong>{latestFeedback.label}</strong><span>{latestFeedback.detail}</span></div> : null}
    <div className="agent-result-panel__filters" role="group" aria-label="结果类型">
      {([['all', '全部'], ['image', '图片'], ['video', '视频'], ['file', '文件']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} className={filter === value ? 'is-active' : ''} onClick={() => setFilter(value)}>{label}</button>)}
    </div>
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
      {groups.map((group) => <section key={group.id} className="agent-result-group">
        <header><span><strong>{group.label}</strong><small>{group.artifacts.length} 项</small></span><div>
          {conversationRunIds.includes(group.id) ? <button type="button" onClick={() => onLocateConversation(group.id)}>来源对话</button> : null}
          <button type="button" onClick={() => toggleGroup(group.artifacts)}>{group.artifacts.every((artifact) => selectedIds.includes(artifact.id)) ? '取消本组' : '选择本组'}</button>
        </div></header>
        <div className="agent-result-panel__grid">
          {group.artifacts.map((artifact) => {
            const locatableNodeId = artifact.provenance.sourceNodeIds?.find((nodeId) => availableNodeIds.has(nodeId))
            const canContinue = Boolean(locatableNodeId || (artifact.url && (artifact.kind === 'image' || artifact.kind === 'video')))
            const selected = selectedIds.includes(artifact.id)
            return <article key={artifact.id} className={selected ? 'is-selected' : ''}>
              <button type="button" className="agent-result-panel__select" aria-pressed={selected} aria-label={`${selected ? '取消选择' : '选择'} ${artifact.label}`} onClick={() => toggleSelection(artifact.id)}>{selected ? '✓' : ''}</button>
              {artifact.url && (artifact.kind === 'image' || artifact.kind === 'video') ? <div className="agent-result-panel__preview">
                {artifact.kind === 'image' ? <img src={artifact.url} alt="" /> : <video src={artifact.url} muted playsInline />}
              </div> : <div className="agent-result-panel__document"><span>{artifact.kind === 'workflow' ? '⌘' : 'Aa'}</span><p>{artifact.content ?? artifact.label}</p></div>}
              <div className="agent-result-panel__meta"><span><strong>{artifact.label}</strong><small>{agentArtifactKindLabel(artifact)} · {artifact.provenance.toolName}{locatableNodeId ? ' · 已回填画布' : ''}</small></span><div>
                {locatableNodeId ? <button type="button" aria-label={`在画布定位 ${artifact.label}`} title="在画布定位" onClick={() => onLocateNode(locatableNodeId)}><FocusIcon /></button> : null}
                {canContinue ? <button type="button" aria-label={`基于 ${artifact.label} 继续修改`} title="继续修改" onClick={() => onContinue(artifact)}><SparkleIcon /></button> : null}
                {artifact.url && (artifact.kind === 'image' || artifact.kind === 'video') ? <button type="button" aria-label={`下载 ${artifact.label}`} title="下载" onClick={() => void downloadMedia(artifact.url!, artifact.label, artifact.kind === 'video' ? 'video' : 'image')}><DownloadIcon /></button> : artifact.url ? <a href={artifact.url} target="_blank" rel="noreferrer" aria-label={`打开 ${artifact.label}`} title="打开"><ArrowUpRightIcon /></a> : null}
                {artifact.url && (artifact.kind === 'image' || artifact.kind === 'video') ? <button type="button" aria-label={artifact.metadata?.savedToLibrary === true ? `${artifact.label} 已入库` : `将 ${artifact.label} 入库`} title={artifact.metadata?.savedToLibrary === true ? '已入库' : '存入素材库'} disabled={artifact.metadata?.savedToLibrary === true} onClick={() => onSaveArtifact(artifact)}><FolderOutlineIcon /></button> : null}
              </div></div>
            </article>
          })}
        </div>
      </section>)}
      {!filteredArtifacts.length ? <div className="agent-skill-panel__empty">还没有该类型结果。生成或执行 Skill / MCP 后会自动汇总。</div> : null}
      {artifactIndexHasMore ? <button type="button" className="agent-result-panel__load-more" disabled={artifactIndexStatus === 'loading-more'} onClick={() => void onLoadMoreArtifacts()}>{artifactIndexStatus === 'loading-more' ? '加载中…' : '加载更早结果'}</button> : null}
    </div>
  </section>
}

export function AgentMemoryPanel({ memory, sourceNodeIds, onAddMemory, onRemoveMemory, onLocateNode }: {
  memory: BotanicAgentMemoryItem[]
  sourceNodeIds: string[]
  onAddMemory: (kind: BotanicAgentMemoryKind, content: string, sourceNodeIds?: string[]) => string | null
  onRemoveMemory: (memoryId: string) => void
  onLocateNode: (nodeId: string) => void
}) {
  const [kind, setKind] = useState<BotanicAgentMemoryKind>('rule')
  const [draft, setDraft] = useState('')
  const save = () => {
    if (!draft.trim()) return
    if (onAddMemory(kind, draft, sourceNodeIds)) setDraft('')
  }

  return <section className="agent-memory-panel" aria-label="项目创作记忆">
    <header><div><small>PROJECT MEMORY</small><h2>项目记忆</h2></div><span>{memory.length} 条</span></header>
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
      {!memory.length ? <div className="agent-skill-panel__empty">还没有项目记忆。</div> : null}
    </div>
  </section>
}
