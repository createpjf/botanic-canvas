import assert from 'node:assert/strict'
import test from 'node:test'
import type { Edge } from '@xyflow/react'
import { canvasZoomMode, generationTaskResultLabel, planResultGroupPresentation, traceCanvasLineage } from './canvasPresentation.ts'

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
