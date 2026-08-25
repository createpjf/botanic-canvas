import assert from 'node:assert/strict'
import test from 'node:test'
import {
  artifactsFromAgentMessage,
  artifactsFromActionResult,
  artifactsFromActionReceipt,
  artifactsFromDocument,
  artifactsFromGenerationJob,
  decodeArtifactCursor,
  encodeArtifactCursor,
  mergeArtifactRecords,
  reconcileArtifactIndex,
  validateIndexedArtifact,
} from './botanicArtifactIndex.mjs'

test('Artifact 复合游标保留同一创建时间下的稳定 ID 边界', () => {
  const cursor = encodeArtifactCursor({ id: 'artifact-b', createdAt: 100 })
  assert.deepEqual(decodeArtifactCursor(cursor), { id: 'artifact-b', createdAt: 100 })
  assert.deepEqual(decodeArtifactCursor('100'), { createdAt: 100 })
  assert.throws(() => decodeArtifactCursor('broken'), /分页游标无效/)
})

test('历史 Agent 行动产物带会话、消息与行动来源进入 Artifact Index', () => {
  const [artifact] = artifactsFromAgentMessage({
    id: 'message-1', createdAt: 100,
    plan: { actions: [{
      id: 'action-1', toolName: 'mcp_call',
      result: { artifacts: [{
        id: 'artifact-1', kind: 'text', label: '检索结果', content: '春季场景',
        provenance: { actionId: 'action-1', toolName: 'mcp_call' },
      }] },
    }] },
  }, { sessionId: 'session-1', updatedAt: 120 })

  assert.equal(artifact.id, 'artifact-1')
  assert.deepEqual(artifact.origin, {
    type: 'agent_action', sessionId: 'session-1', messageId: 'message-1', actionId: 'action-1',
  })
  assert.equal(artifact.updatedAt, 120)
})

test('历史生成任务的每个输出形成稳定 Artifact，并补齐画布节点血缘', () => {
  const artifacts = artifactsFromGenerationJob({
    id: 'job-1', projectId: 'project-1', status: 'succeeded', createdAt: 100, updatedAt: 300,
    settings: { model: 'image-1', aspectRatio: '1:1', resolution: '1K' },
    agentRun: { runId: 'run-1', branchId: 'branch-1' },
    generationRecipe: { prompt: '海边黄昏，保持商品不变。', batchCount: 1, references: [] },
    rawInput: { prompt: '原始请求提示词', productionWorkflow: {
      workflowId: 'workflow-1', workflowVersion: 2, workflowRunId: 'workflow-run-1', workflowItemId: 'sku-a',
    } },
    outputs: [{ id: 'output-1', image: '/api/media/media-1', mediaKind: 'image' }],
    variants: [{ index: 0, status: 'succeeded', completedAt: 250, output: { id: 'output-1' } }],
  }, {
    document: {
      nodes: [{ id: 'result-1', type: 'result', data: { jobId: 'job-1', candidateId: 'output-1', label: '海边主图' } }],
      assets: [{ id: 'asset-1', source: 'generated', image: '/api/media/media-1' }],
    },
  })

  assert.equal(artifacts[0].id, 'generation:job-1:output-1')
  assert.equal(artifacts[0].label, '海边主图')
  assert.equal(artifacts[0].metadata.savedToLibrary, true)
  assert.deepEqual(artifacts[0].provenance.sourceNodeIds, ['result-1'])
  assert.deepEqual(artifacts[0].metadata.productionWorkflow, {
    workflowId: 'workflow-1', workflowVersion: 2, workflowRunId: 'workflow-run-1', workflowItemId: 'sku-a',
  })
  assert.equal(artifacts[0].createdAt, 250)
  // 结果面板要展示“图 + 生成它的 Prompt”，配方优先于原始请求。
  assert.equal(artifacts[0].metadata.prompt, '海边黄昏，保持商品不变。')
  assert.equal(artifacts[0].placement, 'canvas')

  const withoutRecipe = artifactsFromGenerationJob({
    id: 'job-2', projectId: 'project-1', status: 'succeeded', createdAt: 100, updatedAt: 300,
    settings: { model: 'image-1', aspectRatio: '1:1', resolution: '1K' },
    rawInput: { prompt: '原始请求提示词' },
    outputs: [{ id: 'output-1', image: '/api/media/media-2', mediaKind: 'image' }],
  })
  assert.equal(withoutRecipe[0].metadata.prompt, '原始请求提示词')
})

test('行动回执可在消息写回前直接补入 Artifact Index', () => {
  const [artifact] = artifactsFromActionResult({ artifacts: [{
    id: 'receipt-artifact', kind: 'workflow', label: 'Skill', content: '锁定商品',
    provenance: { actionId: 'call-1', toolName: 'skill_apply' },
  }] }, { actionId: 'call-1', toolName: 'skill_apply', createdAt: 200 })
  assert.equal(artifact.origin.type, 'agent_action')
  assert.equal(artifact.origin.actionId, 'call-1')
})

test('服务端实际的嵌套行动回执形状也能回填 Artifact', () => {
  const [artifact] = artifactsFromActionReceipt({
    toolCallId: 'call-nested', createdAt: 300,
    result: {
      output: { artifacts: [{
        id: 'nested-artifact', kind: 'text', label: '外部结果', content: '结果',
        provenance: { actionId: 'call-nested', toolName: 'mcp_call' },
      }] },
      toolCall: { id: 'call-nested', name: 'mcp_call' },
    },
  })
  assert.equal(artifact.id, 'nested-artifact')
  assert.equal(artifact.provenance.toolName, 'mcp_call')
})

