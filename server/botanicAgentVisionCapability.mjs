// @ts-check

/**
 * Agent 看图能力集合。只有这些模型能原生多模态看图；
 * 其它 Composer 选型走 caption，再回到所选文本模型。
 */
export const AGENT_VISION_CAPABLE_MODELS = Object.freeze([
  'gemini-3.7-flash',
  'deepseek-v4-flash-vision-exp',
])

export function isAgentVisionCapableModel(model) {
  return AGENT_VISION_CAPABLE_MODELS.includes(typeof model === 'string' ? model.trim() : '')
}

/** 所选规划模型能看图时返回它自己，否则返回空串（不要劫持到环境变量）。 */
export function nativeAgentVisionModel(plannerModel) {
  const model = typeof plannerModel === 'string' ? plannerModel.trim() : ''
  return isAgentVisionCapableModel(model) ? model : ''
}

/** caption 降级默认；只给不能原生看图的规划模型用。 */
export function captionAgentVisionModel(runtimeConfig) {
  return typeof runtimeConfig?.agentVisionModel === 'string' ? runtimeConfig.agentVisionModel.trim() : ''
}
