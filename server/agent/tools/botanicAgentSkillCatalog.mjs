import {
  agentSkillExecutionContentHash,
  agentSkillManifestRisk,
  agentSkillVersion,
  BotanicAgentSkillError,
  normalizeAgentSkillManifest,
  normalizeBotanicAgentSkillCapabilities,
  resolveAgentSkillDependencyClosure,
  skillRiskOrder,
} from '../action/botanicAgentSkill.mjs'
import { estimateAgentContextTokens } from '../context/agentContextBudget.mjs'
import { AGENT_SEMANTIC_EVENT_NAMES, writeAgentSemanticEvent } from '../../observability/agentSemanticEvent.mjs'

function emitSkillOutcome(outcome, reason) {
  writeAgentSemanticEvent(AGENT_SEMANTIC_EVENT_NAMES.HARNESS_LIFECYCLE, {
    kind: 'skill',
    outcome,
    ...(reason ? { reason } : {}),
  })
}
import { readFileSync } from 'node:fs'

function readBuiltInSkill(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8').trim()
}

const skillCatalog = Object.freeze({
  controlled_edit: {
    label: '受控局部编辑',
    instructions: readBuiltInSkill('../../skills/controlled-edit/SKILL.md'),
  },
  batch_variation: {
    label: '批量变量生成',
    instructions: readBuiltInSkill('../../skills/batch-variation/SKILL.md'),
  },
  root_recipe_redo: {
    label: '按原参数重做',
    instructions: readBuiltInSkill('../../skills/root-recipe-redo/SKILL.md'),
  },
  ecommerce_listing: {
    label: '电商套图',
    instructions: readBuiltInSkill('../../skills/ecommerce-listing/SKILL.md'),
  },
  platform_pack: {
    label: '平台交付包',
    instructions: readBuiltInSkill('../../skills/platform-pack/SKILL.md'),
  },
  video_storyboard: {
    label: '静帧转视频分镜',
    instructions: readBuiltInSkill('../../skills/video-storyboard/SKILL.md'),
  },
  conversation_distill: {
    label: '对话沉淀 Skill',
    instructions: readBuiltInSkill('../../skills/conversation-distill/SKILL.md'),
  },
})

/**
 * Skill 的实际风险。
 *
 * 取「自称的能力」与「Manifest 白名单里的工具实际是什么风险」两者的**较高者**。
 *
 * 只按自称算的话，`capabilities` 是一句没人核对的话：一个项目 Skill 声明 `['read']`
 * 就会被直接应用、不需要用户确认（见下方 `skill_run`）。取较高者之后，少报能力
 * 不再能换来跳过确认。
 *
 * `riskOf` 由调用方从当前工具注册表提供；不给时退化为只按自称算 —— 那正是存量
 * Skill（没有 Manifest）今天的行为，不能因为这次改动而变得更宽松或更严格。
 *
 * @param {any} skill
 * @param {(name: string) => (string | undefined)} [riskOf]
 */
export function botanicAgentSkillRisk(skill, riskOf) {
  const capabilities = Array.isArray(skill?.capabilities) && skill.capabilities.length ? skill.capabilities : ['read']
  const declared = capabilities.reduce((risk, capability) => {
    // 历史数据里的未知能力按最高风险处理，不能因迁移缺字段而静默放行。
    const normalized = skillRiskOrder.includes(capability) ? capability : 'external'
    const current = skillRiskOrder.indexOf(normalized)
    return current > skillRiskOrder.indexOf(risk) ? normalized : risk
  }, 'read')
  if (!skill?.manifest?.toolAllowlist?.length) return declared
  const actual = agentSkillManifestRisk(skill.manifest, riskOf)
  return skillRiskOrder.indexOf(actual) > skillRiskOrder.indexOf(declared) ? actual : declared
}

/**
 * 内置 Skill 的版本与内容摘要。内容随代码发布，因此版本固定为 1，摘要按内容算 ——
 * Run 绑定里 version 与 contentHash 是必填（ADR 0006），内置 Skill 不能例外：
 * 留一个「系统 Skill 免填」的口子等于允许出现无法重放的 Run。
 */
const builtInSkillVersion = 1

