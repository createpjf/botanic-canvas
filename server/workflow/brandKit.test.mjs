import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BRAND_KIT_FACETS,
  BRAND_KIT_LAYERS,
  BRAND_RULE_STATUSES,
  BrandKitError,
  brandConstraintLines,
  brandKitFingerprint,
  brandQualityVerdict,
  brandReviewCriteria,
  brandRuleProvenance,
  normalizeBrandKit,
  proposeBrandRulesFromDocument,
  resolveBrandKit,
} from './brandKit.mjs'

const rule = (extra) => ({ id: 'r', facet: 'color', statement: '主色只用品牌绿', ...extra })

const globalKit = {
  brandId: 'botanic',
  name: 'Botanic',
  rules: [
    rule({ id: 'g-color', statement: '主色只用品牌绿 #1F5C3A' }),
    rule({ id: 'g-logo', facet: 'logo', statement: 'Logo 置于右下角，四周留出等于 Logo 高度的净空' }),
    rule({ id: 'g-ban', facet: 'prohibition', statement: '画面中不得出现竞品包装' }),
    rule({ id: 'g-layout', facet: 'layout', enforcement: 'should', statement: '顶部留出 15% 文案安全区' }),
  ],
}

test('声明词表与层级优先级顺序被锁定', () => {
  assert.deepEqual([...BRAND_KIT_FACETS], ['logo', 'color', 'typography', 'tone', 'photography', 'layout', 'prohibition'])
  // 顺序即优先级。写反会让全局品牌压住单次覆盖，而且不会有任何报错。
  assert.deepEqual([...BRAND_KIT_LAYERS], ['global', 'project', 'run'])
  assert.deepEqual([...BRAND_RULE_STATUSES], ['proposed', 'active', 'retired'])
})

test('三层按就近覆盖，且每条规则能说出自己从哪来、压住了谁', () => {
  const resolved = resolveBrandKit({
    brandId: 'botanic',
    global: globalKit,
    project: { brandId: 'botanic', rules: [rule({ id: 'p-color', statement: '本项目主色改用品牌深绿 #0E3B24' })] },
    run: { rules: [rule({ id: 'r-layout', facet: 'layout', statement: '本次顶部留出 25% 安全区' })] },
  })
  const bySlot = new Map(resolved.rules.map((item) => [item.slot, item]))
  assert.equal(bySlot.get('color.default').id, 'p-color')
  assert.equal(bySlot.get('color.default').layer, 'project')
  assert.deepEqual(bySlot.get('color.default').overrides, [{ id: 'g-color', layer: 'global' }])
  assert.equal(bySlot.get('layout.default').id, 'r-layout')
  // 没有被覆盖的槽位原样保留全局那条。
  assert.equal(bySlot.get('logo.default').id, 'g-logo')

  assert.match(brandRuleProvenance(bySlot.get('p-color') ?? bySlot.get('color.default')), /项目 Creative Spec.*优先于.*全局品牌/u)
  assert.match(brandRuleProvenance(bySlot.get('logo.default')), /^来自全局品牌。$/u)
  assert.match(brandRuleProvenance(bySlot.get('color.default'), 'en'), /project.*takes priority over.*global/u)
})

test('被压住的规则单独列出来，用户才知道它为什么没生效', () => {
  const resolved = resolveBrandKit({
    brandId: 'botanic',
    global: globalKit,
    project: { brandId: 'botanic', rules: [rule({ id: 'p-color', statement: '改用深绿' })] },
  })
  assert.deepEqual(resolved.overridden.map((item) => item.id), ['g-color'])
})

test('高层显式停用同一槽位会一并取消低层那条', () => {
  // 否则「这次不要这条规则」做不到，只能反向再写一条去抵消。
  const resolved = resolveBrandKit({
    brandId: 'botanic',
    global: globalKit,
    run: { rules: [rule({ id: 'r-off', facet: 'prohibition', status: 'retired', statement: '本次允许出现竞品包装作对比' })] },
  })
  assert.equal(resolved.rules.some((item) => item.slot === 'prohibition.default'), false)
})

test('多品牌隔离：绑错品牌直接报错，不静默按空品牌生成', () => {
  // 过滤掉等于让绑错品牌的项目静默按空品牌生成，用户会以为品牌规则生效了。
  assert.throws(() => resolveBrandKit({
    brandId: 'botanic',
    global: globalKit,
    project: { brandId: 'other-brand', rules: [rule({ id: 'x' })] },
  }), (error) => error instanceof BrandKitError && error.code === 'BRAND_KIT_BRAND_MISMATCH')
  // 另一个品牌的全局套件也拿不到 botanic 的规则。
  assert.throws(() => resolveBrandKit({ brandId: 'other-brand', global: globalKit }), /BRAND_KIT_BRAND_MISMATCH|不符/u)
})

