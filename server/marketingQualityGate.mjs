function clone(value) {
  return structuredClone(value)
}

const prohibitedPattern = /(最好|第一|绝对|祖传|治愈)/

export function evaluateMarketingQuality({
  copyText = '',
  brandRules = [],
  approvedClaims = [],
  prohibitedClaims = [],
  hasPrimaryPackaging = false,
  visualProviderAvailable = false,
} = {}) {
  const prohibited = prohibitedClaims.filter((claim) => claim && copyText.includes(claim))
  const matchedPattern = prohibitedPattern.test(copyText)
  const checks = [
    {
      id: 'copy-prohibited-claims',
      label: '禁用表达',
      passed: prohibited.length === 0 && !matchedPattern,
      severity: 'blocking',
      reason: prohibited.length || matchedPattern
        ? `命中禁用表达：${[...prohibited, matchedPattern ? '绝对化用语' : ''].filter(Boolean).join('、')}`
        : '未命中禁用表达',
      locator: 'copy',
    },
    {
      id: 'copy-claim-provenance',
      label: '主张溯源',
      passed: approvedClaims.length > 0,
      severity: 'blocking',
      reason: approvedClaims.length ? '文案绑定已批准主张' : '缺少已批准产品主张',
      locator: 'claim',
    },
    {
      id: 'brand-rule-coverage',
      label: '品牌规则覆盖',
      passed: brandRules.length > 0,
      severity: 'blocking',
      reason: brandRules.length ? '已锁定品牌规则' : '尚未锁定品牌规则',
      locator: 'rules',
    },
    {
      id: 'packaging-reference-primary',
      label: '主包装参考',
      passed: Boolean(hasPrimaryPackaging),
      severity: 'blocking',
      reason: hasPrimaryPackaging ? '已绑定主包装参考' : '缺少主包装参考',
      locator: 'packaging',
    },
    {
      id: 'visual-review-required',
      label: '视觉复核',
      passed: true,
      severity: 'warning',
      reason: visualProviderAvailable
        ? '可调用 Vision Provider 复核 Logo 与包装文字'
        : '视觉 Logo、包装文字与构图需人工或 Vision Provider 复核，字符串扫描不视为通过',
      locator: 'visual',
    },
  ]
  return {
    checks,
    blockingPassed: checks.filter((check) => check.severity === 'blocking').every((check) => check.passed),
    requiresVisualReview: true,
  }
}

export function qualityFromWorkflow(run, document = {}) {
  const definition = run?.definition ?? {}
  const recipe = definition.recipe ?? {}
  const copyText = run.items?.[0]?.input?.copyText ?? definition.prompt ?? ''
  const approvedFromMemory = Array.isArray(document.agentMemory)
    ? document.agentMemory.filter((item) => item.kind === 'approved').map((item) => item.content)
    : []
  return evaluateMarketingQuality({
    copyText,
    brandRules: definition.brandRules ?? [],
    approvedClaims: approvedFromMemory.length ? approvedFromMemory : (definition.brandRules ?? []),
    hasPrimaryPackaging: Array.isArray(recipe.references) && recipe.references.some((reference) => reference.primary),
  })
}
