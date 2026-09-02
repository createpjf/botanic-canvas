// @ts-check

export const AGENT_CONTEXT_ACTIVE_FLAG = 'AGENT_CONTEXT_COMPACTION_V2'
export const AGENT_CONTEXT_SHADOW_FLAG = 'AGENT_CONTEXT_COMPACTION_V2_SHADOW'

/**
 * Context V2 的唯一放量决策。kill switch 优先于所有 rollout；active 又优先于 shadow，
 * 避免一次请求既被新路径服务、又被重复影子评估。
 */
export function resolveAgentContextRollout(input = {}) {
  const { featureFlags, rolloutFlags, userId, projectId } = input
  const context = { userId, projectId }
  if (featureFlags?.runtimeV2 === false || featureFlags?.contextCompactionV2 === false) {
    return Object.freeze({ mode: 'killed', servedVariant: 'legacy', rolloutMode: 'off' })
  }
  if (rolloutFlags?.isEnabled?.(AGENT_CONTEXT_ACTIVE_FLAG, context) === true) {
    return Object.freeze({
      mode: 'active', servedVariant: 'v2',
      rolloutMode: rolloutFlags?.describe?.(AGENT_CONTEXT_ACTIVE_FLAG)?.mode ?? 'all',
    })
  }
  if (rolloutFlags?.isEnabled?.(AGENT_CONTEXT_SHADOW_FLAG, context) === true) {
    return Object.freeze({
      mode: 'shadow', servedVariant: 'legacy', evaluatedVariant: 'v2',
      rolloutMode: rolloutFlags?.describe?.(AGENT_CONTEXT_SHADOW_FLAG)?.mode ?? 'all',
    })
  }
  return Object.freeze({ mode: 'control', servedVariant: 'legacy', rolloutMode: 'off' })
}

export function agentContextRolloutHealth(featureFlags, rolloutFlags) {
  const killed = featureFlags?.runtimeV2 === false || featureFlags?.contextCompactionV2 === false
  return Object.freeze({
    schemaVersion: 1,
    killSwitch: {
      enabled: !killed,
      killed,
      reload: 'restart-required',
    },
    active: rolloutFlags?.describe?.(AGENT_CONTEXT_ACTIVE_FLAG)
      ?? Object.freeze({ mode: 'off', invalidSelectorCount: 0 }),
    shadow: rolloutFlags?.describe?.(AGENT_CONTEXT_SHADOW_FLAG)
      ?? Object.freeze({ mode: 'off', invalidSelectorCount: 0 }),
  })
}