test('Run 层覆盖不必自报品牌身份，自报了就要一致', () => {
  assert.equal(resolveBrandKit({
    brandId: 'botanic', global: globalKit, run: { rules: [rule({ id: 'r1', statement: '临时改色' })] },
  }).rules.find((item) => item.slot === 'color.default').id, 'r1')
  assert.throws(() => resolveBrandKit({
    brandId: 'botanic', global: globalKit, run: { brandId: 'other', rules: [rule({ id: 'r1' })] },
  }), (error) => error instanceof BrandKitError && error.code === 'BRAND_KIT_BRAND_MISMATCH')
})

test('待确认的建议不进入生效集，但必须能被看见', () => {
  const resolved = resolveBrandKit({
    brandId: 'botanic',
    project: {
      brandId: 'botanic',
      rules: [
        rule({ id: 'p-1', facet: 'tone', status: 'proposed', source: 'document_import', statement: '文案语气克制，不用感叹号' }),
        rule({ id: 'p-2', facet: 'tone', key: 'formal', statement: '正式场景用完整句式' }),
      ],
    },
  })
  assert.deepEqual(resolved.rules.map((item) => item.id), ['p-2'])
  assert.deepEqual(resolved.pending.map((item) => item.id), ['p-1'])
})

test('手册解析出来的规则不能直接激活', () => {
  // 靠调用方自觉早晚有一条路径会绕过；这里由数据层拒绝。
  assert.throws(() => normalizeBrandKit({
    brandId: 'botanic',
    rules: [rule({ id: 'i-1', status: 'active', source: 'document_import' })],
  }), (error) => error instanceof BrandKitError && error.code === 'BRAND_RULE_CONFIRMATION_REQUIRED')
  // 人确认过就可以。
  assert.equal(normalizeBrandKit({
    brandId: 'botanic',
    rules: [rule({ id: 'i-1', status: 'active', source: 'document_import', confirmedBy: 'user-1', confirmedAt: 5 })],
  }).rules[0].confirmedBy, 'user-1')
})

test('同层同槽位重复报错，不静默保留其一', () => {
  assert.throws(() => normalizeBrandKit({
    brandId: 'botanic',
    rules: [rule({ id: 'a' }), rule({ id: 'b', statement: '主色改用蓝' })],
  }), (error) => error instanceof BrandKitError && error.code === 'BRAND_RULE_SLOT_DUPLICATE')
  // 给了不同槽位名就并存。
  assert.equal(normalizeBrandKit({
    brandId: 'botanic',
    rules: [rule({ id: 'a', key: 'primary' }), rule({ id: 'b', key: 'background', statement: '背景用米白' })],
  }).rules.length, 2)
})

test('禁用规则一律是硬约束', () => {
  // 允许它是 should 等于允许「建议不要出现竞品 Logo」，那不是禁用规则。
  const [prohibition] = normalizeBrandKit({
    brandId: 'botanic',
    rules: [rule({ id: 'x', facet: 'prohibition', enforcement: 'should', statement: '不得出现竞品' })],
  }).rules
  assert.equal(prohibition.enforcement, 'must')
})

test('缺品牌标识或缺维度都拒绝', () => {
  assert.throws(() => normalizeBrandKit({ rules: [] }), /BRAND_FIELD_MISSING|品牌标识/u)
  assert.throws(() => normalizeBrandKit({ brandId: 'botanic', rules: [{ id: 'x', statement: '某条规则' }] }),
    (error) => error instanceof BrandKitError && error.code === 'BRAND_RULE_FACET_REQUIRED')
})

test('契约行区分 must / should / 禁用，且不拼进画面描述', () => {
  const lines = brandConstraintLines(resolveBrandKit({ brandId: 'botanic', global: globalKit }))
  assert.equal(lines[0], '必须遵守的品牌规则：')
  assert.ok(lines.some((line) => line.startsWith('- 【颜色】必须：')))
  assert.ok(lines.some((line) => line.startsWith('- 【版式】尽量：')))
  assert.ok(lines.some((line) => line.startsWith('- 【禁用】绝不：')))
  const en = brandConstraintLines(resolveBrandKit({ brandId: 'botanic', global: globalKit }), 'en')
  assert.equal(en[0], 'Brand rules that must hold:')
  assert.ok(en.some((line) => line.startsWith('- [Prohibited] Never:')))
  assert.deepEqual(brandConstraintLines({ rules: [] }), [])
})

test('QA 判据以槽位为关联键，规则换 id 不会让历史评审对不上', () => {
  const criteria = brandReviewCriteria(resolveBrandKit({ brandId: 'botanic', global: globalKit }))
  assert.deepEqual(criteria.map((item) => item.id).sort(), [
    'brand.color.default', 'brand.layout.default', 'brand.logo.default', 'brand.prohibition.default',
  ])
  assert.equal(criteria.find((item) => item.id === 'brand.color.default').statement, '主色只用品牌绿 #1F5C3A')
  assert.equal(criteria.find((item) => item.id === 'brand.color.default').ruleId, 'g-color')
})

