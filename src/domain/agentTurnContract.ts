import type { AgentEntityReference, AgentToolCallTrace, BotanicAgentExecutionMode, BotanicAgentMessage, BotanicAgentReasoningEntry, BotanicAgentTurnRequestSnapshot } from './agent'
import type { GenerationAspectRatio, GenerationModelOption, GenerationResolution } from './canvas'
import type { ProductLocale } from '../i18n/core'

type BotanicAgentTurnInputMessage = Pick<BotanicAgentMessage, 'id' | 'content' | 'mentions'>
type BotanicAgentTurnLegacyMessage = Pick<BotanicAgentMessage, 'role' | 'content'>

type BotanicAgentTurnRequestBase = {
  projectId: string
  locale: ProductLocale
  plannerModel?: string
  mountedSkillIds?: string[]
  contextNodeIds: string[]
  hasTarget?: boolean
  /** 选中结果图的稳定画布节点身份；刷新恢复不得用当前选中代替。 */
  selectedResultNodeId?: string
  /** 选中结果图的名称。选中态决定这一步是改这张图还是新建一张，模型必须知道。 */
  selectedResultLabel?: string
  /** 会话执行模式。决定生成后是自动提交还是停在确认卡，模型据此陈述状态而不是猜。 */
  executionMode?: BotanicAgentExecutionMode
  generationModels?: Pick<GenerationModelOption, 'id' | 'label' | 'mediaKind' | 'aspectRatios' | 'resolutions'>[]
  maxOutputCount?: number
}

/**
 * Agent 回合契约：新客户端只声明会话与本轮用户 Message，历史由服务端权威实体重建；
 * 旧客户端仍可暂时发送 messages，服务端迁移期兼容后即可删除该分支。
 */
export type BotanicAgentTurnRequestInput = BotanicAgentTurnRequestBase & (
  | {
      /** 当前 Agent 会话。服务端用它从独立 Message 实体重建权威历史。 */
      sessionId: string
      /** 本轮用户消息的稳定身份；与本地气泡、离线交付和 Turn 共用同一个 ID。 */
      inputMessage: BotanicAgentTurnInputMessage
      /** 迁移期可用于影子比对，不再是新客户端的上下文来源。 */
      messages?: BotanicAgentTurnLegacyMessage[]
    }
  | {
      sessionId?: never
      inputMessage?: never
      /** 旧客户端兼容历史。 */
      messages: BotanicAgentTurnLegacyMessage[]
    }
)

