import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanvasDocument } from './canvas.ts'
import { eligibleProductionWorkflowSources, productionWorkflowDraftFromCanvas } from './productionWorkflows.ts'

const agentRun = (id: string, status: 'completed' | 'partial' | 'running') => ({
  id, status, createdAt: 1, updatedAt: 2, completedBranchCount: 1, failedBranchCount: 0,
  branches: [], plan: {} as never,
})

const resultNode = (id: string, runId: string, branchId: string, outputOf: string) => ({
  id, type: 'result' as const, position: { x: 600, y: 0 },
  data: {
    kind: 'result' as const, status: 'ready' as const, image: '/api/media/media-out',
    jobId: `job-${runId}`, candidateId: `${id}-candidate`, outputOf,
    agentRun: { runId, branchId }, label: '生成结果',
  },
})

const document = {
  schemaVersion: 25,
  id: 'project-a', name: '品牌项目', updatedAt: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  assets: [{ id: 'asset-a', name: '商品', role: '商品', image: '/api/media/media-a', source: 'upload', tags: [] }],
  assetGroups: [{ id: 'group-a', name: '商品组', role: '商品', assetIds: ['asset-a'], createdAt: 1, updatedAt: 1 }],
  templates: [], history: [], deliveries: [], generationJobs: [], batchVariationRuns: [], agentSessions: [],
  agentMemory: [
    { id: 'memory-a', kind: 'rule', content: '保持植物学留白', sourceNodeIds: [], createdAt: 1, updatedAt: 1, confidence: 'confirmed' },
    { id: 'memory-b', kind: 'rule', content: '未确认的猜测', sourceNodeIds: [], createdAt: 1, updatedAt: 1, confidence: 'provisional' },
  ],
  agentRuns: [agentRun('run-a', 'completed'), agentRun('run-b', 'completed'), agentRun('run-c', 'running')],
  nodes: [
    { id: 'asset-node', type: 'asset', position: { x: 0, y: 0 }, data: { kind: 'asset', assetId: 'asset-a', role: '商品', name: '商品', image: '/api/media/media-a', source: 'upload' } },
    { id: 'generate-a', type: 'generate', position: { x: 300, y: 0 }, data: {
      kind: 'generate', label: '品牌首图', prompt: '生成植物学品牌首图', batchCount: 2,
      settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
      agentRun: { runId: 'run-a', branchId: 'branch-a' },
    } },
    { id: 'generate-b', type: 'generate', position: { x: 300, y: 400 }, data: {
      kind: 'generate', label: '纯文字草稿', prompt: '生成秋季主视觉，无参考图', batchCount: 1,
      settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
      agentRun: { runId: 'run-b', branchId: 'branch-b' },
    } },
    { id: 'generate-c', type: 'generate', position: { x: 300, y: 800 }, data: {
      kind: 'generate', label: '进行中', prompt: '仍在执行', batchCount: 1,
      settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
      agentRun: { runId: 'run-c', branchId: 'branch-c' },
    } },
    resultNode('result-a1', 'run-a', 'branch-a', 'generate-a'),
    resultNode('result-a2', 'run-a', 'branch-a', 'generate-a'),
    resultNode('result-b1', 'run-b', 'branch-b', 'generate-b'),
  ],
  edges: [{ id: 'edge-a', source: 'asset-node', target: 'generate-a' }],
} satisfies CanvasDocument

function draftOf(documentValue: CanvasDocument, nodeId: string) {
  const result = productionWorkflowDraftFromCanvas(documentValue, nodeId)
  assert.equal(result.ok, true, `预期 ${nodeId} 可提升，实际 ${JSON.stringify(result)}`)
  return result.ok ? result.draft : undefined!
}

test('已验证 Agent 画布操作可提升为不包含媒体字节的版本化生产工作流定义', () => {
  const draft = draftOf(document, 'generate-a')
  assert.equal(draft.sourceAgentRunId, 'run-a')
  assert.equal(draft.definition.model, 'gpt-image-2')
  assert.deepEqual(draft.definition.assetGroupIds, ['group-a'])
  assert.equal(draft.definition.settings.batchCount, 2)
  assert.doesNotMatch(JSON.stringify(draft.definition), /\/api\/media|base64/)
  assert.equal((draft.definition.recipe?.references as Array<{ assetId: string }>)[0].assetId, 'asset-a')
})

test('草稿显式携带画布节点、Run、分支与结果四类来源身份', () => {
  const draft = draftOf(document, 'generate-a')
  assert.equal(draft.source.canvasNodeId, 'generate-a')
  assert.equal(draft.source.runId, 'run-a')
  assert.equal(draft.source.branchId, 'branch-a')
  // 只收本分支的结果，不把其他分支的输出当成本次来源。
  assert.deepEqual(draft.source.resultNodeIds, ['result-a1', 'result-a2'])
})

test('用户显式选择的节点被尊重，不回退到画布上第一个可用生成节点', () => {
  const draft = draftOf(document, 'generate-b')
  assert.equal(draft.source.canvasNodeId, 'generate-b')
  assert.equal(draft.source.runId, 'run-b')
  assert.equal(draft.definition.prompt, '生成秋季主视觉，无参考图')
})

test('纯文字 Run 没有参考图也可以提升为生产工作流', () => {
  const draft = draftOf(document, 'generate-b')
  assert.deepEqual(draft.definition.recipe?.references, [])
  assert.deepEqual(draft.definition.assetGroupIds, [])
  assert.deepEqual(draft.source.resultNodeIds, ['result-b1'])
})

test('尚未完成的 Agent 操作不能静默保存为生产工作流', () => {
  assert.deepEqual(productionWorkflowDraftFromCanvas(document, 'generate-c'), { ok: false, reason: 'run_not_terminal' })
})

test('来源缺失或指向非生成节点时返回具名原因，不猜测替代来源', () => {
  assert.deepEqual(productionWorkflowDraftFromCanvas(document, ''), { ok: false, reason: 'source_not_selected' })
  assert.deepEqual(productionWorkflowDraftFromCanvas(document, 'missing-node'), { ok: false, reason: 'node_not_found' })
  assert.deepEqual(productionWorkflowDraftFromCanvas(document, 'asset-node'), { ok: false, reason: 'not_generate_node' })
})

test('提示词为空的生成节点不能提升', () => {
  const blank = structuredClone(document) as CanvasDocument
  const target = blank.nodes.find((node) => node.id === 'generate-b')!
  ;(target.data as { prompt: string }).prompt = '   '
  blank.edges = []
  assert.deepEqual(productionWorkflowDraftFromCanvas(blank, 'generate-b'), { ok: false, reason: 'prompt_empty' })
})

test('可选来源列举全部合格生成节点，并排除未完成的 Run', () => {
  const options = eligibleProductionWorkflowSources(document)
  assert.deepEqual(options.map((option) => option.nodeId), ['generate-a', 'generate-b'])
  assert.deepEqual(options.map((option) => option.hasReferences), [true, false])
  assert.deepEqual(options.map((option) => option.resultCount), [2, 1])
  assert.equal(options[0].label, '品牌首图')
  assert.equal(options[1].label, '纯文字草稿')
})

test('已知缺口：brandRules 目前不过滤未确认记忆，也不保留版本绑定（Epic 6 修）', () => {
  // 钉住现状，避免在 MemoryV2 落地前有人误以为这条路径已经安全。
  // 正确行为应是只取 confirmed 且携带 version/contentHash 绑定。
  const draft = draftOf(document, 'generate-a')
  assert.deepEqual(draft.definition.brandRules, ['保持植物学留白', '未确认的猜测'])
})
