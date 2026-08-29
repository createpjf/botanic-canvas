import type { BotanicAgentMessage, BotanicAgentReasoningEntry } from './agent.ts'
import { instructionRequestsBatchVariation } from './agent.ts'
import { instructionRequestsMarkOverlay } from './generationComposition.ts'
import type { GenerationAspectRatio, GenerationModelOption, GenerationResolution } from './canvas.ts'
import { GENERATION_ASPECT_RATIOS, NANO_BANANA_MODEL_ID } from './canvas.ts'
import { defaultImageGenerationModel } from './generationRecipe.ts'
import type { ProductLocale } from '../i18n/core'
import {
  customGenerationSizeFields,
  inferAspectRatioFromPixels,
  modelSupportsCustomSize,
  parseCustomGenerationSize,
  normalizeCustomGenerationSize,
} from './generationOutputSize.ts'

export type BotanicAgentChatMode = 'conversation' | 'prompt' | 'research'
export type BotanicAgentRequestRoute = BotanicAgentChatMode | 'generation'

export type BotanicAgentRequestDecision =
  | { kind: 'chat'; mode: BotanicAgentChatMode }
  | { kind: 'generation'; mediaKind: 'image' | 'video'; promptSource: 'instruction' | 'previous_prompt' }
  /** 裸确认语没有创作内容，只能去提交已存在的待确认计划，不能当成新指令送进规划器。 */
  | { kind: 'confirm_pending' }
  | { kind: 'clarification'; reason: 'unsupported_media' | 'ambiguous_action' | 'video_requires_reference' }

export type BotanicAgentGenerationPromptResolution =
  | { status: 'resolved'; prompt: string; sourceMessageId?: string; delta?: string }
  | { status: 'missing'; prompt: '' }

export type BotanicAgentGenerationSettingsHint = {
  model?: string
  aspectRatio?: GenerationAspectRatio
  resolution?: GenerationResolution
  outputWidth?: number
  outputHeight?: number
}

export type BotanicAgentChatRequestInput = {
  projectId: string
  locale: ProductLocale
  plannerModel?: string
  mountedSkillIds?: string[]
  mode: BotanicAgentChatMode
  messages: Pick<BotanicAgentMessage, 'role' | 'content'>[]
  contextNodeIds: string[]
}

export type BotanicAgentChatToolCall = {
  id: string
  name: string
  label: string
  risk: 'read' | 'write' | 'costly' | 'external'
  status: 'pending' | 'running' | 'awaiting_confirmation' | 'succeeded' | 'failed'
  requiresConfirmation: boolean
  summary?: string
  error?: string
}

export type BotanicAgentChatResponse = {
  answer: string
  mode: BotanicAgentChatMode
  plannerModel?: string
  toolCalls?: BotanicAgentChatToolCall[]
  /** 当轮运行说明；仅用于面板实时展示，不随消息持久化。 */
  reasoning?: BotanicAgentReasoningEntry[]
  sources?: string[]
}

const refersToPreviousPrompt = /(?:按照|按|使用|用|基于|拿).{0,8}(?:这个|上面的?|刚才的?|上一条|该|这段)(?:.{0,8}(?:prompt|提示词|提示语))?.{0,16}(?:生成|生图|出图|做一张|来一张)/iu

function previousPromptDelta(instruction: string) {
  const match = instruction.match(/(?:生成|生图|出图|做一张|来一张)(?:一张|一版|图片|画面)?[\s：:，,；;]*([^\s].+)$/iu)
  const delta = match?.[1]?.trim()
  return delta && !/^(?:一张|一版|图片|画面)$/u.test(delta) ? delta : undefined
}

export function resolveBotanicAgentGenerationPromptDecision(
  instruction: string,
  messages: Pick<BotanicAgentMessage, 'id' | 'role' | 'content' | 'prompt'>[],
  sourceMessageId?: string,
): BotanicAgentGenerationPromptResolution {
  const cleanInstruction = instruction.trim()
  const explicitSource = sourceMessageId
    ? messages.find((message) => message.id === sourceMessageId && message.role === 'assistant' && message.prompt?.trim())
    : undefined
  const referencesPrevious = Boolean(sourceMessageId) || refersToPreviousPrompt.test(cleanInstruction)
  if (!referencesPrevious) return { status: 'resolved', prompt: cleanInstruction }
  const promptMessage = explicitSource
    ?? [...messages].reverse().find((message) => message.role === 'assistant' && message.prompt?.trim())
  const basePrompt = promptMessage?.prompt?.trim()
  if (!basePrompt) return { status: 'missing', prompt: '' }
  const delta = previousPromptDelta(cleanInstruction)
  return {
    status: 'resolved',
    prompt: delta ? `${basePrompt}\n\n本次修改：${delta}` : basePrompt,
    ...(promptMessage?.id ? { sourceMessageId: promptMessage.id } : {}),
    ...(delta ? { delta } : {}),
  }
}

