const truthy = new Set(['1', 'true', 'yes', 'on'])

function flag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback
  return truthy.has(String(value).trim().toLowerCase())
}

/**
 * V2 旗标集中在一个纯 Module 中，避免路由、Worker 和浏览器各自解析环境变量。
 * V2 已经完成并默认启用；健康检查会回显部署状态，旧入口只作为兼容 Adapter。
 */
export function resolveAgentFeatureFlags(env = process.env) {
  return Object.freeze({
    runtimeV2: flag(env.AGENT_RUNTIME_V2, true),
    qualityV2: flag(env.AGENT_QUALITY_V2, true),
    memoryV2: flag(env.AGENT_MEMORY_V2, true),
    skillGovernanceV2: flag(env.AGENT_SKILL_GOVERNANCE_V2, true),
    forkCompareV2: flag(env.AGENT_FORK_COMPARE_V2, true),
  })
}

export function agentFeatureEnabled(flags, name) {
  return Boolean(flags && flags[name])
}
