import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  botanicAgentNextIterationTargetId,
  collectBotanicAgentResults,
  mergeBotanicAgentArtifactIndex,
  readBotanicAgentCanvasWritebacks,
  recordBotanicAgentCanvasWritebacks,
  expandBotanicAgentContextNodeIds,
  resolveBotanicAgentWorkflowReferenceNodeIds,
  resolveBotanicAgentCanvasCommands,
  botanicAgentBatchBranchTitles,
  botanicAgentBranchId,
  botanicAgentLocalInitialGenerationDecision,
  type BotanicAgentActionProposal,
  type BotanicAgentActionResult,
  type BotanicAgentArtifact,
  type BotanicAgentManualRetryAuthorization,
  type BotanicAgentPlan,
} from '../../domain/agent'
import { collectAgentMediaSources, collectAgentVisionMediaSources, prepareAgentMediaSources } from '../../domain/agentMedia'
import {
  type AssetNodeData,
  type CanvasDocument,
  type GenerateNodeData,
  type ResultNodeData,
  type TextNodeData,
  type UploadedAssetInput,
} from '../../domain/canvas'
import { canUseForImageDelivery } from '../../domain/deliveryPresentation'
import { botanicAgentConfirmBranchDrafts, botanicAgentBranchGenerationPrompt } from '../../domain/agentVariations'
import {
  createPersistentBotanicAgentRun,
  executePersistentBotanicAgentRun,
  executeProjectAgentAction,
  listProjectAgentArtifacts,
  persistAgentReferenceMedia,
  submitPersistentBotanicAgentReadingAnchor,
  type ProjectAgentActionContext,
} from '../../lib/agentApi'
import { flushPendingCanvasDocumentWrites } from '../../lib/db'
import { serverPersistenceEnabled } from '../../lib/productSession'
import { localizeProductError } from '../../i18n/core'
import { useProductI18n } from '../../i18n/react'
import { useCanvasStore } from '../../store/canvasStore'
import { useAgentSessionMessages } from '../agent/useAgentSessionMessages'
import type { AgentArtifactIndexState, AgentContextItem, AgentDockTarget } from '../agent/agentWorkspace.types'
import {
  projectAcceptedAgentRunBestEffort,
  preserveCanvasAgentActionError,
} from './canvasAgentActionExecution'
import { canvasSystemLabel } from './canvasI18n'

const canvasAgentExecutionCopy = {
  'zh-CN': {
    selectedResult: '已选结果',
    imageAsset: '图片素材',
    generatedResult: '生成结果',
    textDescription: '文字描述',
    generateNode: '生成节点',
    projectChanged: '项目已切换，本次计划未启动。',
    projectChangedResult: '已切换项目，结果保留在原项目，未写入当前画布。',
    actionFailed: 'Agent 操作执行失败，请稍后重试。',
    runPersistenceFailed: 'Agent Run 无法持久化，请稍后重试。',
    initialGenerationRequiresService: '首次生成需要连接工作区服务，以创建可恢复任务；当前未修改画布。',
    initialGenerationReferenceRequiresService: '按参考图首次生成需要连接工作区服务。本地回退无法保留参考素材，已停止以免变成纯文字生成；当前未修改画布。',
    missingParentResult: '当前计划缺少父结果，未创建画布节点。',
    generationNotStarted: '生成任务未启动，请检查参考素材与生成服务。',
  },
  en: {
    selectedResult: 'Selected result',
    imageAsset: 'Image asset',
    generatedResult: 'Generated result',
    textDescription: 'Text description',
    generateNode: 'Generation node',
    projectChanged: 'The project changed, so this plan was not started.',
    projectChangedResult: 'The project changed. The result remains in the original project and was not added to this canvas.',
    actionFailed: 'Unable to complete the Agent action. Try again.',
    runPersistenceFailed: 'Unable to save the Agent run. Try again.',
    initialGenerationRequiresService: 'Connect to the workspace service to create a recoverable first-generation task. The canvas was not changed.',
    initialGenerationReferenceRequiresService: 'Reference-based first generation needs the workspace service. The local fallback cannot preserve reference assets, so it stopped rather than generating from text only. The canvas was not changed.',
    missingParentResult: 'This plan has no parent result, so no canvas node was created.',
    generationNotStarted: 'The generation task did not start. Check the reference assets and generation service.',
  },
} as const

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
function canvasAssetName(document: CanvasDocument, assetId: string) {
  return document.assets.find((asset) => asset.id === assetId)?.name
    ?? document.nodes.flatMap((node) => {
      if (node.type !== 'asset') return []
      const data = node.data as AssetNodeData
      return data.assetId === assetId ? [data.name] : []
    })[0]
}

