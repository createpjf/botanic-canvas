import assert from 'node:assert/strict'
import test from 'node:test'
import type { GenerationModelOption } from './canvas.ts'
import {
  botanicAgentComposerIntentHint,
  botanicAgentRequestUsesGenerationTurn,
  buildBotanicAgentChatRequest,
  completeBotanicAgentGenerationSettings,
  decideBotanicAgentRequest,
  inferBotanicAgentGenerationSettings,
  isBotanicAgentPromptGenerationPending,
  resolveBotanicAgentGenerationPromptDecision,
} from './agentChatContract.ts'

test('通用 Agent 对话请求只发送有限消息与节点 ID', () => {
  const request = buildBotanicAgentChatRequest({
    projectId: 'project-chat',
    locale: 'en',
    plannerModel: 'kimi-k3',
    mode: 'research',
    messages: Array.from({ length: 18 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: `消息 ${index}` })),
    contextNodeIds: ['node-a', 'node-a', 'node-b'],
  })

  assert.equal(request.messages.length, 16)
  assert.equal(request.locale, 'en')
  assert.deepEqual(request.messages[0], { role: 'user', content: '消息 2' })
  assert.deepEqual(request.contextNodeIds, ['node-a', 'node-b'])
  assert.doesNotMatch(JSON.stringify(request), /image|data:image|base64|url/i)
})

test('4K 请求以模型能力为准，不形成 GPT Image 2 + 4K 的无效组合', () => {
  const models: GenerationModelOption[] = [
    {
      id: 'gpt-image-2', label: 'GPT Image 2', provider: 'openai', mediaKind: 'image',
      aspectRatios: ['1:1', '3:4'], resolutions: ['1K', '2K'], supportsCustomSize: true,
    },
    {
      id: 'gemini-3.1-pro-preview', label: 'Nano Banana', provider: 'flock', mediaKind: 'image',
      aspectRatios: ['1:1', '3:4'], resolutions: ['1K', '2K', '4K'],
    },
  ]
  assert.deepEqual(inferBotanicAgentGenerationSettings('用 GPT Image 2 生成 4K，3:4', models), {
    model: 'gemini-3.1-pro-preview',
    aspectRatio: '3:4',
    resolution: '4K',
  })
  assert.deepEqual(inferBotanicAgentGenerationSettings('用 GPT Image 2 生成 4K', models.slice(0, 1)), {})
})

test('图片咨询、运行状态和能力询问不会误触发生成', () => {
  const consultations = [
    '这张图片怎么写比较好？',
    '这张图是什么内容',
    '图里有什么',
    '帮我分析一下这个画面',
    '怎么改背景比较好？',
    '能不能给我几个换场景的建议？',
    '这张图片是哪次生成的？',
    '图片生成用了什么模型？',
    '为什么生成这么慢？',
    '重新生成是什么意思？',
    '你可以生成视频吗？',
    '帮我生成一个产品文案',
  ]

  consultations.forEach((instruction) => {
    const decision = decideBotanicAgentRequest(instruction, true)
    assert.notEqual(decision.kind, 'generation', instruction)
    assert.equal(botanicAgentRequestUsesGenerationTurn(decision), false, instruction)
  })
  assert.equal(decideBotanicAgentRequest('分析一下然后生成3张海边人像', true).kind, 'generation')
  assert.equal(
    botanicAgentComposerIntentHint(decideBotanicAgentRequest('这张图里有什么，分析一下', true), { hasVisualContext: true }, 'zh-CN'),
    '这一步将分析引用图，不会出图',
  )
  assert.equal(
    botanicAgentComposerIntentHint(decideBotanicAgentRequest('做一张海边人像', true), { hasVisualContext: true }, 'zh-CN'),
    '这一步将规划出图',
  )
})

test('明确的视觉执行请求才进入生成链路', () => {
  const requests = [
    '做一张海边人像',
    '来一张海边人像',
    '按这个做一张',
    '用你刚才写的那个直接做一张',
    '我要一张海边人像',
    'generate an image of a summer fragrance bottle',
    'edit this image into a beach scene',
    '能不能帮我生成一张海边人像',
  ]

  requests.forEach((instruction) => {
    assert.equal(decideBotanicAgentRequest(instruction, true).kind, 'generation', instruction)
  })
})

