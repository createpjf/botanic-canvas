import test from 'node:test'
import assert from 'node:assert/strict'
import { CreativePlanCompileError, buildCreativeConstraintPrompt, compileCreativePlan } from './botanicCreativePlanCompiler.mjs'

const baseRecipe = {
  references: [{ nodeId: 'asset-product', assetId: 'product-1', name: '香薰', role: '商品', primary: true, priority: 1 }],
  prompt: '一张自然光品牌视觉。',
  batchCount: 1,
  settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '1K' },
}

const plan = {
  intent: 'replace_scene',
  instruction: '换成海边背景',
  summary: '保持商品结构，变化场景',
  prompt: '白色香薰瓶放在桌面上，留出标题空间。',
  settings: baseRecipe.settings,
  constraints: [
    { dimension: 'product', mode: 'preserve' },
    { dimension: 'scene', mode: 'vary' },
  ],
  output: { mode: 'single', count: 1, candidatesPerItem: 1 },
}

test('compileCreativePlan compiles locked/vary constraints into an immutable recipe snapshot', () => {
  const result = compileCreativePlan({
    plan,
    baseRecipe,
    branch: {
      id: 'branch-1',
      label: '海边',
      variation: { values: [{ key: 'scene', axisLabel: '场景', valueLabel: '海边' }], promptDelta: '场景替换为海边。' },
    },
    models: [{ id: 'gpt-image-2', aspectRatios: ['3:4'], resolutions: ['1K'] }],
    memoryBindings: [{ id: 'memory-1', version: 2, contentHash: 'abc', selectionReason: '当前项目商品规则' }],
  })
  assert.equal(result.recipe.creativeIntent, 'replace_scene')
  assert.deepEqual(result.recipe.constraints, plan.constraints)
  assert.match(result.recipe.prompt, /必须保持：product/u)
  assert.match(result.recipe.prompt, /本分支变化：场景替换为海边。/u)
  assert.equal(result.recipe.memoryBindings[0].id, 'memory-1')
  assert.equal(result.recipe.sourcePlanFingerprint, result.compiled.sourceFingerprint)
  assert.equal(result.compiled.qualityPolicy.humanDecisionRequired, true)
})

test('constraint prompt supports English output without leaking Chinese contract labels', () => {
  const prompt = buildCreativeConstraintPrompt({
    locale: 'en',
    prompt: 'A product image.',
    constraints: [{ dimension: 'product', mode: 'preserve' }],
    branch: { variation: { promptDelta: 'Change the background to a beach.' } },
  })
  assert.match(prompt, /Must preserve: product\./u)
  assert.match(prompt, /Branch change: Change the background/u)
  assert.doesNotMatch(prompt, /必须保持/u)
})

test('compiler rejects conflicting constraints and unsupported settings before a Job is created', () => {
  assert.throws(() => compileCreativePlan({
    plan: { ...plan, constraints: [{ dimension: 'scene', mode: 'preserve' }, { dimension: 'scene', mode: 'vary' }] },
    baseRecipe,
  }), (error) => error instanceof CreativePlanCompileError && error.code === 'PLAN_CONSTRAINT_CONFLICT')
  assert.throws(() => compileCreativePlan({
    plan,
    baseRecipe,
    models: [{ id: 'other', aspectRatios: ['1:1'], resolutions: ['1K'] }],
  }), (error) => error instanceof CreativePlanCompileError && error.code === 'MODEL_NOT_CONFIGURED')
})

test('同一次确认的所有分支共享 plan 级指纹，分支指纹由它派生', () => {
  // 只有 plan 级指纹能回答「这两张图是不是同一次确认出来的」；早期指纹把分支混进
  // 哈希，分支之间互不相关，这个问题无从回答。
  const compileBranch = (id, valueLabel) => compileCreativePlan({
    plan, baseRecipe,
    branch: { id, label: valueLabel, variation: { values: [{ key: 'scene', axisLabel: '场景', valueLabel }] } },
    models: [{ id: 'gpt-image-2', aspectRatios: ['3:4'], resolutions: ['1K'] }],
  }).compiled

  const first = compileBranch('branch-1', '海边')
  const second = compileBranch('branch-2', '森林')
  assert.equal(first.planFingerprint, second.planFingerprint)
  assert.notEqual(first.branchFingerprint, second.branchFingerprint)
  // 兼容名指向本分支，配方两侧一致。
  assert.equal(first.sourceFingerprint, first.branchFingerprint)

  // 计划本身变了就不再是同一次确认。
  const otherPlan = compileBranch('branch-1', '海边')
  assert.equal(otherPlan.planFingerprint, first.planFingerprint)
  const changed = compileCreativePlan({
    plan: { ...plan, prompt: '换成完全不同的画面描述。' }, baseRecipe,
    branch: { id: 'branch-1', label: '海边', variation: { values: [{ key: 'scene', axisLabel: '场景', valueLabel: '海边' }] } },
    models: [{ id: 'gpt-image-2', aspectRatios: ['3:4'], resolutions: ['1K'] }],
  }).compiled
  assert.notEqual(changed.planFingerprint, first.planFingerprint)
})

test('无分支编译同样给出 plan 级指纹，且与带分支的那一支可区分', () => {
  const single = compileCreativePlan({ plan, baseRecipe }).compiled
  assert.ok(single.planFingerprint)
  assert.notEqual(single.branchFingerprint, single.planFingerprint)
})
