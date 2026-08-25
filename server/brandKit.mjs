// @ts-check
import { canonicalHash } from './canonicalHash.mjs'

/**
 * Brand Kit V1（Epic 9.1）。品牌规则的唯一权威表示与三层解析。
 *
 * 在此之前品牌只有一种形态：`ProductionWorkflowDefinition.brandRules`，一个从项目
 * 记忆派生的 `string[]`。它有两个结构性缺陷：
 *
 * - **只有一层**。「全局品牌」「项目 Creative Spec」「单次 Run 覆盖」压成同一个数组，
 *   因此无法回答「这条规则从哪来、为什么是它生效而不是另一条」。
 * - **评审拿不到它**。`agentReviewVision` 一直把 `brand_style` 列为必查判据，却只给
 *   模型一句「是否符合品牌风格与禁用表达」—— 没有任何一条真实规则。那道判据从上线
 *   起就是在没有答案的情况下作答，pass 与 fail 都不可信。
 *
 * 所以这里不是「再加一份品牌字段」，而是补上那两件事：**规则能解释自己的来源与优先
 * 级**，且**同一份解析结果同时喂给 Prompt 编译与结果 QA**。两个消费方都已存在。
 */

/** 品牌维度。与 Epic 9.1 列举一一对应；新增维度必须同时说明它如何被检查。 */
export const BRAND_KIT_FACETS = Object.freeze([
  'logo', 'color', 'typography', 'tone', 'photography', 'layout', 'prohibition',
])

/**
 * 三层，**升序即优先级**。测试锁定这个顺序：把它写反会让全局品牌压住单次覆盖，
 * 而且不会有任何报错 —— 用户只会发现「我明明改了这次的要求，出来还是老样子」。
 */
export const BRAND_KIT_LAYERS = Object.freeze(['global', 'project', 'run'])

/**
 * 规则状态。`proposed` 是从品牌手册解析出来的建议，**不进入任何一次生成**，
 * 必须由人确认后才变 `active`（Epic 9.1：「解析只能生成建议，需人工确认后激活」）。
 */
export const BRAND_RULE_STATUSES = Object.freeze(['proposed', 'active', 'retired'])

/**
 * 强制度。`must` 不满足即品牌 QA 判不合格；`should` 不满足只记录。
 * 两者混为一谈，会让「建议留白多一点」和「禁止出现竞品 Logo」有同样的后果。
 */
export const BRAND_RULE_ENFORCEMENT = Object.freeze(['must', 'should'])

/** 规则来源。人工录入与手册解析的可信度不同，激活门槛也不同。 */
export const BRAND_RULE_SOURCES = Object.freeze(['human', 'document_import'])

export class BrandKitError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [statusCode]
   */
  constructor(code, message, statusCode = 400) {
    super(message)
    this.name = 'BrandKitError'
    this.code = code
    this.statusCode = statusCode
  }
}

const SLUG = /^[a-z][a-z0-9_]{0,39}$/

function text(value, name, maximum) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BrandKitError('BRAND_FIELD_MISSING', `${name}不能为空。`)
  }
  const result = value.trim()
  if (result.length > maximum) throw new BrandKitError('BRAND_FIELD_TOO_LONG', `${name}过长。`)
  return result
}

/**
 * 一条品牌规则。
 *
 * `facet` + `key` 构成**槽位**：三层之间按槽位覆盖，高层替换低层。同一层内槽位重复
 * 直接报错而不是静默保留其一 —— 静默丢弃会让作者以为两条规则都生效了。
 *
 * @param {any} raw
 * @param {string} layer
 */
