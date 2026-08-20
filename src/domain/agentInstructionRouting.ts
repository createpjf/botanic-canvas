import type { BotanicAgentContextSnapshotInput, BotanicAgentIntent, BotanicAgentMessage, BotanicAgentPlan, BotanicAgentRegionSelection } from './agent.ts'
import { buildBotanicAgentPlan, createBotanicAgentContextSnapshot, inferBotanicAgentIntent } from './agent.ts'
import {
  decideBotanicAgentRequest,
  inferBotanicAgentGenerationSettings,
  resolveBotanicAgentGenerationPromptDecision,
  type BotanicAgentRequestDecision,
} from './agentChatContract.ts'
import { advanceBotanicCreativeBrief } from './agentCreativeBrief.ts'
import type { BotanicAgentClarification, BotanicAgentResolvedGeneration, BotanicCreativeBrief } from './agentCreativeBrief.ts'
import {
  applyBotanicAgentVariationToPlan,
  botanicAgentBriefWithVariationAnswers,
  botanicAgentPendingVariationClarification,
} from './agentVariations.ts'
import type { BotanicAgentComposition } from './agentCreativeComposition.ts'
import type { GenerationModelOption, GenerationSettings } from './canvas.ts'
import type { GenerationSizeOverride } from './generationOutputSize.ts'

/**
 * 一次 Agent 指令的路由与生成前置决策。此前这套状态机隐式散落在 AgentWorkspace 的
 * runInstruction 里，追问锁死、意图跨轮丢失、执行语污染简报等事故全部产自那里的分支密度。
 * 这里只做纯决策：不追加消息、不置忙、不发请求；编排层按返回值执行副作用。
 */

export type BotanicAgentInstructionOptions = {
  generationOverrides?: GenerationSizeOverride
  clarificationAnswers?: Record<string, string>
  creativeBrief?: BotanicCreativeBrief
  sourcePromptMessageId?: string
  /** 上一轮已由服务端判定的生成结论；重放追问时据此直接进入生成，不再二次分类。 */
  resolvedGeneration?: BotanicAgentResolvedGeneration
  /** 用户已框选的局部重绘选区；带选区的指令是明确的生成请求，不再进服务端意图分类。 */
  region?: BotanicAgentRegionSelection
  /** 方案卡点击或重放时指定的成套方案；缺省则取会话里最近一条 composition 消息。 */
  composition?: BotanicAgentComposition
}

export type BotanicAgentGenerationDecision = Extract<BotanicAgentRequestDecision, { kind: 'generation' }>

export type BotanicAgentInstructionEntry =
  | { kind: 'confirm_plan'; message: BotanicAgentMessage }
  | { kind: 'notice'; notice: 'answer_pending_question' | 'nothing_to_confirm' }
  | {
      /** 局部重绘语但还没有选区：编排层打开框选界面，框选后带 region 重放指令。 */
      kind: 'select_region'
    }
  | {
      kind: 'route'
      /** 已确定的生成决策（追问回程或执行语沿用历史 Prompt）；空则由调用方继续路由。 */
      decision?: BotanicAgentGenerationDecision
      useServerTurn: boolean
      options: BotanicAgentInstructionOptions
      synthesizedPrompt?: string
      synthesizedCount?: number
      synthesizedDuration?: number
      synthesizedVariants?: Array<{ label: string; promptDelta: string }>
      synthesizedAxisLabel?: string
    }

/**
 * 入口路由：确认语与执行语的落点按序为「待确认计划 → 待答确认卡 → 历史定稿 Prompt → 提示」。
 * 追问回程带着上一轮生成结论时不再对画面描述做意图分类——那只会被误判成聊天。
 */
