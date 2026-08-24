// @ts-check

/**
 * 全仓 Feature Flag 的唯一来源。这里有两类语义不同的旗标，混用会出事故，因此分开声明：
 *
 * 1. **已发布功能的 kill switch**（`resolveAgentFeatureFlags`）：功能已完成并默认
 *    启用，旗标只用于出问题时紧急关闭。**默认 true。**
 * 2. **升级期灰度闸门**（`ROLLOUT_FLAGS` / `createRolloutFlags`）：功能尚未建成或
 *    正在灰度，必须显式开启，且支持按项目/用户放量。**默认 false。**
 *
 * 把第 2 类写成默认 true 会让未完成的路径在生产直接生效；把第 1 类写成默认 false
 * 会让已上线功能在没配置的部署上静默消失。两者不能共用一个解析函数。
 */

const truthy = new Set(['1', 'true', 'yes', 'on'])

function flag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback
  return truthy.has(String(value).trim().toLowerCase())
}

/**
 * 已发布 V2 能力的 kill switch。集中在一个纯 Module 中，避免路由、Worker 和浏览器
 * 各自解析环境变量；健康检查会回显部署状态，旧入口只作为兼容 Adapter。
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

/**
 * 升级期灰度闸门词表。灰度、回滚与影子对比都以这里为唯一来源。
 *
 * 名称必须声明。查询未声明的名称会抛错，不会静默返回 false —— 一个拼错的 Flag
 * 名如果静默为假，对应功能会永远打不开而且没有任何信号，这是升级期最难查的一类
 * 问题（与用错误文案反推执行阶段同类）。
 */
export const ROLLOUT_FLAGS = Object.freeze([
  'AGENT_TURN_RESUME_V3',
  'AGENT_ACTIVE_CANCEL_V3',
  'AGENT_COMPILED_PLAN_V2',
  'AGENT_REVIEW_WORKER_V3',
  'AGENT_OPERATIONAL_TOOLS_V2',
  'PRODUCTION_WORKFLOW_V2',
])

const flagSet = new Set(ROLLOUT_FLAGS)

const TRUTHY = new Set(['true', '1', 'on', 'yes'])
const FALSY = new Set(['false', '0', 'off', 'no', ''])

/**
 * 把单个环境变量值解析为规则。
 *
 * - 未设置或 falsy 字面量 → 全部关闭（升级期的安全默认值）
 * - truthy 字面量 → 全部开启
 * - 其余按逗号分隔的选择器：`project:<id>` 或 `user:<id>`
 *
 * 选择器写错（既不是 project: 也不是 user: 前缀）会被忽略并记入 `invalid`，
 * 由调用方决定是否上报；这里不抛错，避免一个配置笔误让服务起不来。
 *
 * @param {string | undefined} raw
 */
export function parseRolloutFlagRule(raw) {
  const value = typeof raw === 'string' ? raw.trim() : ''
  const normalized = value.toLowerCase()
  if (FALSY.has(normalized)) return { mode: 'off', projectIds: [], userIds: [], invalid: [] }
  if (TRUTHY.has(normalized)) return { mode: 'all', projectIds: [], userIds: [], invalid: [] }
  const projectIds = []
  const userIds = []
  const invalid = []
  for (const entry of value.split(',').map((item) => item.trim()).filter(Boolean)) {
    if (entry.startsWith('project:')) projectIds.push(entry.slice('project:'.length))
    else if (entry.startsWith('user:')) userIds.push(entry.slice('user:'.length))
    else invalid.push(entry)
  }
  const mode = projectIds.length || userIds.length ? 'scoped' : 'off'
  return { mode, projectIds, userIds, invalid }
}

/**
 * 从环境变量构建 Flag 解析器。默认全关：升级期任何新路径都必须显式开启，
 * 因此「关闭全部新 Flag 后现有行为不变」是默认状态而不是需要额外保证的状态。
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function createRolloutFlags(env = process.env) {
  /** @type {Map<string, ReturnType<typeof parseRolloutFlagRule>>} */
  const rules = new Map()
  for (const name of ROLLOUT_FLAGS) rules.set(name, parseRolloutFlagRule(env[name]))

  /**
   * @param {string} name
   * @param {{ projectId?: string, userId?: string }} [context]
   */
  function isEnabled(name, context) {
    if (!flagSet.has(name)) throw new TypeError(`未声明的 Feature Flag：${name}`)
    const rule = rules.get(name)
    if (!rule || rule.mode === 'off') return false
    if (rule.mode === 'all') return true
    const projectId = context?.projectId
    const userId = context?.userId
    return Boolean(
      (projectId && rule.projectIds.includes(projectId))
      || (userId && rule.userIds.includes(userId)),
    )
  }

  /**
   * 某个上下文下已开启的 Flag 名单。只含名称，可安全进日志与影子指标；
   * 不返回选择器内容，避免把白名单里的项目或用户标识写进日志。
   *
   * @param {{ projectId?: string, userId?: string }} [context]
   */
  function enabledFor(context) {
    return ROLLOUT_FLAGS.filter((name) => isEnabled(name, context))
  }

  /** 配置笔误汇总，供启动时告警。 */
  function invalidSelectors() {
    return ROLLOUT_FLAGS.flatMap((name) => (rules.get(name)?.invalid ?? []).map((entry) => ({ name, entry })))
  }

  return { isEnabled, enabledFor, invalidSelectors }
}
