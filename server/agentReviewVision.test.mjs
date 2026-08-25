import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AgentReviewVisionError,
  createAgentReviewVisionJudge,
  reviewCriteriaBriefing,
  reviewVisionInstructions,
} from './agentReviewVision.mjs'

const task = {
  qualityPolicy: { version: 1, requiredCriteria: ['identity', 'brand_style', 'delivery_spec'], humanDecisionRequired: true },
  qualityPolicyFingerprint: 'policy-fp',
}
const candidate = { artifactId: 'generation:job-a:out-1', output: { id: 'out-1', image: '/api/media/media_a' } }
const resolveMedia = async () => 'data:image/png;base64,AAAA'

const judgeWith = (reply) => createAgentReviewVisionJudge({
  runtimeConfig: { agentVisionModel: 'vision-1', flockApiKey: 'key' },
  resolveMedia,
  callModel: async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }] }),
})

test('判据全部来自质量策略，不自带硬编码 rubric', () => {
  // Review 自带 rubric 的话，「结果符合用户确认的约束」无法被证明。
  const instructions = reviewVisionInstructions(task.qualityPolicy.requiredCriteria)
  assert.match(instructions, /identity：/u)
  assert.match(instructions, /brand_style：/u)
  assert.match(instructions, /delivery_spec：/u)
  assert.doesNotMatch(instructions, /composition：/u)
  // 未知判据原样交给模型，不静默跳过。
  assert.deepEqual(reviewCriteriaBriefing(['brand_new_axis']), ['brand_new_axis：按该判据名判断是否满足'])
})

test('未配置视觉模型时不返回评审器，调用方据此记为无法验证', () => {
  // 拿一个永远失败的评审器去跑，会把「没配置」变成一串「模型不可用」的假故障。
  assert.equal(createAgentReviewVisionJudge({ runtimeConfig: {} }), undefined)
  assert.equal(createAgentReviewVisionJudge({ runtimeConfig: { agentVisionModel: 'vision-1' } }), undefined)
  assert.ok(createAgentReviewVisionJudge({ runtimeConfig: { agentVisionModel: 'v', flockApiKey: 'k' } }))
})

test('逐判据返回结论与依据，并按失败判据产出修订建议', async () => {
  const judge = judgeWith({
    criteria: [
      { id: 'identity', verdict: 'pass', evidence: '人物一致' },
      { id: 'brand_style', verdict: 'fail', evidence: '主色偏蓝' },
      { id: 'delivery_spec', verdict: 'pass', evidence: '留白充足' },
    ],
    revision: '把主色调回品牌绿再出一版。',
  })
  const result = await judge({ candidate, task })
  assert.deepEqual(result.criteria.map((entry) => `${entry.id}:${entry.verdict}`), [
    'identity:pass', 'brand_style:fail', 'delivery_spec:pass',
  ])
  assert.ok(result.criteria.every((entry) => entry.layer === 'model'))
  assert.deepEqual(result.revisionProposal.failedCriteria, ['brand_style'])
  assert.equal(result.revisionProposal.qualityPolicyFingerprint, 'policy-fp')
})

test('全部通过时不产出修订建议', async () => {
  // 全通过还给建议会诱导无意义的重跑。
  const judge = judgeWith({
    criteria: task.qualityPolicy.requiredCriteria.map((id) => ({ id, verdict: 'pass', evidence: '符合' })),
    revision: '也可以再亮一点。',
  })
  assert.equal((await judge({ candidate, task })).revisionProposal, undefined)
})

test('模型漏答的判据判无法验证，不按通过处理', async () => {
  // 漏答不是合格。
  const judge = judgeWith({ criteria: [{ id: 'identity', verdict: 'pass', evidence: '一致' }] })
  const result = await judge({ candidate, task })
  assert.deepEqual(result.criteria.map((entry) => entry.verdict), ['pass', 'unverifiable', 'unverifiable'])
  assert.equal(result.criteria[1].evidence, '模型未对该判据作答。')
})

test('模型给了未声明的判据不会混进结论', async () => {
  const judge = judgeWith({
    criteria: [
      ...task.qualityPolicy.requiredCriteria.map((id) => ({ id, verdict: 'pass', evidence: 'ok' })),
      { id: 'made_up_axis', verdict: 'fail', evidence: '编的' },
    ],
  })
  const result = await judge({ candidate, task })
  assert.equal(result.criteria.length, 3)
  assert.equal(result.criteria.some((entry) => entry.id === 'made_up_axis'), false)
})

test('模型不可用与输出不可解析是两种不同的失败', async () => {
  // 收敛成一个空结果会让运维无从判断该重试还是该修解析。
  const unavailable = createAgentReviewVisionJudge({
    runtimeConfig: { agentVisionModel: 'v', flockApiKey: 'k' },
    resolveMedia,
    callModel: async () => { throw new Error('网关 502') },
  })
  await assert.rejects(
    () => unavailable({ candidate, task }),
    (error) => error instanceof AgentReviewVisionError && error.code === 'REVIEW_MODEL_UNAVAILABLE',
  )

  const unparsable = createAgentReviewVisionJudge({
    runtimeConfig: { agentVisionModel: 'v', flockApiKey: 'k' },
    resolveMedia,
    callModel: async () => ({ choices: [{ message: { content: '这不是 JSON' } }] }),
  })
  await assert.rejects(
    () => unparsable({ candidate, task }),
    (error) => error.code === 'REVIEW_OUTPUT_UNPARSABLE',
  )
})

test('取不到画面时不拿空图去问模型', async () => {
  let called = false
  const judge = createAgentReviewVisionJudge({
    runtimeConfig: { agentVisionModel: 'v', flockApiKey: 'k' },
    resolveMedia: async () => undefined,
    callModel: async () => { called = true; return {} },
  })
  const result = await judge({ candidate, task })
  assert.equal(called, false)
  assert.ok(result.criteria.every((entry) => entry.verdict === 'unverifiable'))
})

test('质量策略没有判据时如实返回无法验证，而不是抛错', async () => {
  const judge = judgeWith({ criteria: [] })
  const result = await judge({ candidate, task: { qualityPolicy: { requiredCriteria: [] } } })
  assert.equal(result.criteria[0].verdict, 'unverifiable')
})
