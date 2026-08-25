import type { BotanicAgentClarification, BotanicAgentContextSnapshot, BotanicAgentIntent, BotanicAgentMemoryItem, BotanicAgentPlan, BotanicAgentReasoningEntry, BotanicCreativeBrief } from './agent.ts'
import { BOTANIC_AGENT_MAX_SINGLE_OUTPUT, summarizeBotanicAgentNodeTitle } from './agent.ts'
import type { AssetGroup, GenerationModelOption, GenerationRecipe, GenerationSettings } from './canvas.ts'
import type { ProductLocale } from '../i18n/core'

export type BotanicAgentPlanRequestInput = {
  projectId: string
  locale: ProductLocale
  plannerModel?: string
  mountedSkillIds?: string[]
  instruction: string
  /** 用户原话。变体轴只从它解析；instruction 在综合 Prompt 链路里是模型写的画面描述。 */
  sourceInstruction?: string
  /** 回合模型结构化声明的变体：有它就直接展开，规划器不再从自然语言里挖轴。 */
  structuredVariants?: Array<{ label: string; promptDelta: string }>
  variationAxisLabel?: string
  requestedIntent?: BotanicAgentIntent
  selectedResultNodeId: string
  selectedResultLabel: string
  rootRecipe: GenerationRecipe
  assetGroup?: AssetGroup
  availableAssetGroups?: AssetGroup[]
  projectMemory?: BotanicAgentMemoryItem[]
  availableGenerationModels?: GenerationModelOption[]
  generationOverrides?: Partial<Pick<GenerationSettings, 'model' | 'aspectRatio' | 'resolution' | 'outputWidth' | 'outputHeight'>>
  clarificationAnswers?: Record<string, string>
  creativeBrief?: BotanicCreativeBrief
  contextSnapshot?: BotanicAgentContextSnapshot[]
  /** 本轮请求的单次生成张数；素材组批量与变体展开的张数由各自规则决定，不受它影响。 */
  outputCount?: number
}

export type BotanicAgentPlanRequest = {
  projectId: string
  locale: ProductLocale
  plannerModel?: string
  mountedSkillIds?: string[]
  instruction: string
  sourceInstruction?: string
  structuredVariants?: Array<{ label: string; promptDelta: string }>
  variationAxisLabel?: string
  requestedIntent?: BotanicAgentIntent
  selectedResult: { nodeId: string; label: string }
  settings: GenerationRecipe['settings']
  references: Array<{ id: string; name: string; role: string; primary: boolean }>
  assetGroup?: { id: string; name: string; role: string; assetCount: number }
  assetGroups?: Array<{ id: string; name: string; role: string; assetCount: number }>
  projectMemory?: Array<{ id: string; kind: BotanicAgentMemoryItem['kind']; content: string }>
  generationModels?: Array<Pick<GenerationModelOption, 'id' | 'label' | 'provider' | 'mediaKind' | 'aspectRatios' | 'resolutions' | 'supportsCustomSize'>>
  clarificationAnswers?: Record<string, string>
  creativeBrief?: BotanicCreativeBrief
  contextSnapshot?: BotanicAgentContextSnapshot[]
  parentPrompt?: string
  outputCount?: number
}

export type BotanicAgentPlanDraft = Omit<BotanicAgentPlan, 'references' | 'rootRecipe'>

/**
 * reasoning 刻意是 plan / clarification 的**兄弟字段**：计划会被原样持久化到会话消息里，
 * 提供方原始推理只允许随当轮响应下发用于实时展示，所以它不能进入计划本体。
 */
export type BotanicAgentPlanResponse =
  | { plan: BotanicAgentPlanDraft; reasoning?: BotanicAgentReasoningEntry[] }
  | { clarification: BotanicAgentClarification; reasoning?: BotanicAgentReasoningEntry[] }

function requestedSingleOutputCount(outputCount: number | undefined) {
  if (typeof outputCount !== 'number' || !Number.isFinite(outputCount)) return undefined
  return Math.max(1, Math.min(BOTANIC_AGENT_MAX_SINGLE_OUTPUT, Math.floor(outputCount)))
}

function confirmedProjectMemory(memory: BotanicAgentMemoryItem[] | undefined) {
  return (memory ?? []).filter((item) => item.confidence !== 'provisional')
}

/**
 * 规划请求与计划绑定必须取**同一份**清单。
 *
 * 绑定记录的是「这次规划实际读到了什么」，也进计划指纹；两边各写一套上限或去重，
 * 绑定就会漏记真正影响了计划的条目 —— 之前请求发 30 条记忆 / 16 个 Skill，绑定
 * 只记 12 条，多出来的部分影响了计划却查不到。
 */
const plannerMemoryLimit = 30
const plannerSkillLimit = 16

function plannerProjectMemory(memory: BotanicAgentMemoryItem[] | undefined) {
  return confirmedProjectMemory(memory).slice(0, plannerMemoryLimit)
}

function plannerMountedSkillIds(ids: string[] | undefined) {
  return [...new Set(ids ?? [])].slice(0, plannerSkillLimit)
}

