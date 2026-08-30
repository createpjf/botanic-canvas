import {
  appendBotanicAgentMessage,
  createBotanicAgentMemoryItem,
  createBotanicAgentRun,
  createBotanicAgentSession,
  renameBotanicAgentSession,
  replaceBotanicAgentSessionSkills,
  replaceBotanicAgentSessionContext,
  updateBotanicAgentSessionPlannerModel,
  updateBotanicAgentSessionReadingAnchor,
  updateBotanicAgentAction,
  updateBotanicAgentMessage,
  upsertBotanicAgentMessage,
  updateBotanicAgentRun,
  upsertBotanicAgentRunSnapshot,
  mergeBotanicAgentCanvasPatch,
} from '../domain/agent.ts'
import type { BotanicAgentRunSnapshot, BotanicAgentSession } from '../domain/agent.ts'
import type { CanvasDocument, ResultNodeData } from '../domain/canvas.ts'
import type { CanvasStore } from './canvasStore.types.ts'

type AgentStoreActions = Pick<CanvasStore,
  | 'saveAgentPlan'
  | 'applyAgentRunSnapshot'
  | 'applyAgentWorkflowPatch'
  | 'retryAgentBranch'
  | 'cancelAgentRun'
  | 'updateAgentRunStatus'
  | 'ensureAgentSession'
  | 'startNewAgentSession'
  | 'appendAgentMessage'
  | 'upsertAgentMessage'
  | 'updateAgentMessage'
  | 'updateAgentAction'
  | 'setAgentSessionContext'
  | 'setAgentSessionExecutionMode'
  | 'waiveAgentSessionConfirmation'
  | 'setAgentSessionPlannerModel'
  | 'setAgentSessionSkills'
  | 'renameAgentSession'
  | 'setAgentSessionReadingAnchor'
  | 'setActiveAgentSession'
  | 'addAgentMemory'
  | 'removeAgentMemory'
>

type CommitDocument = (
  document: CanvasDocument,
  extra?: Partial<CanvasStore>,
  options?: { immediate?: boolean; rejectOnFailure?: boolean },
) => Promise<void>

type PersistentAgentRunApi = {
  retryBranch: (runId: string, branchId: string, idempotencyKey: string) => Promise<BotanicAgentRunSnapshot>
  cancelRun: (runId: string) => Promise<BotanicAgentRunSnapshot>
}

type PersistAgentSession = (projectId: string, session: BotanicAgentSession) => Promise<BotanicAgentSession | undefined>

/**
 * CanvasStore 内的 Agent 实体命令模块。
 * Session、Message、Memory 与 Run 的兼容双写都经同一个提交端口完成。
 */
