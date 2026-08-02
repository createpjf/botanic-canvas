import type { AssetGroup, AssetRecord, CanvasNode, GenerationJob, GenerationRecipe, GenerationSettings, ResultNodeData } from './canvas.ts'

export type BotanicAgentIntent =
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
  source: 'selected_result' | 'root_recipe' | 'asset_group'
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
  error?: string
}

export type BotanicAgentArtifactKind = 'image' | 'video' | 'text' | 'workflow' | 'asset_group' | 'file'

export type BotanicAgentArtifact = {
  id: string
  kind: BotanicAgentArtifactKind
  label: string
  content?: string
  url?: string
  mimeType?: string
  metadata?: Record<string, unknown>
  provenance: {
    actionId: string
    toolName: string
    runId?: string
    externalTool?: string
    sourceNodeIds?: string[]
  }
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
  artifacts?: BotanicAgentArtifact[]
  canvasCommands?: BotanicAgentCanvasCommand[]
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

export function resolveBotanicAgentCanvasCommands(result: BotanicAgentActionResult): ResolvedBotanicAgentCanvasCommand[] {
  if (result.artifacts?.length && result.canvasCommands?.length) {
    const artifacts = new Map(result.artifacts.map((artifact) => [artifact.id, artifact]))
    return result.canvasCommands.flatMap((command): ResolvedBotanicAgentCanvasCommand[] => {
      if (command.type !== 'create_text_node' && command.type !== 'create_media_node') return []
      const artifact = artifacts.get(command.artifactId)
      if (!artifact) return []
      const textCompatible = command.type === 'create_text_node'
        && (artifact.kind === 'text' || artifact.kind === 'workflow')
        && Boolean(artifact.content?.trim())
      const mediaCompatible = command.type === 'create_media_node'
        && (artifact.kind === 'image' || artifact.kind === 'video')
        && safeAgentArtifactUrl(artifact.url)
      return textCompatible || mediaCompatible ? [{ artifact, command }] : []
    })
  }
  if (!result.writeback?.content.trim()) return []
  const artifact: BotanicAgentArtifact = {
    id: 'legacy-writeback', kind: 'text', label: result.writeback.label,
    content: result.writeback.content,
    provenance: { actionId: 'legacy-action', toolName: 'legacy_writeback' },
  }
  return [{ artifact, command: { id: 'legacy-writeback-command', type: 'create_text_node', artifactId: artifact.id } }]
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
  selectedResultNodeId: string
  references: AgentReferenceBinding[]
  constraints: CreativeConstraint[]
  prompt: string
  settings: GenerationSettings
  output: {
    mode: 'single' | 'batch_by_asset'
    count: number
    candidatesPerItem: number
  }
  assetGroupId?: string
  rootRecipe: GenerationRecipe
  toolCalls?: AgentToolCallTrace[]
  actions?: BotanicAgentActionProposal[]
}

export type BotanicAgentRunStatus = 'awaiting_confirmation' | 'queued' | 'executing' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled'

export type BotanicAgentBranchStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export type BotanicAgentRunBranch = {
  id: string
  label: string
  assetId?: string
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

export type BotanicAgentMessage = {
  id: string
  role: 'user' | 'assistant'
  kind: 'text' | 'plan' | 'run' | 'notice'
  content: string
  createdAt: number
  plan?: BotanicAgentPlan
  runId?: string
  status?: 'pending' | 'submitted' | 'failed'
  feedback?: 'positive' | 'negative'
}

export type BotanicAgentSession = {
  id: string
  title: string
  executionMode: BotanicAgentExecutionMode
  contextNodeIds: string[]
  messages: BotanicAgentMessage[]
  createdAt: number
  updatedAt: number
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
    return [{
      id: `generation:${job.id}:${candidateId}`,
      kind: mediaKind,
      label: result.label?.trim() || (mediaKind === 'video' ? '生成视频' : '生成图片'),
      url: result.image,
      mimeType: undefined,
      metadata: {
        source: 'generation',
        status: result.status,
        createdAt: job.updatedAt,
        jobId: job.id,
        branchId: job.agentRun.branchId,
        groupId: job.agentRun.runId,
        savedToLibrary: assets.some((asset) => asset.source === 'generated' && asset.image === result.image),
        settings: result.generationSettings,
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
  contextNodeIds?: string[]
} = {}): BotanicAgentSession {
  const now = input.now ?? Date.now()
  return {
    id: input.id ?? `agent-session-${now}`,
    title: input.title?.trim() || '新建对话',
    executionMode: input.executionMode ?? 'manual',
    contextNodeIds: uniqueIds(input.contextNodeIds ?? []),
    messages: [],
    createdAt: now,
    updatedAt: now,
  }
}

export function appendBotanicAgentMessage(session: BotanicAgentSession, message: BotanicAgentMessage): BotanicAgentSession {
  return {
    ...session,
    title: session.messages.length === 0 && message.role === 'user'
      ? sessionTitle(message.content) || session.title
      : session.title,
    messages: [...session.messages, message],
    updatedAt: Math.max(session.updatedAt, message.createdAt),
  }
}

export function replaceBotanicAgentSessionContext(
  session: BotanicAgentSession,
  contextNodeIds: string[],
  now = Date.now(),
): BotanicAgentSession {
  return { ...session, contextNodeIds: uniqueIds(contextNodeIds), updatedAt: now }
}

export function updateBotanicAgentMessage(
  session: BotanicAgentSession,
  messageId: string,
  patch: Partial<Pick<BotanicAgentMessage, 'content' | 'runId' | 'status' | 'feedback'>>,
  now = Date.now(),
): BotanicAgentSession {
  if (!session.messages.some((message) => message.id === messageId)) return session
  return {
    ...session,
    messages: session.messages.map((message) => message.id === messageId ? { ...message, ...patch } : message),
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
  intent?: BotanicAgentIntent
  selectedResultNodeId?: string
  selectedResultLabel?: string
  rootRecipe: GenerationRecipe
  assetGroup?: AssetGroup
}

const intentPatterns: Array<[BotanicAgentIntent, RegExp]> = [
  ['redo_from_root', /(最初|原始|原配方|商品图).*(重新|重做|再做)|复用.*(最初|原始)/i],
  ['replace_scene', /(换|替换|改变|更换).*(场景|背景)|(场景|背景).*(换|替换|改变|更换)/i],
  ['replace_person', /(换|替换|改变|更换).*(人物|模特)|(人物|模特).*(换|替换|改变|更换)/i],
  ['replace_product', /(换|替换|改变|更换).*(商品|服装|衣服)|(商品|服装|衣服).*(换|替换|改变|更换)/i],
  ['change_pose', /(动作|姿势|姿态|肢体)/i],
  ['change_style', /(风格|调性|色调|质感)/i],
  ['batch_variation', /(批量|一组|一批|多个|十个|10个)/i],
]

export function inferBotanicAgentIntent(instruction: string): BotanicAgentIntent {
  const normalized = instruction.trim()
  return intentPatterns.find(([, pattern]) => pattern.test(normalized))?.[0] ?? 'continue_generation'
}

function constraintsForIntent(intent: BotanicAgentIntent, assetGroup?: AssetGroup): CreativeConstraint[] {
  const groupSource = assetGroup ? { sourceAssetGroupId: assetGroup.id } : {}
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

export function buildBotanicAgentPlan(input: BuildBotanicAgentPlanInput): BotanicAgentPlan {
  if (!input.selectedResultNodeId) throw new Error('请先选择一张已生成图片。')
  const instruction = input.instruction.trim()
  if (!instruction) throw new Error('请描述希望 Agent 完成的修改。')
  const intent = input.intent ?? inferBotanicAgentIntent(instruction)
  const constraints = constraintsForIntent(intent, input.assetGroup)
  const batchCount = input.assetGroup?.assetIds.length ?? 0
  const output = batchCount
    ? { mode: 'batch_by_asset' as const, count: batchCount, candidatesPerItem: 1 }
    : { mode: 'single' as const, count: 1, candidatesPerItem: 1 }
  const references: AgentReferenceBinding[] = [
    { source: 'selected_result', id: input.selectedResultNodeId, label: input.selectedResultLabel ?? '当前结果图' },
    ...input.rootRecipe.references.map((reference) => ({
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
    summary: `${intentLabel(intent)}，${output.mode === 'batch_by_asset' ? `按「${input.assetGroup?.name}」生成 ${output.count} 张` : '生成 1 张新版本'}。`,
    selectedResultNodeId: input.selectedResultNodeId,
    references,
    constraints,
    prompt: instruction,
    settings: input.rootRecipe.settings,
    output,
    ...(input.assetGroup ? { assetGroupId: input.assetGroup.id } : {}),
    rootRecipe: input.rootRecipe,
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
    return runs.map((run) => run.id === snapshot.id ? mergeBotanicAgentRunSnapshot(run, snapshot) : run)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }
  if (!snapshot.plan) return runs
  const recipe = rootRecipe ?? {
    references: [],
    prompt: snapshot.plan.prompt,
    batchCount: Math.max(1, snapshot.plan.output.candidatesPerItem),
    settings: snapshot.plan.settings,
  }
  const restored: BotanicAgentRun = {
    id: snapshot.id,
    status: snapshot.status,
    plan: {
      ...snapshot.plan,
      references: [
        { source: 'selected_result', id: snapshot.plan.selectedResultNodeId, label: '父结果' },
        ...recipe.references.map((reference) => ({
          source: 'root_recipe' as const,
          id: reference.nodeId,
          label: reference.name,
          role: reference.role,
        })),
      ],
      rootRecipe: recipe,
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