function normalizeRule(raw, layer) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BrandKitError('BRAND_RULE_INVALID', '品牌规则无效。')
  }
  const id = text(raw.id, '品牌规则标识', 160)
  if (!BRAND_KIT_FACETS.includes(raw.facet)) {
    // 手册解析出的建议可以没有维度；但没有维度就**无法激活** —— 它决定这条规则
    // 怎么编译进 Prompt、又该由哪一类检查来判定。确认时必须由人补上。
    throw new BrandKitError('BRAND_RULE_FACET_REQUIRED', `品牌规则「${id}」缺少有效的品牌维度。`)
  }
  const key = raw.key === undefined ? 'default' : String(raw.key).trim()
  if (!SLUG.test(key)) {
    throw new BrandKitError('BRAND_RULE_KEY_INVALID', `品牌规则「${id}」的槽位名无效。`)
  }
  const status = raw.status === undefined ? 'active' : raw.status
  if (!BRAND_RULE_STATUSES.includes(status)) {
    throw new BrandKitError('BRAND_RULE_STATUS_INVALID', `品牌规则「${id}」的状态无效。`)
  }
  const source = raw.source === undefined ? 'human' : raw.source
  if (!BRAND_RULE_SOURCES.includes(source)) {
    throw new BrandKitError('BRAND_RULE_SOURCE_INVALID', `品牌规则「${id}」的来源无效。`)
  }
  // 禁用规则天然是硬约束。允许它是 `should` 等于允许「建议不要出现竞品 Logo」，
  // 那不是禁用规则。
  const enforcement = raw.facet === 'prohibition' ? 'must' : (raw.enforcement ?? 'must')
  if (!BRAND_RULE_ENFORCEMENT.includes(enforcement)) {
    throw new BrandKitError('BRAND_RULE_ENFORCEMENT_INVALID', `品牌规则「${id}」的强制度无效。`)
  }
  // 解析自手册的规则**不能**以激活态入库，无论调用方怎么写。这是 Epic 9.1 的治理
  // 要求落在数据层的那一半：靠调用方自觉，早晚有一条路径会绕过它。
  if (source === 'document_import' && status === 'active' && !raw.confirmedBy) {
    throw new BrandKitError(
      'BRAND_RULE_CONFIRMATION_REQUIRED',
      `品牌规则「${id}」解析自品牌手册，需要人工确认后才能激活。`,
      409,
    )
  }
  return {
    id,
    layer,
    facet: raw.facet,
    key,
    slot: `${raw.facet}.${key}`,
    statement: text(raw.statement, `品牌规则「${id}」的内容`, 600),
    enforcement,
    status,
    source,
    ...(raw.sourceRef ? { sourceRef: text(raw.sourceRef, `品牌规则「${id}」的出处`, 240) } : {}),
    ...(raw.confirmedBy ? { confirmedBy: text(raw.confirmedBy, `品牌规则「${id}」的确认人`, 160) } : {}),
    ...(Number.isFinite(raw.confirmedAt) ? { confirmedAt: Number(raw.confirmedAt) } : {}),
  }
}

/**
 * 校验并归一一层品牌规则。
 *
 * @param {any} raw
 * @param {{ layer?: string }} [options]
 */
