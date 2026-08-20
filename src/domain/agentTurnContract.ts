import type { AgentToolCallTrace, BotanicAgentMessage } from './agent'
import type { GenerationAspectRatio, GenerationModelOption, GenerationResolution } from './canvas'

/**
 * Agent 回合契约：浏览器把整段对话交给服务端回合解析器，由模型判断这一步是聊天还是生成，
 * 并在生成时综合出可执行 Prompt。浏览器不再用正则猜测意图，也不再要求“字面 Prompt 才能复用”。
 */
export type BotanicAgentTurnRequestInput = {
  projectId: string
  plannerModel?: string
  messages: Pick<BotanicAgentMessage, 'role' | 'content'>[]
  contextNodeIds: string[]
  hasTarget?: boolean
  generationModels?: Pick<GenerationModelOption, 'id' | 'label' | 'mediaKind' | 'aspectRatios' | 'resolutions'>[]
  maxOutputCount?: number
}

export type BotanicAgentTurnRequest = {
  projectId: string
  plannerModel?: string
  messages: Array<{ role: BotanicAgentMessage['role']; content: string }>
  contextNodeIds: string[]
  hasTarget: boolean
  generationModels?: Array<Pick<GenerationModelOption, 'id' | 'label' | 'mediaKind' | 'aspectRatios' | 'resolutions'>>
  maxOutputCount?: number
}

export type BotanicAgentTurnSettingsHint = {
  model?: string
  aspectRatio?: GenerationAspectRatio
  resolution?: GenerationResolution
}

export type BotanicAgentTurnResult =
  | {
      kind: 'generation'
      mediaKind: 'image' | 'video'
      prompt: string
      count: number
      settingsHint?: BotanicAgentTurnSettingsHint
      plannerModel?: string
      toolCalls?: AgentToolCallTrace[]
    }
  | {
      kind: 'chat'
      answer: string
      plannerModel?: string
      sources?: string[]
      toolCalls?: AgentToolCallTrace[]
    }

/**
 * 单条历史消息的上限，与服务端回合校验一致。助手回答可以长到 12000 字，
 * 整段历史原样回传会被判成请求非法；这里先截断，宁可少给上文也不让整轮 400。
 */
export const botanicAgentTurnMessageLimit = 4000

export function buildBotanicAgentTurnRequest(input: BotanicAgentTurnRequestInput): BotanicAgentTurnRequest {
  return {
    projectId: input.projectId,
    ...(input.plannerModel ? { plannerModel: input.plannerModel } : {}),
    messages: input.messages.slice(-16).map((message) => ({
      role: message.role,
      content: message.content.slice(0, botanicAgentTurnMessageLimit),
    })),
    contextNodeIds: [...new Set(input.contextNodeIds)].slice(0, 32),
    hasTarget: Boolean(input.hasTarget),
    ...(input.generationModels?.length
      ? {
          generationModels: input.generationModels.slice(0, 30).map((model) => ({
            id: model.id,
            label: model.label,
            ...(model.mediaKind ? { mediaKind: model.mediaKind } : {}),
            ...(model.aspectRatios ? { aspectRatios: model.aspectRatios } : {}),
            ...(model.resolutions ? { resolutions: model.resolutions } : {}),
          })),
        }
      : {}),
    ...(input.maxOutputCount ? { maxOutputCount: input.maxOutputCount } : {}),
  }
}
