import { useCallback, useEffect, useMemo, useState } from 'react'
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
import { localizeProductError, type ProductLocale } from '../../i18n/core'
import { useProductI18n } from '../../i18n/react'

const runtimeErrorCopy = {
  'zh-CN': '运行步骤未完成，请重试。',
  en: 'This step could not be completed. Try again.',
} as const

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`
}

function localizeRuntimeError(message: string | undefined, locale: ProductLocale) {
  if (!message?.trim()) return message
  if (locale === 'zh-CN' || !/\p{Script=Han}/u.test(message)) return message
  if (message === '任务已取消。') return 'Task canceled.'
  if (message === '任务未完成，请查看任务面板。') return 'Task did not complete. Review the task panel.'
  return localizeProductError({ message }, locale, runtimeErrorCopy)
}

function localizeRuntimeSteps({
  steps,
  locale,
  mode,
  hasTarget,
  referenceCount,
  memoryCount,
  assetGroupCount,
  plannerLabel,
}: {
  steps: BotanicAgentRuntimeStep[]
  locale: ProductLocale
  mode: BotanicAgentRuntimeMode
  hasTarget: boolean
  referenceCount: number
  memoryCount: number
  assetGroupCount: number
  plannerLabel: string
}) {
  if (locale === 'zh-CN') return steps
  return steps.map((step) => {
    const restored = step.detail.endsWith(' · 已从服务端恢复')
    let label = step.label
    let detail = step.detail
    if (step.id === 'read-canvas') {
      label = 'Read canvas context'
      detail = mode === 'research'
        ? 'Read verifiable project sources'
        : hasTarget ? 'Current result, generation settings, and node relationships' : 'Current canvas and available nodes'
    } else if (step.id === 'read-references') {
      label = 'Read references'
      detail = countLabel(referenceCount, 'connected reference')
    } else if (step.id === 'read-memory') {
      label = 'Read project memory'
      detail = countLabel(memoryCount, 'saved rule')
    } else if (step.id === 'search-assets') {
      label = 'Search asset groups'
      detail = countLabel(assetGroupCount, 'available asset group')
    } else if (step.id === 'call-planner') {
      label = hasTarget ? 'Call planning model' : 'Interpret creative request'
      detail = mode === 'conversation'
        ? 'Understand the request and conversation context'
        : mode === 'prompt'
          ? 'Prepare a ready-to-use prompt'
          : mode === 'research'
            ? 'Search project sources and verify references'
            : hasTarget
              ? (plannerLabel ? `${plannerLabel} · Build an execution plan` : 'Build an execution plan')
              : 'Organize the creative request and node relationships'
    } else if (step.id === 'finalize-plan') {
      label = 'Prepare execution plan'
      detail = 'Define fixed elements, variations, and output branches'
    } else if (step.id === 'create-workflow') {
      label = 'Create canvas workflow'
      detail = 'Write the request into editable nodes'
    } else if (step.id === 'respond') {
      label = mode === 'research' ? 'Prepare research results' : mode === 'prompt' ? 'Create prompt draft' : 'Prepare response'
      detail = mode === 'research' ? 'Separate project facts, inferences, and sources' : 'Prepare a clear next response'
    } else if (step.id.startsWith('reasoning:')) {
      label = 'Model activity'
    } else if (step.id.startsWith('tool:')) {
      detail = detail
        .replace(/ · 读取项目数据$/, ' · Read project data')
        .replace(/ · 调用外部工具$/, ' · Use external tool')
        .replace(/ · 会产生生成费用$/, ' · Uses generation credits')
        .replace(/ · 写入项目数据$/, ' · Write project data')
    }

    if (step.id === 'finalize-plan' || step.id === 'create-workflow') {
      if (step.detail === '任务已恢复，正在等待生成结果') detail = 'Task restored. Waiting for generation results.'
      else if (step.detail === '任务已结束，可查看失败原因或重试') detail = 'Task ended. Review the failure or retry.'
      else if (step.detail === '任务已完成，结果已回填画布' || step.detail === '任务已完成，结果已放到画布') detail = 'Task completed. Results were added to the canvas.'
    } else if (restored) {
      detail = `${detail} · Restored from the server`
    }

    return { ...step, label, detail, ...(step.error ? { error: localizeRuntimeError(step.error, locale) } : {}) }
  })
}

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
  const { locale } = useProductI18n()
  const [steps, setSteps] = useState<BotanicAgentRuntimeStep[]>([])
  const [phase, setPhase] = useState<BotanicAgentRuntimePhase>('idle')
  const [mode, setMode] = useState<BotanicAgentRuntimeMode>('generation')
  const [detailsOpen, setDetailsOpen] = useState(false)

  const updateStep = useCallback((
    stepId: string,
    status: BotanicAgentRuntimeStep['status'],
    errorMessage?: string,
  ) => {
    setSteps((current) => updateBotanicAgentRuntimeStep(current, stepId, status, Date.now(), localizeRuntimeError(errorMessage, locale)))
  }, [locale])

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
    const localizedMessage = localizeRuntimeError(message, locale) ?? runtimeErrorCopy[locale]
    setPhase('failed')
    setSteps((current) => {
      const active = current.find((step) => step.status === 'running')
      return active
        ? updateBotanicAgentRuntimeStep(current, active.id, 'failed', Date.now(), localizedMessage)
        : current
    })
  }, [locale])

  useEffect(() => {
    if (!hasSession || !latestRun || planning) return
    if (phase === 'waiting_clarification' || phase === 'waiting_confirmation' || phase === 'waiting_reference' || phase === 'draft_ready') return
    const active = latestRun.status === 'queued' || latestRun.status === 'running' || latestRun.status === 'executing'
    const failed = latestRun.status === 'failed' || latestRun.status === 'cancelled'
    setPhase(active ? 'executing' : failed ? 'failed' : 'completed')
    if (steps.length) {
      if (phase === 'executing' && !shouldRestoreBotanicAgentRuntimeSteps(latestRun.status)) {
        setSteps([])
        setDetailsOpen(false)
      }
      return
    }
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

  const localizedSteps = useMemo(() => localizeRuntimeSteps({
    steps,
    locale,
    mode,
    hasTarget,
    referenceCount,
    memoryCount,
    assetGroupCount,
    plannerLabel,
  }), [assetGroupCount, hasTarget, locale, memoryCount, mode, plannerLabel, referenceCount, steps])

  return {
    runtimeSteps: localizedSteps,
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
