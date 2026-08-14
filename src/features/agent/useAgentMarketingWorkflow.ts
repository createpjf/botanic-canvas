import { useCallback, useEffect, useRef, useState } from 'react'
import type { BotanicAgentMessage } from '../../domain/agent'
import type { CanvasDocument, ProductionWorkflowRun } from '../../domain/canvas'
import {
  marketingPlanRunId,
  marketingPlanWorkflowDraft,
  marketingPlanWorkflowId,
  marketingWorkflowRunItems,
  marketingWorkflowRunProjection,
  projectFixtureAssets,
  resolveMarketingExecutionMode,
  type MarketingWorkflowRunProjection,
} from '../../domain/productionWorkflows'
import { ProductApiError } from '../../lib/productSession'
import {
  approveProductionWorkflowNode,
  publishMarketingPlanWorkflow,
  readProductionWorkflowRun,
  startProductionWorkflowRun,
  updateProductionWorkflowRun,
} from '../../lib/productionWorkflowApi'

const activeRunStatuses = new Set(['queued', 'running', 'paused', 'waiting_copy'])

export function useAgentMarketingWorkflow({
  projectId,
  messages,
  document,
  isCurrentProject,
}: {
  projectId: string
  messages: BotanicAgentMessage[]
  document: CanvasDocument
  isCurrentProject: () => boolean
}) {
  const [runs, setRuns] = useState<Record<string, ProductionWorkflowRun>>({})
  const [busyMessageId, setBusyMessageId] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const runsRef = useRef(runs)
  const documentRef = useRef(document)
  const isCurrentProjectRef = useRef(isCurrentProject)
  runsRef.current = runs
  documentRef.current = document
  isCurrentProjectRef.current = isCurrentProject
  const planMessageKey = messages.filter((message) => message.plan).map((message) => message.id).join('|')

  useEffect(() => {
    setRuns({})
    setErrors({})
    setBusyMessageId('')
  }, [projectId])

  const rememberRun = useCallback((messageId: string, run: ProductionWorkflowRun) => {
    setRuns((current) => ({ ...current, [messageId]: run }))
  }, [])

  const refreshRun = useCallback(async (messageId: string) => {
    try {
      const run = await readProductionWorkflowRun(projectId, marketingPlanRunId(messageId))
      if (!isCurrentProjectRef.current()) return undefined
      rememberRun(messageId, run)
      setErrors((current) => {
        if (!current[messageId]) return current
        const next = { ...current }
        delete next[messageId]
        return next
      })
      return run
    } catch (error) {
      if (error instanceof ProductApiError && error.status === 404) return undefined
      throw error
    }
  }, [projectId, rememberRun])

  useEffect(() => {
    let cancelled = false
    const planIds = planMessageKey ? planMessageKey.split('|') : []
    void Promise.all(planIds.map(async (messageId) => {
      try {
        const run = await readProductionWorkflowRun(projectId, marketingPlanRunId(messageId))
        if (cancelled || !isCurrentProjectRef.current()) return
        rememberRun(messageId, run)
      } catch (error) {
        if (error instanceof ProductApiError && error.status === 404) return
      }
    }))
    return () => { cancelled = true }
  }, [projectId, planMessageKey, rememberRun])

  useEffect(() => {
    const activeIds = Object.entries(runs).filter(([, run]) => {
      const projection = marketingWorkflowRunProjection(run)
      return activeRunStatuses.has(run.status) || projection?.status === 'waiting_copy' || projection?.status === 'running'
    }).map(([messageId]) => messageId)
    if (!activeIds.length) return
    const timer = window.setInterval(() => {
      void Promise.all(activeIds.map((messageId) => refreshRun(messageId).catch(() => undefined)))
    }, 3_000)
    return () => window.clearInterval(timer)
  }, [runs, refreshRun])

  const executeMarketingPlan = useCallback(async (message: BotanicAgentMessage) => {
    if (!message.plan || busyMessageId === message.id) return
    setBusyMessageId(message.id)
    setErrors((current) => ({ ...current, [message.id]: '' }))
    try {
      const canvasDocument = documentRef.current
      const draft = marketingPlanWorkflowDraft({
        messageId: message.id,
        plan: message.plan,
        document: canvasDocument,
      })
      const fixtureAssets = projectFixtureAssets(canvasDocument)
      const mode = resolveMarketingExecutionMode({
        recipe: draft.definition.recipe,
        fixtureAssets,
      })
      const workflow = await publishMarketingPlanWorkflow({
        projectId,
        id: marketingPlanWorkflowId(message.id),
        name: draft.name,
        definition: draft.definition,
      })
      const started = await startProductionWorkflowRun({
        projectId,
        workflowId: workflow.id,
        workflowVersion: workflow.currentVersion,
        id: marketingPlanRunId(message.id),
        items: marketingWorkflowRunItems({
          mode,
          copyText: message.plan.prompt,
          fixtureAssetIds: fixtureAssets.map((asset) => asset.id),
        }),
      })
      if (!isCurrentProjectRef.current()) return
      rememberRun(message.id, started.run)
    } catch (error) {
      if (!isCurrentProjectRef.current()) return
      setErrors((current) => ({
        ...current,
        [message.id]: error instanceof Error ? error.message : '营销生产链发布失败，请稍后重试。',
      }))
    } finally {
      if (isCurrentProjectRef.current()) setBusyMessageId('')
    }
  }, [busyMessageId, projectId, rememberRun])

  const approveMarketingCopy = useCallback(async (message: BotanicAgentMessage, decision: 'approved' | 'rejected') => {
    const run = runsRef.current[message.id]
    const projection = run ? marketingWorkflowRunProjection(run) : undefined
    const nodeId = projection?.nodeRuns.find((node) => node.kind === 'approval')?.nodeId
    if (!run || !nodeId || busyMessageId === message.id) return
    setBusyMessageId(message.id)
    try {
      const updated = await approveProductionWorkflowNode(projectId, run.id, { nodeId, decision })
      if (!isCurrentProjectRef.current()) return
      rememberRun(message.id, updated)
    } catch (error) {
      if (!isCurrentProjectRef.current()) return
      setErrors((current) => ({
        ...current,
        [message.id]: error instanceof Error ? error.message : '审批失败，请稍后重试。',
      }))
    } finally {
      if (isCurrentProjectRef.current()) setBusyMessageId('')
    }
  }, [busyMessageId, projectId, rememberRun])

  const resetMarketingRun = useCallback(async (message: BotanicAgentMessage) => {
    const run = runsRef.current[message.id]
    if (busyMessageId === message.id) return
    setBusyMessageId(message.id)
    try {
      if (run && !['succeeded', 'failed', 'cancelled', 'partially_failed'].includes(run.status)) {
        const updated = await updateProductionWorkflowRun(projectId, run.id, 'cancel')
        if (!isCurrentProjectRef.current()) return
        rememberRun(message.id, updated)
      } else if (run) {
        await refreshRun(message.id)
      }
    } catch (error) {
      if (!isCurrentProjectRef.current()) return
      setErrors((current) => ({
        ...current,
        [message.id]: error instanceof Error ? error.message : '取消生产运行失败，请稍后重试。',
      }))
    } finally {
      if (isCurrentProjectRef.current()) setBusyMessageId('')
    }
  }, [busyMessageId, projectId, refreshRun, rememberRun])

  const projectionFor = useCallback((messageId: string): MarketingWorkflowRunProjection | undefined => {
    const run = runs[messageId]
    return run ? marketingWorkflowRunProjection(run) : undefined
  }, [runs])

  return {
    busyMessageId,
    errors,
    projectionFor,
    executeMarketingPlan,
    approveMarketingCopy,
    resetMarketingRun,
  }
}
