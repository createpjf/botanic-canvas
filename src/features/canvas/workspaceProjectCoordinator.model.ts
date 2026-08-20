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

export function nextWorkspaceProjectName(projects: Array<Pick<WorkspaceProject, 'id'>>, locale: ProductLocale = 'zh-CN') {
  const ordinal = projects.filter((item) => item.id.startsWith('project-')).length + 1
  return locale === 'en' ? `Creative project ${ordinal}` : `创意项目 ${ordinal}`
}
