import assert from 'node:assert/strict'
import test from 'node:test'
import type { AssetGroup, GenerationRecipe } from '../domain/canvas.ts'
import { buildBotanicAgentPlanRequest, completeBotanicAgentPlan } from '../domain/agentPlanContract.ts'

const recipe: GenerationRecipe = {
  primaryReferenceNodeId: 'asset-product',
  references: [
    { nodeId: 'asset-product', assetId: 'product', name: '德国队球衣', image: 'data:image/png;base64,product-secret', role: '商品', primary: true },
    { nodeId: 'asset-model', assetId: 'model', name: '模特 33', image: '/api/media/private-model', role: '模特' },
  ],
  prompt: '模特穿着球衣。',
  batchCount: 1,
  settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
}

const group: AssetGroup = {
  id: 'group-scenes', name: '夏日场景', role: '场景', assetIds: ['scene-1', 'scene-2'], createdAt: 1, updatedAt: 1,
}

test('浏览器只向 Agent Planner 发送参考元数据，不发送图片与媒体地址', () => {
  const request = buildBotanicAgentPlanRequest({
    projectId: 'project-agent',
    plannerModel: 'kimi-k3',
    instruction: '保持人物服装不变，替换场景。',
    requestedIntent: 'replace_scene',
    selectedResultNodeId: 'result-v03',
    selectedResultLabel: '首图候选 01',
    rootRecipe: recipe,
    assetGroup: group,
    availableAssetGroups: [
      { ...group, id: 'empty-scenes', name: '空场景组', assetIds: [] },
      group,
    ],
    projectMemory: [
      { id: 'memory-brand', kind: 'rule', content: 'Logo 与瓶身比例不可改变。', sourceNodeIds: ['asset-product'], createdAt: 1, updatedAt: 1 },
    ],
  })

  assert.deepEqual(request, {
    projectId: 'project-agent',
    plannerModel: 'kimi-k3',
    instruction: '保持人物服装不变，替换场景。',
    requestedIntent: 'replace_scene',
    selectedResult: { nodeId: 'result-v03', label: '首图候选 01' },
    settings: recipe.settings,
    references: [
      { id: 'asset-product', name: '德国队球衣', role: '商品', primary: true },
      { id: 'asset-model', name: '模特 33', role: '模特', primary: false },
    ],
    assetGroup: { id: 'group-scenes', name: '夏日场景', role: '场景', assetCount: 2 },
    assetGroups: [{ id: 'group-scenes', name: '夏日场景', role: '场景', assetCount: 2 }],
    projectMemory: [{ id: 'memory-brand', kind: 'rule', content: 'Logo 与瓶身比例不可改变。' }],
  })
  assert.doesNotMatch(JSON.stringify(request), /base64|private-model|media/i)
})

test('浏览器把追问答案和模型目录回填到 Agent 请求，但仍只发送安全元数据', () => {
  const request = buildBotanicAgentPlanRequest({
    projectId: 'project-agent',
    instruction: '把场景换成海边。',
    selectedResultNodeId: 'result-v03',
    selectedResultLabel: '首图候选 01',
    rootRecipe: recipe,
    generationOverrides: { model: 'minimax-h3', aspectRatio: '16:9', resolution: '2K' },
    clarificationAnswers: { model: 'minimax-h3', aspect_ratio: '16:9', resolution: '2K' },
    availableGenerationModels: [
      { id: 'gpt-image-2', label: 'GPT Image 2', provider: 'openai', mediaKind: 'image', aspectRatios: ['1:1', '3:4'], resolutions: ['1K', '2K'] },
      { id: 'minimax-h3', label: 'MiniMax H3', provider: 'minimax', mediaKind: 'video', aspectRatios: ['16:9'], resolutions: ['2K'] },
    ],
  })

  assert.deepEqual(request.settings, { model: 'minimax-h3', aspectRatio: '16:9', resolution: '2K' })
  assert.deepEqual(request.clarificationAnswers, { model: 'minimax-h3', aspect_ratio: '16:9', resolution: '2K' })
  assert.deepEqual(request.generationModels, [
    { id: 'gpt-image-2', label: 'GPT Image 2', provider: 'openai', mediaKind: 'image', aspectRatios: ['1:1', '3:4'], resolutions: ['1K', '2K'] },
    { id: 'minimax-h3', label: 'MiniMax H3', provider: 'minimax', mediaKind: 'video', aspectRatios: ['16:9'], resolutions: ['2K'] },
  ])
  assert.doesNotMatch(JSON.stringify(request), /data:image|private-model/i)
})

