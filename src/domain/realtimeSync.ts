import type { BotanicAgentRunSnapshot } from './agent'

export type ProjectUpdatedRealtimeEvent = {
  type: 'project.updated'
  projectId: string
  revision: number
  graphRevision?: number
  updatedAt: number
}

export type CanvasCrdtRealtimeEvent = {
  type: 'canvas.crdt.update'
  projectId: string
  update: string
}

export type AgentRunUpdatedRealtimeEvent = {
  type: 'agent.run.updated'
  projectId: string
  run: BotanicAgentRunSnapshot
}

export type ProjectRealtimeEvent = ProjectUpdatedRealtimeEvent | CanvasCrdtRealtimeEvent | AgentRunUpdatedRealtimeEvent

export function parseProjectRealtimeEvent(event: unknown, currentProjectId: string): ProjectRealtimeEvent | undefined {
  if (!event || typeof event !== 'object') return undefined
  const candidate = event as {
    type?: unknown
    projectId?: unknown
    revision?: unknown
    graphRevision?: unknown
    updatedAt?: unknown
    update?: unknown
    run?: unknown
  }
  if (candidate.projectId !== currentProjectId) return undefined
  if (candidate.type === 'project.updated'
    && typeof candidate.revision === 'number'
    && (candidate.graphRevision === undefined || typeof candidate.graphRevision === 'number')
    && typeof candidate.updatedAt === 'number') {
    return candidate as ProjectUpdatedRealtimeEvent
  }
  if (candidate.type === 'canvas.crdt.update'
    && typeof candidate.update === 'string'
    && candidate.update.length > 0
    && candidate.update.length <= 700_000
    && /^[A-Za-z0-9+/]*={0,2}$/.test(candidate.update)) {
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
  return undefined
}

export function shouldRefreshFromRealtimeEvent({
  event,
  currentProjectId,
  currentUpdatedAt,
}: {
  event: unknown
  currentProjectId: string
  currentUpdatedAt: number
}) {
  if (!event || typeof event !== 'object') return false
  const candidate = event as Partial<ProjectUpdatedRealtimeEvent>
  return candidate.type === 'project.updated'
    && candidate.projectId === currentProjectId
    && typeof candidate.revision === 'number'
    && typeof candidate.updatedAt === 'number'
    && candidate.updatedAt > currentUpdatedAt
}
