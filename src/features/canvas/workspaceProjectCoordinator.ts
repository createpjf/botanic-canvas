import { useCallback, useEffect, useMemo, useState, type MutableRefObject } from 'react'
import { createEmptyCanvasDocument } from '../../data/seed'
import type { CanvasDocument } from '../../domain/canvas'
import { createLatestOperation } from '../../domain/latestOperation'
import {
  createCanvasProject,
  deleteCanvasDocument,
  readCanvasProjectSummaries,
  renameCanvasProject,
  type CanvasProjectSummary,
} from '../../lib/db'
import { markProjectOpenStarted } from '../../lib/productPerformance'
import type { WorkspaceProject } from '../../components/WorkspaceViews'
import { useProductI18n } from '../../i18n/react'
import { nextWorkspaceProjectName, reconcileWorkspaceProjects, workspaceProjectsFromSummaries, workspaceTemplateProjectSummary } from './workspaceProjectCoordinator.model'

type WorkspaceProjectCoordinatorOptions = {
  activeDocumentId: string
  refreshKey: string | null
  navigationSequence: MutableRefObject<number>
  openDocument: (documentId: string) => Promise<boolean>
  openNewDocument: (document: CanvasDocument) => void
  renameDocument: (name: string) => Promise<void>
  createDocumentFromTemplate: (templateId: string, shared: boolean) => CanvasDocument | null
  onProjectOpened: (projectId: string) => void
  onProjectDeleted: (projectId: string) => void
}

/**
 * 项目列表与项目级远端命令的唯一协调器。
 * 画布工作区只决定导航去向，不再编排列表竞态、乐观删除或模板建项。
 */
export function useWorkspaceProjectCoordinator({
  activeDocumentId,
  refreshKey,
  navigationSequence,
  openDocument,
  openNewDocument,
  renameDocument,
  createDocumentFromTemplate,
  onProjectOpened,
  onProjectDeleted,
}: WorkspaceProjectCoordinatorOptions) {
  const { locale } = useProductI18n()
  const [projects, setProjects] = useState<WorkspaceProject[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requests = useMemo(() => createLatestOperation(), [])

  const invalidate = useCallback(() => {
    requests.invalidate()
    setLoading(false)
  }, [requests])

  const refresh = useCallback(async () => {
    const operationToken = requests.begin()
    setLoading(true)
    setError(null)
    try {
      const summaries = await readCanvasProjectSummaries()
      if (!requests.isCurrent(operationToken)) return
      setProjects((current) => reconcileWorkspaceProjects(current, workspaceProjectsFromSummaries(summaries, locale)))
    } catch {
      if (requests.isCurrent(operationToken)) setError(locale === 'en' ? 'Check your connection and try again.' : '请检查网络或稍后重试。')
    } finally {
      if (requests.isCurrent(operationToken)) setLoading(false)
    }
  }, [locale, requests])

  useEffect(() => {
    if (refreshKey) void refresh()
  }, [refresh, refreshKey])

  const openProject = useCallback(async (projectId: string) => {
    const navigationRunId = navigationSequence.current
    markProjectOpenStarted(projectId)
    const opened = await openDocument(projectId)
    if (opened && navigationRunId === navigationSequence.current) onProjectOpened(projectId)
    return opened
  }, [navigationSequence, onProjectOpened, openDocument])

  const createProject = useCallback(async () => {
    const project = createEmptyCanvasDocument(`project-${Date.now()}`, nextWorkspaceProjectName(projects, locale))
    // 空白项目首次添加内容时才持久化，避免项目库产生不可用空卡片。
    openNewDocument(project)
    onProjectOpened(project.id)
    return true
  }, [locale, onProjectOpened, openNewDocument, projects])

  const createProjectFromTemplate = useCallback(async (templateId: string, shared: boolean) => {
    const navigationRunId = navigationSequence.current
    const project = createDocumentFromTemplate(templateId, shared)
    if (!project) return false
    try {
      const saved = await createCanvasProject(project)
      invalidate()
      const summaryByLocale = workspaceTemplateProjectSummary(saved.nodes.length)
      setProjects((current) => [{
        id: saved.id,
        name: saved.name,
        updatedAt: saved.updatedAt,
        cover: saved.history[0]?.image || undefined,
        summary: summaryByLocale[locale],
        summaryByLocale,
      }, ...current.filter((item) => item.id !== saved.id)])
      if (navigationRunId === navigationSequence.current) {
        openNewDocument(saved)
        onProjectOpened(saved.id)
      }
      return true
    } catch {
      return false
    }
  }, [createDocumentFromTemplate, invalidate, locale, navigationSequence, onProjectOpened, openNewDocument])

  const renameProject = useCallback(async (projectId: string, name: string) => {
    const nextName = name.trim()
    if (!nextName) return false
    let previousName = ''
    setProjects((current) => current.map((project) => {
      if (project.id !== projectId) return project
      previousName = project.name
      return { ...project, name: nextName, updatedAt: Date.now() }
    }))
    invalidate()
    try {
      if (projectId === activeDocumentId) await renameDocument(nextName)
      else await renameCanvasProject(projectId, nextName)
    } catch {
      if (previousName) {
        setProjects((current) => current.map((project) => project.id === projectId
          ? { ...project, name: previousName }
          : project))
      }
      return false
    }
    return true
  }, [activeDocumentId, invalidate, renameDocument])

  const deleteProject = useCallback(async (projectId: string) => {
    const removedIndex = projects.findIndex((project) => project.id === projectId)
    const removedProject = removedIndex >= 0 ? projects[removedIndex] : undefined
    invalidate()
    setProjects((current) => current.filter((project) => project.id !== projectId))
    onProjectDeleted(projectId)
    try {
      await deleteCanvasDocument(projectId)
    } catch (deleteError) {
      if (removedProject) {
        setProjects((current) => {
          if (current.some((project) => project.id === projectId)) return current
          const next = [...current]
          next.splice(Math.min(removedIndex, next.length), 0, removedProject)
          return next
        })
      }
      throw deleteError
    }
    void refresh()
  }, [invalidate, onProjectDeleted, projects, refresh])

  return {
    projects,
    loading,
    error,
    refresh,
    openProject,
    createProject,
    createProjectFromTemplate,
    renameProject,
    deleteProject,
  }
}
