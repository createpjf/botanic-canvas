import { createHash, randomUUID } from 'node:crypto'

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
      if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
        throw new BotanicAgentSkillError(400, 'INVALID_AGENT_SKILL_MANIFEST', `Skill 依赖「${skillId}」的版本无效。`)
      }
      return { skillId, ...(version === undefined ? {} : { version }) }
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
  const byId = new Map((catalog ?? []).filter((entry) => entry?.id).map((entry) => [entry.id, entry]))
  const missing = []
  const unusable = []
  const cyclic = []
  const seen = new Set([skill?.id])
  const queue = [...(skill?.manifest?.dependencies ?? [])]
  while (queue.length) {
    const dependency = queue.shift()
    if (dependency.skillId === skill?.id) { cyclic.push(dependency.skillId); continue }
    if (seen.has(dependency.skillId)) { cyclic.push(dependency.skillId); continue }
    seen.add(dependency.skillId)
    const target = byId.get(dependency.skillId)
    if (!target) { missing.push(dependency.skillId); continue }
    if (!isUsableAgentSkill(target)) { unusable.push(dependency.skillId); continue }
    // 声明了版本却取不到那个版本，等同依赖缺失：按「当前版本」顶替会让规则悄悄变了。
    if (dependency.version !== undefined && !agentSkillVersion(target, dependency.version)) {
      missing.push(`${dependency.skillId}@${dependency.version}`)
      continue
    }
    queue.push(...(target.manifest?.dependencies ?? []))
  }
  return { ok: !missing.length && !unusable.length && !cyclic.length, missing, unusable, cyclic }
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
  now = Date.now(),
} = {}) {
  if (!ownerId) throw new TypeError('项目 Skill 缺少所有者。')
  const manifest = normalizeAgentSkillManifest(input.manifest)
  // 少报能力在**发布时**就指出来，不留到运行时靠取最大值兜底。
  assertAgentSkillManifestConsistent({ capabilities: input.capabilities, manifest }, riskOf)
  const contentHash = createHash('sha256').update(input.instructions).digest('base64url')
  const lifecycle = approvedBy ? 'published' : 'draft'
  return {
    id,
    projectId: input.projectId,
    ownerId,
    name: input.name,
    instructions: input.instructions,
    lifecycle,
    status: statusForLifecycle(lifecycle),
    createdAt: now,
    updatedAt: now,
    version: 1,
    contentHash,
    capabilities: normalizeBotanicAgentSkillCapabilities(input.capabilities),
    ...(manifest ? { manifest } : {}),
    ...(approvedBy ? { governance: 'project-approved', publishedBy: approvedBy, publishedAt: now } : {}),
    versions: [{
      version: 1, contentHash, instructions: input.instructions, updatedAt: now,
      ...(approvedBy ? { publishedBy: approvedBy, publishedAt: now } : {}),
    }],
  }
}

/**
 * 修改已发布 Skill：**追加新版本**，不原位改写。
 *
 * 已发布版本原位可改的话，持有 `version: N` 的历史 Run 会突然按新内容执行，
 * 「历史 Run 仍引用旧版本」就是一句无法验证的声明（ADR 0006）。
 */
export function updateAgentSkill(existing, input, { actorId, approvedBy, riskOf, now = Date.now() } = {}) {
  if (!existing?.id) throw new TypeError('Skill 更新缺少原始记录。')
  if (!actorId) throw new TypeError('Skill 更新缺少操作者。')
  const manifest = input?.manifest === undefined
    ? normalizeAgentSkillManifest(existing.manifest)
    : normalizeAgentSkillManifest(input.manifest)
  assertAgentSkillManifestConsistent({
    capabilities: input?.capabilities === undefined ? existing.capabilities : input.capabilities,
    manifest,
  }, riskOf)
  const instructions = text(input?.instructions ?? existing.instructions, 'Skill 规则', 4000)
  const contentHash = createHash('sha256').update(instructions).digest('base64url')
  const versions = Array.isArray(existing.versions) ? [...existing.versions] : []
  const version = Number(existing.version ?? versions.length ?? 1) + 1
  const lifecycle = approvedBy ? 'published' : 'draft'
  return {
    ...existing,
    name: input?.name ? text(input.name, 'Skill 名称', 80) : existing.name,
    instructions,
    capabilities: input?.capabilities === undefined
      ? normalizeBotanicAgentSkillCapabilities(existing.capabilities)
      : normalizeBotanicAgentSkillCapabilities(input.capabilities),
    ...(manifest ? { manifest } : {}),
    lifecycle,
    status: statusForLifecycle(lifecycle),
    version,
    contentHash,
    updatedAt: now,
    ...(approvedBy
      ? { governance: 'project-approved', publishedBy: approvedBy, publishedAt: now }
      : { governance: undefined, publishedBy: undefined, publishedAt: undefined }),
    versions: [...versions, {
      version, contentHash, instructions, updatedAt: now,
      ...(approvedBy ? { publishedBy: approvedBy, publishedAt: now } : {}),
    }],
  }
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
  if (!Number.isInteger(target) || target < 1) return undefined
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