export function botanicAgentBuiltInSkill(skillId) {
  const skill = skillCatalog[skillId]
  return skill ? {
    id: skillId,
    name: skill.label,
    instructions: skill.instructions,
    version: builtInSkillVersion,
    contentHash: agentSkillExecutionContentHash({
      name: skill.label,
      instructions: skill.instructions,
      capabilities: ['read'],
    }),
    capabilities: ['read'],
    lifecycle: 'published',
    status: 'active',
    source: 'system',
  } : undefined
}

export function botanicAgentSystemSkills() {
  return Object.keys(skillCatalog).map(botanicAgentBuiltInSkill)
}

function projectSkillEntries(projectSkills = []) {
  return (Array.isArray(projectSkills) ? projectSkills : [])
    .filter((skill) => skill?.status === 'active' && typeof skill.id === 'string' && typeof skill.name === 'string' && typeof skill.instructions === 'string')
    .filter((skill) => !skillCatalog[skill.id])
    .map((skill) => [skill.id, {
      label: skill.name,
      instructions: skill.instructions,
      source: 'project',
      ...(Number.isInteger(skill.version) ? { version: skill.version } : {}),
      ...(typeof skill.contentHash === 'string' ? { contentHash: skill.contentHash } : {}),
      capabilities: Array.isArray(skill.capabilities) ? skill.capabilities.slice(0, 12) : ['read'],
      ...(Array.isArray(skill.versions) ? { versions: structuredClone(skill.versions) } : {}),
      // Manifest 要跟着进目录：`skill_run` 算风险时读它，不带过来就等于没有 Manifest。
      ...(skill.manifest ? { manifest: skill.manifest } : {}),
    }])
}

/** 系统目录 + 当前项目已启用 Skill。同名 id 以系统目录为准，避免项目覆盖内置规则。
 * `builtIn`（H5）：恢复时传入 Turn 创建时冻结的内置语义 snapshot；部署后的内置目录
 * 变化不得替换原回合正文。 */
export function resolveBotanicAgentAvailableSkills(projectSkills = [], { builtIn } = {}) {
  const frozenBuiltIn = builtIn && typeof builtIn === 'object' && !Array.isArray(builtIn) ? builtIn : undefined
  const systemEntries = frozenBuiltIn
    ? Object.entries(frozenBuiltIn).map(([id, skill]) => [id, {
        label: skill.name,
        instructions: skill.instructions,
        source: 'system',
        version: skill.version,
        contentHash: skill.contentHash,
        capabilities: Array.isArray(skill.capabilities) ? skill.capabilities : ['read'],
        versions: [{
          version: skill.version,
          name: skill.name,
          instructions: skill.instructions,
          capabilities: Array.isArray(skill.capabilities) ? skill.capabilities : ['read'],
          contentHash: skill.contentHash,
        }],
      }])
    : Object.keys(skillCatalog).map((id) => {
        const skill = botanicAgentBuiltInSkill(id)
        return [id, {
          label: skill.name,
          instructions: skill.instructions,
          source: 'system',
          version: skill.version,
          contentHash: skill.contentHash,
          capabilities: skill.capabilities,
          versions: [{
            version: skill.version,
            name: skill.name,
            instructions: skill.instructions,
            capabilities: skill.capabilities,
            contentHash: skill.contentHash,
          }],
        }]
      })
  return { ...Object.fromEntries(systemEntries), ...Object.fromEntries(projectSkillEntries(projectSkills)) }
}

/** Skill Loader V2 防御边界（H5）。 */
const AGENT_SKILL_CATALOG_MAX_ITEMS = 128
const AGENT_SKILL_SNAPSHOT_MAX_BYTES = 64 * 1024

function invalidFrozenSkillCatalog(message, code = 'AGENT_SKILL_SNAPSHOT_MISMATCH') {
  throw new BotanicAgentSkillError(409, code, message)
}

function frozenCatalogObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidFrozenSkillCatalog(`${name}无效。`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalidFrozenSkillCatalog(`${name}必须是普通对象。`)
  return value
}

function frozenCatalogKeys(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalidFrozenSkillCatalog(`${name}包含不允许的字段：${key}。`)
  }
}

function frozenCatalogText(value, name, maximumLength) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximumLength) invalidFrozenSkillCatalog(`${name}无效。`)
  return value
}

