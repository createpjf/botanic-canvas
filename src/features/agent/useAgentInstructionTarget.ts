import { useEffect, useRef, useState } from 'react'
import { resolveBotanicAgentContinuationTarget } from '../../domain/agentTurnObservation'
import { resolveAgentInstructionExecutionContext } from './agentComposerQueue'
import type { AgentDockTarget } from './agentWorkspace.types'

/** 原目标预检还没有 Turn 身份；Stop 只取消这次只读预检，不能误取消上一轮。 */
export function useAgentInstructionTarget(input: {
  projectId: string
  sessionId?: string
  isCurrentProject: () => boolean
  resolveTarget: (nodeId: string, signal?: AbortSignal) => AgentDockTarget | undefined | Promise<AgentDockTarget | undefined>
}) {
  const scope = JSON.stringify([input.projectId, input.sessionId])
  const activeScope = useRef(scope); activeScope.current = scope
  const pending = useRef<AbortController | null>(null)
  const [pendingScope, setPendingScope] = useState('')
  const cancel = () => {
    pending.current?.abort()
    pending.current = null
    setPendingScope('')
  }
  useEffect(() => () => { pending.current?.abort(); pending.current = null }, [scope])
  const prepare = async (
    context: Omit<Parameters<typeof resolveAgentInstructionExecutionContext>[0], 'resolveTarget'>,
    onFailure: (caught: unknown) => void,
  ) => {
    if (pending.current || !input.isCurrentProject()) return undefined
    const controller = new AbortController()
    const current = () => !controller.signal.aborted && activeScope.current === scope && input.isCurrentProject()
    pending.current = controller
    setPendingScope(scope)
    try {
      const result = await resolveAgentInstructionExecutionContext({
        ...context,
        resolveTarget: (nodeId) => resolveBotanicAgentContinuationTarget(nodeId, input.resolveTarget, controller.signal),
      })
      return current() ? result : undefined
    } catch (caught) {
      if (current()) onFailure(caught)
      return undefined
    } finally {
      if (pending.current === controller) { pending.current = null; setPendingScope('') }
    }
  }
  return { prepare, cancel, busy: pendingScope === scope }
}
