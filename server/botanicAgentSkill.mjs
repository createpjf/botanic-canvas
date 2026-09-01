import { randomUUID } from 'node:crypto'
import { canonicalHash } from './canonicalHash.mjs'

/**
 * 能力词表，**顺序即风险高低**。风险语义归 Skill 模块所有，`botanicAgentTools`
 * 从这里取 —— 两处各写一份顺序的话，某天新增一档就会出现「工具侧算高风险、
 * Skill 侧算低风险」，而低的那一侧决定要不要弹确认。
 */
export const botanicAgentSkillCapabilities = Object.freeze(['read', 'write', 'costly', 'external'])
export const skillRiskOrder = botanicAgentSkillCapabilities
const skillCapabilitySet = new Set(botanicAgentSkillCapabilities)

/**
 * Skill 生命周期。治理状态必须由流程产生，不得在创建时硬编码为已批准（ADR 0006）。
 *
 * `published` 只能来自一次可追溯的批准动作，并记下批准人与时间 —— 状态本身要能被
 * 核对，而不只是被声明。`status` 字段保留为派生的兼容视图（active/archived），
 * 既有读取路径按它过滤。
 */
export const botanicAgentSkillLifecycle = Object.freeze(['draft', 'review', 'published', 'deprecated'])
const lifecycleSet = new Set(botanicAgentSkillLifecycle)

/** 兼容视图：老读取路径只认 active/archived。 */
function statusForLifecycle(lifecycle) {
  return lifecycle === 'published' ? 'active' : 'archived'
}

/** 已发布且未弃用的 Skill 才能被挂载或执行。 */
export function isUsableAgentSkill(skill) {
  if (!skill) return false
  if (typeof skill.lifecycle === 'string') return skill.lifecycle === 'published'
  // 生命周期字段上线前创建的 Skill 只有 status。
  return skill.status === 'active'
}

export class BotanicAgentSkillError extends Error {
  constructor(statusCode, code, message) {
    super(message)
    this.statusCode = statusCode
    this.code = code
  }
}

function text(value, name, maximumLength) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BotanicAgentSkillError(400, 'INVALID_AGENT_SKILL', `${name}不能为空。`)
  }
  if (value.length > maximumLength) {
    throw new BotanicAgentSkillError(400, 'INVALID_AGENT_SKILL', `${name}过长。`)
  }
  return value.trim()
}

export function normalizeBotanicAgentSkillCapabilities(value) {
  if (value === undefined) return ['read']
  if (!Array.isArray(value) || value.length > 12 || !value.length) {
    throw new BotanicAgentSkillError(400, 'INVALID_AGENT_SKILL', 'Skill 能力声明无效。')
  }
  const capabilities = [...new Set(value.map((capability) => {
    if (typeof capability !== 'string' || !skillCapabilitySet.has(capability)) {
      throw new BotanicAgentSkillError(400, 'INVALID_AGENT_SKILL', `Skill 能力「${String(capability)}」不受支持。`)
    }
    return capability
  }))]
  if (!capabilities.length) throw new BotanicAgentSkillError(400, 'INVALID_AGENT_SKILL', 'Skill 能力声明无效。')
  return capabilities
}

/**
 * Skill Manifest（Epic 6 遗留项，消费方由 Epic 11 提供）。
 *
 * 当初推迟它的理由是「先加字段只会得到一批写而不读的数据」。现在有了真实落点，
 * 而且它补的是一个**已经存在的洞**：
 *
 * `capabilities` 一直是 Skill 的**自称**。`skill_run` 按它算风险 —— 声明 `['read']`
 * 就直接应用、不需要用户确认。但没有任何东西约束这个声明：一个项目 Skill 可以一边
 * 声明自己只读，一边在 instructions 里让 Agent 去做别的。
 *
 * `toolAllowlist` 把声明变成**可核对**的：风险取「自称」与「允许的工具实际是什么风险」
 * 两者的**较高者**，因此少报能力不再能换来跳过确认。
 *
 * 有意不做 `inputSchema` / `outputSchema`：Skill 的产出是指令文本，不是结构化输出，
 * 到今天仍然没有消费方 —— 加了还是写而不读（已复核 `skill_run` / `skill_apply`）。
 */
export const botanicAgentSkillManifestVersion = 1

/**
 * Skill 的执行形态。
 *
 * - `guidance`（缺省，就是今天）：正文注入 Prompt，产出是指令文本。
 * - `evaluator`：作为**受治理的子任务**运行（Epic 11 那套），逐候选给出结构化结论，
 *   进入结果评审的判据集合。
 *
 * 这是 `outputSchema` 的消费方 —— 上一轮我说它「至今没有消费方」，是因为 Skill 只有
 * guidance 一种形态。加了第二种形态之后它才成立。
 */
export const BOTANIC_AGENT_SKILL_KINDS = Object.freeze(['guidance', 'evaluator'])

