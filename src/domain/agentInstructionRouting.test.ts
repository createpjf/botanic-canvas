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

test('只有全新用户发送才走服务端回合；澄清答复与显式来源保持确定性路径', () => {
  const fresh = resolveBotanicAgentInstructionEntry({
    instruction: '帮我生成一张海边人像', options: {}, hasVisualContext: true, messages: [],
  })
  assert.equal(fresh.kind === 'route' && fresh.useServerTurn, true)

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
    synthesizedCount: 3,
  })
  assert.equal(draft.kind, 'ask')
  if (draft.kind !== 'ask') return
  assert.deepEqual(draft.clarification.resolvedGeneration, {
    mediaKind: 'image', prompt: '海边礁石人像，黄金时刻逆光', count: 3,
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
