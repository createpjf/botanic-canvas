export type WorkspaceView = 'dashboard' | 'projects' | 'canvas'

export type WorkspaceLocation = {
  view: WorkspaceView
  projectId?: string
}

export function workspaceLocationFromHash(hash: string): WorkspaceLocation | null {
  const path = hash.replace(/^#\/?/, '').replace(/\/+$/, '')
  if (path === 'dashboard') return { view: 'dashboard' }
  if (path === 'projects') return { view: 'projects' }

  const canvasMatch = path.match(/^canvas\/([^/]+)$/)
  if (!canvasMatch) return null

  try {
    const projectId = decodeURIComponent(canvasMatch[1]).trim()
    return projectId ? { view: 'canvas', projectId } : null
  } catch {
    return null
  }
}

export function workspaceHash(location: WorkspaceLocation) {
  if (location.view === 'canvas' && location.projectId) return `#/canvas/${encodeURIComponent(location.projectId)}`
  return `#/${location.view}`
}

export function sameWorkspaceLocation(left: WorkspaceLocation | null, right: WorkspaceLocation | null) {
  return left?.view === right?.view && left?.projectId === right?.projectId
}
