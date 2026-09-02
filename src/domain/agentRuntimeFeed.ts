import type { AssetNodeData, CanvasNode, GenerateNodeData, ResultNodeData } from './canvas.ts'
import type { AgentEntityReference, BotanicAgentIntent, BotanicAgentMessage, BotanicAgentPlan, BotanicAgentRun, BotanicAgentRunStatus } from './agent.ts'

/** 意图分类名，只用来识别旧数据里的话术，不再当用户可见标题。 */
const botanicAgentIntentProcessLabels = {
  'zh-CN': {
    initial_generation: '首次生成',
    continue_generation: '继续生成',
    replace_scene: '替换场景',
    replace_person: '替换模特',
    replace_product: '替换商品',
    change_pose: '调整动作',
    change_style: '改变风格',
    batch_variation: '批量变体',
    region_edit: '局部重绘',
    redo_from_root: '从原参数重做',
  },
  en: {
    initial_generation: 'Initial generation',
    continue_generation: 'Continue generation',
    replace_scene: 'Replace scene',
    replace_person: 'Replace model',
    replace_product: 'Replace product',
    change_pose: 'Adjust pose',
    change_style: 'Change style',
    batch_variation: 'Batch variation',
    region_edit: 'Region edit',
    redo_from_root: 'Rebuild from original settings',
  },
} as const satisfies Record<'zh-CN' | 'en', Record<BotanicAgentIntent, string>>

const botanicAgentProcessLabelExtras = [
  '新版本', '新图', '生成', '生成分支',
  'Generate', 'Continue', 'Scene', 'Model', 'Product', 'Pose', 'Style', 'Variants', 'Rebuild',
] as const

const botanicAgentProcessLabels = new Set<string>([
  ...Object.values(botanicAgentIntentProcessLabels['zh-CN']),
  ...Object.values(botanicAgentIntentProcessLabels.en),
  ...botanicAgentProcessLabelExtras,
])

/** 分支/摘要里残留的意图分类名，对话和回执都不该再念出来。 */
export function isBotanicAgentProcessLabel(value: string) {
  return botanicAgentProcessLabels.has(value.trim())
}

/** 旧计划摘要常以「首次生成，」起头；展示时剥掉，只留后半句。 */
export function presentBotanicAgentPlanSummary(summary: string) {
  const text = summary.trim()
  if (!text) return ''
  for (const label of botanicAgentProcessLabels) {
    if (text === label) return ''
    for (const glue of ['，', ', ', '. '] as const) {
      const prefix = `${label}${glue}`
      if (text.startsWith(prefix)) return text.slice(prefix.length).trim()
    }
  }
  return text
}

