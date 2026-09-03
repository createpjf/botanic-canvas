// @ts-check
import { AgentToolRuntimeError } from '../agent/tools/agentToolRuntime.mjs'

export const CANVAS_LAYOUT_MODES = Object.freeze(['row', 'column', 'grid', 'workflow', 'align_left', 'align_center', 'align_right', 'align_top', 'align_middle', 'align_bottom', 'distribute_horizontal', 'distribute_vertical'])
const modes = new Set(CANVAS_LAYOUT_MODES)
function fail(message) { throw new AgentToolRuntimeError('CANVAS_LAYOUT_INVALID', message, 422) }
function bounds(node) {
  if (node.type === 'asset') {
    const width = Number(node.data?.imageWidth), height = Number(node.data?.imageHeight)
    if (width > 0 && height > 0) { const scale = Math.min(320 / width, 340 / height, 1); return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) + 28 } }
    return { width: 255, height: 368 }
  }
  if (node.type === 'prompt') return { width: 252, height: 126 }
  if (node.type === 'reference') return { width: 252, height: 148 }
  if (node.type === 'text') return { width: 236, height: 158 }
  if (node.type === 'generate') return { width: 360, height: 148 }
  if (node.type === 'frame') return { width: Number(node.data?.width) || 320, height: Number(node.data?.height) || 240 }
  const ratio = node.data?.generationSettings?.aspectRatio
  return { width: 300, height: (ratio === '16:9' ? 169 : ratio === '4:3' ? 225 : ratio === '1:1' ? 300 : ratio === '4:5' ? 375 : ratio === '9:16' ? 533 : 400) + 36 }
}
function ordered(nodes) { return nodes.slice().sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x || a.id.localeCompare(b.id)) }
function workflowRanks(nodes, edges) {
  const ids = new Set(nodes.map((node) => node.id)), incoming = new Map(nodes.map((node) => [node.id, 0])), outgoing = new Map(nodes.map((node) => [node.id, []]))
  for (const edge of edges ?? []) if (ids.has(edge.source) && ids.has(edge.target) && edge.source !== edge.target) { outgoing.get(edge.source).push(edge.target); incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1) }
  const rank = new Map(nodes.map((node) => [node.id, 0])), queue = nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id).sort(), visited = new Set()
  while (queue.length) { const id = queue.shift(); visited.add(id); for (const target of outgoing.get(id) ?? []) { rank.set(target, Math.max(rank.get(target) ?? 0, (rank.get(id) ?? 0) + 1)); incoming.set(target, incoming.get(target) - 1); if (incoming.get(target) === 0) queue.push(target) } queue.sort() }
  const finalRank = Math.max(0, ...rank.values()) + 1
  for (const node of nodes) if (!visited.has(node.id)) rank.set(node.id, finalRank)
  return rank
}

/** Pure deterministic projection from declarative intent to absolute placements. */
export function layoutCanvasAgentNodes(document, input) {
  if (!modes.has(input?.mode)) fail('不支持的布局模式。')
  if (!Array.isArray(input.nodeIds) || !input.nodeIds.length || input.nodeIds.length > 20) fail('布局必须包含 1–20 个节点。')
  if (new Set(input.nodeIds).size !== input.nodeIds.length) fail('布局节点不能重复。')
  const byId = new Map((document.nodes ?? []).map((node) => [node.id, node]))
  const nodes = input.nodeIds.map((id) => { const node = byId.get(id); if (!node) fail('布局节点不存在：' + id + '。'); return node })
  const gap = input.gap ?? 64, anchor = input.anchor ?? { x: Math.min(...nodes.map((node) => node.position.x)), y: Math.min(...nodes.map((node) => node.position.y)) }, sorted = ordered(nodes), placements = new Map()
  const put = (node, position) => placements.set(node.id, { nodeId: node.id, position })
  if (input.mode === 'row' || input.mode === 'column') {
    let cursor = input.mode === 'row' ? anchor.x : anchor.y
    for (const node of sorted) { put(node, input.mode === 'row' ? { x: cursor, y: anchor.y } : { x: anchor.x, y: cursor }); const size = bounds(node); cursor += (input.mode === 'row' ? size.width : size.height) + gap }
  } else if (input.mode === 'grid') {
    const columns = input.columns ?? Math.ceil(Math.sqrt(nodes.length)), rows = Math.ceil(nodes.length / columns), widths = Array(columns).fill(0), heights = Array(rows).fill(0)
    sorted.forEach((node, index) => { const size = bounds(node); widths[index % columns] = Math.max(widths[index % columns], size.width); heights[Math.floor(index / columns)] = Math.max(heights[Math.floor(index / columns)], size.height) })
    const starts = (values, origin) => values.map((_, index) => origin + values.slice(0, index).reduce((sum, value) => sum + value + gap, 0)), xs = starts(widths, anchor.x), ys = starts(heights, anchor.y)
    sorted.forEach((node, index) => put(node, { x: xs[index % columns], y: ys[Math.floor(index / columns)] }))
  } else if (input.mode === 'workflow') {
    const ranks = workflowRanks(nodes, document.edges), groups = new Map()
    for (const node of sorted) { const rank = ranks.get(node.id) ?? 0; groups.set(rank, [...(groups.get(rank) ?? []), node]) }
    let x = anchor.x
    for (const rank of [...groups.keys()].sort((a, b) => a - b)) { let y = anchor.y, width = 0; for (const node of groups.get(rank)) { put(node, { x, y }); const size = bounds(node); width = Math.max(width, size.width); y += size.height + gap } x += width + gap }
  } else if (input.mode.startsWith('align_')) {
    const left = Math.min(...nodes.map((node) => node.position.x)), top = Math.min(...nodes.map((node) => node.position.y)), right = Math.max(...nodes.map((node) => node.position.x + bounds(node).width)), bottom = Math.max(...nodes.map((node) => node.position.y + bounds(node).height))
    for (const node of nodes) { const size = bounds(node); const x = input.mode === 'align_left' ? left : input.mode === 'align_center' ? (left + right - size.width) / 2 : input.mode === 'align_right' ? right - size.width : node.position.x; const y = input.mode === 'align_top' ? top : input.mode === 'align_middle' ? (top + bottom - size.height) / 2 : input.mode === 'align_bottom' ? bottom - size.height : node.position.y; put(node, { x, y }) }
  } else {
    if (nodes.length < 3) fail('分布布局至少需要 3 个节点。')
    const horizontal = input.mode === 'distribute_horizontal', axis = sorted.slice().sort((a, b) => (horizontal ? a.position.x - b.position.x : a.position.y - b.position.y) || a.id.localeCompare(b.id)); let cursor = horizontal ? axis[0].position.x : axis[0].position.y
    for (const node of axis) { put(node, horizontal ? { x: cursor, y: node.position.y } : { x: node.position.x, y: cursor }); const size = bounds(node); cursor += (horizontal ? size.width : size.height) + gap }
  }
  return input.nodeIds.map((id) => placements.get(id))
}
