import assert from 'node:assert/strict'
import test from 'node:test'
import {
  advanceBotanicCreativeBrief,
  applyBotanicCreativeBriefAnswers,
  botanicAgentClarificationAnswersComplete,
} from './agentCreativeBrief.ts'

const imageModels = [{
  id: 'gpt-image-2',
  label: 'GPT Image 2',
  mediaKind: 'image' as const,
  aspectRatios: ['1:1', '3:4', '9:16'] as const,
  resolutions: ['1K', '2K'] as const,
}]

test('未点名图片模型时，Agent Brief 与画布统一默认 Nano Banana', () => {
  const turn = advanceBotanicCreativeBrief({
    mode: 'generation',
    executionMode: 'manual',
    instruction: '生成一张海边人像',
    generationModels: [
      ...imageModels,
      {
        id: 'gemini-3.1-pro-preview', label: 'Nano Banana', mediaKind: 'image' as const,
        aspectRatios: ['3:4'] as const, resolutions: ['1K', '2K', '4K'] as const,
      },
    ],
  })
  assert.equal(turn.brief.output.model, 'gemini-3.1-pro-preview')
  assert.equal(turn.brief.provenance.model, 'default')
})

test('手动生成缺少关键信息时只追问用途、清晰度和 Prompt 方向', () => {
  const turn = advanceBotanicCreativeBrief({
    mode: 'generation',
    executionMode: 'manual',
    instruction: '生成一张海边人像',
    generationModels: imageModels,
    clarificationId: 'clarification-1',
  })

  assert.equal(turn.kind, 'ask')
  assert.deepEqual(turn.clarification.fields.map((field) => field.id), [
    'delivery_preset',
    'resolution',
    'prompt_direction',
  ])
  assert.equal(turn.brief.output.model, 'gpt-image-2')
  assert.equal(turn.brief.provenance.model, 'default')
})

test('追问答案会合并到 Brief 并编译进生成设置与 Prompt', () => {
  const first = advanceBotanicCreativeBrief({
    mode: 'generation',
    executionMode: 'manual',
    instruction: '生成一张海边人像',
    generationModels: imageModels,
    clarificationId: 'clarification-1',
  })
  assert.equal(first.kind, 'ask')

  const turn = advanceBotanicCreativeBrief({
    mode: 'generation',
    executionMode: 'manual',
    instruction: '生成一张海边人像',
    generationModels: imageModels,
    previousBrief: first.brief,
    answers: {
      delivery_preset: 'xiaohongshu',
      resolution: '2K',
      prompt_direction: 'editorial',
    },
  })

  assert.equal(turn.kind, 'ready')
  assert.deepEqual(turn.settings, {
    model: 'gpt-image-2',
    aspectRatio: '3:4',
    resolution: '2K',
  })
  assert.equal(turn.brief.output.deliveryPreset, 'xiaohongshu')
  assert.equal(turn.brief.provenance.delivery_preset, 'user')
  assert.match(turn.prompt, /杂志氛围/)
  assert.match(turn.prompt, /小红书/)
})

test('创作设置追问只保留一句不会立刻出图的说明', () => {
  const turn = advanceBotanicCreativeBrief({
    mode: 'prompt',
    instruction: '优化这段人物摄影 Prompt',
    clarificationId: 'clarification-copy',
  })

  assert.equal(turn.kind, 'ask')
  assert.equal(turn.clarification.question, '确认后继续整理 Prompt，不会立刻出图。')
  assert.equal(turn.clarification.helper, undefined)
})

test('自定义 Prompt 方向与说明可以在同一轮提交并收束', () => {
  const first = advanceBotanicCreativeBrief({
    mode: 'prompt',
    instruction: '优化这段人物摄影 Prompt',
    clarificationId: 'clarification-direction',
  })
  assert.equal(first.kind, 'ask')

  const ready = advanceBotanicCreativeBrief({
    mode: 'prompt',
    instruction: first.brief.originalInstruction,
    previousBrief: first.brief,
    answers: {
      prompt_direction: 'custom',
      custom_direction: '克制的电影感，保留自然肤质',
    },
  })
  assert.equal(ready.kind, 'ready')
  assert.match(ready.prompt, /克制的电影感，保留自然肤质/)
})