function canvasAgentDockTarget(
  document: CanvasDocument,
  nodeId: string,
  fallbackLabel: string,
  locale: 'zh-CN' | 'en',
): AgentDockTarget | undefined {
  const node = document.nodes.find((candidate) => candidate.id === nodeId && candidate.type === 'result')
  const data = node?.type === 'result' ? node.data as ResultNodeData : undefined
  const rootRecipe = data?.rootRecipe ?? data?.generationRecipe
  return node?.type === 'result' && data?.image && rootRecipe
    ? { id: node.id, label: canvasSystemLabel(data.label ?? fallbackLabel, locale), image: data.image, rootRecipe }
    : undefined
}

export function useCanvasAgentExecutionBridge({
  document,
  agentOpen,
  selectedFocusNodeIds,
  selectedReadyResultId,
  onPrepareAgentOpen,
  onPrepareCanvasFocus,
}: UseCanvasAgentExecutionBridgeOptions) {
  const { locale } = useProductI18n()
  const copy = canvasAgentExecutionCopy[locale]
  const updateGenerateNode = useCanvasStore((state) => state.updateGenerateNode)
  const runGeneration = useCanvasStore((state) => state.runGeneration)
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
  const applyAgentWorkflowPatch = useCanvasStore((state) => state.applyAgentWorkflowPatch)
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

  const sessionMeta = document.agentSessions.find((session) => session.id === document.activeAgentSessionId)
  useEffect(() => {
    if (!agentOpen || sessionMeta) return
    ensureAgentSession(selectedFocusNodeIds)
  }, [agentOpen, ensureAgentSession, selectedFocusNodeIds, sessionMeta])
  const sessionMessages = useAgentSessionMessages(
    document.id,
    document.activeAgentSessionId,
    sessionMeta?.messages ?? [],
    agentOpen && Boolean(document.activeAgentSessionId),
  )
  const activeSession = sessionMeta
    ? { ...sessionMeta, messages: sessionMessages.messages }
    : undefined
  const activeContextNodeIds = activeSession?.contextNodeIds ?? selectedFocusNodeIds
  const contextualResultId = activeContextNodeIds.find((nodeId) => {
    const node = document.nodes.find((item) => item.id === nodeId && item.type === 'result')
    const result = node?.type === 'result' ? node.data as ResultNodeData : undefined
    return Boolean(result?.image) && canUseForImageDelivery(result?.mediaKind)
  })
  const effectiveTargetResultId = targetResultId ?? contextualResultId
  const target = effectiveTargetResultId
    ? canvasAgentDockTarget(document, effectiveTargetResultId, copy.selectedResult, locale)
    : undefined
  const resolveTarget = useCallback((nodeId: string) => {
    const currentDocument = useCanvasStore.getState().document
    if (currentDocument.id !== document.id) return undefined
    return canvasAgentDockTarget(currentDocument, nodeId, copy.selectedResult, locale)
  }, [copy.selectedResult, document.id, locale])
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

  // 创意循环的心跳：一轮生成回填后，新结果自动成为下一轮基准，「再改一下」不再退回旧父图。
  // 每个 Run 终态只跟随一次（结果回填可能晚于终态到达，成功设置后才记账），
  // 之后用户点选其他结果的显式选择不会被轮询或文档刷新抢回来。
  const followedRunTargetRef = useRef('')
  useEffect(() => {
    if (!latestRun) return
    const followKey = `${latestRun.id}:${latestRun.status}`
    if (followedRunTargetRef.current === followKey) return
    const nextTargetId = botanicAgentNextIterationTargetId(latestRun, document.nodes)
    if (!nextTargetId) return
    followedRunTargetRef.current = followKey
    setTargetResultId(nextTargetId)
  }, [document.nodes, latestRun])

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
    () => mergeBotanicAgentArtifactIndex(indexedArtifacts, localArtifacts)
      .map((artifact) => ({ ...artifact, label: canvasSystemLabel(artifact.label, locale) })),
    [indexedArtifacts, localArtifacts, locale],
  )
  const contextOptions = useMemo(() => document.nodes.flatMap((node): AgentContextItem[] => {
    if (node.type === 'asset') {
      const data = node.data as AssetNodeData
      return [{
        id: node.id,
        label: data.name ?? copy.imageAsset,
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
      const mediaKind = data.mediaKind ?? 'image'
      // Agent @ 引用比投放更宽：有预览图或视频结果都可进菜单；投放仍走 canUseForImageDelivery。
      const usableForAgentReference = Boolean(data.image) || mediaKind === 'video'
      return usableForAgentReference
        ? [{
          id: node.id,
          label: canvasSystemLabel(data.label ?? copy.generatedResult, locale),
          kind: '结果',
          ...(data.image ? { image: data.image } : {}),
          mediaKind,
          source: 'generated',
        }]
        : []
    }
    if (node.type === 'text') {
      const data = node.data as TextNodeData
      return [{
        id: node.id,
        label: canvasSystemLabel(data.label ?? copy.textDescription, locale),
        kind: '文字',
        ...(data.content?.trim() ? { content: data.content.trim() } : {}),
      }]
    }
    if (node.type === 'generate') {
      const data = node.data as GenerateNodeData
      return [{ id: node.id, label: canvasSystemLabel(data.label ?? copy.generateNode, locale), kind: '节点' }]
    }
    return []
  }), [copy.generateNode, copy.generatedResult, copy.imageAsset, copy.textDescription, document.nodes, locale])

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
    const contextNodeIds = expandBotanicAgentContextNodeIds(document.nodes, document.edges, selectedFocusNodeIds)
    const sessionId = ensureAgentSession(contextNodeIds)
    if (contextNodeIds.length) setSessionContext(sessionId, contextNodeIds)
    setTargetResultId(selectedReadyResultId ?? null)
    onPrepareAgentOpen()
  }, [document.edges, document.nodes, ensureAgentSession, onPrepareAgentOpen, selectedFocusNodeIds, selectedReadyResultId, setSessionContext])

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
   * 面板开着时在画布上点一张图，就等于把它交给 Agent，用户不必再 @ 一次。
   * 点到生成节点时展开成它连着的参考图。文字和视频仍需显式引用，否则普通浏览
   * 会把无关节点堆进 composer。并入而非替换，逐张点选才能攒出一组参考。
   */
  const attachNodeContext = useCallback((nodeId: string) => {
    const expanded = expandBotanicAgentContextNodeIds(document.nodes, document.edges, [nodeId])
    const visual = resolveBotanicAgentWorkflowReferenceNodeIds(document.nodes, expanded)
    if (!visual.length) return
    const sessionId = useCanvasStore.getState().document.activeAgentSessionId ?? ensureAgentSession(visual)
    setSessionContext(sessionId, visual)
    // 点选结果图同时把它设为下一轮基准：用户显式指认的对象优先于自动跟随。
    const node = document.nodes.find((item) => item.id === nodeId)
    if (node?.type === 'result') setTargetResultId(nodeId)
  }, [document.edges, document.nodes, ensureAgentSession, setSessionContext])

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

  /**
   * 对话/回合看图读的是服务端文档。聊天框刚放下的参考图还只在本机 data URL 里，
   * 不先入库并冲刷，视觉模型只能拿到节点名，只能猜画面。
   */
  const prepareConversationVisionContext = useCallback(async (sessionId: string) => {
    const activeDocument = useCanvasStore.getState().document
    const contextNodeIds = activeDocument.agentSessions.find((item) => item.id === sessionId)?.contextNodeIds ?? []
    if (!serverPersistenceEnabled || !contextNodeIds.length) return contextNodeIds
    const sources = collectAgentVisionMediaSources(activeDocument, contextNodeIds)
    if (!sources.length) return contextNodeIds
    const replacements = await prepareAgentMediaSources(sources, (source) => persistAgentReferenceMedia(activeDocument.id, source))
    if (Object.keys(replacements).length) await replaceMediaSources(replacements)
    // 有视觉输入时必须确保服务端能读到同一份图片；失败由调用方展示并中止 Turn。
    await flushPendingCanvasDocumentWrites()
    return contextNodeIds
  }, [replaceMediaSources])

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

  const confirmAction = useCallback(async (
    action: BotanicAgentActionProposal,
    context: ProjectAgentActionContext,
    options?: {
      manualRetryAuthorization?: BotanicAgentManualRetryAuthorization
      resumeManualRetry?: { retryIdempotencyKey: string }
      observedResult?: BotanicAgentActionResult
    },
  ): Promise<BotanicAgentActionResult> => {
    const projectId = document.id
    let output = options?.observedResult
    if (!output) {
      try {
        const response = await executeProjectAgentAction({
          projectId,
          action,
          ...context,
          manualRetryAuthorization: options?.manualRetryAuthorization,
          resumeManualRetry: options?.resumeManualRetry,
        })
        output = response.output
      } catch (caught) {
        throw preserveCanvasAgentActionError(caught, localizeProductError(caught, locale, {
          'zh-CN': canvasAgentExecutionCopy['zh-CN'].actionFailed,
          en: canvasAgentExecutionCopy.en.actionFailed,
        }))
      }
    }
    if (useCanvasStore.getState().document.id !== projectId) {
      return { ...output, message: `${output.message} ${copy.projectChangedResult}` }
    }
    const canvasCommands = resolveBotanicAgentCanvasCommands(output)
    const writebacks = readBotanicAgentCanvasWritebacks(action.result)
    const completedArtifactIds = new Set(writebacks.map((writeback) => writeback.artifactId))
    const pendingCanvasCommands = canvasCommands.filter(({ artifact }) => !completedArtifactIds.has(artifact.id))
    if (useCanvasStore.getState().collaborationStatus === 'reconnecting' && pendingCanvasCommands.length) {
      useCanvasStore.setState({ assistantMessage: locale === 'en'
        ? 'Realtime is reconnecting. The completed Agent result is saved and can be written back after reconnection.'
        : '实时连接正在恢复；Agent 结果已保留，连接恢复后可继续回写画布。' })
      return { ...recordBotanicAgentCanvasWritebacks(output, writebacks), canvasWritebackPending: true }
    }
    const nodes = useCanvasStore.getState().document.nodes
    const origin = nodes.length
      ? { x: Math.max(...nodes.map((node) => node.position.x)) + 220, y: Math.min(...nodes.map((node) => node.position.y)) + 120 }
      : { x: 180, y: 160 }
    for (const [index, resolved] of canvasCommands.entries()) {
      if (completedArtifactIds.has(resolved.artifact.id)) continue
      const position = { x: origin.x + (index % 2) * 240, y: origin.y + Math.floor(index / 2) * 260 }
      if (resolved.command.type === 'create_text_node' && resolved.artifact.content) {
        const nodeId = addTextNode(position, { select: false })
        if (nodeId) {
          updateTextNode(nodeId, resolved.artifact.content)
          renameCanvasNode(nodeId, resolved.artifact.label)
          writebacks.push({ artifactId: resolved.artifact.id, nodeId })
          completedArtifactIds.add(resolved.artifact.id)
        }
      }
      if (resolved.command.type === 'create_media_node' && resolved.artifact.url) {
        const existingNodeIds = new Set(useCanvasStore.getState().document.nodes.map((node) => node.id))
        addUploadedAssetsToCanvas([{
          name: resolved.artifact.label,
          image: resolved.artifact.url,
          role: '场景',
          mediaKind: resolved.artifact.kind === 'video' ? 'video' : 'image',
          collection: 'Agent 产物',
          tags: ['Agent', resolved.artifact.provenance.externalTool ?? resolved.artifact.provenance.toolName],
        }], position)
        const nodeId = useCanvasStore.getState().document.nodes.find((node) => !existingNodeIds.has(node.id))?.id
        if (nodeId) {
          writebacks.push({ artifactId: resolved.artifact.id, nodeId })
          completedArtifactIds.add(resolved.artifact.id)
        }
      }
    }
    const result = recordBotanicAgentCanvasWritebacks(output, writebacks)
    return canvasCommands.every(({ artifact }) => completedArtifactIds.has(artifact.id))
      ? result
      : { ...result, canvasWritebackPending: true }
  }, [addTextNode, addUploadedAssetsToCanvas, copy.projectChangedResult, document.id, locale, renameCanvasNode, updateTextNode])

  const confirmPlan = useCallback(async (plan: BotanicAgentPlan, submissionKey?: string) => {
    const projectId = document.id
    const group = plan.assetGroupId ? document.assetGroups.find((item) => item.id === plan.assetGroupId) : undefined
    const drafts = botanicAgentConfirmBranchDrafts(plan, group ? {
      group: {
        assetIds: group.assetIds,
        names: group.assetIds.map((assetId) => canvasAssetName(document, assetId)),
      },
    } : undefined)
    const labels = plan.output.mode === 'batch_by_asset'
      ? botanicAgentBatchBranchTitles(plan, drafts.map((draft) => draft.label))
      : drafts.map((draft) => draft.label)
    const branchInputs = drafts.map((draft, index) => ({
      branchId: botanicAgentBranchId(submissionKey, index),
      label: labels[index] ?? draft.label,
      ...(draft.assetId ? { assetId: draft.assetId } : {}),
      ...(draft.variation ? { variation: draft.variation } : {}),
      ...(draft.item ? { item: draft.item } : {}),
    }))
    let runId: string
    if (serverPersistenceEnabled) {
      try {
        const activeDocument = useCanvasStore.getState().document
        if (activeDocument.id !== projectId) throw new Error(copy.projectChanged)
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
        if (useCanvasStore.getState().document.id !== projectId) throw new Error(copy.projectChanged)
        await replaceMediaSources(replacements)
        if (useCanvasStore.getState().document.id !== projectId) throw new Error(copy.projectChanged)
        const snapshot = await createPersistentBotanicAgentRun({
          projectId,
          plan,
          idempotencyKey: submissionKey,
          ...(plan.turnId ? { turnId: plan.turnId } : {}),
          branches: branchInputs.map((branch) => ({
            id: branch.branchId,
            label: branch.label,
            ...(branch.assetId ? { assetId: branch.assetId } : {}),
            ...(branch.variation ? { variation: branch.variation } : {}),
            ...(branch.item ? { item: branch.item } : {}),
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
        await projectAcceptedAgentRunBestEffort({
          apply: () => { applyAgentRunSnapshot(snapshot) },
          flush: flushPendingCanvasDocumentWrites,
        })
        // 导演模式：服务端在创建时已自主建工作流并提交。快照带着 Job 绑定或终态时，
        // 浏览器不再补打三跳，只刷新画布把服务端建好的占位拉下来并聚焦。
        const serverSubmitted = snapshot.status === 'failed'
          || snapshot.branches.some((branch) => branch.activeJobId || branch.jobIds.length > 0)
        if (serverSubmitted) {
          const started = snapshot.status !== 'failed'
            && snapshot.branches.some((branch) => branch.activeJobId || branch.jobIds.length > 0)
          if (useCanvasStore.getState().document.id === projectId) {
            await refreshDocumentFromRemote().catch(() => false)
            if (useCanvasStore.getState().document.id === projectId) {
              const visibleNodeIds = resolveRunNodes(runId)
              if (visibleNodeIds.length) {
                selectNode(visibleNodeIds.at(-1)!)
                onPrepareCanvasFocus()
                setFocusRequest({ nodeIds: visibleNodeIds, requestId: Date.now() })
              }
            }
          }
          return { started, runId }
        }
        // 旧版服务端或队列暂不可用（Run 仍是空 queued）：保留浏览器三跳作幂等兜底。
        if (useCanvasStore.getState().document.id !== projectId) {
          const execution = await executePersistentBotanicAgentRun(projectId, runId)
          return { started: execution.jobIds.length > 0, runId }
        }
        const execution = await executePersistentBotanicAgentRun(projectId, runId, {
          // 服务端先落盘文字/生成/结果占位工作流；在提交真实 Job 前直接应用回执，
          // 让用户立即看到节点，旧服务端回执才回退到整份刷新。
          onWorkflowReady: async (workflow) => {
            if (useCanvasStore.getState().document.id !== projectId) return
            if (workflow.canvasPatch) await applyAgentWorkflowPatch(workflow.canvasPatch)
            else await refreshDocumentFromRemote()
            const visibleNodeIds = workflow.canvasNodeIds?.filter((nodeId) => (
              useCanvasStore.getState().document.nodes.some((node) => node.id === nodeId)
            )) ?? []
            if (visibleNodeIds.length) {
              selectNode(visibleNodeIds.at(-1)!)
              onPrepareCanvasFocus()
              setFocusRequest({ nodeIds: visibleNodeIds, requestId: Date.now() })
            }
          },
        })
        if (useCanvasStore.getState().document.id !== projectId) return { started: execution.jobIds.length > 0, runId }
        await projectAcceptedAgentRunBestEffort({
          apply: () => { applyAgentRunSnapshot(execution.run) },
        })
        await refreshDocumentFromRemote().catch(() => false)
        return { started: execution.jobIds.length > 0, runId }
      } catch (caught) {
        const projectChanged = caught instanceof Error && caught.message === copy.projectChanged
        throw preserveCanvasAgentActionError(caught, localizeProductError(caught, locale, projectChanged ? {
          'zh-CN': canvasAgentExecutionCopy['zh-CN'].projectChanged,
          en: canvasAgentExecutionCopy.en.projectChanged,
        } : {
          'zh-CN': canvasAgentExecutionCopy['zh-CN'].runPersistenceFailed,
          en: canvasAgentExecutionCopy.en.runPersistenceFailed,
        }))
      }
    }
    if (useCanvasStore.getState().document.id !== projectId) throw new Error(copy.projectChanged)
    if (plan.intent === 'initial_generation') {
      // 本地回退只允许确实无图片引用的首轮文生图。带引用时必须阻断：下面构造的是
      // 空引用配方，静默走下去会把用户要求的「按参考生成」变成纯文字生成。
      // 视频仍交给可恢复服务处理首帧约束。
      const fallback = botanicAgentLocalInitialGenerationDecision(plan)
      if (!fallback.ok) {
        throw new Error(fallback.reason === 'reference_requires_service'
          ? copy.initialGenerationReferenceRequiresService
          : copy.initialGenerationRequiresService)
      }
      runId = saveAgentPlan(plan)
      updateAgentRunStatus(runId, 'executing')
      const started = await runGeneration({
        prompt: plan.prompt,
        batchCount: plan.output.count,
        settings: plan.settings,
        recipe: {
          prompt: plan.prompt,
          batchCount: plan.output.count,
          settings: plan.settings,
          references: [],
        },
        title: plan.title,
      })
      if (!started) {
        updateAgentRunStatus(runId, 'failed', copy.generationNotStarted)
        return { started: false, runId }
      }
      return { started: true, runId }
    }
    const selectedResultNodeId = plan.selectedResultNodeId
    if (!selectedResultNodeId) throw new Error(copy.missingParentResult)
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
    } else if (plan.output.mode === 'batch_by_variation') {
      const nodeIds = branchInputs.flatMap((branch) => {
        const nodeId = createGenerateBranchFromResult(selectedResultNodeId, {
          prompt: botanicAgentBranchGenerationPrompt(plan.prompt, branch.variation?.promptDelta),
          batchCount: 1,
          settings: plan.settings,
          refinementMode: 'faithful',
        })
        return nodeId ? [nodeId] : []
      })
      const results = await Promise.all(nodeIds.map((nodeId) => runGraphGeneration(nodeId)))
      started = results.some(Boolean)
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
      updateAgentRunStatus(runId, 'failed', copy.generationNotStarted)
      return { started: false, runId }
    }
    return { started: true, runId }
  }, [applyAgentRunSnapshot, applyAgentWorkflowPatch, copy.generationNotStarted, copy.initialGenerationRequiresService, copy.missingParentResult, copy.projectChanged, createGenerateBranchFromResult, createGenerateFromResultRecipe, document.assetGroups, document.id, locale, onPrepareCanvasFocus, refreshDocumentFromRemote, replaceMediaSources, resolveRunNodes, runBatchVariation, runGeneration, runGraphGeneration, saveAgentPlan, selectNode, updateAgentRunStatus, updateGenerateNode])

  const newSession = useCallback(() => {
    const contextNodeIds = expandBotanicAgentContextNodeIds(document.nodes, document.edges, selectedFocusNodeIds)
    const sessionId = startNewAgentSession(contextNodeIds)
    setTargetResultId(selectedReadyResultId ?? null)
    return sessionId
  }, [document.edges, document.nodes, selectedFocusNodeIds, selectedReadyResultId, startNewAgentSession])

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
    if (!session) return
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
    resolveTarget,
    latestRun,
    artifacts,
    contextOptions,
    resolveRunNodes,
    artifactIndexStatus: artifactIndex.projectId === document.id ? artifactIndex.status : 'idle' as const,
    artifactIndexHasMore: artifactIndex.projectId === document.id && artifactIndex.nextBefore !== undefined,
    loadOlderAgentMessages: sessionMessages.loadOlderMessages,
    hasOlderAgentMessages: sessionMessages.hasOlderMessages,
    loadingOlderAgentMessages: sessionMessages.loadingOlder,
    refreshAgentSessionMessages: sessionMessages.refresh,
    agentMessagesLoading: sessionMessages.loading,
    focusRequest,
    open,
    openForResult,
    attachNodeContext,
    focusNodes,
    addUploadedImages,
    prepareConversationVisionContext,
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
