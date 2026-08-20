import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyBotanicAgentVariationToPlan,
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
