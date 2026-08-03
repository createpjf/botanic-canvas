import type { BotanicAgentClarification, BotanicAgentIntent, BotanicAgentMemoryItem, BotanicAgentPlan } from './agent.ts'
import type { AssetGroup, GenerationModelOption, GenerationRecipe, GenerationSettings } from './canvas.ts'

export type BotanicAgentPlanRequestInput = {
  projectId: string
  plannerModel?: string
  instruction: string
  requestedIntent?: BotanicAgentIntent
  selectedResultNodeId: string
  selectedResultLabel: string
  rootRecipe: GenerationRecipe
  assetGroup?: AssetGroup
  availableAssetGroups?: AssetGroup[]
  projectMemory?: BotanicAgentMemoryItem[]
  availableGenerationModels?: GenerationModelOption[]
  generationOverrides?: Partial<Pick<GenerationSettings, 'model' | 'aspectRatio' | 'resolution'>>
  clarificationAnswers?: Record<string, string>
}

export type BotanicAgentPlanRequest = {
  projectId: string
  plannerModel?: string
  instruction: string
  requestedIntent?: BotanicAgentIntent
  selectedResult: { nodeId: string; label: string }
  settings: GenerationRecipe['settings']
  references: Array<{ id: string; name: string; role: string; primary: boolean }>
  assetGroup?: { id: string; name: string; role: string; assetCount: number }
  assetGroups?: Array<{ id: string; name: string; role: string; assetCount: number }>
  projectMemory?: Array<{ id: string; kind: BotanicAgentMemoryItem['kind']; content: string }>
  generationModels?: Array<Pick<GenerationModelOption, 'id' | 'label' | 'provider' | 'mediaKind' | 'aspectRatios' | 'resolutions'>>
  clarificationAnswers?: Record<string, string>
}

export type BotanicAgentPlanDraft = Omit<BotanicAgentPlan, 'references' | 'rootRecipe'>

export type BotanicAgentPlanResponse =
  | { plan: BotanicAgentPlanDraft }
  | { clarification: BotanicAgentClarification }

export function buildBotanicAgentPlanRequest(input: BotanicAgentPlanRequestInput): BotanicAgentPlanRequest {
  return {
    projectId: input.projectId,
    ...(input.plannerModel ? { plannerModel: input.plannerModel } : {}),
    instruction: input.instruction.trim(),
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
    ...(input.projectMemory?.length ? {
      projectMemory: input.projectMemory.slice(0, 30).map((memory) => ({
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
      })),
    } : {}),
    ...(input.clarificationAnswers ? { clarificationAnswers: input.clarificationAnswers } : {}),
  }
}

export function completeBotanicAgentPlan(
  draft: BotanicAgentPlanDraft,
  input: BotanicAgentPlanRequestInput,
): BotanicAgentPlan {
  const resolvedAssetGroup = input.assetGroup
    ?? input.availableAssetGroups?.find((group) => group.id === draft.assetGroupId)
  const settings = { ...input.rootRecipe.settings, ...input.generationOverrides }
  return {
    ...draft,
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
