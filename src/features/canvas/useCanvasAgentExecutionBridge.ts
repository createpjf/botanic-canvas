import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  collectBotanicAgentResults,
  mergeBotanicAgentArtifactIndex,
  recordBotanicAgentCanvasWritebacks,
  resolveBotanicAgentWorkflowReferenceNodeIds,
  resolveBotanicAgentCanvasCommands,
  type BotanicAgentActionProposal,
  type BotanicAgentActionResult,
  type BotanicAgentArtifact,
  type BotanicAgentCanvasWriteback,
  type BotanicAgentPlan,
} from '../../domain/agent'
import { collectAgentMediaSources, prepareAgentMediaSources } from '../../domain/agentMedia'
import {
  type AssetNodeData,
  type CanvasDocument,
  type GenerateNodeData,
  type ResultNodeData,
  type TextNodeData,
  type UploadedAssetInput,
} from '../../domain/canvas'
import { canUseForImageDelivery } from '../../domain/deliveryPresentation'
import {
  createPersistentBotanicAgentRun,
  executePersistentBotanicAgentRun,
  executeProjectAgentAction,
  listProjectAgentArtifacts,
  persistAgentReferenceMedia,
  submitPersistentBotanicAgentReadingAnchor,
} from '../../lib/agentApi'
import { flushPendingCanvasDocumentWrites } from '../../lib/db'
import { serverPersistenceEnabled } from '../../lib/productSession'
import { useCanvasStore } from '../../store/canvasStore'
import type { AgentArtifactIndexState, AgentContextItem, AgentDockTarget } from '../agent/agentWorkspace.types'

type UseCanvasAgentExecutionBridgeOptions = {
  document: CanvasDocument
  agentOpen: boolean
  selectedFocusNodeIds: string[]
  selectedReadyResultId?: string
  onPrepareAgentOpen: () => void
  onPrepareCanvasFocus: () => void
}

/**
 * Owns the Agent-to-canvas execution boundary: context projection, run persistence,
 * artifact paging and command writeback. The workspace only coordinates surfaces.
 */
