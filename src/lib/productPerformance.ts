const projectOpenMarks = new Map<string, number>()

/** 用户点击打开项目时打点，供首帧画布可见时计算端到端耗时。 */
export function markProjectOpenStarted(projectId: string) {
  projectOpenMarks.set(projectId, Date.now())
}

export function observeProjectOpenCanvasVisible(projectId: string) {
  const startedAt = projectOpenMarks.get(projectId)
  if (!startedAt) return
  projectOpenMarks.delete(projectId)
  const durationMs = Date.now() - startedAt
  console.info(JSON.stringify({
    event: 'project.open',
    projectId,
    phase: 'canvas_visible',
    durationMs,
  }))
}
