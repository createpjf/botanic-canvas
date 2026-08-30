import assert from 'node:assert/strict'
import test from 'node:test'
import type { BotanicAgentMessage } from './agent.ts'
import {
  buildBotanicAgentInitialDraftPlan,
  prepareBotanicAgentGenerationDraft,
  resolveBotanicAgentInstructionEntry,
} from './agentInstructionRouting.ts'
import type { GenerationModelOption } from './canvas.ts'

const imageModel: GenerationModelOption = {
  id: 'gpt-image-2', label: 'GPT Image 2', mediaKind: 'image',
  aspectRatios: ['1:1', '3:4', '16:9'], resolutions: ['1K', '2K'],
}
const nanoModel: GenerationModelOption = {
  id: 'gemini-3.1-flash-image-preview', label: 'Nano Banana', provider: 'flock', mediaKind: 'image',
  aspectRatios: ['3:4'], resolutions: ['1K', '2K', '4K'],
  supportsSearchGrounding: true, thinkingLevels: ['minimal', 'high'],
}
const videoModel: GenerationModelOption = {
  id: 'MiniMax-H3', label: 'MiniMax H3', mediaKind: 'video',
  aspectRatios: ['16:9', '3:4', '9:16'], resolutions: ['2K'], durations: [5, 10, 15], defaultDuration: 5,
}

function message(partial: Partial<BotanicAgentMessage> & Pick<BotanicAgentMessage, 'id' | 'role'>): BotanicAgentMessage {
  return { kind: 'text', content: '', createdAt: 1, ...partial } as BotanicAgentMessage
}

test('执行语按序落点：待确认计划、待答确认卡、历史定稿 Prompt，最后才提示', () => {
  const base = { instruction: '直接生成', options: {}, hasVisualContext: true }
  const pendingPlan = message({ id: 'plan-1', role: 'assistant', kind: 'plan', status: 'pending', plan: { intent: 'initial_generation' } as never })
  const pendingQuestion = message({ id: 'question-1', role: 'assistant', kind: 'question', status: 'pending', question: { id: 'q', question: '?', originalInstruction: '', fields: [] } })
  const promptMessage = message({ id: 'prompt-1', role: 'assistant', prompt: '海边礁石人像，黄金时刻逆光' })

  const confirm = resolveBotanicAgentInstructionEntry({ ...base, messages: [promptMessage, pendingQuestion, pendingPlan] })
  assert.equal(confirm.kind, 'confirm_plan')
  assert.equal(confirm.kind === 'confirm_plan' && confirm.message.id, 'plan-1')

  const answerFirst = resolveBotanicAgentInstructionEntry({ ...base, messages: [promptMessage, pendingQuestion] })
  assert.deepEqual(answerFirst, { kind: 'notice', notice: 'answer_pending_question' })

  // 执行语没有画面信息：沿用最近定稿 Prompt，以 previous_prompt 进入生成，不写进简报。
  const reuse = resolveBotanicAgentInstructionEntry({ ...base, messages: [promptMessage] })
  assert.equal(reuse.kind, 'route')
  if (reuse.kind !== 'route') return
  assert.equal(reuse.useServerTurn, false)
  assert.deepEqual(reuse.decision, { kind: 'generation', mediaKind: 'image', promptSource: 'previous_prompt' })
  assert.equal(reuse.options.sourcePromptMessageId, 'prompt-1')

  const nothing = resolveBotanicAgentInstructionEntry({ ...base, messages: [] })
  assert.deepEqual(nothing, { kind: 'notice', notice: 'nothing_to_confirm' })
})

test('追问回程带回的生成结论直接进入生成，不再对画面描述二次分类', () => {
  const entry = resolveBotanicAgentInstructionEntry({
    // 纯画面描述本会被判成聊天；带着上一轮结论时必须跳过分类。
    instruction: '海边礁石人像，黄金时刻逆光，浅景深',
    options: { resolvedGeneration: { mediaKind: 'video', prompt: '海边礁石人像', count: 1, duration: 10 } },
    hasVisualContext: true,
    messages: [],
  })
  assert.equal(entry.kind, 'route')
  if (entry.kind !== 'route') return
  assert.equal(entry.useServerTurn, false)
  assert.deepEqual(entry.decision, { kind: 'generation', mediaKind: 'video', promptSource: 'instruction' })
  assert.equal(entry.synthesizedPrompt, '海边礁石人像')
  assert.equal(entry.synthesizedDuration, 10)
})

