import type { GenerationModelOption } from '../domain/canvas'
import openAIProviderLogo from '../assets/providers/openai.png'
import miniMaxProviderLogo from '../assets/providers/minimax.png'

export const defaultAgentPlannerModels = ['deepseek-v4-pro', 'deepseek-v4-flash', 'kimi-k3']

export function modelProviderLogo(model?: GenerationModelOption) {
  const provider = model?.provider ?? (/minimax/i.test(model?.id ?? '') ? 'minimax' : 'openai')
  return provider === 'minimax' ? miniMaxProviderLogo : openAIProviderLogo
}

export function modelDisplayLabel(model?: GenerationModelOption) {
  return (model?.label ?? model?.id ?? '').replace(/\s*·\s*(?:图像|视频).*$/u, '').trim()
}

export function agentPlannerModelLabel(model: string) {
  if (model === 'deepseek-v4-pro') return 'DeepSeek V4 Pro'
  if (model === 'deepseek-v4-flash') return 'DeepSeek V4 Flash'
  if (model === 'kimi-k3') return 'Kimi K3'
  return model
}

export function agentPlannerModelShortLabel(model: string) {
  return agentPlannerModelLabel(model).replace(/^(DeepSeek|Kimi|MiniMax)\s+/i, '')
}

export type AgentPlannerProvider = 'deepseek' | 'kimi' | 'minimax' | 'other'

export function agentPlannerProvider(model: string): AgentPlannerProvider {
  if (/deepseek/i.test(model)) return 'deepseek'
  if (/kimi/i.test(model)) return 'kimi'
  if (/minimax/i.test(model)) return 'minimax'
  return 'other'
}
