import type { GenerationModelOption } from '../domain/canvas'
import openAIProviderLogo from '../assets/providers/openai.png'
import miniMaxProviderLogo from '../assets/providers/minimax.png'

const geminiProviderLogo = '/provider-logos/gemini.png'

export const defaultAgentPlannerModels = [
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'deepseek-v4-flash-vision-exp',
  'kimi-k3',
  'gemini-3.7-flash',
  'glm-5',
]

export function modelProviderLogo(model?: GenerationModelOption) {
  const provider = model?.provider ?? (/minimax/i.test(model?.id ?? '') ? 'minimax' : /gemini|nano banana/i.test(model?.id ?? '') ? 'flock' : 'openai')
  if (provider === 'minimax') return miniMaxProviderLogo
  if (provider === 'flock') return geminiProviderLogo
  return openAIProviderLogo
}

export function modelDisplayLabel(model?: GenerationModelOption) {
  return (model?.label ?? model?.id ?? '').replace(/\s*·\s*(?:图像|视频|image|video).*$/iu, '').trim()
}

export function agentPlannerModelLabel(model: string) {
  if (model === 'deepseek-v4-pro') return 'DeepSeek V4 Pro'
  if (model === 'deepseek-v4-flash') return 'DeepSeek V4 Flash'
  if (model === 'deepseek-v4-flash-vision-exp') return 'DeepSeek V4 Flash Vision'
  if (model === 'kimi-k3') return 'Kimi K3'
  if (model === 'gemini-3.7-flash') return 'Gemini 3.7 Flash'
  if (model === 'glm-5') return 'GLM 5'
  return model
}

export function agentPlannerModelShortLabel(model: string) {
  if (model === 'gemini-3.7-flash') return 'Gemini'
  if (model === 'deepseek-v4-flash-vision-exp') return 'Vision'
  if (model === 'glm-5') return 'GLM-5'
  return agentPlannerModelLabel(model).replace(/^(DeepSeek|Kimi|MiniMax|Gemini|GLM)\s+/i, '')
}

export type AgentPlannerProvider = 'deepseek' | 'kimi' | 'minimax' | 'gemini' | 'glm' | 'other'

export function agentPlannerProvider(model: string): AgentPlannerProvider {
  if (/deepseek/i.test(model)) return 'deepseek'
  if (/kimi/i.test(model)) return 'kimi'
  if (/minimax/i.test(model)) return 'minimax'
  if (/gemini/i.test(model)) return 'gemini'
  if (/glm|zhipu|chatglm/i.test(model)) return 'glm'
  return 'other'
}
