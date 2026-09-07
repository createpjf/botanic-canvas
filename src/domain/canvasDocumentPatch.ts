import type { CanvasDocument } from './canvas.ts'

// JSONB/网络往返不保留对象键序；数组顺序仍然是业务数据，不能排序。
export function canvasJsonEqual(left: unknown, right: unknown) {
  const ordered = (_key: string, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
    : value
  return left === right || JSON.stringify(left, ordered) === JSON.stringify(right, ordered)
}

type CollectionPatch<T extends { id: string }> = { upsert?: T[]; remove?: string[] }
export type CanvasDocumentPatch = {
  fields?: Record<string, unknown>
  nodes?: CollectionPatch<CanvasDocument['nodes'][number]>
  edges?: CollectionPatch<CanvasDocument['edges'][number]>
}

function collectionPatch<T extends { id: string }>(previous: T[], next: T[]): CollectionPatch<T> | undefined {
  const previousById = new Map(previous.map(item => [item.id, item]))
  const nextIds = new Set(next.map(item => item.id))
  const upsert = next.filter(item => !canvasJsonEqual(previousById.get(item.id), item))
  const remove = previous.filter(item => !nextIds.has(item.id)).map(item => item.id)
  return upsert.length || remove.length ? {
    ...(upsert.length ? { upsert } : {}),
    ...(remove.length ? { remove } : {}),
  } : undefined
}

function persistentNode(node: CanvasDocument['nodes'][number]) {
  const { measured: _measured, selected: _selected, dragging: _dragging, resizing: _resizing, ...persistent } = node
  if (persistent.type === 'result' && 'selected' in persistent.data) {
    const { selected: _resultSelected, ...data } = persistent.data
    return { ...persistent, data } as typeof node
  }
  return persistent as typeof node
}

/** 只提交真实编辑；工作流专用 API 与 V2 图谱的权威边界保持不变。 */
export function createCanvasDocumentPatch(previous: CanvasDocument, next: CanvasDocument, includeGraph = true): CanvasDocumentPatch {
  const fields: Record<string, unknown> = {}
  const ignored = new Set(['id', 'updatedAt', 'nodes', 'edges', 'productionWorkflows', 'productionWorkflowRuns'])
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (ignored.has(key)) continue
    if (!canvasJsonEqual(previous[key as keyof CanvasDocument], next[key as keyof CanvasDocument])) fields[key] = next[key as keyof CanvasDocument]
  }
  const nodes = includeGraph ? collectionPatch(previous.nodes.map(persistentNode), next.nodes.map(persistentNode)) : undefined
  const edges = includeGraph ? collectionPatch(previous.edges, next.edges) : undefined
  if (Object.keys(fields).length || nodes || edges) fields.updatedAt = next.updatedAt
  return {
    ...(Object.keys(fields).length ? { fields } : {}),
    ...(nodes ? { nodes } : {}),
    ...(edges ? { edges } : {}),
  }
}
