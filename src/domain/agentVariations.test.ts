import assert from 'node:assert/strict'
import test from 'node:test'
import {
  inferBotanicAgentIntent,
  resolveBotanicAgentIntent,
  botanicAgentLooksLikePlannerNarration,
  botanicAgentVisualGenerationPrompt,
} from './agent.ts'
import {
  applyBotanicAgentVariationToPlan,
  botanicAgentBranchGenerationPrompt,
  botanicAgentConfirmBranchDrafts,
  botanicAgentPlanOutputLabel,
  botanicAgentSharedVariationPrompt,
  expandBotanicAgentVariationBranches,
  instructionRequestsBatchVariation,
  resolveBotanicAgentVariationRequest,
} from './agentVariations.ts'

test('多个、几种、批量、一组会识别为批量变体，不压成换景', () => {
  assert.equal(instructionRequestsBatchVariation('多个肤色人物、多图'), true)
  assert.equal(instructionRequestsBatchVariation('做几种肤色版本'), true)
  assert.equal(instructionRequestsBatchVariation('批量换场景'), true)
  assert.equal(instructionRequestsBatchVariation('出一组变体'), true)
  assert.equal(instructionRequestsBatchVariation('保持人物、服装和商品不变，只替换场景与环境光线。'), false)
  assert.equal(inferBotanicAgentIntent('多个肤色人物、多图'), 'batch_variation')
  assert.equal(inferBotanicAgentIntent('保持衣服不变，换十个海边场景'), 'batch_variation')
  assert.equal(resolveBotanicAgentIntent('多个肤色人物、多图', 'replace_scene'), 'batch_variation')
  assert.equal(resolveBotanicAgentIntent('换成海边场景', 'replace_scene'), 'replace_scene')
})

test('各种肤色没有具体取值时必须追问，不能假装已批量', () => {
  const request = resolveBotanicAgentVariationRequest({
    instruction: '多个肤色人物、多图',
    requestedIntent: 'replace_scene',
  })
  assert.equal(request.kind, 'ask')
  assert.equal(request.clarification.fields.some((field) => field.id === 'variation_values'), true)
  assert.match(request.clarification.question, /肤色/)
})

test('列出 2–8 个短值时按单轴展开，张数由展开结果决定', () => {
  const request = resolveBotanicAgentVariationRequest({
    instruction: '白皙、自然、小麦、深棕四种肤色，多图',
  })
  assert.equal(request.kind, 'ready')
  assert.equal(request.spec.combine, false)
  assert.equal(request.spec.axes[0].label, '肤色')
  const branches = expandBotanicAgentVariationBranches(request.spec)
  assert.equal(branches.length, 4)
  assert.deepEqual(branches.map((branch) => branch.label), ['白皙', '自然', '小麦', '深棕'])
  assert.match(branches[0].promptDelta, /白皙/)
  assert.equal(request.spec.axes[0].values.every((value) => Array.from(value.label).length <= 8), true)
})

test('两轴未确认组合时只拆第一条轴，确认后才相乘且不超过 20 张', () => {
  const listed = '白皙、自然、小麦、深棕四种肤色，海边、森林、棚拍三个场景'
  const single = resolveBotanicAgentVariationRequest({ instruction: listed })
  assert.equal(single.kind, 'ready')
  assert.equal(expandBotanicAgentVariationBranches(single.spec).length, 4)

  const asked = resolveBotanicAgentVariationRequest({
    instruction: listed,
    clarificationAnswers: {},
  })
  assert.ok(asked.kind === 'ready' || asked.kind === 'ask')

  const combined = resolveBotanicAgentVariationRequest({
    instruction: listed,
    clarificationAnswers: { variation_combine: 'combine' },
  })
  assert.equal(combined.kind, 'ready')
  assert.equal(combined.spec.combine, true)
  assert.equal(expandBotanicAgentVariationBranches(combined.spec).length, 12)

  const tooMany = resolveBotanicAgentVariationRequest({
    instruction: '白皙、自然、小麦、深棕、冷白五种肤色，海边、森林、棚拍、街道、夜店五个场景，请组合',
    clarificationAnswers: { variation_combine: 'combine' },
  })
  assert.equal(tooMany.kind, 'ask')
  assert.match(tooMany.clarification.question, /20/)
})

