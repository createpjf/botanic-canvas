import { randomUUID } from 'node:crypto'

const allowedKinds = new Set(['canvas', 'conversation', 'task', 'project'])
const allowedTargetKinds = new Set(['node', 'message', 'task', 'project'])

function text(value, maximum) {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : ''
}

export function validateCollaborationActivity(input, { actorId, actorName, occurredAt = Date.now() }) {
  const kind = text(input?.kind, 32)
  const summary = text(input?.summary, 240)
  if (!allowedKinds.has(kind) || !summary) throw new TypeError('协作动态格式无效。')
  const targetKind = text(input?.target?.kind, 32)
  const target = allowedTargetKinds.has(targetKind) ? structuredClone(input.target) : undefined
  return {
    id: text(input?.id, 200) || `collaboration_${randomUUID()}`,
    actorId,
    actorName: text(actorName, 80) || '协作者',
    kind,
    summary,
    ...(target ? { target } : {}),
    occurredAt,
    count: Math.max(1, Math.min(999, Number.isInteger(input?.count) ? input.count : 1)),
  }
}

export function collaborationActivitiesForMember(activities, receipt, userId, limit = 100) {
  const options = collaborationActivityListOptions(limit)
  const readAt = Number(receipt?.readAt ?? 0)
  const clearedAt = Number(receipt?.clearedAt ?? 0)
  return activities
    .filter((activity) => activity.occurredAt > clearedAt)
    .filter((activity) => !options.before
      || activity.occurredAt < options.before.occurredAt
      || (activity.occurredAt === options.before.occurredAt && activity.id.localeCompare(options.before.id) < 0))
    .sort((left, right) => right.occurredAt - left.occurredAt || right.id.localeCompare(left.id))
    .slice(0, options.limit)
    .map((activity) => ({
      ...structuredClone(activity),
      unread: activity.actorId !== userId && activity.occurredAt > readAt,
    }))
}

export function collaborationActivityListOptions(input = 100) {
  const value = typeof input === 'number' ? { limit: input } : input ?? {}
  const limit = Math.max(1, Math.min(Number(value.limit) || 100, 500))
  const occurredAt = Number(value.before?.occurredAt)
  const id = text(value.before?.id, 200)
  return {
    limit,
    ...(Number.isFinite(occurredAt) && occurredAt >= 0 && id ? { before: { occurredAt, id } } : {}),
  }
}

export function encodeCollaborationActivityCursor(activity) {
  if (!activity || !Number.isFinite(Number(activity.occurredAt)) || typeof activity.id !== 'string' || !activity.id) return undefined
  return Buffer.from(JSON.stringify([Number(activity.occurredAt), activity.id]), 'utf8').toString('base64url')
}

export function decodeCollaborationActivityCursor(value) {
  if (value === undefined || value === null || value === '') return undefined
  try {
    const [occurredAt, id] = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'))
    if (Number.isFinite(Number(occurredAt)) && Number(occurredAt) >= 0 && typeof id === 'string' && id) {
      return { occurredAt: Number(occurredAt), id: id.slice(0, 200) }
    }
  } catch {}
  throw new TypeError('协作动态分页游标无效。')
}

export function nextCollaborationReceipt(current, action, timestamp = Date.now()) {
  if (action !== 'read' && action !== 'clear') throw new TypeError('协作回执操作无效。')
  const readAt = Math.max(Number(current?.readAt ?? 0), timestamp)
  const clearedAt = action === 'clear' ? Math.max(Number(current?.clearedAt ?? 0), timestamp) : Number(current?.clearedAt ?? 0)
  return { readAt, clearedAt, updatedAt: Math.max(Number(current?.updatedAt ?? 0), timestamp) }
}

function nodeLabel(node) {
  const label = typeof node?.data?.label === 'string' ? node.data.label : typeof node?.data?.name === 'string' ? node.data.name : ''
  return label.trim() || '未命名节点'
}

function contentSignature(node) {
  if (!node) return ''
  const { position: _position, selected: _selected, ...rest } = node
  const data = { ...(rest.data ?? {}) }
  delete data.selected
  return JSON.stringify({ ...rest, data })
}

export function collaborationChangeFromDocuments(before, after) {
  const beforeNodes = new Map((before?.nodes ?? []).map((node) => [node.id, node]))
  const afterNodes = new Map((after?.nodes ?? []).map((node) => [node.id, node]))
  const added = (after?.nodes ?? []).filter((node) => !beforeNodes.has(node.id))
  if (added.length) return {
    kind: 'canvas',
    summary: added.length === 1 ? `新增了「${nodeLabel(added[0])}」` : `新增了 ${added.length} 个画布节点`,
    target: { kind: 'node', nodeId: added[0].id },
  }
  const removed = (before?.nodes ?? []).filter((node) => !afterNodes.has(node.id))
  if (removed.length) return {
    kind: 'canvas',
    summary: removed.length === 1 ? `移除了「${nodeLabel(removed[0])}」` : `移除了 ${removed.length} 个画布节点`,
  }
  const changed = (after?.nodes ?? []).filter((node) => beforeNodes.has(node.id) && JSON.stringify(beforeNodes.get(node.id)) !== JSON.stringify(node))
  if (changed.length) {
    const movedOnly = changed.length === 1 && contentSignature(beforeNodes.get(changed[0].id)) === contentSignature(changed[0])
    return {
      kind: 'canvas',
      summary: changed.length === 1 ? `${movedOnly ? '移动' : '更新'}了「${nodeLabel(changed[0])}」` : `更新了 ${changed.length} 个画布节点`,
      target: { kind: 'node', nodeId: changed[0].id },
    }
  }
  if (JSON.stringify(before?.edges ?? []) !== JSON.stringify(after?.edges ?? [])) return { kind: 'canvas', summary: '调整了画布连线' }
  if (before?.name !== after?.name) return { kind: 'project', summary: `将项目重命名为「${after?.name ?? '未命名项目'}」`, target: { kind: 'project' } }
  const beforeSessions = new Map((before?.agentSessions ?? []).map((session) => [session.id, session]))
  for (const session of after?.agentSessions ?? []) {
    const knownMessageIds = new Set((beforeSessions.get(session.id)?.messages ?? []).map((message) => message.id))
    const message = [...(session.messages ?? [])].reverse().find((candidate) => !knownMessageIds.has(candidate.id))
    if (message) return {
      kind: 'conversation',
      summary: `更新了对话「${session.title || '新建对话'}」`,
      target: { kind: 'message', sessionId: session.id, messageId: message.id },
    }
  }
  const beforeRuns = new Map((before?.agentRuns ?? []).map((run) => [run.id, run]))
  const run = (after?.agentRuns ?? []).find((candidate) => {
    const previous = beforeRuns.get(candidate.id)
    return !previous || previous.updatedAt !== candidate.updatedAt || previous.status !== candidate.status
  })
  if (run) return {
    kind: 'task',
    summary: `更新了任务「${run.plan?.summary || '生成任务'}」`,
    target: { kind: 'task', runId: run.id },
  }
  return undefined
}
