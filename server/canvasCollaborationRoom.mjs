import * as Y from 'yjs'

const clone = (value) => structuredClone(value)

function updateFromBase64(encoded) {
  return new Uint8Array(Buffer.from(encoded, 'base64'))
}

function updateToBase64(update) {
  return Buffer.from(update).toString('base64')
}

function collaborativeNode(node) {
  const normalized = clone(node)
  delete normalized.selected
  if (normalized.type === 'result' && normalized.data) delete normalized.data.selected
  if ((normalized.type === 'asset' || normalized.type === 'result') && normalized.data) delete normalized.data.image
  return normalized
}

function collaborativeGraph(graph) {
  return {
    nodes: graph.nodes.map(collaborativeNode),
    edges: graph.edges.map(clone),
  }
}

function replaceRecords(records, values) {
  const nextIds = new Set(values.map((item) => item.id))
  for (const id of records.keys()) {
    if (!nextIds.has(id)) records.set(id, { deleted: true, order: -1 })
  }
  values.forEach((value, order) => records.set(value.id, { order, value: clone(value) }))
}

function materializeRecords(current, records, changedIds, { preserveMedia = false } = {}) {
  const byId = new Map(current.map((item) => [item.id, clone(item)]))
  const orderById = new Map(current.map((item, index) => [item.id, index]))
  for (const id of changedIds) {
    const record = records.get(id)
    if (!record || record.deleted || !record.value) {
      byId.delete(id)
      orderById.delete(id)
      continue
    }
    const existing = byId.get(id)
    const value = clone(record.value)
    if (preserveMedia && (value.type === 'asset' || value.type === 'result') && !value.data?.image) {
      if (!existing?.data?.image) continue
      value.data = { ...value.data, image: existing.data.image }
    }
    byId.set(id, value)
    orderById.set(id, Number.isInteger(record.order) ? record.order : orderById.get(id) ?? Number.MAX_SAFE_INTEGER)
  }
  return [...byId.values()].sort((left, right) => (
    (orderById.get(left.id) ?? Number.MAX_SAFE_INTEGER)
    - (orderById.get(right.id) ?? Number.MAX_SAFE_INTEGER)
    || left.id.localeCompare(right.id)
  ))
}

function materializeGraph(document, current, changedNodeIds, changedEdgeIds) {
  return {
    nodes: materializeRecords(current.nodes, document.getMap('nodes'), changedNodeIds, { preserveMedia: true }),
    edges: materializeRecords(current.edges, document.getMap('edges'), changedEdgeIds),
  }
}

/**
 * 一个项目对应一个持久化 Y.Doc 房间。调用方只负责提供三种 Adapter 行为：
 * 初始状态、追加增量、压缩快照；Yjs 恢复与图谱物化全部封装在模块内部。
 */
export function createCanvasCollaborationRoom({ state, append, compact, compactEvery = 64 }) {
  if (!state?.graph || !Array.isArray(state.graph.nodes) || !Array.isArray(state.graph.edges)) {
    throw new TypeError('画布协作初始状态无效。')
  }
  const document = new Y.Doc()
  if (state.snapshot) Y.applyUpdate(document, updateFromBase64(state.snapshot))
  for (const update of state.updates ?? []) Y.applyUpdate(document, updateFromBase64(update))
  const authoritative = collaborativeGraph(state.graph)
  document.transact(() => {
    replaceRecords(document.getMap('nodes'), authoritative.nodes)
    replaceRecords(document.getMap('edges'), authoritative.edges)
  }, 'materialized-authoritative-graph')
  let graph = clone(state.graph)
  let applyChain = Promise.resolve()

  const applyUpdate = async (encodedUpdate, actorId) => {
    const update = updateFromBase64(encodedUpdate)
    let applied = false
    const changedNodeIds = new Set()
    const changedEdgeIds = new Set()
    const observeUpdate = () => { applied = true }
    const observeNodes = (event) => { for (const id of event.keysChanged) changedNodeIds.add(id) }
    const observeEdges = (event) => { for (const id of event.keysChanged) changedEdgeIds.add(id) }
    document.on('update', observeUpdate)
    document.getMap('nodes').observe(observeNodes)
    document.getMap('edges').observe(observeEdges)
    try {
      Y.applyUpdate(document, update)
    } finally {
      document.off('update', observeUpdate)
      document.getMap('nodes').unobserve(observeNodes)
      document.getMap('edges').unobserve(observeEdges)
    }
    if (!applied) return { applied: false, graph: clone(graph) }

    graph = materializeGraph(document, graph, changedNodeIds, changedEdgeIds)
    const saved = await append({ update: encodedUpdate, graph: clone(graph) }, actorId)
    if (saved.updateCount >= compactEvery) {
      await compact({ snapshot: updateToBase64(Y.encodeStateAsUpdate(document)), graph: clone(graph) }, actorId)
    }
    return { applied: true, graph: clone(graph), ...saved }
  }

  return {
    graph: () => clone(graph),
    stateUpdate: () => updateToBase64(Y.encodeStateAsUpdate(document)),
    replaceBaseGraph(nextGraph, actorId) {
      if (!Array.isArray(nextGraph?.nodes) || !Array.isArray(nextGraph?.edges)) throw new TypeError('画布图谱格式无效。')
      const run = applyChain.then(async () => {
        const changed = JSON.stringify(graph) !== JSON.stringify(nextGraph)
        graph = clone(nextGraph)
        const synchronized = collaborativeGraph(nextGraph)
        document.transact(() => {
          replaceRecords(document.getMap('nodes'), synchronized.nodes)
          replaceRecords(document.getMap('edges'), synchronized.edges)
        }, 'http-authoritative-graph')
        await compact({
          snapshot: updateToBase64(Y.encodeStateAsUpdate(document)),
          graph: clone(graph),
        }, actorId)
        return { changed, graph: clone(graph) }
      })
      applyChain = run.catch(() => undefined)
      return run
    },
    applyUpdate(encodedUpdate, actorId) {
      const run = applyChain.then(() => applyUpdate(encodedUpdate, actorId))
      applyChain = run.catch(() => undefined)
      return run
    },
    destroy() {
      const run = applyChain.then(() => { document.destroy() })
      applyChain = run.catch(() => undefined)
      return run
    },
  }
}