test('回填跳过单条损坏历史产物，并按项目内 Artifact ID 幂等保留最新版本', () => {
  const document = {
    agentSessions: [{ id: 'session-1', updatedAt: 300, messages: [{
      id: 'message-1', createdAt: 100,
      plan: { actions: [{ id: 'action-1', toolName: 'skill_apply', result: { artifacts: [
        { id: 'same', kind: 'text', label: '新版', content: 'ok', provenance: { actionId: 'action-1', toolName: 'skill_apply' } },
        { id: 'broken', kind: 'unknown', label: '损坏', provenance: {} },
      ] } }] },
    }] }],
  }
  const artifacts = artifactsFromDocument(document)
  assert.deepEqual(artifacts.map((item) => item.id), ['same'])
  assert.equal(mergeArtifactRecords([{ ...artifacts[0], updatedAt: 200 }, artifacts[0]])[0].updatedAt, 300)
})

test('Artifact 校验拒绝图片字节地址和超大元数据', () => {
  const base = {
    id: 'artifact-1', kind: 'image', label: '图片',
    provenance: { actionId: 'action-1', toolName: 'mcp_call' },
    origin: { type: 'agent_action', messageId: 'message-1', actionId: 'action-1' },
  }
  assert.throws(() => validateIndexedArtifact({ ...base, url: 'data:image/png;base64,AAAA' }), /同源媒体地址/)
  assert.throws(() => validateIndexedArtifact({ ...base, metadata: { value: 'x'.repeat(70_000) } }), /过大/)
})

test('Artifact Index 对账报告区分缺失、历史保留与重复输入', () => {
  const report = reconcileArtifactIndex({
    expectedArtifacts: [
      { id: 'artifact-a' },
      { id: 'artifact-a' },
      { id: 'artifact-b' },
    ],
    indexedArtifacts: [
      { id: 'artifact-a' },
      { id: 'artifact-history' },
    ],
  })

  assert.deepEqual(report, {
    status: 'failed',
    expectedCount: 2,
    indexedCount: 2,
    missingCount: 1,
    retainedHistoryCount: 1,
    duplicateExpectedCount: 1,
    missingIds: ['artifact-b'],
    retainedHistoryIds: ['artifact-history'],
  })
})

test('精修结果在 Artifact 上留下父版本身份，节点删除后仍能回到原件', () => {
  // 「不覆盖原件」本来就成立：每次精修是新 Job、新 Artifact 标识。断的是另一半 ——
  // 父子关系只记在 Job 上，而 Artifact Index 不随节点删除而级联删除，节点一删就回不去了。
  const document = {
    nodes: [
      { id: 'node-parent', type: 'result', data: { jobId: 'job-1', candidateId: 'out-1' } },
      { id: 'node-child', type: 'result', data: { jobId: 'job-2', candidateId: 'out-9' } },
    ],
    assets: [],
  }
  const [artifact] = artifactsFromGenerationJob({
    id: 'job-2', status: 'succeeded', parentNodeId: 'node-parent',
    outputs: [{ id: 'out-9', image: 'https://example.com/child.png' }],
  }, { document, now: 5 })
  assert.equal(artifact.metadata.parentArtifactId, 'generation:job-1:out-1')
  assert.equal(artifact.metadata.parentNodeId, 'node-parent')

  // 父节点被删除之后，血缘已经落在 Artifact 上，不依赖画布现查。
  const [afterDeletion] = artifactsFromGenerationJob({
    id: 'job-2', status: 'succeeded', parentNodeId: 'node-parent',
    outputs: [{ id: 'out-9', image: 'https://example.com/child.png' }],
  }, { document: { nodes: [], assets: [] }, now: 5 })
  assert.equal(afterDeletion.metadata.parentNodeId, 'node-parent')
  // 但这时构造不出父 Artifact 标识，如实缺省而不是猜一个。
  assert.equal(afterDeletion.metadata.parentArtifactId, undefined)
})

test('早期单输出父节点没有 candidateId 时不猜父 Artifact', () => {
  // 猜错会把血缘指到同一次任务的另一张图上，比缺失更糟。
  const [artifact] = artifactsFromGenerationJob({
    id: 'job-2', status: 'succeeded', parentNodeId: 'node-parent',
    outputs: [{ id: 'out-9', image: 'https://example.com/child.png' }],
  }, {
    document: { nodes: [{ id: 'node-parent', type: 'result', data: { jobId: 'job-1' } }], assets: [] },
    now: 5,
  })
  assert.equal(artifact.metadata.parentArtifactId, undefined)
  assert.equal(artifact.metadata.parentNodeId, 'node-parent')
})

test('首次生成没有父版本，不写空血缘字段', () => {
  const [artifact] = artifactsFromGenerationJob({
    id: 'job-1', status: 'succeeded',
    outputs: [{ id: 'out-1', image: 'https://example.com/a.png' }],
  }, { document: { nodes: [], assets: [] }, now: 5 })
  assert.equal('parentNodeId' in artifact.metadata, false)
  assert.equal('parentArtifactId' in artifact.metadata, false)
})