function validateFrozenSkillCatalog(value) {
  const raw = frozenCatalogObject(value, 'Skill 冻结目录')
  frozenCatalogKeys(raw, new Set(['version', 'builtIn', 'project']), 'Skill 冻结目录')
  if (raw.version !== 1) invalidFrozenSkillCatalog('Skill 冻结目录版本无效。')
  let serialized
  try { serialized = JSON.stringify(raw) } catch { invalidFrozenSkillCatalog('Skill 冻结目录无法序列化。') }
  if (Buffer.byteLength(serialized, 'utf8') > AGENT_SKILL_SNAPSHOT_MAX_BYTES) {
    invalidFrozenSkillCatalog('Skill 目录冻结快照过大。', 'AGENT_SKILL_SNAPSHOT_TOO_LARGE')
  }
  const builtIn = frozenCatalogObject(raw.builtIn, '内置 Skill 冻结目录')
  if (!Array.isArray(raw.project)) invalidFrozenSkillCatalog('项目 Skill 冻结目录无效。')
  const ids = new Set()
  const normalizedBuiltIn = {}
  for (const [id, value] of Object.entries(builtIn)) {
    frozenCatalogText(id, '内置 Skill 标识', 160)
    const skill = frozenCatalogObject(value, `内置 Skill ${id}`)
    frozenCatalogKeys(skill, new Set(['name', 'instructions', 'version', 'contentHash', 'capabilities']), `内置 Skill ${id}`)
    if (!Number.isSafeInteger(skill.version) || skill.version < 1) invalidFrozenSkillCatalog(`内置 Skill ${id} 版本无效。`)
    if (!Array.isArray(skill.capabilities)) invalidFrozenSkillCatalog(`内置 Skill ${id} 能力无效。`)
    let capabilities
    try { capabilities = normalizeBotanicAgentSkillCapabilities(skill.capabilities) } catch { invalidFrozenSkillCatalog(`内置 Skill ${id} 能力无效。`) }
    normalizedBuiltIn[id] = {
      name: frozenCatalogText(skill.name, `内置 Skill ${id} 名称`, 80),
      instructions: frozenCatalogText(skill.instructions, `内置 Skill ${id} 规则`, 12_000),
      version: skill.version,
      contentHash: frozenCatalogText(skill.contentHash, `内置 Skill ${id} 内容摘要`, 200),
      capabilities,
    }
    ids.add(id)
  }
  const project = raw.project.map((value, index) => {
    const binding = frozenCatalogObject(value, `项目 Skill 冻结绑定 ${index + 1}`)
    frozenCatalogKeys(binding, new Set(['id', 'name', 'version', 'contentHash', 'capabilities', 'manifest']), `项目 Skill 冻结绑定 ${index + 1}`)
    const id = frozenCatalogText(binding.id, '项目 Skill 标识', 160)
    if (ids.has(id)) invalidFrozenSkillCatalog(`Skill 冻结目录标识重复：${id}。`)
    if (!Number.isSafeInteger(binding.version) || binding.version < 1) invalidFrozenSkillCatalog(`项目 Skill ${id} 版本无效。`)
    if (!Array.isArray(binding.capabilities)) invalidFrozenSkillCatalog(`项目 Skill ${id} 能力无效。`)
    let capabilities
    let manifest
    try {
      capabilities = normalizeBotanicAgentSkillCapabilities(binding.capabilities)
      if (binding.manifest !== undefined) {
        frozenCatalogKeys(frozenCatalogObject(binding.manifest, `项目 Skill ${id} Manifest`), new Set(['version', 'kind', 'outputSchema', 'toolAllowlist', 'dependencies']), `项目 Skill ${id} Manifest`)
        manifest = normalizeAgentSkillManifest(binding.manifest)
      }
    } catch { invalidFrozenSkillCatalog(`项目 Skill ${id} 冻结绑定无效。`) }
    ids.add(id)
    return {
      id,
      name: frozenCatalogText(binding.name, `项目 Skill ${id} 名称`, 80),
      version: binding.version,
      contentHash: frozenCatalogText(binding.contentHash, `项目 Skill ${id} 内容摘要`, 200),
      capabilities,
      ...(manifest ? { manifest } : {}),
    }
  })
  if (ids.size > AGENT_SKILL_CATALOG_MAX_ITEMS) {
    invalidFrozenSkillCatalog(`Skill 目录超过 ${AGENT_SKILL_CATALOG_MAX_ITEMS} 项，无法冻结。`, 'AGENT_SKILL_CATALOG_TOO_LARGE')
  }
  return { version: 1, builtIn: normalizedBuiltIn, project }
}

