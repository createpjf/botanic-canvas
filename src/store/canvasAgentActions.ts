import {
  appendBotanicAgentMessage,
  createBotanicAgentMemoryItem,
  createBotanicAgentRun,
  createBotanicAgentSession,
  replaceBotanicAgentSessionContext,
  updateBotanicAgentAction,
  updateBotanicAgentMessage,
  updateBotanicAgentRun,
  upsertBotanicAgentRunSnapshot,
} from '../domain/agent'
import type { CanvasDocument, ResultNodeData } from '../domain/canvas'
import { cancelPersistentBotanicAgentRun, retryPersistentBotanicAgentBranch } from '../lib/agentApi'
import type { CanvasStore } from './canvasStore.types'

type AgentStoreActions = Pick<CanvasStore,
  | 'saveAgentPlan'
  | 'applyAgentRunSnapshot'
  | 'retryAgentBranch'
  | 'cancelAgentRun'
  | 'updateAgentRunStatus'
  | 'ensureAgentSession'
  | 'startNewAgentSession'
  | 'appendAgentMessage'
  | 'updateAgentMessage'
  | 'updateAgentAction'
  | 'setAgentSessionContext'
  | 'setAgentSessionExecutionMode'
  | 'setActiveAgentSession'
  | 'addAgentMemory'
  | 'removeAgentMemory'
>

type CommitDocument = (
  document: CanvasDocument,
  extra?: Partial<CanvasStore>,
  options?: { immediate?: boolean; rejectOnFailure?: boolean },
) => Promise<void>

/**
 * CanvasStore 内的 Agent 实体命令模块。
 * Session、Message、Memory 与 Run 的兼容双写都经同一个提交端口完成。
 */
