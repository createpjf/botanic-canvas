import type { BotanicAgentRun } from './agent.ts'
import type { CanvasDocument, CanvasNode } from './canvas.ts'

export type CollaborationActivityKind = 'canvas' | 'conversation' | 'task' | 'project'

export type CollaborationActivityTarget =
  | { kind: 'node'; nodeId: string }
  | { kind: 'message'; sessionId: string; messageId: string }
  | { kind: 'task'; runId: string }
  | { kind: 'project' }

export type CollaborationDocumentChange = {
  kind: CollaborationActivityKind
  summary: string
  target?: CollaborationActivityTarget
}

export type CollaborationActivity = CollaborationDocumentChange & {
  id: string
  actorId?: string
  actorName: string
  occurredAt: number
  unread: boolean
  count: number
}

function nodeLabel(node: CanvasNode) {
  const data = node.data as { label?: unknown; name?: unknown }
  const label = typeof data.label === 'string' ? data.label : typeof data.name === 'string' ? data.name : ''
  return label.trim() || '未命名节点'
}

function contentSignature(node: CanvasNode) {
  const { position: _position, selected: _selected, ...rest } = node
  const data = { ...(rest.data as Record<string, unknown>) }
  delete data.selected
  return JSON.stringify({ ...rest, data })
}

function changedRun(before: BotanicAgentRun | undefined, after: BotanicAgentRun) {
  return !before || before.updatedAt !== after.updatedAt || before.status !== after.status
}

/**
 * 把远端文档差异压缩成一条用户可理解、可定位的协作变更。
 * 它不参与合并与持久化，只生成 Agent 面板的非权威读模型。
 */
export function collaborationDocumentChange(before: CanvasDocument, after: CanvasDocument): CollaborationDocumentChange {
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]))
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]))
  const added = after.nodes.filter((node) => !beforeNodes.has(node.id))
  if (added.length === 1) {
    return { kind: 'canvas', summary: `新增了「${nodeLabel(added[0])}」`, target: { kind: 'node', nodeId: added[0].id } }
  }
  if (added.length > 1) return { kind: 'canvas', summary: `新增了 ${added.length} 个画布节点`, target: { kind: 'node', nodeId: added[0].id } }

  const removed = before.nodes.filter((node) => !afterNodes.has(node.id))
  if (removed.length === 1) return { kind: 'canvas', summary: `移除了「${nodeLabel(removed[0])}」` }
  if (removed.length > 1) return { kind: 'canvas', summary: `移除了 ${removed.length} 个画布节点` }

  const changed = after.nodes.filter((node) => {
    const previous = beforeNodes.get(node.id)
    return previous && JSON.stringify(previous) !== JSON.stringify(node)
  })
  if (changed.length === 1) {
    const node = changed[0]
    const previous = beforeNodes.get(node.id)!
    const movedOnly = contentSignature(previous) === contentSignature(node)
    return {
      kind: 'canvas',
      summary: `${movedOnly ? '移动' : '更新'}了「${nodeLabel(node)}」`,
      target: { kind: 'node', nodeId: node.id },
    }
  }
  if (changed.length > 1) return { kind: 'canvas', summary: `更新了 ${changed.length} 个画布节点`, target: { kind: 'node', nodeId: changed[0].id } }

  const beforeRuns = new Map(before.agentRuns.map((run) => [run.id, run]))
  const run = after.agentRuns.find((candidate) => changedRun(beforeRuns.get(candidate.id), candidate))
  if (run) {
    return {
      kind: 'task',
      summary: `更新了任务「${run.plan.summary || '生成任务'}」`,
      target: { kind: 'task', runId: run.id },
    }
  }

  if (JSON.stringify(before.edges) !== JSON.stringify(after.edges)) return { kind: 'canvas', summary: '调整了画布连线' }
  if (before.name !== after.name) return { kind: 'project', summary: `将项目重命名为「${after.name}」`, target: { kind: 'project' } }
  return { kind: 'project', summary: '更新了项目内容', target: { kind: 'project' } }
}

/**
 * 冲突审阅需要展示多个具体差异，而不是把整份文档压成一句泛化提示。
 * 只生成可读摘要，不参与文档合并。
 */
export function collaborationDocumentChanges(
  before: CanvasDocument,
  after: CanvasDocument,
  maximum = 8,
): CollaborationDocumentChange[] {
  const changes: CollaborationDocumentChange[] = []
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]))
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]))

  for (const node of after.nodes) {
    const previous = beforeNodes.get(node.id)
    if (!previous) changes.push({ kind: 'canvas', summary: `新增了「${nodeLabel(node)}」`, target: { kind: 'node', nodeId: node.id } })
    else if (JSON.stringify(previous) !== JSON.stringify(node)) changes.push({
      kind: 'canvas',
      summary: `${contentSignature(previous) === contentSignature(node) ? '移动' : '更新'}了「${nodeLabel(node)}」`,
      target: { kind: 'node', nodeId: node.id },
    })
  }
  for (const node of before.nodes) {
    if (!afterNodes.has(node.id)) changes.push({ kind: 'canvas', summary: `移除了「${nodeLabel(node)}」` })
  }
  if (JSON.stringify(before.edges) !== JSON.stringify(after.edges)) changes.push({ kind: 'canvas', summary: '调整了画布连线' })
  if (before.name !== after.name) changes.push({ kind: 'project', summary: `将项目重命名为「${after.name}」`, target: { kind: 'project' } })

  return changes.slice(0, Math.max(1, maximum))
}

function targetKey(target: CollaborationActivityTarget | undefined) {
  if (!target) return ''
  if (target.kind === 'node') return `node:${target.nodeId}`
  if (target.kind === 'message') return `message:${target.sessionId}:${target.messageId}`
  if (target.kind === 'task') return `task:${target.runId}`
  return 'project'
}

export function appendCollaborationActivity(
  activities: CollaborationActivity[],
  incoming: CollaborationActivity,
  { maximum = 30, mergeWindowMs = 15_000 } = {},
) {
  const latest = activities[0]
  const merge = latest
    && latest.actorId === incoming.actorId
    && latest.kind === incoming.kind
    && latest.summary === incoming.summary
    && targetKey(latest.target) === targetKey(incoming.target)
    && incoming.occurredAt - latest.occurredAt <= mergeWindowMs
  if (merge) {
    return [{ ...incoming, id: latest.id, count: latest.count + incoming.count, unread: true }, ...activities.slice(1)]
  }
  return [incoming, ...activities].slice(0, maximum)
}

export function markCollaborationActivitiesRead(activities: CollaborationActivity[]) {
  return activities.map((activity) => activity.unread ? { ...activity, unread: false } : activity)
}