/**
 * 在 Turn 创建时冻结 Skill catalog（H5）：
 * - 内置 Skill 没有版本历史,完整语义 snapshot 一次冻结（不整体注入 prompt）;
 * - 项目 Skill 只存 metadata binding（id/name/version/contentHash/capabilities/manifest）,
 *   正文恢复时从不可变版本历史读取;
 * - 越界具名失败:catalog 超 128 项 AGENT_SKILL_CATALOG_TOO_LARGE,序列化超 64KB
 *   AGENT_SKILL_SNAPSHOT_TOO_LARGE。
 */
export function freezeBotanicAgentSkillCatalog(projectSkills = []) {
  const available = resolveBotanicAgentAvailableSkills(projectSkills)
  const entries = Object.entries(available)
  if (entries.length > AGENT_SKILL_CATALOG_MAX_ITEMS) {
    throw new BotanicAgentSkillError(409, 'AGENT_SKILL_CATALOG_TOO_LARGE', `Skill 目录超过 ${AGENT_SKILL_CATALOG_MAX_ITEMS} 项，无法冻结。`)
  }
  const builtIn = {}
  const project = []
  for (const [id, skill] of entries) {
    if ((skill.source ?? 'system') === 'project') {
      if (!Number.isSafeInteger(skill.version) || skill.version < 1 || typeof skill.contentHash !== 'string' || !skill.contentHash.trim()) {
        invalidFrozenSkillCatalog(`项目 Skill ${id} 缺少不可变版本身份。`)
      }
      project.push({
        id,
        name: skill.label,
        ...(Number.isInteger(skill.version) ? { version: skill.version } : {}),
        ...(typeof skill.contentHash === 'string' ? { contentHash: skill.contentHash } : {}),
        ...(Array.isArray(skill.capabilities) ? { capabilities: [...skill.capabilities] } : {}),
        ...(skill.manifest ? { manifest: structuredClone(skill.manifest) } : {}),
      })
    } else {
      builtIn[id] = {
        name: skill.label,
        instructions: skill.instructions,
        version: skill.version,
        contentHash: skill.contentHash,
        capabilities: Array.isArray(skill.capabilities) ? [...skill.capabilities] : ['read'],
      }
    }
  }
  return validateFrozenSkillCatalog({ version: 1, builtIn, project })
}

/**
 * 恢复时按冻结 catalog 固定项目 Skill 正文（H5）：当前版本命中直接用,否则从
 * 不可变版本历史读取;历史丢失或 hash 不一致报 AGENT_SKILL_SNAPSHOT_MISMATCH,
 * 在 Provider 调用前失败。返回形如 projectSkills 的数组供既有解析器消费。
 */
export function pinnedBotanicAgentProjectSkills(frozenCatalog, currentProjectSkills = []) {
  if (frozenCatalog === undefined || frozenCatalog === null) return currentProjectSkills
  const frozen = validateFrozenSkillCatalog(frozenCatalog)
  const byId = new Map((Array.isArray(currentProjectSkills) ? currentProjectSkills : []).filter((skill) => skill?.id).map((skill) => [skill.id, skill]))
  const mismatch = (message) => {
    emitSkillOutcome('snapshot_mismatch', 'AGENT_SKILL_SNAPSHOT_MISMATCH')
    throw new BotanicAgentSkillError(409, 'AGENT_SKILL_SNAPSHOT_MISMATCH', message)
  }
  return frozen.project.map((binding) => {
    const current = byId.get(binding.id)
    if (!current) {
      mismatch(`项目 Skill ${binding.id} 已不存在，无法按原回合恢复。`)
    }
    const currentMatches = Number(current.version) === binding.version && current.contentHash === binding.contentHash
    if (currentMatches) return { ...current, status: 'active' }
    const snapshot = agentSkillVersion(current, binding.version)
    if (!snapshot || (binding.contentHash && snapshot.contentHash !== binding.contentHash)) {
      mismatch(`项目 Skill ${binding.id}@${binding.version ?? '?'} 的历史版本缺失或内容不一致。`)
    }
    return {
      ...current,
      status: 'active',
      name: typeof snapshot.name === 'string' ? snapshot.name : current.name,
      instructions: snapshot.instructions,
      version: binding.version,
      contentHash: snapshot.contentHash,
      ...(Array.isArray(snapshot.capabilities) ? { capabilities: [...snapshot.capabilities] } : {}),
      ...(snapshot.manifest ? { manifest: snapshot.manifest } : {}),
    }
  })
}