export function resolveBotanicAgentGenerationPrompt(
  instruction: string,
  messages: Pick<BotanicAgentMessage, 'id' | 'role' | 'content' | 'prompt'>[],
  sourceMessageId?: string,
) {
  const resolution = resolveBotanicAgentGenerationPromptDecision(instruction, messages, sourceMessageId)
  return resolution.status === 'resolved' ? resolution.prompt : ''
}

const acknowledgePrefix = /^(?:好的|好|嗯|行|可以的?|没问题|ok)[，,。!！~\s]*/iu
const bareGenerationConfirmation = /^(?:确认(?:生成|执行|提交)?|生成|生成吧|生成一下|开始生成|直接生成|马上生成|立即生成|开始执行|直接执行|马上执行|执行吧?|继续执行|开始吧|就(?:这样|按这个)(?:生成|执行)|按推荐(?:值|方案)(?:继续)?)[。！!～~\s]*$/u
const refersToHarnessExecution = /(?:执行链路|执行界面|接手.{0,12}待确认|待确认(?:任务|计划)|触发这批(?:生成)?节点|交接计划)/u
const asksForAdviceOrExplanation = /(?:为什么|为何|怎么|如何|什么意思|多久|多慢|是否|用了什么|给我.{0,8}建议|分析|比较|好吗|怎么样|哪次)/iu
const explicitVisualGeneration = /(?:帮我|请|直接|马上|按照|按|用|基于|拿)?\s*(?:生成|生图|出图|做一张|来一张|做一版|出一张|我要一张|创建一张)|(?:做成|转成)\s*(?:一段|一条)?\s*(?:视频|动图|video)|(?:我想要|我希望|我需要|想要|希望|需要)\s*(?:一张|一版)?\s*[^，。！？?!]{0,40}(?:图片|图|画面|海报|人像|照片)|(?:generate|create|make|edit)\s+(?:(?:an?|this|the)\s+)?(?:image|photo|video)|(?:i\s+)?want\s+(?:an?|the)\s+(?:image|photo|picture|visual)\b/iu
const explicitVisualChange = /(?:帮我|请|直接|把|将|给|我想(?:要)?|我希望|我需要).{0,8}(?:换|替换|改成|变成|变为|调整|重做).{0,16}(?:场景|背景|模特|人物|商品|动作|姿势|风格|光线|构图)|(?:换|替换|改成|变成|变为|重做).{0,8}(?:场景|背景|模特|人物|商品|动作|姿势|风格|光线|构图)|(?:把|将|给|我想(?:要)?|我希望|我需要)?\s*(?:场景|背景|模特|人物|商品|动作|姿势|风格|光线|构图|图|画面|照片).{0,8}(?:换|替换|改成|变成|变为|调整|重做)|(?:i\s+want\s+to\s+)?(?:turn|transform|change|edit)\s+(?:(?:this|the)\s+)?(?:image|photo|picture)\s+(?:into|to)\b/iu
const cancelsVisualGeneration = /(?:先\s*)?(?:不要|不用|别|暂不)\s*(?:再\s*)?(?:生成|生图|出图|做图|创建)|(?:先\s*)?不\s*(?:再\s*)?(?:生成|生图|出图|做图)(?:了)?|(?:取消|停止|中止|暂停)(?:当前|这次|刚才的)?(?:生成|生图|出图|任务)?/iu
const asksForPromptWork = /(?:怎么|如何).{0,16}(?:写|改|优化|润色).{0,8}(?:prompt|提示词|提示语)|(?:prompt|提示词|提示语).{0,16}(?:怎么|如何).{0,8}(?:写|改|优化|润色|更好)|(?:写|创作|生成|改写|优化|润色).{0,12}(?:prompt|提示词|提示语)/iu

