import type { AssetGroup, AssetNodeData, AssetRecord, CanvasDocument, CanvasNode, GenerationJob, GenerationRecipe, GenerationSettings, ResultNodeData } from './canvas.ts'
import type { BotanicAgentClarification, BotanicCreativeBrief } from './agentCreativeBrief.ts'
import type { BotanicAgentBranchVariation, BotanicAgentVariationSpec } from './agentVariations.ts'
export type {
  BotanicAgentClarification,
  BotanicAgentClarificationField,
  BotanicAgentClarificationFieldId,
  BotanicCreativeBriefFieldId,
  BotanicAgentClarificationOption,
  BotanicCreativeBrief,
  BotanicCreativeBriefMode,
  BotanicCreativeBriefSource,
  BotanicDeliveryPreset,
  BotanicPreservationPriority,
  BotanicPromptDirection,
} from './agentCreativeBrief.ts'

export type BotanicAgentIntent =
  | 'initial_generation'
  | 'continue_generation'
  | 'replace_scene'
  | 'replace_person'
  | 'replace_product'
  | 'change_pose'
  | 'change_style'
  | 'batch_variation'
  | 'redo_from_root'

export type CreativeDimension =
  | 'person'
  | 'garment'
  | 'product'
  | 'scene'
  | 'style'
  | 'pose'
  | 'composition'
  | 'lighting'
  | 'aspect_ratio'
  | 'copy_space'

export type CreativeConstraint = {
  dimension: CreativeDimension
  mode: 'preserve' | 'vary'
  sourceAssetGroupId?: string
}

export type AgentReferenceBinding = {
  source: 'selected_result' | 'root_recipe' | 'asset_group' | 'context_node'
  id: string
  label: string
  role?: string
}

export type AgentToolCallTrace = {
  id: string
  name: string
  label: string
  risk: 'read' | 'write' | 'costly' | 'external'
  status: 'pending' | 'running' | 'awaiting_confirmation' | 'succeeded' | 'failed'
  requiresConfirmation: boolean
  /** 模型自述的一句话调用目的。它是说给用户听的摘要，不是隐藏思维链，可展示也可持久化。 */
  summary?: string
  error?: string
}

/**
 * 一轮里的运行说明片段。
 * - `summary` 来自模型自述的工具调用目的，可展示、可随计划持久化。
 * - `raw` 是提供方回传的完整推理，默认关闭；即使打开也只用于当轮实时展示，
 *   不写入消息、计划或 Artifact Index。
 */
export type BotanicAgentReasoningEntry = {
  step: number
  source: 'summary' | 'raw'
  text: string
}

/**
 * Agent 运行记录只描述可验证的产品操作，不承载模型内部思考内容。
 * 该读模型供 Composer 展示，也可以在后续接入服务端事件流时复用。
 */
export type BotanicAgentRuntimeStep = {
  id: string
  kind: 'read' | 'search' | 'plan' | 'write'
  label: string
  detail: string
  status: 'pending' | 'running' | 'succeeded' | 'failed'
  startedAt?: number
  completedAt?: number
  error?: string
}

export function createBotanicAgentRuntimeSteps(input: {
  hasTarget: boolean
  referenceCount?: number
  memoryCount?: number
  assetGroupCount?: number
  plannerLabel?: string
  mode?: 'generation' | 'conversation' | 'prompt' | 'research'
}): BotanicAgentRuntimeStep[] {
  const mode = input.mode ?? 'generation'
  const isGeneration = mode === 'generation'
  const steps: BotanicAgentRuntimeStep[] = [
    {
      id: 'read-canvas', kind: 'read', label: '读取画布上下文',
      detail: mode === 'research'
        ? '读取当前项目可验证资料'
        : input.hasTarget ? '当前结果、生成参数与节点关系' : '当前画布与可用节点', status: 'pending',
    },
  ]
  if ((input.referenceCount ?? 0) > 0) {
    steps.push({
      id: 'read-references', kind: 'read', label: '读取参考素材',
      detail: `${input.referenceCount} 个已连接参考`, status: 'pending',
    })
  }
  if ((input.memoryCount ?? 0) > 0) {
    steps.push({
      id: 'read-memory', kind: 'read', label: '读取项目记忆',
      detail: `${input.memoryCount} 条已保存规则`, status: 'pending',
    })
  }
  if ((input.assetGroupCount ?? 0) > 0) {
    steps.push({
      id: 'search-assets', kind: 'search', label: '搜索素材组',
      detail: `${input.assetGroupCount} 个可用素材组`, status: 'pending',
    })
  }
  steps.push({
    id: 'call-planner', kind: 'plan', label: input.hasTarget ? '调用规划模型' : '解析创作要求',
    detail: mode === 'conversation'
      ? '理解问题与对话上下文'
      : mode === 'prompt'
        ? '整理为可直接使用的 Prompt'
        : mode === 'research'
          ? '检索项目资料并核对来源'
          : input.hasTarget
      ? (input.plannerLabel ? `${input.plannerLabel} · 生成执行计划` : '生成执行计划')
      : '整理创作要求与节点关系',
    status: 'pending',
  })
  steps.push({
    id: isGeneration ? (input.hasTarget ? 'finalize-plan' : 'create-workflow') : 'respond',
    kind: isGeneration ? (input.hasTarget ? 'plan' : 'write') : 'plan',
    label: isGeneration
      ? input.hasTarget ? '整理执行计划' : '创建画布工作流'
      : mode === 'research' ? '整理检索结果' : mode === 'prompt' ? '生成 Prompt 草稿' : '组织回答',
    detail: isGeneration
      ? input.hasTarget ? '锁定项、变化项与输出分支' : '把要求写入可编辑节点'
      : mode === 'research' ? '区分项目事实、推断与来源' : '准备清晰的下一步回复',
    status: 'pending',
  })
  return steps
}

const toolCallStepPrefix = 'tool:'

function agentToolCallStepKind(risk: AgentToolCallTrace['risk']): BotanicAgentRuntimeStep['kind'] {
  if (risk === 'read') return 'read'
  if (risk === 'external') return 'search'
  return 'write'
}

function agentToolCallStepDetail(call: AgentToolCallTrace) {
  const riskLabel = call.risk === 'read'
    ? '读取项目数据'
    : call.risk === 'external'
      ? '调用外部工具'
      : call.risk === 'costly'
        ? '会产生生成费用'
        : '写入项目数据'
  return `${call.name} · ${riskLabel}`
}

/**
 * 把服务端真实回传的工具调用展开成独立运行步骤，插在规划步骤之后。
 * 这些仍然只是可验证的产品操作——调了哪个工具、结果如何——不是模型内部思考内容，
 * 但比“已调用：A、B”这一行 detail 能说明的多得多。
 */
export function insertBotanicAgentToolCallSteps(
  steps: BotanicAgentRuntimeStep[],
  toolCalls: AgentToolCallTrace[],
): BotanicAgentRuntimeStep[] {
  const seen = new Set<string>()
  const toolSteps = toolCalls.flatMap((call): BotanicAgentRuntimeStep[] => {
    const id = `${toolCallStepPrefix}${call.id}`
    const label = call.label?.trim()
    if (!call.id || !label || seen.has(id)) return []
    seen.add(id)
    return [{
      id,
      kind: agentToolCallStepKind(call.risk),
      label,
      detail: call.summary?.trim() || agentToolCallStepDetail(call),
      status: call.status === 'awaiting_confirmation' ? 'pending' : call.status,
      ...(call.error?.trim() ? { error: call.error.trim() } : {}),
    }]
  })
  if (!toolSteps.length) return steps
  // 工具调用可能一条一条到达（流式）。已有的调用就地更新状态、保持原位；
  // 新调用接在最后一条工具步骤之后，否则实时轨迹会倒序显示，
  // 直到轮次结束被整批更新纠正。
  const incomingById = new Map(toolSteps.map((step) => [step.id, step]))
  const existingIds = new Set(steps.map((step) => step.id))
  const updated = steps.map((step) => incomingById.get(step.id) ?? step)
  const appended = toolSteps.filter((step) => !existingIds.has(step.id))
  if (!appended.length) return updated
  const lastToolIndex = updated.reduce(
    (last, step, index) => step.id.startsWith(toolCallStepPrefix) ? index : last,
    -1,
  )
  if (lastToolIndex < 0) return insertAfterPlannerStep(updated, appended)
  return [...updated.slice(0, lastToolIndex + 1), ...appended, ...updated.slice(lastToolIndex + 1)]
}

function insertAfterPlannerStep(
  steps: BotanicAgentRuntimeStep[],
  inserted: BotanicAgentRuntimeStep[],
): BotanicAgentRuntimeStep[] {
  const replaced = new Set(inserted.map((step) => step.id))
  const base = steps.filter((step) => !replaced.has(step.id))
  const plannerIndex = base.findIndex((step) => step.id === 'call-planner')
  if (plannerIndex < 0) return [...base, ...inserted]
  return [...base.slice(0, plannerIndex + 1), ...inserted, ...base.slice(plannerIndex + 1)]
}

const liveReasoningStepPrefix = 'reasoning:live:'
/** 实时推理只保留尾部，避免长思维链把运行轨迹撑成日志墙。 */
export const botanicAgentLiveReasoningLimit = 600

/**
 * 流式推理增量。同一步的增量追加到同一条步骤上，轮次收束后由最终片段替换。
 * 这条步骤只活在组件状态里，不写入消息、计划或 Artifact Index。
 */
export function appendBotanicAgentReasoningDelta(
  steps: BotanicAgentRuntimeStep[],
  step: number,
  delta: string,
): BotanicAgentRuntimeStep[] {
  if (!delta) return steps
  const id = `${liveReasoningStepPrefix}${step}`
  const existing = steps.find((item) => item.id === id)
  if (existing) {
    const detail = `${existing.detail}${delta}`.slice(-botanicAgentLiveReasoningLimit)
    return steps.map((item) => item.id === id ? { ...item, detail } : item)
  }
  return insertAfterPlannerStep(steps, [{
    id,
    kind: 'plan',
    label: '模型运行说明',
    detail: delta.slice(-botanicAgentLiveReasoningLimit),
    status: 'running',
  }])
}

/**
 * 把当轮运行说明补进轨迹。summary 片段已经由工具步骤承载，这里只补提供方原始推理——
 * 它默认关闭，即使打开也只活在这一轮的组件状态里，不写入消息、计划或 Artifact Index。
 * 收到最终片段时同时清掉流式过程中的临时步骤，避免同一段推理出现两次。
 */
export function insertBotanicAgentReasoningSteps(
  steps: BotanicAgentRuntimeStep[],
  entries: BotanicAgentReasoningEntry[],
): BotanicAgentRuntimeStep[] {
  const reasoningSteps = entries.flatMap((entry, index): BotanicAgentRuntimeStep[] => {
    const text = entry.source === 'raw' ? entry.text.trim() : ''
    if (!text) return []
    return [{
      id: `reasoning:${entry.step}:${index}`,
      kind: 'plan',
      label: '模型运行说明',
      detail: text,
      status: 'succeeded',
    }]
  })
  if (!reasoningSteps.length) return steps
  return insertAfterPlannerStep(steps.filter((step) => !step.id.startsWith(liveReasoningStepPrefix)), reasoningSteps)
}

