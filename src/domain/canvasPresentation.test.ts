import assert from 'node:assert/strict'
import test from 'node:test'
import type { Edge } from '@xyflow/react'
import { canvasZoomMode, generationJobErrorCopy, generationResultNodeLabel, generationTaskErrorMessage, generationTaskFeedback, generationTaskResultLabel, planResultGroupPresentation, traceCanvasLineage } from './canvasPresentation.ts'

test('canvasZoomMode applies stable semantic zoom bands', () => {
  assert.equal(canvasZoomMode(1), 'detail')
  assert.equal(canvasZoomMode(0.62), 'detail')
  assert.equal(canvasZoomMode(0.61), 'compact')
  assert.equal(canvasZoomMode(0.36), 'compact')
  assert.equal(canvasZoomMode(0.35), 'overview')
})

test('generationTaskResultLabel distinguishes expired login from a real submission timeout', () => {
  assert.equal(generationTaskResultLabel({
    generationKind: 'generation',
    status: 'failed',
    previousTaskStatus: 'uploading',
    error: '请先登录 Botanic 工作区。',
    currentLabel: '首图候选 01',
  }), '首图候选 · 登录已失效')

  assert.equal(generationTaskResultLabel({
    generationKind: 'generation',
    status: 'failed',
    previousTaskStatus: 'uploading',
    error: '任务提交超过 5 分钟，未进入生成队列。请重试。',
    currentLabel: '首图候选 01',
  }), '首图候选 · 提交超时')
})

test('提交成功后保留已有新图名，不用状态文案覆盖', () => {
  assert.equal(generationTaskResultLabel({
    generationKind: 'refinement',
    status: 'succeeded',
    currentLabel: '换景调光',
  }), '换景调光')
})

test('新图名用短标题，不用 Prompt 原文', () => {
  assert.equal(generationResultNodeLabel({
    kind: 'refinement',
    title: '换景调光',
    prompt: '说明一下来源：当前项目上下文里我没有读取到原图。保留模特，把背景换成撒哈拉沙漠柔和自然光。',
  }), '换景调光')
  assert.equal(generationResultNodeLabel({
    kind: 'generation',
    generateLabel: '换景调光',
    prompt: '把原图里的女孩换成短发女孩，手持花瓶站在窗边。',
  }), '换景调光')
  const labeled = generationResultNodeLabel({
    kind: 'generation',
    prompt: '把原图里的女孩换成短发女孩，手持花瓶站在窗边柔和自然光。',
  })
  assert.notEqual(labeled, '把原图里的女孩换成短发女孩，手持花瓶站在窗边柔和自然光。')
  assert.ok(Array.from(labeled).length <= 8)
})

test('提交状态未知时保持可恢复状态，不误报任务失败', () => {
  assert.equal(generationTaskResultLabel({
    generationKind: 'generation',
    status: 'submission_unknown',
    currentLabel: '首图候选 01',
  }), '首图候选 · 等待确认')

  assert.deepEqual(generationTaskFeedback('submission_unknown'), {
    title: '正在恢复任务',
    detail: '请勿重复提交，联网后自动确认',
    recoverable: true,
  })
})

test('generationTaskErrorMessage hides raw network errors while preserving actionable provider messages', () => {
  assert.equal(generationTaskErrorMessage('Failed to fetch'), '生成服务连接中断，请重试。')
  assert.equal(generationTaskErrorMessage('fetch failed'), '生成服务连接中断，请重试。')
  assert.equal(generationTaskErrorMessage('图像服务当前限流，请稍后重试。'), '图像服务当前限流，请稍后重试。')
})

test('已登记错误码按 locale 返回双语文案，两种语言都不是服务端原文', () => {
  const serverMessage = '图片像素超过 4096x4096 上限，请压缩后重试。'
  assert.equal(
    generationTaskErrorMessage(serverMessage, 'IMAGE_TOO_LARGE_PIXELS', 'zh-CN'),
    '图片像素过大，请压缩后重试。',
  )
  assert.equal(
    generationTaskErrorMessage(serverMessage, 'IMAGE_TOO_LARGE_PIXELS', 'en'),
    'The image resolution is too large. Resize it and try again.',
  )
})

