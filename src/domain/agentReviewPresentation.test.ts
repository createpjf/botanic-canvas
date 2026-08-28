import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentReviewCandidateRows,
  agentReviewCoverageSummary,
  agentReviewEvaluatorCostNote,
  agentReviewRequiresReconciliation,
  agentReviewTaskStatusNote,
  agentReviewVerdictLabel,
  isEvaluatorCriterion,
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

test('覆盖摘要必须说出被跳过的结果数', () => {
  // 不说的话「评了 2 张」看起来就像「全评过了」。
  const summary = agentReviewCoverageSummary(task)
  assert.match(summary, /5 张图中已评审 2 张/u)
  assert.match(summary, /另有 3 张按覆盖策略跳过/u)
  assert.match(agentReviewCoverageSummary(task, 'en'), /3 skipped by the coverage strategy/u)

  const full = agentReviewCoverageSummary({ ...task, coverage: { totalCandidates: 2, reviewedCandidates: 2, skippedCandidates: 0 } })
  assert.doesNotMatch(full, /跳过/u)
  assert.match(agentReviewCoverageSummary(undefined), /没有可评审的结果/u)
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

  const revisionWins = agentReviewCandidateRows({
    ...task,
    decisions: [
      { artifactId: 'a2', decision: 'rejected', decidedAt: 999, decisionRevision: 1 },
      { artifactId: 'a2', decision: 'accepted', decidedAt: 1, decisionRevision: 2 },
    ],
  })
  assert.equal(revisionWins[1].decision, 'accepted', '锁内 revision 必须压过客户端时钟')
})

test('任务失败要能被诊断，不只显示「评审失败」', () => {
  const failed = agentReviewTaskStatusNote({ ...task, status: 'failed', error: { code: 'REVIEW_MODEL_UNAVAILABLE' } })
  assert.match(failed, /REVIEW_MODEL_UNAVAILABLE/u)
  // 评审失败不改变已生成的结果，这一点必须说清楚。
  assert.match(failed, /已生成的结果不受影响/u)
  assert.match(agentReviewTaskStatusNote({ ...task, status: 'running' }), /仍在后台进行/u)
  assert.match(agentReviewTaskStatusNote({ ...task, status: 'cancelling' }), /Worker 退出或租约过期/u)
  assert.match(agentReviewTaskStatusNote({ ...task, status: 'cancelled' }), /已取消/u)
  const outcomeUnknown = {
    ...task,
    status: 'failed' as const,
    error: { code: 'AGENT_REVIEW_OUTCOME_UNKNOWN' },
  }
  assert.equal(agentReviewRequiresReconciliation(outcomeUnknown), true)
  assert.match(agentReviewTaskStatusNote(outcomeUnknown), /未自动重试/u)
  assert.match(agentReviewTaskStatusNote(outcomeUnknown, 'en'), /not retried automatically/u)
  assert.equal(agentReviewRequiresReconciliation(task), false)
  assert.equal(agentReviewTaskStatusNote({ ...task, status: 'completed' }), '')
  assert.equal(agentReviewTaskStatusNote(undefined), '')
})

test('空任务不炸', () => {
  assert.deepEqual(agentReviewCandidateRows(undefined), [])
  assert.deepEqual(agentReviewCandidateRows({ ...task, results: undefined, decisions: undefined }), [])
})

test('自定义判据的成本必须在评审开始前就能显示', () => {
  // 评审完再说已经晚了，钱已经花掉。用户加了 3 条判据却不知道费用翻了 3 倍，
  // 是这个功能最容易造成的伤害。
  const task = {
    id: 't', runId: 'r', status: 'queued' as const,
    coverage: { totalCandidates: 5, reviewedCandidates: 5, skippedCandidates: 0 },
    qualityPolicy: {
      requiredCriteria: ['identity'],
      evaluatorSkills: [
        { id: 'skill.a@1', skillId: 'a', version: 1 },
        { id: 'skill.b@2', skillId: 'b', version: 2 },
      ],
    },
  }
  assert.equal(agentReviewEvaluatorCostNote(task), '2 条自定义判据 × 5 张图 = 额外 10 次模型调用。')
  assert.match(agentReviewEvaluatorCostNote(task, 'en'), /2 project-defined criteria × 5 candidates = 10 extra model call\(s\)\./u)
  // 没有自定义判据时不显示这一行。
  assert.equal(agentReviewEvaluatorCostNote({ ...task, qualityPolicy: { requiredCriteria: ['identity'] } }), '')
  assert.equal(agentReviewEvaluatorCostNote(undefined), '')
})

test('自定义判据与内置判据能分开，且带 Skill 版本', () => {
  // Skill 版本不可变：历史评审要说得清当时按哪一版判的。
  const rows = agentReviewCandidateRows({
    id: 't', runId: 'r', status: 'completed',
    results: [{
      artifactId: 'a-1',
      criteria: [
        { id: 'identity', layer: 'model', verdict: 'pass' },
        { id: 'skill.compliance@3', layer: 'model', verdict: 'fail', evidence: '出现「最」字', skillId: 'compliance', skillVersion: 3 },
      ],
    }],
  })
  const custom = rows[0].criteria.find((item) => item.id === 'skill.compliance@3')!
  assert.equal(custom.skillId, 'compliance')
  assert.equal(custom.skillVersion, 3)
  assert.equal(isEvaluatorCriterion(custom), true)
  // 内置判据没有 Skill 溯源。
  const builtin = rows[0].criteria.find((item) => item.id === 'identity')!
  assert.equal(builtin.skillId, undefined)
  assert.equal(isEvaluatorCriterion(builtin), false)
})
