import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAMPAIGN_MATRIX_AXES,
  campaignMatrixAxes,
  campaignMatrixFieldsAreValid,
  campaignMatrixSize,
  campaignMatrixSummary,
  expandCampaignMatrix,
} from './campaignMatrix.ts'

test('矩阵轴是服务端批量字段的子集', () => {
  // 不一致会让「校验通过」变得不可信。
  assert.deepEqual([...CAMPAIGN_MATRIX_AXES], ['sku', 'channel', 'language', 'aspectRatio', 'copy'])
  assert.equal(campaignMatrixFieldsAreValid(), true)
})

test('张数在展开前就能算出来', () => {
  // 展开后再显示总数已经晚了一步：每一项都是一次真实的模型调用。
  const input = { sku: ['A', 'B', 'C'], channel: ['tmall', 'jd'], language: ['zh', 'en'] }
  assert.equal(campaignMatrixSize(input), 12)
  assert.equal(campaignMatrixSize({}), 0)
  assert.equal(campaignMatrixSize(undefined), 0)
})

test('按轴相乘展开，空轴不参与也不把结果变成 0 项', () => {
  const result = expandCampaignMatrix({ sku: ['A', 'B'], channel: ['tmall'], language: [] })
  assert.equal(result.items.length, 2)
  assert.deepEqual(result.axes.map((entry) => entry.axis), ['sku', 'channel'])
  assert.deepEqual(result.items, [
    { sku: 'A', channel: 'tmall' },
    { sku: 'B', channel: 'tmall' },
  ])
})

test('共享 Reference Pack 与品牌上下文对每一项都一样', () => {
  // 逐项让用户各填一次，迟早会出现某一项用了不同参考 —— 那正是跨输出一致性最常见的破法。
  const result = expandCampaignMatrix({
    sku: ['A', 'B'],
    shared: { assetGroupId: 'group-1', variables: { 产品名: '香水' } },
  })
  assert.ok(result.items.every((item) => item.assetGroupId === 'group-1'))
  assert.ok(result.items.every((item) => item.variables?.产品名 === '香水'))
  // 变量对象不共享同一引用，改一项不会牵动其他项。
  result.items[0].variables!.产品名 = '改了'
  assert.equal(result.items[1].variables?.产品名, '香水')
})

test('超过上限时拒绝并说明，不截断', () => {
  // 截断会让用户以为整批都提交了，缺的那部分要到交付时才被发现。
  const result = expandCampaignMatrix({
    sku: ['a', 'b', 'c', 'd', 'e'], channel: ['1', '2', '3', '4', '5'],
    language: ['x', 'y', 'z', 'w', 'v'], aspectRatio: ['1:1', '3:4', '9:16', '16:9', '4:3'],
  })
  assert.deepEqual(result.items, [])
  assert.equal(result.size, 625)
  assert.equal(result.problems[0].code, 'too_large')
  assert.match(result.problems[0].detail, /5 × 5 × 5 × 5 = 625 项，超过上限 200/u)
  assert.match(campaignMatrixSummary(result), /超过上限 200/u)
})

test('重复取值去重但报告出来', () => {
  // 同一组合出现两次时业务标识相同，之后「只重试失败的 2 项」会对不上号。
  const result = expandCampaignMatrix({ sku: ['A', 'A', 'B'] })
  assert.equal(result.items.length, 2)
  assert.equal(result.problems[0].code, 'axis_duplicate')
  assert.equal(result.problems[0].axis, 'sku')
})

test('一个轴都没有时明确报错', () => {
  const result = expandCampaignMatrix({})
  assert.deepEqual(result.items, [])
  assert.equal(result.problems[0].code, 'no_axis')
  assert.match(campaignMatrixSummary(result), /至少要有一个轴/u)
})

test('摘要说清张数是怎么乘出来的', () => {
  const result = expandCampaignMatrix({ sku: ['A', 'B', 'C'], channel: ['tmall', 'jd'] })
  assert.equal(campaignMatrixSummary(result), 'sku 3 × channel 2 = 6 项，每项都是一次独立生成。')
  assert.match(campaignMatrixSummary(result, 'en'), /sku 3 x channel 2 = 6 item\(s\), each a separate generation\./u)
})

test('空输入不炸', () => {
  assert.deepEqual(expandCampaignMatrix(undefined).items, [])
  assert.deepEqual(campaignMatrixAxes(undefined), [])
})
