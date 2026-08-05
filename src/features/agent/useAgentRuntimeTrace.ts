import { useCallback, useEffect, useState } from 'react'
import {
  createBotanicAgentRuntimeSteps,
  restoreBotanicAgentRuntimeSteps,
  updateBotanicAgentRuntimeStep,
  type BotanicAgentPlan,
  type BotanicAgentClarificationResponse,
  type BotanicAgentRun,
  type BotanicAgentRuntimePhase,
  type BotanicAgentRuntimeStep,
} from '../../domain/agent'

function yieldRuntimeFrame() {
  return new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timeoutId)
      window.cancelAnimationFrame(frameId)
      resolve()
    }
    const frameId = window.requestAnimationFrame(finish)
    const timeoutId = window.setTimeout(finish, 50)
  })
}

/** Agent 运行轨迹的创建、恢复与阶段收敛模块。 */
export function useAgentRuntimeTrace({
  latestRun,
  planning,
  hasSession,
  hasTarget,
  referenceCount,
  memoryCount,
  assetGroupCount,
  plannerLabel,
}: {
  latestRun?: BotanicAgentRun
  planning: boolean
  hasSession: boolean
  hasTarget: boolean
  referenceCount: number
  memoryCount: number
  assetGroupCount: number
  plannerLabel: string
}) {
  const [steps, setSteps] = useState<BotanicAgentRuntimeStep[]>([])
  const [phase, setPhase] = useState<BotanicAgentRuntimePhase>('idle')
  const [detailsOpen, setDetailsOpen] = useState(false)

  const updateStep = useCallback((
    stepId: string,
    status: BotanicAgentRuntimeStep['status'],
    errorMessage?: string,
  ) => {
    setSteps((current) => updateBotanicAgentRuntimeStep(current, stepId, status, Date.now(), errorMessage))
  }, [])

  const begin = useCallback((input: {
    hasTarget: boolean
    referenceCount: number
    memoryCount: number
    assetGroupCount: number
    mode?: 'generation' | 'conversation' | 'prompt' | 'research'
  }) => {
    const nextSteps = createBotanicAgentRuntimeSteps({ ...input, plannerLabel })
    const firstStep = nextSteps[0]
    const started = firstStep ? updateBotanicAgentRuntimeStep(nextSteps, firstStep.id, 'running') : nextSteps
    setSteps(started)
    setPhase('reading')
    setDetailsOpen(false)
    return started
  }, [plannerLabel])

  const attachPlannerTools = useCallback((plan?: BotanicAgentPlan | BotanicAgentClarificationResponse) => {
    const labels = plan?.toolCalls?.map((call) => call.label).filter(Boolean) ?? []
    if (!labels.length) return
    setSteps((current) => current.map((step) => step.id === 'call-planner'
      ? { ...step, detail: `已调用：${[...new Set(labels)].join('、')}` }
      : step))
  }, [])

  const completeContextReads = useCallback(async (runtimeSteps: BotanicAgentRuntimeStep[]) => {
    const contextSteps = runtimeSteps.filter((step) => !['call-planner', 'finalize-plan', 'create-workflow', 'respond'].includes(step.id))
    for (const step of contextSteps) {
      updateStep(step.id, 'running')
      await yieldRuntimeFrame()
      updateStep(step.id, 'succeeded')
    }
  }, [updateStep])

  const complete = useCallback(async (targetPresent: boolean) => {
    updateStep('call-planner', 'succeeded')
    const finalStepId = targetPresent ? 'finalize-plan' : 'create-workflow'
    updateStep(finalStepId, 'running')
    await yieldRuntimeFrame()
    updateStep(finalStepId, 'succeeded')
    setPhase('completed')
    setDetailsOpen(false)
  }, [updateStep])

  const fail = useCallback((message: string) => {
    setPhase('failed')
    setSteps((current) => {
      const active = current.find((step) => step.status === 'running')
      return active
        ? updateBotanicAgentRuntimeStep(current, active.id, 'failed', Date.now(), message)
        : current
    })
  }, [])

  useEffect(() => {
    if (!hasSession || !latestRun || planning) return
    if (phase === 'waiting_clarification' || phase === 'waiting_confirmation') return
    const active = latestRun.status === 'queued' || latestRun.status === 'running' || latestRun.status === 'executing'
    const failed = latestRun.status === 'failed' || latestRun.status === 'cancelled'
    setPhase(active ? 'executing' : failed ? 'failed' : 'completed')
    if (steps.length) return
    setSteps(restoreBotanicAgentRuntimeSteps({
      run: latestRun,
      hasTarget,
      referenceCount,
      memoryCount,
      assetGroupCount,
      plannerLabel,
    }))
    setDetailsOpen(false)
  }, [assetGroupCount, hasSession, hasTarget, latestRun, memoryCount, phase, plannerLabel, planning, referenceCount, steps.length])

  return {
    runtimeSteps: steps,
    runtimePhase: phase,
    runtimeDetailsOpen: detailsOpen,
    setRuntimePhase: setPhase,
    setRuntimeDetailsOpen: setDetailsOpen,
    beginRuntimeTrace: begin,
    updateRuntimeStep: updateStep,
    attachPlannerToolTrace: attachPlannerTools,
    yieldRuntimeFrame,
    completeRuntimeContextReads: completeContextReads,
    completeRuntimeTrace: complete,
    failRuntimeTrace: fail,
  }
}
