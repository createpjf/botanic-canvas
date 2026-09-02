import test from 'node:test'
import assert from 'node:assert/strict'
import { aggregateAgentOutcomes, createAgentOutcomes, formatAgentOutcomeRecap } from './agentOutcomeMetrics.mjs'

test('从权威实体串起确认、产出、人工决定、交付与成本', () => {
  const outcomes = createAgentOutcomes({
    turns: [{ id: 'turn-1', projectId: 'project-1', sessionId: 'session-1', status: 'completed', createdAt: 100, updatedAt: 900, request: { operation: 'plan' } }],
    runs: [{ id: 'run-1', turnId: 'turn-1', status: 'completed', plan: { plannerModel: 'planner-a' } }],
    jobs: [{
      id: 'job-1', status: 'succeeded', updatedAt: 500, agentRun: { runId: 'run-1' },
      effectiveModel: 'image-a', usage: { costUnits: 4 }, outputs: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    }],
    reviewTasks: [{
      runId: 'run-1', coverage: { artifactIds: ['generation:job-1:a', 'generation:job-1:b', 'generation:job-1:c'] }, decisions: [
        { artifactId: 'generation:job-1:a', decision: 'rejected', decisionRevision: 0, decidedAt: 700 },
        { artifactId: 'generation:job-1:a', decision: 'accepted', decisionRevision: 1, decidedAt: 600 },
        { artifactId: 'generation:job-1:b', decision: 'rejected', decidedAt: 610 },
      ],
    }],
    manifests: [{ files: [{ artifactId: 'generation:job-1:a' }] }],
  })
  assert.equal(outcomes.length, 1)
  assert.deepEqual(outcomes[0], {
    version: 1, turnId: 'turn-1', projectId: 'project-1', sessionId: 'session-1', requestType: 'plan', turnStatus: 'completed',
    planCreated: true, planConfirmed: true, runCount: 1, executionTerminal: true, executionSucceeded: true,
    generatedArtifactCount: 3, acceptedArtifactCount: 1, rejectedArtifactCount: 1, retryRequestCount: 0,
    pendingReviewArtifactCount: 1, deliveredArtifactCount: 1, estimatedCostUnits: 4, timeToFirstGeneratedMs: 400,
    timeToFirstAcceptedMs: 500, totalObservedDurationMs: 800,
    plannerVersions: ['planner-a'], generationModels: ['image-a'], createdAt: 100, updatedAt: 900, stage: 'delivered',
  })
  assert.equal(formatAgentOutcomeRecap(outcomes[0]), '本次任务：已生成 3 个候选，已接受 1 个，已拒绝 1 个，还有 1 个等待决定，已有 1 个进入交付。')
  assert.deepEqual(aggregateAgentOutcomes(outcomes), {
    version: 1, requestCount: 1, planCreationRate: 1, planConfirmationRate: 1, executionSuccessRate: 1,
    plannedRequestDeliveryRate: 1, generatedArtifactCount: 3, acceptedArtifactCount: 1, rejectedArtifactCount: 1,
    retryRequestCount: 0, deliveredArtifactCount: 1, candidateAcceptanceRate: 0.5,
    estimatedCostUnits: 4, estimatedCostPerAcceptedArtifact: 4,
    averageTimeToFirstGeneratedMs: 400, averageTimeToFirstAcceptedMs: 500, averageTotalObservedDurationMs: 800,
  })
})

test('无样本与未确认计划不冒充失败或零成功率', () => {
  assert.deepEqual(aggregateAgentOutcomes([]), {
    version: 1, requestCount: 0, planCreationRate: null, planConfirmationRate: null, executionSuccessRate: null,
    plannedRequestDeliveryRate: null, generatedArtifactCount: 0, acceptedArtifactCount: 0, rejectedArtifactCount: 0,
    retryRequestCount: 0, deliveredArtifactCount: 0, candidateAcceptanceRate: null,
    estimatedCostUnits: 0, estimatedCostPerAcceptedArtifact: null,
    averageTimeToFirstGeneratedMs: null, averageTimeToFirstAcceptedMs: null, averageTotalObservedDurationMs: null,
  })
  const [outcome] = createAgentOutcomes({
    turns: [{ id: 'turn-plan', projectId: 'project-1', status: 'completed', result: { planFingerprint: 'fp' }, createdAt: 10, updatedAt: 20 }],
  })
  assert.equal(outcome.stage, 'awaiting_confirmation')
  assert.equal(outcome.executionTerminal, false)
  assert.equal(formatAgentOutcomeRecap(outcome), 'Agent 已形成计划，正在等待确认。')
})
