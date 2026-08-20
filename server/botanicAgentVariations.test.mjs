import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyBotanicAgentVariationToPlan,
  botanicAgentConfirmBranchDrafts,
  botanicAgentVisualGenerationPrompt,
  expandBotanicAgentVariationBranches,
  instructionRequestsBatchVariation,
  resolveBotanicAgentVariationRequest,
} from './botanicAgentVariations.mjs'

test('执行链路元话语和创作简报拼接段不能切成自定义变体', () => {
  const harness = [
    '在画布/执行界面触发这批生成节点，执行链路会按交接计划读取 Mia 素材并出图；',
    '',
    '创作简报：',
    '- 交付用途：小红书，画面比例 3:4',
    '- Prompt 优化方向：杂志氛围',
  ].join('\n')
  assert.equal(resolveBotanicAgentVariationRequest({ instruction: harness }).kind, 'none')
})

test('首次生成按变体展开时保留 initial_generation', () => {
  const applied = applyBotanicAgentVariationToPlan({
    intent: 'initial_generation',
    instruction: '白皙、自然两种肤色，多图',
    summary: '首次生成 1 张。',
    prompt: '基于 Mia 氛围肖像，保持人物身份。',
    constraints: [],
    output: { mode: 'single', count: 1, candidatesPerItem: 1 },
  }, {
    instruction: '白皙、自然两种肤色，多图',
    requestedIntent: 'initial_generation',
  })
  assert.equal(applied.kind, 'plan')
  assert.equal(applied.plan.intent, 'initial_generation')
  assert.equal(applied.plan.output.mode, 'batch_by_variation')
  assert.equal(applied.plan.output.count, 2)
})

// ---- 镜像一致性：与 src/domain 的同名实现共用一份夹具，防止两界漂移。 ----

const mirrorFixture = JSON.parse(await import('node:fs/promises')
  .then((fs) => fs.readFile(new URL('../scripts/fixtures/agentVariationMirrorCases.json', import.meta.url), 'utf8')))

function projectVariationResolution(result) {
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

test('镜像夹具：变体决策与 src/domain 实现一致', () => {
  for (const item of mirrorFixture.resolveCases) {
    assert.deepEqual(projectVariationResolution(resolveBotanicAgentVariationRequest(item.input)), item.expected, item.name)
  }
})

test('镜像夹具：提示词清洗与 src/domain 实现一致', () => {
  for (const item of mirrorFixture.promptCases) {
    assert.equal(botanicAgentVisualGenerationPrompt(item.prompt, item.fallback), item.expected, item.name)
  }
})

test('镜像夹具：批量意图识别与 src/domain 实现一致', () => {
  for (const item of mirrorFixture.batchDetectionCases) {
    assert.equal(instructionRequestsBatchVariation(item.instruction), item.expected, item.instruction)
  }
})

test('成套方案的分支按条目展开，条目随分支下发（镜像）', () => {
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

test('两个不同背景按场景展开 2 张，不把人物要全身当成人物轴', () => {
  const request = resolveBotanicAgentVariationRequest({
    instruction: '@Mia 氛围肖像 这张图给我生成两个不同的背景，一个在沙漠一个在海边。16:9，人物要全身',
  })
  assert.equal(request.kind, 'ready')
  assert.equal(request.spec.axes[0].key, 'scene')
  assert.deepEqual(request.spec.axes[0].values.map((value) => value.label), ['沙漠', '海边'])
})

test('说了两张却切出画面碎词时必须追问，不能按 8 张提交', () => {
  const request = resolveBotanicAgentVariationRequest({
    instruction: '基于同一女性人物生成两张全身人像。海岸线与沙滩，海浪，海风吹拂发丝与裙摆，柔和光线，金色夕阳，广角，浅景深，胶片颗粒',
  })
  assert.equal(request.kind, 'ask')
  assert.match(request.clarification.question, /2 张/)
})