export function createCanvasAgentActions({
  set,
  get,
  commitDocument,
  persistentAgentRunApi,
  persistAcknowledgedRemotePatch,
  persistAgentSession = async () => undefined,
}: {
  set: (next: Partial<CanvasStore>) => void
  get: () => CanvasStore
  commitDocument: CommitDocument
  persistentAgentRunApi: PersistentAgentRunApi
  persistAcknowledgedRemotePatch: (document: CanvasDocument, revision: number, graphRevision: number) => Promise<void>
  persistAgentSession?: PersistAgentSession
}): AgentStoreActions {
  const commitAgentSessionDocument = (document: CanvasDocument, options: { persistSession?: boolean } = {}) => {
    // Session 创建后的首条消息/上下文可能与持久化同一帧发生；
    // 先更新本地权威快照，后续命令才能稳定命中同一 Session。
    set({ document })
    void commitDocument(document)
    if (!options.persistSession) return
    const session = document.agentSessions.find((item) => item.id === document.activeAgentSessionId)
    if (session) void persistAgentSession(document.id, session).catch((caught) => {
      if (get().document.id !== document.id) return
      const source = caught as { code?: string; message?: string } | undefined
      set({ assistantMessage: source?.message || 'Agent 会话设置同步失败，请刷新后重试。' })
      if (source?.code === 'AGENT_SESSION_REVISION_CONFLICT') {
        void get().refreshDocumentFromRemote().catch(() => false)
      }
    })
  }

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

    applyAgentWorkflowPatch: async (patch) => {
      const document = get().document
      const nextDocument = mergeBotanicAgentCanvasPatch(document, patch)
      set({ document: nextDocument })
      void persistAcknowledgedRemotePatch(nextDocument, patch.revision, patch.graphRevision).catch(() => {
        // 服务端工作流已经落盘；本机缓存失败不能阻断真实生成任务。
      })
      return true
    },

    retryAgentBranch: async (runId, branchId) => {
      const projectId = get().document.id
      try {
        const run = get().document.agentRuns.find((candidate) => candidate.id === runId)
        const branch = run?.branches.find((candidate) => candidate.id === branchId)
        const retryKey = `agent-retry-${runId}-${branchId}-attempt-${(branch?.attempt ?? 0) + 1}`
        const snapshot = await persistentAgentRunApi.retryBranch(runId, branchId, retryKey)
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
        const snapshot = await persistentAgentRunApi.cancelRun(runId)
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
      commitAgentSessionDocument({
        ...document,
        agentSessions: [session, ...document.agentSessions],
        activeAgentSessionId: session.id,
      }, { persistSession: true })
      return session.id
    },

    appendAgentMessage: (sessionId, message) => {
      const document = get().document
      const session = document.agentSessions.find((item) => item.id === sessionId)
      if (!session || session.messages.some((item) => item.id === message.id)) return
      commitAgentSessionDocument({
        ...document,
        agentSessions: document.agentSessions.map((candidate) => candidate.id === sessionId
          ? appendBotanicAgentMessage(candidate, message)
          : candidate),
        activeAgentSessionId: sessionId,
      })
    },

    upsertAgentMessage: (sessionId, message) => {
      const document = get().document
      const session = document.agentSessions.find((item) => item.id === sessionId)
      if (!session) return
      commitAgentSessionDocument({
        ...document,
        agentSessions: document.agentSessions.map((candidate) => candidate.id === sessionId
          ? upsertBotanicAgentMessage(candidate, message)
          : candidate),
        activeAgentSessionId: sessionId,
      })
    },

    updateAgentMessage: (sessionId, messageId, patch) => {
      const document = get().document
      if (!document.agentSessions.some((session) => session.id === sessionId)) return
      commitAgentSessionDocument({
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
      commitAgentSessionDocument({
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
      commitAgentSessionDocument({
        ...document,
        agentSessions: document.agentSessions.map((session) => session.id === sessionId
          ? replaceBotanicAgentSessionContext(session, contextNodeIds)
          : session),
        activeAgentSessionId: sessionId,
      }, { persistSession: true })
    },

    setAgentSessionExecutionMode: (sessionId, mode) => {
      const document = get().document
      if (!document.agentSessions.some((session) => session.id === sessionId)) return
      commitAgentSessionDocument({
        ...document,
        agentSessions: document.agentSessions.map((session) => session.id === sessionId
          ? {
            ...session,
            executionMode: mode,
            // 切回计划模式是「以后先给我看计划」的明确表态；留着 manual 豁免会让这个开关失效。
            ...(mode === 'manual' && session.confirmationWaivers?.length
              ? { confirmationWaivers: session.confirmationWaivers.filter((waiver) => waiver !== 'manual') }
              : {}),
            updatedAt: Date.now(),
          }
          : session),
        activeAgentSessionId: sessionId,
      }, { persistSession: true })
    },

    /** 用户在计划卡上交出某一类确认。只增不减，撤销走执行模式开关。 */
    waiveAgentSessionConfirmation: (sessionId, waiver) => {
      const document = get().document
      const session = document.agentSessions.find((item) => item.id === sessionId)
      if (!session || session.confirmationWaivers?.includes(waiver)) return
      commitAgentSessionDocument({
        ...document,
        agentSessions: document.agentSessions.map((item) => item.id === sessionId
          ? { ...item, confirmationWaivers: [...(item.confirmationWaivers ?? []), waiver], updatedAt: Date.now() }
          : item),
        activeAgentSessionId: sessionId,
      }, { persistSession: true })
    },

    setAgentSessionPlannerModel: (sessionId, plannerModel) => {
      const document = get().document
      const session = document.agentSessions.find((candidate) => candidate.id === sessionId)
      if (!session) return
      const updatedSession = updateBotanicAgentSessionPlannerModel(session, plannerModel)
      if (updatedSession === session) return
      commitAgentSessionDocument({
        ...document,
        agentSessions: document.agentSessions.map((candidate) => candidate.id === sessionId ? updatedSession : candidate),
        activeAgentSessionId: sessionId,
      }, { persistSession: true })
    },

    setAgentSessionSkills: (sessionId, mountedSkillIds) => {
      const document = get().document
      const session = document.agentSessions.find((candidate) => candidate.id === sessionId)
      if (!session) return
      const updatedSession = replaceBotanicAgentSessionSkills(session, mountedSkillIds)
      if (updatedSession === session) return
      commitAgentSessionDocument({
        ...document,
        agentSessions: document.agentSessions.map((candidate) => candidate.id === sessionId ? updatedSession : candidate),
        activeAgentSessionId: sessionId,
      }, { persistSession: true })
    },

    renameAgentSession: (sessionId, title) => {
      const document = get().document
      const session = document.agentSessions.find((candidate) => candidate.id === sessionId)
      if (!session) return
      const updatedSession = renameBotanicAgentSession(session, title)
      if (updatedSession === session) return
      commitAgentSessionDocument({
        ...document,
        agentSessions: document.agentSessions.map((candidate) => candidate.id === sessionId ? updatedSession : candidate),
        activeAgentSessionId: sessionId,
      }, { persistSession: true })
    },

    setAgentSessionReadingAnchor: (sessionId, messageId, updatedAt = Date.now()) => {
      const document = get().document
      const session = document.agentSessions.find((candidate) => candidate.id === sessionId)
      if (!session) return
      const updatedSession = updateBotanicAgentSessionReadingAnchor(session, messageId, updatedAt)
      if (updatedSession === session) return
      // 阅读位置由独立 Session 资源持久化；这里仅更新本地视图，避免滚动触发整份画布写入。
      set({
        document: {
          ...document,
          agentSessions: document.agentSessions.map((candidate) => candidate.id === sessionId ? updatedSession : candidate),
        },
      })
    },

    setActiveAgentSession: (sessionId) => {
      const document = get().document
      if (!document.agentSessions.some((session) => session.id === sessionId)) return
      commitAgentSessionDocument({ ...document, activeAgentSessionId: sessionId })
    },

    addAgentMemory: (kind, content, sourceNodeIds = [], options = {}) => {
      const document = get().document
      let memory
      try {
        memory = createBotanicAgentMemoryItem({ kind, content, sourceNodeIds, ...options })
      } catch (caught) {
        set({ assistantMessage: caught instanceof Error ? caught.message : '项目记忆无法保存。' })
        return null
      }
      // 同内容但适用范围不同不是重复：「天猫留白 20%」与「京东留白 20%」是两条规则。
      const duplicate = document.agentMemory.find((item) => item.kind === memory.kind
        && item.content === memory.content
        && (item.subject ?? 'project') === (memory.subject ?? 'project')
        && (item.subjectValue ?? '') === (memory.subjectValue ?? ''))
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