/** 评审结论词表。与 `agentReviewDeterministic.REVIEW_VERDICTS` 同一份，不另立。 */
const EVALUATOR_VERDICTS = Object.freeze(['pass', 'fail', 'unverifiable'])

const TOOL_NAME = /^[a-z][a-z0-9_]{1,63}$/
// 与 agentStructuredContract 的字段词表一致。outputSchema 会进入跨 Adapter
// canonical hash；把对象键限制为 ASCII 后，Node UTF-16 与 PostgreSQL C collation
// 不再可能因为 Unicode 键排序不同而得到两个 contentHash。
const EVALUATOR_SCHEMA_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/
const FORBIDDEN_EVALUATOR_SCHEMA_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function assertEvaluatorSchemaKeys(raw) {
  const pending = [raw]
  const visited = new Set()
  while (pending.length) {
    const current = pending.pop()
    if (!current || typeof current !== 'object' || visited.has(current)) continue
    visited.add(current)
    if (Array.isArray(current)) {
      pending.push(...current)
      continue
    }
    for (const key of Object.keys(current)) {
      if (!EVALUATOR_SCHEMA_KEY.test(key) || FORBIDDEN_EVALUATOR_SCHEMA_KEYS.has(key)) {
        throw new BotanicAgentSkillError(
          400,
          'INVALID_AGENT_SKILL_MANIFEST',
          `evaluator Skill 的输出 Schema 字段键「${key}」无效。`,
        )
      }
      pending.push(current[key])
    }
  }
}

/**
 * 校验 evaluator 的输出 Schema。
 *
 * 硬性要求它能产出一个**评审结论**：必填 `verdict`，取值限于 pass/fail/unverifiable。
 * 不要求的话，一条 evaluator Skill 可以返回任意形状的 JSON，而评审层拿到它既没法
 * 汇总也没法展示 —— 那就又变成一个写而不读的字段。
 *
 * guidance 形态**不允许**带 outputSchema：它的产出是指令文本，声明一个没人校验的
 * 输出形状只会让人以为它被校验过。
 *
 * @param {any} raw
 * @param {string} kind
 */
function normalizeEvaluatorOutputSchema(raw, kind) {
  if (kind !== 'evaluator') {
    if (raw !== undefined) {
      throw new BotanicAgentSkillError(
        400, 'INVALID_AGENT_SKILL_MANIFEST',
        '只有 evaluator 形态的 Skill 才有输出 Schema；guidance 的产出是指令文本。',
      )
    }
    return undefined
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.type !== 'object') {
    throw new BotanicAgentSkillError(400, 'INVALID_AGENT_SKILL_MANIFEST', 'evaluator Skill 必须声明对象形状的输出 Schema。')
  }
  assertEvaluatorSchemaKeys(raw)
  const properties = raw.properties && typeof raw.properties === 'object' ? raw.properties : {}
  const required = Array.isArray(raw.required) ? raw.required : []
  if (!required.includes('verdict')) {
    throw new BotanicAgentSkillError(400, 'AGENT_SKILL_EVALUATOR_VERDICT_REQUIRED', 'evaluator Skill 的输出 Schema 必须把 verdict 列为必填。')
  }
  const verdict = properties.verdict
  const values = Array.isArray(verdict?.enum) ? verdict.enum : []
  if (verdict?.type !== 'string' || !values.length || values.some((value) => !EVALUATOR_VERDICTS.includes(value))) {
    throw new BotanicAgentSkillError(
      400, 'AGENT_SKILL_EVALUATOR_VERDICT_INVALID',
      `evaluator Skill 的 verdict 取值只能来自 ${EVALUATOR_VERDICTS.join(' / ')}。`,
    )
  }
  if (Object.keys(properties).length > 6) {
    // 字段越多越容易出现「看起来很详实、其实是编的」，而评审层无从分辨。
    throw new BotanicAgentSkillError(400, 'INVALID_AGENT_SKILL_MANIFEST', 'evaluator Skill 的输出字段过多。')
  }
  return structuredClone(raw)
}

/** 这条 Skill 是否作为评审判据执行。缺省 guidance —— 存量 Skill 行为不变。 */
export function isEvaluatorSkill(skill) {
  return skill?.manifest?.kind === 'evaluator' && Boolean(skill.manifest.outputSchema)
}

/**
 * 归一 Skill Manifest。
 *
 * @param {any} raw
 */