export function updateBotanicAgentRuntimeStep(
  steps: BotanicAgentRuntimeStep[],
  stepId: string,
  status: BotanicAgentRuntimeStep['status'],
  now = Date.now(),
  error?: string,
): BotanicAgentRuntimeStep[] {
  return steps.map((step) => {
    if (step.id !== stepId) return step
    return {
      ...step,
      status,
      ...(status === 'running' ? { startedAt: step.startedAt ?? now, error: undefined } : {}),
      ...(status === 'succeeded' || status === 'failed' ? { completedAt: now } : {}),
      ...(error ? { error } : {}),
    }
  })
}

export type BotanicAgentRuntimePhase =
  | 'idle'
  | 'reading'
  | 'planning'
  | 'waiting_clarification'
  | 'waiting_confirmation'
  | 'waiting_reference'
  | 'draft_ready'
  | 'executing'
  | 'completed'
  | 'failed'

export type BotanicAgentRuntimeSummary = {
  phase: BotanicAgentRuntimePhase
  label: string
  detail: string
  nextAction: string
  completedCount: number
  totalCount: number
  progress: number
}

export type BotanicAgentRuntimeMode = 'generation' | 'conversation' | 'prompt' | 'research'

/**
 * 把多个底层步骤压缩成一个用户能理解的阶段摘要。
 * 详细步骤仍可展开查看，但默认只显示当前阶段与下一步，避免 Runtime 变成日志墙。
 * 摘要按本轮路由取词：对话、Prompt 与检索轮次不会谎称“结果已回填画布”。
 */
export function summarizeBotanicAgentRuntime(input: {
  steps: BotanicAgentRuntimeStep[]
  phase: BotanicAgentRuntimePhase
  mode?: BotanicAgentRuntimeMode
}): BotanicAgentRuntimeSummary {
  const totalCount = input.steps.length
  const completedCount = input.steps.filter((step) => step.status === 'succeeded').length
  const progress = totalCount ? Math.round((completedCount / totalCount) * 100) : 0
  const activeStep = input.steps.find((step) => step.status === 'running')
  const phaseCopy: Record<BotanicAgentRuntimePhase, Pick<BotanicAgentRuntimeSummary, 'label' | 'detail' | 'nextAction'>> = {
    idle: {
      label: '等待创作要求',
      detail: '描述目标，Agent 会先读取上下文，再决定是否需要追问。',
      nextAction: '输入需求',
    },
    reading: {
      label: activeStep?.label ?? '读取创作上下文',
      detail: activeStep?.detail ?? '正在读取当前画布、参考素材与项目记忆。',
      nextAction: '等待读取完成',
    },
    planning: {
      label: activeStep?.label ?? '正在制定计划',
      detail: activeStep?.detail ?? '正在整理目标、锁定项与输出设置。',
      nextAction: '等待计划',
    },
    waiting_clarification: {
      label: '等待你补充设置',
      detail: '补充交付规格或创作方向后，Agent 才会继续整理。',
      nextAction: '选择设置',
    },
    waiting_confirmation: {
      label: '等待你确认计划',
      detail: '检查提示词与输出设置；确认后开始生成。',
      nextAction: '确认生成',
    },
    waiting_reference: {
      label: '等待参考图片',
      detail: '添加或 @ 引用一张图片后再继续；当前不会创建空节点。',
      nextAction: '添加参考图片',
    },
    draft_ready: {
      label: '生成草稿已创建',
      detail: '可编辑节点已写入画布，尚未提交生成任务。',
      nextAction: '检查并生成',
    },
    executing: {
      label: '生成任务处理中',
      detail: '任务已提交，结果完成后会直接回填画布。',
      nextAction: '查看任务',
    },
    completed: {
      label: 'Agent 已完成',
      detail: '结果已回填画布，可以继续修改或定位结果。',
      nextAction: '继续修改',
    },
    failed: {
      label: 'Agent 运行未完成',
      detail: '已保留失败位置；可以修改要求或重试当前任务。',
      nextAction: '查看并重试',
    },
  }
  const mode = input.mode ?? 'generation'
  const nonGenerationCopy: Partial<Record<BotanicAgentRuntimePhase, Pick<BotanicAgentRuntimeSummary, 'label' | 'detail' | 'nextAction'>>> = mode === 'generation'
    ? {}
    : {
      idle: {
        label: '等待你的问题',
        detail: mode === 'research' ? '描述要查的内容，Agent 只回答项目内可核对的事实。' : '可以直接提问，也可以让我先写一段 Prompt。',
        nextAction: '输入问题',
      },
      completed: mode === 'prompt'
        ? { label: 'Prompt 已生成', detail: '可以直接复制使用，或让我按这段 Prompt 生成。', nextAction: '用这段 Prompt 生成' }
        : mode === 'research'
          ? { label: '检索完成', detail: '已列出命中的项目资料与来源。', nextAction: '继续追问' }
          : { label: '已回复', detail: '可以继续追问，或描述创作目标进入生成。', nextAction: '继续对话' },
    }
  return {
    phase: input.phase,
    ...phaseCopy[input.phase],
    ...nonGenerationCopy[input.phase],
    completedCount,
    totalCount,
    progress,
  }
}

const botanicAgentRuntimeFeedPhases = new Set<BotanicAgentRuntimePhase>([
  'reading', 'planning', 'waiting_clarification', 'waiting_confirmation',
  'waiting_reference', 'draft_ready', 'executing', 'failed',
])

/**
 * 底部运行卡只描述“这一轮还没收束”的规划/生成过程。
 * 对话流式时同一段回答已经在气泡里出现，不再另开一张“组织回答”卡。
 */
export function shouldShowBotanicAgentRuntimeFeed(input: {
  runtimePhase: BotanicAgentRuntimePhase
  hasRuntimeSteps: boolean
  hasLiveConversation: boolean
  runBranchCount?: number
}): boolean {
  if (input.hasLiveConversation) return false
  if (!input.hasRuntimeSteps) return false
  if (!botanicAgentRuntimeFeedPhases.has(input.runtimePhase)) return false
  if ((input.runBranchCount ?? 0) > 0 && input.runtimePhase === 'executing') return false
  return true
}

/**
 * Agent 只有拿到可用图片参考时才允许创建生成工作流。
 * 该领域规则避免对话、文字说明、视频或空结果被误转成空白生成节点。
 */
export function resolveBotanicAgentWorkflowReferenceNodeIds(
  nodes: CanvasNode[],
  contextNodeIds: string[],
): string[] {
  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  return [...new Set(contextNodeIds)].filter((nodeId) => {
    const node = nodesById.get(nodeId)
    if (node?.type === 'asset') {
      const data = node.data as AssetNodeData
      return Boolean(data.image) && (data.mediaKind ?? 'image') === 'image'
    }
    if (node?.type === 'result') {
      const data = node.data as ResultNodeData
      return Boolean(data.image) && (data.mediaKind ?? 'image') === 'image'
    }
    return false
  })
}

/** 仍在进行的 Run 才需要在面板底部恢复实时进度；已结束的 Run 由对话内的状态消息承载。 */
export function shouldRestoreBotanicAgentRuntimeSteps(status: BotanicAgentRunStatus) {
  return status === 'queued' || status === 'running' || status === 'executing'
}

/**
 * 从持久化 Run 快照恢复一条可理解的运行时间线。
 * 时间线不是服务端事实，只是把已持久化的任务状态映射成 UI 进度，
 * 因此刷新或跨设备打开时不会假装重放模型内部过程。
 */
export function restoreBotanicAgentRuntimeSteps(input: {
  run: Pick<BotanicAgentRun, 'status'>
  hasTarget: boolean
  referenceCount?: number
  memoryCount?: number
  assetGroupCount?: number
  plannerLabel?: string
}): BotanicAgentRuntimeStep[] {
  const steps = createBotanicAgentRuntimeSteps({
    hasTarget: input.hasTarget,
    referenceCount: input.referenceCount,
    memoryCount: input.memoryCount,
    assetGroupCount: input.assetGroupCount,
    plannerLabel: input.plannerLabel,
  })
  const finalStepId = input.hasTarget ? 'finalize-plan' : 'create-workflow'
  const active = input.run.status === 'queued' || input.run.status === 'running' || input.run.status === 'executing'
  const failed = input.run.status === 'failed' || input.run.status === 'cancelled'
  return steps.map((step) => {
    if (step.id === finalStepId) {
      return {
        ...step,
        status: failed ? 'failed' : active ? 'running' : 'succeeded',
        detail: active ? '任务已恢复，正在等待生成结果' : failed ? '任务已结束，可查看失败原因或重试' : '任务已完成，结果已回填画布',
        ...(failed ? { error: input.run.status === 'cancelled' ? '任务已取消。' : '任务未完成，请查看任务面板。' } : {}),
      }
    }
    // 上下文与规划步骤在 Run 落库时必然已经完成，无论 Run 最终成败。
    return {
      ...step,
      status: 'succeeded',
      detail: `${step.detail} · 已从服务端恢复`,
    }
  })
}

function stableAgentPlanHash(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

/** 同一确认消息与同一计划始终复用同一个提交键，防止网络重试产生重复 Run。 */
export function botanicAgentSubmissionKey(messageId: string, plan: Pick<BotanicAgentPlan, 'instruction' | 'prompt' | 'settings' | 'output' | 'selectedResultNodeId' | 'contextSnapshot'>) {
  const safeMessageId = messageId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64) || 'message'
  const fingerprint = JSON.stringify({
    instruction: plan.instruction,
    prompt: plan.prompt,
    settings: plan.settings,
    output: plan.output,
    selectedResultNodeId: plan.selectedResultNodeId,
    contextNodeIds: [...new Set(plan.contextSnapshot?.map((item) => item.nodeId).filter(Boolean) ?? [])].sort(),
  })
  return `agent-plan-${safeMessageId}-${stableAgentPlanHash(fingerprint)}`
}

export type BotanicAgentArtifactKind = 'image' | 'video' | 'text' | 'workflow' | 'asset_group' | 'file'

/**
 * Artifact 自己声明落点。'panel' 只进结果面板与 Artifact Index，'canvas' 才允许创建节点。
 * 缺省时按媒体落画布、文本留面板，避免 Skill 规则、MCP 文本被当成创作素材写进画布。
 */
export type BotanicAgentArtifactPlacement = 'canvas' | 'panel'

export type BotanicAgentArtifact = {
  id: string
  kind: BotanicAgentArtifactKind
  label: string
  content?: string
  url?: string
  mimeType?: string
  placement?: BotanicAgentArtifactPlacement
  metadata?: Record<string, unknown>
  provenance: {
    actionId: string
    toolName: string
    runId?: string
    externalTool?: string
    sourceNodeIds?: string[]
  }
}