test('无素材组的批量变体请求进入生成计划，而不是写成对话旁白', () => {
  const requests = [
    '多个肤色人物、多图',
    '白皙、自然、小麦、深棕四种肤色，多图',
    '多肤色批量',
    '做几种肤色版本',
    '出一组变体',
  ]
  requests.forEach((instruction) => {
    assert.equal(decideBotanicAgentRequest(instruction, true).kind, 'generation', instruction)
  })
  assert.notEqual(decideBotanicAgentRequest('能不能给我几个换场景的建议？', true).kind, 'generation')
})

test('裸确认语只提交待确认计划，不当成新指令送进规划器', () => {
  for (const instruction of [
    '确认生成', '确认', '生成', '开始生成', '就这样生成', '按推荐值继续', '按推荐方案继续', '确认生成。',
    '开始执行', '直接执行', '执行吧', '可以的 直接执行', '好的，开始生成', '马上执行',
    '直接生成', '马上生成', '立即生成', '生成一下',
  ]) {
    assert.deepEqual(decideBotanicAgentRequest(instruction, true), { kind: 'confirm_pending' }, instruction)
  }
  // 带画面内容的指令仍是新的生成请求，不能被裸确认语规则吞掉。
  assert.equal(decideBotanicAgentRequest('确认生成一张海边人像', true).kind, 'generation')
  assert.equal(decideBotanicAgentRequest('生成多个肤色的任务', true).kind, 'generation')
})

test('执行链路元话语只提交已有计划，不把出图二字送进规划器', () => {
  for (const instruction of [
    '或让具备执行能力的 Agent（如 planner 的执行链路）接手这批待确认任务。',
    '在画布/执行界面触发这批生成节点，执行链路会按交接计划读取 Mia 素材并出图；',
  ]) {
    assert.deepEqual(decideBotanicAgentRequest(instruction, true), { kind: 'confirm_pending' }, instruction)
  }
  assert.equal(decideBotanicAgentRequest('按白皙、小麦、黄色三档肤色出 3 张', true).kind, 'generation')
  assert.deepEqual(decideBotanicAgentRequest('为什么没生成', true), { kind: 'chat', mode: 'conversation' })
})

test('视频请求有图片首帧才进视频计划，沿用历史 Prompt 的路径同判', () => {
  // 有可用图片（选中结果或引用素材）：进入视频生成计划。
  assert.deepEqual(
    decideBotanicAgentRequest('用这段 Prompt 生成视频', true),
    { kind: 'generation', mediaKind: 'video', promptSource: 'previous_prompt' },
  )
  assert.deepEqual(
    decideBotanicAgentRequest('把这张图做成视频', true),
    { kind: 'generation', mediaKind: 'video', promptSource: 'instruction' },
  )
  // 没有图片可作首帧：先请用户指定，不产出按图片模型走的“视频”计划。
  assert.deepEqual(
    decideBotanicAgentRequest('用这段 Prompt 生成视频', false),
    { kind: 'clarification', reason: 'video_requires_reference' },
  )
  assert.deepEqual(
    decideBotanicAgentRequest('用这段 Prompt 生成', true),
    { kind: 'generation', mediaKind: 'image', promptSource: 'previous_prompt' },
  )
})

test('同样的执行链路措辞出现在提问里只是发问，不能提交待确认计划', () => {
  // 提交待确认计划会真实发起生成并花钱，提问不该有这个副作用。
  for (const question of [
    '为什么执行链路没有跑？',
    '这个待确认计划怎么改',
    '执行链路是什么意思？',
    '触发这批生成节点会不会重复扣费？',
  ]) {
    assert.notEqual(decideBotanicAgentRequest(question, true).kind, 'confirm_pending', question)
  }
})

