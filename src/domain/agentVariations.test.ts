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
  botanicAgentBriefWithVariationAnswers,
  botanicAgentConfirmBranchDrafts,
  botanicAgentPendingVariationClarification,
  botanicAgentPlanBranchPrompts,
  botanicAgentPlanConfirmActionLabel,
  botanicAgentPlanOutputLabel,
  botanicAgentPlanSheetCountLabel,
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

test('单图指令里的多个、2个、一组不能当成批量', () => {
  assert.equal(instructionRequestsBatchVariation('保持多个细节不变，把背景换成海边黄昏'), false)
  assert.equal(instructionRequestsBatchVariation('画面里加2个道具，保持人物不变'), false)
  assert.equal(instructionRequestsBatchVariation('模特换一组更自然的姿态'), false)
  assert.equal(inferBotanicAgentIntent('保持多个细节不变，把背景换成海边黄昏'), 'replace_scene')
  assert.equal(inferBotanicAgentIntent('模特换一组更自然的姿态'), 'change_pose')
  assert.equal(resolveBotanicAgentIntent('保持多个细节不变，把背景换成海边黄昏', 'replace_scene'), 'replace_scene')
  assert.equal(resolveBotanicAgentVariationRequest({
    instruction: '保持多个细节不变，把背景换成海边黄昏',
    requestedIntent: 'replace_scene',
  }).kind, 'none')
  assert.equal(resolveBotanicAgentVariationRequest({
    instruction: '画面里加2个道具，保持人物不变',
  }).kind, 'none')
  assert.equal(resolveBotanicAgentVariationRequest({
    instruction: '模特换一组更自然的姿态',
  }).kind, 'none')
})