export function normalizeBrandKit(raw, { layer = 'global' } = {}) {
  if (!BRAND_KIT_LAYERS.includes(layer)) {
    throw new BrandKitError('BRAND_LAYER_INVALID', `品牌层级「${layer}」无效。`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BrandKitError('BRAND_KIT_INVALID', '品牌套件无效。')
  }
  const rules = Array.isArray(raw.rules) ? raw.rules : []
  if (rules.length > 200) throw new BrandKitError('BRAND_KIT_TOO_LARGE', '品牌规则数量超出上限。')
  const seenSlots = new Set()
  const seenIds = new Set()
  const normalized = rules.map((rule) => {
    const result = normalizeRule(rule, layer)
    if (seenIds.has(result.id)) {
      throw new BrandKitError('BRAND_RULE_ID_DUPLICATE', `品牌规则标识「${result.id}」重复。`)
    }
    seenIds.add(result.id)
    // 同层同槽位重复：静默保留其一会让作者以为两条都生效。报出来让他改槽位名。
    if (result.status !== 'retired' && seenSlots.has(result.slot)) {
      throw new BrandKitError(
        'BRAND_RULE_SLOT_DUPLICATE',
        `品牌槽位「${result.slot}」在同一层中重复；给其中一条换个槽位名。`,
        409,
      )
    }
    if (result.status !== 'retired') seenSlots.add(result.slot)
    return result
  })
  return {
    // `brandId` 是多品牌隔离的依据，因此**不可缺省**。缺省意味着「属于所有品牌」，
    // 那正是要防的事。
    brandId: text(raw.brandId, '品牌标识', 160),
    ...(raw.name ? { name: text(raw.name, '品牌名称', 160) } : {}),
    layer,
    rules: normalized,
    ...(Number.isFinite(raw.updatedAt) ? { updatedAt: Number(raw.updatedAt) } : {}),
  }
}

/** 工作区全局品牌套件库的标识。沿用既有的按标识存取的全局文档表，不新增存储面。 */
export const globalBrandKitLibraryId = 'global-brand-kits'

/**
 * 全局品牌套件库：一个工作区可以有多个品牌，彼此隔离。
 *
 * 服务端**不采信**客户端提交的整份 blob，逐个套件走 `normalizeBrandKit`：这条路径
 * 直接决定生成时套哪套规则，放行一份未校验的内容等于让客户端自行决定品牌约束。
 *
 * @param {any} raw
 */
export function normalizeBrandKitLibrary(raw) {
  const kits = Array.isArray(raw?.kits) ? raw.kits : []
  if (kits.length > 50) throw new BrandKitError('BRAND_LIBRARY_TOO_LARGE', '品牌套件数量超出上限。')
  const seen = new Set()
  const normalized = kits.map((kit) => {
    const result = normalizeBrandKit(kit, { layer: 'global' })
    if (seen.has(result.brandId)) {
      // 同一品牌两份全局套件，取哪一份都是猜。报出来让人合并。
      throw new BrandKitError('BRAND_KIT_DUPLICATE', `品牌「${result.brandId}」有多份全局套件。`, 409)
    }
    seen.add(result.brandId)
    return result
  })
  return {
    id: globalBrandKitLibraryId,
    schemaVersion: 1,
    kits: normalized,
    updatedAt: Number.isFinite(raw?.updatedAt) ? Number(raw.updatedAt) : Date.now(),
  }
}

/** 取某个品牌的全局套件；没有就返回 `undefined`，不退回「第一个」。 */
export function findBrandKit(library, brandId) {
  if (typeof brandId !== 'string' || !brandId.trim()) return undefined
  return (library?.kits ?? []).find((kit) => kit?.brandId === brandId.trim())
}

/**
 * 三层解析。返回**每条生效规则的来源与它压住了谁**。
 *
 * 隔离：任何一层声明了 `brandId` 就必须与目标品牌一致，不一致直接报错而不是过滤掉。
 * 过滤掉等于让一个绑错品牌的项目静默按空品牌生成 —— 用户会以为品牌规则生效了。
 * Run 层允许不声明 `brandId`（临时覆盖没有自己的品牌身份），其余层必须声明。
 *
 * @param {{ brandId: string, global?: any, project?: any, run?: any }} input
 */
export function resolveBrandKit({ brandId, global: globalKit, project: projectKit, run: runKit } = /** @type {any} */ ({})) {
  const targetBrandId = text(brandId, '品牌标识', 160)
  const layers = [
    { layer: 'global', kit: globalKit, brandRequired: true },
    { layer: 'project', kit: projectKit, brandRequired: true },
    { layer: 'run', kit: runKit, brandRequired: false },
  ]
  /** @type {Map<string, any>} */
  const bySlot = new Map()
  /** @type {any[]} */
  const pending = []
  /** @type {any[]} */
  const all = []
  for (const { layer, kit, brandRequired } of layers) {
    if (!kit) continue
    const normalized = normalizeBrandKit(
      // Run 层覆盖继承目标品牌身份，不必自报；自报了就要一致。
      brandRequired || kit.brandId ? kit : { ...kit, brandId: targetBrandId },
      { layer },
    )
    if (normalized.brandId !== targetBrandId) {
      throw new BrandKitError(
        'BRAND_KIT_BRAND_MISMATCH',
        `${layer} 层品牌套件属于品牌「${normalized.brandId}」，与当前品牌「${targetBrandId}」不符。`,
        409,
      )
    }
    for (const rule of normalized.rules) {
      all.push(rule)
      if (rule.status === 'retired') {
        // 高层显式停用同一槽位，等于把低层那条也一并取消 —— 否则「这次不要这条」
        // 做不到，只能靠反向再写一条规则去抵消。
        bySlot.delete(rule.slot)
        continue
      }
      if (rule.status === 'proposed') { pending.push(rule); continue }
      const displaced = bySlot.get(rule.slot)
      bySlot.set(rule.slot, {
        ...rule,
        ...(displaced
          ? { overrides: [...(displaced.overrides ?? []), { id: displaced.id, layer: displaced.layer }] }
          : {}),
      })
    }
  }
  const rules = [...bySlot.values()].sort((left, right) => left.slot.localeCompare(right.slot))
  return {
    brandId: targetBrandId,
    rules,
    /** 待人工确认的建议。它们**不生效**，但必须能被看见，否则永远没人去确认。 */
    pending: pending.map((rule) => ({ ...rule })),
    /** 被高层压住的规则，供界面解释「为什么这条没生效」。 */
    overridden: all.filter((rule) => rule.status === 'active' && !rules.some((kept) => kept.id === rule.id)),
    fingerprint: brandKitFingerprint(rules),
  }
}

/**
 * 生效规则集的指纹。进 Compiled Plan，使「这次是在哪套品牌规则下生成的」可被证明，
 * 也让品牌规则改动后的重跑能被识别为漂移而不是同一次执行。
 *
 * 只取生效规则的身份与内容：待确认的建议与被压住的规则不影响执行，不该改变指纹。
 *
 * @param {any[]} rules
 */
export function brandKitFingerprint(rules) {
  return canonicalHash((rules ?? []).map((rule) => ({
    slot: rule.slot,
    statement: rule.statement,
    enforcement: rule.enforcement,
    layer: rule.layer,
  })))
}

const FACET_LABELS = Object.freeze({
  logo: { 'zh-CN': 'Logo', en: 'Logo' },
  color: { 'zh-CN': '颜色', en: 'Color' },
  typography: { 'zh-CN': '字体', en: 'Typography' },
  tone: { 'zh-CN': '语气', en: 'Tone' },
  photography: { 'zh-CN': '摄影', en: 'Photography' },
  layout: { 'zh-CN': '版式', en: 'Layout' },
  prohibition: { 'zh-CN': '禁用', en: 'Prohibited' },
})

/** @param {string} facet @param {string} [locale] */
export function brandFacetLabel(facet, locale = 'zh-CN') {
  return FACET_LABELS[facet]?.[locale] ?? facet
}

/**
 * 编译进执行 Prompt 的品牌契约行。
 *
 * 与 `withWorkflowBrandRules` 同样的边界：规则以**契约前缀**出现，不拼进用户的画面
 * 描述 —— 混进描述里模型会把「不要用饱和背景」当成要画的元素。
 *
 * `must` 与 `should` 措辞必须不同，否则模型没有依据区分哪条可以让步。
 *
 * @param {{ rules?: any[] }} resolved
 * @param {string} [locale]
 */
export function brandConstraintLines(resolved, locale = 'zh-CN') {
  const rules = resolved?.rules ?? []
  if (!rules.length) return []
  const en = locale === 'en'
  const header = en ? 'Brand rules that must hold:' : '必须遵守的品牌规则：'
  const lines = rules.map((rule) => {
    const facet = brandFacetLabel(rule.facet, locale)
    if (rule.facet === 'prohibition') {
      return en ? `- [${facet}] Never: ${rule.statement}` : `- 【${facet}】绝不：${rule.statement}`
    }
    return rule.enforcement === 'must'
      ? (en ? `- [${facet}] Must: ${rule.statement}` : `- 【${facet}】必须：${rule.statement}`)
      : (en ? `- [${facet}] Prefer: ${rule.statement}` : `- 【${facet}】尽量：${rule.statement}`)
  })
  return [header, ...lines]
}

/**
 * 品牌 QA 的逐条判据。
 *
 * 判据标识用槽位而不是规则 id：规则内容改一版就换 id 的话，历史评审结果无法与
 * 当前规则对上；槽位在三层之间是稳定的。Epic 9.1 验收要求「QA 能逐条关联品牌规则」，
 * 关联键就是它。
 *
 * @param {{ rules?: any[] }} resolved
 */
export function brandReviewCriteria(resolved) {
  return (resolved?.rules ?? []).map((rule) => ({
    id: `brand.${rule.slot}`,
    ruleId: rule.id,
    facet: rule.facet,
    layer: rule.layer,
    enforcement: rule.enforcement,
    statement: rule.statement,
  }))
}

/**
 * 一条不合格的判据是否只是**让步**而不是违规。
 *
 * 「should 不满足不判不合格」这条规则只能有一个实现：评审汇总候选终态时要用它，
 * 品牌 QA 摘要也要用它。两处各写一遍，迟早出现「品牌面板说通过、候选却是 fail」。
 *
 * 判据自带 `enforcement` 时以它为准；没带的一律按 `must`（通用判据没有让步一说）。
 *
 * @param {{ verdict?: string, enforcement?: string }} criterion
 */
export function isBrandConcession(criterion) {
  return criterion?.verdict === 'fail' && criterion?.enforcement === 'should'
}

/**
 * 品牌 QA 结论。
 *
 * `must` 不满足才判不合格；`should` 不满足记为让步项，不改变结论 —— 否则「尽量」
 * 与「必须」没有区别。`unverifiable` 不算通过也不算失败，与既有评审口径一致。
 *
 * @param {Array<{ id: string, verdict?: string, enforcement?: string }>} criteria
 * @param {Array<{ id: string, enforcement: string }>} declared
 */
export function brandQualityVerdict(criteria, declared) {
  const enforcementById = new Map((declared ?? []).map((item) => [item.id, item.enforcement]))
  const relevant = (criteria ?? [])
    .filter((item) => enforcementById.has(item.id))
    .map((item) => ({ ...item, enforcement: item.enforcement ?? enforcementById.get(item.id) }))
  if (!relevant.length) return { verdict: 'unverifiable', violations: [], concessions: [] }
  const concessions = relevant.filter(isBrandConcession)
  const violations = relevant.filter((item) => item.verdict === 'fail' && !isBrandConcession(item))
  if (violations.length) return { verdict: 'fail', violations, concessions }
  // 只有**没被检查**的判据才让结论变成无法验证。让步项是查过并且认了的，
  // 把它算进来会让「尽量留白没做到」显示成「品牌规则没检查」。
  if (relevant.some((item) => item.verdict !== 'pass' && !concessions.includes(item))) {
    return { verdict: 'unverifiable', violations, concessions }
  }
  return { verdict: 'pass', violations, concessions }
}

/**
 * 解释一条规则**为什么**是它生效。Epic 9.1 验收：「Brand Kit 规则能解释来源和优先级」。
 *
 * @param {any} rule
 * @param {string} [locale]
 */
export function brandRuleProvenance(rule, locale = 'zh-CN') {
  const en = locale === 'en'
  const layerLabels = en
    ? { global: 'the global brand kit', project: "this project's creative spec", run: 'this run’s override' }
    : { global: '全局品牌', project: '项目 Creative Spec', run: '本次运行覆盖' }
  const from = layerLabels[rule?.layer] ?? rule?.layer ?? ''
  const overrides = rule?.overrides ?? []
  if (!overrides.length) return en ? `From ${from}.` : `来自${from}。`
  const displaced = overrides.map((item) => layerLabels[item.layer] ?? item.layer).join(en ? ', ' : '、')
  return en
    ? `From ${from}; takes priority over the rule in ${displaced} for the same slot.`
    : `来自${from}，在同一槽位上优先于${displaced}的规则。`
}

const IMPORT_FACET_HINTS = Object.freeze([
  { facet: 'prohibition', patterns: [/禁止|不得|不要|严禁|避免使用/u, /\b(?:never|do not|don't|prohibit|avoid)\b/iu] },
  { facet: 'logo', patterns: [/标志|徽标/u, /\blogo|wordmark\b/iu] },
  { facet: 'color', patterns: [/颜色|色彩|主色|色板|配色/u, /\bcolou?r|palette|hex\b/iu] },
  { facet: 'typography', patterns: [/字体|字号|排版字/u, /\bfont|typeface|typograph/iu] },
  { facet: 'photography', patterns: [/摄影|拍摄|镜头|光线|布光/u, /\bphotograph|lighting|shot\b/iu] },
  { facet: 'layout', patterns: [/版式|留白|间距|安全区|构图/u, /\blayout|margin|spacing|safe area|grid\b/iu] },
  { facet: 'tone', patterns: [/语气|口吻|文案风格/u, /\btone|voice|copy style\b/iu] },
])

function detectFacet(statement) {
  for (const { facet, patterns } of IMPORT_FACET_HINTS) {
    if (patterns.some((pattern) => pattern.test(statement))) return facet
  }
  return undefined
}

/**
 * 从品牌手册正文解析规则**建议**（Epic 9.1）。
 *
 * 两条硬约束，都由结构保证而不是靠调用方自觉：
 *
 * - 产出一律 `status: 'proposed'`、`source: 'document_import'`，因此
 *   `normalizeBrandKit` 会拒绝把它们直接激活。
 * - 判不出维度的条目**不猜**，留空 `facet`。留空的建议无法通过 `normalizeBrandKit`，
 *   于是必须由人在确认时补上维度才能生效。猜一个维度会让它悄悄按错误的方式编译。
 *
 * 入参是**已抽取的文本**。PDF 二进制解包不在这里：仓库没有 PDF 解析依赖，
 * 把它塞进来会让这个纯函数变成需要外部库的模块。
 *
 * @param {string} documentText
 * @param {{ sourceRef?: string, limit?: number, idPrefix?: string }} [options]
 */
export function proposeBrandRulesFromDocument(documentText, { sourceRef, limit = 50, idPrefix = 'brand-proposal' } = {}) {
  const body = typeof documentText === 'string' ? documentText : ''
  const statements = body
    .split(/\r?\n|(?<=[。；;])\s*/u)
    .map((line) => line.replace(/^[\s•*\-–—]+/u, '').replace(/^\d+[.)、]\s*/u, '').trim())
    // 过短的行是标题或页眉，不是规则。
    .filter((line) => line.length >= 6 && line.length <= 600)
  const seen = new Set()
  /** @type {any[]} */
  const proposals = []
  for (const statement of statements) {
    if (seen.has(statement)) continue
    seen.add(statement)
    const facet = detectFacet(statement)
    proposals.push({
      id: `${idPrefix}-${proposals.length + 1}`,
      ...(facet ? { facet } : {}),
      statement,
      status: 'proposed',
      source: 'document_import',
      enforcement: facet === 'prohibition' ? 'must' : 'should',
      ...(sourceRef ? { sourceRef } : {}),
      // 维度判不出来时明确要求人工补齐，而不是让它以「看起来完整」的样子躺在列表里。
      ...(facet ? {} : { needsFacet: true }),
    })
    if (proposals.length >= limit) break
  }
  return {
    proposals,
    unclassified: proposals.filter((proposal) => proposal.needsFacet).length,
    truncated: statements.length > proposals.length,
  }
}
