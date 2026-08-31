import type { BotanicAgentRunSnapshot } from './agent'
import type { CollaborationActivity } from './collaborationActivity'

export type ProjectRealtimeConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed'

export type ProjectUpdatedRealtimeEvent = {
  type: 'project.updated'
  projectId: string
  revision: number
  graphRevision?: number
  updatedAt: number
  actorId?: string
  actorName?: string
}

export type CanvasCrdtRealtimeEvent = {
  type: 'canvas.crdt.update'
  projectId: string
  update: string
  actorId?: string
  actorName?: string
  activity?: CollaborationActivity
}

export type AgentRunUpdatedRealtimeEvent = {
  type: 'agent.run.updated'
  projectId: string
  run: BotanicAgentRunSnapshot
}

export type CollaborationPresenceRealtimeEvent = {
  type: 'collaboration.presence'
  projectId: string
  members: Array<{ userId: string; actorName?: string; connectionCount: number }>
}

export type CollaborationActivityRealtimeEvent = {
  type: 'collaboration.activity'
  projectId: string
  activity: CollaborationActivity
}

export type ProjectRealtimeEvent = ProjectUpdatedRealtimeEvent | CanvasCrdtRealtimeEvent | AgentRunUpdatedRealtimeEvent | CollaborationPresenceRealtimeEvent | CollaborationActivityRealtimeEvent

export function projectRealtimeConnectionOpened(openedBefore: boolean) {
  return {
    openedBefore: true,
    event: { reconnected: openedBefore },
  }
}

export function parseProjectRealtimeEvent(event: unknown, currentProjectId: string): ProjectRealtimeEvent | undefined {
  if (!event || typeof event !== 'object') return undefined
  const candidate = event as {
    type?: unknown
    projectId?: unknown
    revision?: unknown
    graphRevision?: unknown
    updatedAt?: unknown
    actorId?: unknown
    actorName?: unknown
    update?: unknown
    run?: unknown
    members?: unknown
    activity?: unknown
  }
  if (candidate.projectId !== currentProjectId) return undefined
  if (candidate.type === 'project.updated'
    && typeof candidate.revision === 'number'
    && (candidate.graphRevision === undefined || typeof candidate.graphRevision === 'number')
    && typeof candidate.updatedAt === 'number'
    && (candidate.actorId === undefined || typeof candidate.actorId === 'string')
    && (candidate.actorName === undefined || (typeof candidate.actorName === 'string' && candidate.actorName.length <= 80))) {
    return candidate as ProjectUpdatedRealtimeEvent
  }
  if (candidate.type === 'collaboration.presence'
    && Array.isArray(candidate.members)
    && candidate.members.length <= 100
    && candidate.members.every((member) => {
      if (!member || typeof member !== 'object') return false
      const value = member as { userId?: unknown; actorName?: unknown; connectionCount?: unknown }
      return typeof value.userId === 'string'
        && value.userId.length > 0
        && value.userId.length <= 200
        && (value.actorName === undefined || (typeof value.actorName === 'string' && value.actorName.length <= 80))
        && Number.isInteger(value.connectionCount)
        && Number(value.connectionCount) > 0
    })) {
    return candidate as CollaborationPresenceRealtimeEvent
  }
  if (candidate.type === 'canvas.crdt.update'
    && typeof candidate.update === 'string'
    && candidate.update.length > 0
    && candidate.update.length <= 700_000
    && /^[A-Za-z0-9+/]*={0,2}$/.test(candidate.update)
    && (candidate.actorId === undefined || typeof candidate.actorId === 'string')
    && (candidate.actorName === undefined || (typeof candidate.actorName === 'string' && candidate.actorName.length <= 80))
    && (candidate.activity === undefined || validCollaborationActivity(candidate.activity))) {
    return candidate as CanvasCrdtRealtimeEvent
  }
  if (candidate.type === 'agent.run.updated' && candidate.run && typeof candidate.run === 'object') {
    const run = candidate.run as Partial<BotanicAgentRunSnapshot>
    if (typeof run.id === 'string'
      && run.projectId === currentProjectId
      && typeof run.status === 'string'
      && Array.isArray(run.branches)
      && typeof run.completedBranchCount === 'number'
      && typeof run.failedBranchCount === 'number'
      && typeof run.createdAt === 'number'
      && typeof run.updatedAt === 'number') {
      return candidate as AgentRunUpdatedRealtimeEvent
    }
  }
  if (candidate.type === 'collaboration.activity' && validCollaborationActivity(candidate.activity)) {
    return candidate as CollaborationActivityRealtimeEvent
  }
  return undefined
}

function validCollaborationActivity(value: unknown) {
  if (!value || typeof value !== 'object') return false
  const activity = value as Partial<CollaborationActivity>
  return typeof activity.id === 'string'
    && typeof activity.actorName === 'string'
    && ['canvas', 'conversation', 'task', 'project'].includes(activity.kind ?? '')
    && typeof activity.summary === 'string'
    && typeof activity.occurredAt === 'number'
    && typeof activity.unread === 'boolean'
    && Number.isInteger(activity.count)
}

export function shouldRefreshFromRealtimeEvent({
  event,
  currentProjectId,
  currentUpdatedAt,
  appliedRevision,
}: {
  event: unknown
  currentProjectId: string
  currentUpdatedAt: number
  /** 本地已反映的服务端 revision；已知时按单调版本判断，不再比本机挂钟。 */
  appliedRevision?: number
}) {
  if (!event || typeof event !== 'object') return false
  const candidate = event as Partial<ProjectUpdatedRealtimeEvent>
  if (candidate.type !== 'project.updated'
    || candidate.projectId !== currentProjectId
    || typeof candidate.revision !== 'number'
    || typeof candidate.updatedAt !== 'number') return false
  return typeof appliedRevision === 'number'
    ? candidate.revision > appliedRevision
    : candidate.updatedAt > currentUpdatedAt
}
