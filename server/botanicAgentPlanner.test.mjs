import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BotanicAgentPlannerError,
  planBotanicGeneration,
  validateBotanicAgentPlanInput,
} from './botanicAgentPlanner.mjs'

const validInput = {
  projectId: 'project-agent',
  plannerModel: 'deepseek-v4-flash',
  instruction: '保持人物和服装不变，把场景换成海边，并让环境光更柔和。',
  requestedIntent: 'replace_scene',
  selectedResult: { nodeId: 'result-v03', label: '首图候选 01' },
  settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
  references: [
    { id: 'asset-model', name: '模特 33', role: '模特', primary: false },
    { id: 'asset-product', name: '德国队球衣', role: '商品', primary: true },
  ],
  assetGroup: { id: 'group-scenes', name: '夏日场景', role: '场景', assetCount: 10 },
  assetGroups: [
    { id: 'group-scenes', name: '夏日场景', role: '场景', assetCount: 10 },
    { id: 'group-models', name: '亚洲模特', role: '模特', assetCount: 6 },
  ],
  projectMemory: [
    { id: 'memory-brand', kind: 'rule', content: 'Logo 与瓶身比例不可改变。' },
    { id: 'memory-approved', kind: 'approved', content: '自然侧光与顶部文案留白已获批准。' },
  ],
}

test('Agent 计划输入只接收结构化元数据，不允许图片字节进入文本模型', () => {
  assert.deepEqual(validateBotanicAgentPlanInput(validInput), validInput)

  for (const unsafe of [
    { ...validInput, selectedResult: { ...validInput.selectedResult, image: 'data:image/png;base64,secret' } },
    { ...validInput, references: [{ ...validInput.references[0], dataUrl: 'data:image/png;base64,secret' }] },
    { ...validInput, references: [{ ...validInput.references[0], url: 'https://private.test/image.png' }] },
  ]) {
    assert.throws(
      () => validateBotanicAgentPlanInput(unsafe),
      (error) => error instanceof BotanicAgentPlannerError
        && error.statusCode === 400
        && error.code === 'INVALID_REQUEST',
    )
  }
})

test('Agent Planner 只允许服务端目录中的 Flock 模型，并按请求选择模型', async () => {
  const requests = []
  await planBotanicGeneration(validInput, {
    flockApiKey: 'flock-secret',
    flockTextModel: 'deepseek-v4-pro',
    flockAgentModels: ['deepseek-v4-pro', 'deepseek-v4-flash', 'kimi-k3'],
  }, {
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body))
      return new Response(JSON.stringify({ choices: [{ message: {
        content: null,
        tool_calls: [{ id: 'call-plan-model', type: 'function', function: {
          name: 'generation_create_plan', arguments: JSON.stringify({
            intent: 'replace_scene', prompt: '保持主体，替换场景。', summary: '替换场景。',
            constraints: [{ dimension: 'person', mode: 'preserve' }, { dimension: 'scene', mode: 'vary' }],
          }),
        } }],
      } }] }), { status: 200 })
    },
  })

  assert.equal(requests[0].model, 'deepseek-v4-flash')
  await assert.rejects(
    planBotanicGeneration({ ...validInput, plannerModel: 'attacker-model' }, {
      flockApiKey: 'flock-secret', flockTextModel: 'deepseek-v4-pro',
      flockAgentModels: ['deepseek-v4-pro', 'deepseek-v4-flash', 'kimi-k3'],
    }),
    (error) => error instanceof BotanicAgentPlannerError
      && error.statusCode === 400
      && error.code === 'INVALID_REQUEST',
  )
})

