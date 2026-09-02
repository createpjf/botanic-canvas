// @ts-check

import { persistedGenerationJob } from './generationProvider.mjs'

/** `null` 明确表示调用方观察到的是尚未被 Worker claim 的 Job。 */
export function observedGenerationJobExecution(job) {
  return job?.execution ? Number(job.execution.generation) : null
}

/**
 * 非 Worker 的状态转换统一走这一条 CAS seam。Worker 使用 leaseToken fenced commit，
 * 取消使用锁内状态判定；提交失败、超时和显式重试只可更新自己读到的那一版状态。
 */
export async function compareAndSetGenerationJob(productStore, userId, existing, next, options = {}) {
  if (typeof productStore?.compareAndSetGenerationJob !== 'function') {
    throw new TypeError('ProductStore 缺少 Generation Job CAS 能力。')
  }
  return productStore.compareAndSetGenerationJob(userId, {
    id: existing.id,
    projectId: existing.projectId,
    expectedStatus: existing.status,
    expectedExecutionGeneration: observedGenerationJobExecution(existing),
    clearExecution: options.clearExecution === true,
    job: persistedGenerationJob(next),
    updateAgentRun: options.updateAgentRun !== false,
    recordAudit: options.recordAudit !== false,
  })
}
