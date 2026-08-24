import assert from 'node:assert/strict'
import test from 'node:test'
import { buildReviewTaskForRun, reviewCandidatesFromRun, runAgentReviewTask } from './agentReviewRunner.mjs'
import { planReviewCoverage } from './agentReviewTask.mjs'

const settings = { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' }
const qualityPolicy = { version: 1, requiredCriteria: ['identity', 'composition'], humanDecisionRequired: true }
const spec = { mimeType: 'image/png', byteSize: 2048, width: 1024, height: 1024 }

function run() {
  return {
    id: 'run-1', projectId: 'project-1', ownerId: 'user-1', status: 'completed',
    branches: [
      { id: 'branch-a', jobIds: ['job-a'], activeJobId: 'job-a' },
      { id: 'branch-b', jobIds: ['job-b'], activeJobId: 'job-b' },
    ],
    compiledPlan: {
      version: 2, planFingerprint: 'plan-fp', branches: [
        { branchId: 'branch-a', branchFingerprint: 'branch-fp-a', qualityPolicy },
        { branchId: 'branch-b', branchFingerprint: 'branch-fp-b', qualityPolicy },
      ],
    },
  }
}

function jobs() {
  return [
    {
      id: 'job-a', status: 'succeeded', settings, branchFingerprint: 'branch-fp-a',
      agentRun: { runId: 'run-1', branchId: 'branch-a' },
      outputs: [{ id: 'out-1', spec }, { id: 'out-2', spec }],
    },
    {
      id: 'job-b', status: 'succeeded', settings, branchFingerprint: 'branch-fp-b',
      agentRun: { runId: 'run-1', branchId: 'branch-b' },
      outputs: [{ id: 'out-1', spec: { mimeType: 'image/png', byteSize: 512, width: 512, height: 1024 } }],
    },
    { id: 'job-failed', status: 'failed', settings, agentRun: { runId: 'run-1', branchId: 'branch-b' }, outputs: [] },
  ]
}

test('候选来自全部成功 Job 的每一张输出，不只每分支第一张', () => {
  // 历史实现每分支只取第一张，覆盖率实测约 25%。
  const candidates = reviewCandidatesFromRun(run(), jobs())
  assert.deepEqual(candidates.map((candidate) => candidate.artifactId), [
    'generation:job-a:out-1', 'generation:job-a:out-2', 'generation:job-b:out-1',
  ])
  assert.deepEqual(candidates.map((candidate) => candidate.branchId), ['branch-a', 'branch-a', 'branch-b'])
})

test('质量策略来自 Run 的编译快照，取不到就不建任务', () => {
  const built = buildReviewTaskForRun({ run: run(), jobs: jobs(), now: 100 })
  assert.equal(built.task.planFingerprint, 'plan-fp')
  assert.deepEqual(built.task.qualityPolicy.requiredCriteria, ['identity', 'composition'])
  assert.equal(built.task.coverage.reviewedCandidates, 3)

  // 没有编译快照的历史 Run 不退回硬编码 rubric，而是不建任务。
  const legacy = { ...run(), compiledPlan: undefined }
  assert.equal(buildReviewTaskForRun({ run: legacy, jobs: jobs() }), undefined)
  // 没有成功候选也不建任务。
  assert.equal(buildReviewTaskForRun({ run: run(), jobs: [] }), undefined)
})

test('第 1 层失败的候选不进模型层，且任务仍能完成', async () => {
  const built = buildReviewTaskForRun({ run: run(), jobs: jobs(), now: 100 })
  const asked = []
  const outcome = await runAgentReviewTask({
    ...built,
    reviewCandidate: async ({ candidate }) => {
      asked.push(candidate.artifactId)
      return { criteria: [{ id: 'identity', layer: 'model', verdict: 'pass', evidence: '主体一致' }] }
    },
    now: () => 200,
  })

  assert.equal(outcome.task.status, 'completed')
  assert.equal(outcome.results.length, 3)
  // job-b 的输出是 1:2，比例不符 → 第 1 层 fail，不问模型。
  assert.deepEqual(asked, ['generation:job-a:out-1', 'generation:job-a:out-2'])
  const failed = outcome.results.find((item) => item.artifactId === 'generation:job-b:out-1')
  assert.equal(failed.verdict, 'fail')
  assert.equal(failed.criteria.some((item) => item.layer === 'model'), false)
  // 每条结论都带质量策略指纹，可证明用的是 Run 确认时那套判据。
  assert.ok(outcome.results.every((item) => item.qualityPolicyFingerprint === built.task.qualityPolicyFingerprint))
})

test('没有模型层时照实记「无法验证」，不把没评当成评过', async () => {
  const built = buildReviewTaskForRun({ run: run(), jobs: jobs(), now: 100 })
  const outcome = await runAgentReviewTask({ ...built, now: () => 200 })
  const first = outcome.results.find((item) => item.artifactId === 'generation:job-a:out-1')
  assert.equal(first.verdict, 'unverifiable')
  assert.equal(first.criteria.find((item) => item.layer === 'model').evidence, '未配置视觉评审模型。')
  assert.equal(outcome.task.status, 'completed')
})

test('模型不可用与输出不可解析被分开记录，任务仍收口', async () => {
  const built = buildReviewTaskForRun({ run: run(), jobs: jobs(), now: 100 })
  let call = 0
  const outcome = await runAgentReviewTask({
    ...built,
    reviewCandidate: async () => {
      call += 1
      const error = new Error(call === 1 ? '网关不可用' : '模型输出不是 JSON')
      error.code = call === 1 ? 'REVIEW_MODEL_UNAVAILABLE' : 'REVIEW_OUTPUT_UNPARSABLE'
      throw error
    },
    now: () => 200,
  })
  assert.deepEqual(outcome.failures.map((item) => item.code), ['REVIEW_MODEL_UNAVAILABLE', 'REVIEW_OUTPUT_UNPARSABLE'])
  // 评审失败不改变已成功生成的 Job/Artifact；任务自身仍给出可诊断结论。
  assert.equal(outcome.task.status, 'completed')
  assert.ok(outcome.results.every((item) => item.verdict !== 'pass'))
})

test('覆盖清单里的候选找不到输出时判无法验证，不静默跳过', async () => {
  const built = buildReviewTaskForRun({ run: run(), jobs: jobs(), now: 100 })
  const outcome = await runAgentReviewTask({
    task: built.task, candidates: [], now: () => 200,
  })
  assert.equal(outcome.results.length, 3)
  assert.ok(outcome.results.every((item) => item.verdict === 'unverifiable'))
  assert.equal(outcome.task.status, 'completed')
})

test('已有结论不重复评审，断点续评后才收 completed', async () => {
  const built = buildReviewTaskForRun({ run: run(), jobs: jobs(), now: 100 })
  const asked = []
  const partial = await runAgentReviewTask({
    task: { ...built.task, coverage: planReviewCoverage({ candidates: built.candidates.slice(0, 1) }) },
    candidates: built.candidates,
    reviewCandidate: async ({ candidate }) => {
      asked.push(candidate.artifactId)
      return { criteria: [{ id: 'identity', layer: 'model', verdict: 'pass' }] }
    },
    now: () => 200,
  })
  assert.equal(partial.task.status, 'completed')

  const resumed = await runAgentReviewTask({
    ...built,
    existingResults: partial.results,
    reviewCandidate: async ({ candidate }) => {
      asked.push(candidate.artifactId)
      return { criteria: [{ id: 'identity', layer: 'model', verdict: 'pass' }] }
    },
    now: () => 300,
  })
  assert.equal(resumed.task.status, 'completed')
  // 第一张只被评了一次。
  assert.equal(asked.filter((id) => id === 'generation:job-a:out-1').length, 1)
})