export function normalizeAgentSkillManifest(raw) {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BotanicAgentSkillError(400, 'INVALID_AGENT_SKILL_MANIFEST', 'Skill Manifest 无效。')
  }
  const toolAllowlist = raw.toolAllowlist === undefined ? [] : raw.toolAllowlist
  if (!Array.isArray(toolAllowlist) || toolAllowlist.length > 12) {
    throw new BotanicAgentSkillError(400, 'INVALID_AGENT_SKILL_MANIFEST', 'Skill 工具白名单无效。')
  }
  const tools = [...new Set(toolAllowlist.map((name) => {
    if (typeof name !== 'string' || !TOOL_NAME.test(name)) {
      throw new BotanicAgentSkillError(400, 'INVALID_AGENT_SKILL_MANIFEST', `Skill 工具名「${String(name)}」无效。`)
    }
    return name
  }))]
  const kind = raw.kind === undefined ? 'guidance' : raw.kind
  if (!BOTANIC_AGENT_SKILL_KINDS.includes(kind)) {
    throw new BotanicAgentSkillError(400, 'INVALID_AGENT_SKILL_MANIFEST', `Skill 形态「${String(kind)}」不受支持。`)
  }
  const outputSchema = normalizeEvaluatorOutputSchema(raw.outputSchema, kind)
  const dependencies = raw.dependencies === undefined ? [] : raw.dependencies
  if (!Array.isArray(dependencies) || dependencies.length > 8) {
    throw new BotanicAgentSkillError(400, 'INVALID_AGENT_SKILL_MANIFEST', 'Skill 依赖声明无效。')
  }
  return {
    version: botanicAgentSkillManifestVersion,
    kind,
    ...(outputSchema ? { outputSchema } : {}),
    toolAllowlist: tools,
    dependencies: dependencies.map((dependency) => {
      const skillId = text(dependency?.skillId, 'Skill 依赖标识', 160)
      const version = dependency?.version === undefined ? undefined : Number(dependency.version)
      if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) {
        throw new BotanicAgentSkillError(400, 'INVALID_AGENT_SKILL_MANIFEST', `Skill 依赖「${skillId}」的版本无效。`)
      }
      const contentHash = dependency?.contentHash === undefined
        ? undefined
        : text(dependency.contentHash, `Skill 依赖「${skillId}」的内容摘要`, 200)
      return {
        skillId,
        ...(version === undefined ? {} : { version }),
        ...(contentHash === undefined ? {} : { contentHash }),
      }
    }),
  }
}

/**
 * Skill 内容摘要的结构版本。旧记录只对 instructions 做 SHA-256；
 * V2 把所有会影响执行的字段一起纳入，避免「Manifest 已换、hash 没换」。
 */
export const BOTANIC_AGENT_SKILL_CONTENT_HASH_VERSION = 2

function normalizedSkillExecution(input) {
  const name = text(input?.name, 'Skill 名称', 80)
  const instructions = text(input?.instructions, 'Skill 规则', 4000)
  const capabilities = normalizeBotanicAgentSkillCapabilities(input?.capabilities)
  const manifest = normalizeAgentSkillManifest(input?.manifest)
  return { name, instructions, capabilities, ...(manifest ? { manifest } : {}) }
}

function manifestHashSemantics(manifest) {
  if (!manifest) return null
  // PostgreSQL `COLLATE "C"` 对 UTF-8 按代码点顺序比较。这里不用受 ICU/
  // 运行环境影响的 localeCompare，确保 Node 与 Supabase RPC 重算同一个 hash。
  const compareStableText = (left, right) => {
    const leftPoints = [...String(left)]
    const rightPoints = [...String(right)]
    const length = Math.min(leftPoints.length, rightPoints.length)
    for (let index = 0; index < length; index += 1) {
      const difference = leftPoints[index].codePointAt(0) - rightPoints[index].codePointAt(0)
      if (difference) return difference
    }
    return leftPoints.length - rightPoints.length
  }
  return {
    version: manifest.version,
    kind: manifest.kind,
    ...(manifest.outputSchema ? { outputSchema: manifest.outputSchema } : {}),
    // 这三者的声明顺序不影响执行；为重试使用稳定的语义顺序。
    toolAllowlist: [...manifest.toolAllowlist].sort(compareStableText),
    dependencies: [...manifest.dependencies]
      .map((dependency) => ({ ...dependency }))
      .sort((left, right) => (
        compareStableText(left.skillId, right.skillId)
        || Number(left.version ?? 0) - Number(right.version ?? 0)
        || compareStableText(left.contentHash ?? '', right.contentHash ?? '')
      )),
  }
}

/** Adapter 与领域层共用的 Skill 执行语义摘要入口。 */
export function agentSkillExecutionContentHash(input) {
  const normalized = normalizedSkillExecution(input)
  return canonicalHash({
    schemaVersion: BOTANIC_AGENT_SKILL_CONTENT_HASH_VERSION,
    name: normalized.name,
    instructions: normalized.instructions,
    capabilities: [...normalized.capabilities]
      .sort((left, right) => skillRiskOrder.indexOf(left) - skillRiskOrder.indexOf(right)),
    manifest: manifestHashSemantics(normalized.manifest),
  })
}

function positiveInteger(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 1 ? number : undefined
}

function timestamp(value, name) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) {
    throw new BotanicAgentSkillError(400, 'INVALID_AGENT_SKILL_VERSION', `${name}无效。`)
  }
  return number
}

/**
 * 构造不可变版本的完整快照。这是三个 ProductStore Adapter 应共用的入口：
 * Adapter 不再自己只 hash instructions，也不再用「写一次就 +1」判定版本。
 */
