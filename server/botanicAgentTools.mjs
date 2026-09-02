import { createHash } from 'node:crypto'
import { projectAgentStructuredObject } from './agentStructuredContract.mjs'
import { AgentToolRuntimeError, createAgentToolRegistry } from './agentToolRuntime.mjs'
import { createBotanicAgentOperationalActionDefinitions } from './botanicAgentOperationalTools.mjs'
import { botanicCreativeBriefFieldIds } from './botanicCreativeBrief.mjs'
import { botanicAgentVariationClarificationFieldIds } from './botanicAgentVariations.mjs'
import { createBotanicAgentWebResearchTools } from './botanicAgentWebTools.mjs'
import {
  agentSkillExecutionContentHash,
  agentSkillManifestRisk,
  agentSkillVersion,
  BotanicAgentSkillError,
  botanicAgentSkillCapabilities,
  normalizeAgentSkillManifest,
  normalizeBotanicAgentSkillCapabilities,
  resolveAgentSkillDependencyClosure,
  skillRiskOrder,
} from './botanicAgentSkill.mjs'
import { estimateAgentContextTokens } from './agentContextBudget.mjs'
import { AGENT_SEMANTIC_EVENT_NAMES, writeAgentSemanticEvent } from './agentSemanticEvent.mjs'

/** Skill 语义事件（H7）:只带低基数 reason(错误码词法),不带 Skill ID 或用户文本。 */
function emitSkillOutcome(outcome, reason) {
  writeAgentSemanticEvent(AGENT_SEMANTIC_EVENT_NAMES.HARNESS_LIFECYCLE, {
    kind: 'skill',
    outcome,
    ...(reason ? { reason } : {}),
  })
}
import { createAgentSubtask } from './agentSubtask.mjs'
import { runAgentSubtaskFanout, subtaskFanoutSummary } from './agentSubtaskScheduler.mjs'
import { readFileSync } from 'node:fs'

function readBuiltInSkill(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8').trim()
}

const skillCatalog = Object.freeze({
  controlled_edit: {
    label: '受控局部编辑',
    instructions: readBuiltInSkill('./skills/controlled-edit/SKILL.md'),
  },
  batch_variation: {
    label: '批量变量生成',
    instructions: readBuiltInSkill('./skills/batch-variation/SKILL.md'),
  },
  root_recipe_redo: {
    label: '按原参数重做',
    instructions: readBuiltInSkill('./skills/root-recipe-redo/SKILL.md'),
  },
  ecommerce_listing: {
    label: '电商套图',
    instructions: readBuiltInSkill('./skills/ecommerce-listing/SKILL.md'),
  },
  platform_pack: {
    label: '平台交付包',
    instructions: readBuiltInSkill('./skills/platform-pack/SKILL.md'),
  },
  video_storyboard: {
    label: '静帧转视频分镜',
    instructions: readBuiltInSkill('./skills/video-storyboard/SKILL.md'),
  },
  conversation_distill: {
    label: '对话沉淀 Skill',
    instructions: readBuiltInSkill('./skills/conversation-distill/SKILL.md'),
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

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentToolRuntimeError('INVALID_TOOL_ARGUMENTS', `${name}参数无效。`)
  }
  return value
}

function optionalText(value, name, maximumLength = 160) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximumLength) {
    throw new AgentToolRuntimeError('INVALID_TOOL_ARGUMENTS', `${name}参数无效。`)
  }
  return value.trim()
}

function requiredText(value, name, maximumLength = 160) {
  const result = optionalText(value, name, maximumLength)
  if (!result) throw new AgentToolRuntimeError('INVALID_TOOL_ARGUMENTS', `${name}参数无效。`)
  return result
}

function safeClone(value) {
  return structuredClone(value)
}

function boundedArguments(value, name) {
  const result = object(value, name)
  let serialized
  try {
    serialized = JSON.stringify(result)
  } catch {
    throw new AgentToolRuntimeError('INVALID_TOOL_ARGUMENTS', `${name}参数无效。`)
  }
  if (serialized.length > 8 * 1024) {
    throw new AgentToolRuntimeError('INVALID_TOOL_ARGUMENTS', `${name}参数过大。`)
  }
  return safeClone(result)
}

function safeResultText(value, maximumLength = 4000) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, maximumLength)
}

function safeArtifactUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('/api/media/') || value.length > 2048) return undefined
  try {
    const parsed = new URL(value, 'http://botanic.internal')
    return parsed.origin === 'http://botanic.internal' && parsed.pathname.startsWith('/api/media/')
      ? value
      : undefined
  } catch {
    return undefined
  }
}

function artifactKindForMimeType(value) {
  if (typeof value !== 'string') return 'file'
  if (value.startsWith('image/')) return 'image'
  if (value.startsWith('video/')) return 'video'
  return 'file'
}

/** MCP image.data 内联上限；更大的应走 resource_link / media。 */
const MCP_INLINE_IMAGE_BASE64_MAX = 280_000

function mcpInlineImageDataUrl(item) {
  if (item?.type !== 'image' || typeof item.data !== 'string') return undefined
  const mimeType = typeof item.mimeType === 'string' && item.mimeType.startsWith('image/')
    ? item.mimeType.slice(0, 120)
    : 'image/png'
  const data = item.data.replace(/\s+/g, '')
  if (!data || data.length > MCP_INLINE_IMAGE_BASE64_MAX || !/^[A-Za-z0-9+/]+=*$/.test(data)) return undefined
  return { url: `data:${mimeType};base64,${data}`, mimeType }
}

