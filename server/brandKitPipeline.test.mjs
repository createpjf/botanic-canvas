import assert from 'node:assert/strict'
import test from 'node:test'
import { compileCreativePlan } from './botanicCreativePlanCompiler.mjs'
import { resolveBrandKit } from './brandKit.mjs'
import { resolveRunBrandKit } from './creativePlanResolver.mjs'
import { createAgentReviewTask } from './agentReviewTask.mjs'
import { createAgentReviewResult } from './agentReviewTask.mjs'
import { createAgentReviewVisionJudge, reviewVisionInstructions } from './agentReviewVision.mjs'

/**
 * Brand Kit 的**贯通**测试（Epic 9.1）。
 *
 * 单元测试只能证明 `brandKit.mjs` 自己算得对。这里证明的是那份结果真的到达了两个
 * 消费方：编译进执行 Prompt、并作为逐条判据进入结果 QA。Epic 6 的教训就是这个 ——
 * `brandRules` 派生了、落库了，却从不进入任何一次生成，而所有单元测试都是绿的。
 */

const kit = {
  brandId: 'botanic',
  rules: [
    { id: 'g-color', facet: 'color', statement: '主色只用品牌绿 #1F5C3A' },
    { id: 'g-ban', facet: 'prohibition', statement: '画面中不得出现竞品包装' },
    { id: 'g-layout', facet: 'layout', enforcement: 'should', statement: '顶部留出 15% 文案安全区' },
  ],
}

const baseRecipe = { prompt: '拍一张香水首图', settings: { model: 'gpt-image-2', aspectRatio: '3:4' }, references: [], batchCount: 1 }
const plan = { intent: 'initial_generation', prompt: '拍一张香水首图', settings: baseRecipe.settings }

