import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateMarketingQuality } from './marketingQuality.ts'

test('质量门禁阻断禁用表达、未批准主张和缺失包装，视觉检查不伪造通过', () => {
  const failed = evaluateMarketingQuality({
    copyText: '绝对第一冰茶',
    brandRules: [],
    approvedClaims: [],
    hasPrimaryPackaging: false,
  })
  assert.equal(failed.blockingPassed, false)
  assert.equal(failed.requiresVisualReview, true)
  assert.equal(failed.checks.find((check) => check.id === 'visual-review-required')?.passed, true)
  assert.equal(failed.checks.find((check) => check.id === 'visual-review-required')?.severity, 'warning')

  const passed = evaluateMarketingQuality({
    copyText: '夏日冰茶清爽解渴',
    brandRules: ['不得改变包装文字'],
    approvedClaims: ['清爽解渴'],
    hasPrimaryPackaging: true,
  })
  assert.equal(passed.blockingPassed, true)
})