test('未登记错误码维持旧行为：原样透传服务端文案，不受新增参数影响', () => {
  assert.equal(
    generationTaskErrorMessage('图像服务当前限流，请稍后重试。', 'SOME_UNKNOWN_CODE', 'en'),
    '图像服务当前限流，请稍后重试。',
  )
  // 不传错误码时（旧调用方式）行为必须和加参数前完全一致。
  assert.equal(generationTaskErrorMessage('fetch failed'), '生成服务连接中断，请重试。')
})

test('generationJobErrorCopy 未登记错误码或缺失错误码时返回 undefined，调用方据此退回旧逻辑', () => {
  assert.equal(generationJobErrorCopy(undefined, 'zh-CN'), undefined)
  assert.equal(generationJobErrorCopy('SOME_UNKNOWN_CODE', 'en'), undefined)
  assert.equal(generationJobErrorCopy('IMAGE_TOO_LARGE_PIXELS', 'en'), 'The image resolution is too large. Resize it and try again.')
})

test('traceCanvasLineage keeps the selected branch and excludes sibling branches', () => {
  const edges: Edge[] = [
    { id: 'asset-to-root', source: 'asset', target: 'root' },
    { id: 'root-to-result', source: 'root', target: 'result' },
    { id: 'result-to-a', source: 'result', target: 'branch-a' },
    { id: 'result-to-b', source: 'result', target: 'branch-b' },
    { id: 'a-to-output', source: 'branch-a', target: 'output-a' },
    { id: 'b-to-output', source: 'branch-b', target: 'output-b' },
  ]

  const lineage = traceCanvasLineage(['branch-a'], edges)
  assert.deepEqual([...lineage.nodeIds].sort(), ['asset', 'branch-a', 'output-a', 'result', 'root'])
  assert.deepEqual([...lineage.edgeIds].sort(), ['a-to-output', 'asset-to-root', 'result-to-a', 'root-to-result'])
})

test('traceCanvasLineage returns no focus when nothing is selected', () => {
  const lineage = traceCanvasLineage([], [{ id: 'edge', source: 'a', target: 'b' }])
  assert.equal(lineage.nodeIds.size, 0)
  assert.equal(lineage.edgeIds.size, 0)
})

test('planResultGroupPresentation keeps a stable first-result anchor while switching active candidate', () => {
  const result = planResultGroupPresentation([
    { id: 'result-2', groupId: 'job-1', active: true, selected: true, variant: 1 },
    { id: 'result-1', groupId: 'job-1', variant: 0 },
    { id: 'result-3', groupId: 'job-1', variant: 2 },
  ], new Set())

  assert.deepEqual(result.get('result-1'), {
    groupId: 'job-1', activeId: 'result-2', index: 2, total: 3, expanded: false, representative: true, promoted: false, hidden: false,
  })
  assert.equal(result.get('result-2')?.hidden, true)
  assert.equal(result.get('result-3')?.hidden, true)
})

test('planResultGroupPresentation expands inside the anchor without revealing scattered nodes', () => {
  const result = planResultGroupPresentation([
    { id: 'result-1', groupId: 'job-1', variant: 0 },
    { id: 'result-2', groupId: 'job-1', variant: 1 },
  ], new Set(['job-1']))

  assert.equal(result.get('result-1')?.hidden, false)
  assert.equal(result.get('result-2')?.hidden, true)
  assert.equal(result.get('result-1')?.expanded, true)
})

test('planResultGroupPresentation promotes candidates with downstream branches', () => {
  const result = planResultGroupPresentation([
    { id: 'result-1', groupId: 'job-1', variant: 0 },
    { id: 'result-2', groupId: 'job-1', variant: 1, hasDownstream: true },
    { id: 'result-3', groupId: 'job-1', variant: 2 },
  ], new Set())

  assert.equal(result.get('result-1')?.representative, true)
  assert.equal(result.get('result-2')?.promoted, true)
  assert.equal(result.get('result-2')?.hidden, false)
  assert.equal(result.get('result-3')?.hidden, true)
})

test('planResultGroupPresentation ignores generating placeholders when only one real output exists', () => {
  const result = planResultGroupPresentation([
    { id: 'result-ready', groupId: 'job-1', variant: 0, hasOutput: true },
    { id: 'result-placeholder', groupId: 'job-1', variant: 0, hasOutput: false },
  ], new Set())

  assert.equal(result.size, 0)
})