function mcpStructuredContentText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return safeResultText(value)
  try {
    return safeResultText(JSON.stringify(value, null, 2), 8_000)
  } catch {
    return ''
  }
}

async function mcpArtifacts(result, { actionId, externalTool, persistMcpMedia }) {
  if (result?.isError) {
    throw new AgentToolRuntimeError('MCP_TOOL_FAILED', 'MCP 工具执行失败。', 502)
  }
  const artifacts = []
  const content = Array.isArray(result?.content) ? result.content : []
  const textContent = safeResultText(content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join('\n'))
  if (textContent) artifacts.push({
    kind: 'text', label: `MCP · ${externalTool}`, content: textContent, placement: 'panel',
  })
  const structured = mcpStructuredContentText(result?.structuredContent)
  if (structured && structured !== textContent) {
    artifacts.push({
      kind: 'text',
      label: `MCP · ${externalTool} · structured`,
      content: structured,
      placement: 'panel',
      metadata: { mcpStructured: true },
    })
  }
  for (const item of content) {
    if (item?.type === 'image') {
      const inline = mcpInlineImageDataUrl(item)
      if (!inline) continue
      // 内联 data: URL 进不了 Artifact Index（同源守卫拒收），历史会丢图。
      // 有媒体服务时先落成 /api/media/ 同源地址；落库失败（格式不支持等）回退内联，仅当轮面板可见。
      let url = inline.url
      if (typeof persistMcpMedia === 'function') {
        try {
          url = await persistMcpMedia(inline.url)
        } catch {
          url = inline.url
        }
      }
      artifacts.push({
        kind: 'image',
        placement: 'panel',
        label: safeResultText(item.name || item.title, 120) || 'MCP 图像',
        url,
        mimeType: inline.mimeType,
      })
      continue
    }
    if (item?.type !== 'resource_link') continue
    const url = safeArtifactUrl(item.uri)
    if (!url) continue
    const kind = artifactKindForMimeType(item.mimeType)
    artifacts.push({
      kind,
      placement: kind === 'image' || kind === 'video' ? 'canvas' : 'panel',
      label: safeResultText(item.title || item.name, 120) || 'MCP 文件',
      url,
      ...(typeof item.mimeType === 'string' ? { mimeType: item.mimeType.slice(0, 120) } : {}),
    })
  }
  return artifacts.slice(0, 20).map((artifact, index) => ({
    id: `artifact-${actionId}-${index + 1}`,
    ...artifact,
    provenance: { actionId, toolName: 'mcp_call', externalTool },
  }))
}

function legacyMcpRuntime(tools) {
  const descriptors = Object.entries(tools ?? {})
    .filter(([, invoke]) => typeof invoke === 'function')
    .map(([key]) => {
      const [server, tool, ...rest] = key.split('.')
      if (!server || !tool || rest.length) return undefined
      const capabilityHash = createHash('sha256').update(`legacy-mcp:${key}`).digest('base64url')
      return Object.freeze({
        key,
        server,
        tool,
        version: 'legacy-1',
        capabilityHash,
        inputSchema: Object.freeze({
          type: 'object',
          properties: Object.freeze({}),
          required: Object.freeze([]),
          additionalProperties: true,
          minProperties: 0,
          maxProperties: 64,
        }),
        outputSchema: Object.freeze({
          type: 'object',
          properties: Object.freeze({}),
          required: Object.freeze([]),
          additionalProperties: true,
          minProperties: 0,
          maxProperties: 64,
        }),
        replayPolicy: 'never',
      })
    })
    .filter(Boolean)
  const byKey = new Map(descriptors.map((descriptor) => [descriptor.key, descriptor]))
  return Object.freeze({
    catalog: () => descriptors.slice(),
    invoke: async (key, argumentsValue, context = {}) => {
      const descriptor = byKey.get(key)
      const invoke = tools?.[key]
      if (!descriptor || typeof invoke !== 'function') {
        throw new AgentToolRuntimeError('MCP_TOOL_NOT_ALLOWED', `MCP 工具不在允许列表：${key}。`, 403)
      }
      if (context.expectedVersion !== descriptor.version
        || context.expectedCapabilityHash !== descriptor.capabilityHash) {
        throw new AgentToolRuntimeError('MCP_CAPABILITY_STALE', `MCP 工具能力已变化：${key}。`, 409)
      }
      return invoke(argumentsValue, context)
    },
  })
}

function resolvedMcpRuntime(runtime, legacyTools) {
  if (runtime && typeof runtime.catalog === 'function' && typeof runtime.invoke === 'function') return runtime
  if (legacyTools && typeof legacyTools.catalog === 'function' && typeof legacyTools.invoke === 'function') return legacyTools
  return legacyMcpRuntime(legacyTools)
}

function artifactPlacement(artifact) {
  if (artifact.placement === 'canvas' || artifact.placement === 'panel') return artifact.placement
  return artifact.kind === 'image' || artifact.kind === 'video' ? 'canvas' : 'panel'
}

/**
 * 只为落点是 canvas 的 Artifact 生成节点命令。Skill 规则与 MCP 文本默认留在结果面板，
 * 不再无条件在画布上产生一个既不能当参考、又会抢走选中态的文字节点。
 */
function artifactCanvasCommands(artifacts, actionId) {
  return artifacts.flatMap((artifact, index) => {
    if (artifactPlacement(artifact) !== 'canvas') return []
    const type = artifact.kind === 'text' || artifact.kind === 'workflow'
      ? 'create_text_node'
      : artifact.kind === 'image' || artifact.kind === 'video'
        ? 'create_media_node'
        : undefined
    return type ? [{ id: `command-${actionId}-${index + 1}`, type, artifactId: artifact.id }] : []
  })
}