export type BotanicAgentArtifactOrigin = {
  type: 'agent_action' | 'generation_output'
  sessionId?: string
  messageId?: string
  actionId?: string
  jobId?: string
  outputId?: string
}

export type BotanicIndexedArtifact = BotanicAgentArtifact & {
  origin: BotanicAgentArtifactOrigin
  createdAt: number
  updatedAt: number
}

export type BotanicAgentCanvasCommand =
  | { id: string; type: 'create_text_node' | 'create_media_node'; artifactId: string }
  | { id: string; type: 'connect_nodes'; sourceNodeId: string; targetNodeId: string }
  | { id: string; type: 'focus_node'; nodeId: string }

export type BotanicAgentActionResult = {
  message: string
  writeback?: { kind: 'text'; label: string; content: string }
  canvasNodeId?: string
  canvasNodeIds?: string[]
  /** 服务端已持久化的工作流增量；客户端先落本地视图，再提交真实生成任务。 */
  canvasPatch?: {
    nodes: CanvasNode[]
    edges: CanvasDocument['edges']
    updatedAt: number
    revision: number
    graphRevision: number
  }
  artifacts?: BotanicAgentArtifact[]
  canvasCommands?: BotanicAgentCanvasCommand[]
}

/** 同一行动的成功回执跨双击、重试和多端重放只保留一条消息。 */
export function botanicAgentActionReceiptMessageId(actionId: string) {
  const stableActionId = actionId.trim().replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 120) || 'unknown'
  return `agent-message-action-${stableActionId}`
}

function canvasEdgeIdentity(edge: CanvasDocument['edges'][number]) {
  return `${edge.source}\u0000${edge.sourceHandle ?? ''}\u0000${edge.target}\u0000${edge.targetHandle ?? ''}`
}

/**
 * 合并服务端已落盘的 Agent 工作流。已有节点保留用户布局与选择态，节点数据和
 * 新连线来自服务端权威增量；按语义去重连线，兼容旧版本不同的 edge id。
 */
export function mergeBotanicAgentCanvasPatch(
  document: CanvasDocument,
  patch: NonNullable<BotanicAgentActionResult['canvasPatch']>,
): CanvasDocument {
  const nodes = [...document.nodes]
  for (const incoming of patch.nodes) {
    const index = nodes.findIndex((node) => node.id === incoming.id)
    if (index < 0) {
      nodes.push({ ...incoming, selected: false } as CanvasNode)
      continue
    }
    const current = nodes[index]
    nodes[index] = {
      ...current,
      ...incoming,
      position: current.position,
      selected: current.selected,
      data: { ...current.data, ...incoming.data },
    } as CanvasNode
  }

  const nodeIds = new Set(nodes.map((node) => node.id))
  const edges = [...document.edges]
  const edgeIds = new Set(edges.map((edge) => edge.id))
  const edgeIdentities = new Set(edges.map(canvasEdgeIdentity))
  for (const edge of patch.edges) {
    const identity = canvasEdgeIdentity(edge)
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target) || edgeIds.has(edge.id) || edgeIdentities.has(identity)) continue
    edges.push(edge)
    edgeIds.add(edge.id)
    edgeIdentities.add(identity)
  }
  return { ...document, nodes, edges, updatedAt: Math.max(document.updatedAt, patch.updatedAt) }
}

export type BotanicAgentActionProposal = {
  id: string
  kind: 'skill' | 'mcp'
  toolName: 'skill_apply' | 'skill_create' | 'mcp_call'
  label: string
  summary: string
  risk: 'write' | 'external'
  arguments: Record<string, unknown>
  status: 'awaiting_confirmation' | 'running' | 'succeeded' | 'failed' | 'dismissed'
  error?: string
  result?: BotanicAgentActionResult
}

export type ResolvedBotanicAgentCanvasCommand = {
  artifact: BotanicAgentArtifact
  command: Extract<BotanicAgentCanvasCommand, { type: 'create_text_node' | 'create_media_node' }>
}

export type BotanicAgentCanvasWriteback = {
  artifactId: string
  nodeId: string
}

function safeAgentArtifactUrl(value?: string) {
  if (!value || value.length > 2048) return false
  if (value.startsWith('/api/media/')) return true
  try { return new URL(value).protocol === 'https:' } catch { return false }
}

export function botanicAgentArtifactPlacement(artifact: Pick<BotanicAgentArtifact, 'kind' | 'placement'>): BotanicAgentArtifactPlacement {
  if (artifact.placement) return artifact.placement
  return artifact.kind === 'image' || artifact.kind === 'video' ? 'canvas' : 'panel'
}

/**
 * 只有显式落点为 canvas 的 Artifact 才会创建节点。文字与工作流产物默认留在结果面板，
 * 旧版 writeback 也不再兜底生成文字节点——它仍会进入 Artifact Index，不丢历史。
 */
export function resolveBotanicAgentCanvasCommands(result: BotanicAgentActionResult): ResolvedBotanicAgentCanvasCommand[] {
  if (!result.artifacts?.length || !result.canvasCommands?.length) return []
  const artifacts = new Map(result.artifacts.map((artifact) => [artifact.id, artifact]))
  return result.canvasCommands.flatMap((command): ResolvedBotanicAgentCanvasCommand[] => {
    if (command.type !== 'create_text_node' && command.type !== 'create_media_node') return []
    const artifact = artifacts.get(command.artifactId)
    if (!artifact || botanicAgentArtifactPlacement(artifact) !== 'canvas') return []
    const textCompatible = command.type === 'create_text_node'
      && (artifact.kind === 'text' || artifact.kind === 'workflow')
      && Boolean(artifact.content?.trim())
    const mediaCompatible = command.type === 'create_media_node'
      && (artifact.kind === 'image' || artifact.kind === 'video')
      && safeAgentArtifactUrl(artifact.url)
    return textCompatible || mediaCompatible ? [{ artifact, command }] : []
  })
}

export function recordBotanicAgentCanvasWritebacks(
  result: BotanicAgentActionResult,
  writebacks: BotanicAgentCanvasWriteback[],
): BotanicAgentActionResult {
  const nodeIdsByArtifact = new Map<string, string[]>()
  const canvasNodeIds: string[] = []
  writebacks.forEach(({ artifactId, nodeId }) => {
    const cleanArtifactId = artifactId.trim()
    const cleanNodeId = nodeId.trim()
    if (!cleanArtifactId || !cleanNodeId) return
    const artifactNodeIds = nodeIdsByArtifact.get(cleanArtifactId) ?? []
    if (!artifactNodeIds.includes(cleanNodeId)) artifactNodeIds.push(cleanNodeId)
    nodeIdsByArtifact.set(cleanArtifactId, artifactNodeIds)
    if (!canvasNodeIds.includes(cleanNodeId)) canvasNodeIds.push(cleanNodeId)
  })
  if (!canvasNodeIds.length) return result

  return {
    ...result,
    canvasNodeId: canvasNodeIds[0],
    canvasNodeIds,
    artifacts: result.artifacts?.map((artifact) => {
      const nodeIds = nodeIdsByArtifact.get(artifact.id)
      if (!nodeIds?.length) return artifact
      return {
        ...artifact,
        provenance: {
          ...artifact.provenance,
          sourceNodeIds: [...new Set([...(artifact.provenance.sourceNodeIds ?? []), ...nodeIds])],
        },
      }
    }),
  }
}

export type BotanicAgentPlan = {
  plannerModel?: string
  intent: BotanicAgentIntent
  instruction: string
  summary: string
  /** 画布新图名；只概括变化，不超过 8 个字，不复述锁定项或比例。 */
  title?: string
  /** 本轮生成前已确认的结构化创意简报；用于解释、刷新恢复与后续继续修改。 */
  creativeBrief?: BotanicCreativeBrief
  selectedResultNodeId?: string
  /**
   * 提交时锁定的画布上下文。只保存可解释的节点元数据，不携带图片地址或媒体内容，
   * 让异步任务、刷新和跨设备恢复时仍能知道这次请求基于哪些输入。
   */
  contextSnapshot?: BotanicAgentContextSnapshot[]
  references: AgentReferenceBinding[]
  constraints: CreativeConstraint[]
  prompt: string
  settings: GenerationSettings
  output: {
    mode: 'single' | 'batch_by_asset' | 'batch_by_variation'
    count: number
    candidatesPerItem: number
  }
  /** 无素材组时按确认过的变体轴展开；张数以展开结果为准。 */
  variation?: BotanicAgentVariationSpec
  assetGroupId?: string
  rootRecipe?: GenerationRecipe
  toolCalls?: AgentToolCallTrace[]
  actions?: BotanicAgentActionProposal[]
}

/** 单条文字节点带进计划的补充描述长度上限。 */
export const botanicAgentContextNoteLimit = 500

export type BotanicAgentContextSnapshot = {
  nodeId: string
  label: string
  kind: '素材' | '结果' | '文字' | '节点'
  mediaKind?: 'image' | 'video'
  role?: string
  /** 文字节点的正文。它是可解释的创作说明，不是媒体数据，因此可以随快照持久化。 */
  note?: string
}

export type BotanicAgentContextSnapshotInput = Omit<BotanicAgentContextSnapshot, 'nodeId'> & {
  nodeId?: string
  id?: string
  /** 画布读模型里文字节点的字段名；与 note 等价。 */
  content?: string
}

/** 生成可安全持久化的上下文快照，明确排除图片 URL、Blob 和其他媒体数据。 */
export function createBotanicAgentContextSnapshot(
  items: BotanicAgentContextSnapshotInput[],
  maximum = 16,
): BotanicAgentContextSnapshot[] {
  const seen = new Set<string>()
  return items.flatMap((item) => {
    const nodeId = (item.nodeId ?? item.id ?? '').trim()
    const label = item.label.trim()
    if (!nodeId || !label || seen.has(nodeId)) return []
    seen.add(nodeId)
    const note = (item.note ?? item.content ?? '').trim().slice(0, botanicAgentContextNoteLimit)
    return [{
      nodeId,
      label,
      kind: item.kind,
      ...(item.mediaKind ? { mediaKind: item.mediaKind } : {}),
      ...(item.role?.trim() ? { role: item.role.trim() } : {}),
      ...(item.kind === '文字' && note ? { note } : {}),
    }]
  }).slice(0, maximum)
}

/**
 * 画布上的文字节点是用户写下的补充描述，把它拼进提示词，
 * 而不是让它既能进上下文、又对生成毫无影响。
 */
export function botanicAgentPromptWithContextNotes(
  instruction: string,
  contextSnapshot: BotanicAgentContextSnapshot[],
) {
  const notes = contextSnapshot.flatMap((item) => (
    item.kind === '文字' && item.note ? [`- ${item.label}：${item.note}`] : []
  ))
  return notes.length ? `${instruction}\n\n补充描述：\n${notes.join('\n')}` : instruction
}

export function botanicAgentContextSnapshotNodeIds(
  snapshot: BotanicAgentContextSnapshot[] | undefined,
  availableNodeIds?: Iterable<string>,
): string[] {
  const available = availableNodeIds ? new Set(availableNodeIds) : undefined
  return [...new Set((snapshot ?? [])
    .map((item) => item.nodeId)
    .filter((nodeId) => nodeId && (!available || available.has(nodeId))))]
}