export function buildAgentSkillVersionSnapshot(input, options) {
  const { version, updatedAt, publishedBy, publishedAt } = options ?? {}
  const normalizedVersion = positiveInteger(version)
  if (!normalizedVersion) {
    throw new BotanicAgentSkillError(400, 'INVALID_AGENT_SKILL_VERSION', 'Skill 版本无效。')
  }
  const normalized = normalizedSkillExecution(input)
  const normalizedUpdatedAt = timestamp(updatedAt, 'Skill 版本更新时间')
  if ((publishedBy === undefined) !== (publishedAt === undefined)) {
    throw new BotanicAgentSkillError(400, 'INVALID_AGENT_SKILL_VERSION', 'Skill 版本的发布人与发布时间必须同时存在。')
  }
  const publication = publishedBy === undefined
    ? {}
    : {
        publishedBy: text(publishedBy, 'Skill 版本发布人', 160),
        publishedAt: timestamp(publishedAt, 'Skill 版本发布时间'),
      }
  return {
    version: normalizedVersion,
    name: normalized.name,
    instructions: normalized.instructions,
    capabilities: [...normalized.capabilities],
    ...(normalized.manifest ? { manifest: structuredClone(normalized.manifest) } : {}),
    contentHash: agentSkillExecutionContentHash(normalized),
    updatedAt: normalizedUpdatedAt,
    ...publication,
  }
}

/**
 * 验证新版本快照的完整性和摘要。`allowLegacy` 只用于读取历史记录，
 * 不会伪造旧版本当时未保存的 name / capabilities / manifest。
 */
export function validateAgentSkillVersionSnapshot(raw, options) {
  const allowLegacy = options?.allowLegacy === true
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BotanicAgentSkillError(400, 'INVALID_AGENT_SKILL_VERSION', 'Skill 版本快照无效。')
  }
  const complete = typeof raw.name === 'string'
    && Array.isArray(raw.capabilities)
    && typeof raw.instructions === 'string'
    && typeof raw.contentHash === 'string'
  if (!complete && allowLegacy) return structuredClone(raw)
  if (!complete) {
    throw new BotanicAgentSkillError(400, 'INVALID_AGENT_SKILL_VERSION', 'Skill 版本快照不完整。')
  }
  const snapshot = buildAgentSkillVersionSnapshot(raw, {
    version: raw.version,
    updatedAt: raw.updatedAt,
    ...(raw.publishedBy === undefined && raw.publishedAt === undefined
      ? {}
      : { publishedBy: raw.publishedBy, publishedAt: raw.publishedAt }),
  })
  if (snapshot.contentHash !== raw.contentHash) {
    if (allowLegacy) return structuredClone(raw)
    throw new BotanicAgentSkillError(409, 'AGENT_SKILL_VERSION_HASH_MISMATCH', 'Skill 版本快照与内容摘要不一致。')
  }
  return snapshot
}

function currentAgentSkillVersion(existing) {
  return Math.max(
    positiveInteger(existing?.version) ?? 0,
    ...(Array.isArray(existing?.versions)
      ? existing.versions.map((entry) => positiveInteger(entry?.version) ?? 0)
      : [0]),
  ) || 1
}

function legacyAgentSkillVersionPrefix(existing, version, now) {
  // 最早的 Skill 行可能只在顶层保存当前版本，没有 versions 数组。
  // 首次 V2 写入时先把这份旧身份冻结成「明确不完整」的 legacy 前缀：
  // 保留旧 hash，不伪造当时没有的 name/capabilities/manifest，后续版本才用 V2 hash。
  return {
    version,
    instructions: text(existing?.instructions, 'Skill legacy 规则', 4000),
    contentHash: text(existing?.contentHash, 'Skill legacy 内容摘要', 200),
    updatedAt: timestamp(existing?.updatedAt ?? existing?.createdAt ?? now, 'Skill legacy 版本更新时间'),
  }
}

/**
 * 单一版本判定：相同执行语义的重试不追加版本；执行语义或 hash
 * 算法变化才追加。返回的 snapshot / versions 可由所有 Adapter 直接持久化。
 */
