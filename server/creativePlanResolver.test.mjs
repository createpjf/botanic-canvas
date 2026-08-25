import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentRunCompiledPlanProvenance,
  compileRunCreativePlan,
  compiledBranchFromRun,
  resolveCreativePlan,
} from './creativePlanResolver.mjs'

const settings = { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' }
const models = [
  { id: 'gpt-image-2', provider: 'openai', mediaKind: 'image', aspectRatios: ['3:4'], resolutions: ['2K'] },
  { id: 'minimax-h3', provider: 'minimax', mediaKind: 'video', aspectRatios: ['3:4'], resolutions: ['1080P'], durations: [5, 10], defaultDuration: 5 },
]

function projectDocument() {
  return {
    schemaVersion: 25, id: 'project-1', name: '测试项目',
    nodes: [{
      id: 'result-parent', type: 'result', position: { x: 100, y: 100 }, draggable: true,
      data: {
        kind: 'result', status: 'ready', image: '/api/media/media_parent', label: '首图 01',
        generationRecipe: {
          references: [{ nodeId: 'asset-product-node', assetId: 'asset-product', name: '球衣', image: '/api/media/media_product', role: '商品', primary: true, priority: 1 }],
          prompt: '原始首图', batchCount: 1, settings,
        },
      },
    }],
    edges: [],
    assets: [
      { id: 'asset-scene-a', name: '海边', role: '场景', image: '/api/media/media_scene_a', source: 'upload', tags: [] },
      { id: 'asset-scene-b', name: '森林', role: '场景', image: '/api/media/media_scene_b', source: 'upload', tags: [] },
    ],
    assetGroups: [{ id: 'group-scenes', name: '场景组', role: '场景', assetIds: ['asset-scene-a', 'asset-scene-b'] }],
    generationJobs: [], agentRuns: [], updatedAt: 1,
  }
}

function persistentRun() {
  return {
    id: 'agent-run-1', ownerId: 'user-1', projectId: 'project-1', status: 'queued',
    plan: {
      intent: 'replace_scene', instruction: '批量替换场景', summary: '生成两个场景分支',
      selectedResultNodeId: 'result-parent', prompt: '人物与服装不变，只替换场景。', settings,
      constraints: [{ dimension: 'scene', mode: 'vary', sourceAssetGroupId: 'group-scenes' }],
      output: { mode: 'batch_by_asset', count: 2, candidatesPerItem: 1 },
      assetGroupId: 'group-scenes',
      memoryBindings: [{ id: 'memory-1', version: 2, contentHash: 'hash-1' }],
    },
    branches: [
      { id: 'branch-a', label: '海边', assetId: 'asset-scene-a', status: 'queued', attempt: 0, jobIds: [], outputCount: 0, updatedAt: 1 },
      { id: 'branch-b', label: '森林', assetId: 'asset-scene-b', status: 'queued', attempt: 0, jobIds: [], outputCount: 0, updatedAt: 1 },
    ],
    createdAt: 1, updatedAt: 1,
  }
}

test('Resolve 从权威文档解析每个分支自洽的执行输入', () => {
  const resolved = resolveCreativePlan({ run: persistentRun(), document: projectDocument(), models })
  assert.equal(resolved.parentNode.id, 'result-parent')
  assert.equal(resolved.branches.length, 2)
  // 继续生成只带本轮 @ 的参考（这份计划没有 contextSnapshot），再并入本支素材。
  assert.deepEqual(resolved.branches.map((entry) => entry.recipe.references.map((reference) => reference.assetId)), [
    ['asset-scene-a'],
    ['asset-scene-b'],
  ])
  assert.ok(resolved.branches.every((entry) => entry.isVideo === false))
})

test('引用失效在 Resolve 阶段阻断，并标明失败阶段', () => {
  const document = projectDocument()
  document.assets = document.assets.filter((asset) => asset.id !== 'asset-scene-b')
  assert.throws(
    () => resolveCreativePlan({ run: persistentRun(), document, models }),
    (error) => error.code === 'AGENT_BRANCH_ASSET_MISSING' && error.stage === 'resolve' && error.statusCode === 409,
  )
})

test('Run 不属于当前画布时不进入编译', () => {
  const run = { ...persistentRun(), projectId: 'project-other' }
  assert.throws(
    () => resolveCreativePlan({ run, document: projectDocument(), models }),
    (error) => error.code === 'AGENT_PROJECT_MISMATCH' && error.stage === 'resolve',
  )
})

test('确认快照是 plan 级的：所有分支共享同一次确认的指纹', () => {
  const compiled = compileRunCreativePlan({ run: persistentRun(), document: projectDocument(), models, now: 500 })
  assert.equal(compiled.version, 2)
  assert.equal(compiled.compiledAt, 500)
  assert.ok(compiled.planFingerprint)
  assert.deepEqual(compiled.branches.map((entry) => entry.branchId), ['branch-a', 'branch-b'])
  assert.ok(compiled.branches.every((entry) => entry.planFingerprint === compiled.planFingerprint))
  // 分支指纹互不相同，但都能归回同一次确认。
  assert.equal(new Set(compiled.branches.map((entry) => entry.branchFingerprint)).size, 2)
  // 快照保存实际选中的绑定与质量策略，重试据此重放同一语义。
  assert.deepEqual(compiled.branches[0].memoryBindings, [{ id: 'memory-1', version: 2, contentHash: 'hash-1' }])
  assert.equal(compiled.branches[0].qualityPolicy.humanDecisionRequired, true)
})

test('快照不含图片字节，只留引用标识', () => {
  const compiled = compileRunCreativePlan({ run: persistentRun(), document: projectDocument(), models })
  const serialized = JSON.stringify(compiled)
  assert.equal(serialized.includes('data:image'), false)
  assert.equal(serialized.includes('/api/media/'), false)
  // 引用身份仍在，Resolve 时才据此重新取图。
  assert.deepEqual(compiled.branches[0].references.map((reference) => reference.assetId), ['asset-scene-a'])
})

test('同一次确认重复编译得到同一指纹；换了计划就不是同一次确认', () => {
  const first = compileRunCreativePlan({ run: persistentRun(), document: projectDocument(), models, now: 1 })
  const again = compileRunCreativePlan({ run: persistentRun(), document: projectDocument(), models, now: 999 })
  // 指纹只由确认内容决定，不含编译时刻。
  assert.equal(again.planFingerprint, first.planFingerprint)

  const changed = persistentRun()
  changed.plan.prompt = '换成完全不同的画面描述。'
  const other = compileRunCreativePlan({ run: changed, document: projectDocument(), models })
  assert.notEqual(other.planFingerprint, first.planFingerprint)
})

test('历史 Run 只有计划草案时标记 legacy，不伪造快照', () => {
  assert.equal(agentRunCompiledPlanProvenance(persistentRun()), 'legacy_draft')
  assert.equal(agentRunCompiledPlanProvenance(undefined), 'legacy_draft')
  // 版本不对的快照同样不算：伪造的快照会声称「这就是当时确认的内容」。
  assert.equal(agentRunCompiledPlanProvenance({ compiledPlan: { version: 1, planFingerprint: 'x' } }), 'legacy_draft')
  assert.equal(agentRunCompiledPlanProvenance({ compiledPlan: { version: 2 } }), 'legacy_draft')

  const run = persistentRun()
  run.compiledPlan = compileRunCreativePlan({ run, document: projectDocument(), models })
  assert.equal(agentRunCompiledPlanProvenance(run), 'compiled_v2')
  assert.equal(compiledBranchFromRun(run, 'branch-b')?.branchId, 'branch-b')
  assert.equal(compiledBranchFromRun(run, 'branch-missing'), undefined)
  assert.equal(compiledBranchFromRun(persistentRun(), 'branch-a'), undefined)
})

function initialGenerationDocument() {
  const document = projectDocument()
  document.nodes.push({
    id: 'asset-product-node', type: 'asset', position: { x: 40, y: 80 }, draggable: true,
    data: { kind: 'asset', assetId: 'asset-product', name: '球衣', image: '/api/media/media_product', role: '商品', source: 'upload', mediaKind: 'image', primary: true },
  })
  return document
}

function initialRun({ contextSnapshot = [], planSettings = settings, output = { mode: 'single', count: 2, candidatesPerItem: 1 } } = {}) {
  return {
    id: 'agent-run-initial', ownerId: 'user-1', projectId: 'project-1', status: 'queued',
    plan: {
      intent: 'initial_generation', instruction: '生成商品首图', summary: '生成商品首图',
      contextSnapshot, prompt: '以球衣为主体，生成棚拍商品首图。', settings: planSettings,
      constraints: [], output,
    },
    branches: [{ id: 'branch-initial', label: '商品首图', status: 'queued', attempt: 0, jobIds: [], outputCount: 0, updatedAt: 1 }],
    createdAt: 1, updatedAt: 1,
  }
}

test('纯文字首次生成也能编译出快照，且引用集为空', () => {
  // 纯文字路径没有参考节点；编译不能因此失败，否则纯文字生成拿不到指纹。
  const compiled = compileRunCreativePlan({
    run: initialRun(), document: initialGenerationDocument(), models,
  })
  assert.ok(compiled.planFingerprint)
  assert.deepEqual(compiled.branches[0].references, [])
  assert.equal(compiled.branches[0].batchCount, 2)
})

test('带参考的首次生成把引用身份写进快照，不会退化成纯文字', () => {
  const compiled = compileRunCreativePlan({
    run: initialRun({
      contextSnapshot: [{ nodeId: 'asset-product-node', label: '球衣', kind: '素材', mediaKind: 'image', role: '商品' }],
    }),
    document: initialGenerationDocument(),
    models,
  })
  assert.deepEqual(compiled.branches[0].references.map((reference) => reference.nodeId), ['asset-product-node'])
  // 纯文字与带参考是两次不同的确认，指纹必须不同。
  const textOnly = compileRunCreativePlan({ run: initialRun(), document: initialGenerationDocument(), models })
  assert.notEqual(compiled.planFingerprint, textOnly.planFingerprint)
})

test('视频分支在快照里裁成首帧一张并锁定视频模型', () => {
  const run = initialRun({
    contextSnapshot: [{ nodeId: 'asset-product-node', label: '球衣', kind: '素材', mediaKind: 'image', role: '商品' }],
    planSettings: { model: 'minimax-h3', aspectRatio: '3:4', resolution: '1080P', duration: 5 },
  })
  const compiled = compileRunCreativePlan({ run, document: initialGenerationDocument(), models })
  assert.equal(compiled.branches[0].isVideo, true)
  assert.equal(compiled.branches[0].batchCount, 1)
  assert.equal(compiled.branches[0].references.length, 1)
})

test('局部重绘快照以父结果为基准，选区进入 plan 级指纹', () => {
  const base = {
    ...persistentRun(),
    plan: {
      ...persistentRun().plan,
      intent: 'region_edit',
      region: { rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 } },
      output: { mode: 'single', count: 1, candidatesPerItem: 1 },
    },
    branches: [{ id: 'branch-region', label: '局部重绘', status: 'queued', attempt: 0, jobIds: [], outputCount: 0, updatedAt: 1 }],
  }
  const compiled = compileRunCreativePlan({ run: base, document: projectDocument(), models })
  assert.ok(compiled.planFingerprint)

  const movedRegion = {
    ...base,
    plan: { ...base.plan, region: { rect: { x: 0.5, y: 0.5, width: 0.3, height: 0.3 } } },
  }
  // 换了选区就是另一次确认：不进指纹的话两次重绘会被当成同一次。
  assert.notEqual(
    compileRunCreativePlan({ run: movedRegion, document: projectDocument(), models }).planFingerprint,
    compiled.planFingerprint,
  )
})

