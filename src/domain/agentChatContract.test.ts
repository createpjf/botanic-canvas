import assert from 'node:assert/strict'
import test from 'node:test'
import type { GenerationModelOption } from './canvas.ts'
import {
  buildBotanicAgentChatRequest,
  decideBotanicAgentRequest,
  inferBotanicAgentGenerationSettings,
  isBotanicAgentPromptGenerationPending,
  resolveBotanicAgentGenerationPromptDecision,
} from './agentChatContract.ts'

test('通用 Agent 对话请求只发送有限消息与节点 ID', () => {
  const request = buildBotanicAgentChatRequest({
    projectId: 'project-chat',
    plannerModel: 'kimi-k3',
    mode: 'research',
    messages: Array.from({ length: 18 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: `消息 ${index}` })),
    contextNodeIds: ['node-a', 'node-a', 'node-b'],
  })

  assert.equal(request.messages.length, 16)
  assert.deepEqual(request.messages[0], { role: 'user', content: '消息 2' })
  assert.deepEqual(request.contextNodeIds, ['node-a', 'node-b'])
  assert.doesNotMatch(JSON.stringify(request), /image|data:image|base64|url/i)
})

test('图片咨询、运行状态和能力询问不会误触发生成', () => {
  const consultations = [
    '这张图片怎么写比较好？',
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
    assert.notEqual(decideBotanicAgentRequest(instruction, true).kind, 'generation', instruction)
  })
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

test('视频执行请求不得误建图片节点', () => {
  assert.deepEqual(decideBotanicAgentRequest('帮我生成一个视频'), {
    kind: 'clarification',
    reason: 'unsupported_media',
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
  for (const instruction of ['把背景换成海边', '把风格改成胶片', '将模特换成男性']) {
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