export function prepareAgentSkillVersionSnapshot(existing, input, options) {
  const { now = Date.now(), publishedBy, publishedAt = now } = options ?? {}
  const normalized = normalizedSkillExecution(input)
  const contentHash = agentSkillExecutionContentHash(normalized)
  const previousVersion = existing ? currentAgentSkillVersion(existing) : 0
  const previousSnapshot = existing ? agentSkillVersion(existing, previousVersion) : undefined
  const previousHash = previousSnapshot?.contentHash
    ?? (Number(existing?.version) === previousVersion ? existing?.contentHash : undefined)
  const changed = !existing || previousHash !== contentHash
  const version = existing ? previousVersion + (changed ? 1 : 0) : 1
  const inheritedPublication = !changed && publishedBy === undefined
    ? (previousSnapshot?.publishedBy
        ? { publishedBy: previousSnapshot.publishedBy, publishedAt: previousSnapshot.publishedAt }
        : (Number(existing?.version) === previousVersion && existing?.publishedBy
            ? { publishedBy: existing.publishedBy, publishedAt: existing.publishedAt }
            : {}))
    : {}
  const publication = publishedBy === undefined
    ? inheritedPublication
    : { publishedBy, publishedAt }
  const snapshot = buildAgentSkillVersionSnapshot(normalized, {
    version,
    updatedAt: changed ? now : Number(previousSnapshot?.updatedAt ?? existing?.updatedAt ?? now),
    ...publication,
  })
  const previousVersions = Array.isArray(existing?.versions) && existing.versions.length
    ? existing.versions.map((entry) => structuredClone(entry))
    : (existing ? [legacyAgentSkillVersionPrefix(existing, previousVersion, now)] : [])
  const versions = changed
    ? [...previousVersions, snapshot]
    : (previousVersions.some((entry) => Number(entry?.version) === version)
        ? previousVersions.map((entry) => (Number(entry?.version) === version ? snapshot : entry))
        : [...previousVersions, snapshot])
  return { changed, version, contentHash, snapshot, versions }
}

/**
 * 发布时将可解析的依赖固定到 version + contentHash。未传目录、依赖缺失，
 * 或存量版本没有 hash 时保留旧声明，由既有运行时 dependencyIssues 路径告警。
 */
export function freezeAgentSkillDependencies(manifest, catalog = []) {
  const normalized = normalizeAgentSkillManifest(manifest)
  if (!normalized) return undefined
  const byId = new Map((catalog ?? []).filter((entry) => entry?.id).map((entry) => [entry.id, entry]))
  return {
    ...normalized,
    dependencies: normalized.dependencies.map((dependency) => {
      const target = byId.get(dependency.skillId)
      if (!target) return dependency
      const version = dependency.version ?? positiveInteger(target.version)
      if (!version) return dependency
      const snapshot = agentSkillVersion(target, version)
      const currentHash = Number(target.version) === version ? target.contentHash : undefined
      const contentHash = snapshot?.contentHash ?? currentHash
      if (!contentHash) return dependency
      if (dependency.contentHash && dependency.contentHash !== contentHash) {
        throw new BotanicAgentSkillError(
          409,
          'AGENT_SKILL_DEPENDENCY_STALE',
          `Skill 依赖「${dependency.skillId}@${version}」的内容摘要已变化。`,
        )
      }
      return { skillId: dependency.skillId, version, contentHash }
    }),
  }
}

/**
 * 白名单里的工具实际是什么风险。
 *
 * **查不到的工具按最高风险处理**，与既有的「未知能力按最高风险」同一判断：
 * 一个不在当前注册表里的工具名，可能是拼错，也可能是别处的写工具 —— 两种情况都不该
 * 因为「这里查不到」而被当成只读放行。
 *
 * @param {any} manifest
 * @param {(name: string) => (string | undefined)} riskOf
 */
export function agentSkillManifestRisk(manifest, riskOf) {
  const tools = Array.isArray(manifest?.toolAllowlist) ? manifest.toolAllowlist : []
  if (!tools.length) return 'read'
  return tools.reduce((risk, name) => {
    const declared = typeof riskOf === 'function' ? riskOf(name) : undefined
    const normalized = skillRiskOrder.includes(declared) ? declared : 'external'
    return skillRiskOrder.indexOf(normalized) > skillRiskOrder.indexOf(risk) ? normalized : risk
  }, 'read')
}

/**
 * 声明的能力必须**覆盖**白名单实际的风险。
 *
 * 少报直接拒绝，而不是悄悄按较高者执行：少报要么是写错了、要么是想绕过确认，
 * 两种都该在发布时被指出来，而不是留到运行时靠取最大值兜底。
 * （运行时仍然取最大值兜底 —— 存量 Skill 没有 Manifest，那条路径必须继续安全。）
 *
 * @param {{ capabilities?: string[], manifest?: any }} skill
 * @param {(name: string) => (string | undefined)} riskOf
 */
export function assertAgentSkillManifestConsistent(skill, riskOf) {
  const manifest = skill?.manifest
  if (!manifest?.toolAllowlist?.length) return
  const declared = normalizeBotanicAgentSkillCapabilities(skill?.capabilities)
  const declaredRisk = declared.reduce((risk, capability) => (
    skillRiskOrder.indexOf(capability) > skillRiskOrder.indexOf(risk) ? capability : risk
  ), 'read')
  const actual = agentSkillManifestRisk(manifest, riskOf)
  if (skillRiskOrder.indexOf(actual) > skillRiskOrder.indexOf(declaredRisk)) {
    throw new BotanicAgentSkillError(
      409,
      'AGENT_SKILL_CAPABILITY_UNDERSTATED',
      `Skill 声明了「${declaredRisk}」能力，但它允许的工具实际需要「${actual}」；请修正能力声明或收窄工具白名单。`,
    )
  }
}