test('浏览器把可信计划草稿与本地原配方合成可执行计划', () => {
  const input = {
    projectId: 'project-agent', instruction: '换场景', requestedIntent: 'replace_scene' as const,
    selectedResultNodeId: 'result-v03', selectedResultLabel: '首图候选 01', rootRecipe: recipe, assetGroup: group,
  }
  const plan = completeBotanicAgentPlan({
    intent: 'replace_scene',
    instruction: '换场景',
    summary: '锁定人物与服装，生成 2 个场景分支。',
    selectedResultNodeId: 'result-v03',
    constraints: [
      { dimension: 'person', mode: 'preserve' },
      { dimension: 'scene', mode: 'vary', sourceAssetGroupId: 'group-scenes' },
    ],
    prompt: '保持人物和服装不变，替换场景。',
    settings: recipe.settings,
    output: { mode: 'batch_by_asset', count: 2, candidatesPerItem: 1 },
    assetGroupId: 'group-scenes',
    toolCalls: [{
      id: 'call-plan-1', name: 'generation_create_plan', label: '生成执行计划',
      risk: 'read', status: 'succeeded', requiresConfirmation: false,
    }],
  }, input)

  assert.equal(plan.rootRecipe, recipe)
  assert.deepEqual(plan.references.map((item) => item.source), ['selected_result', 'root_recipe', 'root_recipe', 'asset_group'])
  assert.equal(plan.references[0].id, 'result-v03')
  assert.equal(plan.references[3].id, 'group-scenes')
  assert.equal(plan.toolCalls?.[0].name, 'generation_create_plan')
})

test('浏览器合成计划时保留追问后的生成参数，而不是被旧根配方覆盖', () => {
  const input = {
    projectId: 'project-agent', instruction: '生成视频', requestedIntent: 'continue_generation' as const,
    selectedResultNodeId: 'result-v03', selectedResultLabel: '首图候选 01', rootRecipe: recipe,
    generationOverrides: { model: 'minimax-h3', aspectRatio: '16:9' as const, resolution: '2K' as const },
  }
  const plan = completeBotanicAgentPlan({
    intent: 'continue_generation', instruction: input.instruction, summary: '生成视频。',
    selectedResultNodeId: input.selectedResultNodeId,
    constraints: [{ dimension: 'scene', mode: 'vary' }],
    prompt: '让画面动起来。', settings: recipe.settings,
    output: { mode: 'single', count: 1, candidatesPerItem: 1 },
  }, input)
  assert.deepEqual(plan.settings, { model: 'minimax-h3', aspectRatio: '16:9', resolution: '2K' })
})

test('Agent 自动选择素材组后，浏览器仍能恢复对应素材组引用', () => {
  const input = {
    projectId: 'project-agent', instruction: '批量换场景', requestedIntent: 'replace_scene' as const,
    selectedResultNodeId: 'result-v03', selectedResultLabel: '首图候选 01', rootRecipe: recipe,
    availableAssetGroups: [group],
  }
  const plan = completeBotanicAgentPlan({
    intent: 'replace_scene', instruction: input.instruction, summary: '按场景组生成。',
    selectedResultNodeId: input.selectedResultNodeId,
    constraints: [{ dimension: 'scene', mode: 'vary', sourceAssetGroupId: group.id }],
    prompt: '保持主体，批量替换场景。', settings: recipe.settings,
    output: { mode: 'batch_by_asset', count: 2, candidatesPerItem: 1 },
    assetGroupId: group.id,
  }, input)

  assert.deepEqual(plan.references.at(-1), {
    source: 'asset_group', id: group.id, label: group.name, role: group.role,
  })
})
