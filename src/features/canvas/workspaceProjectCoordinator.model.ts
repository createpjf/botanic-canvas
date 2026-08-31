import type { WorkspaceProject } from '../../components/WorkspaceViews.tsx'
import { formatProductNumber, type LocalizedText, type ProductLocale } from '../../i18n/core.ts'
import type { CanvasProjectSummary } from '../../lib/db.ts'

function countLabel(value: number, noun: 'image' | 'node', locale: ProductLocale) {
  const count = formatProductNumber(value, locale)
  if (locale === 'zh-CN') return `${count} ${noun === 'image' ? '张图' : '个节点'}`
  return `${count} ${noun}${value === 1 ? '' : 's'}`
}

export function workspaceProjectSummary(resultCount: number, nodeCount: number): LocalizedText {
  if (resultCount > 0) return {
    'zh-CN': `已生成 ${countLabel(resultCount, 'image', 'zh-CN')} · ${countLabel(nodeCount, 'node', 'zh-CN')}`,
    en: `${countLabel(resultCount, 'image', 'en')} generated · ${countLabel(nodeCount, 'node', 'en')}`,
  }
  if (nodeCount > 0) return {
    'zh-CN': `已搭建 ${countLabel(nodeCount, 'node', 'zh-CN')}`,
    en: `${countLabel(nodeCount, 'node', 'en')} on canvas`,
  }
  return { 'zh-CN': '空白画布', en: 'Blank canvas' }
}

export function workspaceTemplateProjectSummary(nodeCount: number): LocalizedText {
  return {
    'zh-CN': `模板项目 · ${countLabel(nodeCount, 'node', 'zh-CN')}`,
    en: `Template project · ${countLabel(nodeCount, 'node', 'en')}`,
  }
}

export function workspaceProjectsFromSummaries(summaries: CanvasProjectSummary[], locale: ProductLocale = 'zh-CN'): WorkspaceProject[] {
  return summaries
    .filter((item) => (item.nodeCount ?? 0) > 0 || (item.resultCount ?? 0) > 0)
    .map((item) => {
      const summaryByLocale = workspaceProjectSummary(item.resultCount ?? 0, item.nodeCount ?? 0)
      return {
        id: item.id,
        name: item.name,
        updatedAt: item.updatedAt,
        cover: item.coverImage,
        summary: summaryByLocale[locale],
        summaryByLocale,
        isSeed: item.id === 'summer-fragrance-visual-lab',
      }
    })
}

/** 列表刷新不得用更旧的远端摘要盖掉本机刚改的项目名。 */
export function reconcileWorkspaceProjects(current: WorkspaceProject[], incoming: WorkspaceProject[]) {
  const currentById = new Map(current.map((project) => [project.id, project]))
  return incoming.map((project) => {
    const local = currentById.get(project.id)
    if (local && local.updatedAt > project.updatedAt && local.name !== project.name) {
      return { ...project, name: local.name, updatedAt: local.updatedAt }
    }
    return project
  })
}

export function nextWorkspaceProjectName(projects: Array<Pick<WorkspaceProject, 'name'>>, locale: ProductLocale = 'zh-CN') {
  const pattern = locale === 'en' ? /^Creative project (\d+)$/i : /^创意项目 (\d+)$/
  const used = new Set(projects.flatMap((item) => {
    const match = item.name.trim().match(pattern)
    return match ? [Number(match[1])] : []
  }))
  let ordinal = 1
  while (used.has(ordinal)) ordinal += 1
  return locale === 'en' ? `Creative project ${ordinal}` : `创意项目 ${ordinal}`
}
