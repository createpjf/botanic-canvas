import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateMarketingQuality, qualityFromWorkflow } from './marketingQualityGate.mjs'

test('视觉检查保持 warning，不把缺少 Vision Provider 伪造为通过阻断', () => {
  const report = evaluateMarketingQuality({
    copyText: '夏日冰茶',
    brandRules: ['保持包装'],
    approvedClaims: ['清爽'],
    hasPrimaryPackaging: true,
  })
  assert.equal(report.blockingPassed, true)
  assert.equal(report.requiresVisualReview, true)
  assert.equal(report.checks.find((check) => check.id === 'visual-review-required')?.severity, 'warning')
})

test('质量门禁用工作流品牌规则快照，不把规则写入 Agent Memory', () => {
  const report = qualityFromWorkflow({
    definition: {
      prompt: '夏日冰茶',
      brandRules: ['保持包装'],
      recipe: { references: [{ primary: true }] },
    },
    items: [{ input: { copyText: '夏日冰茶' } }],
  }, { agentMemory: [{ kind: 'rule', content: '保持植物学留白' }] })
  assert.equal(report.blockingPassed, true)
  assert.deepEqual(report.checks.find((check) => check.id === 'copy-claim-provenance')?.passed, true)
})
