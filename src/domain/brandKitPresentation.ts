import type { BrandRule, ProjectBrandKit } from './canvas'
import type { ProductLocale } from '../i18n/core'

/**
 * Brand Kit 的展示规则（Epic 9.1）。
 *
 * 放在 domain 而不是组件里，因为这里有几条**不能靠组件自觉**的约束：
 *
 * - 待确认的建议必须与生效规则**分开显示**。混在一起，用户会以为从手册里解析出来的
 *   东西已经在约束生成了 —— 它没有，而且在有人点确认之前永远不会。
 * - 每条生效规则要能说出**来自哪一层、压住了谁**。看不到这个，用户改了项目规则却
 *   发现没生效时，只能猜是不是自己写错了。
 * - 被压住的规则不能直接隐藏。隐藏等于让「我明明写过这条」变成一个无从查证的问题。
 *
 * 解析与优先级判定的权威实现在 `server/brandKit.mjs`；这里只做展示归类，
 * 不重新实现覆盖规则 —— 两份实现迟早会对不上，而对不上的表现是界面说生效、
 * 生成却没按它来。
 */

export const BRAND_FACET_ORDER = ['logo', 'color', 'typography', 'tone', 'photography', 'layout', 'prohibition'] as const

export type BrandFacet = typeof BRAND_FACET_ORDER[number]
export type BrandLayer = 'global' | 'project' | 'run'

/** 服务端解析后的规则：比 `BrandRule` 多出层级与覆盖关系。 */
export type ResolvedBrandRule = BrandRule & {
  layer: BrandLayer
  slot: string
  overrides?: Array<{ id: string; layer: BrandLayer }>
}

export type ResolvedBrandKit = {
  brandId: string
  rules: ResolvedBrandRule[]
  pending: ResolvedBrandRule[]
  overridden: ResolvedBrandRule[]
  fingerprint: string
}

const facetLabels: Record<BrandFacet, Record<ProductLocale, string>> = {
  logo: { 'zh-CN': 'Logo', en: 'Logo' },
  color: { 'zh-CN': '颜色', en: 'Color' },
  typography: { 'zh-CN': '字体', en: 'Typography' },
  tone: { 'zh-CN': '语气', en: 'Tone' },
  photography: { 'zh-CN': '摄影', en: 'Photography' },
  layout: { 'zh-CN': '版式', en: 'Layout' },
  prohibition: { 'zh-CN': '禁用', en: 'Prohibited' },
}

const layerLabels: Record<BrandLayer, Record<ProductLocale, string>> = {
  global: { 'zh-CN': '全局品牌', en: 'Global brand' },
  project: { 'zh-CN': '项目 Creative Spec', en: 'Project creative spec' },
  run: { 'zh-CN': '本次运行覆盖', en: 'This run’s override' },
}

export function brandFacetLabel(facet: string | undefined, locale: ProductLocale = 'zh-CN') {
  return facetLabels[facet as BrandFacet]?.[locale] ?? facet ?? ''
}

export function brandLayerLabel(layer: string | undefined, locale: ProductLocale = 'zh-CN') {
  return layerLabels[layer as BrandLayer]?.[locale] ?? layer ?? ''
}

export type BrandRuleRow = {
  id: string
  slot: string
  facet: string
  facetLabel: string
  statement: string
  layer: BrandLayer
  layerLabel: string
  /** `must` 与 `should` 的后果不同，必须在行上就能看出来。 */
  enforcement: 'must' | 'should'
  enforcementLabel: string
  /** 这条规则为什么是它生效；被压住时说明是谁压的。 */
  provenance: string
  effective: boolean
}

function enforcementLabel(enforcement: string | undefined, facet: string, locale: ProductLocale) {
  if (facet === 'prohibition') return locale === 'en' ? 'Never' : '绝不'
  return enforcement === 'should'
    ? (locale === 'en' ? 'Prefer' : '尽量')
    : (locale === 'en' ? 'Must' : '必须')
}

/**
 * 一条规则的来源说明。与服务端 `brandRuleProvenance` 同一口径。
 */
export function brandRuleProvenanceText(rule: ResolvedBrandRule, locale: ProductLocale = 'zh-CN') {
  const from = brandLayerLabel(rule.layer, locale)
  const overrides = rule.overrides ?? []
  if (!overrides.length) return locale === 'en' ? `From ${from}.` : `来自${from}。`
  const displaced = overrides.map((item) => brandLayerLabel(item.layer, locale)).join(locale === 'en' ? ', ' : '、')
  return locale === 'en'
    ? `From ${from}; takes priority over the ${displaced} rule in the same slot.`
    : `来自${from}，在同一槽位上优先于${displaced}的规则。`
}

function toRow(rule: ResolvedBrandRule, locale: ProductLocale, effective: boolean): BrandRuleRow {
  return {
    id: rule.id,
    slot: rule.slot,
    facet: rule.facet,
    facetLabel: brandFacetLabel(rule.facet, locale),
    statement: rule.statement,
    layer: rule.layer,
    layerLabel: brandLayerLabel(rule.layer, locale),
    enforcement: rule.facet === 'prohibition' ? 'must' : (rule.enforcement === 'should' ? 'should' : 'must'),
    enforcementLabel: enforcementLabel(rule.enforcement, rule.facet, locale),
    provenance: brandRuleProvenanceText(rule, locale),
    effective,
  }
}