export function buildBotanicAgentPlanRequest(input: BotanicAgentPlanRequestInput): BotanicAgentPlanRequest {
  const outputCount = requestedSingleOutputCount(input.outputCount)
  const projectMemory = plannerProjectMemory(input.projectMemory)
  return {
    projectId: input.projectId,
    locale: input.locale,
    ...(input.plannerModel ? { plannerModel: input.plannerModel } : {}),
    ...(input.mountedSkillIds?.length ? { mountedSkillIds: plannerMountedSkillIds(input.mountedSkillIds) } : {}),
    instruction: input.instruction.trim(),
    ...(input.sourceInstruction?.trim() ? { sourceInstruction: input.sourceInstruction.trim() } : {}),
    ...(input.structuredVariants?.length
      ? {
          structuredVariants: input.structuredVariants
            .filter((variant) => variant.label?.trim() && variant.promptDelta?.trim())
            .slice(0, 8)
            .map((variant) => ({ label: variant.label.trim(), promptDelta: variant.promptDelta.trim() })),
        }
      : {}),
    ...(input.structuredVariants?.length && input.variationAxisLabel?.trim()
      ? { variationAxisLabel: input.variationAxisLabel.trim().slice(0, 16) }
      : {}),
    ...(input.requestedIntent ? { requestedIntent: input.requestedIntent } : {}),
    selectedResult: { nodeId: input.selectedResultNodeId, label: input.selectedResultLabel },
    settings: { ...input.rootRecipe.settings, ...input.generationOverrides },
    references: input.rootRecipe.references.map((reference) => ({
      id: reference.nodeId,
      name: reference.name,
      role: reference.role,
      primary: Boolean(reference.primary),
    })),
    ...(input.assetGroup ? {
      assetGroup: {
        id: input.assetGroup.id,
        name: input.assetGroup.name,
        role: input.assetGroup.role,
        assetCount: input.assetGroup.assetIds.length,
      },
    } : {}),
    ...(input.availableAssetGroups ? {
      assetGroups: input.availableAssetGroups.filter((group) => group.assetIds.length > 0).map((group) => ({
        id: group.id,
        name: group.name,
        role: group.role,
        assetCount: group.assetIds.length,
      })),
    } : {}),
    ...(projectMemory.length ? {
      projectMemory: projectMemory.map((memory) => ({
        id: memory.id,
        kind: memory.kind,
        content: memory.content,
      })),
    } : {}),
    ...(input.availableGenerationModels?.length ? {
      generationModels: input.availableGenerationModels.slice(0, 30).map((model) => ({
        id: model.id,
        label: model.label,
        ...(model.provider ? { provider: model.provider } : {}),
        ...(model.mediaKind ? { mediaKind: model.mediaKind } : {}),
        ...(model.aspectRatios ? { aspectRatios: model.aspectRatios } : {}),
        ...(model.resolutions ? { resolutions: model.resolutions } : {}),
        ...(model.supportsCustomSize === undefined ? {} : { supportsCustomSize: model.supportsCustomSize }),
      })),
    } : {}),
    ...(input.clarificationAnswers ? { clarificationAnswers: input.clarificationAnswers } : {}),
    ...(input.creativeBrief ? { creativeBrief: structuredClone(input.creativeBrief) } : {}),
    ...(input.contextSnapshot?.length ? { contextSnapshot: input.contextSnapshot } : {}),
    ...(input.rootRecipe.prompt.trim() ? { parentPrompt: input.rootRecipe.prompt } : {}),
    ...(outputCount ? { outputCount } : {}),
  }
}

export function completeBotanicAgentPlan(
  draft: BotanicAgentPlanDraft,
  input: BotanicAgentPlanRequestInput,
): BotanicAgentPlan {
  const projectMemory = plannerProjectMemory(input.projectMemory)
  const resolvedAssetGroup = input.assetGroup
    ?? input.availableAssetGroups?.find((group) => group.id === draft.assetGroupId)
  const settings = { ...input.rootRecipe.settings, ...input.generationOverrides }
  const outputCount = requestedSingleOutputCount(input.outputCount)
  return {
    ...draft,
    // 尚未认识本轮张数的服务端仍会回单张；单次生成按请求张数收敛，
    // 素材组批量与变体展开的张数由各自规则决定，不在这里改写。
    ...(outputCount && draft.output.mode === 'single'
      ? { output: { ...draft.output, count: outputCount } }
      : {}),
    title: summarizeBotanicAgentNodeTitle(draft),
    ...(input.creativeBrief ? { creativeBrief: structuredClone(input.creativeBrief) } : {}),
    ...(input.contextSnapshot?.length ? { contextSnapshot: input.contextSnapshot } : {}),
    ...(projectMemory.length ? {
      memoryBindings: projectMemory.map((memory) => ({
        id: memory.id,
        ...(memory.version ? { version: memory.version } : {}),
        ...(memory.contentHash ? { contentHash: memory.contentHash } : {}),
        selectionReason: '规划阶段读取的项目记忆',
      })),
    } : {}),
    ...(input.mountedSkillIds?.length ? {
      skillBindings: plannerMountedSkillIds(input.mountedSkillIds).map((id) => ({ id, selectionReason: '本轮对话已挂载 Skill' })),
    } : {}),
    settings,
    references: [
      { source: 'selected_result', id: input.selectedResultNodeId, label: input.selectedResultLabel },
      ...input.rootRecipe.references.map((reference) => ({
        source: 'root_recipe' as const,
        id: reference.nodeId,
        label: reference.name,
        role: reference.role,
      })),
      ...(resolvedAssetGroup ? [{
        source: 'asset_group' as const,
        id: resolvedAssetGroup.id,
        label: resolvedAssetGroup.name,
        role: resolvedAssetGroup.role,
      }] : []),
    ],
    rootRecipe: input.rootRecipe,
  }
}
