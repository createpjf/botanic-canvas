export type WorkspaceView = 'projects' | 'canvas'

export type WorkspaceLocation = {
  view: WorkspaceView
  projectId?: string
}

export function workspaceLocationFromHash(hash: string): WorkspaceLocation | null {
  const path = hash.replace(/^#\/?/, '').replace(/\/+$/, '')
  // 旧经营驾驶舱地址保留为项目库别名，避免历史书签失效。
  if (path === 'dashboard') return { view: 'projects' }
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

/** 冷启动、列表打开和浏览器前进/后退共用；旧读取不阻塞新导航。 */
export function createWorkspaceNavigation(input: {
  openDocument: (id: string, signal: AbortSignal) => Promise<boolean>
  onStart: (location: WorkspaceLocation) => void
  onFinish: (location: WorkspaceLocation) => void
  onError: (location: WorkspaceLocation) => void
}) {
  let current: { location: WorkspaceLocation; controller: AbortController; result: Promise<boolean> } | undefined
  const cancel = () => { current?.controller.abort(); current = undefined }
  const open = (location: WorkspaceLocation, force = false): Promise<boolean> => {
    if (!force && current && sameWorkspaceLocation(location, current.location)) return current.result
    cancel()
    const controller = new AbortController()
    let finish!: (opened: boolean) => void
    const result = new Promise<boolean>((resolve) => { finish = resolve })
    current = { location, controller, result }
    input.onStart(location)
    if (location.view !== 'canvas' || !location.projectId) {
      input.onFinish(location)
      finish(true)
      return result
    }
    const timer = setTimeout(() => {
      if (controller.signal.aborted) return
      controller.abort()
      input.onError(location)
    }, 45_000)
    controller.signal.addEventListener('abort', () => { clearTimeout(timer); finish(false) }, { once: true })
    void Promise.resolve().then(() => controller.signal.aborted ? false : input.openDocument(location.projectId!, controller.signal)).then((opened) => {
      if (controller.signal.aborted) return
      if (opened) input.onFinish(location)
      else { controller.abort(); input.onError(location) }
      finish(opened)
    }).catch(() => {
      if (controller.signal.aborted) return
      controller.abort()
      input.onError(location)
      finish(false)
    }).finally(() => clearTimeout(timer))
    return result
  }
  return { open, cancel }
}
