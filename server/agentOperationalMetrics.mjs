// @ts-check

/**
 * 工程指标聚合（Epic 12）。
 *
 * 它**消费**既有的结构化事件，不重新定义埋点协议 —— 运行时该发什么事件由 Epic 0
 * 的 `agentRunObservability` 与各模块自己决定，这里只负责把它们算成可对比的数字。
 * 反过来做（为了指标去改埋点）会让每加一个看板就动一次运行时代码。
 *
 * 所有比率在分母为 0 时返回 `null` 而不是 0：**「没有样本」和「成功率 0%」是两件事**，
 * 用 0 顶替会让一个还没跑过任何任务的部署看起来像全线崩溃。
 */

/** 指标族。声明式：新增族必须同时说明它由哪些事件算出来。 */
export const OPERATIONAL_METRIC_FAMILIES = Object.freeze([
  'turn',
  'tool',
  'run',
  'provider',
  'cancel',
  'writeback',
  'review',
  'workflow',
  'harness',
])

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null
}

/** 分位数。样本不足时返回 null —— 3 个样本的 P95 不是 P95。 */
function percentile(values, fraction, { minimumSamples = 1 } = {}) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right)
  if (sorted.length < minimumSamples) return null
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index]
}

const eventsOf = (events, name) => events.filter((event) => event?.event === name)
const runEventsOf = (events, type) => eventsOf(events, `agent.run.${type}`)

/**
 * 从结构化事件聚合工程指标。
 *
 * @param {Array<Record<string, any>>} [events]
 * @param {{ minimumPercentileSamples?: number }} [options]
 */