test('Agent 在规格缺失时返回受控追问卡，并从可信模型目录回填选项', async () => {
  const generationModels = [
    { id: 'gpt-image-2', label: 'GPT Image 2', provider: 'openai', mediaKind: 'image', aspectRatios: ['1:1', '3:4'], resolutions: ['1K', '2K'] },
    { id: 'minimax-h3', label: 'MiniMax H3', provider: 'minimax', mediaKind: 'video', aspectRatios: ['16:9'], resolutions: ['2K'] },
  ]
  const result = await planBotanicGeneration({ ...validInput, generationModels }, {
    flockApiKey: 'flock-secret', flockTextModel: 'deepseek-v4-pro',
  }, {
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body)
      assert.ok(request.tools.some((tool) => tool.function.name === 'generation_ask_clarification'))
      return new Response(JSON.stringify({ choices: [{ message: {
        content: null,
        tool_calls: [{ id: 'call-clarify-1', type: 'function', function: {
          name: 'generation_ask_clarification', arguments: JSON.stringify({
            question: '这次输出更偏图片还是视频？', helper: '先确认输出规格，之后仍可在节点里调整。',
            fields: [
              { id: 'model', label: '生成类型' },
              { id: 'aspect_ratio', label: '画面比例' },
              { id: 'resolution', label: '清晰度' },
            ],
          }),
        } }],
      } }] }), { status: 200 })
    },
  })

  assert.equal(result.kind, 'clarification')
  assert.equal(result.clarification.originalInstruction, validInput.instruction)
  assert.deepEqual(result.clarification.fields.map((field) => field.id), ['model', 'aspect_ratio', 'resolution'])
  assert.deepEqual(result.clarification.fields[0].options.map((option) => option.value), ['gpt-image-2', 'minimax-h3'])
  assert.deepEqual(result.clarification.fields[1].options.map((option) => option.value), ['1:1', '3:4'])
  assert.deepEqual(result.clarification.fields[2].options.map((option) => option.value), ['1K', '2K'])
  assert.equal(result.clarification.fields[0].defaultValue, validInput.settings.model)
})

test('Agent 参数回填只接受可信目录中的模型、比例和分辨率', () => {
  const input = validateBotanicAgentPlanInput({
    ...validInput,
    generationModels: [
      { id: 'gpt-image-2', label: 'GPT Image 2', aspectRatios: ['1:1', '3:4'], resolutions: ['1K', '2K'] },
      { id: 'minimax-h3', label: 'MiniMax H3', aspectRatios: ['16:9'], resolutions: ['2K'] },
    ],
    generationOverrides: { model: 'minimax-h3', aspectRatio: '16:9', resolution: '2K' },
    clarificationAnswers: { model: 'minimax-h3', aspect_ratio: '16:9', resolution: '2K' },
  })
  assert.deepEqual(input.settings, { model: 'minimax-h3', aspectRatio: '16:9', resolution: '2K' })
  assert.deepEqual(input.clarificationAnswers, { model: 'minimax-h3', aspect_ratio: '16:9', resolution: '2K' })
  assert.throws(() => validateBotanicAgentPlanInput({
    ...validInput,
    generationModels: [{ id: 'gpt-image-2', label: 'GPT Image 2' }],
    generationOverrides: { model: 'attacker-model' },
  }), /覆盖模型不在可用目录中/)
})

test('Kimi K3 使用服务商要求的 temperature=1，其余规划模型保持低温度', async () => {
  const requests = []
  const fetchImpl = async (_url, init) => {
    requests.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ choices: [{ message: {
      content: null,
      tool_calls: [{ id: `call-plan-temperature-${requests.length}`, type: 'function', function: {
        name: 'generation_create_plan', arguments: JSON.stringify({
          intent: 'replace_scene', prompt: '保持主体，替换场景。', summary: '替换场景。',
          constraints: [{ dimension: 'person', mode: 'preserve' }, { dimension: 'scene', mode: 'vary' }],
        }),
      } }],
    } }] }), { status: 200 })
  }
  const runtime = {
    flockApiKey: 'flock-secret',
    flockTextModel: 'deepseek-v4-pro',
    flockAgentModels: ['deepseek-v4-pro', 'deepseek-v4-flash', 'kimi-k3'],
  }

  await planBotanicGeneration({ ...validInput, plannerModel: 'kimi-k3' }, runtime, { fetchImpl })
  await planBotanicGeneration({ ...validInput, plannerModel: 'deepseek-v4-pro' }, runtime, { fetchImpl })

  assert.equal(requests[0].temperature, 1)
  assert.equal(requests[1].temperature, 0.1)
})

test('项目创作记忆进入规划上下文，但拒绝媒体地址和未知类型', () => {
  assert.deepEqual(validateBotanicAgentPlanInput(validInput).projectMemory, validInput.projectMemory)
  assert.throws(() => validateBotanicAgentPlanInput({
    ...validInput,
    projectMemory: [{ id: 'memory-unsafe', kind: 'rule', content: '保留商品', url: 'https://private.test/product.png' }],
  }), /Agent 计划不接收图片数据/)
  assert.throws(() => validateBotanicAgentPlanInput({
    ...validInput,
    projectMemory: [{ id: 'memory-unknown', kind: 'secret', content: '未知类型' }],
  }), /项目记忆类型无效/)
})