export type BotanicAgentClarificationResponse = {
  kind: 'clarification'
  clarification: BotanicAgentClarification
  plannerModel?: string
  toolCalls?: AgentToolCallTrace[]
}

export type BotanicAgentRunStatus = 'awaiting_confirmation' | 'queued' | 'executing' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled'

export type BotanicAgentBranchStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export type BotanicAgentRunFeedbackTone = 'neutral' | 'progress' | 'success' | 'warning' | 'error'

export type BotanicAgentRunFeedbackAction = 'view_task' | 'view_results' | 'adjust' | 'none'

export type BotanicAgentRunFeedback = {
  label: string
  detail: string
  action: BotanicAgentRunFeedbackAction
  actionLabel: string
  tone: BotanicAgentRunFeedbackTone
  terminal: boolean
}

export type BotanicAgentRunFeedbackOptions = {
  /** 当前 Run 已进入 Artifact Index 的结果数。 */
  artifactCount?: number
  /** 当前 Run 已有画布来源节点的结果数。 */
  canvasOutputCount?: number
  /** 仍处于 queued/running 的分支数；只要还有活跃分支就不能说「已生成待回填」。 */
  activeBranchCount?: number
}

/**
 * 把服务端 Run 状态统一翻译成用户可执行的反馈，避免 Runtime、任务面板和消息各说一套。
 * timeout 仍由现有 failed 状态承载，兼容历史快照，不扩张持久化状态机。
 */
export function botanicAgentRunFeedback(
  status: BotanicAgentRunStatus,
  outputCount = 0,
  error?: string,
  options?: BotanicAgentRunFeedbackOptions,
): BotanicAgentRunFeedback {
  const terminal = status === 'completed' || status === 'partial' || status === 'failed' || status === 'cancelled'
  const timedOut = status === 'failed' && Boolean(error && /超时|timeout|timed out/i.test(error))
  const hasActiveBranches = (options?.activeBranchCount ?? 0) > 0
  if (hasActiveBranches && status === 'completed') {
    return { label: '生成中', detail: '正在生成，完成后回填画布。', action: 'view_task', actionLabel: '查看任务', tone: 'progress', terminal: false }
  }
  if (status === 'awaiting_confirmation') {
    return { label: '待确认', detail: '确认后开始生成。', action: 'view_task', actionLabel: '查看计划', tone: 'warning', terminal: false }
  }
  if (status === 'queued') {
    return { label: '排队中', detail: '已入队，等待生成。', action: 'view_task', actionLabel: '查看任务', tone: 'progress', terminal: false }
  }
  if (status === 'executing' || status === 'running') {
    return { label: '生成中', detail: '正在生成，完成后回填画布。', action: 'view_task', actionLabel: '查看任务', tone: 'progress', terminal: false }
  }
  if (status === 'completed') {
    if (outputCount > 0 && options && (options.artifactCount ?? 0) === 0) {
      return { label: '已完成', detail: '已完成，结果整理中。', action: 'view_task', actionLabel: '查看任务', tone: 'warning', terminal }
    }
    if (outputCount > 0 && options && (options.canvasOutputCount ?? 0) < (options.artifactCount ?? 0)) {
      return { label: '已完成', detail: '结果已生成，正在回填画布。', action: 'view_results', actionLabel: '查看结果', tone: 'warning', terminal }
    }
    return outputCount > 0
      ? { label: '已完成', detail: `已回填画布 · ${outputCount} 项`, action: 'view_results', actionLabel: '查看结果', tone: 'success', terminal }
      : { label: '已完成', detail: '已完成，暂无可用结果。', action: 'view_task', actionLabel: '查看任务', tone: 'warning', terminal }
  }
  if (status === 'partial') {
    return { label: '部分完成', detail: `已回填 ${outputCount} 项，有分支失败。`, action: 'view_task', actionLabel: '查看失败分支', tone: 'warning', terminal }
  }
  if (status === 'cancelled') {
    return { label: '已取消', detail: `已取消，保留 ${outputCount} 项结果。`, action: 'adjust', actionLabel: '调整后重试', tone: 'warning', terminal }
  }
  return timedOut
    ? { label: '响应超时', detail: '生成超时，可调整后重试。', action: 'adjust', actionLabel: '调整后重试', tone: 'error', terminal }
    : { label: '生成失败', detail: outputCount ? `未完成，已保留 ${outputCount} 项。` : '任务未完成，可调整后重试。', action: 'adjust', actionLabel: '调整后重试', tone: 'error', terminal }
}

export function botanicAgentBranchStatusLabel(status: BotanicAgentBranchStatus) {
  if (status === 'succeeded') return '已完成'
  if (status === 'running') return '生成中'
  if (status === 'queued') return '排队中'
  if (status === 'cancelled') return '已取消'
  return '失败'
}

/**
 * 判断一次持久化 Run 恢复是否可能带来新的画布结果。
 * 只在终态首次出现或终态快照变新时触发，避免 4 秒轮询反复对账。
 */
export function shouldRecoverAgentRunResults(
  current: Pick<BotanicAgentRun, 'status' | 'updatedAt'> | undefined,
  incoming: Pick<BotanicAgentRunSnapshot, 'status' | 'updatedAt'>,
) {
  if (incoming.status !== 'completed' && incoming.status !== 'partial') return false
  if (!current) return true
  if (current.status !== 'completed' && current.status !== 'partial') return true
  return incoming.updatedAt > current.updatedAt
}

/**
 * 用户已确认后，Run 会先持久化，再幂等提交生成任务。如果页面在
 * 两步之间关闭，恢复器只对“仍排队且从未绑定 Job”的 Run 补做
 * 幂等执行；已绑定 Job 的正常排队任务不会重复提交。
 */
export function shouldResumeQueuedAgentRunExecution(
  run: Pick<BotanicAgentRunSnapshot, 'status' | 'branches'>,
) {
  return run.status === 'queued'
    && run.branches.length > 0
    && run.branches.every((branch) => !branch.activeJobId && branch.jobIds.length === 0)
}

export type BotanicAgentRunBranch = {
  id: string
  label: string
  assetId?: string
  variation?: BotanicAgentBranchVariation
  status: BotanicAgentBranchStatus
  attempt: number
  jobIds: string[]
  activeJobId?: string
  outputCount: number
  error?: string
  updatedAt: number
}

export type BotanicAgentRunSnapshot = {
  id: string
  projectId: string
  status: Exclude<BotanicAgentRunStatus, 'awaiting_confirmation' | 'executing'>
  plan?: Omit<BotanicAgentPlan, 'references' | 'rootRecipe' | 'actions'>
  branches: BotanicAgentRunBranch[]
  completedBranchCount: number
  failedBranchCount: number
  createdAt: number
  updatedAt: number
}

export type BotanicAgentRun = {
  id: string
  status: BotanicAgentRunStatus
  plan: BotanicAgentPlan
  createdAt: number
  updatedAt: number
  error?: string
  branches: BotanicAgentRunBranch[]
  completedBranchCount: number
  failedBranchCount: number
}

export type BotanicAgentExecutionMode = 'manual' | 'auto'

export type BotanicAgentExecutionDecision =
  /** 输出设置仍然缺项，两种模式都必须先问清楚，不猜测会产生费用的参数。 */
  | { action: 'ask_settings' }
  /** 计划里还有需要人工确认的外部行动，自动模式在此降级为手动。 */
  | { action: 'confirm'; reason: 'manual' | 'pending_actions' }
  | { action: 'auto_submit' }

/**
 * 执行模式的唯一判定处。计划模式与自动模式的差别在这里成为可解释的结论，
 * 而不是散落在界面里的若干 if：自动模式会自己补全可推断的输出设置并直接提交，
 * 但遇到外部行动仍然停下来，且降级原因可以被界面读出来告诉用户。
 */
export function resolveBotanicAgentExecutionDecision(input: {
  mode: BotanicAgentExecutionMode
  settingsComplete: boolean
  pendingActionCount: number
}): BotanicAgentExecutionDecision {
  if (!input.settingsComplete) return { action: 'ask_settings' }
  if (input.pendingActionCount > 0) return { action: 'confirm', reason: 'pending_actions' }
  return input.mode === 'auto' ? { action: 'auto_submit' } : { action: 'confirm', reason: 'manual' }
}

export function botanicAgentExecutionModeLabel(mode: BotanicAgentExecutionMode) {
  return mode === 'auto' ? '自动模式' : '计划模式'
}

/** 已审核 Skill 只注入本轮约束，不单独占用一次确认。 */
export function botanicAgentActionRequiresUserConfirmation(
  action: Pick<BotanicAgentActionProposal, 'toolName' | 'status'>,
): boolean {
  if (action.toolName === 'skill_apply') return false
  return action.status === 'awaiting_confirmation' || action.status === 'running'
}

export function botanicAgentPendingConfirmationCount(actions?: BotanicAgentActionProposal[]): number {
  return actions?.filter((action) => botanicAgentActionRequiresUserConfirmation(action)).length ?? 0
}

export function botanicAgentAppliedSkillName(action: Pick<BotanicAgentActionProposal, 'label'>): string {
  const name = action.label.replace(/^(应用\s*)?Skill\s*[：:·]\s*/u, '').trim()
  return name || '已应用'
}

export type BotanicAgentMemoryKind = 'rule' | 'approved' | 'avoid'

export type BotanicAgentMemoryItem = {
  id: string
  kind: BotanicAgentMemoryKind
  content: string
  sourceNodeIds: string[]
  createdAt: number
  updatedAt: number
}

export type BotanicAgentSkill = {
  id: string
  projectId: string
  name: string
  instructions: string
  status: 'active' | 'archived'
  createdAt: number
  updatedAt: number
}

export type BotanicAgentSkillCatalogItem = {
  id: string
  name: string
  instructions: string
  source: 'system' | 'project'
}

export type BotanicAgentMessage = {
  id: string
  role: 'user' | 'assistant'
  kind: 'text' | 'question' | 'plan' | 'run' | 'notice'
  content: string
  /** Prompt 对话产出的结构化结果；普通助手文字不能被当作生图 Prompt。 */
  prompt?: string
  createdAt: number
  /** 消息自身的版本时间；旧文档缺省时由 append/服务端回退到 createdAt。 */
  updatedAt?: number
  plan?: BotanicAgentPlan
  question?: BotanicAgentClarification
  runId?: string
  status?: 'pending' | 'answered' | 'submitted' | 'failed'
  feedback?: 'positive' | 'negative'
  /** 只用于本地离线送达状态；服务端权威消息不依赖该字段。 */
  deliveryStatus?: 'waiting_network' | 'queued' | 'syncing' | 'synced' | 'failed'
}