/**
 * 生效规则，按维度声明顺序排列。
 *
 * 用固定的维度顺序而不是字母序：用户是按「Logo / 颜色 / 字体…」这个心智去找规则的，
 * 字母序在中英文下还会得到两种不同的排列。
 */
export function effectiveBrandRuleRows(kit: ResolvedBrandKit | undefined, locale: ProductLocale = 'zh-CN'): BrandRuleRow[] {
  return [...(kit?.rules ?? [])]
    .sort((left, right) => {
      const facetDelta = BRAND_FACET_ORDER.indexOf(left.facet as BrandFacet) - BRAND_FACET_ORDER.indexOf(right.facet as BrandFacet)
      return facetDelta || left.slot.localeCompare(right.slot)
    })
    .map((rule) => toRow(rule, locale, true))
}

/**
 * 被高层压住的规则。**不隐藏**：隐藏会让「我明明写过这条」无从查证。
 */
export function overriddenBrandRuleRows(kit: ResolvedBrandKit | undefined, locale: ProductLocale = 'zh-CN'): BrandRuleRow[] {
  const winnerBySlot = new Map((kit?.rules ?? []).map((rule) => [rule.slot, rule]))
  return (kit?.overridden ?? []).map((rule) => {
    const winner = winnerBySlot.get(rule.slot)
    return {
      ...toRow(rule, locale, false),
      provenance: winner
        ? (locale === 'en'
          ? `Defined in ${brandLayerLabel(rule.layer, locale)}, but the ${brandLayerLabel(winner.layer, locale)} rule takes effect in this slot.`
          : `写在${brandLayerLabel(rule.layer, locale)}，但该槽位当前生效的是${brandLayerLabel(winner.layer, locale)}的规则。`)
        : brandRuleProvenanceText(rule, locale),
    }
  })
}

export type BrandProposalRow = {
  id: string
  statement: string
  facet?: string
  facetLabel: string
  sourceRef?: string
  /** 维度判不出来时必须由人补上才能激活。 */
  needsFacet: boolean
  hint: string
}

/**
 * 待确认的建议。
 *
 * 每一条都要写明**它当前不生效**。解析出来的建议看起来和真规则一模一样，
 * 不写清楚，用户会以为导入品牌手册就等于品牌规则已经生效了。
 */
export function brandProposalRows(
  proposals: Array<ResolvedBrandRule & { needsFacet?: boolean }> | undefined,
  locale: ProductLocale = 'zh-CN',
): BrandProposalRow[] {
  return (proposals ?? []).map((proposal) => {
    const needsFacet = Boolean(proposal.needsFacet) || !proposal.facet
    return {
      id: proposal.id,
      statement: proposal.statement,
      ...(proposal.facet ? { facet: proposal.facet } : {}),
      facetLabel: proposal.facet ? brandFacetLabel(proposal.facet, locale) : (locale === 'en' ? 'Unclassified' : '待归类'),
      ...(proposal.sourceRef ? { sourceRef: proposal.sourceRef } : {}),
      needsFacet,
      hint: needsFacet
        ? (locale === 'en'
          ? 'Not in effect. Pick a brand facet, then confirm to activate.'
          : '当前不生效。先选定品牌维度，确认后才会生效。')
        : (locale === 'en' ? 'Not in effect until you confirm it.' : '当前不生效，确认后才会生效。'),
    }
  })
}

/**
 * 品牌规则摘要。**待确认数必须与生效数并列**，只报生效了几条会让人以为全都在管用。
 */
export function brandKitSummary(kit: ResolvedBrandKit | undefined, locale: ProductLocale = 'zh-CN') {
  const effective = kit?.rules?.length ?? 0
  const pendingCount = kit?.pending?.length ?? 0
  if (!effective && !pendingCount) {
    return locale === 'en' ? 'No brand rules apply to this project.' : '当前项目没有生效的品牌规则。'
  }
  const base = locale === 'en' ? `${effective} rule(s) in effect` : `${effective} 条规则生效中`
  if (!pendingCount) return locale === 'en' ? `${base}.` : `${base}。`
  return locale === 'en'
    ? `${base}; ${pendingCount} proposal(s) await confirmation and are not applied.`
    : `${base}；另有 ${pendingCount} 条建议待确认，尚未生效。`
}

/**
 * 把项目 Creative Spec 里的一条建议改为生效。
 *
 * 纯函数：返回新的 kit，不改原对象。**必须带确认人**——没有确认人的激活等于
 * 系统自己把手册解析结果当成了品牌规则，那正是 Epic 9.1 要禁止的事。
 */
export function confirmBrandProposal(
  kit: ProjectBrandKit,
  ruleId: string,
  { facet, confirmedBy, confirmedAt }: { facet?: BrandFacet; confirmedBy: string; confirmedAt: number },
): ProjectBrandKit {
  if (!confirmedBy) throw new Error('确认品牌规则必须记录确认人。')
  return {
    ...kit,
    rules: kit.rules.map((rule) => {
      if (rule.id !== ruleId) return rule
      const resolvedFacet = facet ?? rule.facet
      if (!resolvedFacet) throw new Error('确认品牌规则前必须选定品牌维度。')
      return { ...rule, facet: resolvedFacet, status: 'active', confirmedBy, confirmedAt }
    }),
    updatedAt: confirmedAt,
  }
}