test('选自定义方向但未填写说明时确认卡仍未完成', () => {
  const fields = [{
    id: 'prompt_direction' as const,
    label: 'Prompt 优化方向',
    required: true,
    control: 'single_choice' as const,
    defaultValue: 'faithful',
    options: [{ value: 'faithful', label: '保真自然' }, { value: 'custom', label: '自定义方向' }],
  }]
  assert.equal(botanicAgentClarificationAnswersComplete(fields, { prompt_direction: 'faithful' }), true)
  assert.equal(botanicAgentClarificationAnswersComplete(fields, { prompt_direction: 'custom' }), false)
  assert.equal(botanicAgentClarificationAnswersComplete(fields, {
    prompt_direction: 'custom',
    custom_direction: '克制的电影感',
  }), true)
})

test('确认过的 Prompt 方向会沉淀到 Brief，下一轮不再追问同一字段', () => {
  const first = advanceBotanicCreativeBrief({
    mode: 'prompt',
    instruction: '优化这段人物摄影 Prompt',
    clarificationId: 'clarification-persist',
  })
  assert.equal(first.kind, 'ask')

  const remembered = applyBotanicCreativeBriefAnswers(first.brief, { prompt_direction: 'editorial' })
  const next = advanceBotanicCreativeBrief({
    mode: 'prompt',
    instruction: first.brief.originalInstruction,
    previousBrief: remembered,
  })

  assert.equal(next.kind, 'ready')
  assert.equal(next.brief.creative.promptDirection, 'editorial')
})

test('自定义 Prompt 方向进入第二轮文本追问并在回答后收束', () => {
  const first = advanceBotanicCreativeBrief({
    mode: 'prompt',
    instruction: '优化这段人物摄影 Prompt',
    clarificationId: 'clarification-direction',
  })
  assert.equal(first.kind, 'ask')
  assert.deepEqual(first.clarification.fields.map((field) => field.id), ['prompt_direction'])

  const second = advanceBotanicCreativeBrief({
    mode: 'prompt',
    instruction: first.brief.originalInstruction,
    previousBrief: first.brief,
    answers: { prompt_direction: 'custom' },
    clarificationId: 'clarification-custom',
  })
  assert.equal(second.kind, 'ask')
  assert.deepEqual(second.clarification.fields.map((field) => field.id), ['custom_direction'])
  assert.equal(second.clarification.fields[0].control, 'text')

  const ready = advanceBotanicCreativeBrief({
    mode: 'prompt',
    instruction: second.brief.originalInstruction,
    previousBrief: second.brief,
    answers: { custom_direction: '克制的电影感，保留自然肤质' },
  })
  assert.equal(ready.kind, 'ready')
  assert.match(ready.prompt, /克制的电影感，保留自然肤质/)
})

test('自定义交付用途会进入比例选择，不会重复追问用途', () => {
  const first = advanceBotanicCreativeBrief({
    mode: 'generation',
    executionMode: 'manual',
    instruction: '生成一张海边人像',
    generationModels: imageModels,
  })
  assert.equal(first.kind, 'ask')

  const second = advanceBotanicCreativeBrief({
    mode: 'generation',
    executionMode: 'manual',
    instruction: first.brief.originalInstruction,
    generationModels: imageModels,
    previousBrief: first.brief,
    answers: {
      delivery_preset: 'custom',
      resolution: '2K',
      prompt_direction: 'faithful',
    },
  })

  assert.equal(second.kind, 'ask')
  assert.deepEqual(second.clarification.fields.map((field) => field.id), ['aspect_ratio'])
  assert.deepEqual(second.clarification.fields[0].options.map((option) => option.value), ['1:1', '3:4', '9:16'])

  const ready = advanceBotanicCreativeBrief({
    mode: 'generation',
    executionMode: 'manual',
    instruction: second.brief.originalInstruction,
    generationModels: imageModels,
    previousBrief: second.brief,
    answers: { aspect_ratio: '9:16' },
  })
  assert.equal(ready.kind, 'ready')
  assert.equal(ready.settings.aspectRatio, '9:16')
})