export function resolveBotanicAgentInstructionEntry(input: {
  instruction: string
  options: BotanicAgentInstructionOptions
  hasVisualContext: boolean
  /** 当前有可框选的图片目标（选中的结果图）；局部重绘语据此进入框选流程。 */
  canSelectRegion?: boolean
  messages: BotanicAgentMessage[]
}): BotanicAgentInstructionEntry {
  const { instruction, options, hasVisualContext, messages } = input
  const restored = options.resolvedGeneration
  // 局部重绘语必须先有选区：没有选区就发起框选，而不是把「只改这里」交给整图链路。
  if (!restored && !options.region && !options.clarificationAnswers && !options.sourcePromptMessageId
    && input.canSelectRegion && inferBotanicAgentIntent(instruction) === 'region_edit') {
    return { kind: 'select_region' }
  }
  const pendingDecision = restored ? undefined : decideBotanicAgentRequest(instruction, hasVisualContext)
  let executionPromptMessageId: string | undefined
  if (pendingDecision?.kind === 'confirm_pending') {
    const pendingPlanMessage = [...messages].reverse()
      .find((item) => item.kind === 'plan' && item.plan && item.status === 'pending')
    if (pendingPlanMessage) return { kind: 'confirm_plan', message: pendingPlanMessage }
    const pendingQuestion = [...messages].reverse()
      .find((item) => item.kind === 'question' && item.question && item.status === 'pending')
    if (pendingQuestion) return { kind: 'notice', notice: 'answer_pending_question' }
    // 「直接生成」这类执行语没有画面信息：沿用最近定稿 Prompt，绝不能写进简报当画面描述。
    const promptMessage = [...messages].reverse()
      .find((item) => item.role === 'assistant' && item.prompt?.trim())
    if (!promptMessage) return { kind: 'notice', notice: 'nothing_to_confirm' }
    executionPromptMessageId = promptMessage.id
  }
  // 服务端回合解析器仅用于全新用户发送；澄清答复、“使用这段 Prompt”、执行语与带选区指令已有明确意图/来源。
  const useServerTurn = !options.clarificationAnswers && !options.sourcePromptMessageId
    && !restored && !executionPromptMessageId && !options.region
  return {
    kind: 'route',
    useServerTurn,
    decision: restored
      ? { kind: 'generation', mediaKind: restored.mediaKind, promptSource: 'instruction' }
      : options.region
        ? { kind: 'generation', mediaKind: 'image', promptSource: 'instruction' }
        : executionPromptMessageId
          ? { kind: 'generation', mediaKind: 'image', promptSource: 'previous_prompt' }
          : undefined,
    options: executionPromptMessageId
      ? { ...options, sourcePromptMessageId: executionPromptMessageId }
      : options,
    synthesizedPrompt: restored?.prompt,
    synthesizedCount: restored?.count,
    synthesizedDuration: restored?.duration,
    synthesizedVariants: restored?.variants,
    synthesizedAxisLabel: restored?.variationAxisLabel,
  }
}

export type BotanicAgentGenerationDraftInput = {
  instruction: string
  locale?: 'zh-CN' | 'en'
  decision: BotanicAgentGenerationDecision
  options: BotanicAgentInstructionOptions
  messages: BotanicAgentMessage[]
  generationModels: GenerationModelOption[]
  executionMode?: 'manual' | 'auto'
  requestedIntent?: BotanicAgentIntent
  target?: {
    id: string
    label: string
    image: string
    inheritedSettings?: Partial<Pick<GenerationSettings, 'model' | 'aspectRatio' | 'resolution' | 'outputWidth' | 'outputHeight'>>
  }
  contextItems: BotanicAgentContextSnapshotInput[]
  variationAssetGroup?: { id: string; role: string; assetCount: number }
  synthesizedPrompt?: string
  synthesizedCount?: number
  synthesizedDuration?: number
  /** 回合模型结构化声明的变体；有它就跳过正则变体追问，护栏校验在计划构建时进行。 */
  synthesizedVariants?: Array<{ label: string; promptDelta: string }>
  synthesizedAxisLabel?: string
}

export type BotanicAgentGenerationDraft =
  | { kind: 'notice'; notice: 'prompt_missing' | 'video_model_missing' }
  | { kind: 'ask'; clarification: BotanicAgentClarification }
  | { kind: 'failed'; message: string }
  | {
      kind: 'ready'
      isVideo: boolean
      /** 视频计划一律走首帧语义，不进服务端图片规划器。 */
      useInitialFlow: boolean
      /** 用户原话；变体轴解析只认它，不认综合 Prompt。 */
      instruction: string
      prompt: string
      brief: BotanicCreativeBrief
      /** 不含时长的输出设置；重试命令与图片规划请求使用它。 */
      generationOverrides: GenerationSizeOverride
      /** 计划设置；视频计划带时长。 */
      planSettings: GenerationSettings
      planContextItems: BotanicAgentContextSnapshotInput[]
      outputCount?: number
      sourcePromptMessageId?: string
      /** 回合模型结构化声明的变体；计划构建时直接展开，不再正则解析。 */
      structuredVariants?: Array<{ label: string; promptDelta: string }>
      variationAxisLabel?: string
      /** 追问卡必须带回下一轮的生成结论与 Prompt 来源。 */
      carryOver: { sourcePromptMessageId?: string; resolvedGeneration?: BotanicAgentResolvedGeneration }
    }