function planParameters() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      intent: { type: 'string' },
      prompt: { type: 'string', maxLength: 6000 },
      summary: { type: 'string', maxLength: 240 },
      title: { type: 'string', maxLength: 40 },
      assetGroupId: { type: 'string', maxLength: 160 },
      constraints: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'object' } },
    },
    required: ['intent', 'prompt', 'summary', 'constraints'],
  }
}

function clarificationParameters() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      question: { type: 'string', maxLength: 240 },
      helper: { type: 'string', maxLength: 240 },
      fields: {
        type: 'array', minItems: 1, maxItems: 3,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string', enum: [...botanicCreativeBriefFieldIds, ...botanicAgentVariationClarificationFieldIds] },
            label: { type: 'string', maxLength: 80 },
          },
          required: ['id', 'label'],
        },
      },
    },
    required: ['question', 'fields'],
  }
}

function skillManifestParameters() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: ['guidance', 'evaluator'] },
      toolAllowlist: {
        type: 'array', maxItems: 12,
        items: { type: 'string', pattern: '^[a-z][a-z0-9_]{1,63}$' },
      },
      dependencies: {
        type: 'array', maxItems: 8,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            skillId: { type: 'string', maxLength: 160 },
            version: { type: 'integer', minimum: 1 },
            contentHash: { type: 'string', maxLength: 200 },
          },
          required: ['skillId'],
        },
      },
      outputSchema: { type: 'object' },
    },
  }
}

function skillCreationParameters({ includeReason = false } = {}) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', maxLength: 80 },
      instructions: { type: 'string', maxLength: 4000 },
      capabilities: {
        type: 'array', minItems: 1, maxItems: botanicAgentSkillCapabilities.length,
        items: { type: 'string', enum: [...botanicAgentSkillCapabilities] },
      },
      manifest: skillManifestParameters(),
      ...(includeReason ? { reason: { type: 'string', maxLength: 240 } } : {}),
    },
    required: ['name', 'instructions', ...(includeReason ? ['reason'] : [])],
  }
}

function validateSkillCreationArguments(raw, label) {
  const value = object(raw, label)
  const manifest = normalizeAgentSkillManifest(value.manifest)
  return {
    name: requiredText(value.name, 'Skill 名称', 80),
    instructions: requiredText(value.instructions, 'Skill 规则', 4000),
    capabilities: normalizeBotanicAgentSkillCapabilities(value.capabilities),
    ...(manifest ? { manifest } : {}),
  }
}

// Skill 发布时的能力核对统一走这张风险目录；实际 Action Registry 优先，目录只补齐
// 规划/回合里的只读与外呼工具，避免路由为每种 Skill 再维护一份判断。
const skillToolRiskCatalog = Object.freeze({
  canvas_read: 'read',
  asset_search: 'read',
  ontology_read: 'read',
  project_memory_search: 'read',
  asset_group_search: 'read',
  skill_search: 'read',
  skill_run: 'read',
  skill_create_propose: 'read',
  mcp_propose: 'read',
  canvas_edit_propose: 'read',
  subagent_research: 'costly',
  generation_ask_clarification: 'read',
  generation_create_plan: 'read',
  ask_clarification: 'read',
  decompose_creative_brief: 'read',
  agent_run_read: 'read',
  generation_job_read: 'read',
  artifact_search: 'read',
  review_read: 'read',
  workflow_run_read: 'read',
  delivery_read: 'read',
  web_search: 'external',
  web_fetch: 'external',
  generate_images: 'costly',
  generate_videos: 'costly',
})

export function botanicAgentSkillToolRisk(name, registry) {
  return registry?.get?.(name)?.risk ?? skillToolRiskCatalog[name]
}

/**
 * 子任务的输出 Schema（Epic 11）。
 *
 * 刻意保守：只要摘要、要点与置信度。子 Agent 的产出是给主 Agent 参考的，字段越多
 * 越容易出现「看起来很详实、其实是编的」——而主 Agent 无从分辨。
 */
/**
 * 允许从规划链路并行派发的角色。
 *
 * 是 `SUBAGENT_ROLES` 的**子集**：审阅类角色（prompt/visual/compliance）需要具体的
 * 待审对象，规划阶段还没有，派出去只会得到一份凭空发挥的结论。
 */
const SUBAGENT_PARALLEL_ROLES = Object.freeze([
  'brand_research', 'audience_research', 'competitor_research', 'creative_direction',
])

const SUBAGENT_RESEARCH_SCHEMA = Object.freeze({
  type: 'object',
  required: ['summary'],
  properties: {
    summary: { type: 'string', maxLength: 600 },
    findings: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 200 } },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
})