export type BotanicAgentSession = {
  id: string
  title: string
  executionMode: BotanicAgentExecutionMode
  /** 会话级 Agent 规划模型；旧会话缺省时由客户端使用默认模型。 */
  plannerModel?: string
  /** 会话级已挂载 Skill；只保存 ID，规则仍由服务端按项目权限解析。 */
  mountedSkillIds?: string[]
  contextNodeIds: string[]
  messages: BotanicAgentMessage[]
  /** 最近一次稳定阅读到的消息；用于切换设备或重新打开会话后恢复视图。 */
  readingAnchorMessageId?: string
  readingAnchorUpdatedAt?: number
  createdAt: number
  updatedAt: number
}

export type BotanicAgentRunTimelineItem = {
  run: BotanicAgentRun
  source?: { sessionId: string; sessionTitle: string; messageId: string }
}

/**
 * Run 是任务状态权威；Session 只补充“从哪段对话发起”的导航信息。
 * 时间线始终按 Run 的服务端更新时间排序，不受各 Adapter 返回顺序影响。
 */
export function buildBotanicAgentRunTimeline(
  runs: BotanicAgentRun[],
  sessions: BotanicAgentSession[],
): BotanicAgentRunTimelineItem[] {
  const sourceByRunId = new Map<string, BotanicAgentRunTimelineItem['source']>()
  const newestSessions = [...sessions].sort((left, right) => right.updatedAt - left.updatedAt)
  for (const session of newestSessions) {
    const newestMessages = [...session.messages].sort((left, right) => (
      (right.updatedAt ?? right.createdAt) - (left.updatedAt ?? left.createdAt)
    ))
    for (const message of newestMessages) {
      if (!message.runId || sourceByRunId.has(message.runId)) continue
      sourceByRunId.set(message.runId, {
        sessionId: session.id,
        sessionTitle: session.title,
        messageId: message.id,
      })
    }
  }
  return [...runs]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map((run) => ({ run, source: sourceByRunId.get(run.id) }))
}

export type BotanicAgentRunTimelineFilter = 'all' | 'active' | 'completed' | 'attention'

export function filterBotanicAgentRunTimeline(
  timeline: BotanicAgentRunTimelineItem[],
  filter: BotanicAgentRunTimelineFilter,
): BotanicAgentRunTimelineItem[] {
  if (filter === 'all') return timeline
  const activeStatuses = new Set<BotanicAgentRunStatus>(['awaiting_confirmation', 'queued', 'executing', 'running'])
  const attentionStatuses = new Set<BotanicAgentRunStatus>(['partial', 'failed', 'cancelled'])
  return timeline.filter(({ run }) => {
    if (filter === 'active') return activeStatuses.has(run.status)
    if (filter === 'completed') return run.status === 'completed'
    return attentionStatuses.has(run.status)
  })
}

export type BotanicAgentSessionTimelineItem = {
  session: BotanicAgentSession
  preview: string
  updatedAt: number
  runCount: number
  activeRunCount: number
  unreadRunCount: number
  unreadResultCount: number
  attentionRunCount: number
  searchText: string
}

export type BotanicAgentSessionTimelineFilter = 'all' | 'unread' | 'results' | 'attention'

/**
 * 对话历史使用消息自身版本时间排序；Run 只补充任务摘要，不反向修改会话。
 * 这样跨设备增量合并后，即使会话外层 updatedAt 尚未刷新，最近对话仍会回到顶部。
 */
export function buildBotanicAgentSessionTimeline(
  sessions: BotanicAgentSession[],
  runs: BotanicAgentRun[],
): BotanicAgentSessionTimelineItem[] {
  const runTimeline = buildBotanicAgentRunTimeline(runs, sessions)
  const runsBySessionId = new Map<string, BotanicAgentRun[]>()
  for (const item of runTimeline) {
    if (!item.source) continue
    const linked = runsBySessionId.get(item.source.sessionId) ?? []
    linked.push(item.run)
    runsBySessionId.set(item.source.sessionId, linked)
  }
  return sessions.map((session) => {
    const messages = [...session.messages].sort((left, right) => (
      (right.updatedAt ?? right.createdAt) - (left.updatedAt ?? left.createdAt)
    ))
    const latestMessage = messages[0]
    const linkedRuns = runsBySessionId.get(session.id) ?? []
    const readingBaseline = session.readingAnchorUpdatedAt
    const unreadRuns = readingBaseline === undefined
      ? []
      : linkedRuns.filter((run) => run.updatedAt > readingBaseline)
    return {
      session,
      preview: latestMessage?.content.trim() || '还没有消息',
      updatedAt: Math.max(session.updatedAt, latestMessage?.updatedAt ?? latestMessage?.createdAt ?? 0),
      runCount: linkedRuns.length,
      activeRunCount: linkedRuns.filter((run) => ['queued', 'running', 'executing'].includes(run.status)).length,
      unreadRunCount: unreadRuns.length,
      unreadResultCount: unreadRuns.filter((run) => (
        (run.status === 'completed' || run.status === 'partial') && run.completedBranchCount > 0
      )).length,
      attentionRunCount: linkedRuns.filter((run) => ['partial', 'failed', 'cancelled'].includes(run.status)).length,
      searchText: [
        session.title,
        ...session.messages.map((message) => message.content),
        ...linkedRuns.map((run) => run.plan.summary),
      ].join('\n').toLocaleLowerCase(),
    }
  }).sort((left, right) => right.updatedAt - left.updatedAt)
}

export function filterBotanicAgentSessionTimeline(
  timeline: BotanicAgentSessionTimelineItem[],
  query: string,
  filter: BotanicAgentSessionTimelineFilter = 'all',
): BotanicAgentSessionTimelineItem[] {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized && filter === 'all') return timeline
  return timeline.filter((item) => {
    if (normalized && !item.searchText.includes(normalized)) return false
    if (filter === 'unread') return item.unreadRunCount > 0
    if (filter === 'results') return item.unreadResultCount > 0
    if (filter === 'attention') return item.attentionRunCount > 0
    return true
  })
}

export type BotanicAgentMentionQuery = {
  start: number
  end: number
  query: string
}

function uniqueIds(ids: string[]) {
  return [...new Set(ids.filter(Boolean))]
}

export function createBotanicAgentMemoryItem(input: {
  id?: string
  now?: number
  kind: BotanicAgentMemoryKind
  content: string
  sourceNodeIds?: string[]
}): BotanicAgentMemoryItem {
  const now = input.now ?? Date.now()
  const content = input.content.trim().replace(/\s+/g, ' ')
  if (!content) throw new Error('项目记忆不能为空。')
  return {
    id: input.id ?? `agent-memory-${crypto.randomUUID()}`,
    kind: input.kind,
    content,
    sourceNodeIds: uniqueIds(input.sourceNodeIds ?? []),
    createdAt: now,
    updatedAt: now,
  }
}

export function readBotanicAgentMentionQuery(value: string, caret: number): BotanicAgentMentionQuery | undefined {
  const safeCaret = Math.max(0, Math.min(value.length, caret))
  const match = value.slice(0, safeCaret).match(/@([^\s@]*)$/u)
  if (!match || match.index === undefined) return undefined
  return { start: match.index, end: safeCaret, query: match[1] }
}

export function insertBotanicAgentMention(
  value: string,
  mention: BotanicAgentMentionQuery,
  label: string,
): { value: string; caret: number } {
  const inserted = `@${label.trim()} `
  return {
    value: `${value.slice(0, mention.start)}${inserted}${value.slice(mention.end)}`,
    caret: mention.start + inserted.length,
  }
}

export function collectBotanicAgentArtifacts(sessions: BotanicAgentSession[]): BotanicAgentArtifact[] {
  const artifacts = new Map<string, BotanicAgentArtifact>()
  const newestFirst = [...sessions].sort((left, right) => right.updatedAt - left.updatedAt)
  for (const session of newestFirst) {
    for (const message of [...session.messages].reverse()) {
      for (const action of [...(message.plan?.actions ?? [])].reverse()) {
        for (const artifact of [...(action.result?.artifacts ?? [])].reverse()) {
          if (!artifacts.has(artifact.id)) artifacts.set(artifact.id, artifact)
        }
      }
    }
  }
  return [...artifacts.values()]
}

/**
 * Artifact Index 是历史权威读模型；当前画布读模型只补充尚未完成服务端写入的新产物。
 * 这样旧节点被删除后仍可查看历史，同时索引暂不可用时结果区不会空白。
 */
export function mergeBotanicAgentArtifactIndex(
  indexedArtifacts: BotanicIndexedArtifact[],
  localArtifacts: BotanicAgentArtifact[],
): BotanicAgentArtifact[] {
  const artifacts = new Map<string, BotanicAgentArtifact>()
  const localById = new Map(localArtifacts.map((artifact) => [artifact.id, artifact]))
  for (const artifact of indexedArtifacts) {
    if (artifact.origin.type === 'generation_output' && !artifact.provenance.runId) continue
    const localArtifact = localById.get(artifact.id)
    const sourceNodeIds = uniqueIds([
      ...(artifact.provenance.sourceNodeIds ?? []),
      ...(localArtifact?.provenance.sourceNodeIds ?? []),
    ])
    if (!artifacts.has(artifact.id)) artifacts.set(artifact.id, {
      ...artifact,
      // 索引条目的时间落进 metadata，读模型才有统一可排序的时间戳。
      metadata: { createdAt: artifact.createdAt, ...artifact.metadata },
      provenance: { ...artifact.provenance, sourceNodeIds },
    })
  }
  for (const artifact of localArtifacts) {
    if (!artifacts.has(artifact.id)) artifacts.set(artifact.id, artifact)
  }
  return [...artifacts.values()]
}

/**
 * Agent 结果区的唯一读模型：同时收录 Skill/MCP 产物与 Agent Run 生成图。
 * 只接收已持久化的画布数据，不从组件临时状态推断结果。
 */
export function collectBotanicAgentResults(input: {
  sessions: BotanicAgentSession[]
  nodes: CanvasNode[]
  generationJobs: GenerationJob[]
  assets?: AssetRecord[]
}): BotanicAgentArtifact[] {
  const actionArtifacts = collectBotanicAgentArtifacts(input.sessions)
  const assets = input.assets ?? []
  const jobs = new Map(input.generationJobs.filter((job) => job.agentRun).map((job) => [job.id, job]))
  const generationArtifacts = input.nodes.flatMap((node): BotanicAgentArtifact[] => {
    if (node.type !== 'result') return []
    const result = node.data as ResultNodeData
    if (result.status !== 'ready' || !result.image || !result.jobId) return []
    const job = jobs.get(result.jobId)
    if (!job?.agentRun) return []
    const candidateId = result.candidateId ?? node.id
    const mediaKind = result.mediaKind ?? 'image'
    // 结果的提示词来自节点配方，不需要额外持久化字段就能在结果面板还原“图 + prompt”。
    const prompt = result.generationRecipe?.prompt?.trim() || result.rootRecipe?.prompt?.trim()
    return [{
      id: `generation:${job.id}:${candidateId}`,
      kind: mediaKind,
      label: result.label?.trim() || (mediaKind === 'video' ? '生成视频' : '生成图片'),
      url: result.image,
      mimeType: undefined,
      placement: 'canvas',
      metadata: {
        source: 'generation',
        status: result.status,
        createdAt: job.updatedAt,
        jobId: job.id,
        branchId: job.agentRun.branchId,
        groupId: job.agentRun.runId,
        savedToLibrary: assets.some((asset) => asset.source === 'generated' && asset.image === result.image),
        settings: result.generationSettings,
        ...(prompt ? { prompt } : {}),
      },
      provenance: {
        actionId: `generation:${job.id}`,
        toolName: mediaKind === 'video' ? 'video_generation' : 'image_generation',
        runId: job.agentRun.runId,
        sourceNodeIds: [node.id],
      },
    }]
  })
  return [...generationArtifacts.sort((left, right) => {
    const leftTime = Number(left.metadata?.createdAt ?? 0)
    const rightTime = Number(right.metadata?.createdAt ?? 0)
    return rightTime - leftTime
  }), ...actionArtifacts]
}