test('全新视觉请求由服务端回合判断意图；无图聊天、澄清答复与显式来源保持确定性路径', () => {
  const fresh = resolveBotanicAgentInstructionEntry({
    instruction: '帮我生成一张海边人像', options: {}, hasVisualContext: true, messages: [],
  })
  assert.equal(fresh.kind === 'route' && fresh.useServerTurn, true)
  assert.equal(fresh.kind === 'route' && fresh.requiresGenerationConfirmation, false)

  const analyze = resolveBotanicAgentInstructionEntry({
    instruction: '这张图里有什么，分析一下', options: {}, hasVisualContext: true, messages: [],
  })
  assert.equal(analyze.kind === 'route' && analyze.useServerTurn, true)
  assert.equal(analyze.kind === 'route' && analyze.requiresGenerationConfirmation, true)

  const replaceObject = resolveBotanicAgentInstructionEntry({
    instruction: '把狗狗换成猫', options: {}, hasVisualContext: true, messages: [],
  })
  assert.equal(replaceObject.kind === 'route' && replaceObject.useServerTurn, true)
  assert.equal(replaceObject.kind === 'route' && replaceObject.requiresGenerationConfirmation, true)

  const noVisualChat = resolveBotanicAgentInstructionEntry({
    instruction: '帮我分析一下', options: {}, hasVisualContext: false, messages: [],
  })
  assert.equal(noVisualChat.kind === 'route' && noVisualChat.useServerTurn, true)
  assert.equal(noVisualChat.kind === 'route' && noVisualChat.requiresGenerationConfirmation, true)

  const answering = resolveBotanicAgentInstructionEntry({
    instruction: '帮我生成一张海边人像',
    options: { clarificationAnswers: { resolution: '2K' } },
    hasVisualContext: true,
    messages: [],
  })
  assert.equal(answering.kind === 'route' && answering.useServerTurn, false)

  const explicitSource = resolveBotanicAgentInstructionEntry({
    instruction: '使用这段 Prompt 生成',
    options: { sourcePromptMessageId: 'prompt-1' },
    hasVisualContext: true,
    messages: [],
  })
  assert.equal(explicitSource.kind === 'route' && explicitSource.useServerTurn, false)
})

const draftBase = {
  instruction: '帮我生成一张海边人像',
  messages: [] as BotanicAgentMessage[],
  contextItems: [{ id: 'asset-mia', label: 'Mia 肖像', kind: '素材' as const, mediaKind: 'image' as const }],
}

test('生成草案：找不到 Prompt 或视频模型缺失时给出对应提示', () => {
  const missingPrompt = prepareBotanicAgentGenerationDraft({
    ...draftBase,
    instruction: '使用这段 Prompt 生成',
    decision: { kind: 'generation', mediaKind: 'image', promptSource: 'previous_prompt' },
    options: {},
    generationModels: [imageModel],
  })
  assert.deepEqual(missingPrompt, { kind: 'notice', notice: 'prompt_missing' })

  const missingVideoModel = prepareBotanicAgentGenerationDraft({
    ...draftBase,
    decision: { kind: 'generation', mediaKind: 'video', promptSource: 'instruction' },
    options: {},
    generationModels: [imageModel],
  })
  assert.deepEqual(missingVideoModel, { kind: 'notice', notice: 'video_model_missing' })
})

test('生成草案的追问卡带回 Prompt 来源与本轮生成结论', () => {
  const draft = prepareBotanicAgentGenerationDraft({
    ...draftBase,
    decision: { kind: 'generation', mediaKind: 'image', promptSource: 'instruction' },
    options: {},
    generationModels: [imageModel],
    executionMode: 'manual',
    synthesizedPrompt: '海边礁石人像，黄金时刻逆光',
    requestedIntent: 'replace_scene',
    synthesizedCount: 3,
  })
  assert.equal(draft.kind, 'ask')
  if (draft.kind !== 'ask') return
  assert.deepEqual(draft.clarification.resolvedGeneration, {
    mediaKind: 'image', prompt: '海边礁石人像，黄金时刻逆光', intent: 'replace_scene', count: 3,
  })
})

