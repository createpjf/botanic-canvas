import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BRANCH_RETRY_ACTIONS,
  DEFAULT_BRANCH_RETRY_POLICY,
  RETRYABLE_ERROR_CODES,
  branchesEligibleForRetry,
  decideBranchRetry,
} from './agentBranchRetryPolicy.mjs'

const branch = (extra = {}) => ({ id: 'branch-a', status: 'failed', attempt: 0, activeJobId: 'job-a', ...extra })
const job = (extra = {}) => ({ id: 'job-a', batchCount: 2, errorCode: 'PROVIDER_TIMEOUT', rawInput: {}, updatedAt: 0, ...extra })

test('瞬时故障的首次失败可以自动重试', () => {
  const outcome = decideBranchRetry({ branch: branch(), job: job(), now: 1_000_000 })
  assert.equal(outcome.action, 'retry')
  assert.equal(outcome.reason, 'transient_failure')
})

test('未知错误码按不可重试处理', () => {
  // 白名单而不是黑名单：把未知当可重试，等于让一类还不理解的失败自动消耗预算。
  assert.equal(decideBranchRetry({ branch: branch(), job: job({ errorCode: 'SOMETHING_NEW' }), now: 1e6 }).reason, 'error_not_retryable')
  assert.equal(decideBranchRetry({ branch: branch(), job: job({ errorCode: undefined }), now: 1e6 }).reason, 'error_code_unknown')
  assert.deepEqual([...RETRYABLE_ERROR_CODES], [
    'PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE', 'PROVIDER_CIRCUIT_OPEN',
    'QUEUE_UNAVAILABLE', 'REQUEST_TIMEOUT', 'GENERATION_FAILED',
  ])
})

test('只自动重试一次：连续失败两次通常不是抖动', () => {
  assert.equal(decideBranchRetry({ branch: branch({ attempt: 1 }), job: job(), now: 1e6 }).reason, 'attempt_limit_reached')
  assert.equal(DEFAULT_BRANCH_RETRY_POLICY.maximumAutomaticAttempts, 1)
})

test('高成本重试停下等用户，系统不替用户决定再花一笔大的', () => {
  assert.equal(decideBranchRetry({ branch: branch(), job: job({ batchCount: 8 }), now: 1e6 }).reason, 'retry_too_costly')
  assert.equal(decideBranchRetry({ branch: branch(), job: job({ batchCount: 4 }), now: 1e6 }).action, 'retry')
})

test('预算不足必须停下：自动重试把余额跑完，用户连手动重试的机会都没有', () => {
  assert.equal(decideBranchRetry({ branch: branch(), job: job(), budgetRemaining: 1, now: 1e6 }).reason, 'budget_insufficient')
  assert.equal(decideBranchRetry({ branch: branch(), job: job(), budgetRemaining: 2, now: 1e6 }).action, 'retry')
  // 没有预算信息时不猜；其余门槛仍然生效。
  assert.equal(decideBranchRetry({ branch: branch(), job: job(), budgetRemaining: undefined, now: 1e6 }).action, 'retry')
})

test('退避未到不重投：紧接着重试很可能撞上同一次上游故障', () => {
  const outcome = decideBranchRetry({ branch: branch(), job: job({ updatedAt: 1_000 }), now: 5_000 })
  assert.equal(outcome.reason, 'backoff_pending')
  assert.equal(outcome.readyAt, 1_000 + DEFAULT_BRANCH_RETRY_POLICY.backoffMs)
  assert.equal(decideBranchRetry({ branch: branch(), job: job({ updatedAt: 1_000 }), now: 40_000 }).action, 'retry')
})

test('缺少原始配方时不重试：那会变成按别的输入再跑一次', () => {
  assert.equal(decideBranchRetry({ branch: branch(), job: job({ rawInput: undefined }), now: 1e6 }).reason, 'retry_source_missing')
  assert.equal(decideBranchRetry({ branch: branch(), job: undefined, now: 1e6 }).reason, 'job_missing')
  assert.equal(decideBranchRetry({ branch: branch({ status: 'succeeded' }), job: job() }).reason, 'branch_not_failed')
  assert.deepEqual([...BRANCH_RETRY_ACTIONS], ['retry', 'wait_for_user'])
})

test('挑选可重试分支时，停下的分支也带原因列出来', () => {
  // 用户需要知道「为什么它没自动重试」。
  const run = {
    branches: [
      branch({ id: 'transient', activeJobId: 'job-transient' }),
      branch({ id: 'permanent', activeJobId: 'job-permanent' }),
      branch({ id: 'done', status: 'succeeded', activeJobId: 'job-done' }),
    ],
  }
  const jobs = new Map([
    ['job-transient', job({ id: 'job-transient' })],
    ['job-permanent', job({ id: 'job-permanent', errorCode: 'INVALID_REQUEST' })],
  ])
  const outcome = branchesEligibleForRetry({ run, jobs, now: 1e6 })
  assert.deepEqual(outcome.eligible.map((entry) => entry.branchId), ['transient'])
  assert.deepEqual(outcome.held.map((entry) => `${entry.branchId}:${entry.reason}`), ['permanent:error_not_retryable'])
})