export function createBotanicAgentPlanningToolRegistry({ input, finalizePlan, finalizeClarification, onProposeAction, webResearch, subagentRunner }) {
  if (!input || typeof finalizePlan !== 'function' || typeof finalizeClarification !== 'function') throw new TypeError('Agent 规划工具缺少可信上下文。')
  const availableSkills = resolveBotanicAgentAvailableSkills(input.projectSkills)
  const mountedSkillLabels = resolveBotanicAgentMountedSkills(input.mountedSkillIds, input.projectSkills)
    .map((skill) => skill.name)
  const availableMcpTools = (input.availableMcpTools ?? [])
    .filter((item) => item
      && typeof item.server === 'string'
      && typeof item.tool === 'string'
      && typeof item.version === 'string'
      && typeof item.capabilityHash === 'string'
      && item.inputSchema?.type === 'object')
    .slice(0, 30)
  const mcpToolCatalog = new Map(availableMcpTools.map((item) => [`${item.server}.${item.tool}`, item]))
  const mcpToolKeys = new Set(mcpToolCatalog.keys())
  const propose = typeof onProposeAction === 'function' ? onProposeAction : () => {}
  const planningRegistryRef = { current: undefined }
  const tools = [
    {
      name: 'canvas_read',
      label: '读取画布上下文',
      description: '读取当前结果、生成参数和已连接参考的安全元数据，不返回图片、媒体地址或文件字节。',
      risk: 'read',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      validate: (raw) => object(raw, '画布读取'),
      execute: async () => safeClone({
        projectId: input.projectId,
        selectedResult: input.selectedResult,
        settings: input.settings,
        references: input.references,
      }),
    },
    {
      name: 'asset_search',
      label: '搜索素材',
      description: '按角色或关键词搜索本次规划可使用的素材组元数据。',
      risk: 'read',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { role: { type: 'string' }, query: { type: 'string' } },
      },
      validate: (raw) => {
        const value = object(raw, '素材搜索')
        return { role: optionalText(value.role, '素材角色', 80), query: optionalText(value.query, '搜索词', 120) }
      },
      execute: async ({ role, query }) => {
        const groups = input.assetGroups?.length ? input.assetGroups : input.assetGroup ? [input.assetGroup] : []
        const normalizedQuery = query?.toLocaleLowerCase('zh-CN')
        const matches = groups.filter((group) => (!role || group.role === role)
          && (!normalizedQuery || `${group.name} ${group.role}`.toLocaleLowerCase('zh-CN').includes(normalizedQuery)))
        return { groups: safeClone(matches), total: matches.length }
      },
    },
    ...createBotanicAgentWebResearchTools(webResearch),
    {
      name: 'skill_run',
      label: '调用创作 Skill',
      description: `调用 Botanic 已审核的创作规则，并立即并入本轮约束。可用 Skill：${Object.keys(availableSkills).join('、')}。${mountedSkillLabels.length ? `当前已挂载，相关任务优先使用：${mountedSkillLabels.join('、')}。` : ''}`,
      risk: 'read',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { skillId: { type: 'string', enum: Object.keys(availableSkills) } },
        required: ['skillId'],
      },
      validate: (raw) => {
        const skillId = requiredText(object(raw, 'Skill 调用').skillId, 'Skill', 80)
        if (!availableSkills[skillId]) throw new AgentToolRuntimeError('SKILL_NOT_ALLOWED', `Skill 不在允许列表：${skillId}。`, 403)
        return { skillId }
      },
      execute: async ({ skillId }, context) => {
        const skill = availableSkills[skillId]
        // 风险按**当前注册表**里工具的真实声明算，不只按 Skill 自称的能力。
        // 查不到的工具名在 agentSkillManifestRisk 里按最高风险处理。
        const risk = botanicAgentSkillRisk(skill, (name) => planningRegistryRef.current?.get?.(name)?.risk)
        if (risk !== 'read') {
          propose({
            id: context?.toolCallId ?? `skill-${skillId}`,
            kind: 'skill',
            toolName: 'skill_apply',
            label: `Skill · ${skill.label}`,
            summary: `Skill「${skill.label}」声明了${risk}能力，需要确认后应用。`,
            risk,
            arguments: { skillId },
            status: 'awaiting_confirmation',
            requiresConfirmation: true,
          })
          return {
            skillId,
            name: skill.label,
            source: skill.source ?? 'system',
            capabilities: skill.capabilities ?? ['read'],
            requiresConfirmation: true,
            risk,
          }
        }
        propose({
          id: context?.toolCallId ?? `skill-${skillId}`,
          kind: 'skill',
          toolName: 'skill_apply',
          label: `Skill · ${skill.label}`,
          summary: `已按「${skill.label}」约束本次创作。`,
          risk: 'write',
          arguments: { skillId },
          status: 'succeeded',
        })
        return { skillId, ...skill, capabilities: skill.capabilities ?? ['read'] }
      },
    },
    {
      name: 'skill_create_propose',
      label: '提议创建项目 Skill',
      description: '当一组创作约束具有明确复用价值时，提议创建项目 Skill；只生成待确认行动，不直接写入项目。',
      risk: 'read',
      parameters: skillCreationParameters({ includeReason: true }),
      validate: (raw) => {
        const value = object(raw, 'Skill 创建提议')
        return {
          ...validateSkillCreationArguments(value, 'Skill 创建提议'),
          reason: requiredText(value.reason, '创建原因', 240),
        }
      },
      execute: async ({ reason, ...skillInput }, context) => {
        const proposal = {
          id: context?.toolCallId ?? `skill-create-${skillInput.name}`,
          kind: 'skill', toolName: 'skill_create', label: `创建 Skill：${skillInput.name}`,
          summary: reason, risk: 'write', arguments: skillInput,
          status: 'awaiting_confirmation',
        }
        propose(proposal)
        return { proposed: true, actionId: proposal.id }
      },
    },
    ...(availableMcpTools.length ? [{
      name: 'mcp_propose',
      label: '提议 MCP 调用',
      description: `提议一个需要用户确认的外部 MCP 工具调用，不在规划阶段执行。允许的工具：${[...mcpToolKeys].join('、')}。`,
      risk: 'read',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          server: { type: 'string' }, tool: { type: 'string' },
          arguments: { type: 'object' }, reason: { type: 'string', maxLength: 240 },
        },
        required: ['server', 'tool', 'arguments', 'reason'],
      },
      validate: (raw) => {
        const value = object(raw, 'MCP 提议')
        const server = requiredText(value.server, 'MCP 服务', 80)
        const tool = requiredText(value.tool, 'MCP 工具', 80)
        const argumentsValue = boundedArguments(value.arguments, 'MCP 工具')
        const reason = requiredText(value.reason, 'MCP 调用原因', 240)
        const descriptor = mcpToolCatalog.get(`${server}.${tool}`)
        if (!descriptor) {
          throw new AgentToolRuntimeError('MCP_TOOL_NOT_ALLOWED', `MCP 工具不在允许列表：${server}.${tool}。`, 403)
        }
        return {
          server,
          tool,
          arguments: projectAgentStructuredObject(descriptor.inputSchema, argumentsValue, { label: `${server}.${tool} 输入` }),
          reason,
          descriptor,
        }
      },
      execute: async ({ server, tool, arguments: argumentsValue, reason, descriptor }, context) => {
        const proposal = {
          id: context?.toolCallId ?? `mcp-${server}-${tool}`,
          kind: 'mcp', toolName: 'mcp_call', label: `调用 MCP：${server}.${tool}`,
          summary: reason, risk: 'external',
          // version + capabilityHash 由服务端目录注入，模型无权自报。Proposal、批准
          // Token、Action Receipt 的既有参数摘要会自动把这份能力身份一并冻结。
          arguments: {
            server,
            tool,
            arguments: argumentsValue,
            version: descriptor.version,
            capabilityHash: descriptor.capabilityHash,
          },
          status: 'awaiting_confirmation',
        }
        propose(proposal)
        return { proposed: true, actionId: proposal.id, tool: `${server}.${tool}` }
      },
    }] : []),
    {
      name: 'canvas_edit_propose',
      label: '提议画布修改',
      description: '提议一次需要用户确认的画布修改（update_text 改文字/重命名；update_generate_settings 调生成参数；delete_nodes 删节点），不在规划阶段执行。结果图片、任务绑定与系统连线永不可改。',
      risk: 'read',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          operation: { type: 'string', enum: ['update_text', 'update_generate_settings', 'delete_nodes'] },
          arguments: { type: 'object' },
          reason: { type: 'string', maxLength: 240 },
        },
        required: ['operation', 'arguments', 'reason'],
      },
      validate: (raw) => {
        const value = object(raw, '画布修改提议')
        const toolName = {
          update_text: 'canvas_update_text',
          update_generate_settings: 'canvas_update_generate_settings',
          delete_nodes: 'canvas_delete_nodes',
        }[value.operation]
        if (!toolName) throw new AgentToolRuntimeError('CANVAS_EDIT_NOT_ALLOWED', `不支持的画布修改类型：${value.operation}。`, 422)
        return {
          toolName,
          arguments: boundedArguments(value.arguments, '画布修改'),
          reason: requiredText(value.reason, '修改原因', 240),
        }
      },
      execute: async ({ toolName, arguments: argumentsValue, reason }, context) => {
        const labels = {
          canvas_update_text: '修改画布文字',
          canvas_update_generate_settings: '调整生成参数',
          canvas_delete_nodes: '删除画布节点',
        }
        const proposal = {
          id: context?.toolCallId ?? `canvas-${toolName}`,
          kind: 'canvas', toolName, label: labels[toolName],
          summary: reason, risk: 'write',
          arguments: argumentsValue,
          status: 'awaiting_confirmation',
        }
        propose(proposal)
        return { proposed: true, actionId: proposal.id }
      },
    },
    ...(typeof subagentRunner === 'function' ? [{
      name: 'subagent_research',
      label: '并行调研',
      description: `就 2–3 个不同角度并行做一次只读调研，会产生额外模型调用费用，返回结构化提案供你参考。可用角色：${SUBAGENT_PARALLEL_ROLES.join('、')}。子任务无权修改画布、提交生成或调用外部系统；它们的结论只是建议，最终仍由你和用户决定。`,
      risk: 'costly',
      // 子任务 ID 由根 Turn 与输入指纹派生，Durable Broker 重放会复用同一任务。
      recovery: 'reexecute',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          tasks: {
            type: 'array', maxItems: 3,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                role: { type: 'string', enum: [...SUBAGENT_PARALLEL_ROLES] },
                question: { type: 'string', maxLength: 400 },
              },
              required: ['role', 'question'],
            },
          },
        },
        required: ['tasks'],
      },
      validate: (raw) => {
        const value = object(raw, '并行调研')
        const tasks = Array.isArray(value.tasks) ? value.tasks : []
        if (!tasks.length || tasks.length > 3) {
          // 上限压得比 SUBAGENT_LIMITS 更低：这条路径不需要用户确认，因此单次能花出去
          // 的钱必须小。真要更大的扇出，应当走一次显式确认的编排，而不是从这里放宽。
          throw new AgentToolRuntimeError('INVALID_TOOL_ARGUMENTS', '并行调研一次最多 3 个角度。')
        }
        return {
          tasks: tasks.map((task, index) => {
            const item = object(task, `第 ${index + 1} 个调研角度`)
            if (!SUBAGENT_PARALLEL_ROLES.includes(item.role)) {
              throw new AgentToolRuntimeError('INVALID_TOOL_ARGUMENTS', `第 ${index + 1} 个调研角度的角色无效。`)
            }
            return { role: item.role, question: requiredText(item.question, `第 ${index + 1} 个调研问题`, 400) }
          }),
        }
      },
      execute: async ({ tasks }, context) => {
        const registry = planningRegistryRef.current
        // web_search 是外呼但只读、根 Agent 调用时也不需要确认的工具，因此子任务可以
        // 持有它；没配置联网时退回只读画布，调研仍能进行但会明说依据有限。
        const allowedTools = registry?.get?.('web_search') ? ['web_search'] : ['canvas_read']
        const subtasks = tasks.map((task) => createAgentSubtask({
          parentTurnId: context?.traceId ?? context?.toolCallId ?? `plan-${input.projectId}`,
          projectId: input.projectId,
          ownerId: context?.userId ?? input.projectId,
          role: task.role,
          input: { question: task.question, projectId: input.projectId },
          // 需要用户确认或会产生终态的工具会被 assertSubtaskToolAllowlist 拒绝，
          // 因此这份名单写错了会在创建时就失败，而不是运行到一半才发现越权。
          allowedTools,
          outputSchema: SUBAGENT_RESEARCH_SCHEMA,
          registry,
          budget: { maxSteps: 1, maxToolCalls: 2 },
          timeoutMs: 45_000,
        }))
        // Scheduler 的 legacy seam 只传 subtask/signal/callTool；Durable Broker 还必须拿到
        // 当前 root executor fence。由拥有 Tool Loop context 的这一层显式闭包注入，
        // 不能让模型参数或 Subtask payload 自报 executionGeneration / leaseToken。
        const runWithRootExecution = (runInput) => subagentRunner({ ...runInput, context })
        context?.reportProgress?.({
          summary: `已启动 ${subtasks.length} 个调研角度`,
          presentation: { kind: 'subagent', title: '并行调研', count: subtasks.length },
        })
        const outcome = await runAgentSubtaskFanout({
          subtasks, registry, context, runSubagent: runWithRootExecution, maxConcurrent: 3,
        })
        context?.reportProgress?.({
          summary: `完成 ${outcome.completed.length}/${subtasks.length} 个调研角度`,
          presentation: { kind: 'subagent', title: '并行调研', count: subtasks.length },
        })
        return {
          // 终止数与完成数并列：只报「拿到 3 份提案」会让主 Agent 在残缺输入上下结论。
          summary: subtaskFanoutSummary(outcome),
          proposals: outcome.completed.map((subtask) => ({
            role: subtask.role,
            subtaskId: subtask.id,
            ...subtask.result.output,
          })),
          stopped: outcome.terminated.map((subtask) => ({
            role: subtask.role, reason: subtask.termination?.reason, detail: subtask.termination?.detail,
          })),
        }
      },
    }] : []),
    {
      name: 'generation_ask_clarification',
      label: '确认生成参数',
      description: '当用户目标、输出规格、变体取值或创作方向确实不清晰时，提出最多三个简短问题；只返回问题卡，不执行生成。批量但未列出 2–8 个具体取值时，必须询问 variation_values。多轴相乘前必须询问 variation_combine 并写明张数。不要重复询问已知项。',
      risk: 'read',
      terminal: true,
      parameters: clarificationParameters(),
      validate: (raw) => {
        const value = object(raw, '参数确认')
        const fields = Array.isArray(value.fields) ? value.fields : []
        if (!fields.length || fields.length > 3) throw new AgentToolRuntimeError('INVALID_TOOL_ARGUMENTS', '参数确认字段无效。')
        return finalizeClarification({
          question: requiredText(value.question, '确认问题', 240),
          ...(value.helper !== undefined ? { helper: optionalText(value.helper, '确认说明', 240) } : {}),
          fields: fields.map((field, index) => {
            const item = object(field, `第 ${index + 1} 个确认字段`)
            return {
              id: requiredText(item.id, `第 ${index + 1} 个确认字段 ID`, 40),
              label: requiredText(item.label, `第 ${index + 1} 个确认字段名称`, 80),
            }
          }),
        })
      },
      execute: async (clarification) => clarification,
    },
    {
      name: 'generation_create_plan',
      label: '生成执行计划',
      description: '把用户要求转换成待确认的 Botanic 生图计划；只创建计划，不执行生成或修改画布。',
      risk: 'read',
      terminal: true,
      parameters: planParameters(),
      validate: (raw) => finalizePlan(object(raw, '生成计划')),
      execute: async (plan) => plan,
    },
  ]
  // 派发工具需要引用**它自己所在的**注册表，才能把只读检索工具授予子任务。
  // 注册表要等 tools 数组建好才能创建，因此用一个持有者在创建后回填 —— 比让调用方
  // 再传一份注册表进来更安全：传进来的那份可能与实际生效的不是同一个。
  const registry = createAgentToolRegistry(tools)
  planningRegistryRef.current = registry
  return registry
}