/** 结果面板的统一排序键；缺时间的历史产物排在最后而不是随机穿插。 */
export function botanicAgentArtifactTimestamp(artifact: Pick<BotanicAgentArtifact, 'metadata'>) {
  const value = Number(artifact.metadata?.createdAt ?? 0)
  return Number.isFinite(value) ? value : 0
}

export function botanicAgentArtifactPrompt(artifact: Pick<BotanicAgentArtifact, 'metadata'>) {
  const value = artifact.metadata?.prompt
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function botanicAgentArtifactModel(artifact: Pick<BotanicAgentArtifact, 'metadata'>) {
  const settings = artifact.metadata?.settings
  if (!settings || typeof settings !== 'object') return undefined
  const model = (settings as { model?: unknown }).model
  return typeof model === 'string' && model.trim() ? model.trim() : undefined
}

export type BotanicAgentResultSelection = {
  artifacts: BotanicAgentArtifact[]
  mediaArtifacts: BotanicAgentArtifact[]
  sourceNodeIds: string[]
}

export function resolveBotanicAgentResultSelection(
  artifacts: BotanicAgentArtifact[],
  selectedIds: string[],
): BotanicAgentResultSelection {
  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]))
  const selectedArtifacts = uniqueIds(selectedIds).flatMap((id) => {
    const artifact = artifactById.get(id)
    return artifact ? [artifact] : []
  })
  return {
    artifacts: selectedArtifacts,
    mediaArtifacts: selectedArtifacts.filter((artifact) =>
      Boolean(artifact.url) && (artifact.kind === 'image' || artifact.kind === 'video')
    ),
    sourceNodeIds: uniqueIds(selectedArtifacts.flatMap((artifact) => artifact.provenance.sourceNodeIds ?? [])),
  }
}

function sessionTitle(content: string) {
  const compact = content.trim().replace(/\s+/g, ' ').replace(/[。！？!?]+$/g, '')
  return compact.length > 18 ? `${compact.slice(0, 18)}…` : compact
}

export function createBotanicAgentSession(input: {
  id?: string
  now?: number
  title?: string
  executionMode?: BotanicAgentExecutionMode
  plannerModel?: string
  mountedSkillIds?: string[]
  contextNodeIds?: string[]
} = {}): BotanicAgentSession {
  const now = input.now ?? Date.now()
  return {
    id: input.id ?? `agent-session-${now}`,
    title: input.title?.trim() || '新建对话',
    executionMode: input.executionMode ?? 'manual',
    ...(input.plannerModel?.trim() ? { plannerModel: input.plannerModel.trim() } : {}),
    ...(input.mountedSkillIds?.length ? { mountedSkillIds: uniqueIds(input.mountedSkillIds) } : {}),
    contextNodeIds: uniqueIds(input.contextNodeIds ?? []),
    messages: [],
    createdAt: now,
    updatedAt: now,
  }
}

export function appendBotanicAgentMessage(session: BotanicAgentSession, message: BotanicAgentMessage): BotanicAgentSession {
  if (session.messages.some((item) => item.id === message.id)) return session
  const versionedMessage = { ...message, updatedAt: message.updatedAt ?? message.createdAt }
  return {
    ...session,
    title: session.messages.length === 0 && message.role === 'user' && session.title === '新建对话'
      ? sessionTitle(message.content) || session.title
      : session.title,
    messages: [...session.messages, versionedMessage],
    updatedAt: Math.max(session.updatedAt, versionedMessage.updatedAt),
  }
}

export function renameBotanicAgentSession(
  session: BotanicAgentSession,
  title: string,
  now = Date.now(),
): BotanicAgentSession {
  const nextTitle = title.trim().replace(/\s+/g, ' ').slice(0, 160) || '新建对话'
  if (nextTitle === session.title) return session
  return { ...session, title: nextTitle, updatedAt: now }
}

export function updateBotanicAgentSessionPlannerModel(
  session: BotanicAgentSession,
  plannerModel: string,
  now = Date.now(),
): BotanicAgentSession {
  const nextModel = plannerModel.trim()
  if (!nextModel || nextModel === session.plannerModel) return session
  return { ...session, plannerModel: nextModel, updatedAt: now }
}

export function replaceBotanicAgentSessionSkills(
  session: BotanicAgentSession,
  mountedSkillIds: string[],
  now = Date.now(),
): BotanicAgentSession {
  const nextIds = uniqueIds(mountedSkillIds).slice(0, 16)
  const currentIds = session.mountedSkillIds ?? []
  if (nextIds.length === currentIds.length && nextIds.every((id, index) => id === currentIds[index])) return session
  return { ...session, mountedSkillIds: nextIds, updatedAt: now }
}

export function replaceBotanicAgentSessionContext(
  session: BotanicAgentSession,
  contextNodeIds: string[],
  now = Date.now(),
): BotanicAgentSession {
  return { ...session, contextNodeIds: uniqueIds(contextNodeIds), updatedAt: now }
}

export function updateBotanicAgentSessionReadingAnchor(
  session: BotanicAgentSession,
  messageId: string,
  now = Date.now(),
): BotanicAgentSession {
  if (!session.messages.some((message) => message.id === messageId)) return session
  if (session.readingAnchorMessageId === messageId && session.readingAnchorUpdatedAt === now) return session
  return {
    ...session,
    readingAnchorMessageId: messageId,
    readingAnchorUpdatedAt: now,
    updatedAt: Math.max(session.updatedAt, now),
  }
}

export function updateBotanicAgentMessage(
  session: BotanicAgentSession,
  messageId: string,
  patch: Partial<Pick<BotanicAgentMessage, 'content' | 'runId' | 'status' | 'feedback' | 'plan' | 'question' | 'deliveryStatus'>>,
  now = Date.now(),
): BotanicAgentSession {
  if (!session.messages.some((message) => message.id === messageId)) return session
  return {
    ...session,
    messages: session.messages.map((message) => message.id === messageId ? { ...message, ...patch, updatedAt: now } : message),
    updatedAt: now,
  }
}

export function updateBotanicAgentAction(
  session: BotanicAgentSession,
  messageId: string,
  actionId: string,
  patch: Partial<Pick<BotanicAgentActionProposal, 'status' | 'error' | 'result'>>,
  now = Date.now(),
): BotanicAgentSession {
  let changed = false
  const messages = session.messages.map((message) => {
    if (message.id !== messageId || !message.plan?.actions?.some((action) => action.id === actionId)) return message
    changed = true
    return {
      ...message,
      updatedAt: now,
      plan: {
        ...message.plan,
        actions: message.plan.actions.map((action) => action.id === actionId ? { ...action, ...patch } : action),
      },
    }
  })
  return changed ? { ...session, messages, updatedAt: now } : session
}

export type BuildBotanicAgentPlanInput = {
  instruction: string
  creativeBrief?: BotanicCreativeBrief
  intent?: BotanicAgentIntent
  selectedResultNodeId?: string
  selectedResultLabel?: string
  rootRecipe?: GenerationRecipe
  settings?: GenerationSettings
  assetGroup?: AssetGroup
  contextSnapshot?: BotanicAgentContextSnapshot[]
  /** 无素材组的单次生成需要多张时的请求数量；服务端按 output.count 生成对应候选。 */
  outputCount?: number
}

const variationDimensionPattern = '人物|模特|角色|场景|背景|画面|环境|肤色|族裔|人种|动作|姿势|姿态|风格|服装|衣服|穿搭|版本|变体'

function stripPreserveClauses(instruction: string) {
  return instruction.replace(/(?:保持|保留)[^，。,；;\n]{0,40}?(?:不变|一致)/gu, ' ')
}

/** 只有明确要出多张/多取值时才走批量；「多个细节」「2个道具」「一组姿态」仍是单图。 */
export function instructionRequestsBatchVariation(instruction: string) {
  const text = stripPreserveClauses(String(instruction ?? '').trim())
  if (!text) return false
  if (/(?:批量|多图|多张|逐一|多来几|来几个|多出几|多肤色)/u.test(text)) return true
  if (new RegExp(`(?:\\d+|两|三|四|五|六|七|八|九|十)(?:种|档)(?:不同(?:的)?)?(?:${variationDimensionPattern})`, 'u').test(text)) return true
  if (new RegExp(`(?:[2-9]|[1-9]\\d|十|两|三|四|五|六|七|八|九)个(?:不同(?:的)?)?(?:[\\u4e00-\\u9fff]{0,6})?(?:${variationDimensionPattern})`, 'u').test(text)) return true
  if (new RegExp(`(?:多个|多种|几种|几个|一组|一批)(?:不同(?:的)?)?(?:${variationDimensionPattern})`, 'u').test(text)) return true
  return false
}

/** 单次（非素材组批量）生成允许的最大输出张数，与 MAX_GENERATION_BATCH 默认值一致。 */
export const BOTANIC_AGENT_MAX_SINGLE_OUTPUT = 8

const intentPatterns: Array<[BotanicAgentIntent, RegExp]> = [
  ['redo_from_root', /(最初|原始|原配方|商品图).*(重新|重做|再做)|复用.*(最初|原始)/i],
  ['replace_scene', /(换|替换|改变|更换).*(场景|背景)|(场景|背景).*(换|替换|改变|更换)/i],
  ['change_pose', /(动作|姿势|姿态|肢体)/i],
  ['replace_person', /(换|替换|改变|更换).*(人物|模特)|(人物|模特).*(换|替换|改变|更换)/i],
  ['replace_product', /(换|替换|改变|更换).*(商品|服装|衣服)|(商品|服装|衣服).*(换|替换|改变|更换)/i],
  ['change_style', /(风格|调性|色调|质感)/i],
]

export function inferBotanicAgentIntent(instruction: string): BotanicAgentIntent {
  const normalized = instruction.trim()
  if (instructionRequestsBatchVariation(normalized)) return 'batch_variation'
  return intentPatterns.find(([, pattern]) => pattern.test(normalized))?.[0] ?? 'continue_generation'
}