test('变体批量的每一支都归回同一次确认，且各自可区分', () => {
  const run = {
    ...persistentRun(),
    plan: {
      ...persistentRun().plan,
      output: { mode: 'batch_by_variation', count: 2, candidatesPerItem: 1 },
      variation: { axisLabel: '场景', values: [{ key: 'scene', label: '海边' }, { key: 'scene', label: '森林' }] },
    },
    branches: [
      { id: 'branch-x', label: '海边', variation: { values: [{ key: 'scene', axisLabel: '场景', valueLabel: '海边' }] }, status: 'queued', attempt: 0, jobIds: [], outputCount: 0, updatedAt: 1 },
      { id: 'branch-y', label: '森林', variation: { values: [{ key: 'scene', axisLabel: '场景', valueLabel: '森林' }] }, status: 'queued', attempt: 0, jobIds: [], outputCount: 0, updatedAt: 1 },
    ],
  }
  const compiled = compileRunCreativePlan({ run, document: projectDocument(), models })
  assert.ok(compiled.branches.every((entry) => entry.planFingerprint === compiled.planFingerprint))
  assert.equal(new Set(compiled.branches.map((entry) => entry.branchFingerprint)).size, 2)
  // 分支增量进了各自的执行 Prompt。
  assert.match(compiled.branches[0].prompt, /海边/u)
  assert.match(compiled.branches[1].prompt, /森林/u)
})
