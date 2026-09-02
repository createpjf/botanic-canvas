import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WORKFLOW_INPUT_FIELDS,
  applyWorkflowItemResult,
  createProductionWorkflowRun,
  createProductionWorkflowVersion,
  generationArtifactId,
  normalizeWorkflowItemInput,
  productionWorkflowLineage,
  productionWorkflowVersionProvenance,
  resolveProductionWorkflowRecipe,
  resolveProductionWorkflowSource,
  resolveWorkflowBrandRules,
  resolveWorkflowExecutionContract,
  retryFailedWorkflowItems,
  transitionProductionWorkflowRun,
  withWorkflowBrandRules,
} from './productionWorkflow.mjs'

test('生产工作流运行时从项目权威文档解析稳定媒体且拒绝临时图片', () => {
  const definition = {
    recipe: { references: [{ nodeId: 'asset-node', assetId: 'asset-a', name: '商品', role: '商品', primary: true }] },
  }
  assert.deepEqual(resolveProductionWorkflowRecipe(definition, {
    assets: [{ id: 'asset-a', image: '/api/media/media_product', mediaKind: 'image' }],
    nodes: [],
  }).references[0], {
    nodeId: 'asset-node', assetId: 'asset-a', name: '商品', role: '商品', primary: true,
    priority: 1, mediaKind: 'image', mediaId: 'media_product',
  })
  assert.throws(() => resolveProductionWorkflowRecipe(definition, {
    assets: [{ id: 'asset-a', image: 'blob:http://localhost/temporary' }],
    nodes: [],
  }), /缺少稳定媒体/)
})

const definition = {
  prompt: '保持商品与人物，只替换场景。',
  model: 'gpt-image-2',
  settings: { aspectRatio: '4:5', resolution: '2K', batchCount: 1 },
  output: { mediaKind: 'image', reviewRequired: true },
  brandRules: ['保持米白与植物绿', '不得改变商品包装'],
  assetGroupIds: ['group-brand', 'group-product'],
  confirmationPolicy: 'before-external-action',
}

const source = { canvasNodeId: 'generate-a', runId: 'run-a', branchId: 'branch-a', resultNodeIds: [], artifactIds: [] }

const sourceDocument = {
  nodes: [
    { id: 'generate-a', type: 'generate', data: { kind: 'generate' } },
    { id: 'asset-a', type: 'asset', data: { kind: 'asset' } },
    { id: 'result-a', type: 'result', data: { kind: 'result', jobId: 'job-a', candidateId: 'candidate-a', agentRun: { runId: 'run-a', branchId: 'branch-a' } } },
    { id: 'result-pending', type: 'result', data: { kind: 'result', agentRun: { runId: 'run-a', branchId: 'branch-a' } } },
  ],
  agentRuns: [{ id: 'run-a', status: 'completed', branches: [{ id: 'branch-a' }] }],
}

test('显式来源按项目权威文档解析，Artifact 标识只由服务端生成', () => {
  const resolved = resolveProductionWorkflowSource({
    canvasNodeId: 'generate-a', runId: 'run-a', branchId: 'branch-a', resultNodeIds: ['result-a'],
  }, sourceDocument)
  assert.deepEqual(resolved, {
    canvasNodeId: 'generate-a', runId: 'run-a', branchId: 'branch-a',
    resultNodeIds: ['result-a'], artifactIds: [generationArtifactId('job-a', 'candidate-a')],
  })
  // 纯文字来源没有引用也没有结果时同样可解析。
  assert.deepEqual(resolveProductionWorkflowSource({ canvasNodeId: 'generate-a', resultNodeIds: [] }, sourceDocument), {
    canvasNodeId: 'generate-a', resultNodeIds: [], artifactIds: [],
  })
})