test('追问答案里的取值可以补全模糊的肤色批量', () => {
  const request = resolveBotanicAgentVariationRequest({
    instruction: '各种肤色多出几张',
    clarificationAnswers: { variation_values: '白皙、自然、小麦、深棕' },
  })
  assert.equal(request.kind, 'ready')
  assert.equal(expandBotanicAgentVariationBranches(request.spec).length, 4)
})

test('规划说明不能当作生图 Prompt，分支只叠加本支增量', () => {
  const narration = '当前项目没有配置批量 Skill，还缺两个字段才能批量。\n\n请确认肤色取值。'
  assert.equal(botanicAgentLooksLikePlannerNarration(narration), true)
  assert.equal(
    botanicAgentSharedVariationPrompt(narration, '保持人物与白裙，只换肤色。白皙、自然、小麦、深棕四种。'),
    '保持人物与白裙，只换肤色。',
  )
  assert.equal(
    botanicAgentVisualGenerationPrompt(narration, '保持人物与白裙，只换肤色。'),
    '保持人物与白裙，只换肤色。',
  )
  assert.equal(
    botanicAgentBranchGenerationPrompt('保持人物与白裙，棚拍柔光。', '人物肤色为小麦，保持五官与身份不变。'),
    '保持人物与白裙，棚拍柔光。\n\n人物肤色为小麦，保持五官与身份不变。',
  )
})

test('无素材组时批量变体计划按展开分支出图，不回落成 1 张换景', () => {
  const applied = applyBotanicAgentVariationToPlan({
    intent: 'replace_scene',
    instruction: '白皙、自然、小麦、深棕四种肤色，多图',
    summary: '替换场景，生成 1 张新版本。',
    prompt: '项目没有配置批量 Skill，缺两个字段。',
    constraints: [
      { dimension: 'person', mode: 'preserve' },
      { dimension: 'scene', mode: 'vary' },
    ],
    output: { mode: 'single', count: 1, candidatesPerItem: 1 },
  }, {
    instruction: '白皙、自然、小麦、深棕四种肤色，多图',
    requestedIntent: 'replace_scene',
  })
  assert.equal(applied.kind, 'plan')
  assert.equal(applied.plan.intent, 'batch_variation')
  assert.deepEqual(applied.plan.output, { mode: 'batch_by_variation', count: 4, candidatesPerItem: 1 })
  assert.equal(applied.plan.prompt.includes('批量 Skill'), false)
  assert.match(applied.plan.summary, /4 张/)
  const drafts = botanicAgentConfirmBranchDrafts(applied.plan)
  assert.equal(drafts.length, 4)
  assert.equal(drafts.every((draft) => !draft.assetId && draft.variation?.promptDelta), true)
  assert.equal(botanicAgentPlanOutputLabel(applied.plan), '4 个分支')
})

test('模糊批量在模型已给出单张计划时仍改成追问卡，不进入确认生成', () => {
  const applied = applyBotanicAgentVariationToPlan({
    intent: 'replace_scene',
    instruction: '多个肤色人物、多图',
    summary: '替换场景，生成 1 张新版本。',
    prompt: '当前项目没有配置批量 Skill。',
    constraints: [{ dimension: 'scene', mode: 'vary' }],
    output: { mode: 'single', count: 1, candidatesPerItem: 1 },
  }, {
    instruction: '多个肤色人物、多图',
    requestedIntent: 'replace_scene',
  })
  assert.equal(applied.kind, 'clarification')
  assert.equal(applied.clarification.fields[0].id, 'variation_values')
})

test('匹配的素材组仍走按图批量，不改成变体轴', () => {
  const applied = applyBotanicAgentVariationToPlan({
    intent: 'replace_scene',
    instruction: '批量换场景',
    summary: '按夏日场景组生成 10 张。',
    prompt: '保持主体，逐一替换场景。',
    constraints: [{ dimension: 'scene', mode: 'vary', sourceAssetGroupId: 'group-scenes' }],
    output: { mode: 'batch_by_asset', count: 10, candidatesPerItem: 1 },
    assetGroupId: 'group-scenes',
  }, {
    instruction: '批量换场景',
    assetGroup: { id: 'group-scenes', role: '场景', assetCount: 10 },
  })
  assert.equal(applied.kind, 'plan')
  assert.deepEqual(applied.plan.output, { mode: 'batch_by_asset', count: 10, candidatesPerItem: 1 })
})