export function botanicAgentGroupRole(intent?: BotanicAgentIntent): AssetGroup['role'] | null {
  if (intent === 'replace_scene') return '场景'
  if (intent === 'replace_person') return '模特'
  if (intent === 'replace_product') return '商品'
  if (intent === 'change_style') return '调性'
  return null
}

/** Composer 未点快捷项时仍列出场景组；不把 requestedIntent 默认成换景。 */
export function botanicAgentComposerGroupRole(intent?: BotanicAgentIntent): AssetGroup['role'] | null {
  return botanicAgentGroupRole(intent ?? 'replace_scene')
}

/** 指令里已写明批量/多取值时，界面上的换景快捷项不能压过批量流。 */
export function resolveBotanicAgentIntent(instruction: string, requestedIntent?: BotanicAgentIntent): BotanicAgentIntent {
  const inferred = inferBotanicAgentIntent(instruction)
  if (inferred === 'batch_variation') return 'batch_variation'
  return requestedIntent ?? inferred
}

function constraintsForIntent(intent: BotanicAgentIntent, assetGroup?: AssetGroup): CreativeConstraint[] {
  const groupSource = assetGroup ? { sourceAssetGroupId: assetGroup.id } : {}
  if (intent === 'initial_generation') return []
  if (intent === 'replace_scene') return [
    { dimension: 'person', mode: 'preserve' },
    { dimension: 'garment', mode: 'preserve' },
    { dimension: 'product', mode: 'preserve' },
    { dimension: 'pose', mode: 'preserve' },
    { dimension: 'scene', mode: 'vary', ...groupSource },
    { dimension: 'lighting', mode: 'vary' },
  ]
  if (intent === 'replace_person') return [
    { dimension: 'person', mode: 'vary', ...groupSource },
    { dimension: 'garment', mode: 'preserve' },
    { dimension: 'product', mode: 'preserve' },
    { dimension: 'scene', mode: 'preserve' },
    { dimension: 'style', mode: 'preserve' },
  ]
  if (intent === 'replace_product') return [
    { dimension: 'person', mode: 'preserve' },
    { dimension: 'garment', mode: 'vary', ...groupSource },
    { dimension: 'product', mode: 'vary', ...groupSource },
    { dimension: 'scene', mode: 'preserve' },
    { dimension: 'style', mode: 'preserve' },
  ]
  if (intent === 'change_pose') return [
    { dimension: 'person', mode: 'preserve' },
    { dimension: 'garment', mode: 'preserve' },
    { dimension: 'product', mode: 'preserve' },
    { dimension: 'scene', mode: 'preserve' },
    { dimension: 'style', mode: 'preserve' },
    { dimension: 'pose', mode: 'vary' },
    { dimension: 'composition', mode: 'vary' },
  ]
  if (intent === 'change_style') return [
    { dimension: 'person', mode: 'preserve' },
    { dimension: 'garment', mode: 'preserve' },
    { dimension: 'product', mode: 'preserve' },
    { dimension: 'scene', mode: 'preserve' },
    { dimension: 'pose', mode: 'preserve' },
    { dimension: 'style', mode: 'vary', ...groupSource },
    { dimension: 'lighting', mode: 'vary' },
  ]
  return [
    { dimension: 'person', mode: 'preserve' },
    { dimension: 'garment', mode: 'preserve' },
    { dimension: 'product', mode: 'preserve' },
    { dimension: 'scene', mode: 'preserve' },
    { dimension: 'style', mode: 'vary' },
  ]
}

function intentLabel(intent: BotanicAgentIntent) {
  const labels: Record<BotanicAgentIntent, string> = {
    initial_generation: '首次生成',
    continue_generation: '继续生成',
    replace_scene: '替换场景',
    replace_person: '替换模特',
    replace_product: '替换商品',
    change_pose: '调整动作',
    change_style: '改变风格',
    batch_variation: '批量变体',
    redo_from_root: '从原配方重做',
  }
  return labels[intent]
}

export const botanicAgentNodeTitleLimit = 8

const varyDimensionTitle: Record<CreativeDimension, string> = {
  person: '换人物', garment: '换服装', product: '换商品', scene: '换场景', style: '换风格',
  pose: '换动作', composition: '调构图', lighting: '调光线', aspect_ratio: '改比例', copy_space: '调留白',
}

const varyDimensionShortTitle: Record<CreativeDimension, string> = {
  person: '换人', garment: '换装', product: '换品', scene: '换景', style: '换风',
  pose: '换姿', composition: '构图', lighting: '调光', aspect_ratio: '比例', copy_space: '留白',
}

/** 去掉空白与标点后截到 8 个字，供画布节点标题使用。 */
export function clipBotanicAgentNodeTitle(value: string): string {
  const compact = value.replace(/[\s·.,，。:：；;、\-_/\\]+/gu, '')
  return Array.from(compact).slice(0, botanicAgentNodeTitleLimit).join('')
}

export function summarizeBotanicAgentNodeTitle(
  plan: Pick<BotanicAgentPlan, 'intent' | 'constraints'> & { title?: string },
  options: { preferred?: string; sequence?: number } = {},
): string {
  const preferred = clipBotanicAgentNodeTitle(options.preferred ?? '')
  const named = preferred || clipBotanicAgentNodeTitle(plan.title ?? '')
  const vary = plan.constraints.filter((constraint) => constraint.mode === 'vary')
  let base = named
  if (!base && vary.length === 1) base = clipBotanicAgentNodeTitle(varyDimensionTitle[vary[0].dimension])
  if (!base && vary.length > 1) {
    base = clipBotanicAgentNodeTitle(vary.map((constraint) => varyDimensionShortTitle[constraint.dimension]).join(''))
  }
  if (!base) base = clipBotanicAgentNodeTitle(intentLabel(plan.intent) || '新版本')
  if (!base) base = '新版本'
  if (options.sequence && options.sequence > 1) {
    const suffix = String(options.sequence)
    const room = Math.max(1, botanicAgentNodeTitleLimit - suffix.length)
    return `${Array.from(base).slice(0, room).join('')}${suffix}`
  }
  return base
}

export function botanicAgentResultGroupTitle(
  plan?: Pick<BotanicAgentPlan, 'intent' | 'constraints'> & { title?: string; summary?: string },
): string {
  if (!plan) return '生成批次'
  return summarizeBotanicAgentNodeTitle(plan)
}

export const botanicAgentSkillSummaryLimit = 28