/**
 * 解析 Skill 依赖，找出**不可用**的那些。
 *
 * 依赖一个已弃用或不存在的 Skill，本身就说明这条 Skill 的规则已经不完整了。
 * 静默照跑会得到一份少了半截约束的执行 —— 而用户以为整套规则都在生效。
 *
 * 自依赖与环也在这里挡住：环会让「解析依赖」变成无限递归。
 *
 * @param {any} skill
 * @param {any[]} catalog
 */
export function resolveAgentSkillDependencies(skill, catalog = []) {
  const closure = resolveAgentSkillDependencyClosure([skill], catalog)
  return { ok: !closure.missing.length && !closure.unusable.length && !closure.cyclic.length, missing: closure.missing, unusable: closure.unusable, cyclic: closure.cyclic }
}

/**
 * 解析一组挂载 root 的完整依赖 closure（fail-closed 版本）。
 *
 * 与 `resolveAgentSkillDependencies` 的差别：除了指出坏依赖，它还返回
 * dependency-first 拓扑顺序的 closure 节点（diamond 只出现一次）、同一依赖被
 * 要求为不同版本时的 `conflicts`，以及超出防御边界时的 `limitExceeded`。
 * 递归前固定边界：越界直接停，不产出巨型 closure 再由调用方裁剪。
 */
export function resolveAgentSkillDependencyClosure(rootSkills, catalog = [], { maxDepth = 8, maxNodes = 64 } = {}) {
  const byId = new Map((catalog ?? []).filter((entry) => entry?.id).map((entry) => [entry.id, entry]))
  const missing = []
  const unusable = []
  const cyclic = []
  const conflicts = []
  const completed = new Set()
  const resolvedVersionById = new Map()
  const closure = []
  let limitExceeded
  const roots = (Array.isArray(rootSkills) ? rootSkills : []).filter((entry) => entry?.id)
  const distinctNodes = new Set(roots.map((entry) => entry.id))
  const pushUnique = (list, value) => { if (!list.includes(value)) list.push(value) }

  // Root 也是同一 closure 的版本约束；否则 A -> B@v1 与显式挂载 B@v2 会把依赖静默丢掉。
  for (const root of roots) {
    const versionKey = positiveInteger(root.version) ?? positiveInteger(byId.get(root.id)?.version) ?? 'current'
    const previousVersion = resolvedVersionById.get(root.id)
    if (previousVersion !== undefined && previousVersion !== versionKey) pushUnique(conflicts, root.id)
    else resolvedVersionById.set(root.id, versionKey)
  }

  const visit = (dependency, stack, depth) => {
    if (limitExceeded) return
    const dependencyId = dependency?.skillId
    if (!dependencyId) return
    if (depth > maxDepth) { limitExceeded = 'depth'; return }
    // `stack` 只表示当前 DFS 路径。不能用全局 seen 当环判定：
    // top -> left -> shared 和 top -> right -> shared 是合法 diamond，不是环。
    if (stack.has(dependencyId)) {
      pushUnique(cyclic, dependencyId)
      return
    }
    const target = byId.get(dependencyId)
    if (!target) { pushUnique(missing, dependencyId); return }
    if (!isUsableAgentSkill(target)) { pushUnique(unusable, dependencyId); return }

    const pinnedSnapshot = dependency.version === undefined
      ? undefined
      : agentSkillVersion(target, dependency.version)
    if (dependency.version !== undefined && !pinnedSnapshot) {
      pushUnique(missing, `${dependencyId}@${dependency.version}`)
      return
    }
    const resolvedVersion = dependency.version ?? positiveInteger(target.version)
    const resolvedHash = pinnedSnapshot?.contentHash
      ?? (resolvedVersion === undefined || Number(target.version) === resolvedVersion ? target.contentHash : undefined)
    if (dependency.contentHash && resolvedHash && dependency.contentHash !== resolvedHash) {
      pushUnique(missing, resolvedVersion ? `${dependencyId}@${resolvedVersion}` : dependencyId)
      return
    }
    // 同一依赖被两个 root/上游要求为不同版本时不能猜一个：closure 里每个 id 只有一份正文。
    const versionKey = resolvedVersion ?? 'current'
    const previousVersion = resolvedVersionById.get(dependencyId)
    if (previousVersion !== undefined && previousVersion !== versionKey) {
      pushUnique(conflicts, dependencyId)
      return
    }
    resolvedVersionById.set(dependencyId, versionKey)
    const nodeKey = `${dependencyId}@${versionKey}`
    if (completed.has(nodeKey)) return
    if (!distinctNodes.has(dependencyId)) {
      if (distinctNodes.size >= maxNodes) { limitExceeded = 'nodes'; return }
      distinctNodes.add(dependencyId)
    }

    stack.add(dependencyId)
    // 新版本快照有自己的 Manifest；存量快照没有时才回退当前 Manifest。
    const completePinnedSnapshot = typeof pinnedSnapshot?.name === 'string'
      && Array.isArray(pinnedSnapshot?.capabilities)
    const nestedManifest = completePinnedSnapshot ? pinnedSnapshot.manifest : target.manifest
    for (const nested of nestedManifest?.dependencies ?? []) visit(nested, stack, depth + 1)
    stack.delete(dependencyId)
    if (limitExceeded) return
    completed.add(nodeKey)
    // 依赖在自己的全部依赖之后入列（post-order）即 dependency-first。
    const body = completePinnedSnapshot ? pinnedSnapshot : target
    closure.push({
      id: dependencyId,
      ...(resolvedVersion !== undefined ? { version: resolvedVersion } : {}),
      ...(resolvedHash ? { contentHash: resolvedHash } : {}),
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(typeof body.instructions === 'string' ? { instructions: body.instructions } : {}),
      ...(Array.isArray(body.capabilities) ? { capabilities: [...body.capabilities] } : {}),
      ...(body.manifest ? { manifest: body.manifest } : {}),
      ...(typeof target.source === 'string' ? { source: target.source } : {}),
    })
  }

  for (const root of roots) {
    const stack = new Set([root.id])
    for (const dependency of root?.manifest?.dependencies ?? []) visit(dependency, stack, 1)
  }
  return {
    ok: !missing.length && !unusable.length && !cyclic.length && !conflicts.length && !limitExceeded,
    missing, unusable, cyclic, conflicts, closure,
    ...(limitExceeded ? { limitExceeded } : {}),
  }
}

