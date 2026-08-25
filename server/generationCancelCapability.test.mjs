import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PROVIDER_CANCEL_CAPABILITIES,
  generationCancelOutcome,
  providerCancelCapability,
} from './generationCancelCapability.mjs'

test('当前没有任何 Provider 支持提交后停止计费', () => {
  // 这条断言就是那张矩阵的意义所在。哪天有 Provider 真支持远端取消，
  // 它会失败并迫使改动者同步更新界面文案，而不是让文案继续沿用旧承诺。
  assert.deepEqual(Object.values(PROVIDER_CANCEL_CAPABILITIES), ['local-abort-only', 'local-abort-only'])
  assert.equal(Object.keys(PROVIDER_CANCEL_CAPABILITIES).sort().join(','), 'minimax,openai')
})

test('未知 Provider 按最保守处理，不得声称能停止计费', () => {
  assert.equal(providerCancelCapability('some-new-provider'), 'local-abort-only')
  assert.equal(providerCancelCapability(undefined), 'local-abort-only')
})

test('未派发就取消是唯一真能省下费用的路径', () => {
  assert.deepEqual(generationCancelOutcome({ status: 'queued', provider: 'openai' }), {
    billing: 'none', capability: 'local-abort-only', workerReleased: false, code: 'CANCELLED_BEFORE_DISPATCH',
  })
})

test('已在执行的任务只能停止采用结果，费用可能已产生', () => {
  const outcome = generationCancelOutcome({ status: 'running', provider: 'minimax' })
  assert.equal(outcome.billing, 'possible', '不得暗示取消省下了费用')
  assert.equal(outcome.code, 'CANCELLED_RESULT_DISCARDED')
  // 释放 worker 槽位是真实收益，视频轮询是分钟级，这一项价值最大。
  assert.equal(outcome.workerReleased, true)
})

test('若某 Provider 支持远端取消，执行中取消才算不计费', () => {
  // 直接传入 capability 走 remote-cancel 分支，保证它不是未测死代码 ——
  // 将来某个 Provider 支持远端取消时，这条路径的语义已经被锁住。
  assert.deepEqual(generationCancelOutcome({ status: 'running', capability: 'remote-cancel' }), {
    billing: 'none', capability: 'remote-cancel', workerReleased: true, code: 'CANCELLED_AT_PROVIDER',
  })
  // 显式传入优先于按 Provider 查表。
  assert.equal(
    generationCancelOutcome({ status: 'running', provider: 'openai', capability: 'remote-cancel' }).billing,
    'none',
  )
})

test('已终态任务的取消是无操作，不产生新的计费判断', () => {
  for (const status of ['succeeded', 'failed', 'cancelled', undefined]) {
    const outcome = generationCancelOutcome({ status, provider: 'openai' })
    assert.equal(outcome.code, 'ALREADY_SETTLED', `${String(status)} 应视为已结算`)
    assert.equal(outcome.billing, 'none')
    assert.equal(outcome.workerReleased, false)
  }
})
