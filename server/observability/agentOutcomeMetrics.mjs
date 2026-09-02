// @ts-check

/**
 * Agent 成功度量读模型。
 *
 * 只从 Turn / Run / GenerationJob / ReviewTask / DeliveryManifest 权威事实派生，
 * 不参与业务写入，也不让模型猜测“是否完成”。输入可来自任意 Store Adapter。
 */

const successfulRunStatuses = new Set(['completed', 'partial'])
const terminalRunStatuses = new Set(['completed', 'partial', 'failed', 'cancelled'])

const list = (value) => Array.isArray(value) ? value.filter(Boolean) : []
const ratio = (numerator, denominator) => denominator > 0 ? numerator / denominator : null
const finiteTime = (value) => Number.isFinite(Number(value)) ? Number(value) : undefined

function latestDecisions(tasks) {
  const latest = new Map()
  for (const task of tasks) {
    for (const decision of list(task?.decisions)) {
      if (!decision?.artifactId || !['accepted', 'rejected', 'retry_requested'].includes(decision.decision)) continue
      const previous = latest.get(decision.artifactId)
      const revision = Number(decision.decisionRevision) || 0
      const previousRevision = Number(previous?.decisionRevision) || 0
      if (!previous || revision > previousRevision
        || (revision === previousRevision && (finiteTime(decision.decidedAt) ?? 0) >= (finiteTime(previous.decidedAt) ?? 0))) {
        latest.set(decision.artifactId, decision)
      }
    }
  }
  return [...latest.values()]
}

function artifactId(job, output) {
  return job?.id && output?.id ? `generation:${job.id}:${output.id}` : undefined
}

function outcomeStage(outcome) {
  if (outcome.deliveredArtifactCount > 0) return 'delivered'
  if (outcome.acceptedArtifactCount > 0) return 'accepted'
  if (outcome.executionSucceeded && outcome.generatedArtifactCount > 0) return 'generated'
  if (outcome.executionTerminal && !outcome.executionSucceeded) return 'failed'
  if (outcome.executionTerminal) return 'completed_without_artifacts'
  if (outcome.planConfirmed) return 'executing'
  if (outcome.planCreated) return 'awaiting_confirmation'
  if (['failed', 'cancelled'].includes(outcome.turnStatus)) return outcome.turnStatus
  if (outcome.turnStatus === 'completed') return 'answered'
  return 'in_progress'
}

/**
 * @param {{ turns?: any[], runs?: any[], jobs?: any[], reviewTasks?: any[], manifests?: any[] }} [input]
 */