function normalizedModelSearchValue(value: string) {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

export function inferBotanicAgentGenerationSettings(
  value: string,
  models: Pick<GenerationModelOption, 'id' | 'label' | 'provider' | 'mediaKind' | 'aspectRatios' | 'resolutions' | 'supportsCustomSize'>[],
): BotanicAgentGenerationSettingsHint {
  const normalizedText = normalizedModelSearchValue(value)
  const selectedModel = models.find((model) => {
    const candidates = [model.id, model.label]
      .map(normalizedModelSearchValue)
      .filter((candidate) => candidate.length >= 3)
    return candidates.some((candidate) => normalizedText.includes(candidate))
  })
  const ratioMatch = value.match(/\b(1|2|3|4|5|9|16|21)\s*[:：]\s*(1|2|3|4|5|9|16)\b/u)
  const ratioCandidate = ratioMatch ? `${ratioMatch[1]}:${ratioMatch[2]}` : undefined
  const ratio = ratioCandidate && (GENERATION_ASPECT_RATIOS as readonly string[]).includes(ratioCandidate)
    ? ratioCandidate as GenerationAspectRatio
    : undefined
  const wantsClarityBoost = /提高清晰度|更清晰|sharper/iu.test(value)
  const resolutionMatch = value.match(/\b(1|2|4)\s*k\b/iu)
  const resolution = wantsClarityBoost
    ? '4K' as GenerationResolution
    : resolutionMatch ? `${resolutionMatch[1]}K` as GenerationResolution : undefined
  const boostModel = wantsClarityBoost || resolution === '4K'
    ? models.find((model) => model.id === NANO_BANANA_MODEL_ID || model.resolutions?.includes('4K'))
    : undefined
  // 4K 是能力选择，不是对任意显式模型的强制参数。用户同时写 GPT Image 2 与
  // 4K 时必须落到真正声明 4K 的模型，不能形成 GPT + 4K 的不可执行组合。
  const effectiveModel = resolution === '4K' ? boostModel : selectedModel
  const supportedRatios = effectiveModel?.aspectRatios?.length
    ? effectiveModel.aspectRatios
    : [...new Set(models.flatMap((model) => model.aspectRatios ?? []))]
  const supportedResolutions = effectiveModel?.resolutions?.length
    ? effectiveModel.resolutions
    : [...new Set(models.flatMap((model) => model.resolutions ?? []))]
  const customModel = boostModel ? undefined : selectedModel ?? models.find((model) => modelSupportsCustomSize(model))
  const parsedCustomSize = parseCustomGenerationSize(value)
  const customSize = parsedCustomSize && modelSupportsCustomSize(customModel)
    ? normalizeCustomGenerationSize(parsedCustomSize.width, parsedCustomSize.height)
    : undefined
  const customRatio = customSize?.ok ? inferAspectRatioFromPixels(customSize.width, customSize.height) : undefined
  const aspectRatio = customRatio && (!supportedRatios.length || supportedRatios.includes(customRatio))
    ? customRatio
    : ratio && (!supportedRatios.length || supportedRatios.includes(ratio))
      ? ratio
      : undefined
  const supportedResolution = resolution === '4K'
    ? Boolean(boostModel)
    : Boolean(resolution && (!supportedResolutions.length || supportedResolutions.includes(resolution)))
  return {
    ...(effectiveModel ? { model: effectiveModel.id } : {}),
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(resolution && supportedResolution
      ? { resolution }
      : {}),
    ...(customSize?.ok ? { outputWidth: customSize.width, outputHeight: customSize.height } : {}),
  }
}

/**
 * 自动模式下补齐仍然缺失的输出设置：只从可信模型目录里取该模型自己支持的第一项，
 * 不发明目录之外的取值。补不齐时返回原提示，调用方仍会退回追问。
 */
export function completeBotanicAgentGenerationSettings(
  hint: BotanicAgentGenerationSettingsHint,
  models: Pick<GenerationModelOption, 'id' | 'label' | 'provider' | 'mediaKind' | 'aspectRatios' | 'resolutions' | 'supportsCustomSize'>[],
): BotanicAgentGenerationSettingsHint {
  const model = models.find((item) => item.id === hint.model)
    ?? defaultImageGenerationModel(models)
    ?? models[0]
  if (!model) return hint
  const customSize = modelSupportsCustomSize(model) ? customGenerationSizeFields(hint) : undefined
  const aspectRatio = customSize
    ? inferAspectRatioFromPixels(customSize.outputWidth, customSize.outputHeight)
    : hint.aspectRatio ?? (model.aspectRatios?.includes('3:4') ? '3:4' : model.aspectRatios?.[0])
  const everyday = (model.resolutions ?? []).filter((item) => item !== '4K')
  const resolution = hint.resolution ?? (everyday.includes('2K') ? '2K' : everyday[0] ?? model.resolutions?.[0])
  return {
    model: model.id,
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(resolution ? { resolution } : {}),
    ...customSize,
  }
}

export function isBotanicAgentPromptGenerationPending(
  sourceMessageId: string,
  messages: Pick<BotanicAgentMessage, 'kind' | 'status' | 'question'>[],
) {
  return messages.some((message) => (
    message.kind === 'question'
    && message.status === 'pending'
    && message.question?.sourcePromptMessageId === sourceMessageId
  ))
}

function isBareGenerationConfirmation(text: string) {
  if (bareGenerationConfirmation.test(text)) return true
  const stripped = text.replace(acknowledgePrefix, '').trim()
  return stripped !== text && Boolean(stripped) && bareGenerationConfirmation.test(stripped)
}

/**
 * 执行链路这类词只有出现在陈述句里才是「去提交那份计划」。
 * 同样的词出现在提问里只是在问它，据此自动提交会花掉用户没打算花的生成额度。
 */
function statesHarnessExecution(text: string) {
  if (!refersToHarnessExecution.test(text)) return false
  return !/[?？]/u.test(text) && !asksForAdviceOrExplanation.test(text)
}

/**
 * 只有明确的视觉执行请求才进入生成链路；咨询、解释和能力询问永远留在对话链路。
 * 这是防止 Agent 因一句“图片怎么改”就在画布创建空节点的单一边界。
 */
export function decideBotanicAgentRequest(value: string, hasGenerationTarget = false): BotanicAgentRequestDecision {
  const text = value.trim()
  if (!text) return { kind: 'chat', mode: 'conversation' }
  // 「确认生成」这类裸确认语不含任何画面信息。把它送进规划器只会得到一份凭空编写的样板计划，
  // 唯一正确的去处是提交对话里已存在的待确认计划。
  if (isBareGenerationConfirmation(text) || statesHarnessExecution(text)) return { kind: 'confirm_pending' }

  const asksAboutPreviousOutcome = /(?:没有|没|未).{0,8}(?:生成|生图|出图|结果)|(?:刚才|之前|上次)?.{0,6}(?:为什么|为何|怎么).{0,16}(?:没|未|不).{0,6}(?:成功|生成|反应|结果)/iu.test(text)
  const asksAboutCapability = /(?:你|agent).{0,8}(?:可以|能|支持).{0,12}(?:生成|生图|出图|做图|视频)|\bcan\s+you\s+(?:generate|create|make|edit)\b/iu.test(text)
  const contextualVisualCommand = /\b(?:generate|create|make|edit|change|turn|transform)\b.{0,32}\b(?:this|the)\s+(?:image|photo|picture|girl|woman|person|model|character|subject)\b/iu
  const hasContextualVisualCommand = hasGenerationTarget && contextualVisualCommand.test(text)
  if (cancelsVisualGeneration.test(text) || asksAboutPreviousOutcome || (asksAboutCapability && !hasContextualVisualCommand)) return { kind: 'chat', mode: 'conversation' }
  if (/(?:生成|写|创作).{0,12}(?:文案|标题|脚本|slogan)/iu.test(text) && !/(?:图片|画面|海报|视频|image|photo|video)/iu.test(text)) {
    return { kind: 'chat', mode: 'conversation' }
  }

  const explicitlyUsesPromptForGeneration = /(?:按照|使用|用|基于|拿).{0,16}(?:prompt|提示词|提示语).{0,16}(?:生成|生图|出图|做一张|来一张)/iu.test(text)
  const usesPreviousPromptForGeneration = refersToPreviousPrompt.test(text)
  if (explicitlyUsesPromptForGeneration || usesPreviousPromptForGeneration) {
    // 视频与显式生成路径同判：有图片可作首帧才进视频计划，否则请用户先指定首帧。
    if (/视频|video/iu.test(text)) {
      return hasGenerationTarget
        ? { kind: 'generation', mediaKind: 'video', promptSource: 'previous_prompt' }
        : { kind: 'clarification', reason: 'video_requires_reference' }
    }
    return { kind: 'generation', mediaKind: 'image', promptSource: 'previous_prompt' }
  }
  if (asksForPromptWork.test(text)) return { kind: 'chat', mode: 'prompt' }
  const wantsVisualExecution = hasContextualVisualCommand
    || instructionRequestsBatchVariation(text)
    || explicitVisualGeneration.test(text)
    || explicitVisualChange.test(text)
    || (hasGenerationTarget && instructionRequestsMarkOverlay(text))
  const asksThenGenerates = /(?:生成|生图|出图|做一张|来一张).{0,16}(?:\d+\s*张|一张|一版|图片|画面|海报)/iu.test(text)
    && !/[?？]/u.test(text)
  // 「哪次生成的 / 换场景的建议」仍是问答；「分析一下然后生成 3 张」才出图。
  if (asksForAdviceOrExplanation.test(text) && !asksThenGenerates && !hasContextualVisualCommand) {
    return { kind: 'chat', mode: 'conversation' }
  }
  if (/(?:prompt|提示词|提示语|提示词生成|写一段.*(?:提示|prompt)|润色提示)/iu.test(text)) return { kind: 'chat', mode: 'prompt' }
  if (/(?:检索|搜索|查找|查一下|研究|资料|联网|外部来源|项目里|画布中|有哪些素材|哪些节点|多少个节点)/iu.test(text)) return { kind: 'chat', mode: 'research' }
  if (/(?:你是谁|你能做什么|如何使用|怎么使用|怎么用|请解释|解释一下|日常聊天|闲聊|你可以|你能)/iu.test(text)) return { kind: 'chat', mode: 'conversation' }

  const mediaKind = /视频|video/iu.test(text) ? 'video' as const : 'image' as const
  // 视频以图片为首帧：有可用图片（选中结果或引用素材）才进入视频计划，否则先请用户指定首帧。
  if (mediaKind === 'video' && explicitVisualGeneration.test(text) && !hasGenerationTarget) {
    return { kind: 'clarification', reason: 'video_requires_reference' }
  }
  if (wantsVisualExecution) {
    return { kind: 'generation', mediaKind, promptSource: 'instruction' }
  }
  if (hasGenerationTarget && /^(?:保持|继续|再来|重试|重新|换|替换|调整)(?!.*[?？])/iu.test(text)) {
    return { kind: 'generation', mediaKind: 'image', promptSource: 'instruction' }
  }
  return { kind: 'chat', mode: 'conversation' }
}

/**
 * 通用 Agent 先路由，再决定是否进入生图 Planner；显式 Prompt/检索请求不应误触发生成。
 */
export function classifyBotanicAgentRequest(value: string, hasGenerationTarget = false): BotanicAgentRequestRoute {
  const decision = decideBotanicAgentRequest(value, hasGenerationTarget)
  return decision.kind === 'generation' ? 'generation' : decision.kind === 'chat' ? decision.mode : 'conversation'
}

/** 只有明确出图才走带生成目录的 Turn；识图/问答走对话，不携带生图工具面。 */
export function botanicAgentRequestUsesGenerationTurn(decision?: BotanicAgentRequestDecision) {
  return decision?.kind === 'generation'
}

export function botanicAgentComposerIntentHint(
  decision: BotanicAgentRequestDecision,
  input: { hasVisualContext?: boolean },
  locale: ProductLocale,
) {
  const english = locale === 'en'
  if (decision.kind === 'generation') {
    return english
      ? (decision.mediaKind === 'video' ? 'This send will plan a video' : 'This send will plan an image')
      : (decision.mediaKind === 'video' ? '这一步将规划视频' : '这一步将规划出图')
  }
  if (decision.kind === 'clarification') {
    return english ? 'A first-frame image is needed first' : '需要先指定首帧图片'
  }
  if (decision.kind === 'confirm_pending') {
    return english ? 'This will confirm the pending plan' : '将确认当前待执行计划'
  }
  if (decision.mode === 'research') return english ? 'This send will search the project' : '这一步将检索项目'
  if (decision.mode === 'prompt') return english ? 'This send will work on the prompt' : '这一步将处理提示词'
  if (input.hasVisualContext) {
    return english ? 'This send will analyze the referenced image, not generate' : '这一步将分析引用图，不会出图'
  }
  return english ? 'This send is a conversation, not generation' : '这一步是问答，不会出图'
}

export function buildBotanicAgentChatRequest(input: BotanicAgentChatRequestInput) {
  return {
    projectId: input.projectId,
    locale: input.locale,
    ...(input.plannerModel ? { plannerModel: input.plannerModel } : {}),
    ...(input.mountedSkillIds?.length ? { mountedSkillIds: [...new Set(input.mountedSkillIds)].slice(0, 16) } : {}),
    mode: input.mode,
    messages: input.messages.slice(-16).map((message) => ({ role: message.role, content: message.content })),
    contextNodeIds: [...new Set(input.contextNodeIds)].slice(0, 32),
  }
}