export type BotanicAgentTurnRequest = {
  projectId: string
  sessionId?: string
  inputMessage?: BotanicAgentTurnInputMessage
  locale: ProductLocale
  plannerModel?: string
  mountedSkillIds?: string[]
  /** 旧客户端兼容历史；服务端权威会话路径不依赖它。 */
  messages?: Array<{ role: BotanicAgentMessage['role']; content: string }>
  contextNodeIds: string[]
  hasTarget: boolean
  selectedResultNodeId?: string
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

export type BotanicAgentTurnResult = (
  | {
      kind: 'generation'
      mediaKind: 'image' | 'video'
      prompt: string
      count: number
      /**
       * 这轮生成固定的父结果；null 表示明确的初始生成。
       * undefined 仅用于识别旧版未持久身份的结果，恢复时必须 fail closed。
       */
      selectedResultNodeId?: string | null
      /** 仅视频：时长（秒），取值来自视频模型目录。 */
      duration?: number
      settingsHint?: BotanicAgentTurnSettingsHint
      /** 模型结构化声明变体：label 短名 + 相对共享画面的差异描述。 */
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
      /** MCoT 分解：一次多资产请求被拆成结构化方案，条目归一后逐项推进。 */
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
) & {
  /** 当轮显式工具产生的有界业务引用；用于服务端 durable Message 与 compaction。 */
  entityReferences?: AgentEntityReference[]
}

/**
 * 单条历史消息的上限，与服务端回合校验一致。助手回答可以长到 12000 字，
 * 整段历史原样回传会被判成请求非法；这里先截断，宁可少给上文也不让整轮 400。
 */
export const botanicAgentTurnMessageLimit = 4000

export function buildBotanicAgentTurnRequest(input: BotanicAgentTurnRequestInput): BotanicAgentTurnRequest {
  return {
    projectId: input.projectId,
    ...(input.sessionId && input.inputMessage
      ? {
          sessionId: input.sessionId,
          inputMessage: {
            id: input.inputMessage.id,
            content: input.inputMessage.content.slice(0, botanicAgentTurnMessageLimit),
            ...(input.inputMessage.mentions?.length ? { mentions: input.inputMessage.mentions.map((mention) => ({ ...mention })) } : {}),
          },
        }
      : {}),
    locale: input.locale,
    ...(input.plannerModel ? { plannerModel: input.plannerModel } : {}),
    ...(input.mountedSkillIds?.length ? { mountedSkillIds: [...new Set(input.mountedSkillIds)].slice(0, 16) } : {}),
    ...(input.messages?.length
      ? {
          messages: input.messages.slice(-16).map((message) => ({
            role: message.role,
            content: message.content.slice(0, botanicAgentTurnMessageLimit),
          })),
        }
      : {}),
    contextNodeIds: [...new Set(input.contextNodeIds)].slice(0, 32),
    hasTarget: Boolean(input.hasTarget),
    ...(input.hasTarget && input.selectedResultNodeId?.trim()
      ? { selectedResultNodeId: input.selectedResultNodeId.trim().slice(0, 160) }
      : {}),
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

/** 在 Turn POST 前留在用户 Message 上的完整 safe request identity。 */
export function botanicAgentTurnRequestSnapshot(
  input: BotanicAgentTurnRequestInput,
): BotanicAgentTurnRequestSnapshot {
  const request = buildBotanicAgentTurnRequest(input)
  if (request.hasTarget && !request.selectedResultNodeId) {
    const error = new Error('选中结果缺少稳定节点身份。')
    Object.assign(error, { code: 'AGENT_TURN_TARGET_IDENTITY_MISSING' })
    throw error
  }
  return {
    locale: request.locale,
    ...(request.plannerModel ? { plannerModel: request.plannerModel } : {}),
    ...(request.mountedSkillIds?.length ? { mountedSkillIds: [...request.mountedSkillIds] } : {}),
    contextNodeIds: [...request.contextNodeIds],
    hasTarget: request.hasTarget,
    selectedResultNodeId: request.hasTarget ? request.selectedResultNodeId ?? null : null,
    ...(request.hasTarget && request.selectedResultLabel ? { selectedResultLabel: request.selectedResultLabel } : {}),
    ...(request.executionMode ? { executionMode: request.executionMode } : {}),
    ...(request.generationModels?.length
      ? { generationModels: request.generationModels.map((model) => ({ ...model })) }
      : {}),
    // 服务端 Turn validator 的固定默认值也是请求身份的一部分；显式落入快照，
    // 避免未来默认值变化或异常 POST 参与恢复。
    maxOutputCount: request.maxOutputCount ?? 8,
  }
}

/** 恢复时只组合 Message 稳定身份与先前持久化的 snapshot。 */
export function botanicAgentTurnRequestFromSnapshot(input: {
  projectId: string
  sessionId: string
  inputMessage: BotanicAgentTurnInputMessage
  snapshot: BotanicAgentTurnRequestSnapshot
}): BotanicAgentTurnRequestInput & {
  sessionId: string
  inputMessage: BotanicAgentTurnInputMessage
} {
  const { selectedResultNodeId, ...snapshot } = input.snapshot
  return buildBotanicAgentTurnRequest({
    projectId: input.projectId,
    sessionId: input.sessionId,
    inputMessage: input.inputMessage,
    ...snapshot,
    ...(selectedResultNodeId
      ? { selectedResultNodeId }
      : {}),
  }) as BotanicAgentTurnRequestInput & {
    sessionId: string
    inputMessage: BotanicAgentTurnInputMessage
  }
}
