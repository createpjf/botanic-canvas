import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentReviewCandidateRows,
  agentReviewCoverageSummary,
  agentReviewTaskStatusNote,
  agentReviewVerdictLabel,
  type AgentReviewTaskSnapshot,
} from './agentReviewPresentation.ts'

const task: AgentReviewTaskSnapshot = {
  id: 'review_task_1', runId: 'run-1', status: 'completed',
  qualityPolicyFingerprint: 'policy-fp',
  coverage: { strategy: 'capped', totalCandidates: 5, reviewedCandidates: 2, skippedCandidates: 3 },
  results: [
    {
      artifactId: 'a1', verdict: 'fail', candidateStatus: 'pending_human',
      criteria: [
        { id: 'aspect_ratio', layer: 'deterministic', verdict: 'fail', evidence: '期望 1:1，实际 1:2。' },
        { id: 'brand_style', layer: 'model', verdict: 'unverifiable', evidence: '未配置视觉评审模型。' },
      ],
      revisionProposal: { suggestion: '把主色调回品牌绿再出一版。', failedCriteria: ['brand_style'] },
    },
    {
      artifactId: 'a2', verdict: 'pass', candidateStatus: 'pending_human',
      criteria: [{ id: 'aspect_ratio', layer: 'deterministic', verdict: 'pass', evidence: '1:1' }],
    },
  ],
  decisions: [
    { artifactId: 'a2', decision: 'rejected', decidedAt: 5 },
    { artifactId: 'a2', decision: 'accepted', decidedAt: 9 },
  ],
}

test('「未验证」与「不符合」必须是两个词', () => {
  // 折进通过，用户会以为没检查过的判据检查过了；折进不通过，又把没验证说成不合格。
  assert.equal(agentReviewVerdictLabel('pass'), '符合')
  assert.equal(agentReviewVerdictLabel('fail'), '不符合')
  assert.equal(agentReviewVerdictLabel('unverifiable'), '未验证')
  assert.equal(agentReviewVerdictLabel(undefined), '未验证')
  assert.equal(agentReviewVerdictLabel('unverifiable', 'en'), 'Not verified')
})

test('覆盖摘要必须说出被跳过的候选数', () => {
  // 不说的话「评了 2 张」看起来就像「全评过了」。
  const summary = agentReviewCoverageSummary(task)
  assert.match(summary, /已评审 5 个候选中的 2 个/u)
  assert.match(summary, /另有 3 个按覆盖策略跳过/u)
  assert.match(agentReviewCoverageSummary(task, 'en'), /3 skipped by the coverage strategy/u)

  const full = agentReviewCoverageSummary({ ...task, coverage: { totalCandidates: 2, reviewedCandidates: 2, skippedCandidates: 0 } })
  assert.doesNotMatch(full, /跳过/u)
  assert.match(agentReviewCoverageSummary(undefined), /没有可评审的候选/u)
})

test('逐条判据带分层与证据摘要', () => {
  const rows = agentReviewCandidateRows(task)
  assert.deepEqual(rows[0].criteria.map((item) => `${item.layerLabel}/${item.id}/${item.verdictLabel}`), [
    '硬规格/aspect_ratio/不符合',
    '视觉评审/brand_style/未验证',
  ])
  assert.equal(rows[0].criteria[0].evidence, '期望 1:1，实际 1:2。')
  // 未验证的判据数单独给出，不混进「不符合」。
  assert.equal(rows[0].unverifiedCount, 1)
  assert.equal(rows[0].revisionSuggestion, '把主色调回品牌绿再出一版。')
})

test('没有人工决定的候选一律算等人：自动结论不代替批准', () => {
  const rows = agentReviewCandidateRows(task)
  assert.equal(rows[0].awaitingHuman, true)
  assert.equal(rows[0].decision, undefined)
  // 已决定的候选显示最后一次决定。
  assert.equal(rows[1].awaitingHuman, false)
  assert.equal(rows[1].decision, 'accepted')
  assert.equal(rows[1].decisionLabel, '已接受')
})

test('任务失败要能被诊断，不只显示「评审失败」', () => {
  const failed = agentReviewTaskStatusNote({ ...task, status: 'failed', error: { code: 'REVIEW_MODEL_UNAVAILABLE' } })
  assert.match(failed, /REVIEW_MODEL_UNAVAILABLE/u)
  // 评审失败不改变已生成的结果，这一点必须说清楚。
  assert.match(failed, /已生成的结果不受影响/u)
  assert.match(agentReviewTaskStatusNote({ ...task, status: 'running' }), /仍在后台进行/u)
  assert.equal(agentReviewTaskStatusNote({ ...task, status: 'completed' }), '')
  assert.equal(agentReviewTaskStatusNote(undefined), '')
})

test('空任务不炸', () => {
  assert.deepEqual(agentReviewCandidateRows(undefined), [])
  assert.deepEqual(agentReviewCandidateRows({ ...task, results: undefined, decisions: undefined }), [])
})