/**
 * 生成前置决策：解析可执行 Prompt、选模型目录、判定变体与创作设置追问，产出可构建计划的草案。
 */
export function prepareBotanicAgentGenerationDraft(input: BotanicAgentGenerationDraftInput): BotanicAgentGenerationDraft {
  const { instruction, decision, options, messages, generationModels, target } = input
  let prompt: string
  let sourcePromptMessageId: string | undefined
  if (input.synthesizedPrompt !== undefined) {
    // 服务端已综合出可执行 Prompt：不再要求历史里存在字面 Prompt，也不再死胡同式拒绝。
    prompt = input.synthesizedPrompt
  } else {
    const promptResolution = resolveBotanicAgentGenerationPromptDecision(instruction, messages, options.sourcePromptMessageId)
    if (promptResolution.status === 'missing') return { kind: 'notice', notice: 'prompt_missing' }
    prompt = promptResolution.prompt
    sourcePromptMessageId = promptResolution.sourceMessageId
  }
  // 服务端判定的生成结论跟着追问卡走完整轮：下一轮据此直接进入生成，
  // 否则那时看到的只是画面描述，会被重新分类成聊天。
  const resolvedGeneration: BotanicAgentResolvedGeneration | undefined = input.synthesizedPrompt !== undefined
    ? {
      mediaKind: decision.mediaKind,
      prompt: input.synthesizedPrompt,
      ...(input.synthesizedCount ? { count: input.synthesizedCount } : {}),
      ...(input.synthesizedDuration ? { duration: input.synthesizedDuration } : {}),
      ...(input.synthesizedVariants?.length ? { variants: input.synthesizedVariants } : {}),
      ...(input.synthesizedVariants?.length && input.synthesizedAxisLabel ? { variationAxisLabel: input.synthesizedAxisLabel } : {}),
    }
    : undefined
  const carryOver = {
    ...(sourcePromptMessageId ? { sourcePromptMessageId } : {}),
    ...(resolvedGeneration ? { resolvedGeneration } : {}),
  }
  // 视频轮次用视频模型目录，图片轮次照旧；brief 的比例/清晰度追问由同一套表单驱动。
  const isVideo = decision.mediaKind === 'video'
  const candidateModels = isVideo
    ? generationModels.filter((model) => model.mediaKind === 'video')
    : generationModels.filter((model) => model.mediaKind !== 'video')
  if (isVideo && !candidateModels.length) return { kind: 'notice', notice: 'video_model_missing' }
  const inferredGenerationOverrides = inferBotanicAgentGenerationSettings(instruction, candidateModels)
  const requestedGenerationOverrides = { ...inferredGenerationOverrides, ...options.generationOverrides }
  // 变体轴决定要开几个分支，必须先于比例与清晰度确认；已确认过的取值不再重复追问。
  // 回合模型已结构化声明变体时语义解析完成，跳过正则追问；否则轴与取值只从用户原话解析：
  // 综合 Prompt 是模型写的画面描述，把它当指令会被正则挖成伪变体。
  // 视频一次一条、局部重绘一次一张，都不进入变体展开。
  const structuredVariants = !isVideo && !options.region && input.synthesizedVariants && input.synthesizedVariants.length >= 2
    ? input.synthesizedVariants
    : undefined
  const pendingVariation = isVideo || options.region || structuredVariants ? undefined : botanicAgentPendingVariationClarification({
    instruction,
    locale: input.locale,
    requestedIntent: input.requestedIntent,
    clarificationAnswers: options.clarificationAnswers,
    brief: options.creativeBrief,
    assetGroup: input.variationAssetGroup,
  })
  if (pendingVariation) {
    return { kind: 'ask', clarification: { ...pendingVariation, ...carryOver } }
  }
  const briefTurn = advanceBotanicCreativeBrief({
    mode: 'generation',
    locale: input.locale,
    executionMode: input.executionMode,
    instruction: prompt,
    generationModels: candidateModels,
    // 视频设置不继承图片配方：比例与清晰度必须落在视频模型自己的目录里。
    inheritedSettings: isVideo ? undefined : target?.inheritedSettings,
    requestedSettings: requestedGenerationOverrides,
    previousBrief: options.creativeBrief,
    answers: options.clarificationAnswers,
  })
  if (briefTurn.kind === 'ask') {
    return {
      kind: 'ask',
      clarification: {
        ...briefTurn.clarification,
        brief: botanicAgentBriefWithVariationAnswers(briefTurn.clarification.brief, options.clarificationAnswers),
        ...carryOver,
      },
    }
  }
  if (briefTurn.kind === 'failed') return { kind: 'failed', message: briefTurn.message }
  const generationOverrides = briefTurn.settings
  const settingsComplete = Boolean(generationOverrides.model && generationOverrides.aspectRatio && generationOverrides.resolution)
  if (!settingsComplete) return {
    kind: 'failed',
    message: input.locale === 'en'
      ? 'No complete generation settings are available. Check the model catalog.'
      : '当前没有可用的完整生成设置，请检查模型目录。',
  }
  // 视频计划一律走首帧语义：选中的结果图并进上下文作为首帧来源。
  const planContextItems = isVideo && target && !input.contextItems.some((item) => (item.nodeId ?? item.id) === target.id)
    ? [
      { id: target.id, label: target.label, kind: '结果' as const, image: target.image, mediaKind: 'image' as const },
      ...input.contextItems,
    ]
    : input.contextItems
  const selectedVideoModel = isVideo
    ? candidateModels.find((model) => model.id === generationOverrides.model)
    : undefined
  return {
    kind: 'ready',
    isVideo,
    useInitialFlow: !target || isVideo,
    instruction,
    prompt: briefTurn.prompt,
    brief: briefTurn.brief,
    generationOverrides,
    planSettings: {
      ...generationOverrides,
      ...(isVideo
        ? { duration: input.synthesizedDuration ?? selectedVideoModel?.defaultDuration ?? selectedVideoModel?.durations?.[0] ?? 5 }
        : {}),
    } as GenerationSettings,
    planContextItems,
    ...(!isVideo && input.synthesizedCount ? { outputCount: input.synthesizedCount } : {}),
    ...(structuredVariants ? { structuredVariants } : {}),
    ...(structuredVariants && input.synthesizedAxisLabel ? { variationAxisLabel: input.synthesizedAxisLabel } : {}),
    ...(sourcePromptMessageId ? { sourcePromptMessageId } : {}),
    carryOver,
  }
}