export function aggregateOperationalMetrics(events = [], { minimumPercentileSamples = 20 } = {}) {
  const all = Array.isArray(events) ? events.filter(Boolean) : []
  const percentileOptions = { minimumSamples: minimumPercentileSamples }

  const turnResumed = eventsOf(all, 'agent.turn.reclaim.resumed')
  const turnAbandoned = eventsOf(all, 'agent.turn.reclaim.abandoned')
  const turnFailed = eventsOf(all, 'agent.turn.reclaim.failed')
  const turnTotal = turnResumed.length + turnAbandoned.length + turnFailed.length

  const started = runEventsOf(all, 'worker_started')
  const completed = runEventsOf(all, 'worker_completed')
  const failed = runEventsOf(all, 'worker_failed')
  const settled = completed.length + failed.length
  const durations = completed.map((event) => Number(event.durationMs)).filter(Number.isFinite)
  const queueWaits = started.map((event) => Number(event.queueDurationMs)).filter(Number.isFinite)

  const retryQueued = runEventsOf(all, 'retry_queued')
  const retryReused = runEventsOf(all, 'retry_reused')
  const submissionReused = runEventsOf(all, 'submission_reused')
  const created = runEventsOf(all, 'created')

  const cancels = eventsOf(all, 'generation.cancel.aborted')
  const cancelLatencies = cancels.map((event) => Number(event.latencyMs)).filter(Number.isFinite)

  const writebackPending = all.filter((event) => event?.projectWritebackPending === true)
  const writebackObserved = all.filter((event) => typeof event?.projectWritebackPending === 'boolean')

  const reviewSettled = eventsOf(all, 'agent.review.settled')
  const reviewCompleted = reviewSettled.filter((event) => event.status === 'completed')
  const reviewSkipped = eventsOf(all, 'agent.review.skipped')
  const reviewed = reviewSettled.reduce((total, event) => total + (Number(event.reviewed) || 0), 0)
  const reviewSkippedCandidates = reviewSettled.reduce((total, event) => total + (Number(event.skipped) || 0), 0)

  const workflowAdvanced = eventsOf(all, 'workflow.advanced')
  const workflowFailed = eventsOf(all, 'workflow.advance.failed')

  // Harness 控制面口径（H7）：消费 botanic.agent.harness.lifecycle 语义事件。
  const harness = eventsOf(all, 'botanic.agent.harness.lifecycle')
  const harnessOf = (kind, outcome) => harness.filter((event) => event.kind === kind && event.outcome === outcome)
  const toolStarted = harnessOf('tool', 'started')
  const toolSucceeded = harnessOf('tool', 'succeeded')
  const toolFailed = harnessOf('tool', 'failed')
  const toolAborted = harnessOf('tool', 'aborted')
  const toolUnknown = harnessOf('tool', 'unknown')
  const toolSettled = toolSucceeded.length + toolFailed.length + toolAborted.length + toolUnknown.length
  const repairs = harnessOf('tool', 'repair')
  const loopStops = harnessOf('loop', 'loop_stop')
  const synthesis = harness.filter((event) => event.kind === 'loop' && event.outcome === 'final_synthesis')
  const skillLoaded = harnessOf('skill', 'loaded')
  const skillRejected = harnessOf('skill', 'rejected')
  const skillMismatch = harnessOf('skill', 'snapshot_mismatch')
  const cancelLatency = harnessOf('cancel', 'cancel_observed').map((event) => Number(event.durationMs)).filter(Number.isFinite)
  const startedAfterCancel = harnessOf('cancel', 'started_after_cancel')
  const completedAfterCancel = harnessOf('cancel', 'completed_after_cancel')
  const recoveryReused = harnessOf('recovery', 'reused')
  const recoveryReexecuted = harnessOf('recovery', 'reexecuted')
  const recoveryUnknown = harnessOf('recovery', 'unknown')
  const duplicateDispatch = harnessOf('recovery', 'duplicate_dispatch')
  const providerRetries = harnessOf('provider', 'retry')
  const providerCallTimeouts = harnessOf('provider', 'call_timeout')
  const deadlineExceeded = harnessOf('provider', 'deadline_exceeded')
  const resumeLimit = harnessOf('provider', 'resume_limit')
  const generations = harness.map((event) => Number(event.generation)).filter(Number.isFinite)

  return {
    sampleCount: all.length,
    turn: {
      // 恢复口径：孤儿清扫处理过的 Turn 里，多少真的续跑成功了。
      reclaimSampleCount: turnTotal,
      resumeRate: ratio(turnResumed.length, turnTotal),
      abandonRate: ratio(turnAbandoned.length, turnTotal),
      failureRate: ratio(turnFailed.length, turnTotal),
    },
    tool: {
      // 工具事件由回合流下发而非运维日志，因此这里只统计运维侧可见的重试面。
      retrySampleCount: retryQueued.length + retryReused.length,
      // 重复请求命中既有任务的比例：高说明幂等在起作用，不是坏事。
      retryReuseRate: ratio(retryReused.length, retryQueued.length + retryReused.length),
    },
    run: {
      startedCount: started.length,
      settledCount: settled,
      successRate: ratio(completed.length, settled),
      p50DurationMs: percentile(durations, 0.5, percentileOptions),
      p95DurationMs: percentile(durations, 0.95, percentileOptions),
      p50QueueWaitMs: percentile(queueWaits, 0.5, percentileOptions),
      // 重复提交率：同一逻辑提交被复用而不是新建，说明幂等生效。
      duplicateSubmissionRate: ratio(submissionReused.length, created.length + submissionReused.length),
    },
    provider: {
      // Provider 归因来自任务事件里的实际模型；没有 fallback 事件时为 null 而不是 0。
      attemptSampleCount: settled,
      failureRate: ratio(failed.length, settled),
      fallbackRate: ratio(
        completed.filter((event) => event.code === 'PROVIDER_FALLBACK').length,
        completed.length,
      ),
    },
    cancel: {
      sampleCount: cancels.length,
      // 取消传播延迟：点取消到 Worker 本地 abort 生效。跨进程时钟偏移使它只适合看趋势。
      p50LatencyMs: percentile(cancelLatencies, 0.5, percentileOptions),
      p95LatencyMs: percentile(cancelLatencies, 0.95, percentileOptions),
    },
    writeback: {
      observedCount: writebackObserved.length,
      // 回填完整率：观察到的写回里有多少不处于 pending。
      completeRate: ratio(writebackObserved.length - writebackPending.length, writebackObserved.length),
    },
    review: {
      taskSampleCount: reviewSettled.length,
      completionRate: ratio(reviewCompleted.length, reviewSettled.length),
      skippedTaskCount: reviewSkipped.length,
      // 覆盖率按候选算而不是按任务算：一个任务评了 2/5 张也是「完成」。
      candidateCoverageRate: ratio(reviewed, reviewed + reviewSkippedCandidates),
    },
    workflow: {
      advanceSampleCount: workflowAdvanced.length + workflowFailed.length,
      advanceSuccessRate: ratio(workflowAdvanced.length, workflowAdvanced.length + workflowFailed.length),
    },
    harness: {
      toolSettledCount: toolSettled,
      toolSuccessRate: ratio(toolSucceeded.length, toolSettled),
      toolUnknownCount: toolUnknown.length,
      toolStartedCount: toolStarted.length,
      repairCount: repairs.length,
      loopStopCount: loopStops.length,
      finalSynthesisCount: synthesis.length,
      finalSynthesisSuccessRate: ratio(
        synthesis.filter((event) => event.reason === undefined).length,
        synthesis.length,
      ),
      skillLoadRejectRate: ratio(skillRejected.length, skillLoaded.length + skillRejected.length),
      skillSnapshotMismatchCount: skillMismatch.length,
      cancelP50LatencyMs: percentile(cancelLatency, 0.5, percentileOptions),
      cancelP95LatencyMs: percentile(cancelLatency, 0.95, percentileOptions),
      // 零容忍不变量:任何 > 0 都是发布阻断,不是趋势指标。
      startedAfterCancelCount: startedAfterCancel.length,
      completedAfterCancelCount: completedAfterCancel.length,
      duplicateDispatchCount: duplicateDispatch.length,
      recoveryReusedCount: recoveryReused.length,
      recoveryReexecutedCount: recoveryReexecuted.length,
      recoveryUnknownCount: recoveryUnknown.length,
      providerRetryCount: providerRetries.length,
      providerCallTimeoutCount: providerCallTimeouts.length,
      deadlineExceededCount: deadlineExceeded.length,
      resumeLimitCount: resumeLimit.length,
      generationP95: percentile(generations, 0.95, percentileOptions),
    },
  }
}

/**
 * 指标对比：同一口径下的前后差异。
 *
 * 只对比两边都有样本的指标 —— 一边是 `null`（没样本）时报 `insufficient_samples`
 * 而不是算出一个看起来像回归的差值。
 *
 * @param {any} before
 * @param {any} after
 */
export function diffOperationalMetrics(before, after) {
  const changes = []
  for (const family of OPERATIONAL_METRIC_FAMILIES) {
    const left = before?.[family] ?? {}
    const right = after?.[family] ?? {}
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const from = left[key]
      const to = right[key]
      if (typeof from !== 'number' || typeof to !== 'number') {
        if (from !== to) changes.push({ family, metric: key, from: from ?? null, to: to ?? null, status: 'insufficient_samples' })
        continue
      }
      if (from === to) continue
      changes.push({ family, metric: key, from, to, delta: to - from, status: 'changed' })
    }
  }
  return changes
}
