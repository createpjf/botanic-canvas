import {
  isAgentReferenceStage, isAgentReferenceMode, isAgentReferenceReason,
  type AgentReferenceStage, type AgentReferenceMode, type AgentReferenceReason,
} from './agentProtocol.generated.ts'

export type AgentReferenceUsageItem = {
  nodeId: string
  stage: AgentReferenceStage
  mode: AgentReferenceMode
  reason?: AgentReferenceReason
}
export type AgentReferenceUsage = { attemptId: string; items: AgentReferenceUsageItem[] }
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/u.test(value)

/** 实时流与历史事件共用白名单，不把 Provider/媒体字段保留进 UI。 */
export function readAgentReferenceUsage(value: unknown): AgentReferenceUsage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  if (!validId(raw.attemptId) || !Array.isArray(raw.items)) return undefined
  const items = readAgentReferenceUsageItems(raw.items)
  return items.length ? { attemptId: raw.attemptId, items } : undefined
}

export function readAgentReferenceUsageItems(value: unknown): AgentReferenceUsageItem[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.slice(0, 32).flatMap((item): AgentReferenceUsageItem[] => {
    if (!item || !validId(item.nodeId) || seen.has(item.nodeId)
      || !isAgentReferenceStage(item.stage) || !isAgentReferenceMode(item.mode)
      || ((item.stage === 'prepared' || item.stage === 'submitted') && item.mode === 'none')) return []
    seen.add(item.nodeId)
    return [{ nodeId: item.nodeId, stage: item.stage, mode: item.mode,
      ...(isAgentReferenceReason(item.reason) ? { reason: item.reason } : {}) }]
  })
}

export function agentReferenceUsageLabel(item: AgentReferenceUsageItem, locale: 'zh-CN' | 'en') {
  if (item.stage === 'prepared') return locale === 'en' ? 'Prepared' : '准备完成'
  if (item.stage === 'submitted') return locale === 'en'
    ? item.mode === 'image' ? 'Image in request' : 'Description in request'
    : item.mode === 'image' ? '请求含图片' : '请求含图片描述'
  const copy: Record<AgentReferenceReason, [string, string]> = {
    unavailable: ['无法读取', 'Unavailable'], forbidden: ['无权读取', 'Access denied'],
    unsupported: ['格式不支持', 'Unsupported format'], limit: ['超出 4 张上限', 'Over the 4-image limit'],
    too_large: ['图片过大', 'Image too large'], network: ['读取失败', 'Read failed'],
    not_configured: ['未配置看图能力', 'Vision unavailable'], description_failed: ['图片识别失败', 'Description failed'],
    context_omitted: ['未进入本次请求', 'Not in this request'],
  }
  return copy[item.reason ?? 'unavailable'][locale === 'en' ? 1 : 0]
}