test('品牌规则真的进了执行 Prompt，且排在执行契约之前', () => {
  const brandKit = resolveBrandKit({ brandId: 'botanic', global: kit })
  const { compiled } = compileCreativePlan({
    plan: { ...plan, constraints: [{ dimension: 'product', mode: 'preserve' }] },
    baseRecipe,
    brandKit,
  })
  assert.match(compiled.prompt, /必须遵守的品牌规则：/u)
  assert.match(compiled.prompt, /主色只用品牌绿 #1F5C3A/u)
  assert.match(compiled.prompt, /绝不：画面中不得出现竞品包装/u)
  // 品牌是跨 Run 的外层边界，排在本次执行契约之前；顺序颠倒会让模型在冲突时先放弃品牌。
  assert.ok(compiled.prompt.indexOf('必须遵守的品牌规则：') < compiled.prompt.indexOf('执行契约：'))
  // 原始画面描述仍在最后，没有被规则挤掉。
  assert.ok(compiled.prompt.endsWith('拍一张香水首图'))
})

test('没有品牌时编译结果与今天完全一致', () => {
  // 未绑定品牌的项目不该因为这次改动多出任何内容。
  const withoutBrand = compileCreativePlan({ plan, baseRecipe }).compiled
  assert.equal(withoutBrand.prompt, '拍一张香水首图')
  assert.equal(withoutBrand.brandKitFingerprint, undefined)
  assert.equal(withoutBrand.qualityPolicy.brandCriteria, undefined)
})

test('品牌规则逐条进入质量策略，并带上强制度', () => {
  const brandKit = resolveBrandKit({ brandId: 'botanic', global: kit })
  const { compiled } = compileCreativePlan({ plan, baseRecipe, brandKit })
  const byId = new Map(compiled.qualityPolicy.brandCriteria.map((item) => [item.id, item]))
  assert.equal(byId.get('brand.color.default').statement, '主色只用品牌绿 #1F5C3A')
  assert.equal(byId.get('brand.prohibition.default').enforcement, 'must')
  assert.equal(byId.get('brand.layout.default').enforcement, 'should')
  assert.equal(compiled.brandId, 'botanic')
  assert.ok(compiled.brandKitFingerprint)
})

test('换一套品牌规则会改变计划指纹与评审任务标识', () => {
  const policyOf = (rules) => compileCreativePlan({
    plan, baseRecipe, brandKit: resolveBrandKit({ brandId: 'botanic', global: { brandId: 'botanic', rules } }),
  }).compiled
  const before = policyOf(kit.rules)
  const after = policyOf([...kit.rules.slice(0, 2), { id: 'g-layout', facet: 'layout', statement: '顶部留出 30% 安全区' }])
  assert.notEqual(before.branchFingerprint, after.branchFingerprint)

  const taskOf = (compiled) => createAgentReviewTask({
    runId: 'run-1', projectId: 'p-1', ownerId: 'u-1', qualityPolicy: compiled.qualityPolicy, now: 1,
  })
  // 任务标识由 (runId, qualityPolicyFingerprint) 决定。品牌规则改了却不改指纹，
  // 重新评审会命中旧任务直接返回，用户以为按新规则复核过了。
  assert.notEqual(taskOf(before).qualityPolicyFingerprint, taskOf(after).qualityPolicyFingerprint)
  assert.notEqual(taskOf(before).id, taskOf(after).id)
})

test('没有品牌判据时评审任务指纹与改动前保持一致', () => {
  // 空数组也进哈希的话，所有存量策略的指纹都会变，每个已评审完的 Run 都会再评一次，
  // 白付一遍视觉模型的钱。
  const task = createAgentReviewTask({
    runId: 'run-1', projectId: 'p-1', ownerId: 'u-1', now: 1,
    qualityPolicy: { version: 1, requiredCriteria: ['identity', 'brand_style'], humanDecisionRequired: true },
  })
  // 常量取自改动**之前**的实现实测输出，不是照着改动后的结果抄回来的。
  assert.equal(task.qualityPolicyFingerprint, 'IKnPe7hVfPcTAx3uRex3Ot1dIPFIbWHkVQ3Ml360oM8')
  assert.equal(task.id, 'review_task_lnOkboUxfcV9W8srZkjsblHN5dFAXGRJ')
})

test('视觉评审拿到的是规则原文，不再是一句空泛的品牌风格', () => {
  const brandKit = resolveBrandKit({ brandId: 'botanic', global: kit })
  const { compiled } = compileCreativePlan({ plan, baseRecipe, brandKit })
  const instructions = reviewVisionInstructions(compiled.qualityPolicy.requiredCriteria, compiled.qualityPolicy.brandCriteria)
  assert.match(instructions, /brand\.color\.default（必须满足）：主色只用品牌绿 #1F5C3A/u)
  assert.match(instructions, /brand\.layout\.default（尽量满足）：顶部留出 15% 文案安全区/u)
})

test('QA 结论逐条关联到品牌规则与它所在的层', async () => {
  const brandKit = resolveBrandKit({
    brandId: 'botanic',
    global: kit,
    project: { brandId: 'botanic', rules: [{ id: 'p-color', facet: 'color', statement: '本项目主色改用深绿' }] },
  })
  const { compiled } = compileCreativePlan({ plan, baseRecipe, brandKit })
  const judge = createAgentReviewVisionJudge({
    runtimeConfig: { agentVisionModel: 'vision-1', flockApiKey: 'k' },
    resolveMedia: async () => 'data:image/png;base64,AA',
    callModel: async () => ({
      choices: [{ message: { content: JSON.stringify({
        criteria: [
          ...compiled.qualityPolicy.requiredCriteria.map((id) => ({ id, verdict: 'pass', evidence: '符合' })),
          { id: 'brand.color.default', verdict: 'fail', evidence: '主色偏蓝' },
          { id: 'brand.prohibition.default', verdict: 'pass', evidence: '无竞品' },
          { id: 'brand.layout.default', verdict: 'fail', evidence: '顶部留白不足' },
        ],
        revision: '把主色调回品牌深绿',
      }) } }],
    }),
  })
  const judged = await judge({ candidate: { output: { image: 'x' } }, task: compiled })
  const byId = new Map(judged.criteria.map((item) => [item.id, item]))

  const colorVerdict = byId.get('brand.color.default')
  assert.equal(colorVerdict.verdict, 'fail')
  // 只有判据名的话，用户看到 fail 也不知道违反了哪条规则、来自哪一层。
  assert.equal(colorVerdict.brandRuleId, 'p-color')
  assert.equal(colorVerdict.brandLayer, 'project')
  assert.equal(colorVerdict.brandFacet, 'color')

  // 溯源字段要能活过持久化归一。
  const result = createAgentReviewResult({
    taskId: 't-1', projectId: 'p-1', artifactId: 'a-1', criteria: judged.criteria, now: 1,
  })
  const persisted = result.criteria.find((item) => item.id === 'brand.color.default')
  assert.equal(persisted.brandRuleId, 'p-color')
  assert.equal(persisted.brandLayer, 'project')
  // 「尽量」不满足是让步，不该把整个候选判成不合格。
  assert.equal(result.criteria.find((item) => item.id === 'brand.layout.default').enforcement, 'should')
  assert.equal(result.verdict, 'fail', '必须项 brand.color.default 不合格，因此候选不合格')

  const conceded = createAgentReviewResult({
    taskId: 't-1', projectId: 'p-1', artifactId: 'a-2', now: 1,
    criteria: judged.criteria.map((item) => (item.id === 'brand.color.default' ? { ...item, verdict: 'pass' } : item)),
  })
  assert.equal(conceded.verdict, 'pass', '只有 should 不满足时是让步，不是不合格')
})

test('Resolve 侧：未绑定品牌的项目拿不到任何品牌规则', () => {
  assert.equal(resolveRunBrandKit({ run: { plan: {} }, document: {} }), undefined)
  // 绑了品牌但全局套件属于别的品牌：当作没有那一层，而不是把别人的规则套上来。
  assert.equal(resolveRunBrandKit({
    run: { plan: {} }, document: { brandId: 'botanic' }, globalBrandKit: { brandId: 'other', rules: kit.rules },
  }), undefined)
})

test('Resolve 侧：三层齐备时按就近覆盖，配置冲突在执行前阻断', () => {
  const resolved = resolveRunBrandKit({
    run: { plan: { brandKitOverride: { rules: [{ id: 'r-color', facet: 'color', statement: '本次改用米白' }] } } },
    document: { brandId: 'botanic', brandKit: { brandId: 'botanic', rules: [{ id: 'p-color', facet: 'color', statement: '项目用深绿' }] } },
    globalBrandKit: kit,
  })
  assert.equal(resolved.rules.find((item) => item.slot === 'color.default').id, 'r-color')
  assert.equal(resolved.rules.find((item) => item.slot === 'prohibition.default').id, 'g-ban')

  // 项目绑错品牌时必须在执行前失败，且带上阶段与错误码 —— 放行等于按残缺规则生成。
  assert.throws(() => resolveRunBrandKit({
    run: { plan: {} },
    document: { brandId: 'botanic', brandKit: { brandId: 'wrong-brand', rules: kit.rules } },
    globalBrandKit: kit,
  }), (error) => error.code === 'BRAND_KIT_BRAND_MISMATCH' && error.stage === 'resolve')
})
