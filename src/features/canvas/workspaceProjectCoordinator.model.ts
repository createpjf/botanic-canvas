import type { WorkspaceProject } from '../../components/WorkspaceViews.tsx'
import type { CanvasProjectSummary } from '../../lib/db.ts'

export function workspaceProjectsFromSummaries(summaries: CanvasProjectSummary[]): WorkspaceProject[] {
  return summaries
    .filter((item) => (item.nodeCount ?? 0) > 0 || (item.resultCount ?? 0) > 0)
    .map((item) => ({
      id: item.id,
      name: item.name,
      updatedAt: item.updatedAt,
      cover: item.coverImage,
      summary: item.resultCount
        ? `已生成 ${item.resultCount} 张图 · ${item.nodeCount ?? 0} 个节点`
        : item.nodeCount ? `已搭建 ${item.nodeCount} 个节点` : '空白画布',
      isSeed: item.id === 'summer-fragrance-visual-lab',
    }))
}

export function nextWorkspaceProjectName(projects: Array<Pick<WorkspaceProject, 'id'>>) {
  const ordinal = projects.filter((item) => item.id.startsWith('project-')).length + 1
  return `创意项目 ${ordinal}`
}
