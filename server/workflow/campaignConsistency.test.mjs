import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAMPAIGN_CONSISTENCY_DIMENSIONS,
  campaignConsistencySummary,
  checkCampaignConsistency,
} from './campaignConsistency.mjs'

const output = (extra) => ({
  artifactId: 'a-1',
  planFingerprint: 'plan-1',
  brandKitFingerprint: 'brand-1',
  settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
  recipe: { references: [{ assetId: 'asset-1' }, { assetId: 'asset-2' }] },
  ...extra,
})

test('声明维度词表被锁定', () => {
  assert.deepEqual([...CAMPAIGN_CONSISTENCY_DIMENSIONS], [
    'reference_pack', 'brand_kit', 'plan', 'model', 'aspect_ratio', 'resolution',
  ])
})

test('同一批参考、品牌与计划判为一套', () => {
  const result = checkCampaignConsistency({
    outputs: [output({ artifactId: 'a-1' }), output({ artifactId: 'a-2' })],
  })
  assert.equal(result.verdict, 'pass')
  assert.ok(result.checks.every((check) => check.verdict === 'pass'))
})

test('参考素材的书写顺序不同不算不一致', () => {
  // 顺序不同不代表用的不是同一批素材。
  const result = checkCampaignConsistency({
    outputs: [
      output({ artifactId: 'a-1', recipe: { references: [{ assetId: 'asset-2' }, { assetId: 'asset-1' }] } }),
      output({ artifactId: 'a-2' }),
    ],
  })
  assert.equal(result.checks.find((check) => check.dimension === 'reference_pack').verdict, 'pass')
})

test('参考素材不同判不一致，并指出是哪几个输出', () => {
  // 只说「不一致」，用户不知道该去看哪一张。
  const result = checkCampaignConsistency({
    outputs: [
      output({ artifactId: 'a-1' }),
      output({ artifactId: 'a-2', recipe: { references: [{ assetId: 'asset-9' }] } }),
      output({ artifactId: 'a-3', recipe: { references: [{ assetId: 'asset-9' }] } }),
    ],
  })
  assert.equal(result.verdict, 'fail')
  assert.equal(result.groups.reference_pack.length, 2)
  assert.deepEqual(result.groups.reference_pack.find((group) => group.value === 'asset-9').artifactIds, ['a-2', 'a-3'])
})

test('品牌规则不同判不一致', () => {
  const result = checkCampaignConsistency({
    outputs: [output({ artifactId: 'a-1' }), output({ artifactId: 'a-2', brandKitFingerprint: 'brand-9' })],
  })
  assert.equal(result.checks.find((check) => check.dimension === 'brand_kit').verdict, 'fail')
})

test('比例与分辨率默认不参与判定', () => {
  // Campaign 的本意就是按渠道/比例分发；默认判成不一致会让 Gate 对每个正常
  // Campaign 都报警，然后没人再看它。
  const result = checkCampaignConsistency({
    outputs: [
      output({ artifactId: 'a-1' }),
      output({ artifactId: 'a-2', settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' } }),
    ],
  })
  assert.equal(result.verdict, 'pass')
  assert.equal(result.checks.some((check) => check.dimension === 'aspect_ratio'), false)
  // 显式要求时才查。
  const strict = checkCampaignConsistency({
    outputs: [
      output({ artifactId: 'a-1' }),
      output({ artifactId: 'a-2', settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' } }),
    ],
    requireDimensions: ['aspect_ratio'],
  })
  assert.equal(strict.verdict, 'fail')
})

test('缺记录判无法验证，不是默认通过', () => {
  // 默认通过会让「没记录」看起来像「一致」。
  const result = checkCampaignConsistency({
    outputs: [output({ artifactId: 'a-1' }), output({ artifactId: 'a-2', brandKitFingerprint: undefined })],
  })
  assert.equal(result.verdict, 'unverifiable')
  const check = result.checks.find((entry) => entry.dimension === 'brand_kit')
  assert.equal(check.verdict, 'unverifiable')
  assert.match(check.evidence, /1 个输出没有记录品牌规则/u)
})

test('不一致优先于无法验证', () => {
  const result = checkCampaignConsistency({
    outputs: [
      output({ artifactId: 'a-1' }),
      output({ artifactId: 'a-2', planFingerprint: 'plan-9', brandKitFingerprint: undefined }),
    ],
  })
  assert.equal(result.verdict, 'fail')
})

test('少于两个输出说无法验证，不说通过', () => {
  // 说成通过会让「只生成了一张」看起来像「一整套都对齐了」。
  assert.equal(checkCampaignConsistency({ outputs: [output({})] }).verdict, 'unverifiable')
  assert.equal(checkCampaignConsistency({ outputs: [] }).verdict, 'unverifiable')
})

test('摘要把「不一致」与「无法验证」分开说', () => {
  const mixed = checkCampaignConsistency({
    outputs: [
      output({ artifactId: 'a-1' }),
      output({ artifactId: 'a-2', planFingerprint: 'plan-9', brandKitFingerprint: undefined }),
    ],
  })
  const summary = campaignConsistencySummary(mixed)
  assert.match(summary, /1 项不一致：计划/u)
  assert.match(summary, /无法验证（没有记录），这与「一致」不是一回事/u)
  assert.match(campaignConsistencySummary(checkCampaignConsistency({
    outputs: [output({ artifactId: 'a-1' }), output({ artifactId: 'a-2' })],
  })), /共享同一批参考、同一套品牌规则与同一份计划/u)
  assert.match(campaignConsistencySummary(mixed, 'en'), /could not be verified \(not recorded\), which is not the same as consistent/u)
})