function botanicAgentSkillFrontmatterDescription(block: string) {
  const lines = block.split(/\r?\n/)
  const start = lines.findIndex((line) => /^description\s*:/i.test(line))
  if (start < 0) return ''
  const remainder = lines[start].replace(/^description\s*:/i, '').trim()
  const blockScalar = remainder.match(/^(>|\\|)\+?-?$/)
  if (blockScalar) {
    const collected: string[] = []
    for (let index = start + 1; index < lines.length; index += 1) {
      const line = lines[index]
      if (!/^\s/.test(line)) break
      collected.push(line.trim())
    }
    return (blockScalar[1] === '>' ? collected.join(' ') : collected.join('\n'))
      .replace(/\s+/g, ' ')
      .trim()
  }
  return remainder.replace(/^['"]|['"]$/g, '').trim()
}

function botanicAgentSkillDocument(instructions: string) {
  const text = instructions.trim()
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!frontmatter) return { description: '', body: text }
  return {
    description: botanicAgentSkillFrontmatterDescription(frontmatter[1]),
    body: text.slice(frontmatter[0].length).trim(),
  }
}

function botanicAgentSkillLead(body: string) {
  const compact = body.replace(/^#+\s+[^\n]+\n+/, '').replace(/\s+/g, ' ').trim()
  return compact.match(/^(.+?[。！？!?])/)?.[1]?.trim() || compact
}

function clipBotanicAgentSkillSummary(value: string) {
  const compact = value.replace(/\s+/g, ' ').trim()
  const characters = Array.from(compact)
  if (characters.length <= botanicAgentSkillSummaryLimit) return compact
  return `${characters.slice(0, botanicAgentSkillSummaryLimit).join('')}…`
}

/** 技能列表的一句用途：优先 YAML description，否则取正文首句。 */
export function botanicAgentSkillSummary(instructions: string): string {
  const document = botanicAgentSkillDocument(instructions)
  return clipBotanicAgentSkillSummary(document.description || botanicAgentSkillLead(document.body))
}

/** 技能展开正文：去掉 YAML frontmatter，保留可读规则。 */
export function botanicAgentSkillBody(instructions: string): string {
  return botanicAgentSkillDocument(instructions).body
}

const canvasPromptMetaPattern = /^(?:说明一下(?:来源)?|来源说明|补充说明)[:：]/u
const canvasPromptMetaBodyPattern = /(?:我没有读取到|当前项目上下文里|根据(?:之前的)?对话上下文)/u
const plannerNarrationPattern = /(?:项目没有配置|没有配置批量|没有启用批量|缺(?:少)?(?:\d+个)?字段|只差.{0,12}字段|批量(?:变体)?\s*Skill|当前无法批量|请确认.{0,12}取值|按推荐值继续|确认前不会(?:执行|生成)|待确认计划)/u

/** 规划说明、缺字段分析和读取失败旁白不是画面描述。 */
export function botanicAgentLooksLikePlannerNarration(text: string) {
  const value = text.trim()
  if (!value) return false
  return canvasPromptMetaPattern.test(value)
    || canvasPromptMetaBodyPattern.test(value)
    || plannerNarrationPattern.test(value)
}

export function botanicAgentMessageOffersVisualPrompt(message: Pick<BotanicAgentMessage, 'prompt' | 'content' | 'plan' | 'question'>) {
  if (message.plan || message.question) return false
  const prompt = message.prompt?.trim()
  if (!prompt) return false
  return !botanicAgentLooksLikePlannerNarration(prompt) && !botanicAgentLooksLikePlannerNarration(message.content)
}

/**
 * 画布文本节点和生图任务只接受视觉描述。
 * 模型把读取失败、对话回顾或规划说明写进 Prompt 时，这些旁白留在对话里，不进画布。
 *
 * 取不到画面描述时返回空串：宁可让调用方继承基准图或追问，也不能把旁白当成提示词发给 Provider。
 */
export function botanicAgentVisualGenerationPrompt(prompt: string, fallback = ''): string {
  const text = prompt.trim()
  const blocks = text.split(/\n{2,}/u).map((block) => block.trim()).filter(Boolean)
  const visual = blocks
    .filter((block) => !botanicAgentLooksLikePlannerNarration(block))
    .join('\n\n')
    .trim()
  if (visual && !botanicAgentLooksLikePlannerNarration(visual)) return visual
  const fallbackText = fallback.trim()
  if (fallbackText && !botanicAgentLooksLikePlannerNarration(fallbackText)) return fallbackText
  return ''
}

export function botanicAgentBatchBranchTitles(
  plan: Pick<BotanicAgentPlan, 'intent' | 'constraints'> & { title?: string },
  preferredNames: Array<string | undefined>,
): string[] {
  return preferredNames.map((preferred, index) => summarizeBotanicAgentNodeTitle(plan, {
    preferred,
    sequence: index + 1,
  }))
}

export function buildBotanicAgentPlan(input: BuildBotanicAgentPlanInput): BotanicAgentPlan {
  const instruction = input.instruction.trim()
  if (!instruction) throw new Error('请描述希望 Agent 完成的修改。')
  const intent = input.intent ?? inferBotanicAgentIntent(instruction)
  const isInitialGeneration = intent === 'initial_generation'
  if (!isInitialGeneration && !input.selectedResultNodeId) throw new Error('请先选择一张已生成图片。')
  if (!isInitialGeneration && !input.rootRecipe) throw new Error('当前结果缺少可恢复的生成配方。')
  const contextSnapshot = createBotanicAgentContextSnapshot(input.contextSnapshot ?? [])
  const imageContext = contextSnapshot.filter((item) =>
    item.mediaKind === 'image' && (item.kind === '素材' || item.kind === '结果'))
  if (isInitialGeneration && !imageContext.length) throw new Error('首次生成至少需要一项图片素材或图片结果。')
  const settings = input.rootRecipe?.settings ?? input.settings
  if (!settings) throw new Error('请先设置生成模型与输出参数。')
  // 提示词只接受画面描述：本轮指令优先，其次继承基准图的配方；都取不到就停下追问，不拿旁白凑数。
  const visualPrompt = botanicAgentVisualGenerationPrompt(instruction)
    || botanicAgentVisualGenerationPrompt(input.rootRecipe?.prompt ?? '')
  if (!visualPrompt) {
    throw new Error('这轮还没有可执行的画面描述。请说明画面要改成什么样，或选中一张作为基准的结果图。')
  }
  const constraints = constraintsForIntent(intent, input.assetGroup)
  const batchCount = input.assetGroup?.assetIds.length ?? 0
  const requestedSingleCount = Math.min(
    BOTANIC_AGENT_MAX_SINGLE_OUTPUT,
    Math.max(1, Math.floor(input.outputCount ?? 1)),
  )
  const output = batchCount
    ? { mode: 'batch_by_asset' as const, count: batchCount, candidatesPerItem: 1 }
    : { mode: 'single' as const, count: requestedSingleCount, candidatesPerItem: 1 }
  const references: AgentReferenceBinding[] = isInitialGeneration
    ? imageContext.map((item) => ({
        source: 'context_node' as const,
        id: item.nodeId,
        label: item.label,
        ...(item.role ? { role: item.role } : {}),
      }))
    : [
        { source: 'selected_result', id: input.selectedResultNodeId!, label: input.selectedResultLabel ?? '当前结果图' },
        ...input.rootRecipe!.references.map((reference) => ({
          source: 'root_recipe' as const,
          id: reference.nodeId,
          label: reference.name,
          role: reference.role,
        })),
      ]
  if (input.assetGroup) references.push({
    source: 'asset_group',
    id: input.assetGroup.id,
    label: input.assetGroup.name,
    role: input.assetGroup.role,
  })

  return {
    intent,
    instruction,
    summary: `${intentLabel(intent)}，${output.mode === 'batch_by_asset' ? `按「${input.assetGroup?.name}」生成 ${output.count} 张` : `生成 ${output.count} 张新版本`}。`,
    title: summarizeBotanicAgentNodeTitle({ intent, constraints }),
    ...(input.creativeBrief ? { creativeBrief: structuredClone(input.creativeBrief) } : {}),
    ...(input.selectedResultNodeId ? { selectedResultNodeId: input.selectedResultNodeId } : {}),
    ...(contextSnapshot.length ? { contextSnapshot } : {}),
    references,
    constraints,
    prompt: botanicAgentPromptWithContextNotes(visualPrompt, contextSnapshot),
    settings,
    output,
    ...(input.assetGroup ? { assetGroupId: input.assetGroup.id } : {}),
    ...(input.rootRecipe ? { rootRecipe: input.rootRecipe } : {}),
  }
}

export function creativeDimensionLabel(dimension: CreativeDimension) {
  const labels: Record<CreativeDimension, string> = {
    person: '人物', garment: '服装', product: '商品', scene: '场景', style: '风格',
    pose: '动作', composition: '构图', lighting: '光线', aspect_ratio: '比例', copy_space: '文案留白',
  }
  return labels[dimension]
}

export function createBotanicAgentRun(
  plan: BotanicAgentPlan,
  options: { id?: string; now?: number; branches?: BotanicAgentRunBranch[] } = {},
): BotanicAgentRun {
  const now = options.now ?? Date.now()
  return {
    id: options.id ?? `agent-run-${now}`,
    status: 'awaiting_confirmation',
    plan,
    createdAt: now,
    updatedAt: now,
    branches: options.branches ?? [],
    completedBranchCount: 0,
    failedBranchCount: 0,
  }
}

export function mergeBotanicAgentRunSnapshot(
  run: BotanicAgentRun,
  snapshot: BotanicAgentRunSnapshot,
): BotanicAgentRun {
  if (run.id !== snapshot.id) return run
  // Realtime 与 4 秒恢复轮询可能同时返回同一快照；旧快照也不能回退
  // 已显示的进度。返回原对象让 Store 跳过无意义的持久化写入。
  if (snapshot.updatedAt <= run.updatedAt) return run
  return {
    ...run,
    status: snapshot.status,
    branches: snapshot.branches,
    completedBranchCount: snapshot.completedBranchCount,
    failedBranchCount: snapshot.failedBranchCount,
    updatedAt: snapshot.updatedAt,
    error: snapshot.status === 'failed'
      ? snapshot.branches.find((branch) => branch.error)?.error
      : undefined,
  }
}

export function upsertBotanicAgentRunSnapshot(
  runs: BotanicAgentRun[],
  snapshot: BotanicAgentRunSnapshot,
  rootRecipe?: GenerationRecipe,
): BotanicAgentRun[] {
  const existing = runs.find((run) => run.id === snapshot.id)
  if (existing) {
    const merged = mergeBotanicAgentRunSnapshot(existing, snapshot)
    if (merged === existing) return runs
    return runs.map((run) => run.id === snapshot.id ? merged : run)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }
  if (!snapshot.plan) return runs
  const initialGeneration = snapshot.plan.intent === 'initial_generation'
  const recipe = initialGeneration ? undefined : rootRecipe ?? {
      references: [],
      prompt: snapshot.plan.prompt,
      batchCount: Math.max(1, snapshot.plan.output.candidatesPerItem),
      settings: snapshot.plan.settings,
    }
  const references: AgentReferenceBinding[] = initialGeneration
    ? (snapshot.plan.contextSnapshot ?? [])
        .filter((item) => item.mediaKind === 'image' && (item.kind === '素材' || item.kind === '结果'))
        .map((item) => ({
          source: 'context_node', id: item.nodeId, label: item.label,
          ...(item.role ? { role: item.role } : {}),
        }))
    : [
        ...(snapshot.plan.selectedResultNodeId
          ? [{ source: 'selected_result' as const, id: snapshot.plan.selectedResultNodeId, label: '父结果' }]
          : []),
        ...(recipe?.references ?? []).map((reference) => ({
          source: 'root_recipe' as const,
          id: reference.nodeId,
          label: reference.name,
          role: reference.role,
        })),
      ]
  const restored: BotanicAgentRun = {
    id: snapshot.id,
    status: snapshot.status,
    plan: {
      ...snapshot.plan,
      references,
      ...(recipe ? { rootRecipe: recipe } : {}),
    },
    branches: snapshot.branches,
    completedBranchCount: snapshot.completedBranchCount,
    failedBranchCount: snapshot.failedBranchCount,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    error: snapshot.status === 'failed'
      ? snapshot.branches.find((branch) => branch.error)?.error
      : undefined,
  }
  return [restored, ...runs].sort((a, b) => b.updatedAt - a.updatedAt)
}

export function updateBotanicAgentRun(
  run: BotanicAgentRun,
  status: BotanicAgentRunStatus,
  now = Date.now(),
  error?: string,
): BotanicAgentRun {
  return {
    ...run,
    status,
    updatedAt: now,
    ...(error ? { error } : { error: undefined }),
  }
}

export type BotanicAgentPromptDiffSegment = {
  kind: 'same' | 'added' | 'removed'
  text: string
}

/**
 * 以词和标点为单位生成提示词差异，供确认卡展示；不改变真正提交给模型的提示词。
 * 对超长提示词使用中间段折叠，避免确认卡因为 O(n²) 比对阻塞界面。
 */
export function buildBotanicAgentPromptDiff(
  original: string,
  revised: string,
): BotanicAgentPromptDiffSegment[] {
  if (original === revised) return original ? [{ kind: 'same', text: original }] : []

  const tokenize = (value: string) => value.match(/\s+|[，。！？、；：,.!?;:\n]+|[\p{Script=Han}]|[^\s，。！？、；：,.!?;:\n\p{Script=Han}]+/gu) ?? []
  const before = tokenize(original)
  const after = tokenize(revised)
  const merge = (segments: BotanicAgentPromptDiffSegment[]) => segments.reduce<BotanicAgentPromptDiffSegment[]>((merged, segment) => {
    if (!segment.text) return merged
    const previous = merged.at(-1)
    if (previous?.kind === segment.kind) previous.text += segment.text
    else merged.push({ ...segment })
    return merged
  }, [])

  // 长文本只保留公共首尾，既能表达主要变化，也避免大提示词的矩阵分配。
  if (before.length * after.length > 65_000) {
    let prefix = 0
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1
    let suffix = 0
    while (
      suffix < before.length - prefix
      && suffix < after.length - prefix
      && before[before.length - suffix - 1] === after[after.length - suffix - 1]
    ) suffix += 1
    return merge([
      { kind: 'same', text: before.slice(0, prefix).join('') },
      { kind: 'removed', text: before.slice(prefix, before.length - suffix).join('') },
      { kind: 'added', text: after.slice(prefix, after.length - suffix).join('') },
      { kind: 'same', text: before.slice(before.length - suffix).join('') },
    ])
  }

  const width = after.length + 1
  const table = Array.from({ length: before.length + 1 }, () => new Uint16Array(width))
  for (let row = before.length - 1; row >= 0; row -= 1) {
    for (let column = after.length - 1; column >= 0; column -= 1) {
      table[row][column] = before[row] === after[column]
        ? table[row + 1][column + 1] + 1
        : Math.max(table[row + 1][column], table[row][column + 1])
    }
  }

  const segments: BotanicAgentPromptDiffSegment[] = []
  let row = 0
  let column = 0
  while (row < before.length && column < after.length) {
    if (before[row] === after[column]) {
      segments.push({ kind: 'same', text: before[row] })
      row += 1
      column += 1
    } else if (table[row + 1][column] >= table[row][column + 1]) {
      segments.push({ kind: 'removed', text: before[row] })
      row += 1
    } else {
      segments.push({ kind: 'added', text: after[column] })
      column += 1
    }
  }
  while (row < before.length) segments.push({ kind: 'removed', text: before[row++] })
  while (column < after.length) segments.push({ kind: 'added', text: after[column++] })
  return merge(segments)
}