test('修饰语和轴名不能当成变体取值，缺枚举时要追问', () => {
  assert.equal(resolveBotanicAgentVariationRequest({
    instruction: '让服装质感更细腻，多种材质层次',
  }).kind, 'none')

  const vague = resolveBotanicAgentVariationRequest({
    instruction: '肤色、场景、动作、风格、人物、服装都多来几个',
  })
  assert.equal(vague.kind, 'ask')
  assert.equal(vague.kind === 'ask' && /人物肤色为动作|动作调整为风格|场景替换为动作/.test(JSON.stringify(vague)), false)

  const scenes = resolveBotanicAgentVariationRequest({
    instruction: '换成海边、森林、街道三个场景',
  })
  assert.equal(scenes.kind, 'ready')
  assert.deepEqual(scenes.spec.axes[0].values.map((value) => value.label), ['海边', '森林', '街道'])

  const mismatched = resolveBotanicAgentVariationRequest({
    instruction: '海边、森林三个场景',
  })
  assert.equal(mismatched.kind, 'ask')
  assert.match(mismatched.clarification.question, /场景/)
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

test('斜杠分隔的短值也能展开成变体轴', () => {
  const request = resolveBotanicAgentVariationRequest({
    instruction: '浅 / 中 / 深 / 极深四档肤色，多图',
  })
  assert.equal(request.kind, 'ready')
  assert.deepEqual(request.spec.axes[0].values.map((value) => value.label), ['浅', '中', '深', '极深'])
})

test('Markdown 表格里的斜杠肤色档也能展开成 4 支', () => {
  const request = resolveBotanicAgentVariationRequest({
    instruction: [
      '结论：多肤色批量计划已就绪。',
      '| 字段 | 推荐值 | 说明 |',
      '|---|---|---|',
      '| 变体数量 | 4 个 | 每档肤色生成 1 张 |',
      '| 肤色档位 | 浅 / 中 / 深 / 极深 | 四档递进 |',
    ].join('\n'),
  })
  assert.equal(request.kind, 'ready')
  assert.deepEqual(request.spec.axes[0].values.map((value) => value.label), ['浅', '中', '深', '极深'])
  assert.equal(expandBotanicAgentVariationBranches(request.spec).length, 4)
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

test('共享底回退到原指令时也要剥掉创作简报附录', () => {
  const spec = {
    axes: [{
      key: 'scene', label: '场景',
      values: [
        { label: '海边', promptDelta: '场景替换为海边，保持人物、服装与商品不变。' },
        { label: '沙漠', promptDelta: '场景替换为沙漠，保持人物、服装与商品不变。' },
      ],
    }],
    combine: false,
  }
  const shared = botanicAgentSharedVariationPrompt(
    '海边、沙漠',
    '在海边和在沙漠拍摄同一位模特\n\n创作简报：\n- Prompt 优化方向：保真自然',
    spec,
  )
  assert.ok(!shared.includes('创作简报'), shared)
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

test('肤色确认一次后沉淀在 Brief 上，后续轮次不再重复追问', () => {
  const brief = {
    version: 1 as const,
    mode: 'generation' as const,
    originalInstruction: '@批量变量生成 生成多个肤色的任务',
    output: {},
    creative: {},
    provenance: {},
  }
  const asked = resolveBotanicAgentVariationRequest({ instruction: brief.originalInstruction, brief })
  assert.equal(asked.kind, 'ask')
  assert.equal(asked.clarification.brief?.variation?.axisKey, 'skin_tone')

  const answers = { variation_values: '白、黑、黄' }
  const remembered = botanicAgentBriefWithVariationAnswers(asked.clarification.brief, answers)
  assert.deepEqual(remembered?.variation, { axisKey: 'skin_tone', values: ['白', '黑', '黄'] })

  // 下一轮只带 Brief、不带本轮答案，仍应直接展开 3 支而不是再问一次肤色。
  const resumed = resolveBotanicAgentVariationRequest({
    instruction: brief.originalInstruction,
    brief: remembered,
  })
  assert.equal(resumed.kind, 'ready')
  assert.deepEqual(resumed.spec.axes[0].values.map((value) => value.label), ['白', '黑', '黄'])
  assert.equal(expandBotanicAgentVariationBranches(resumed.spec).length, 3)
  assert.equal(botanicAgentPendingVariationClarification({
    instruction: brief.originalInstruction,
    brief: remembered,
  }), undefined)
})

test('已确认肤色数决定分支数，每支一条点名该肤色的独立提示词', () => {
  const applied = applyBotanicAgentVariationToPlan({
    intent: 'replace_scene',
    instruction: '生成多个肤色的任务',
    summary: '替换场景，生成 1 张新版本。',
    prompt: '以画布上的黑人女性图为参考，保持场景、构图与光影不变。',
    constraints: [{ dimension: 'scene', mode: 'vary' }],
    output: { mode: 'single', count: 1, candidatesPerItem: 1 },
  }, {
    instruction: '生成多个肤色的任务',
    brief: {
      version: 1,
      mode: 'generation',
      originalInstruction: '生成多个肤色的任务',
      output: {},
      creative: {},
      variation: { axisKey: 'skin_tone', values: ['白', '黑', '黄'] },
      provenance: {},
    },
  })
  assert.equal(applied.kind, 'plan')
  assert.equal(applied.plan.output.count, 3)

  const branches = botanicAgentPlanBranchPrompts(applied.plan as Parameters<typeof botanicAgentPlanBranchPrompts>[0])
  assert.deepEqual(branches.map((branch) => branch.label), ['白', '黑', '黄'])
  assert.equal(new Set(branches.map((branch) => branch.prompt)).size, 3)
  branches.forEach((branch) => {
    assert.match(branch.prompt, /黑人女性图为参考/)
    assert.match(branch.prompt, new RegExp(`人物肤色为${branch.label}`))
  })
})

test('肤色×族裔组合出 6 支，每支叠加两条增量', () => {
  const instruction = '白皙、小麦、黄色三档肤色，白人、亚洲人两种族裔，组合出 6 张'
  assert.equal(instructionRequestsBatchVariation('做几个肤色和族裔的组合版本'), true)
  const request = resolveBotanicAgentVariationRequest({ instruction })
  assert.equal(request.kind, 'ready')
  assert.equal(request.spec.combine, true)
  const branches = expandBotanicAgentVariationBranches(request.spec)
  assert.equal(branches.length, 6)
  assert.match(branches[0].promptDelta, /肤色为白皙/)
  assert.match(branches[0].promptDelta, /族裔特征调整为白人/)
})

test('非批量计划没有分支提示词列表', () => {
  assert.deepEqual(botanicAgentPlanBranchPrompts({
    output: { mode: 'single', count: 1, candidatesPerItem: 1 },
    prompt: '换成海边黄昏。',
  }), [])
})

test('编号清单和「一个在」不会进入共享底，沙漠支不含海边或宇宙', () => {
  const instruction = '1. 一个在海边 2. 一个在沙漠里 3. 一个在宇宙，多图'
  const request = resolveBotanicAgentVariationRequest({ instruction })
  assert.equal(request.kind, 'ready')
  assert.equal(request.spec.axes[0].key, 'scene')
  assert.deepEqual(request.spec.axes[0].values.map((value) => value.label), ['海边', '沙漠', '宇宙'])
  assert.match(request.spec.axes[0].values[1].promptDelta, /场景替换为沙漠/)

  const inventory = [
    '请按下面三套场景分别出图。',
    '1. 海边日落，人物站在沙滩。',
    '2. 沙漠正午，热浪与沙丘。',
    '3. 宇宙星空，远处是行星。',
  ].join('\n')
  const shared = botanicAgentSharedVariationPrompt(inventory, instruction, request.spec)
  assert.equal(shared.includes('海边'), false)
  assert.equal(shared.includes('沙漠'), false)
  assert.equal(shared.includes('宇宙'), false)

  const applied = applyBotanicAgentVariationToPlan({
    intent: 'replace_scene',
    instruction,
    summary: '换场景',
    prompt: inventory,
    constraints: [{ dimension: 'scene', mode: 'vary' }],
    output: { mode: 'single', count: 1, candidatesPerItem: 1 },
  }, { instruction })
  assert.equal(applied.kind, 'plan')
  const desert = botanicAgentPlanBranchPrompts(applied.plan as Parameters<typeof botanicAgentPlanBranchPrompts>[0])
    .find((branch) => branch.label.includes('沙漠'))
  assert.ok(desert)
  assert.equal(desert.delta.includes('场景替换为沙漠'), true)
  assert.equal(desert.prompt.includes('海边'), false)
  assert.equal(desert.prompt.includes('宇宙'), false)
})

test('清洗后仍含多个取值时共享底回退到 fallbackPrompt', () => {
  const instruction = '1. 一个在海边 2. 一个在沙漠里 3. 一个在宇宙，多图'
  const inventory = '1. 海边 2. 沙漠 3. 宇宙。海边沙漠宇宙都要出图。'
  const applied = applyBotanicAgentVariationToPlan({
    intent: 'replace_scene',
    instruction,
    summary: '换场景',
    prompt: inventory,
    constraints: [{ dimension: 'scene', mode: 'vary' }],
    output: { mode: 'single', count: 1, candidatesPerItem: 1 },
  }, {
    instruction,
    fallbackPrompt: '保持人物身份、白裙与商品，棚拍柔光。',
  })
  assert.equal(applied.kind, 'plan')
  assert.equal(applied.plan.prompt, '保持人物身份、白裙与商品，棚拍柔光。')
})

test('执行链路元话语和创作简报拼接段不能切成自定义变体', () => {
  const harness = [
    '在画布/执行界面触发这批生成节点，执行链路会按交接计划读取 Mia 素材并出图；',
    '',
    '创作简报：',
    '- 交付用途：小红书，画面比例 3:4',
    '- Prompt 优化方向：杂志氛围',
  ].join('\n')
  assert.equal(resolveBotanicAgentVariationRequest({ instruction: harness }).kind, 'none')
  assert.equal(resolveBotanicAgentVariationRequest({
    instruction: '在画布/执行界面触发这批生成节点，执行链路会按交接计划读取 Mia 素材并出图；',
  }).kind, 'none')

  const applied = applyBotanicAgentVariationToPlan({
    intent: 'initial_generation',
    instruction: harness,
    summary: '首次生成',
    prompt: harness,
    constraints: [],
    output: { mode: 'single', count: 1, candidatesPerItem: 1 },
  }, { instruction: harness, requestedIntent: 'initial_generation' })
  assert.equal(applied.kind, 'plan')
  assert.equal(applied.plan.intent, 'initial_generation')
  assert.equal(applied.plan.output.mode, 'single')
  assert.equal(applied.plan.variation, undefined)
})

test('目录轴枚举和已确认取值仍可展开，不依赖自定义标点兜底', () => {
  const scenes = resolveBotanicAgentVariationRequest({
    instruction: '海边、沙漠、森林',
  })
  assert.equal(scenes.kind, 'ready')
  assert.equal(scenes.spec.axes[0].key, 'scene')
  assert.deepEqual(scenes.spec.axes[0].values.map((value) => value.label), ['海边', '沙漠', '森林'])

  const confirmed = resolveBotanicAgentVariationRequest({
    instruction: '按确认的取值出图',
    clarificationAnswers: { variation_values: '画布、天台、雨夜' },
  })
  assert.equal(confirmed.kind, 'ready')
  assert.deepEqual(confirmed.spec.axes[0].values.map((value) => value.label), ['画布', '天台', '雨夜'])
})

test('首次生成按变体展开时保留 initial_generation，不改写成需要父结果的意图', () => {
  const applied = applyBotanicAgentVariationToPlan({
    intent: 'initial_generation',
    instruction: '白皙、自然、小麦、深棕四种肤色，多图',
    summary: '首次生成 1 张。',
    prompt: '基于 Mia 氛围肖像，保持人物身份。',
    constraints: [],
    output: { mode: 'single', count: 1, candidatesPerItem: 1 },
  }, {
    instruction: '白皙、自然、小麦、深棕四种肤色，多图',
    requestedIntent: 'initial_generation',
  })
  assert.equal(applied.kind, 'plan')
  assert.equal(applied.plan.intent, 'initial_generation')
  assert.deepEqual(applied.plan.output, { mode: 'batch_by_variation', count: 4, candidatesPerItem: 1 })
  assert.equal(applied.plan.variation?.axes[0].key, 'skin_tone')
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

test('确认卡张数与生成按钮用张，不把分支节点当常驻标题', () => {
  const single = { output: { mode: 'single' as const, count: 1, candidatesPerItem: 1 } }
  const batch = { output: { mode: 'batch_by_variation' as const, count: 2, candidatesPerItem: 1 } }
  assert.equal(botanicAgentPlanSheetCountLabel(single), '1 张')
  assert.equal(botanicAgentPlanSheetCountLabel(batch), '2 张')
  assert.equal(botanicAgentPlanConfirmActionLabel(single), '生成')
  assert.equal(botanicAgentPlanConfirmActionLabel(batch), '生成 2 张')
  assert.equal(botanicAgentPlanConfirmActionLabel(batch, 'submitting'), '正在提交…')
  assert.equal(botanicAgentPlanConfirmActionLabel(batch, 'blocked'), '先处理行动卡')
  assert.equal(botanicAgentPlanConfirmActionLabel(batch, 'failed'), '重新生成')
})

// ---- 镜像一致性：与 server/botanicAgentVariations.mjs 共用一份夹具，防止两界漂移。 ----

const mirrorFixture = JSON.parse(await import('node:fs/promises')
  .then((fs) => fs.readFile(new URL('../../scripts/fixtures/agentVariationMirrorCases.json', import.meta.url), 'utf8')))

function projectVariationResolution(result: ReturnType<typeof resolveBotanicAgentVariationRequest>) {
  if (result.kind === 'ready') {
    return {
      kind: 'ready',
      combine: Boolean(result.spec.combine),
      branchLabels: expandBotanicAgentVariationBranches(result.spec).map((branch) => branch.label),
    }
  }
  if (result.kind === 'ask') return { kind: 'ask', fieldIds: result.clarification.fields.map((field) => field.id) }
  if (result.kind === 'asset_group') return { kind: 'asset_group', groupId: result.groupId, count: result.count }
  return { kind: 'none' }
}

test('镜像夹具：变体决策与 server 实现一致', () => {
  for (const item of mirrorFixture.resolveCases) {
    assert.deepEqual(projectVariationResolution(resolveBotanicAgentVariationRequest(item.input)), item.expected, item.name)
  }
})

test('镜像夹具：提示词清洗与 server 实现一致', () => {
  for (const item of mirrorFixture.promptCases) {
    assert.equal(botanicAgentVisualGenerationPrompt(item.prompt, item.fallback), item.expected, item.name)
  }
})

test('镜像夹具：批量意图识别与 server 实现一致', () => {
  for (const item of mirrorFixture.batchDetectionCases) {
    assert.equal(instructionRequestsBatchVariation(item.instruction), item.expected, item.instruction)
  }
})

test('成套方案的分支按条目展开，条目随分支下发', () => {
  const drafts = botanicAgentConfirmBranchDrafts({
    intent: 'initial_generation',
    constraints: [],
    output: { mode: 'single', count: 2, candidatesPerItem: 1 },
    composition: {
      theme: '春季系列',
      items: [
        { index: 1, title: '主视觉', mediaKind: 'image', prompt: '主画面', count: 1 },
        { index: 2, title: '氛围视频', mediaKind: 'video', prompt: '镜头缓推', count: 1, duration: 10 },
      ],
    },
  })
  assert.deepEqual(drafts.map((draft) => [draft.label, draft.item?.mediaKind]), [
    ['主视觉', 'image'],
    ['氛围视频', 'video'],
  ])
})