export type AgentToolCallTrace = {
  id: string
  name: string
  label: string
  risk: 'read' | 'write' | 'costly' | 'external'
  status: 'pending' | 'running' | 'awaiting_confirmation' | 'succeeded' | 'failed' | 'aborted'
  requiresConfirmation: boolean
  /** 模型自述的一句话调用目的。它是说给用户听的摘要，不是隐藏思维链，可展示也可持久化。 */
  summary?: string
  error?: string
  /** 仅由服务端显式工具 allowlist 派生；不含 URL、Prompt 或原始工具输出。 */
  entityReferences?: AgentEntityReference[]
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
  // 对话主路径禁止用本函数做 rAF/假进度演出；仅保留给非流式本地回退或测试脚手架。
  // 真实工具步必须来自服务端 tool emit 或 Run/Action 状态投影。
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
      // aborted:同批 fatal 时未启动;运行轨迹按 failed 收尾,不留永久 pending。
      status: call.status === 'awaiting_confirmation' ? 'pending' : call.status === 'aborted' ? 'failed' : call.status,
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
      detail: '任务已提交，结果完成后会直接放到画布。',
      nextAction: '查看任务',
    },
    completed: {
      label: 'Agent 已完成',
      detail: '结果已放到画布，可以继续修改或定位结果。',
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
 * Agent 的图片首图既支持纯文字生图，也支持带参考图的受控生成；视频仍必须有首帧。
 * 文字、视频或空结果不会被误当成图片参考写入执行配方。
 */
/**
 * 画布上的生成节点不是参考物：交给 Agent 时展开成它连着的素材、结果和文字。
 * 没有入线的 orphan 生成节点不进上下文，避免只留下一块没有图的「节点」芯片。
 */
export function expandBotanicAgentContextNodeIds(
  nodes: CanvasNode[],
  edges: { source: string; target: string }[],
  nodeIds: string[],
) {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const seen = new Set<string>()
  const expanded: string[] = []
  const add = (id: string) => {
    if (seen.has(id) || !byId.has(id)) return
    seen.add(id)
    expanded.push(id)
  }
  for (const id of nodeIds) {
    const node = byId.get(id)
    if (!node) continue
    if (node.type === 'generate') {
      const data = node.data as GenerateNodeData
      const connected = edges.filter((edge) => edge.target === id).map((edge) => edge.source)
      const ordered = [
        ...(data.inputOrder ?? []).filter((inputId) => connected.includes(inputId)),
        ...connected.filter((inputId) => !(data.inputOrder ?? []).includes(inputId)),
      ]
      for (const inputId of ordered) add(inputId)
      continue
    }
    add(id)
  }
  return expanded
}

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

/** 对话默认层：进行中的 Run 卡不出现；结算后计划回执让给结果卡。 */
export function shouldShowBotanicAgentConversationMessage(input: {
  kind: BotanicAgentMessage['kind']
  status?: BotanicAgentMessage['status']
  runId?: string
  hasPlan?: boolean
  runStatus?: BotanicAgentRunStatus
  hasStatusMessage?: boolean
}) {
  if (input.kind === 'run' && input.runId) {
    return !input.runStatus || !shouldRestoreBotanicAgentRuntimeSteps(input.runStatus)
  }
  if (input.hasPlan && input.status === 'submitted' && input.runId) {
    if (!input.runStatus || shouldRestoreBotanicAgentRuntimeSteps(input.runStatus)) return true
    return !input.hasStatusMessage
  }
  return true
}

/**
 * 从持久化 Run 快照恢复执行进度。
 * 只投影已发生的提交/分支状态，标明「从服务端状态恢复」；
 * 不得把未发生的读取/规划步骤标成 succeeded。
 */
export function restoreBotanicAgentRuntimeSteps(input: {
  run: Pick<BotanicAgentRun, 'status' | 'branches' | 'error'>
  hasTarget: boolean
  referenceCount?: number
  memoryCount?: number
  assetGroupCount?: number
  plannerLabel?: string
}): BotanicAgentRuntimeStep[] {
  void input.hasTarget
  void input.referenceCount
  void input.memoryCount
  void input.assetGroupCount
  void input.plannerLabel
  const active = input.run.status === 'queued' || input.run.status === 'running' || input.run.status === 'executing'
  const failed = input.run.status === 'failed' || input.run.status === 'cancelled'
  const branches = input.run.branches ?? []
  const steps: BotanicAgentRuntimeStep[] = [{
    id: 'exec-submit',
    kind: 'write',
    label: '提交生成任务',
    detail: '从服务端状态恢复',
    status: failed && !branches.length ? 'failed' : 'succeeded',
    ...(failed && !branches.length
      ? { error: input.run.status === 'cancelled' ? '任务已取消。' : (input.run.error ?? '任务未完成，请查看任务面板。') }
      : {}),
  }]
  if (branches.length) {
    for (const branch of branches) {
      const branchFailed = branch.status === 'failed' || branch.status === 'cancelled'
      const branchActive = branch.status === 'queued' || branch.status === 'running'
      steps.push({
        id: `exec-branch:${branch.id}`,
        kind: 'write',
        label: branch.label.trim() && !isBotanicAgentProcessLabel(branch.label) ? `生成 · ${branch.label.trim()}` : '生成',
        detail: '从服务端状态恢复',
        status: branchFailed ? 'failed' : branchActive ? 'running' : 'succeeded',
        ...(branchFailed ? { error: branch.error ?? (branch.status === 'cancelled' ? '任务已取消。' : '任务未完成，请查看任务面板。') } : {}),
      })
    }
  } else if (active) {
    steps.push({
      id: 'exec-wait',
      kind: 'write',
      label: '等待生成结果',
      detail: '任务已恢复，正在等待生成结果 · 从服务端状态恢复',
      status: 'running',
    })
  } else if (failed) {
    steps[0] = {
      ...steps[0],
      status: 'failed',
      detail: '任务已结束，可查看失败原因或重试 · 从服务端状态恢复',
      error: input.run.status === 'cancelled' ? '任务已取消。' : (input.run.error ?? '任务未完成，请查看任务面板。'),
    }
  }
  return steps
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

/**
 * 分支身份进入服务端幂等请求绑定；submissionKey 存在时必须从它稳定派生，
 * 同一 Message+Plan 的自动重试才能字节级复用同一 Run 请求。
 * 无提交键的旧/本地路径保留随机 ID。
 */
export function botanicAgentBranchId(submissionKey: string | undefined, index: number) {
  return submissionKey ? `branch-${submissionKey}-${index + 1}` : `branch-${crypto.randomUUID()}`
}

/**
 * v2 人工重试在 resolve 前就必须有新 Receipt 身份。该键只由服务端可复核的稳定
 * 上下文与原始提交键派生：本地 Message 写入失败或 resolve 响应丢失时，刷新后仍
 * 能重算同一键；它只是公开幂等身份，不是授权凭据。
 */
export function botanicAgentPreparedRetryIdempotencyKey(input: {
  projectId: string
  sessionId: string
  messageId: string
  actionId: string
  originalIdempotencyKey: string
}) {
  const safeActionId = input.actionId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64) || 'action'
  const fingerprint = JSON.stringify({
    version: 1,
    projectId: input.projectId,
    sessionId: input.sessionId,
    messageId: input.messageId,
    actionId: input.actionId,
    originalIdempotencyKey: input.originalIdempotencyKey,
  })
  return `agent-action-manual-retry-${safeActionId}-${stableAgentPlanHash(fingerprint)}`
}