export function validateAgentSkillCreation(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BotanicAgentSkillError(400, 'INVALID_AGENT_SKILL', 'Skill 请求无效。')
  }
  const projectId = text(body.projectId, '项目', 160)
  const name = text(body.name, 'Skill 名称', 80)
  const instructions = text(body.instructions, 'Skill 规则', 4000)
  if (/data:(?:image|video|audio)\//i.test(instructions)) {
    throw new BotanicAgentSkillError(400, 'AGENT_SKILL_MEDIA_FORBIDDEN', 'Skill 规则不能包含媒体数据。')
  }
  if (/https?:\/\//i.test(instructions)) {
    throw new BotanicAgentSkillError(400, 'AGENT_SKILL_EXTERNAL_URL_FORBIDDEN', 'Skill 规则不能直接包含外部地址。')
  }
  const capabilities = normalizeBotanicAgentSkillCapabilities(body.capabilities)
  const manifest = normalizeAgentSkillManifest(body.manifest)
  return { projectId, name, instructions, capabilities, ...(manifest ? { manifest } : {}) }
}

/**
 * 创建项目 Skill。
 *
 * `approvedBy` 是批准这次创建的人。有它才进入 `published` 并记下批准人与时间；
 * 没有它就停在 `draft` —— 「已批准」不能凭创建这个动作本身成立。当前唯一的创建入口
 * 是用户确认过的 Agent 行动，因此路由把确认者作为批准人传进来。
 */
export function createAgentSkill(input, {
  id = `agent_skill_${randomUUID()}`,
  ownerId,
  approvedBy,
  riskOf,
  skillCatalog,
  now = Date.now(),
} = {}) {
  if (!ownerId) throw new TypeError('项目 Skill 缺少所有者。')
  const manifest = approvedBy && skillCatalog !== undefined
    ? freezeAgentSkillDependencies(input.manifest, skillCatalog)
    : normalizeAgentSkillManifest(input.manifest)
  const normalized = normalizedSkillExecution({ ...input, ...(manifest ? { manifest } : { manifest: undefined }) })
  // 少报能力在**发布时**就指出来，不留到运行时靠取最大值兜底。
  assertAgentSkillManifestConsistent({ capabilities: normalized.capabilities, manifest }, riskOf)
  const lifecycle = approvedBy ? 'published' : 'draft'
  const prepared = prepareAgentSkillVersionSnapshot(undefined, normalized, {
    now,
    ...(approvedBy ? { publishedBy: approvedBy, publishedAt: now } : {}),
  })
  return {
    id,
    projectId: input.projectId,
    ownerId,
    name: normalized.name,
    instructions: normalized.instructions,
    lifecycle,
    status: statusForLifecycle(lifecycle),
    createdAt: now,
    updatedAt: now,
    version: prepared.version,
    contentHash: prepared.contentHash,
    capabilities: normalized.capabilities,
    ...(manifest ? { manifest } : {}),
    ...(approvedBy ? { governance: 'project-approved', publishedBy: approvedBy, publishedAt: now } : {}),
    versions: prepared.versions,
  }
}

/**
 * 修改已发布 Skill：**追加新版本**，不原位改写。
 *
 * 已发布版本原位可改的话，持有 `version: N` 的历史 Run 会突然按新内容执行，
 * 「历史 Run 仍引用旧版本」就是一句无法验证的声明（ADR 0006）。
 */