export function createAgentOutcomes(input = {}) {
  const turns = list(input.turns)
  const runs = list(input.runs)
  const jobs = list(input.jobs)
  const reviewTasks = list(input.reviewTasks)
  const manifests = list(input.manifests)
  const runsByTurn = new Map()
  for (const run of runs) {
    if (!run?.turnId) continue
    const group = runsByTurn.get(run.turnId) ?? []
    group.push(run)
    runsByTurn.set(run.turnId, group)
  }

  return turns.filter((turn) => turn?.id).map((turn) => {
    const linkedRuns = runsByTurn.get(turn.id) ?? []
    const runIds = new Set(linkedRuns.map((run) => run.id).filter(Boolean))
    const linkedJobs = jobs.filter((job) => runIds.has(job?.agentRun?.runId))
    const linkedReviews = reviewTasks.filter((task) => runIds.has(task?.runId))
    const generatedArtifacts = new Set(linkedJobs.flatMap((job) => list(job?.outputs)
      .map((output) => artifactId(job, output)).filter(Boolean)))
    const reviewedArtifacts = new Set(linkedReviews.flatMap((task) => [
      ...list(task?.coverage?.artifactIds),
      ...list(task?.results).map((result) => result?.artifactId),
    ]).filter((id) => generatedArtifacts.has(id)))
    const decisions = latestDecisions(linkedReviews)
      .filter((decision) => generatedArtifacts.has(decision.artifactId))
    const deliveredArtifacts = new Set(manifests.flatMap((manifest) => list(manifest?.files)
      .map((file) => file?.artifactId).filter((id) => generatedArtifacts.has(id))))
    const completedJobs = linkedJobs.filter((job) => job?.status === 'succeeded' && list(job.outputs).length)
    const firstGeneratedAt = completedJobs.map((job) => finiteTime(job.completedAt) ?? finiteTime(job.updatedAt))
      .filter((value) => value !== undefined).sort((left, right) => left - right)[0]
    const firstAcceptedAt = decisions.filter((decision) => decision.decision === 'accepted')
      .map((decision) => finiteTime(decision.decidedAt)).filter((value) => value !== undefined)
      .sort((left, right) => left - right)[0]
    const observedTimes = [
      finiteTime(turn.updatedAt),
      ...linkedRuns.map((run) => finiteTime(run.updatedAt)),
      ...linkedJobs.map((job) => finiteTime(job.updatedAt)),
      ...decisions.map((decision) => finiteTime(decision.decidedAt)),
      ...manifests.filter((manifest) => list(manifest?.files).some((file) => generatedArtifacts.has(file?.artifactId)))
        .map((manifest) => finiteTime(manifest.generatedAt)),
    ].filter((value) => value !== undefined)
    const latestObservedAt = observedTimes.length ? Math.max(...observedTimes) : undefined
    const createdAt = finiteTime(turn.createdAt)
    const planCreated = linkedRuns.length > 0 || Boolean(turn?.result?.plan || turn?.result?.planFingerprint)
    const outcome = {
      version: 1,
      turnId: turn.id,
      projectId: turn.projectId,
      ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
      requestType: turn?.result?.runtimeOperation ?? turn?.result?.kind ?? turn?.request?.operation ?? 'unknown',
      turnStatus: turn.status ?? 'unknown',
      planCreated,
      planConfirmed: linkedRuns.length > 0,
      runCount: linkedRuns.length,
      executionTerminal: linkedRuns.length > 0 && linkedRuns.every((run) => terminalRunStatuses.has(run?.status)),
      executionSucceeded: linkedRuns.some((run) => successfulRunStatuses.has(run?.status)),
      generatedArtifactCount: generatedArtifacts.size,
      acceptedArtifactCount: decisions.filter((decision) => decision.decision === 'accepted').length,
      rejectedArtifactCount: decisions.filter((decision) => decision.decision === 'rejected').length,
      retryRequestCount: decisions.filter((decision) => decision.decision === 'retry_requested').length,
      pendingReviewArtifactCount: Math.max(0, reviewedArtifacts.size - decisions.length),
      deliveredArtifactCount: deliveredArtifacts.size,
      estimatedCostUnits: linkedJobs.reduce((total, job) => total + (Number(job?.usage?.costUnits) || 0), 0),
      timeToFirstGeneratedMs: createdAt !== undefined && firstGeneratedAt !== undefined
        ? Math.max(0, firstGeneratedAt - createdAt) : null,
      timeToFirstAcceptedMs: createdAt !== undefined && firstAcceptedAt !== undefined
        ? Math.max(0, firstAcceptedAt - createdAt) : null,
      totalObservedDurationMs: createdAt !== undefined && latestObservedAt !== undefined
        ? Math.max(0, latestObservedAt - createdAt) : null,
      plannerVersions: [...new Set(linkedRuns.map((run) => run?.plan?.plannerModel).filter(Boolean))].sort(),
      generationModels: [...new Set(linkedJobs.map((job) => job?.effectiveModel ?? job?.usage?.model ?? job?.settings?.model).filter(Boolean))].sort(),
      createdAt: createdAt ?? null,
      updatedAt: finiteTime(turn.updatedAt) ?? null,
    }
    return { ...outcome, stage: outcomeStage(outcome) }
  })
}