test('服务端 Agent 只让模型解释意图与约束，节点、参数和批量数量由可信输入确定', async () => {
  const requests = []
  const result = await planBotanicGeneration(validInput, {
    flockApiBaseUrl: 'https://api.flock.example/v1/',
    flockApiKey: 'flock-secret',
    flockTextModel: 'deepseek-v4-pro',
    agentPlannerTimeoutMs: 20_000,
  }, {
    fetchImpl: async (url, init) => {
      requests.push({ url, init })
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          choices: [{ message: {
            content: null,
            tool_calls: [
              { id: 'call-canvas-1', type: 'function', function: { name: 'canvas_read', arguments: '{}' } },
              { id: 'call-assets-1', type: 'function', function: { name: 'asset_search', arguments: JSON.stringify({ role: '场景', query: '海边' }) } },
              { id: 'call-skill-1', type: 'function', function: { name: 'skill_run', arguments: JSON.stringify({ skillId: 'controlled_edit' }) } },
            ],
          } }],
        }), { status: 200 })
      }
      return new Response(JSON.stringify({
        choices: [{ message: {
          content: null,
          tool_calls: [{
            id: 'call-plan-1', type: 'function',
            function: { name: 'generation_create_plan', arguments: JSON.stringify({
              intent: 'replace_scene',
              prompt: '保持人物身份、球衣版型与图案一致，替换为海边场景，使用柔和自然光。',
              summary: '锁定人物与服装，批量替换 10 个场景。',
              constraints: [
                { dimension: 'person', mode: 'preserve' },
                { dimension: 'garment', mode: 'preserve' },
                { dimension: 'product', mode: 'preserve' },
                { dimension: 'scene', mode: 'vary' },
                { dimension: 'lighting', mode: 'vary' },
              ],
              selectedResultNodeId: 'attacker-controlled-node',
              settings: { model: 'attacker-model', aspectRatio: '1:1', resolution: '512P' },
              output: { mode: 'single', count: 999, candidatesPerItem: 99 },
            }) },
          }],
        } }],
      }), { status: 200 })
    },
  })

  assert.equal(requests.length, 2)
  assert.equal(requests[0].url, 'https://api.flock.example/v1/chat/completions')
  const firstRequest = JSON.parse(requests[0].init.body)
  const finalRequest = JSON.parse(requests[1].init.body)
  assert.match(firstRequest.messages[0].content, /受控上下文/)
  assert.deepEqual(JSON.parse(firstRequest.messages[1].content), validInput)
  assert.deepEqual(firstRequest.tools.map((item) => item.function.name), [
    'canvas_read', 'asset_search', 'skill_run', 'skill_create_propose', 'generation_ask_clarification', 'generation_create_plan',
  ])
  assert.equal(firstRequest.tool_choice, 'auto')
  assert.deepEqual(finalRequest.messages.filter((message) => message.role === 'tool').map((message) => message.tool_call_id), [
    'call-canvas-1', 'call-assets-1', 'call-skill-1',
  ])
  assert.deepEqual(result, {
    plannerModel: 'deepseek-v4-flash',
    intent: 'replace_scene',
    instruction: validInput.instruction,
    summary: '锁定人物与服装，批量替换 10 个场景。',
    selectedResultNodeId: 'result-v03',
    constraints: [
      { dimension: 'person', mode: 'preserve' },
      { dimension: 'garment', mode: 'preserve' },
      { dimension: 'product', mode: 'preserve' },
      { dimension: 'scene', mode: 'vary', sourceAssetGroupId: 'group-scenes' },
      { dimension: 'lighting', mode: 'vary' },
    ],
    prompt: '保持人物身份、球衣版型与图案一致，替换为海边场景，使用柔和自然光。',
    settings: validInput.settings,
    output: { mode: 'batch_by_asset', count: 10, candidatesPerItem: 1 },
    assetGroupId: 'group-scenes',
    actions: [{
      id: 'call-skill-1', kind: 'skill', toolName: 'skill_apply', label: '应用 Skill：受控局部编辑',
      summary: '按「受控局部编辑」约束本次创作，并把规则写回画布。', risk: 'write',
      arguments: { skillId: 'controlled_edit' }, status: 'awaiting_confirmation',
    }],
    toolCalls: [
      { id: 'call-canvas-1', name: 'canvas_read', label: '读取画布上下文', risk: 'read', status: 'succeeded', requiresConfirmation: false },
      { id: 'call-assets-1', name: 'asset_search', label: '搜索素材', risk: 'read', status: 'succeeded', requiresConfirmation: false },
      { id: 'call-skill-1', name: 'skill_run', label: '调用创作 Skill', risk: 'read', status: 'succeeded', requiresConfirmation: false },
      { id: 'call-plan-1', name: 'generation_create_plan', label: '生成执行计划', risk: 'read', status: 'succeeded', requiresConfirmation: false },
    ],
  })
  assert.doesNotMatch(JSON.stringify([firstRequest, finalRequest]), /secret/)
})