test('视频草案：时长取默认档、选中结果并进首帧上下文、恒走首图链路且不带张数', () => {
  const draft = prepareBotanicAgentGenerationDraft({
    ...draftBase,
    instruction: '把这张图做成视频，镜头缓慢推近',
    decision: { kind: 'generation', mediaKind: 'video', promptSource: 'instruction' },
    options: {},
    generationModels: [imageModel, videoModel],
    executionMode: 'auto',
    target: { id: 'result-1', label: '首图 01', image: '/api/media/result-1' },
    synthesizedCount: 3,
  })
  assert.equal(draft.kind, 'ready')
  if (draft.kind !== 'ready') return
  assert.equal(draft.isVideo, true)
  assert.equal(draft.useInitialFlow, true)
  assert.equal(draft.planSettings.model, 'MiniMax-H3')
  assert.equal(draft.planSettings.duration, 5)
  assert.equal((draft.planContextItems[0] as { id?: string }).id, 'result-1')
  assert.equal(draft.outputCount, undefined)
  // 不含时长的输出设置留给重试命令；时长只进计划设置。
  assert.equal('duration' in draft.generationOverrides, false)

  const plan = buildBotanicAgentInitialDraftPlan(draft)
  assert.equal(plan.kind, 'plan')
  if (plan.kind !== 'plan') return
  assert.equal(plan.plan.settings.duration, 5)
  assert.deepEqual(plan.plan.output, { mode: 'single', count: 1, candidatesPerItem: 1 })
})

test('图片草案：有基准图走服务端规划器，张数随草案透传', () => {
  const draft = prepareBotanicAgentGenerationDraft({
    ...draftBase,
    decision: { kind: 'generation', mediaKind: 'image', promptSource: 'instruction' },
    options: {},
    generationModels: [imageModel, videoModel],
    executionMode: 'auto',
    target: {
      id: 'result-1', label: '首图 01', image: '/api/media/result-1',
      inheritedSettings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
    },
    synthesizedPrompt: '海边礁石人像，黄金时刻逆光',
    synthesizedCount: 3,
  })
  assert.equal(draft.kind, 'ready')
  if (draft.kind !== 'ready') return
  assert.equal(draft.isVideo, false)
  assert.equal(draft.useInitialFlow, false)
  assert.equal(draft.outputCount, 3)
  assert.equal(draft.planSettings.duration, undefined)
})

test('图片草案把 Nano Banana 的固定执行参数写入计划', () => {
  const draft = prepareBotanicAgentGenerationDraft({
    ...draftBase,
    instruction: '生成一张海边广告图',
    decision: { kind: 'generation', mediaKind: 'image', promptSource: 'instruction' },
    options: {},
    generationModels: [imageModel, nanoModel],
    executionMode: 'auto',
    synthesizedPrompt: '海边自然光下的品牌广告图，主体清晰，留出标题空间。',
  })
  assert.equal(draft.kind, 'ready')
  if (draft.kind !== 'ready') return
  assert.deepEqual(draft.planSettings, {
    model: 'gemini-3.1-flash-image-preview',
    aspectRatio: '3:4',
    resolution: '2K',
    searchGrounding: true,
    thinkingLevel: 'high',
  })
})

const synthesizedProse = 'Mia 的氛围肖像照（海边版）：一位 20 多岁韩国女性，黑色长发自然垂落，清透裸妆，身穿燕麦色针织衫，站在海边浅滩上，背景是灰蓝色海面，柔和的自然光，视觉风格清新通透，画面比例 3:4。'