function actionHandler(handler, name) {
  return typeof handler === 'function'
    ? handler
    : async () => { throw new AgentToolRuntimeError('TOOL_NOT_CONFIGURED', `${name}尚未配置。`, 503) }
}

export function createBotanicAgentActionToolRegistry({
  createWorkflow,
  submitGeneration,
  applySkill,
  createSkill,
  mcpRuntime,
  mcpTools = {},
  /** 把 MCP 内联图片落成同源媒体（dataUrl → /api/media/...）；缺省时保留 data: URL 仅面板展示。 */
  persistMcpMedia,
  // 画布编辑三件套（提案-确认制）：改文字 / 调生成参数 / 删节点。
  updateCanvasText,
  updateGenerateSettings,
  deleteCanvasNodes,
  // 运维写工具（Epic 4）：按项目角色暴露，全部需要确认。缺执行器或权限不足时
  // 不进注册表 —— 模型看不到的工具不会被它拿去向用户承诺。
  role,
  ...operationalExecutors
} = {}) {
  const workflowHandler = actionHandler(createWorkflow, '工作流创建工具')
  const generationHandler = actionHandler(submitGeneration, '生成提交工具')
  const applySkillHandler = actionHandler(applySkill, 'Skill 应用工具')
  const skillHandler = actionHandler(createSkill, 'Skill 创建工具')
  const canvasTextHandler = actionHandler(updateCanvasText, '画布文字修改工具')
  const canvasSettingsHandler = actionHandler(updateGenerateSettings, '生成参数调整工具')
  const canvasDeleteHandler = actionHandler(deleteCanvasNodes, '画布节点删除工具')
  const externalMcpRuntime = resolvedMcpRuntime(mcpRuntime, mcpTools)
  const externalMcpCatalog = new Map(externalMcpRuntime.catalog().map((entry) => [entry.key, entry]))
  const operationalActions = createBotanicAgentOperationalActionDefinitions({ role, ...operationalExecutors })
  return createAgentToolRegistry([
    ...operationalActions,
    {
      name: 'workflow_create', label: '创建画布工作流',
      description: '在当前项目中创建新的文字、参考和生成节点，不覆盖已有节点。',
      risk: 'write', requiresConfirmation: true, terminal: true,
      parameters: { type: 'object', additionalProperties: false, properties: { planId: { type: 'string' } }, required: ['planId'] },
      validate: (raw) => ({ planId: requiredText(object(raw, '工作流创建').planId, '计划') }),
      execute: workflowHandler,
    },
    {
      name: 'generation_submit', label: '提交生成任务',
      description: '提交一个已确认计划对应的生成任务，会产生模型费用。',
      risk: 'costly', requiresConfirmation: true, terminal: true,
      parameters: { type: 'object', additionalProperties: false, properties: { planId: { type: 'string' } }, required: ['planId'] },
      validate: (raw) => ({ planId: requiredText(object(raw, '生成提交').planId, '计划') }),
      execute: generationHandler,
    },
    {
      name: 'skill_apply', label: '应用项目 Skill',
      description: '读取已审核的项目或内置 Skill，并把规则作为本轮创作约束返回；不会在画布上创建节点。',
      risk: 'write', requiresConfirmation: true, terminal: true,
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { skillId: { type: 'string' } },
        required: ['skillId'],
      },
      validate: (raw) => ({ skillId: requiredText(object(raw, 'Skill 应用').skillId, 'Skill', 160) }),
      execute: async ({ skillId }, context) => {
        const result = await applySkillHandler({ skillId }, context)
        const skill = object(result?.skill, 'Skill 应用结果')
        const name = requiredText(skill.name, 'Skill 名称', 80)
        const instructions = requiredText(skill.instructions, 'Skill 规则', 4000)
        const actionId = context?.toolCallId ?? `skill-apply-${skillId}`
        const artifact = {
          id: `artifact-${actionId}-1`, kind: 'workflow', label: `Skill · ${name}`, content: instructions,
          placement: 'panel',
          provenance: { actionId, toolName: 'skill_apply' },
        }
        return {
          message: `已应用 Skill「${name}」。`,
          writeback: { kind: 'text', label: `Skill · ${name}`, content: instructions },
          artifacts: [artifact],
          canvasCommands: artifactCanvasCommands([artifact], actionId),
        }
      },
    },
    {
      name: 'skill_create', label: '创建项目 Skill',
      description: '创建项目级创作规则草稿；启用前必须由用户确认。',
      risk: 'write', requiresConfirmation: true, terminal: true,
      parameters: skillCreationParameters(),
      validate: (raw) => validateSkillCreationArguments(raw, 'Skill 创建'),
      execute: async (argumentsValue, context) => {
        const result = await skillHandler(argumentsValue, context)
        const skill = object(result?.skill, 'Skill 创建结果')
        const name = requiredText(skill.name, 'Skill 名称', 80)
        const instructions = requiredText(skill.instructions, 'Skill 规则', 4000)
        const actionId = context?.toolCallId ?? `skill-create-${name}`
        return {
          ...result,
          message: `已创建项目 Skill「${name}」。`,
          artifacts: [{
            id: `artifact-${actionId}-1`, kind: 'workflow', label: `Skill · ${name}`, content: instructions,
            placement: 'panel',
            provenance: { actionId, toolName: 'skill_create' },
          }],
        }
      },
    },
    {
      name: 'canvas_update_text', label: '修改画布文字',
      description: '改写文字节点正文或重命名节点；不改结果图片、任务绑定与系统连线。',
      risk: 'write', requiresConfirmation: true, terminal: true,
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          nodeId: { type: 'string' },
          content: { type: 'string', maxLength: 4000 },
          label: { type: 'string', maxLength: 60 },
        },
        required: ['nodeId'],
      },
      validate: (raw) => {
        const value = object(raw, '画布文字修改')
        const nodeId = requiredText(value.nodeId, '画布节点', 160)
        const content = value.content === undefined ? undefined : requiredText(value.content, '文字内容', 4000)
        const label = value.label === undefined ? undefined : requiredText(value.label, '节点名称', 60)
        if (content === undefined && label === undefined) {
          throw new AgentToolRuntimeError('CANVAS_EDIT_EMPTY', '至少提供新的正文或名称。', 422)
        }
        return { nodeId, ...(content === undefined ? {} : { content }), ...(label === undefined ? {} : { label }) }
      },
      execute: canvasTextHandler,
    },
    {
      name: 'canvas_update_generate_settings', label: '调整生成参数',
      description: '调整空闲生成节点的模型、比例、清晰度或张数；排队或生成中的节点不可改。',
      risk: 'write', requiresConfirmation: true, terminal: true,
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          nodeId: { type: 'string' },
          model: { type: 'string', maxLength: 80 },
          aspectRatio: { type: 'string', maxLength: 16 },
          resolution: { type: 'string', maxLength: 16 },
          batchCount: { type: 'integer', minimum: 1, maximum: 8 },
        },
        required: ['nodeId'],
      },
      validate: (raw) => {
        const value = object(raw, '生成参数调整')
        const nodeId = requiredText(value.nodeId, '画布节点', 160)
        const settings = {
          ...(value.model === undefined ? {} : { model: requiredText(value.model, '模型', 80) }),
          ...(value.aspectRatio === undefined ? {} : { aspectRatio: requiredText(value.aspectRatio, '画面比例', 16) }),
          ...(value.resolution === undefined ? {} : { resolution: requiredText(value.resolution, '清晰度', 16) }),
        }
        const batchCount = value.batchCount === undefined ? undefined : Number(value.batchCount)
        if (batchCount !== undefined && (!Number.isInteger(batchCount) || batchCount < 1 || batchCount > 8)) {
          throw new AgentToolRuntimeError('CANVAS_EDIT_INVALID', '张数必须是 1-8 的整数。', 422)
        }
        if (!Object.keys(settings).length && batchCount === undefined) {
          throw new AgentToolRuntimeError('CANVAS_EDIT_EMPTY', '至少提供一项要调整的参数。', 422)
        }
        return { nodeId, settings, ...(batchCount === undefined ? {} : { batchCount }) }
      },
      execute: canvasSettingsHandler,
    },
    {
      name: 'canvas_delete_nodes', label: '删除画布节点',
      description: '删除指定画布节点及其连线；活跃任务的节点不可删，历史结果保留在 Artifact 面板。',
      risk: 'write', requiresConfirmation: true, terminal: true,
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          nodeIds: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string' } },
        },
        required: ['nodeIds'],
      },
      validate: (raw) => {
        const value = object(raw, '画布节点删除')
        if (!Array.isArray(value.nodeIds) || !value.nodeIds.length || value.nodeIds.length > 12) {
          throw new AgentToolRuntimeError('CANVAS_EDIT_INVALID', '一次最多删除 12 个节点。', 422)
        }
        return { nodeIds: value.nodeIds.map((nodeId, index) => requiredText(nodeId, `画布节点 ${index + 1}`, 160)) }
      },
      execute: canvasDeleteHandler,
    },
    {
      name: 'mcp_call', label: '调用外部工具',
      description: '调用服务端明确允许的 MCP 工具；服务器和工具名必须同时命中白名单。',
      risk: 'external', requiresConfirmation: true, terminal: true,
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          server: { type: 'string' },
          tool: { type: 'string' },
          arguments: { type: 'object' },
          version: { type: 'string', maxLength: 64 },
          capabilityHash: { type: 'string', maxLength: 128 },
        },
        required: ['server', 'tool', 'arguments', 'version', 'capabilityHash'],
      },
      validate: (raw) => {
        const value = object(raw, 'MCP 调用')
        const server = requiredText(value.server, 'MCP 服务', 80)
        const tool = requiredText(value.tool, 'MCP 工具', 80)
        const key = `${server}.${tool}`
        const descriptor = externalMcpCatalog.get(key)
        if (!descriptor) throw new AgentToolRuntimeError('MCP_TOOL_NOT_ALLOWED', `MCP 工具不在允许列表：${key}。`, 403)
        const version = requiredText(value.version, 'MCP 能力版本', 64)
        const capabilityHash = requiredText(value.capabilityHash, 'MCP 能力摘要', 128)
        if (version !== descriptor.version || capabilityHash !== descriptor.capabilityHash) {
          throw new AgentToolRuntimeError('MCP_CAPABILITY_STALE', `MCP 工具能力已变化：${key}。`, 409)
        }
        const argumentsValue = projectAgentStructuredObject(
          descriptor.inputSchema,
          boundedArguments(value.arguments, 'MCP 工具'),
          { label: `${key} 输入` },
        )
        return { key, arguments: argumentsValue, version, capabilityHash }
      },
      execute: async ({ key, arguments: argumentsValue, version, capabilityHash }, context) => {
        const result = await externalMcpRuntime.invoke(key, argumentsValue, {
          ...context,
          expectedVersion: version,
          expectedCapabilityHash: capabilityHash,
        })
        const actionId = context?.toolCallId ?? `mcp-${key}`
        const artifacts = await mcpArtifacts(result, { actionId, externalTool: key, persistMcpMedia })
        const textArtifact = artifacts.find((artifact) => artifact.kind === 'text')
        return {
          message: `MCP 工具 ${key} 已执行。`,
          ...(textArtifact?.content ? { writeback: { kind: 'text', label: textArtifact.label, content: textArtifact.content } } : {}),
          ...(artifacts.length ? { artifacts, canvasCommands: artifactCanvasCommands(artifacts, actionId) } : {}),
        }
      },
    },
  ])
}