test('Agent 拒绝没有可变项或结构异常的模型输出', async () => {
  await assert.rejects(
    planBotanicGeneration(validInput, {
      flockApiKey: 'flock-secret',
      flockTextModel: 'deepseek-v4-pro',
    }, {
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          intent: 'replace_scene',
          prompt: '保持所有内容不变。',
          summary: '没有变化。',
          constraints: [{ dimension: 'person', mode: 'preserve' }],
        }) } }],
      }), { status: 200 }),
    }),
    (error) => error instanceof BotanicAgentPlannerError
      && error.statusCode === 502
      && error.code === 'INVALID_PROVIDER_RESPONSE',
  )
})

test('Agent Planner 未配置时不会伪装成已接入智能模型', async () => {
  await assert.rejects(
    planBotanicGeneration(validInput, { flockApiKey: '', flockTextModel: '' }),
    (error) => error instanceof BotanicAgentPlannerError
      && error.statusCode === 503
      && error.code === 'PROVIDER_NOT_CONFIGURED',
  )
})

test('项目 Skill 规则只进入受控工具，不直接暴露在模型用户消息中', async () => {
  const requests = []
  const projectSkills = [{
    id: 'skill-brand-safe',
    projectId: validInput.projectId,
    name: '品牌安全首图',
    instructions: '内部规则：不得改变瓶身标签与商标比例。',
    status: 'active',
  }]
  await planBotanicGeneration({ ...validInput, projectSkills }, {
    flockApiKey: 'flock-secret', flockTextModel: 'deepseek-v4-pro',
  }, {
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body))
      return new Response(JSON.stringify({ choices: [{ message: {
        content: null,
        tool_calls: [{ id: 'call-plan-skill-safe', type: 'function', function: {
          name: 'generation_create_plan', arguments: JSON.stringify({
            intent: 'replace_scene', prompt: '保持主体，替换为海边场景。', summary: '替换场景。',
            constraints: [{ dimension: 'person', mode: 'preserve' }, { dimension: 'scene', mode: 'vary' }],
          }),
        } }],
      } }] }), { status: 200 })
    },
  })

  const modelInput = requests[0].messages.find((message) => message.role === 'user').content
  assert.match(modelInput, /skill-brand-safe/)
  assert.match(modelInput, /品牌安全首图/)
  assert.doesNotMatch(modelInput, /内部规则/)
  assert.doesNotMatch(modelInput, /不得改变瓶身标签/)
  const skillTool = requests[0].tools.find((tool) => tool.function.name === 'skill_run')
  assert.deepEqual(skillTool.function.parameters.properties.skillId.enum.includes('skill-brand-safe'), true)
})

test('未手选素材组时，Agent 只能从服务端提供的素材组中选择批量输入', async () => {
  const automaticInput = { ...validInput, assetGroup: undefined }
  const result = await planBotanicGeneration(automaticInput, {
    flockApiKey: 'flock-secret', flockTextModel: 'deepseek-v4-pro',
  }, {
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: {
      content: null,
      tool_calls: [{ id: 'call-plan-auto', type: 'function', function: {
        name: 'generation_create_plan', arguments: JSON.stringify({
          intent: 'replace_scene', prompt: '保持主体，逐一替换场景。', summary: '使用夏日场景组批量生成。',
          constraints: [{ dimension: 'person', mode: 'preserve' }, { dimension: 'scene', mode: 'vary' }],
          assetGroupId: 'group-scenes',
        }),
      } }],
    } }] }), { status: 200 }),
  })

  assert.equal(result.assetGroupId, 'group-scenes')
  assert.deepEqual(result.output, { mode: 'batch_by_asset', count: 10, candidatesPerItem: 1 })
  assert.equal(result.constraints.find((item) => item.dimension === 'scene').sourceAssetGroupId, 'group-scenes')
})