export type BotanicAgentInitialDraftPlanResult =
  | { kind: 'plan'; plan: BotanicAgentPlan }
  | { kind: 'clarification'; clarification: BotanicAgentClarification }

/**
 * 无基准图（或视频）的首图/首帧计划构建。可能抛出领域错误（如缺少图片上下文），
 * 由编排层收尾运行轨迹并展示。
 */
export function buildBotanicAgentInitialDraftPlan(
  draft: Extract<BotanicAgentGenerationDraft, { kind: 'ready' }>,
  clarificationAnswers?: Record<string, string>,
  locale: 'zh-CN' | 'en' = 'zh-CN',
): BotanicAgentInitialDraftPlanResult {
  const initialPlan = buildBotanicAgentPlan({
    instruction: draft.prompt,
    locale,
    creativeBrief: draft.brief,
    intent: 'initial_generation',
    settings: draft.planSettings,
    contextSnapshot: createBotanicAgentContextSnapshot(draft.planContextItems),
    ...(draft.outputCount ? { outputCount: draft.outputCount } : {}),
  })
  // 视频一次一条，不做变体展开。模型结构化声明优先；否则轴与取值从用户原话解析，综合 Prompt 只做共享画面底。
  const applied = draft.isVideo
    ? { kind: 'plan' as const, plan: initialPlan }
    : applyBotanicAgentVariationToPlan(initialPlan, {
      instruction: draft.instruction,
      locale,
      requestedIntent: 'initial_generation',
      clarificationAnswers,
      brief: draft.brief,
      fallbackPrompt: draft.prompt,
      structuredVariants: draft.structuredVariants,
      variationAxisLabel: draft.variationAxisLabel,
    })
  if (applied.kind === 'clarification') {
    return { kind: 'clarification', clarification: { ...applied.clarification, ...draft.carryOver } }
  }
  return { kind: 'plan', plan: { ...initialPlan, ...applied.plan } }
}
