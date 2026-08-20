import type { AgentToolCallTrace, BotanicAgentExecutionMode, BotanicAgentMessage, BotanicAgentReasoningEntry } from './agent'
import type { GenerationAspectRatio, GenerationModelOption, GenerationResolution } from './canvas'
import type { ProductLocale } from '../i18n/core'

/**
 * Agent 回合契约：浏览器把整段对话交给服务端回合解析器，由模型判断这一步是聊天还是生成，
 * 并在生成时综合出可执行 Prompt。浏览器不再用正则猜测意图，也不再要求“字面 Prompt 才能复用”。
 */
export type BotanicAgentTurnRequestInput = {
  projectId: string
  locale: ProductLocale
  plannerModel?: string
  mountedSkillIds?: string[]
  messages: Pick<BotanicAgentMessage, 'role' | 'content'>[]
  contextNodeIds: string[]
  hasTarget?: boolean
  /** 选中结果图的名称。选中态决定这一步是改这张图还是新建一张，模型必须知道。 */
  selectedResultLabel?: string
  /** 会话执行模式。决定生成后是自动提交还是停在确认卡，模型据此陈述状态而不是猜。 */
  executionMode?: BotanicAgentExecutionMode
  generationModels?: Pick<GenerationModelOption, 'id' | 'label' | 'mediaKind' | 'aspectRatios' | 'resolutions'>[]
  maxOutputCount?: number
}

export type BotanicAgentTurnRequest = {
  projectId: string
  locale: ProductLocale
  plannerModel?: string
  mountedSkillIds?: string[]
  messages: Array<{ role: BotanicAgentMessage['role']; content: string }>
  contextNodeIds: string[]
  hasTarget: boolean
  selectedResultLabel?: string
  executionMode?: BotanicAgentExecutionMode
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
      /** 仅视频：时长（秒），取值来自视频模型目录。 */
      duration?: number
      settingsHint?: BotanicAgentTurnSettingsHint
      /** 模型结构化声明的变体：label 短名 + 相对共享画面的差异描述。有它就不再正则挖轴。 */
      variants?: Array<{ label: string; promptDelta: string }>
      /** 变化维度短名（如「肤色」），仅用于展示与追问文案。 */
      axisLabel?: string
      plannerModel?: string
      toolCalls?: AgentToolCallTrace[]
      /** 当轮运行说明；原始推理只在 AGENT_RAW_REASONING 时出现，不得写入消息。 */
      reasoning?: BotanicAgentReasoningEntry[]
    }
  | {
      kind: 'chat'
      answer: string
      plannerModel?: string
      sources?: string[]
      toolCalls?: AgentToolCallTrace[]
      reasoning?: BotanicAgentReasoningEntry[]
    }
  | {
      /** 模型判定核心信息缺失时的结构化中断；客户端据此进入等待作答，而不是当成普通回答。 */
      kind: 'clarification'
      question: string
      options?: string[]
      plannerModel?: string
      toolCalls?: AgentToolCallTrace[]
      reasoning?: BotanicAgentReasoningEntry[]
    }
  | {
      /** MCoT 分解：一次多资产请求被拆成结构化方案，客户端以方案卡呈现并逐项推进。 */
      kind: 'composition'
      theme: string
      items: Array<{
        index: number
        title: string
        purpose?: string
        mediaKind: 'image' | 'video'
        prompt: string
        count: number
        duration?: number
      }>
      plannerModel?: string
      toolCalls?: AgentToolCallTrace[]
      reasoning?: BotanicAgentReasoningEntry[]
    }

/**
 * 单条历史消息的上限，与服务端回合校验一致。助手回答可以长到 12000 字，
 * 整段历史原样回传会被判成请求非法；这里先截断，宁可少给上文也不让整轮 400。
 */
export const botanicAgentTurnMessageLimit = 4000

export function buildBotanicAgentTurnRequest(input: BotanicAgentTurnRequestInput): BotanicAgentTurnRequest {
  return {
    projectId: input.projectId,
    locale: input.locale,
    ...(input.plannerModel ? { plannerModel: input.plannerModel } : {}),
    ...(input.mountedSkillIds?.length ? { mountedSkillIds: [...new Set(input.mountedSkillIds)].slice(0, 16) } : {}),
    messages: input.messages.slice(-16).map((message) => ({
      role: message.role,
      content: message.content.slice(0, botanicAgentTurnMessageLimit),
    })),
    contextNodeIds: [...new Set(input.contextNodeIds)].slice(0, 32),
    hasTarget: Boolean(input.hasTarget),
    // 选中结果只在真的有选中时下发；没有选中却带标签会让模型以为在改图。
    ...(input.hasTarget && input.selectedResultLabel?.trim()
      ? { selectedResultLabel: input.selectedResultLabel.trim().slice(0, 160) }
      : {}),
    ...(input.executionMode ? { executionMode: input.executionMode } : {}),
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
