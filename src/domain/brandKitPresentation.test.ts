import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BRAND_FACET_ORDER,
  brandKitSummary,
  brandProposalRows,
  brandRuleProvenanceText,
  confirmBrandProposal,
  effectiveBrandRuleRows,
  overriddenBrandRuleRows,
} from './brandKitPresentation.ts'
import type { ResolvedBrandKit, ResolvedBrandRule } from './brandKitPresentation.ts'

const resolved = (extra: Partial<ResolvedBrandRule>): ResolvedBrandRule => ({
  id: 'r', facet: 'color', slot: 'color.default', statement: '主色只用品牌绿',
  layer: 'global', status: 'active', ...extra,
})

const kit: ResolvedBrandKit = {
  brandId: 'botanic',
  fingerprint: 'fp',
  rules: [
    resolved({ id: 'g-layout', facet: 'layout', slot: 'layout.default', enforcement: 'should', statement: '顶部留 15% 安全区' }),
    resolved({ id: 'p-color', layer: 'project', overrides: [{ id: 'g-color', layer: 'global' }] }),
    resolved({ id: 'g-logo', facet: 'logo', slot: 'logo.default', statement: 'Logo 置于右下角' }),
    resolved({ id: 'g-ban', facet: 'prohibition', slot: 'prohibition.default', enforcement: 'should', statement: '不得出现竞品包装' }),
  ],
  pending: [
    resolved({ id: 'imp-1', facet: 'tone', slot: 'tone.default', status: 'proposed', statement: '语气克制', sourceRef: 'brandbook.pdf#p3' }),
    { ...resolved({ id: 'imp-2', slot: '', status: 'proposed', statement: '所有物料需三级复核' }), facet: undefined as never },
  ],
  overridden: [resolved({ id: 'g-color', statement: '主色只用品牌绿' })],
}

test('生效规则按维度声明顺序排列，不按字母序', () => {
  // 用户按「Logo / 颜色 / 字体…」的心智去找规则；字母序在中英文下还会给出两种排列。
  const rows = effectiveBrandRuleRows(kit)
  assert.deepEqual(rows.map((row) => row.facet), ['logo', 'color', 'layout', 'prohibition'])
  assert.deepEqual([...BRAND_FACET_ORDER].slice(0, 2), ['logo', 'color'])
})

test('每条生效规则说得出来自哪一层、压住了谁', () => {
  const rows = effectiveBrandRuleRows(kit)
  const color = rows.find((row) => row.id === 'p-color')!
  assert.equal(color.layerLabel, '项目 Creative Spec')
  assert.match(color.provenance, /来自项目 Creative Spec，在同一槽位上优先于全局品牌的规则。/u)
  assert.match(rows.find((row) => row.id === 'g-logo')!.provenance, /^来自全局品牌。$/u)
  assert.match(brandRuleProvenanceText(kit.rules[1], 'en'), /takes priority over the Global brand rule/u)
})

test('must / should / 禁用在行上就能区分', () => {
  const rows = effectiveBrandRuleRows(kit)
  assert.equal(rows.find((row) => row.id === 'g-logo')!.enforcementLabel, '必须')
  assert.equal(rows.find((row) => row.id === 'g-layout')!.enforcementLabel, '尽量')
  assert.equal(rows.find((row) => row.id === 'g-layout')!.enforcement, 'should')
  // 禁用规则即便被写成 should 也按硬约束展示，与服务端归一口径一致。
  assert.equal(rows.find((row) => row.id === 'g-ban')!.enforcementLabel, '绝不')
  assert.equal(rows.find((row) => row.id === 'g-ban')!.enforcement, 'must')
  assert.equal(effectiveBrandRuleRows(kit, 'en').find((row) => row.id === 'g-layout')!.enforcementLabel, 'Prefer')
})

test('被压住的规则不隐藏，并说明是谁压的', () => {
  // 隐藏会让「我明明写过这条」变成无从查证的问题。
  const rows = overriddenBrandRuleRows(kit)
  assert.deepEqual(rows.map((row) => row.id), ['g-color'])
  assert.equal(rows[0].effective, false)
  assert.match(rows[0].provenance, /写在全局品牌，但该槽位当前生效的是项目 Creative Spec的规则。/u)
  assert.match(overriddenBrandRuleRows(kit, 'en')[0].provenance, /Defined in Global brand.*Project creative spec rule takes effect/u)
})

test('待确认建议必须写明当前不生效，缺维度的另外提示', () => {
  const rows = brandProposalRows(kit.pending)
  assert.equal(rows[0].facetLabel, '语气')
  assert.equal(rows[0].needsFacet, false)
  assert.match(rows[0].hint, /当前不生效，确认后才会生效。/u)
  assert.equal(rows[0].sourceRef, 'brandbook.pdf#p3')
  // 判不出维度的要先选维度。
  assert.equal(rows[1].needsFacet, true)
  assert.equal(rows[1].facetLabel, '待归类')
  assert.match(rows[1].hint, /先选定品牌维度/u)
  assert.match(brandProposalRows(kit.pending, 'en')[1].hint, /Pick a brand facet/u)
})

test('摘要把待确认数与生效数并列', () => {
  // 只报生效了几条，用户会以为全都在管用。
  assert.equal(brandKitSummary(kit), '4 条规则生效中；另有 2 条建议待确认，尚未生效。')
  assert.equal(brandKitSummary({ ...kit, pending: [] }), '4 条规则生效中。')
  assert.equal(brandKitSummary(undefined), '当前项目没有生效的品牌规则。')
  assert.match(brandKitSummary(kit, 'en'), /2 proposal\(s\) await confirmation and are not applied/u)
})

test('确认建议必须记录确认人，缺维度时拒绝激活', () => {
  const projectKit = {
    brandId: 'botanic',
    rules: [
      { id: 'imp-1', facet: 'tone' as const, statement: '语气克制', status: 'proposed' as const, source: 'document_import' as const },
      { id: 'imp-2', statement: '所有物料需三级复核', status: 'proposed' as const, source: 'document_import' as const } as never,
    ],
  }
  const confirmed = confirmBrandProposal(projectKit, 'imp-1', { confirmedBy: 'user-1', confirmedAt: 9 })
  assert.equal(confirmed.rules[0].status, 'active')
  assert.equal(confirmed.rules[0].confirmedBy, 'user-1')
  assert.equal(confirmed.updatedAt, 9)
  // 原对象不被改动。
  assert.equal(projectKit.rules[0].status, 'proposed')

  // 没有确认人的激活等于系统自己把手册解析结果当成了品牌规则。
  assert.throws(() => confirmBrandProposal(projectKit, 'imp-1', { confirmedBy: '', confirmedAt: 9 }), /确认人/u)
  assert.throws(() => confirmBrandProposal(projectKit, 'imp-2', { confirmedBy: 'user-1', confirmedAt: 9 }), /品牌维度/u)
  // 补上维度就能确认。
  assert.equal(
    confirmBrandProposal(projectKit, 'imp-2', { facet: 'layout', confirmedBy: 'user-1', confirmedAt: 9 }).rules[1].facet,
    'layout',
  )
})

test('空集合不炸', () => {
  assert.deepEqual(effectiveBrandRuleRows(undefined), [])
  assert.deepEqual(overriddenBrandRuleRows(undefined), [])
  assert.deepEqual(brandProposalRows(undefined), [])
})