export function updateAgentSkill(existing, input, {
  actorId,
  approvedBy,
  riskOf,
  skillCatalog,
  now = Date.now(),
} = {}) {
  if (!existing?.id) throw new TypeError('Skill 更新缺少原始记录。')
  if (!actorId) throw new TypeError('Skill 更新缺少操作者。')
  let manifest = input?.manifest === undefined
    ? normalizeAgentSkillManifest(existing.manifest)
    : normalizeAgentSkillManifest(input.manifest)
  if (approvedBy && skillCatalog !== undefined) {
    manifest = freezeAgentSkillDependencies(manifest, skillCatalog)
  }
  const normalized = normalizedSkillExecution({
    name: input?.name === undefined ? existing.name : input.name,
    instructions: input?.instructions === undefined ? existing.instructions : input.instructions,
    capabilities: input?.capabilities === undefined ? existing.capabilities : input.capabilities,
    ...(manifest ? { manifest } : {}),
  })
  assertAgentSkillManifestConsistent({
    capabilities: normalized.capabilities,
    manifest,
  }, riskOf)
  const prepared = prepareAgentSkillVersionSnapshot(existing, normalized, {
    now,
    ...(approvedBy ? { publishedBy: approvedBy, publishedAt: now } : {}),
  })

  // 顶层已是 V2 hash 但没有 versions 的存量行，需要一次同版完整快照
  // backfill。这不是语义更新：保留原生命周期、批准人和 updatedAt。
  const executionReplay = !approvedBy || existing.lifecycle === 'published'
  if (!prepared.changed && (!Array.isArray(existing.versions) || !existing.versions.length)
    && executionReplay) {
    return { ...existing, versions: prepared.versions }
  }
  // 完全相同的执行语义是重试，不降级生命周期、不改 updatedAt，也不追加版本。
  if (!prepared.changed && executionReplay) return existing

  const lifecycle = approvedBy ? 'published' : 'draft'
  const result = {
    ...existing,
    name: normalized.name,
    instructions: normalized.instructions,
    capabilities: normalized.capabilities,
    ...(manifest ? { manifest } : {}),
    lifecycle,
    status: statusForLifecycle(lifecycle),
    version: prepared.version,
    contentHash: prepared.contentHash,
    updatedAt: now,
    ...(approvedBy
      ? { governance: 'project-approved', publishedBy: approvedBy, publishedAt: now }
      : { governance: undefined, publishedBy: undefined, publishedAt: undefined }),
    versions: prepared.versions,
  }
  if (!manifest) delete result.manifest
  return result
}

/** 弃用：不删除历史版本，只让它不再可挂载。 */
export function deprecateAgentSkill(existing, { actorId, now = Date.now() } = {}) {
  if (!existing?.id) throw new TypeError('Skill 弃用缺少原始记录。')
  if (!actorId) throw new TypeError('Skill 弃用缺少操作者。')
  return {
    ...existing,
    lifecycle: 'deprecated',
    status: statusForLifecycle('deprecated'),
    deprecatedBy: actorId,
    deprecatedAt: now,
    updatedAt: now,
  }
}

/**
 * 取回某个历史版本的指令内容。
 *
 * 没有这条路径，一个持有 `version: N` 的历史 Run 就无法说明自己当时按什么执行 ——
 * 「Run 固定 Skill 版本」也就无从验证。
 */
export function agentSkillVersion(skill, version) {
  const target = Number(version)
  if (!Number.isSafeInteger(target) || target < 1) return undefined
  return (Array.isArray(skill?.versions) ? skill.versions : []).find((entry) => Number(entry?.version) === target)
}

export function publicAgentSkill(skill) {
  if (!skill) return undefined
  const lifecycle = lifecycleSet.has(skill.lifecycle)
    ? skill.lifecycle
    : (skill.status === 'active' ? 'published' : 'deprecated')
  return {
    id: skill.id,
    projectId: skill.projectId,
    name: skill.name,
    instructions: skill.instructions,
    lifecycle,
    status: skill.status,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
    version: skill.version ?? 1,
    contentHash: skill.contentHash,
    capabilities: skill.capabilities ?? ['read'],
    ...(skill.manifest ? { manifest: skill.manifest } : {}),
    // 治理状态只在真的批准过时才出现；缺省即「尚未批准」，不再默认成已批准。
    ...(skill.governance ? { governance: skill.governance } : {}),
    ...(skill.publishedBy ? { publishedBy: skill.publishedBy, publishedAt: skill.publishedAt } : {}),
    ...(skill.deprecatedBy ? { deprecatedBy: skill.deprecatedBy, deprecatedAt: skill.deprecatedAt } : {}),
    // 历史版本清单随读模型暴露：内容按需用 agentSkillVersion 取回，列表只给身份。
    versions: (Array.isArray(skill.versions) ? skill.versions : []).map((entry) => ({
      version: entry.version,
      contentHash: entry.contentHash,
      updatedAt: entry.updatedAt,
      ...(entry.publishedBy ? { publishedBy: entry.publishedBy, publishedAt: entry.publishedAt } : {}),
    })),
  }
}