export function createCanvasAgentActions({
  set,
  get,
  commitDocument,
}: {
  set: (next: Partial<CanvasStore>) => void
  get: () => CanvasStore
  commitDocument: CommitDocument
}): AgentStoreActions {
  return {
    saveAgentPlan: (plan, options) => {
      const currentDocument = get().document
      const existingRun = options?.id ? currentDocument.agentRuns.find((run) => run.id === options.id) : undefined
      if (existingRun) return existingRun.id
      const run = createBotanicAgentRun(plan, options)
      void commitDocument({ ...currentDocument, agentRuns: [run, ...currentDocument.agentRuns] }, {
        assistantMessage: plan.summary,
      })
      return run.id
    },

    applyAgentRunSnapshot: (snapshot) => {
      const document = get().document
      const sourceResult = snapshot.plan ? document.nodes.find((node) => node.id === snapshot.plan?.selectedResultNodeId && node.type === 'result') : undefined
      const sourceData = sourceResult?.data as ResultNodeData | undefined
      const rootRecipe = sourceData?.rootRecipe ?? sourceData?.generationRecipe
      const agentRuns = upsertBotanicAgentRunSnapshot(document.agentRuns, snapshot, rootRecipe)
      if (agentRuns === document.agentRuns) return
      void commitDocument({ ...document, agentRuns }, {}, { immediate: true })
    },

    retryAgentBranch: async (runId, branchId) => {
      const projectId = get().document.id
      try {
        const run = get().document.agentRuns.find((candidate) => candidate.id === runId)
        const branch = run?.branches.find((candidate) => candidate.id === branchId)
        const retryKey = `agent-retry-${runId}-${branchId}-attempt-${(branch?.attempt ?? 0) + 1}`
        const snapshot = await retryPersistentBotanicAgentBranch(runId, branchId, retryKey)
        if (get().document.id !== projectId) return true
        get().applyAgentRunSnapshot(snapshot)
        await get().refreshDocumentFromRemote().catch(() => false)
        return true
      } catch (caught) {
        if (get().document.id === projectId) set({ assistantMessage: caught instanceof Error ? caught.message : '分支重试失败，请稍后重试。' })
        return false
      }
    },

    cancelAgentRun: async (runId) => {
      const projectId = get().document.id
      try {
        const snapshot = await cancelPersistentBotanicAgentRun(runId)
        if (get().document.id !== projectId) return true
        get().applyAgentRunSnapshot(snapshot)
        await get().refreshDocumentFromRemote().catch(() => false)
        return true
      } catch (caught) {
        if (get().document.id === projectId) set({ assistantMessage: caught instanceof Error ? caught.message : '任务取消失败，请稍后重试。' })
        return false
      }
    },

    updateAgentRunStatus: (runId, status, error) => {
      const document = get().document
      if (!document.agentRuns.some((run) => run.id === runId)) return
      void commitDocument({
        ...document,
        agentRuns: document.agentRuns.map((run) => run.id === runId
          ? updateBotanicAgentRun(run, status, undefined, error)
          : run),
      })
    },

    ensureAgentSession: (contextNodeIds = []) => {
      const document = get().document
      const active = document.agentSessions.find((session) => session.id === document.activeAgentSessionId)
      if (active) return active.id
      return get().startNewAgentSession(contextNodeIds)
    },

    startNewAgentSession: (contextNodeIds = []) => {
      const document = get().document
      const session = createBotanicAgentSession({
        id: `agent-session-${crypto.randomUUID()}`,
        contextNodeIds,
      })
      void commitDocument({
        ...document,
        agentSessions: [session, ...document.agentSessions],
        activeAgentSessionId: session.id,
      })
      return session.id
    },

    appendAgentMessage: (sessionId, message) => {
      const document = get().document
      const session = document.agentSessions.find((item) => item.id === sessionId)
      if (!session || session.messages.some((item) => item.id === message.id)) return
      void commitDocument({
        ...document,
        agentSessions: document.agentSessions.map((candidate) => candidate.id === sessionId
          ? appendBotanicAgentMessage(candidate, message)
          : candidate),
        activeAgentSessionId: sessionId,
      })
    },

    updateAgentMessage: (sessionId, messageId, patch) => {
      const document = get().document
      if (!document.agentSessions.some((session) => session.id === sessionId)) return
      void commitDocument({
        ...document,
        agentSessions: document.agentSessions.map((session) => session.id === sessionId
          ? updateBotanicAgentMessage(session, messageId, patch)
          : session),
        activeAgentSessionId: sessionId,
      })
    },

    updateAgentAction: (sessionId, messageId, actionId, patch) => {
      const document = get().document
      if (!document.agentSessions.some((session) => session.id === sessionId)) return
      void commitDocument({
        ...document,
        agentSessions: document.agentSessions.map((session) => session.id === sessionId
          ? updateBotanicAgentAction(session, messageId, actionId, patch)
          : session),
        activeAgentSessionId: sessionId,
      })
    },

    setAgentSessionContext: (sessionId, contextNodeIds) => {
      const document = get().document
      if (!document.agentSessions.some((session) => session.id === sessionId)) return
      void commitDocument({
        ...document,
        agentSessions: document.agentSessions.map((session) => session.id === sessionId
          ? replaceBotanicAgentSessionContext(session, contextNodeIds)
          : session),
        activeAgentSessionId: sessionId,
      })
    },

    setAgentSessionExecutionMode: (sessionId, mode) => {
      const document = get().document
      if (!document.agentSessions.some((session) => session.id === sessionId)) return
      void commitDocument({
        ...document,
        agentSessions: document.agentSessions.map((session) => session.id === sessionId
          ? { ...session, executionMode: mode, updatedAt: Date.now() }
          : session),
        activeAgentSessionId: sessionId,
      })
    },

    setActiveAgentSession: (sessionId) => {
      const document = get().document
      if (!document.agentSessions.some((session) => session.id === sessionId)) return
      void commitDocument({ ...document, activeAgentSessionId: sessionId })
    },

    addAgentMemory: (kind, content, sourceNodeIds = []) => {
      const document = get().document
      let memory
      try {
        memory = createBotanicAgentMemoryItem({ kind, content, sourceNodeIds })
      } catch (caught) {
        set({ assistantMessage: caught instanceof Error ? caught.message : '项目记忆无法保存。' })
        return null
      }
      const duplicate = document.agentMemory.find((item) => item.kind === memory.kind && item.content === memory.content)
      if (duplicate) return duplicate.id
      void commitDocument({ ...document, agentMemory: [memory, ...document.agentMemory].slice(0, 30) })
      return memory.id
    },

    removeAgentMemory: (memoryId) => {
      const document = get().document
      if (!document.agentMemory.some((memory) => memory.id === memoryId)) return
      void commitDocument({ ...document, agentMemory: document.agentMemory.filter((memory) => memory.id !== memoryId) })
    },
  }
}
