import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_EVALUATOR_SKILLS,
  createEvaluatorSkillRunner,
  evaluatorCallEstimate,
  evaluatorCriterionId,
  evaluatorSkillCriteria,
  runEvaluatorSkillCriterion,
} from './agentReviewSkillEvaluator.mjs'
import { normalizeAgentSkillManifest } from './botanicAgentSkill.mjs'

const evaluatorManifest = {
  kind: 'evaluator',
  toolAllowlist: ['canvas_read'],
  outputSchema: {
    type: 'object',
    required: ['verdict'],
    properties: {
      verdict: { type: 'string', enum: ['pass', 'fail', 'unverifiable'] },
      evidence: { type: 'string', maxLength: 200 },
    },
  },
}

const skill = (extra = {}) => ({
  id: 'skill-compliance', name: '合规审核', instructions: '不得出现绝对化用语。',
  lifecycle: 'published', status: 'active', version: 2, contentHash: 'hash-2',
  manifest: normalizeAgentSkillManifest(evaluatorManifest),
  ...extra,
})

const task = { id: 'task-1', projectId: 'p-1', ownerId: 'u-1' }
const candidate = { artifactId: 'generation:job-1:out-1', output: { image: '/api/media/m-1' } }

const registry = { get: (name) => (name === 'canvas_read' ? { name, risk: 'read' } : undefined) }

test('判据标识带 Skill 版本', () => {
  // 不带版本的话，Skill 改了之后旧结论会看起来像是新规则判出来的。
  assert.equal(evaluatorCriterionId(skill()), 'skill.skill-compliance@2')
  assert.notEqual(evaluatorCriterionId(skill({ version: 3 })), evaluatorCriterionId(skill()))
})

test('只有已发布的 evaluator Skill 进判据集合', () => {
  const criteria = evaluatorSkillCriteria([
    skill(),
    // guidance 形态不是判据。
    skill({ id: 'guide', manifest: normalizeAgentSkillManifest({ kind: 'guidance', toolAllowlist: [] }) }),
    // draft 还没人批准过，不该决定结果合不合格。
    skill({ id: 'draft', lifecycle: 'draft' }),
    { id: 'legacy', name: '存量', instructions: 'x', status: 'active' },
  ])
  assert.deepEqual(criteria.map((item) => item.skillId), ['skill-compliance'])
  assert.equal(criteria[0].instructions, '不得出现绝对化用语。')
  assert.equal(criteria[0].contentHash, 'hash-2')
})

test('自定义判据数量有硬上限', () => {
  // 上限低是因为每条都乘以候选数。
  const many = Array.from({ length: 6 }, (_, index) => skill({ id: `skill-${index}` }))
  assert.equal(evaluatorSkillCriteria(many).length, MAX_EVALUATOR_SKILLS)
})

test('成本能在评审开始前算出来', () => {
  // 用户加了 3 条判据却不知道评审费用翻了 3 倍，是这个功能最容易造成的伤害。
  const policy = { evaluatorSkills: evaluatorSkillCriteria([skill(), skill({ id: 'b' }), skill({ id: 'c' })]) }
  assert.deepEqual(evaluatorCallEstimate(policy, 5), { criteria: 3, candidates: 5, calls: 15 })
  assert.deepEqual(evaluatorCallEstimate({}, 5), { criteria: 0, candidates: 5, calls: 0 })
})

test('正常判定回带 Skill 版本', async () => {
  const judgeWith = () => async () => ({ verdict: 'fail', evidence: '出现「最」字' })
  const result = await runEvaluatorSkillCriterion({
    criterion: evaluatorSkillCriteria([skill()])[0], candidate, task, judgeWith, registry, now: () => 1,
  })
  assert.equal(result.verdict, 'fail')
  assert.equal(result.evidence, '出现「最」字')
  assert.equal(result.layer, 'model')
  // 历史评审要说得清当时按哪一版判的。
  assert.equal(result.skillId, 'skill-compliance')
  assert.equal(result.skillVersion, 2)
})