/** Composer 公开请求上限与解析上限共用同一常量；两处不一致就会出现「API 接受、解析器丢弃」。 */
export const BOTANIC_AGENT_MOUNTED_SKILL_LIMIT = 16
/** 依赖 closure 防御边界：越界直接具名失败，不进入 Provider。 */
const MOUNTED_SKILL_DEPENDENCY_MAX_DEPTH = 8
const MOUNTED_SKILL_DEPENDENCY_MAX_NODES = 64
/** Skill 聚合子预算上限（token）；至少 75% 输入预算留给 system/工具/历史。 */
const MOUNTED_SKILL_TOKEN_BUDGET_CEILING = 4000

function mountedSkillTokenBudget(contextPolicy) {
  const maxInputTokens = Number(contextPolicy?.maxInputTokens)
  if (!Number.isSafeInteger(maxInputTokens) || maxInputTokens <= 0) return MOUNTED_SKILL_TOKEN_BUDGET_CEILING
  return Math.min(MOUNTED_SKILL_TOKEN_BUDGET_CEILING, Math.floor(maxInputTokens * 0.25))
}

/**
 * Composer 挂载的 Skill：解析成带正文的列表，**fail-closed**。
 *
 * 任何静默降级都会让用户以为自己挂的规则在生效：未知 id 不再丢弃、第 9–16 个
 * 不再裁掉、依赖缺失/环/冲突不再带 warning 继续。任一问题都在 Provider 调用前
 * 以具名 `AGENT_SKILL_*` 错误收口。
 *
 * 返回数组 = 依赖 closure（dependency-first 拓扑序，diamond 只注入一次，
 * `role: 'dependency'`）+ 挂载 roots（保留用户挂载顺序）。全部条目正文完整注入，
 * 聚合预算超限时具名失败而不是裁剪正文。
 */
export function resolveBotanicAgentMountedSkills(mountedSkillIds = [], projectSkills = [], { contextPolicy, builtIn } = {}) {
  const requested = [...new Set(Array.isArray(mountedSkillIds) ? mountedSkillIds : [])]
  if (!requested.length) return []
  const reject = (statusCode, code, message) => {
    emitSkillOutcome('rejected', code)
    throw new BotanicAgentSkillError(statusCode, code, message)
  }
  if (requested.length > BOTANIC_AGENT_MOUNTED_SKILL_LIMIT) {
    reject(400, 'AGENT_SKILL_BINDING_LIMIT', `一次最多挂载 ${BOTANIC_AGENT_MOUNTED_SKILL_LIMIT} 个 Skill。`)
  }
  const available = resolveBotanicAgentAvailableSkills(projectSkills, { builtIn })
  const unknown = requested.filter((skillId) => !available[skillId])
  if (unknown.length) {
    reject(409, 'AGENT_SKILL_BINDING_UNKNOWN', `挂载的 Skill 不可用：${unknown.join('、')}。`)
  }
  // `resolveAgentSkillDependencyClosure` 按 id 查目录，因此这里摊成带 id 的数组。
  // 内置 Skill 没有 lifecycle，按已发布处理 —— 它们随代码发布，不存在「未批准」。
  const catalog = Object.entries(available).map(([id, skill]) => ({
    id,
    lifecycle: skill.source === 'project' ? undefined : 'published',
    status: 'active',
    version: skill.version,
    contentHash: skill.contentHash,
    manifest: skill.manifest,
    versions: skill.versions ?? [],
    name: skill.label,
    instructions: skill.instructions,
    capabilities: skill.capabilities,
    source: skill.source ?? 'system',
  }))
  const roots = requested.map((skillId) => {
    const skill = available[skillId]
    return {
      id: skillId, name: skill.label, instructions: skill.instructions, source: skill.source ?? 'system',
      ...(skill.version ? { version: skill.version } : {}),
      ...(skill.contentHash ? { contentHash: skill.contentHash } : {}),
      ...(skill.capabilities ? { capabilities: skill.capabilities } : {}),
      ...(skill.manifest ? { manifest: skill.manifest } : {}),
    }
  })
  const resolution = resolveAgentSkillDependencyClosure(roots, catalog, {
    maxDepth: MOUNTED_SKILL_DEPENDENCY_MAX_DEPTH,
    maxNodes: MOUNTED_SKILL_DEPENDENCY_MAX_NODES,
  })
  if (resolution.limitExceeded) {
    reject(409, 'AGENT_SKILL_DEPENDENCY_LIMIT', '挂载 Skill 的依赖图超出防御边界，已停止解析。')
  }
  if (resolution.conflicts.length) {
    reject(409, 'AGENT_SKILL_DEPENDENCY_CONFLICT', `同一依赖被要求为不同版本：${resolution.conflicts.join('、')}。`)
  }
  const broken = [...resolution.missing, ...resolution.unusable, ...resolution.cyclic]
  if (broken.length) {
    reject(409, 'AGENT_SKILL_BINDING_DEPENDENCY', `挂载 Skill 的依赖不可用：${broken.join('、')}。`)
  }
  const rootIds = new Set(requested)
  const dependencies = resolution.closure
    .filter((entry) => !rootIds.has(entry.id))
    .map((entry) => ({ ...entry, role: 'dependency' }))
  const mounted = [...dependencies, ...roots]
  const totalTokens = mounted.reduce(
    (sum, skill) => sum + estimateAgentContextTokens(`${skill.name ?? skill.id}\n${skill.instructions ?? ''}`),
    0,
  )
  const budget = mountedSkillTokenBudget(contextPolicy)
  if (totalTokens > budget) {
    const names = mounted.map((skill) => skill.name ?? skill.id).join('、')
    reject(
      409,
      'AGENT_SKILL_CONTEXT_TOO_LARGE',
      `挂载 Skill（${names}）合计约 ${totalTokens} token，超出本轮 Skill 预算 ${budget} token；请减少挂载数量，正文不会被截断。`,
    )
  }
  emitSkillOutcome('loaded')
  return mounted
}