test('来源缺失或实体不成立时拒绝发布，服务端不退到别的节点', () => {
  const cases = [
    [undefined, 'WORKFLOW_SOURCE_REQUIRED'],
    [{ canvasNodeId: 'ghost', resultNodeIds: [] }, 'WORKFLOW_SOURCE_NODE_NOT_FOUND'],
    [{ canvasNodeId: 'asset-a', resultNodeIds: [] }, 'WORKFLOW_SOURCE_NODE_INVALID'],
    [{ canvasNodeId: 'generate-a', branchId: 'branch-a', resultNodeIds: [] }, 'WORKFLOW_SOURCE_BRANCH_WITHOUT_RUN'],
    [{ canvasNodeId: 'generate-a', runId: 'ghost', resultNodeIds: [] }, 'WORKFLOW_SOURCE_RUN_NOT_FOUND'],
    [{ canvasNodeId: 'generate-a', runId: 'run-a', branchId: 'ghost', resultNodeIds: [] }, 'WORKFLOW_SOURCE_BRANCH_NOT_FOUND'],
    [{ canvasNodeId: 'generate-a', resultNodeIds: ['ghost'] }, 'WORKFLOW_SOURCE_RESULT_NOT_FOUND'],
    [{ canvasNodeId: 'generate-a', resultNodeIds: ['asset-a'] }, 'WORKFLOW_SOURCE_RESULT_NOT_FOUND'],
    [{ canvasNodeId: 'generate-a', resultNodeIds: ['result-pending'] }, 'WORKFLOW_SOURCE_RESULT_UNRESOLVED'],
    [{ canvasNodeId: 'generate-a', resultNodeIds: ['result-a', 'result-a'] }, 'WORKFLOW_SOURCE_RESULTS_INVALID'],
  ]
  for (const [input, code] of cases) {
    assert.throws(() => resolveProductionWorkflowSource(input, sourceDocument), (caught) => {
      assert.equal(caught.code, code, `来源 ${JSON.stringify(input)} 应返回 ${code}，实际 ${caught.code}`)
      return true
    })
  }
})

test('未完成的 Agent Run 不能作为发布来源', () => {
  const running = { ...sourceDocument, agentRuns: [{ id: 'run-a', status: 'running', branches: [] }] }
  assert.throws(
    () => resolveProductionWorkflowSource({ canvasNodeId: 'generate-a', runId: 'run-a', resultNodeIds: [] }, running),
    (caught) => caught.code === 'WORKFLOW_SOURCE_RUN_NOT_TERMINAL',
  )
})

test('缺少来源快照的历史版本按 legacy_unverified 读取，不伪造来源', () => {
  assert.equal(productionWorkflowVersionProvenance({ version: 1, definition }), 'legacy_unverified')
  assert.equal(productionWorkflowVersionProvenance({ version: 1, definition, source }), 'verified')
  assert.equal(productionWorkflowVersionProvenance(undefined), 'legacy_unverified')
  const published = createProductionWorkflowVersion({
    id: 'workflow-a', projectId: 'project-a', name: '来源可查', definition, source,
  }, { actorId: 'user-a', now: 100 })
  assert.equal(productionWorkflowVersionProvenance(published.versions[0]), 'verified')
  assert.deepEqual(published.versions[0].source, source)
})

test('发布必须携带来源，缺失时明确失败而不是写入无来源版本', () => {
  assert.throws(() => createProductionWorkflowVersion({
    id: 'workflow-a', projectId: 'project-a', name: '无来源', definition,
  }, { actorId: 'user-a', now: 100 }), (caught) => caught.code === 'WORKFLOW_SOURCE_REQUIRED')
})

test('工作流版本保存完整生产设置，升级不会改变旧版本', () => {
  const first = createProductionWorkflowVersion({
    id: 'workflow-a', projectId: 'project-a', name: '夏日场景', definition, source,
  }, { actorId: 'user-a', now: 100 })
  const second = createProductionWorkflowVersion({
    id: 'workflow-a', projectId: 'project-a', name: '夏日场景',
    definition: { ...definition, prompt: '替换为海边晨光。' },
    source: { ...source, canvasNodeId: 'generate-b' },
    previous: first,
  }, { actorId: 'user-a', now: 200 })

  assert.equal(first.currentVersion, 1)
  assert.equal(second.currentVersion, 2)
  assert.equal(second.versions[0].definition.prompt, definition.prompt)
  assert.equal(second.versions[1].definition.prompt, '替换为海边晨光。')
  assert.deepEqual(second.versions[1].definition.assetGroupIds, ['group-brand', 'group-product'])
  assert.equal(second.versions[1].definition.confirmationPolicy, 'before-external-action')
})