test('编辑已有结果时继承输出设置并从明确锁定要求推断保真方向', () => {
  const turn = advanceBotanicCreativeBrief({
    mode: 'generation',
    executionMode: 'manual',
    instruction: '保持人物、服装和姿态不变，只把背景换成晴朗海边',
    generationModels: imageModels,
    inheritedSettings: {
      model: 'gpt-image-2',
      aspectRatio: '3:4',
      resolution: '2K',
    },
  })

  assert.equal(turn.kind, 'ready')
  assert.equal(turn.brief.creative.promptDirection, 'faithful')
  assert.equal(turn.brief.creative.preservationPriority, 'identity')
  assert.equal(turn.brief.provenance.aspect_ratio, 'canvas')
  assert.match(turn.prompt, /保真自然/)
})

test('自动模式只从可信模型目录补齐默认值且不发起追问', () => {
  const turn = advanceBotanicCreativeBrief({
    mode: 'generation',
    executionMode: 'auto',
    instruction: '生成一张海边人像',
    generationModels: imageModels,
  })

  assert.equal(turn.kind, 'ready')
  // 默认画幅与 completeBotanicAgentGenerationSettings 同源：优先目录里的 3:4，
  // 不再取目录第一项，否则同一句指令按走哪条补全路径得到不同画幅。
  assert.deepEqual(turn.settings, {
    model: 'gpt-image-2',
    aspectRatio: '3:4',
    resolution: '2K',
  })
  assert.equal(turn.brief.creative.promptDirection, 'faithful')
  assert.equal(turn.brief.provenance.aspect_ratio, 'default')
  assert.equal(turn.brief.provenance.resolution, 'default')
})

test('切换模型时清除不兼容的继承设置并重新确认', () => {
  const turn = advanceBotanicCreativeBrief({
    mode: 'generation',
    executionMode: 'manual',
    instruction: '换一个模型继续生成',
    generationModels: [
      ...imageModels,
      {
        id: 'square-only',
        label: 'Square Only',
        mediaKind: 'image' as const,
        aspectRatios: ['1:1'] as const,
        resolutions: ['1K'] as const,
      },
    ],
    inheritedSettings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
    requestedSettings: { model: 'square-only' },
  })

  assert.equal(turn.kind, 'ask')
  assert.equal(turn.brief.output.model, 'square-only')
  assert.equal(turn.brief.output.aspectRatio, undefined)
  assert.equal(turn.brief.output.resolution, undefined)
  assert.deepEqual(turn.clarification.fields.map((field) => field.id), [
    'delivery_preset',
    'resolution',
    'prompt_direction',
  ])
  assert.deepEqual(turn.clarification.fields[0].options.map((option) => option.value), ['taobao', 'custom'])
  assert.equal(turn.clarification.fields[0].defaultValue, 'taobao')
  assert.deepEqual(turn.clarification.fields[1].options.map((option) => option.value), ['1K'])
})

test('生成模式没有可用图片模型时明确失败', () => {
  const turn = advanceBotanicCreativeBrief({
    mode: 'generation',
    executionMode: 'manual',
    instruction: '生成一张海边人像',
    generationModels: [],
  })

  assert.equal(turn.kind, 'failed')
  assert.equal(turn.code, 'NO_IMAGE_MODEL')
  assert.match(turn.message, /图片模型/)
})

