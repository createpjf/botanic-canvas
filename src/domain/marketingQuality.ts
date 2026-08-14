export type QualityCheckSeverity = 'blocking' | 'warning'

export type MarketingQualityCheck = {
  id: string
  label: string
  passed: boolean
  severity: QualityCheckSeverity
  reason: string
  locator?: string
}

export type MarketingQualityReport = {
  checks: MarketingQualityCheck[]
  blockingPassed: boolean
  requiresVisualReview: boolean
}

const prohibitedPattern = /(最好|第一|绝对|祖传|治愈)/

export function evaluateMarketingQuality(input: {
  copyText?: string
  brandRules?: string[]
  approvedClaims?: string[]
  prohibitedClaims?: string[]
  hasPrimaryPackaging?: boolean
  visualProviderAvailable?: boolean
} = {}): MarketingQualityReport {
  const copyText = input.copyText ?? ''
  const prohibited = (input.prohibitedClaims ?? []).filter((claim) => claim && copyText.includes(claim))
  const matchedPattern = prohibitedPattern.test(copyText)
  const copyCheck: MarketingQualityCheck = {
    id: 'copy-prohibited-claims',
    label: '禁用表达',
    passed: prohibited.length === 0 && !matchedPattern,
    severity: 'blocking',
    reason: prohibited.length || matchedPattern ? `命中禁用表达：${[...prohibited, matchedPattern ? '绝对化用语' : ''].filter(Boolean).join('、')}` : '未命中禁用表达',
    locator: 'copy',
  }
  const claimCheck: MarketingQualityCheck = {
    id: 'copy-claim-provenance',
    label: '主张溯源',
    passed: (input.approvedClaims ?? []).length > 0,
    severity: 'blocking',
    reason: (input.approvedClaims ?? []).length ? '文案绑定已批准主张' : '缺少已批准产品主张',
    locator: 'claim',
  }
  const ruleCheck: MarketingQualityCheck = {
    id: 'brand-rule-coverage',
    label: '品牌规则覆盖',
    passed: (input.brandRules ?? []).length > 0,
    severity: 'blocking',
    reason: (input.brandRules ?? []).length ? '已锁定品牌规则' : '尚未锁定品牌规则',
    locator: 'rules',
  }
  const packagingCheck: MarketingQualityCheck = {
    id: 'packaging-reference-primary',
    label: '主包装参考',
    passed: Boolean(input.hasPrimaryPackaging),
    severity: 'blocking',
    reason: input.hasPrimaryPackaging ? '已绑定主包装参考' : '缺少主包装参考',
    locator: 'packaging',
  }
  const visualCheck: MarketingQualityCheck = {
    id: 'visual-review-required',
    label: '视觉复核',
    passed: true,
    severity: 'warning',
    reason: input.visualProviderAvailable
      ? '可调用 Vision Provider 复核 Logo 与包装文字'
      : '视觉 Logo、包装文字与构图需人工或 Vision Provider 复核，字符串扫描不视为通过',
    locator: 'visual',
  }
  const checks = [copyCheck, claimCheck, ruleCheck, packagingCheck, visualCheck]
  return {
    checks,
    blockingPassed: checks.filter((check) => check.severity === 'blocking').every((check) => check.passed),
    requiresVisualReview: true,
  }
}