test('批量运行固定工作流版本，支持部分失败、失败项重试和刷新恢复', () => {
  const workflow = createProductionWorkflowVersion({
    id: 'workflow-a', projectId: 'project-a', name: '批量首图', definition, source,
  }, { actorId: 'user-a', now: 100 })
  const run = createProductionWorkflowRun({
    id: 'workflow-run-a', workflow, itemInputs: [
      { id: 'sku-a', variables: { product: '香水 A' } },
      { id: 'sku-b', variables: { product: '香水 B' } },
    ],
  }, { actorId: 'user-a', now: 200 })

  const running = transitionProductionWorkflowRun(run, 'start', { now: 210 })
  const oneDone = applyWorkflowItemResult(running, 'sku-a', {
    status: 'succeeded', jobId: 'job-a', artifactIds: ['artifact-a'], canvasNodeIds: ['result-a'],
  }, { now: 220 })
  const partial = applyWorkflowItemResult(oneDone, 'sku-b', {
    status: 'failed', jobId: 'job-b', error: { code: 'PROVIDER_TIMEOUT', message: '超时' },
  }, { now: 230 })
  const recovered = JSON.parse(JSON.stringify(partial))
  const retried = retryFailedWorkflowItems(recovered, { now: 240 })

  assert.equal(partial.status, 'partially_failed')
  assert.equal(partial.workflowVersion, 1)
  assert.equal(retried.status, 'running')
  assert.equal(retried.items[0].status, 'succeeded')
  assert.equal(retried.items[1].status, 'queued')
  assert.equal(retried.items[1].attempt, 2)
  assert.equal(retried.items[1].idempotencyKey, partial.items[1].idempotencyKey)
})

test('运行可暂停、恢复与取消，终态和历史版本不会被静默重写', () => {
  const workflow = createProductionWorkflowVersion({
    id: 'workflow-a', projectId: 'project-a', name: '批量首图', definition, source,
  }, { actorId: 'user-a', now: 100 })
  const run = createProductionWorkflowRun({ id: 'run-a', workflow, itemInputs: [{ id: 'sku-a' }] }, { actorId: 'user-a', now: 200 })
  const paused = transitionProductionWorkflowRun(transitionProductionWorkflowRun(run, 'start', { now: 210 }), 'pause', { now: 220 })
  const resumed = transitionProductionWorkflowRun(paused, 'resume', { now: 230 })
  const cancelled = transitionProductionWorkflowRun(resumed, 'cancel', { now: 240 })

  assert.equal(paused.status, 'paused')
  assert.equal(resumed.status, 'running')
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.workflowVersion, 1)
  assert.throws(() => transitionProductionWorkflowRun(cancelled, 'resume', { now: 250 }), /终态/)
})

test('开启质量门时全部生成完成后必须经过人工评审才能发布', () => {
  const workflow = createProductionWorkflowVersion({
    id: 'workflow-review', projectId: 'project-a', name: '需审核', definition, source,
  }, { actorId: 'user-a', now: 100 })
  const run = createProductionWorkflowRun({ id: 'run-review', workflow, itemInputs: [{ id: 'sku-a' }] }, { actorId: 'user-a', now: 200 })
  const awaiting = applyWorkflowItemResult(transitionProductionWorkflowRun(run, 'start', { now: 210 }), 'sku-a', { status: 'succeeded', jobId: 'job-a' }, { now: 220 })
  assert.equal(awaiting.status, 'awaiting_review')
  assert.equal(awaiting.qualityGate.status, 'pending')
  assert.equal(transitionProductionWorkflowRun(awaiting, 'approve-review', { now: 230 }).status, 'succeeded')
  assert.equal(transitionProductionWorkflowRun(awaiting, 'reject-review', { now: 240 }).status, 'failed')
})

test('工作流结果血缘关联版本、运行、任务、Artifact、画布节点与来源版本', () => {
  assert.deepEqual(productionWorkflowLineage({
    workflowId: 'workflow-a', workflowVersion: 3, runId: 'run-a', itemId: 'sku-a',
    jobId: 'job-a', artifactId: 'artifact-a', canvasNodeId: 'result-a', sourceVersionId: 'history-a',
  }), {
    workflowId: 'workflow-a', workflowVersion: 3, workflowRunId: 'run-a', workflowItemId: 'sku-a',
    generationJobId: 'job-a', artifactId: 'artifact-a', canvasNodeId: 'result-a', sourceVersionId: 'history-a',
  })
})