test('变体轴从用户原话解析；综合 Prompt 只做画面描述，不被挖成伪变体', () => {
  const draft = prepareBotanicAgentGenerationDraft({
    ...draftBase,
    instruction: '@Mia 氛围肖像 生成在不同背景下的，比方说在海边和在沙漠',
    decision: { kind: 'generation', mediaKind: 'image', promptSource: 'instruction' },
    options: {},
    generationModels: [imageModel],
    executionMode: 'auto',
    synthesizedPrompt: synthesizedProse,
  })
  assert.equal(draft.kind, 'ready')
  if (draft.kind !== 'ready') return
  const applied = buildBotanicAgentInitialDraftPlan(draft)
  assert.equal(applied.kind, 'plan')
  if (applied.kind !== 'plan') return
  // 用户要的是换背景：场景轴、海边/沙漠两个分支，场景变、人物服装锁定；@ 引用不是取值。
  assert.equal(applied.plan.output.mode, 'batch_by_variation')
  assert.equal(applied.plan.output.count, 2)
  assert.equal(applied.plan.variation?.axes[0]?.key, 'scene')
  assert.deepEqual(applied.plan.variation?.axes[0]?.values.map((value) => value.label), ['海边', '沙漠'])
  assert.equal(applied.plan.constraints.find((item) => item.dimension === 'scene')?.mode, 'vary')
  assert.equal(applied.plan.constraints.find((item) => item.dimension === 'person')?.mode, 'preserve')
  // 共享 Prompt 是可读的画面描述：不带创作简报附录，也不能被值剔除腰斩成碎片。
  assert.ok(!applied.plan.prompt.includes('创作简报'), applied.plan.prompt)
  assert.match(applied.plan.prompt, /韩国女性/)
  assert.match(applied.plan.prompt, /3:4/)
})

test('回合模型结构化声明变体：跳过正则追问，初始计划按声明展开', () => {
  const draft = prepareBotanicAgentGenerationDraft({
    ...draftBase,
    // 这句话在纯正则链路里会因取值凑不齐而追问；结构化声明存在时语义已定，不再追问。
    instruction: '换一个模特肤色',
    decision: { kind: 'generation', mediaKind: 'image', promptSource: 'instruction' },
    options: {},
    generationModels: [imageModel],
    executionMode: 'auto',
    synthesizedPrompt: '棚拍模特肖像，柔光，浅景深，保持人物身份。',
    synthesizedCount: 2,
    synthesizedVariants: [
      { label: '白人', promptDelta: '人物肤色改为白人，保持五官与身份不变' },
      { label: '黑人', promptDelta: '人物肤色改为黑人，保持五官与身份不变' },
    ],
    synthesizedAxisLabel: '肤色',
  })
  assert.equal(draft.kind, 'ready')
  if (draft.kind !== 'ready') return
  assert.deepEqual(draft.structuredVariants?.map((variant) => variant.label), ['白人', '黑人'])
  // 追问回程也要带上声明的变体，回来那一轮不重新解析。
  assert.deepEqual(draft.carryOver.resolvedGeneration?.variants?.map((variant) => variant.label), ['白人', '黑人'])
  assert.equal(draft.carryOver.resolvedGeneration?.variationAxisLabel, '肤色')
  const applied = buildBotanicAgentInitialDraftPlan(draft)
  assert.equal(applied.kind, 'plan')
  if (applied.kind !== 'plan') return
  assert.equal(applied.plan.output.mode, 'batch_by_variation')
  assert.equal(applied.plan.output.count, 2)
  assert.equal(applied.plan.variation?.axes[0]?.label, '肤色')
  assert.deepEqual(applied.plan.variation?.axes[0]?.values.map((value) => value.label), ['白人', '黑人'])
})

test('没有批量语的单图请求即使带综合 Prompt 也保持单张', () => {
  const draft = prepareBotanicAgentGenerationDraft({
    ...draftBase,
    instruction: '生成一张 Mia 的海边氛围肖像',
    decision: { kind: 'generation', mediaKind: 'image', promptSource: 'instruction' },
    options: {},
    generationModels: [imageModel],
    executionMode: 'auto',
    synthesizedPrompt: synthesizedProse,
  })
  assert.equal(draft.kind, 'ready')
  if (draft.kind !== 'ready') return
  const applied = buildBotanicAgentInitialDraftPlan(draft)
  assert.equal(applied.kind, 'plan')
  if (applied.kind !== 'plan') return
  assert.equal(applied.plan.output.mode, 'single')
  assert.equal(applied.plan.output.count, 1)
})