test('自然语言创作请求在已有图片上下文时进入生成计划链路', () => {
  const requests = [
    '我想要一张 Mori Kei 风格的人像',
    '把这张图变成森系风格',
    '这张图换成海边版本',
    '我希望调整背景为海边',
    'I want an image of a Mori Kei woman',
    'Turn this image into a forest scene',
    'I want to turn this image into a forest scene',
  ]

  requests.forEach((instruction) => {
    assert.equal(decideBotanicAgentRequest(instruction, true).kind, 'generation', instruction)
  })
})

test('视频执行请求不得误建图片节点', () => {
  // 无图片首帧时提示先指定，不落成图片计划。
  assert.deepEqual(decideBotanicAgentRequest('帮我生成一个视频'), {
    kind: 'clarification',
    reason: 'video_requires_reference',
  })
  assert.deepEqual(decideBotanicAgentRequest('帮我生成一个视频', true), {
    kind: 'generation',
    mediaKind: 'video',
    promptSource: 'instruction',
  })
})

test('能力询问和先写 Prompt 的请求不应直接创建画布节点', () => {
  assert.deepEqual(decideBotanicAgentRequest('Can you generate an image?'), {
    kind: 'chat',
    mode: 'conversation',
  })
  assert.deepEqual(decideBotanicAgentRequest('重新写一版提示词并生成'), {
    kind: 'chat',
    mode: 'prompt',
  })
})

test('已有图片上下文时视觉能力问句进入生成计划链路', () => {
  const requests = [
    'Can you generate this girl?',
    'Generate this girl',
    'I want to generate this girl',
    'Can you create an image of this woman?',
  ]

  requests.forEach((instruction) => {
    assert.equal(decideBotanicAgentRequest(instruction, true).kind, 'generation', instruction)
  })
  assert.deepEqual(decideBotanicAgentRequest('Can you generate this girl?'), {
    kind: 'chat',
    mode: 'conversation',
  })
})

test('否定和取消生成请求不会创建画布节点', () => {
  for (const instruction of ['先不要生成图片', '取消生成', '停止生成', '暂不出图', '先不生成了', '不生图了', '不生成了']) {
    assert.deepEqual(decideBotanicAgentRequest(instruction, true), {
      kind: 'chat',
      mode: 'conversation',
    }, instruction)
  }
  assert.equal(decideBotanicAgentRequest('不要改变人物，生成一张海边版本', true).kind, 'generation')
})

test('Prompt 写作求助优先进入结构化 Prompt 模式', () => {
  for (const instruction of ['这个 Prompt 怎么写更好', '如何写海边人像提示词', '帮我润色这段 Prompt']) {
    assert.deepEqual(decideBotanicAgentRequest(instruction, true), {
      kind: 'chat',
      mode: 'prompt',
    }, instruction)
  }
})

test('对象前置的常用视觉编辑语法进入生成链路', () => {
  for (const instruction of ['把背景换成海边', '把风格改成胶片', '将模特换成男性', '添加flock.io的logo']) {
    assert.equal(decideBotanicAgentRequest(instruction, true).kind, 'generation', instruction)
  }
})

test('只回填从可信模型目录中完整解析出的输出设置', () => {
  const models: GenerationModelOption[] = [
    { id: 'gpt-image-2', label: 'GPT Image 2', aspectRatios: ['1:1', '16:9'], resolutions: ['1K', '2K'] },
    { id: 'minimax-h3', label: 'MiniMax H3', aspectRatios: ['16:9'], resolutions: ['2K'] },
  ]
  assert.deepEqual(inferBotanicAgentGenerationSettings('用 GPT Image 2 生成，16:9，2K', models), {
    model: 'gpt-image-2', aspectRatio: '16:9', resolution: '2K',
  })
  assert.deepEqual(inferBotanicAgentGenerationSettings('生成 4:3、2K 图片', models), {
    resolution: '2K',
  })
  assert.deepEqual(inferBotanicAgentGenerationSettings('请用 1920×1080 出图', models), {
    aspectRatio: '16:9', outputWidth: 1920, outputHeight: 1088,
  })
})