test('输出不合 Schema 时判无法验证，不是静默通过', async () => {
  const judgeWith = () => async () => ({ notVerdict: '随便什么' })
  const result = await runEvaluatorSkillCriterion({
    criterion: evaluatorSkillCriteria([skill()])[0], candidate, task, judgeWith, registry, now: () => 1,
  })
  assert.equal(result.verdict, 'unverifiable')
  assert.match(result.evidence, /未完成（output_invalid）/u)
})

test('一条自定义判据配错不让整个评审失败', async () => {
  // Skill 的白名单里带了需要确认的工具：子任务治理会拒绝，但那只该让这一条判据
  // 记为无法验证，其余判据照常。
  const broken = {
    ...evaluatorSkillCriteria([skill()])[0],
    toolAllowlist: ['generation_submit'],
  }
  const result = await runEvaluatorSkillCriterion({
    criterion: broken, candidate, task,
    judgeWith: () => async () => ({ verdict: 'pass' }),
    registry: { get: (name) => (name === 'generation_submit' ? { name, risk: 'costly', requiresConfirmation: true } : undefined) },
    now: () => 1,
  })
  assert.equal(result.verdict, 'unverifiable')
  assert.match(result.evidence, /自定义判据无法执行/u)
  assert.match(result.evidence, /需要用户确认/u)
})

test('子任务超时按 unverifiable 收口并带出原因', async () => {
  // 超时、预算用尽与越权是三种不同的运维问题，收口时必须区分得开。
  const judgeWith = () => ({ signal }) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ verdict: 'pass' }), 30_000)
    timer.unref?.()
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) })
  })
  const result = await runEvaluatorSkillCriterion({
    criterion: evaluatorSkillCriteria([skill()])[0], candidate, task, judgeWith, registry,
    timeoutMs: 1_000, now: () => 1,
  })
  assert.equal(result.verdict, 'unverifiable')
  assert.match(result.evidence, /未完成（timeout）/u)
  assert.equal(result.skillVersion, 2, '超时也要说得清是哪一版判的')
})

test('未配置视觉模型时不返回执行器', () => {
  // 拿一个永远失败的执行器去跑，会把「没配模型」变成一串看不懂的失败。
  assert.equal(createEvaluatorSkillRunner({ runtimeConfig: {} }), undefined)
  assert.equal(typeof createEvaluatorSkillRunner({
    runtimeConfig: { agentVisionModel: 'vision-1', flockApiKey: 'k' },
  }), 'function')
})

test('取不到画面时如实判无法验证，不拿空图去问模型', async () => {
  let called = 0
  const judgeWith = createEvaluatorSkillRunner({
    runtimeConfig: { agentVisionModel: 'vision-1', flockApiKey: 'k' },
    resolveMedia: async () => undefined,
    callModel: async () => { called += 1; return {} },
  })
  const result = await runEvaluatorSkillCriterion({
    criterion: evaluatorSkillCriteria([skill()])[0], candidate, task, judgeWith, registry, now: () => 1,
  })
  assert.equal(result.verdict, 'unverifiable')
  assert.equal(result.evidence, '无法读取该候选的画面。')
  assert.equal(called, 0, '不该发起模型调用')
})

test('执行器把 Skill 正文交给模型，并要求只输出 JSON', async () => {
  const seen = []
  const judgeWith = createEvaluatorSkillRunner({
    runtimeConfig: { agentVisionModel: 'vision-1', flockApiKey: 'k' },
    resolveMedia: async () => 'data:image/png;base64,AA',
    callModel: async ({ messages }) => {
      seen.push(messages)
      return { choices: [{ message: { content: '{"verdict":"pass","evidence":"未见绝对化用语"}' } }] }
    },
  })
  const result = await runEvaluatorSkillCriterion({
    criterion: evaluatorSkillCriteria([skill()])[0], candidate, task, judgeWith, registry, now: () => 1,
  })
  assert.equal(result.verdict, 'pass')
  assert.equal(result.evidence, '未见绝对化用语')
  const system = seen[0][0].content
  assert.match(system, /不得出现绝对化用语。/u, 'Skill 正文进了提示词')
  assert.match(system, /只输出 JSON/u)
  assert.match(system, /看不出来必须给 unverifiable/u)
})