test('无图片上下文的首图草案仍可构建纯文字计划', () => {
  const draft = prepareBotanicAgentGenerationDraft({
    instruction: '生成一张海边广告图',
    decision: { kind: 'generation', mediaKind: 'image', promptSource: 'instruction' },
    options: {},
    messages: [],
    generationModels: [imageModel],
    executionMode: 'auto',
    contextItems: [],
    synthesizedPrompt: '海边自然光下的品牌广告图，主体清晰，留出标题空间。',
  })
  assert.equal(draft.kind, 'ready')
  if (draft.kind !== 'ready') return
  const applied = buildBotanicAgentInitialDraftPlan(draft)
  assert.equal(applied.kind, 'plan')
  if (applied.kind !== 'plan') return
  assert.deepEqual(applied.plan.references, [])
  assert.match(applied.plan.summary, /根据文字描述直接生成 1 张图片/u)
})

test('首图草案按批量变体展开，视频草案不展开', () => {
  const draft = prepareBotanicAgentGenerationDraft({
    ...draftBase,
    instruction: '白皙、自然、小麦三档肤色，多图',
    decision: { kind: 'generation', mediaKind: 'image', promptSource: 'instruction' },
    options: {},
    generationModels: [imageModel],
    executionMode: 'auto',
  })
  assert.equal(draft.kind, 'ready')
  if (draft.kind !== 'ready') return
  const applied = buildBotanicAgentInitialDraftPlan(draft)
  assert.equal(applied.kind, 'plan')
  if (applied.kind !== 'plan') return
  assert.equal(applied.plan.intent, 'initial_generation')
  assert.equal(applied.plan.output.mode, 'batch_by_variation')
  assert.equal(applied.plan.output.count, 3)
})

test('局部重绘语在有可框选目标时先进入框选，选区回程后直接进生成', () => {
  const entry = resolveBotanicAgentInstructionEntry({
    instruction: '只把右上角的花重画一下',
    options: {},
    hasVisualContext: true,
    canSelectRegion: true,
    messages: [],
  })
  assert.deepEqual(entry, { kind: 'select_region' })
  // 贴标识默认走 GPT Image 2 整图精修，不先弹框。
  const addLogo = resolveBotanicAgentInstructionEntry({
    instruction: '添加flock.io的logo',
    options: {},
    hasVisualContext: true,
    canSelectRegion: true,
    messages: [],
  })
  assert.equal(addLogo.kind, 'route')
  if (addLogo.kind === 'route') {
    assert.equal(addLogo.useServerTurn, true)
    assert.equal(addLogo.decision, undefined)
  }

  // 没有可框选目标时不拦截：仍走正常路由（由后续链路提示先选结果图）。
  const noTarget = resolveBotanicAgentInstructionEntry({
    instruction: '只把右上角的花重画一下',
    options: {},
    hasVisualContext: false,
    canSelectRegion: false,
    messages: [],
  })
  assert.equal(noTarget.kind, 'route')

  // 选区回程：确定为图片生成，不再进服务端意图分类。
  const region = { rect: { x: 0.6, y: 0, width: 0.4, height: 0.4 }, description: '画面右上的区域' }
  const withRegion = resolveBotanicAgentInstructionEntry({
    instruction: '只把右上角的花重画一下',
    options: { region },
    hasVisualContext: true,
    canSelectRegion: true,
    messages: [],
  })
  assert.equal(withRegion.kind, 'route')
  if (withRegion.kind !== 'route') return
  assert.equal(withRegion.useServerTurn, false)
  assert.deepEqual(withRegion.decision, { kind: 'generation', mediaKind: 'image', promptSource: 'instruction' })
  assert.deepEqual(withRegion.options.region, region)
})

test('带选区的生成草案一次一张：跳过变体展开与追问', () => {
  const draft = prepareBotanicAgentGenerationDraft({
    ...draftBase,
    instruction: '白皙、自然、小麦三档肤色，多图',
    decision: { kind: 'generation', mediaKind: 'image', promptSource: 'instruction' },
    options: { region: { rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 } } },
    generationModels: [imageModel],
    executionMode: 'auto',
    target: {
      id: 'result-1',
      label: '首图 01',
      image: 'https://example.test/result.png',
      inheritedSettings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
    },
  })
  assert.equal(draft.kind, 'ready')
  if (draft.kind !== 'ready') return
  assert.equal(draft.useInitialFlow, false)
})