/** skill_search 用的扁平目录：系统 Skill 始终在，项目 Skill 跟在后面。 */
export function botanicAgentSearchableSkills(projectSkills = [], { builtIn } = {}) {
  const available = resolveBotanicAgentAvailableSkills(projectSkills, { builtIn })
  return Object.entries(available).map(([id, skill]) => ({
    id,
    name: skill.label,
    instructions: typeof skill.instructions === 'string' ? skill.instructions.trim().slice(0, 4000) : '',
    status: 'active',
    ...(Number.isInteger(skill.version) ? { version: skill.version } : {}),
    ...(typeof skill.contentHash === 'string' ? { contentHash: skill.contentHash } : {}),
    ...(Array.isArray(skill.capabilities) ? { capabilities: [...skill.capabilities] } : {}),
    ...(skill.manifest ? { manifest: structuredClone(skill.manifest) } : {}),
  }))
}

/**
 * 挂载 Skill 简报：用户在 Composer @ 选中后，正文直接进入本轮规则。
 * 回合链路没有 skill_run，不注入就等于白挂。
 */
export function botanicAgentMountedSkillBriefing(mountedSkills = [], locale = 'zh-CN') {
  if (!Array.isArray(mountedSkills) || !mountedSkills.length) return ''
  const english = locale === 'en'
  const header = english
    ? 'The user mounted these Skills in the composer. Follow them for this turn. Do not skill_search just to confirm they exist, and do not skill_run them again if that tool is available.'
    : '用户已在输入框挂载以下 Skill。本轮必须遵守；不要再检索确认它们是否存在，工具列表里有 skill_run 时也不必再调一次。'
  const blocks = mountedSkills.map((skill) => {
    const name = typeof skill.name === 'string' ? skill.name.trim() : skill.id
    // 正文完整注入。解析器已按聚合预算 fail-closed（AGENT_SKILL_CONTEXT_TOO_LARGE），
    // 这里再截断就会回到「用户以为整套规则在生效」的静默丢失。
    const body = typeof skill.instructions === 'string' ? skill.instructions.trim() : ''
    const dependencyNote = skill.role === 'dependency'
      ? (english ? ' — dependency of a mounted Skill' : ' — 挂载 Skill 的依赖')
      : ''
    return `### ${name} (${skill.id})${dependencyNote}\n${body}`
  })
  return [header, ...blocks].join('\n\n')
}

