// @ts-check

/**
 * 失败分支的服务端自动重试策略（Epic 5）。
 *
 * 此前「失败了要不要再跑一次」由浏览器决定，因此关掉页面就没有重试。把它挪到服务端
 * 的关键不是「让它更自动」，而是**明确什么情况下不该自动重试**：
 *
 * - 不可重试的错误（参数非法、模型未配置、内容被拒）重试多少次都一样，只是重复扣费；
 * - 高成本重试（一次要出很多张）应当让人确认，而不是系统替用户决定再花一次钱；
 * - 预算不足时必须停下 —— 自动重试把余额跑完，用户连手动重试的机会都没有。
 *
 * 因此这里的默认值刻意保守：**只自动重试一次**，且只针对明确的瞬时故障。
 */

/** 判定结果。声明式：新增动作必须同时说明谁来执行它。 */
export const BRANCH_RETRY_ACTIONS = Object.freeze(['retry', 'wait_for_user'])

/**
 * 明确属于瞬时故障、重试有意义的错误码。
 *
 * 白名单而不是黑名单：未知错误码按「不自动重试」处理。把未知当成可重试，等于让一类
 * 我们还不理解的失败自动消耗预算。
 */
export const RETRYABLE_ERROR_CODES = Object.freeze([
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_CIRCUIT_OPEN',
  'QUEUE_UNAVAILABLE',
  'REQUEST_TIMEOUT',
  'GENERATION_FAILED',
])

const retryableCodes = new Set(RETRYABLE_ERROR_CODES)

/** 默认策略。三个数字都偏保守，宁可少自动重试一次也不要多花一次钱。 */
export const DEFAULT_BRANCH_RETRY_POLICY = Object.freeze({
  // 只自动重试一次：连续失败两次通常不是抖动，而是这次请求本身有问题。
  maximumAutomaticAttempts: 1,
  // 单次重试的最大出图数。超过它就让人确认 —— 系统不替用户决定再花一笔大的。
  maximumAutomaticBatchCount: 4,
  // 退避：紧接着重投很可能撞上同一次上游故障。
  backoffMs: 30_000,
})

function decision(action, reason, extra = {}) {
  return { action, reason, ...extra }
}

/**
 * 一个失败分支现在该不该自动重试。
 *
 * @param {{
 *   branch?: any,
 *   job?: any,
 *   policy?: any,
 *   budgetRemaining?: number,
 *   now?: number,
 * }} input
 * @returns {{ action: string, reason: string, delayMs?: number }}
 */
export function decideBranchRetry({ branch, job, policy = DEFAULT_BRANCH_RETRY_POLICY, budgetRemaining, now = Date.now() } = {}) {
  const settings = { ...DEFAULT_BRANCH_RETRY_POLICY, ...policy }
  if (branch?.status !== 'failed') return decision('wait_for_user', 'branch_not_failed')
  if (!job) return decision('wait_for_user', 'job_missing')
  if (!job.rawInput) {
    // 没有原始配方就无法重放这一支；重试会变成「按别的输入再跑一次」。
    return decision('wait_for_user', 'retry_source_missing')
  }
  const attempt = Number(branch.attempt ?? 0)
  if (attempt >= settings.maximumAutomaticAttempts) {
    return decision('wait_for_user', 'attempt_limit_reached')
  }
  const code = typeof job.errorCode === 'string' ? job.errorCode : undefined
  if (!code) {
    // 失败但没记错误码：无法判断是不是瞬时故障，按不可重试处理。
    return decision('wait_for_user', 'error_code_unknown')
  }
  if (!retryableCodes.has(code)) {
    return decision('wait_for_user', 'error_not_retryable')
  }
  const batchCount = Math.max(1, Number(job.batchCount ?? 1))
  if (batchCount > settings.maximumAutomaticBatchCount) {
    return decision('wait_for_user', 'retry_too_costly')
  }
  if (Number.isFinite(budgetRemaining) && Number(budgetRemaining) < batchCount) {
    // 自动重试把余额跑完的话，用户连手动重试的机会都没有。
    return decision('wait_for_user', 'budget_insufficient')
  }
  const failedAt = Number(job.updatedAt ?? 0)
  const readyAt = failedAt + settings.backoffMs
  if (failedAt && now < readyAt) {
    return decision('wait_for_user', 'backoff_pending', { readyAt })
  }
  return decision('retry', 'transient_failure', { delayMs: settings.backoffMs })
}

/**
 * 从一个 Run 里挑出当前可自动重试的分支。
 *
 * @param {{ run: any, jobs?: Map<string, any> | Record<string, any>, policy?: any, budgetRemaining?: number, now?: number }} input
 */
export function branchesEligibleForRetry({ run, jobs, policy, budgetRemaining, now = Date.now() } = /** @type {any} */ ({})) {
  const lookup = jobs instanceof Map ? jobs : new Map(Object.entries(jobs ?? {}))
  const eligible = []
  const held = []
  for (const branch of run?.branches ?? []) {
    if (branch?.status !== 'failed') continue
    const job = branch.activeJobId ? lookup.get(branch.activeJobId) : undefined
    const outcome = decideBranchRetry({ branch, job, policy, budgetRemaining, now })
    if (outcome.action === 'retry') eligible.push({ branchId: branch.id, ...outcome })
    // 停下等用户的分支也要列出来并带上原因：用户需要知道「为什么它没自动重试」。
    else held.push({ branchId: branch.id, ...outcome })
  }
  return { eligible, held }
}
