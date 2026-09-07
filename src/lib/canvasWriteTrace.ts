import type { CanvasDocument } from '../domain/canvas.ts'
import { canvasJsonEqual, type CanvasDocumentPatch } from '../domain/canvasDocumentPatch.ts'

// 只在专门的诊断构建启用；不记录正文、值、实体 ID、URL 或任意字典键。
const enabled = import.meta.env?.VITE_CANVAS_WRITE_TRACE === 'true'
const pageId = enabled ? crypto.randomUUID() : undefined
const traces = new WeakMap<CanvasDocument, { id: string; callers: string[]; locations: string[] }>()
const knownKeys = new Set(('name schemaVersion updatedAt viewport x y zoom agentSessions activeAgentSessionId agentRuns generationJobs assets history templates deliveries brandKit nodes edges id type data position width height measured selected dragging resizing label content image imageUrl imageAssetId sourceAssetId assetId status error outputs generationRecipe rootRecipe parentId extent style zIndex hidden source target sourceHandle targetHandle').split(' '))

function changedPaths(before: unknown, after: unknown, path: string, result: Set<string>, depth = 0) {
  if (canvasJsonEqual(before, after)) return
  if (depth >= 4 || !before || !after || typeof before !== 'object' || typeof after !== 'object'
    || Array.isArray(before) || Array.isArray(after)) {
    result.add(path)
    return
  }
  const left = before as Record<string, unknown>
  const right = after as Record<string, unknown>
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (!canvasJsonEqual(left[key], right[key])) {
      if (!knownKeys.has(key)) result.add(`${path}.[other]`)
      else changedPaths(left[key], right[key], `${path}.${key}`, result, depth + 1)
    }
  }
}

export function canvasPatchTracePaths(previous: CanvasDocument | undefined, patch: CanvasDocumentPatch) {
  const paths = new Set<string>()
  for (const key of Object.keys(patch.fields ?? {})) paths.add(`fields.${knownKeys.has(key) ? key : '[other]'}`)
  for (const collection of ['nodes', 'edges'] as const) {
    const before = new Map(previous?.[collection].map(item => [item.id, item]))
    for (const item of patch[collection]?.upsert ?? []) changedPaths(before.get(item.id), item, `${collection}[]`, paths)
    if (patch[collection]?.remove?.length) paths.add(`${collection}[].remove`)
  }
  return [...paths].sort()
}

export function markCanvasWrite(document: CanvasDocument) {
  if (!enabled) return
  // 仅保留调用函数名。丢掉堆栈里的页面路径、查询参数和其它自由文本。
  const stack = (new Error().stack ?? '').split('\n').slice(1, 10)
  const callers = stack
    .map(line => /^\s*at ([\w.$]+) \(/u.exec(line)?.[1]).filter((name): name is string => Boolean(name))
  const locations = stack.map(line => /\/([\w.-]+\.[cm]?[jt]sx?:\d+:\d+)\)?$/u.exec(line)?.[1])
    .filter((location): location is string => Boolean(location))
  traces.set(document, { id: crypto.randomUUID(), callers, locations })
}

export function traceCanvasWrite(document: CanvasDocument, previous: CanvasDocument | undefined,
  patch: CanvasDocumentPatch | undefined, revision: number | undefined, graphRevision: number | undefined) {
  if (!enabled) return undefined
  const requestId = crypto.randomUUID()
  console.info('[canvas-write]', JSON.stringify({
    pageId, requestId, write: traces.get(document) ?? { id: 'pending-draft-replay', callers: [] },
    release: typeof __BOTANIC_RELEASE__ === 'undefined' ? undefined : __BOTANIC_RELEASE__.revision,
    revision, graphRevision, paths: patch ? canvasPatchTracePaths(previous, patch) : ['document.create'],
    upserts: { nodes: patch?.nodes?.upsert?.length ?? 0, edges: patch?.edges?.upsert?.length ?? 0 },
    removals: { nodes: patch?.nodes?.remove?.length ?? 0, edges: patch?.edges?.remove?.length ?? 0 },
  }))
  return requestId
}

export function traceCanvasWriteFailure(requestId: string | undefined, error: unknown) {
  if (!enabled || !requestId) return
  const source = error as { code?: unknown; status?: unknown }
  console.info('[canvas-write-failure]', JSON.stringify({ pageId, requestId,
    code: typeof source?.code === 'string' && /^[A-Z_]{1,64}$/u.test(source.code) ? source.code : 'UNKNOWN',
    status: typeof source?.status === 'number' ? source.status : undefined,
  }))
}