/** @param {any[]} outcomes */
export function aggregateAgentOutcomes(outcomes = []) {
  const all = list(outcomes)
  const planned = all.filter((outcome) => outcome.planCreated)
  const confirmed = all.filter((outcome) => outcome.planConfirmed)
  const settledExecutions = confirmed.filter((outcome) => outcome.executionTerminal)
  const decided = all.reduce((total, outcome) => total + outcome.acceptedArtifactCount + outcome.rejectedArtifactCount + outcome.retryRequestCount, 0)
  const accepted = all.reduce((total, outcome) => total + outcome.acceptedArtifactCount, 0)
  const totalCost = all.reduce((total, outcome) => total + (Number(outcome.estimatedCostUnits) || 0), 0)
  const average = (values) => values.length ? values.reduce((total, value) => total + value, 0) / values.length : null
  const firstGeneratedDurations = all.map((outcome) => outcome.timeToFirstGeneratedMs).filter(Number.isFinite)
  const firstAcceptedDurations = all.map((outcome) => outcome.timeToFirstAcceptedMs).filter(Number.isFinite)
  const totalDurations = all.map((outcome) => outcome.totalObservedDurationMs).filter(Number.isFinite)
  return {
    version: 1,
    requestCount: all.length,
    planCreationRate: ratio(planned.length, all.length),
    planConfirmationRate: ratio(confirmed.length, planned.length),
    executionSuccessRate: ratio(settledExecutions.filter((outcome) => outcome.executionSucceeded).length, settledExecutions.length),
    plannedRequestDeliveryRate: ratio(planned.filter((outcome) => outcome.deliveredArtifactCount > 0).length, planned.length),
    generatedArtifactCount: all.reduce((total, outcome) => total + outcome.generatedArtifactCount, 0),
    acceptedArtifactCount: accepted,
    rejectedArtifactCount: all.reduce((total, outcome) => total + outcome.rejectedArtifactCount, 0),
    retryRequestCount: all.reduce((total, outcome) => total + outcome.retryRequestCount, 0),
    deliveredArtifactCount: all.reduce((total, outcome) => total + outcome.deliveredArtifactCount, 0),
    candidateAcceptanceRate: ratio(accepted, decided),
    estimatedCostUnits: totalCost,
    estimatedCostPerAcceptedArtifact: accepted > 0 ? totalCost / accepted : null,
    averageTimeToFirstGeneratedMs: average(firstGeneratedDurations),
    averageTimeToFirstAcceptedMs: average(firstAcceptedDurations),
    averageTotalObservedDurationMs: average(totalDurations),
  }
}

/** 确定性用户摘要；只陈述已观测事实，不推断完成。 @param {any} outcome */
export function formatAgentOutcomeRecap(outcome) {
  if (!outcome) return '没有可回顾的 Agent 任务。'
  const parts = []
  if (outcome.generatedArtifactCount > 0) parts.push(`已生成 ${outcome.generatedArtifactCount} 个候选`)
  if (outcome.acceptedArtifactCount > 0) parts.push(`已接受 ${outcome.acceptedArtifactCount} 个`)
  if (outcome.rejectedArtifactCount > 0) parts.push(`已拒绝 ${outcome.rejectedArtifactCount} 个`)
  if (outcome.retryRequestCount > 0) parts.push(`已请求重试 ${outcome.retryRequestCount} 个`)
  if (outcome.pendingReviewArtifactCount > 0) parts.push(`还有 ${outcome.pendingReviewArtifactCount} 个等待决定`)
  if (outcome.deliveredArtifactCount > 0) parts.push(`已有 ${outcome.deliveredArtifactCount} 个进入交付`)
  if (!parts.length) {
    if (outcome.stage === 'awaiting_confirmation') return 'Agent 已形成计划，正在等待确认。'
    if (outcome.stage === 'executing') return '计划已确认，Agent 正在执行。'
    if (outcome.stage === 'failed') return 'Agent 执行已结束，但没有成功产出候选。'
    if (outcome.stage === 'completed_without_artifacts') return 'Agent 执行已结束，当前快照中没有候选产物。'
    if (outcome.stage === 'cancelled') return '本次 Agent 任务已取消。'
    if (outcome.stage === 'answered') return 'Agent 已完成本次回复，没有创建生成任务。'
    return 'Agent 任务仍在处理中。'
  }
  return `本次任务：${parts.join('，')}。`
}
