// @ts-check
import { AgentToolRuntimeError } from '../agent/tools/agentToolRuntime.mjs'

export const CANVAS_FRAME_STAGES = Object.freeze(['brief', 'references', 'generation', 'review', 'approved', 'delivery', 'archive', 'custom'])
const stages = new Set(CANVAS_FRAME_STAGES)
function fail(code, message, statusCode = 422) { throw new AgentToolRuntimeError(code, message, statusCode) }
function frame(document, id) {
  const node = (document.nodes ?? []).find((item) => item.id === id)
  if (!node) fail('CANVAS_NODE_NOT_FOUND', '未找到 Frame：' + id + '。', 404)
  if (node.type !== 'frame') fail('CANVAS_FRAME_INVALID', '目标节点不是 Frame。')
  return node
}
export function assertCanvasFrameData(input) {
  if (typeof input.label !== 'string' || !input.label.trim() || input.label.trim().length > 60) fail('CANVAS_FRAME_INVALID', 'Frame 名称无效。')
  if (!stages.has(input.stage)) fail('CANVAS_FRAME_INVALID', 'Frame 阶段无效。')
  const width = Number(input.width), height = Number(input.height)
  if (!Number.isFinite(width) || width < 320 || width > 4000 || !Number.isFinite(height) || height < 240 || height > 4000) fail('CANVAS_FRAME_INVALID', 'Frame 尺寸超出范围。')
  return { label: input.label.trim(), stage: input.stage, width, height }
}
export function applyCanvasFrameUpdate(document, input, now = Date.now()) {
  const current = frame(document, input.nodeId)
  const data = assertCanvasFrameData({ ...current.data, ...input })
  const next = { ...current, data: { kind: 'frame', ...data } }
  return { document: { ...document, nodes: document.nodes.map((node) => node.id === current.id ? next : node), updatedAt: now }, node: next }
}
export function applyCanvasFrameMembership(document, placements, now = Date.now()) {
  const byId = new Map()
  for (const placement of placements) {
    const current = (document.nodes ?? []).find((node) => node.id === placement.nodeId)
    if (!current) fail('CANVAS_NODE_NOT_FOUND', '未找到画布节点：' + placement.nodeId + '。', 404)
    if (current.type === 'frame') fail('CANVAS_FRAME_NESTING_NOT_ALLOWED', 'Frame 不能加入另一个 Frame。')
    if (placement.frameId !== null) frame(document, placement.frameId)
    const data = { ...current.data }
    if (placement.frameId === null) delete data.frameId
    else data.frameId = placement.frameId
    byId.set(current.id, { ...current, data })
  }
  return { document: { ...document, nodes: document.nodes.map((node) => byId.get(node.id) ?? node), updatedAt: now }, updatedNodeIds: [...byId.keys()] }
}
