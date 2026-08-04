import assert from 'node:assert/strict'
import test from 'node:test'
import {
  beginCanvasFileDrag,
  endCanvasFileDrag,
  hasFileDragPayload,
  resetCanvasFileDrag,
  type CanvasFileDragState,
} from './canvasFileDrag.ts'

test('文件拖入 Agent 后松开时，画布拖拽遮罩会复位', () => {
  const fileTypes = ['Files']
  let state: CanvasFileDragState = resetCanvasFileDrag()

  state = beginCanvasFileDrag(state, fileTypes, true)
  assert.deepEqual(state, { depth: 1, active: true })

  // Agent 面板不是画布目标，不应再次增加画布的嵌套深度。
  state = beginCanvasFileDrag(state, fileTypes, false)
  assert.deepEqual(state, { depth: 1, active: true })

  // Agent 接收文件后由全局 drop 捕获阶段清掉画布的拖拽状态。
  state = resetCanvasFileDrag()
  assert.deepEqual(state, { depth: 0, active: false })
})

test('非文件拖拽不会激活画布遮罩，画布内部的进入离开可配对复位', () => {
  let state: CanvasFileDragState = resetCanvasFileDrag()
  assert.equal(hasFileDragPayload(['text/plain']), false)
  state = beginCanvasFileDrag(state, ['text/plain'], true)
  assert.deepEqual(state, { depth: 0, active: false })

  state = beginCanvasFileDrag(state, ['Files'], true)
  state = beginCanvasFileDrag(state, ['Files'], true)
  assert.deepEqual(state, { depth: 2, active: true })
  state = endCanvasFileDrag(state)
  state = endCanvasFileDrag(state)
  assert.deepEqual(state, { depth: 0, active: false })
})