export function useCanvasAgentExecutionBridge({
  document,
  agentOpen,
  selectedFocusNodeIds,
  selectedReadyResultId,
  onPrepareAgentOpen,
  onPrepareCanvasFocus,
}: UseCanvasAgentExecutionBridgeOptions) {
  const updateGenerateNode = useCanvasStore((state) => state.updateGenerateNode)
  const runGraphGeneration = useCanvasStore((state) => state.runGraphGeneration)
  const runBatchVariation = useCanvasStore((state) => state.runBatchVariation)
  const addUploadedAssetsToCanvas = useCanvasStore((state) => state.addUploadedAssetsToCanvas)
  const addTextNode = useCanvasStore((state) => state.addTextNode)
  const updateTextNode = useCanvasStore((state) => state.updateTextNode)
  const renameCanvasNode = useCanvasStore((state) => state.renameCanvasNode)
  const replaceMediaSources = useCanvasStore((state) => state.replaceMediaSources)
  const refreshDocumentFromRemote = useCanvasStore((state) => state.refreshDocumentFromRemote)
  const saveGeneratedImageToLibrary = useCanvasStore((state) => state.saveGeneratedImageToLibrary)
  const ensureAgentSession = useCanvasStore((state) => state.ensureAgentSession)
  const startNewAgentSession = useCanvasStore((state) => state.startNewAgentSession)
  const setActiveAgentSession = useCanvasStore((state) => state.setActiveAgentSession)
  const setAgentSessionContext = useCanvasStore((state) => state.setAgentSessionContext)
  const setAgentSessionReadingAnchor = useCanvasStore((state) => state.setAgentSessionReadingAnchor)
  const saveAgentPlan = useCanvasStore((state) => state.saveAgentPlan)
  const updateAgentRunStatus = useCanvasStore((state) => state.updateAgentRunStatus)
  const applyAgentRunSnapshot = useCanvasStore((state) => state.applyAgentRunSnapshot)
  const createGenerateBranchFromResult = useCanvasStore((state) => state.createGenerateBranchFromResult)
  const createGenerateFromResultRecipe = useCanvasStore((state) => state.createGenerateFromResultRecipe)
  const selectNode = useCanvasStore((state) => state.selectNode)

  const [artifactIndex, setArtifactIndex] = useState<AgentArtifactIndexState>({
    projectId: '',
    artifacts: [],
    status: 'idle',
  })
  const [targetResultId, setTargetResultId] = useState<string | null>(null)
  const [focusRequest, setFocusRequest] = useState<{ nodeIds: string[]; requestId: number } | null>(null)
  const readingAnchorWritesRef = useRef(new Map<string, Promise<void>>())

  const activeSession = document.agentSessions.find((session) => session.id === document.activeAgentSessionId)
  const activeContextNodeIds = activeSession?.contextNodeIds ?? selectedFocusNodeIds
  const contextualResultId = activeContextNodeIds.find((nodeId) => {
    const node = document.nodes.find((item) => item.id === nodeId && item.type === 'result')
    const result = node?.type === 'result' ? node.data as ResultNodeData : undefined
    return Boolean(result?.image) && canUseForImageDelivery(result?.mediaKind)
  })
  const effectiveTargetResultId = targetResultId ?? contextualResultId
  const targetNode = effectiveTargetResultId
    ? document.nodes.find((node) => node.id === effectiveTargetResultId && node.type === 'result')
    : undefined
  const targetData = targetNode?.type === 'result' ? targetNode.data as ResultNodeData : undefined
  const rootRecipe = targetData?.rootRecipe ?? targetData?.generationRecipe
  const target: AgentDockTarget | undefined = targetNode?.type === 'result' && targetData?.image && rootRecipe
    ? { id: targetNode.id, label: targetData.label ?? '已选结果', image: targetData.image, rootRecipe }
    : undefined
  const latestRun = useMemo(() => {
    const candidates = new Map<string, typeof document.agentRuns[number]>()
    for (const message of activeSession?.messages ?? []) {
      if (!message.runId) continue
      const run = document.agentRuns.find((item) => item.id === message.runId)
      if (run) candidates.set(run.id, run)
    }
    if (effectiveTargetResultId) {
      const targetRun = document.agentRuns.find((run) => run.plan.selectedResultNodeId === effectiveTargetResultId)
      if (targetRun) candidates.set(targetRun.id, targetRun)
    }
    return [...candidates.values()].sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id))[0]
  }, [activeSession?.messages, document.agentRuns, effectiveTargetResultId])

  const localArtifacts = useMemo(() => collectBotanicAgentResults({
    sessions: document.agentSessions,
    nodes: document.nodes,
    generationJobs: document.generationJobs,
    assets: document.assets,
  }), [document.agentSessions, document.assets, document.generationJobs, document.nodes])

  const artifactRefreshKey = useMemo(() => [
    ...document.generationJobs
      .filter((job) => ['succeeded', 'failed', 'cancelled'].includes(job.status))
      .map((job) => `job:${job.id}:${job.status}:${job.updatedAt ?? 0}:${job.outputs?.length ?? 0}`),
    ...document.agentRuns
      .filter((run) => ['completed', 'partial', 'failed', 'cancelled'].includes(run.status))
      .map((run) => `run:${run.id}:${run.status}:${run.updatedAt}`),
  ].join('|'), [document.agentRuns, document.generationJobs])

  useEffect(() => {
    if (!agentOpen || !serverPersistenceEnabled) return
    const controller = new AbortController()
    setArtifactIndex((current) => current.projectId === document.id
      ? { ...current, status: 'loading' }
      : { projectId: document.id, artifacts: [], status: 'loading' })
    void listProjectAgentArtifacts(document.id, { limit: 100, signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return
      setArtifactIndex({
        projectId: document.id,
        artifacts: result.artifacts,
        nextBefore: result.nextBefore,
        status: 'ready',
      })
    }).catch(() => {
      if (controller.signal.aborted) return
      setArtifactIndex((current) => current.projectId === document.id
        ? { ...current, status: 'error' }
        : { projectId: document.id, artifacts: [], status: 'error' })
    })
    return () => controller.abort()
  }, [agentOpen, artifactRefreshKey, document.id])

  const indexedArtifacts = artifactIndex.projectId === document.id ? artifactIndex.artifacts : []
  const artifacts = useMemo(
    () => mergeBotanicAgentArtifactIndex(indexedArtifacts, localArtifacts),
    [indexedArtifacts, localArtifacts],
  )
  const contextOptions = useMemo(() => document.nodes.flatMap((node): AgentContextItem[] => {
    if (node.type === 'asset') {
      const data = node.data as AssetNodeData
      return [{
        id: node.id,
        label: data.name ?? '图片素材',
        kind: '素材',
        image: data.image,
        assetId: data.assetId,
        role: data.role,
        mediaKind: data.mediaKind ?? 'image',
        source: data.source,
      }]
    }
    if (node.type === 'result') {
      const data = node.data as ResultNodeData
      return data.image && canUseForImageDelivery(data.mediaKind)
        ? [{ id: node.id, label: data.label ?? '生成结果', kind: '结果', image: data.image, mediaKind: data.mediaKind ?? 'image', source: 'generated' }]
        : []
    }
    if (node.type === 'text') {
      const data = node.data as TextNodeData
      return [{
        id: node.id,
        label: data.label ?? '文字描述',
        kind: '文字',
        ...(data.content?.trim() ? { content: data.content.trim() } : {}),
      }]
    }
    if (node.type === 'generate') {
      const data = node.data as GenerateNodeData
      return [{ id: node.id, label: data.label ?? '生成节点', kind: '节点' }]
    }
    return []
  }), [document.nodes])

  const loadMoreArtifacts = useCallback(async () => {
    const cursor = artifactIndex.projectId === document.id ? artifactIndex.nextBefore : undefined
    if (cursor === undefined || artifactIndex.status === 'loading-more') return
    setArtifactIndex((current) => current.projectId === document.id ? { ...current, status: 'loading-more' } : current)
    try {
      const result = await listProjectAgentArtifacts(document.id, { limit: 100, before: cursor })
      setArtifactIndex((current) => {
        if (current.projectId !== document.id) return current
        const merged = new Map(current.artifacts.map((artifact) => [artifact.id, artifact]))
        for (const artifact of result.artifacts) if (!merged.has(artifact.id)) merged.set(artifact.id, artifact)
        return {
          projectId: document.id,
          artifacts: [...merged.values()],
          nextBefore: result.nextBefore,
          status: 'ready',
        }
      })
    } catch {
      setArtifactIndex((current) => current.projectId === document.id ? { ...current, status: 'error' } : current)
    }
  }, [artifactIndex.nextBefore, artifactIndex.projectId, artifactIndex.status, document.id])

  /**
   * 默认并入已有上下文（用户逐张添加素材时需要），但「基于这张结果继续」这类入口
   * 必须整组替换：叠加会让 composer 里的参考越攒越多，下一轮把上一轮的参考也带上。
   */
  const setSessionContext = useCallback((sessionId: string, nodeIds: string[], options?: { replace?: boolean }) => {
    if (options?.replace) {
      setAgentSessionContext(sessionId, [...new Set(nodeIds)])
      return
    }
    const session = useCanvasStore.getState().document.agentSessions.find((item) => item.id === sessionId)
    setAgentSessionContext(sessionId, [...new Set([...(session?.contextNodeIds ?? []), ...nodeIds])])
  }, [setAgentSessionContext])

  const open = useCallback(() => {
    const sessionId = ensureAgentSession(selectedFocusNodeIds)
    if (selectedFocusNodeIds.length) setSessionContext(sessionId, selectedFocusNodeIds)
    setTargetResultId(selectedReadyResultId ?? null)
    onPrepareAgentOpen()
  }, [ensureAgentSession, onPrepareAgentOpen, selectedFocusNodeIds, selectedReadyResultId, setSessionContext])

  const openForResult = useCallback((resultNodeId: string) => {
    const result = document.nodes.find((node) => node.id === resultNodeId && node.type === 'result')
    const data = result?.type === 'result' ? result.data as ResultNodeData : undefined
    if (!data?.image) return
    selectNode(resultNodeId)
    const sessionId = ensureAgentSession([resultNodeId])
    setSessionContext(sessionId, [resultNodeId], { replace: true })
    setTargetResultId(resultNodeId)
    onPrepareAgentOpen()
  }, [document.nodes, ensureAgentSession, onPrepareAgentOpen, selectNode, setSessionContext])

  /**
   * Agent Run 在画布上的节点。任务刚提交时结果还是占位节点（没有图片），
   * 因此按 agentRun.runId 直接查图谱，而不是等 Artifact 出现。
   */
  const resolveRunNodes = useCallback((runId: string) => {
    const nodes = useCanvasStore.getState().document.nodes
    return nodes.flatMap((node) => {
      if (node.type !== 'result') return []
      const data = node.data as ResultNodeData
      return data.agentRun?.runId === runId ? [node.id] : []
    })
  }, [])

  const focusNodes = useCallback((nodeIds: string[]) => {
    const validNodeIds = [...new Set(nodeIds)].filter((nodeId) => document.nodes.some((node) => node.id === nodeId))
    if (!validNodeIds.length) return
    selectNode(validNodeIds[0])
    onPrepareCanvasFocus()
    setFocusRequest({ nodeIds: validNodeIds, requestId: Date.now() })
  }, [document.nodes, onPrepareCanvasFocus, selectNode])

  const addUploadedImages = useCallback((uploads: UploadedAssetInput[]) => {
    if (!uploads.length) return
    const projectId = document.id
    const currentDocument = useCanvasStore.getState().document
    if (currentDocument.id !== projectId) return
    const existingNodeIds = new Set(currentDocument.nodes.map((node) => node.id))
    const hasProduct = currentDocument.nodes.some((node) => node.type === 'asset' && (node.data as AssetNodeData).role === '商品')
    const normalizedUploads = uploads.map((upload, index) => ({
      ...upload,
      role: !hasProduct && index === 0 ? '商品' as const : upload.role,
    }))
    const origin = currentDocument.nodes.length
      ? { x: Math.max(...currentDocument.nodes.map((node) => node.position.x)) + 220, y: Math.min(...currentDocument.nodes.map((node) => node.position.y)) }
      : { x: 180, y: 160 }
    addUploadedAssetsToCanvas(normalizedUploads, origin)
    const addedNodeIds = useCanvasStore.getState().document.nodes
      .filter((node) => node.type === 'asset' && !existingNodeIds.has(node.id))
      .map((node) => node.id)
    if (!addedNodeIds.length) return
    const latestDocument = useCanvasStore.getState().document
    const sessionId = latestDocument.activeAgentSessionId ?? ensureAgentSession()
    setSessionContext(sessionId, addedNodeIds)
  }, [addUploadedAssetsToCanvas, document.id, ensureAgentSession, setSessionContext])

  const confirmAction = useCallback(async (action: BotanicAgentActionProposal): Promise<BotanicAgentActionResult> => {
    const projectId = document.id
    const response = await executeProjectAgentAction({ projectId, action })
    const output = response.output
    if (useCanvasStore.getState().document.id !== projectId) {
      return { ...output, message: `${output.message} 已切换项目，结果保留在原项目，未写入当前画布。` }
    }
    const nodes = useCanvasStore.getState().document.nodes
    const origin = nodes.length
      ? { x: Math.max(...nodes.map((node) => node.position.x)) + 220, y: Math.min(...nodes.map((node) => node.position.y)) + 120 }
      : { x: 180, y: 160 }
    const writebacks: BotanicAgentCanvasWriteback[] = []
    for (const [index, resolved] of resolveBotanicAgentCanvasCommands(output).entries()) {
      const position = { x: origin.x + (index % 2) * 240, y: origin.y + Math.floor(index / 2) * 260 }
      if (resolved.command.type === 'create_text_node' && resolved.artifact.content) {
        const nodeId = addTextNode(position, { select: false })
        updateTextNode(nodeId, resolved.artifact.content)
        renameCanvasNode(nodeId, resolved.artifact.label)
        writebacks.push({ artifactId: resolved.artifact.id, nodeId })
      }
      if (resolved.command.type === 'create_media_node' && resolved.artifact.url) {
        addUploadedAssetsToCanvas([{
          name: resolved.artifact.label,
          image: resolved.artifact.url,
          role: '场景',
          mediaKind: resolved.artifact.kind === 'video' ? 'video' : 'image',
          collection: 'Agent 产物',
          tags: ['Agent', resolved.artifact.provenance.externalTool ?? resolved.artifact.provenance.toolName],
        }], position)
        const nodeId = useCanvasStore.getState().selectedNodeId
        if (nodeId) writebacks.push({ artifactId: resolved.artifact.id, nodeId })
      }
    }
    return recordBotanicAgentCanvasWritebacks(output, writebacks)
  }, [addTextNode, addUploadedAssetsToCanvas, document.id, renameCanvasNode, updateTextNode])

  const confirmPlan = useCallback(async (plan: BotanicAgentPlan, submissionKey?: string) => {
    const projectId = document.id
    const group = plan.assetGroupId ? document.assetGroups.find((item) => item.id === plan.assetGroupId) : undefined
    const branchInputs = plan.output.mode === 'batch_by_asset' && group
      ? group.assetIds.map((assetId, index) => ({ assetId, branchId: `branch-${crypto.randomUUID()}`, label: `分支 ${index + 1}` }))
      : [{ branchId: `branch-${crypto.randomUUID()}`, label: plan.summary }]
    let runId: string
    if (serverPersistenceEnabled) {
      try {
        const activeDocument = useCanvasStore.getState().document
        if (activeDocument.id !== projectId) throw new Error('项目已切换，本次计划未启动。')
        const contextNodeIds = new Set(plan.contextSnapshot?.map((item) => item.nodeId) ?? [])
        const contextSources = activeDocument.nodes.flatMap((node) => {
          if (!contextNodeIds.has(node.id)) return []
          if (node.type === 'asset') {
            const data = node.data as AssetNodeData
            return data.image && canUseForImageDelivery(data.mediaKind) ? [data.image] : []
          }
          if (node.type === 'result') {
            const data = node.data as ResultNodeData
            return data.image && canUseForImageDelivery(data.mediaKind) ? [data.image] : []
          }
          return []
        })
        const sources = [...new Set([
          ...collectAgentMediaSources(activeDocument, plan.selectedResultNodeId ?? '', plan.assetGroupId),
          ...contextSources,
        ])]
        const replacements = await prepareAgentMediaSources(sources, (source) => persistAgentReferenceMedia(activeDocument.id, source))
        if (useCanvasStore.getState().document.id !== projectId) throw new Error('项目已切换，本次计划未启动。')
        await replaceMediaSources(replacements)
        if (useCanvasStore.getState().document.id !== projectId) throw new Error('项目已切换，本次计划未启动。')
        const snapshot = await createPersistentBotanicAgentRun({
          projectId,
          plan,
          idempotencyKey: submissionKey,
          branches: branchInputs.map((branch) => ({
            id: branch.branchId,
            label: branch.label,
            ...('assetId' in branch ? { assetId: branch.assetId } : {}),
          })),
        })
        if (useCanvasStore.getState().document.id !== projectId) {
          const execution = await executePersistentBotanicAgentRun(projectId, snapshot.id)
          return { started: execution.jobIds.length > 0, runId: snapshot.id }
        }
        // POST 返回的 Run 是独立持久化实体的权威快照。不能再用客户端时钟
        // 重建同 ID 的 awaiting_confirmation Run，否则会用更新的本地时间戳压住
        // 服务端 queued 状态，断线后任务也无法恢复执行。
        runId = snapshot.id
        applyAgentRunSnapshot(snapshot)
        await flushPendingCanvasDocumentWrites()
        if (useCanvasStore.getState().document.id !== projectId) {
          const execution = await executePersistentBotanicAgentRun(projectId, runId)
          return { started: execution.jobIds.length > 0, runId }
        }
        const execution = await executePersistentBotanicAgentRun(projectId, runId, {
          // 服务端先落盘文字/参考/生成占位工作流；在提交真实 Job 前刷新一次，
          // 让用户看到“生成中”节点，而不是等整个提交请求返回后才看到画布变化。
          onWorkflowReady: async () => {
            if (useCanvasStore.getState().document.id === projectId) await refreshDocumentFromRemote()
          },
        })
        if (useCanvasStore.getState().document.id !== projectId) return { started: execution.jobIds.length > 0, runId }
        applyAgentRunSnapshot(execution.run)
        await refreshDocumentFromRemote().catch(() => false)
        return { started: execution.jobIds.length > 0, runId }
      } catch (caught) {
        throw new Error(caught instanceof Error ? caught.message : 'Agent Run 无法持久化，请稍后重试。')
      }
    }
    if (useCanvasStore.getState().document.id !== projectId) throw new Error('项目已切换，本次计划未启动。')
    if (plan.intent === 'initial_generation') {
      throw new Error('首次生成需要连接工作区服务，以创建可恢复任务；当前未修改画布。')
    }
    const selectedResultNodeId = plan.selectedResultNodeId
    if (!selectedResultNodeId) throw new Error('当前计划缺少父结果，未创建画布节点。')
    runId = saveAgentPlan(plan)
    updateAgentRunStatus(runId, 'executing')
    let started = false
    if (plan.output.mode === 'batch_by_asset' && plan.assetGroupId) {
      started = await runBatchVariation({
        sourceResultNodeId: selectedResultNodeId,
        groupId: plan.assetGroupId,
        prompt: plan.prompt,
        candidatesPerAsset: plan.output.candidatesPerItem,
        settings: plan.settings,
        agentRunId: undefined,
      })
    } else {
      const branchId = plan.intent === 'redo_from_root'
        ? createGenerateFromResultRecipe(selectedResultNodeId)
        : createGenerateBranchFromResult(selectedResultNodeId, {
            prompt: plan.prompt,
            batchCount: plan.output.count,
            settings: plan.settings,
            refinementMode: 'faithful',
          })
      if (branchId) {
        if (plan.intent === 'redo_from_root') updateGenerateNode(branchId, { prompt: plan.prompt, settings: plan.settings })
        started = await runGraphGeneration(branchId)
      }
    }
    if (!started) {
      updateAgentRunStatus(runId, 'failed', '生成任务未启动，请检查参考素材与生成服务。')
      return { started: false, runId }
    }
    return { started: true, runId }
  }, [applyAgentRunSnapshot, createGenerateBranchFromResult, createGenerateFromResultRecipe, document.assetGroups, document.id, refreshDocumentFromRemote, replaceMediaSources, runBatchVariation, runGraphGeneration, saveAgentPlan, updateAgentRunStatus, updateGenerateNode])

  const newSession = useCallback(() => {
    const sessionId = startNewAgentSession(selectedFocusNodeIds)
    setTargetResultId(selectedReadyResultId ?? null)
    return sessionId
  }, [selectedFocusNodeIds, selectedReadyResultId, startNewAgentSession])

  const selectSession = useCallback((sessionId: string) => {
    setActiveAgentSession(sessionId)
    const session = document.agentSessions.find((item) => item.id === sessionId)
    const resultId = session?.contextNodeIds.find((nodeId) => document.nodes.some((node) => {
      if (node.id !== nodeId || node.type !== 'result') return false
      const result = node.data as ResultNodeData
      return Boolean(result.image) && canUseForImageDelivery(result.mediaKind)
    }))
    setTargetResultId(resultId ?? null)
  }, [document.agentSessions, document.nodes, setActiveAgentSession])

  const updateSessionReadingAnchor = useCallback((sessionId: string, messageId: string) => {
    const currentDocument = useCanvasStore.getState().document
    if (currentDocument.id !== document.id) return
    const session = currentDocument.agentSessions.find((candidate) => candidate.id === sessionId)
    if (!session?.messages.some((message) => message.id === messageId)) return
    if (session.readingAnchorMessageId === messageId) return
    setAgentSessionReadingAnchor(sessionId, messageId)
    if (!serverPersistenceEnabled) return

    const previous = readingAnchorWritesRef.current.get(sessionId) ?? Promise.resolve()
    const write = previous.catch(() => undefined).then(async () => {
      const latestDocument = useCanvasStore.getState().document
      if (latestDocument.id !== document.id) return
      const latestSession = latestDocument.agentSessions.find((candidate) => candidate.id === sessionId)
      if (!latestSession?.readingAnchorMessageId) return
      await submitPersistentBotanicAgentReadingAnchor(document.id, sessionId, latestSession.readingAnchorMessageId)
    }).catch(() => {
      // 阅读位置是增强能力；同步失败不得阻断对话或画布编辑。
    }).finally(() => {
      if (readingAnchorWritesRef.current.get(sessionId) === write) readingAnchorWritesRef.current.delete(sessionId)
    })
    readingAnchorWritesRef.current.set(sessionId, write)
  }, [document.id, setAgentSessionReadingAnchor])

  const saveArtifact = useCallback((artifact: BotanicAgentArtifact) => {
    if (!artifact.url || (artifact.kind !== 'image' && artifact.kind !== 'video')) return
    saveGeneratedImageToLibrary({ image: artifact.url, name: artifact.label, mediaKind: artifact.kind })
  }, [saveGeneratedImageToLibrary])

  const continueArtifact = useCallback((artifact: BotanicAgentArtifact) => {
    let currentDocument = useCanvasStore.getState().document
    let sourceNodeIds = (artifact.provenance.sourceNodeIds ?? [])
      .filter((nodeId) => currentDocument.nodes.some((node) => node.id === nodeId))
    if (!sourceNodeIds.length && artifact.url && (artifact.kind === 'image' || artifact.kind === 'video')) {
      const existingNodeIds = new Set(currentDocument.nodes.map((node) => node.id))
      addUploadedAssetsToCanvas([{
        name: artifact.label,
        image: artifact.url,
        role: '场景',
        mediaKind: artifact.kind,
        collection: 'Agent 历史结果',
        tags: ['Agent', '历史结果'],
      }])
      currentDocument = useCanvasStore.getState().document
      sourceNodeIds = currentDocument.nodes
        .filter((node) => node.type === 'asset' && !existingNodeIds.has(node.id))
        .map((node) => node.id)
    }
    if (!sourceNodeIds.length) return
    const sessionId = currentDocument.activeAgentSessionId ?? ensureAgentSession(sourceNodeIds)
    setSessionContext(sessionId, sourceNodeIds, { replace: true })
    const resultId = sourceNodeIds.find((nodeId) => currentDocument.nodes.some((node) => node.id === nodeId && node.type === 'result'))
    setTargetResultId(resultId ?? null)
    selectNode(sourceNodeIds[0])
    onPrepareCanvasFocus()
    setFocusRequest({ nodeIds: sourceNodeIds, requestId: Date.now() })
  }, [addUploadedAssetsToCanvas, ensureAgentSession, onPrepareCanvasFocus, selectNode, setSessionContext])

  const useResultContext = useCallback((sourceNodeIds: string[]) => {
    const currentDocument = useCanvasStore.getState().document
    const sessionId = currentDocument.activeAgentSessionId ?? ensureAgentSession(sourceNodeIds)
    setSessionContext(sessionId, sourceNodeIds, { replace: true })
    const resultId = sourceNodeIds.find((nodeId) => currentDocument.nodes.some((node) => node.id === nodeId && node.type === 'result'))
    setTargetResultId(resultId ?? null)
    if (resultId) selectNode(resultId)
  }, [ensureAgentSession, selectNode, setSessionContext])

  return {
    activeSession,
    target,
    latestRun,
    artifacts,
    contextOptions,
    resolveRunNodes,
    artifactIndexStatus: artifactIndex.projectId === document.id ? artifactIndex.status : 'idle' as const,
    artifactIndexHasMore: artifactIndex.projectId === document.id && artifactIndex.nextBefore !== undefined,
    focusRequest,
    open,
    openForResult,
    focusNodes,
    addUploadedImages,
    confirmAction,
    confirmPlan,
    newSession,
    selectSession,
    updateSessionReadingAnchor,
    saveArtifact,
    continueArtifact,
    loadMoreArtifacts,
    useResultContext,
  }
}