test('Prompt 自动模式使用保真默认方向，不打断为追问', () => {
  const turn = advanceBotanicCreativeBrief({
    mode: 'prompt',
    executionMode: 'auto',
    instruction: '优化这段人物摄影 Prompt',
  })

  assert.equal(turn.kind, 'ready')
  assert.equal(turn.brief.creative.promptDirection, 'faithful')
  assert.equal(turn.brief.provenance.prompt_direction, 'default')
})

test('请求的自定义像素会进入 ready 生成设置', () => {
  const turn = advanceBotanicCreativeBrief({
    mode: 'generation',
    executionMode: 'auto',
    instruction: '请用 1920x1080 生成海边人像',
    generationModels: [{
      ...imageModels[0],
      aspectRatios: ['1:1', '16:9', '3:4', '9:16'] as const,
    }],
    requestedSettings: {
      model: 'gpt-image-2', aspectRatio: '16:9', resolution: '2K', outputWidth: 1920, outputHeight: 1080,
    },
  })

  assert.equal(turn.kind, 'ready')
  if (turn.kind !== 'ready') return
  assert.equal(turn.settings.aspectRatio, '16:9')
  assert.equal(turn.settings.outputWidth, 1920)
  assert.equal(turn.settings.outputHeight, 1088)
})

test('英文模式本地追问与选项使用英文，用户指令保持原文', () => {
  const turn = advanceBotanicCreativeBrief({
    mode: 'generation',
    locale: 'en',
    executionMode: 'manual',
    instruction: 'Create a seaside portrait',
    generationModels: imageModels,
    clarificationId: 'clarification-en',
  })

  assert.equal(turn.kind, 'ask')
  if (turn.kind !== 'ask') return
  assert.equal(turn.clarification.question, 'Confirm these settings to continue refining the prompt. No image will be generated yet.')
  assert.deepEqual(turn.clarification.fields.map((field) => field.label), [
    'Use and aspect ratio',
    'Resolution',
    'Prompt direction',
  ])
  assert.equal(turn.clarification.fields[0].options[0].label, 'Taobao / Tmall')
  assert.equal(turn.clarification.fields[2].options[0].label, 'Natural and faithful')
  assert.equal(turn.clarification.originalInstruction, 'Create a seaside portrait')
})

test('英文模式将本地创作简报编译为英文', () => {
  const first = advanceBotanicCreativeBrief({
    mode: 'generation',
    locale: 'en',
    executionMode: 'manual',
    instruction: 'Create a seaside portrait',
    generationModels: imageModels,
  })
  assert.equal(first.kind, 'ask')
  if (first.kind !== 'ask') return

  const turn = advanceBotanicCreativeBrief({
    mode: 'generation',
    locale: 'en',
    executionMode: 'manual',
    instruction: first.brief.originalInstruction,
    generationModels: imageModels,
    previousBrief: first.brief,
    answers: {
      delivery_preset: 'xiaohongshu',
      resolution: '2K',
      prompt_direction: 'editorial',
    },
  })

  assert.equal(turn.kind, 'ready')
  if (turn.kind !== 'ready') return
  assert.match(turn.prompt, /Creative brief:/)
  assert.match(turn.prompt, /Delivery: RED, aspect ratio 3:4/)
  assert.match(turn.prompt, /Prompt direction: Editorial mood/)
  assert.doesNotMatch(turn.prompt, /[\u3400-\u9fff]/u)
})

test('英文模式的本地配置错误使用英文', () => {
  const turn = advanceBotanicCreativeBrief({
    mode: 'generation',
    locale: 'en',
    instruction: 'Create a portrait',
    generationModels: [],
  })

  assert.equal(turn.kind, 'failed')
  if (turn.kind !== 'failed') return
  assert.equal(turn.code, 'NO_IMAGE_MODEL')
  assert.equal(turn.message, 'No image model is available. Check the model configuration.')
})
