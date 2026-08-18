import { useCallback, useEffect, useState } from 'react'
import {
  appendBotanicAgentReasoningDelta,
  createBotanicAgentRuntimeSteps,
  insertBotanicAgentReasoningSteps,
  insertBotanicAgentToolCallSteps,
  restoreBotanicAgentRuntimeSteps,
  shouldRestoreBotanicAgentRuntimeSteps,
  updateBotanicAgentRuntimeStep,
  type BotanicAgentPlan,
  type BotanicAgentClarificationResponse,
  type BotanicAgentReasoningEntry,
  type BotanicAgentRun,
  type BotanicAgentRuntimeMode,
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
  const [mode, setMode] = useState<BotanicAgentRuntimeMode>('generation')
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
    mode?: BotanicAgentRuntimeMode
  }) => {
    const nextSteps = createBotanicAgentRuntimeSteps({ ...input, plannerLabel })
    const firstStep = nextSteps[0]
    const started = firstStep ? updateBotanicAgentRuntimeStep(nextSteps, firstStep.id, 'running') : nextSteps
    setSteps(started)
    setMode(input.mode ?? 'generation')
    setPhase('reading')
    setDetailsOpen(false)
    return started
  }, [plannerLabel])

  /** 切换会话时丢弃上一轮的运行轨迹，避免旧内容跟着新会话留在面板底部。 */
  const reset = useCallback(() => {
    setSteps([])
    setMode('generation')
    setPhase('idle')
    setDetailsOpen(false)
  }, [])

  // 服务端真实回传的工具调用展开成独立步骤，而不是压成规划步骤下的一行说明。
  const attachPlannerTools = useCallback((plan?: BotanicAgentPlan | BotanicAgentClarificationResponse) => {
    const toolCalls = plan?.toolCalls ?? []
    if (!toolCalls.length) return
    setSteps((current) => insertBotanicAgentToolCallSteps(current, toolCalls))
  }, [])

  /** 当轮运行说明只活在组件状态里，轮次结束随轨迹一起消失。 */
  const attachReasoning = useCallback((entries?: BotanicAgentReasoningEntry[]) => {
    if (!entries?.length) return
    setSteps((current) => insertBotanicAgentReasoningSteps(current, entries))
  }, [])

  /** 流式推理增量；收到最终片段时会被 attachReasoning 替换掉。 */
  const appendReasoningDelta = useCallback((step: number, delta: string) => {
    if (!delta) return
    setSteps((current) => appendBotanicAgentReasoningDelta(current, step, delta))
  }, [])

  const updateStepDetail = useCallback((stepId: string, detail: string) => {
    setSteps((current) => current.map((step) => step.id === stepId ? { ...step, detail } : step))
  }, [])

  /**
   * 上下文（画布节点、参考、项目记忆、素材组）本来就在内存里，读取是同步且瞬时的。
   * 这里一次性标记完成——此前逐条播 rAF 动画，会让人误以为后台正在做耗时工作，
   * 也把真实的模型调用淹没在假进度里。轨迹只应反映真实发生的事。
   */
  const completeContextReads = useCallback(async (runtimeSteps: BotanicAgentRuntimeStep[]) => {
    const contextStepIds = new Set(runtimeSteps
      .filter((step) => !['call-planner', 'finalize-plan', 'create-workflow', 'respond'].includes(step.id))
      .map((step) => step.id))
    if (!contextStepIds.size) return
    setSteps((current) => current.map((step) => contextStepIds.has(step.id)
      ? { ...step, status: 'succeeded', completedAt: Date.now() }
      : step))
  }, [])

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
    if (phase === 'waiting_clarification' || phase === 'waiting_confirmation' || phase === 'waiting_reference' || phase === 'draft_ready') return
    const active = latestRun.status === 'queued' || latestRun.status === 'running' || latestRun.status === 'executing'
    const failed = latestRun.status === 'failed' || latestRun.status === 'cancelled'
    setPhase(active ? 'executing' : failed ? 'failed' : 'completed')
    if (steps.length) return
    // 已结束的 Run 由对话内的状态消息承载，不再在面板底部重放一份历史步骤。
    if (!shouldRestoreBotanicAgentRuntimeSteps(latestRun.status)) return
    setMode('generation')
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
    runtimeMode: mode,
    runtimeDetailsOpen: detailsOpen,
    setRuntimePhase: setPhase,
    setRuntimeDetailsOpen: setDetailsOpen,
    beginRuntimeTrace: begin,
    resetRuntimeTrace: reset,
    updateRuntimeStep: updateStep,
    attachPlannerToolTrace: attachPlannerTools,
    attachRuntimeReasoning: attachReasoning,
    appendRuntimeReasoningDelta: appendReasoningDelta,
    updateRuntimeStepDetail: updateStepDetail,
    yieldRuntimeFrame,
    completeRuntimeContextReads: completeContextReads,
    completeRuntimeTrace: complete,
    failRuntimeTrace: fail,
  }
}
