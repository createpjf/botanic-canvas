import { useCallback, useEffect, useRef } from 'react'
import { prepareBotanicAgentComposerSubmission, type BotanicAgentRuntimePhase } from '../../domain/agent.ts'
import type { ProductLocale } from '../../i18n/core.ts'
import type { AgentComposerState } from './agentComposerState.ts'
import {
  agentInstructionQueueSettlement,
  enqueueAgentInstruction,
  removeAgentQueuedInstruction,
  shiftAgentQueuedInstruction,
  type AgentInstructionExecutionSnapshot,
  type AgentQueuedInstruction,
} from './agentComposerQueue.ts'
import type { AgentContextItem, AgentSkillOption } from './agentWorkspace.types.ts'
import { expandAgentComposerPastes } from './agentComposerPaste.ts'

export function useAgentInstructionQueue(input: {
  state: AgentComposerState
  updateState: (patch: Partial<AgentComposerState>) => void
  mountedSkills: AgentSkillOption[]
  contextItems: AgentContextItem[]
  locale: ProductLocale
  currentSnapshot: AgentInstructionExecutionSnapshot
  planning: boolean
  runtimePhase: BotanicAgentRuntimePhase
  execute: (item: AgentQueuedInstruction) => Promise<unknown>
  applySnapshot: (item: AgentQueuedInstruction) => void
  onQueued: () => void
  onFull: () => void
}) {
  const executeRef = useRef(input.execute)
  const applySnapshotRef = useRef(input.applySnapshot)
  useEffect(() => {
    executeRef.current = input.execute
    applySnapshotRef.current = input.applySnapshot
  }, [input.applySnapshot, input.execute])
  const flushingRef = useRef(false)
  const queue = input.state.queuedInstructions

  const enqueue = useCallback(() => {
    const prepared = prepareBotanicAgentComposerSubmission({
      instruction: expandAgentComposerPastes(input.state.instruction, input.state.pendingPastes),
      mountedSkills: input.mountedSkills,
      contextItems: input.contextItems,
      locale: input.locale,
    })
    if (!prepared) return
    const result = enqueueAgentInstruction(queue, {
      id: `agent-queue-${crypto.randomUUID()}`,
      instruction: prepared.instruction,
      content: prepared.content,
      mentions: structuredClone(prepared.mentions),
      queuedAt: Date.now(),
      snapshot: {
        ...input.currentSnapshot,
        mountedSkillIds: [...input.currentSnapshot.mountedSkillIds],
        sessionContextNodeIds: [...input.currentSnapshot.sessionContextNodeIds],
        contextItems: input.currentSnapshot.contextItems.map((item) => ({ ...item })),
        generationOverrides: { ...input.currentSnapshot.generationOverrides },
      },
    })
    if (!result.accepted) { input.onFull(); return }
    input.updateState({
      queuedInstructions: result.queue,
      instruction: '',
      caret: 0,
      mentionQuery: undefined,
      dismissedMention: undefined,
      pendingGenerationOverrides: {},
      pendingPastes: {},
      error: '',
    })
    input.onQueued()
  }, [input, queue])

  const remove = useCallback((id: string) => {
    input.updateState({ queuedInstructions: removeAgentQueuedInstruction(queue, id) })
  }, [input, queue])

  const restore = useCallback((item: AgentQueuedInstruction) => {
    input.updateState({
      queuedInstructions: removeAgentQueuedInstruction(queue, item.id),
      instruction: item.content,
      caret: item.content.length,
      mentionQuery: undefined,
      dismissedMention: undefined,
      pendingGenerationOverrides: { ...item.snapshot.generationOverrides },
      pendingPastes: {},
      error: '',
    })
    input.applySnapshot(item)
  }, [input, queue])

  useEffect(() => {
    if (flushingRef.current) return
    const settlement = agentInstructionQueueSettlement({
      queueLength: queue.length, planning: input.planning,
      runtimePhase: input.runtimePhase, instruction: input.state.instruction,
    })
    if (settlement === 'wait') return
    const { item, queue: rest } = shiftAgentQueuedInstruction(queue)
    if (!item) return
    if (settlement === 'execute') {
      flushingRef.current = true
      input.updateState({ queuedInstructions: rest })
      void executeRef.current(item).finally(() => { flushingRef.current = false })
      return
    }
    input.updateState({ queuedInstructions: rest, instruction: item.content, caret: item.content.length, pendingPastes: {} })
    applySnapshotRef.current(item)
  }, [input.planning, input.runtimePhase, input.state.instruction, input.updateState, queue])

  return { queue, enqueue, remove, restore }
}