test('批量项标识来自业务身份，不是位置', () => {
  // 位置标识在重排或补项后会指向另一行，重试就会打到错误的项上。
  const first = normalizeWorkflowItemInput({ sku: 'SKU-001', channel: '天猫', variables: { product: '香水' } }, { index: 0 })
  assert.equal(first.id, 'SKU-001')
  assert.equal(first.channel, '天猫')
  // 声明字段自动进插值上下文，Prompt 里 {{sku}} 直接可用。
  assert.equal(first.variables.sku, 'SKU-001')
  assert.equal(first.variables.product, '香水')

  // 没有业务身份时才退回位置标识。
  assert.equal(normalizeWorkflowItemInput({ variables: { product: '香水' } }, { index: 2 }).id, 'item-3')
  // 显式 id 优先。
  assert.equal(normalizeWorkflowItemInput({ id: 'custom', sku: 'SKU-001' }, { index: 0 }).id, 'custom')
})

test('同一批里重复的业务标识是输入错误，不静默去重', () => {
  const taken = new Set()
  normalizeWorkflowItemInput({ sku: 'SKU-001' }, { index: 0, taken })
  assert.throws(() => normalizeWorkflowItemInput({ sku: 'SKU-001' }, { index: 1, taken }), /标识重复/u)
})

test('批量输入字段是声明式的，未声明的键只能进 variables', () => {
  assert.deepEqual([...WORKFLOW_INPUT_FIELDS], ['sku', 'channel', 'language', 'aspectRatio', 'copy', 'assetGroupId'])
  const item = normalizeWorkflowItemInput({ sku: 'S1', notAField: 'x', variables: { notAField: 'y' } }, { index: 0 })
  assert.equal(item.notAField, undefined)
  assert.equal(item.variables.notAField, 'y')
})

test('版本固定执行契约：计划指纹、绑定与质量策略随版本落库', () => {
  // 新版本不改变历史或进行中的 Run，靠的就是运行只读版本里的这份快照。
  const document = {
    id: 'project-a',
    nodes: [
      { id: 'generate-a', type: 'generate', data: { kind: 'generate' } },
      {
        id: 'result-a', type: 'result',
        data: {
          kind: 'result', jobId: 'job-a', candidateId: 'out-1',
          generationRecipe: {
            planFingerprint: 'plan-fp', branchFingerprint: 'branch-fp',
            qualityPolicy: { version: 1, requiredCriteria: ['identity'], humanDecisionRequired: true },
            skillBindings: [{ id: 'skill-1', version: 2, contentHash: 'h' }],
            memoryBindings: [{ id: 'memory-1', version: 3 }],
          },
        },
      },
    ],
    agentRuns: [],
  }
  const contract = resolveWorkflowExecutionContract({ canvasNodeId: 'generate-a', resultNodeIds: ['result-a'] }, document)
  assert.equal(contract.planFingerprint, 'plan-fp')
  assert.equal(contract.branchFingerprint, 'branch-fp')
  assert.deepEqual(contract.qualityPolicy.requiredCriteria, ['identity'])
  assert.deepEqual(contract.skillBindings, [{ id: 'skill-1', version: 2, contentHash: 'h' }])
  assert.deepEqual(contract.memoryBindings, [{ id: 'memory-1', version: 3 }])
  // 取不到就不写，缺字段表示「这个版本没固定它」，而不是伪造一份。
  assert.deepEqual(resolveWorkflowExecutionContract({ canvasNodeId: 'generate-a', resultNodeIds: [] }, document), {})
})

test('版本固定的品牌规则进入执行 Prompt，而不是只存不读', () => {
  // 此前 brandRules 写而不读：用户以为「这条流程会遵守品牌规则」，实际不会。
  const definition = { brandRules: ['主色只用品牌绿', '不要出现竞品 Logo'] }
  const prompt = withWorkflowBrandRules('为香水 A 生成品牌首图。', definition)
  assert.match(prompt, /必须遵守的品牌规则：/u)
  assert.match(prompt, /- 主色只用品牌绿/u)
  // 规则作为前缀出现，用户的画面描述原样保留在后面。
  assert.ok(prompt.endsWith('为香水 A 生成品牌首图。'))
})