test('同一 Prompt 已有待回答输出设置时阻止重复创建追问', () => {
  assert.equal(isBotanicAgentPromptGenerationPending('prompt-1', [{
    kind: 'question', status: 'pending', question: {
      id: 'question-1', question: '确认输出', originalInstruction: '使用这段 Prompt 生成', fields: [], sourcePromptMessageId: 'prompt-1',
    },
  }]), true)
  assert.equal(isBotanicAgentPromptGenerationPending('prompt-1', [{
    kind: 'question', status: 'answered', question: {
      id: 'question-1', question: '确认输出', originalInstruction: '使用这段 Prompt 生成', fields: [], sourcePromptMessageId: 'prompt-1',
    },
  }]), false)
})

test('历史 Prompt 必须精确按消息取用，并保留本次增量修改', () => {
  const messages = [
    { id: 'prompt-old', role: 'assistant' as const, content: '旧回复', prompt: '旧 Prompt' },
    { id: 'prompt-new', role: 'assistant' as const, content: '新回复', prompt: '新 Prompt' },
  ]
  assert.deepEqual(
    resolveBotanicAgentGenerationPromptDecision('按这个生成，把背景改成森林', messages, 'prompt-old'),
    {
      status: 'resolved',
      prompt: '旧 Prompt\n\n本次修改：把背景改成森林',
      sourceMessageId: 'prompt-old',
      delta: '把背景改成森林',
    },
  )
})

test('引用历史 Prompt 但找不到来源时明确返回缺失', () => {
  assert.deepEqual(resolveBotanicAgentGenerationPromptDecision('按这个生成', []), { status: 'missing', prompt: '' })
})

test('自动模式只用模型目录内的取值补齐输出设置', () => {
  const models: GenerationModelOption[] = [
    { id: 'gpt-image-2', label: 'GPT Image 2', aspectRatios: ['1:1', '16:9'], resolutions: ['1K', '2K'] },
    { id: 'minimax-h3', label: 'MiniMax H3', aspectRatios: ['16:9'], resolutions: ['2K'] },
  ]
  assert.deepEqual(completeBotanicAgentGenerationSettings({}, models), {
    model: 'gpt-image-2', aspectRatio: '1:1', resolution: '2K',
  })
  // 已解析出的取值不被覆盖，只补缺项。
  assert.deepEqual(completeBotanicAgentGenerationSettings({ model: 'minimax-h3', resolution: '2K' }, models), {
    model: 'minimax-h3', aspectRatio: '16:9', resolution: '2K',
  })
  // 没有可信目录就补不出取值，调用方仍会退回追问。
  assert.deepEqual(completeBotanicAgentGenerationSettings({ aspectRatio: '1:1' }, []), { aspectRatio: '1:1' })
})

test('用户说提高清晰度或 4K 时推断 Nano Banana + 4K，普通补齐仍用日常 2K', () => {
  const models: GenerationModelOption[] = [
    { id: 'gpt-image-2', label: 'GPT Image 2', provider: 'openai', mediaKind: 'image', aspectRatios: ['1:1', '16:9'], resolutions: ['1K', '2K'] },
    {
      id: 'gemini-3.1-pro-preview', label: 'Nano Banana', provider: 'flock', mediaKind: 'image',
      aspectRatios: ['1:1', '16:9', '3:4', '21:9'], resolutions: ['1K', '2K', '4K'],
    },
  ]
  assert.deepEqual(inferBotanicAgentGenerationSettings('提高清晰度', models), {
    model: 'gemini-3.1-pro-preview', resolution: '4K',
  })
  assert.deepEqual(inferBotanicAgentGenerationSettings('make it sharper', models), {
    model: 'gemini-3.1-pro-preview', resolution: '4K',
  })
  assert.deepEqual(inferBotanicAgentGenerationSettings('生成 21:9、4K 图片', models), {
    model: 'gemini-3.1-pro-preview', aspectRatio: '21:9', resolution: '4K',
  })
  assert.deepEqual(completeBotanicAgentGenerationSettings({}, models), {
    model: 'gemini-3.1-pro-preview', aspectRatio: '3:4', resolution: '2K',
  })
})