test('must 不满足才判不合格，should 不满足只记让步', () => {
  const declared = brandReviewCriteria(resolveBrandKit({ brandId: 'botanic', global: globalKit }))
  const verdicts = (overrides) => declared.map((item) => ({ id: item.id, verdict: overrides[item.id] ?? 'pass' }))

  assert.equal(brandQualityVerdict(verdicts({}), declared).verdict, 'pass')

  const conceded = brandQualityVerdict(verdicts({ 'brand.layout.default': 'fail' }), declared)
  assert.equal(conceded.verdict, 'pass')
  assert.deepEqual(conceded.concessions.map((item) => item.id), ['brand.layout.default'])

  const violated = brandQualityVerdict(verdicts({ 'brand.prohibition.default': 'fail' }), declared)
  assert.equal(violated.verdict, 'fail')
  assert.deepEqual(violated.violations.map((item) => item.id), ['brand.prohibition.default'])

  // 没看出来不算通过。
  assert.equal(brandQualityVerdict(verdicts({ 'brand.color.default': 'unverifiable' }), declared).verdict, 'unverifiable')
  // 一条判据都没有时诚实地说无法验证，而不是「全通过」。
  assert.equal(brandQualityVerdict([], []).verdict, 'unverifiable')
})

test('指纹只随生效规则变化', () => {
  const base = resolveBrandKit({ brandId: 'botanic', global: globalKit })
  const withProposal = resolveBrandKit({
    brandId: 'botanic',
    global: { ...globalKit, rules: [...globalKit.rules, rule({ id: 'g-new', facet: 'tone', status: 'proposed', statement: '语气克制' })] },
  })
  // 待确认的建议不进入执行，因此不该改变指纹。
  assert.equal(base.fingerprint, withProposal.fingerprint)
  const overridden = resolveBrandKit({
    brandId: 'botanic', global: globalKit,
    project: { brandId: 'botanic', rules: [rule({ id: 'p-color', statement: '改用深绿' })] },
  })
  assert.notEqual(base.fingerprint, overridden.fingerprint)
  // 规则换个 id 但内容不变时执行语义没变，指纹也不该变。
  assert.equal(brandKitFingerprint(base.rules), brandKitFingerprint(base.rules.map((item) => ({ ...item, id: `${item.id}-v2` }))))
})

test('手册解析只产建议，判不出维度的不猜', () => {
  const result = proposeBrandRulesFromDocument([
    '品牌视觉规范',
    '1. 主色只用品牌绿 #1F5C3A，辅色用米白。',
    '- 禁止在画面中出现竞品包装。',
    '2) 摄影统一使用自然侧光，避免硬阴影。',
    '所有对外物料需在发布前完成三级复核。',
  ].join('\n'), { sourceRef: 'brandbook.pdf#p12' })

  assert.ok(result.proposals.every((item) => item.status === 'proposed' && item.source === 'document_import'))
  assert.ok(result.proposals.every((item) => item.sourceRef === 'brandbook.pdf#p12'))
  const byFacet = new Map(result.proposals.map((item) => [item.facet, item]))
  assert.ok(byFacet.has('color'))
  assert.ok(byFacet.has('prohibition'))
  assert.ok(byFacet.has('photography'))
  assert.equal(byFacet.get('prohibition').enforcement, 'must')

  // 判不出维度的留空并标记；猜一个会让它悄悄按错误的方式编译。
  const unclassified = result.proposals.filter((item) => item.needsFacet)
  assert.ok(unclassified.every((item) => item.facet === undefined))
  // 标题行「品牌视觉规范」也会被当成待定建议留下来。启发式分不清标题与规则，
  // 而两种错的代价不对称：多留一条标题用户确认时一眼删掉，漏掉一条真规则没人会发现。
  assert.deepEqual(unclassified.map((item) => item.statement), ['品牌视觉规范', '所有对外物料需在发布前完成三级复核。'])
  assert.equal(result.unclassified, 2)
  // 留空维度的建议无法通过校验，因此必须由人补齐才能生效。
  assert.throws(() => normalizeBrandKit({ brandId: 'botanic', rules: [{ ...unclassified[0], status: 'active', confirmedBy: 'u' }] }),
    (error) => error instanceof BrandKitError && error.code === 'BRAND_RULE_FACET_REQUIRED')
})

test('空输入与超限都不炸', () => {
  assert.deepEqual(proposeBrandRulesFromDocument('').proposals, [])
  assert.deepEqual(proposeBrandRulesFromDocument(undefined).proposals, [])
  const many = Array.from({ length: 80 }, (_, index) => `主色规则第 ${index} 条必须遵守`).join('\n')
  const limited = proposeBrandRulesFromDocument(many, { limit: 10 })
  assert.equal(limited.proposals.length, 10)
  assert.equal(limited.truncated, true)
  const empty = resolveBrandKit({ brandId: 'botanic' })
  assert.deepEqual(empty.rules, [])
  assert.deepEqual(brandReviewCriteria(empty), [])
})