test('没有品牌规则时 Prompt 原样不动', () => {
  assert.equal(withWorkflowBrandRules('生成首图。', {}), '生成首图。')
  assert.equal(withWorkflowBrandRules('生成首图。', { brandRules: [] }), '生成首图。')
  assert.equal(withWorkflowBrandRules('生成首图。', { brandRules: ['  ', ''] }), '生成首图。')
})

test('规则来自版本快照，历史版本重跑按当时的规则执行', () => {
  // 读当前项目记忆的话，「新版本不改变进行中的运行」就不成立。
  const oldVersion = { brandRules: ['主色用旧版蓝'] }
  const newVersion = { brandRules: ['主色只用品牌绿'] }
  assert.match(withWorkflowBrandRules('x', oldVersion), /旧版蓝/u)
  assert.match(withWorkflowBrandRules('x', newVersion), /品牌绿/u)
  assert.doesNotMatch(withWorkflowBrandRules('x', oldVersion), /品牌绿/u)
})

test('一次批量里天猫项与京东项各自遵守各自的规范', () => {
  // 这是适用主体要解决的实际问题：此前所有规则无差别进每一项，用户只能把
  // 「（仅天猫）」写进规则正文，指望模型自己注意到。
  const document = {
    id: 'p-1',
    agentMemory: [
      { id: 'all', kind: 'rule', content: '主色只用品牌绿', sourceNodeIds: [], createdAt: 1, updatedAt: 1, source: 'human', status: 'active' },
      { id: 'tmall', kind: 'rule', content: '天猫主图顶部留 20% 安全区', sourceNodeIds: [], createdAt: 1, updatedAt: 2, source: 'human', status: 'active', subject: 'channel', subjectValue: 'tmall' },
      { id: 'jd', kind: 'rule', content: '京东主图不加促销角标', sourceNodeIds: [], createdAt: 1, updatedAt: 3, source: 'human', status: 'active', subject: 'channel', subjectValue: 'jd' },
    ],
  }
  // 发布时固定的是全集：此刻还没有批量项，也就没有渠道可比。
  const definition = resolveWorkflowBrandRules(document)
  assert.equal(definition.brandRules.length, 3, '版本固定全部三条')
  assert.deepEqual(
    definition.brandRuleBindings.filter((binding) => binding.subject).map((binding) => `${binding.id}:${binding.subjectValue}`).sort(),
    ['jd:jd', 'tmall:tmall'],
  )
  // 内容与绑定必须同序：执行期按下标对应，错位会让规则张冠李戴。
  definition.brandRuleBindings.forEach((binding, index) => {
    const item = document.agentMemory.find((entry) => entry.id === binding.id)
    assert.equal(definition.brandRules[index], item.content, `第 ${index} 条内容与绑定对应`)
  })

  const tmallPrompt = withWorkflowBrandRules('生成首图。', definition, { context: { channel: 'tmall' } })
  assert.match(tmallPrompt, /主色只用品牌绿/u)
  assert.match(tmallPrompt, /天猫主图顶部留 20% 安全区/u)
  assert.equal(/京东主图不加促销角标/u.test(tmallPrompt), false)

  const jdPrompt = withWorkflowBrandRules('生成首图。', definition, { context: { channel: 'jd' } })
  assert.match(jdPrompt, /京东主图不加促销角标/u)
  assert.equal(/天猫主图顶部留 20% 安全区/u.test(jdPrompt), false)
})

test('发布于适用主体上线之前的历史版本，执行语义完全不变', () => {
  // 没有绑定就一律保留：历史版本的执行不能因为这次改动而变。
  const legacy = { brandRules: ['主色只用品牌绿', '不要出现竞品'] }
  const prompt = withWorkflowBrandRules('生成首图。', legacy, { context: { channel: 'tmall' } })
  assert.match(prompt, /主色只用品牌绿/u)
  assert.match(prompt, /不要出现竞品/u)
})

test('没有渠道信息时限定渠道的规则不生效', () => {
  const definition = {
    brandRules: ['全项目规则', '天猫规则'],
    brandRuleBindings: [{ id: 'all' }, { id: 'tmall', subject: 'channel', subjectValue: 'tmall' }],
  }
  const prompt = withWorkflowBrandRules('生成首图。', definition, {})
  assert.match(prompt, /全项目规则/u)
  assert.equal(/天猫规则/u.test(prompt), false)
})
