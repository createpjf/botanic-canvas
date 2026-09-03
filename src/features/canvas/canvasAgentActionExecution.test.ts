import assert from 'node:assert/strict'
import test from 'node:test'
import {
  projectAcceptedAgentRunBestEffort,
  preserveCanvasAgentActionError,
  removeUnstartedGenerateBranches,
} from './canvasAgentActionExecution.ts'

class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(
    message: string,
    status: number,
    code: string,
  ) {
    super(message)
    this.name = 'ProductApiError'
    this.status = status
    this.code = code
  }
}

test('画布行动边界本地化错误时保留 API 错误身份、状态码与业务码', () => {
  const source = new ApiError('raw timeout', 504, 'AGENT_ACTION_TIMEOUT')

  const localized = preserveCanvasAgentActionError(source, '行动结果未知，请人工核对。')

  assert.equal(localized, source)
  assert.ok(localized instanceof ApiError)
  assert.equal(localized.message, '行动结果未知，请人工核对。')
  assert.equal(localized.status, 504)
  assert.equal(localized.code, 'AGENT_ACTION_TIMEOUT')
})

test('Run 已被服务端接受后，本地投影与 Canvas flush 失败不能把计划降级为提交失败', async () => {
  const calls: string[] = []
  const settlement = await projectAcceptedAgentRunBestEffort({
    apply: () => {
      calls.push('apply')
      throw new Error('local projection failed')
    },
    flush: async () => {
      calls.push('flush')
      throw Object.assign(new Error('unrelated canvas conflict'), { status: 409, code: 'PROJECT_CONFLICT' })
    },
  })

  assert.deepEqual(calls, ['apply', 'flush'])
  assert.deepEqual(settlement, { applied: false, flushed: false })
})

test('回退执行失败只清理本次创建且未进入提交流程的分支节点', () => {
  const generateNode = (id: string, data: Record<string, unknown> = {}) => ({
    id, type: 'generate' as const, position: { x: 0, y: 0 },
    data: { kind: 'generate', label: '新图 · 图像 01', prompt: '', batchCount: 1, settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' }, ...data },
  })
  const document = { nodes: [
    generateNode('branch-clean'),
    generateNode('branch-submitted', { submissionKey: 'key-1' }),
    generateNode('branch-running', { status: 'uploading' }),
    generateNode('branch-with-job', { jobId: 'job-1' }),
    { id: 'result-1', type: 'result' as const, position: { x: 0, y: 0 }, data: { kind: 'result', image: '/image.png' } },
    { id: 'asset-restored', type: 'asset' as const, position: { x: 0, y: 0 }, data: { kind: 'asset', assetId: 'a-1', name: '参考 01' } },
    { id: 'asset-existing', type: 'asset' as const, position: { x: 0, y: 0 }, data: { kind: 'asset', assetId: 'a-2', name: '参考 02' } },
  ] }
  const removed: string[] = []
  removeUnstartedGenerateBranches(
    [
      { nodeId: 'branch-clean', companionNodeIds: ['asset-restored', 'missing-companion'] },
      { nodeId: 'branch-submitted', companionNodeIds: ['asset-existing'] },
      { nodeId: 'branch-running' },
      { nodeId: 'branch-with-job' },
      { nodeId: 'result-1' },
      { nodeId: 'missing-node' },
    ],
    document as never,
    (nodeId) => removed.push(nodeId),
  )
  // 只删干净的孤儿节点及它本次补建的素材；已提交/运行中/带任务的连同素材留给恢复器，
  // 非 generate 节点与不存在的 id 忽略。
  assert.deepEqual(removed, ['branch-clean', 'asset-restored'])
})
