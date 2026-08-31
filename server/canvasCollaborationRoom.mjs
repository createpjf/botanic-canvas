import * as Y from 'yjs'
import { canvasGraphConflictCode } from './productStoreContract.mjs'

const clone = (value) => structuredClone(value)
const mediaReferenceKeys = new Set(['image', 'maskImage', 'externalImage', 'mediaUrl', 'thumbnailUrl', 'previewUrl'])
const mediaPayloadKeys = new Set(['blob', 'dataUrl', 'base64', 'bytes', 'buffer'])

function updateFromBase64(encoded) {
  return new Uint8Array(Buffer.from(encoded, 'base64'))
}

function updateToBase64(update) {
  return Buffer.from(update).toString('base64')
}

function stableMediaReference(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined
  return /^(?:data:|blob:|https?:|\/\/|[a-z][a-z\d+.-]*:)/i.test(value) ? undefined : value
}

function sanitizeCollaborativeValue(value, key, mediaContext = false, stripExternalReferences = false) {
  if (typeof value === 'string') {
    const normalized = value.trim()
    if (/^(?:data:|blob:)/i.test(normalized) || (stripExternalReferences && /^(?:\/\/|[a-z][a-z\d+.-]*:)/i.test(normalized))) return undefined
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return undefined
  if (mediaReferenceKeys.has(key) || (mediaContext && key === 'url')) return stableMediaReference(value)
  if (mediaPayloadKeys.has(key) || (key === 'data' && typeof value === 'string' && /^(?:data:|blob:)/i.test(value))) return undefined
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeCollaborativeValue(item, undefined, mediaContext, stripExternalReferences)).filter((item) => item !== undefined)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).flatMap(([childKey, childValue]) => {
      const sanitized = sanitizeCollaborativeValue(
        childValue,
        childKey,
        mediaContext || key === 'media' || key === 'mask',
        stripExternalReferences,
      )
      return sanitized === undefined ? [] : [[childKey, sanitized]]
    }))
  }
  return value
}

function persistableNode(node) {
  const normalized = sanitizeCollaborativeValue(node)
  delete normalized.selected
  if (normalized.type === 'result' && normalized.data) delete normalized.data.selected
  return normalized
}

function collaborativeNode(node) {
  const normalized = persistableNode(node)
  if ((normalized.type === 'asset' || normalized.type === 'result') && normalized.data) delete normalized.data.image
  return normalized
}

function collaborativeEdge(edge) {
  const normalized = sanitizeCollaborativeValue(edge, undefined, false, true)
  // 选中是本机私有视图状态，与节点侧同一边界：既不进 mutation log 持久化，
  // 也不经 room 重播给协作者。旧客户端广播的 selected 也在这里收口。
  delete normalized.selected
  return normalized
}

function collaborativeGraph(graph) {
  return {
    nodes: graph.nodes.map(collaborativeNode),
    edges: graph.edges.map(collaborativeEdge),
  }
}

function persistableGraph(graph) {
  return {
    nodes: graph.nodes.map(persistableNode),
    edges: graph.edges.map(collaborativeEdge),
  }
}

function replaceRecords(records, values) {
  const nextIds = new Set(values.map((item) => item.id))
  for (const id of records.keys()) {
    if (!nextIds.has(id)) records.set(id, { deleted: true, order: -1 })
  }
  values.forEach((value, order) => records.set(value.id, { order, value: clone(value) }))
}

function updateRecords(records, current, next) {
  const currentById = new Map(current.map((item) => [item.id, item]))
  const currentOrderById = new Map(current.map((item, order) => [item.id, order]))
  const nextById = new Map(next.map((item) => [item.id, item]))
  for (const item of current) {
    if (!nextById.has(item.id)) records.set(item.id, { deleted: true, order: -1 })
  }
  next.forEach((item, order) => {
    const previous = currentById.get(item.id)
    if (!previous || !sameGraph(previous, item) || currentOrderById.get(item.id) !== order) {
      records.set(item.id, { order, value: clone(item) })
    }
  })
}

function valuesFromRecords(records) {
  return [...records.values()]
    .filter((record) => record && !record.deleted && record.value)
    .sort((left, right) => (
      (Number.isInteger(left.order) ? left.order : Number.MAX_SAFE_INTEGER)
      - (Number.isInteger(right.order) ? right.order : Number.MAX_SAFE_INTEGER)
    ))
    .map((record) => clone(record.value))
}

function sameGraph(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
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
      if (existing?.data?.image) value.data = { ...value.data, image: existing.data.image }
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

function restoredRoomState(state) {
  if (!state?.graph || !Array.isArray(state.graph.nodes) || !Array.isArray(state.graph.edges)) {
    throw new TypeError('画布协作初始状态无效。')
  }
  const document = new Y.Doc()
  if (state.snapshot) Y.applyUpdate(document, updateFromBase64(state.snapshot))
  for (const update of state.updates ?? []) Y.applyUpdate(document, updateFromBase64(update))
  const materialized = persistableGraph(state.graph)
  const hasYjsState = Boolean(state.snapshot || state.updates?.length)
  const logAuthoritative = hasYjsState && Number(state.syncProtocolEpoch ?? 1) >= 2
  let graph = materialized
  let needsCompaction = !sameGraph(state.graph, materialized)
  if (!logAuthoritative) {
    const collaborative = collaborativeGraph(materialized)
    const restored = {
      nodes: valuesFromRecords(document.getMap('nodes')),
      edges: valuesFromRecords(document.getMap('edges')),
    }
    needsCompaction ||= hasYjsState && !sameGraph(restored, collaborative)
    if (!hasYjsState || needsCompaction) {
      document.transact(() => {
        replaceRecords(document.getMap('nodes'), collaborative.nodes)
        replaceRecords(document.getMap('edges'), collaborative.edges)
      }, 'materialized-authoritative-graph')
    }
  } else {
    let sanitized = false
    document.transact(() => {
      for (const [id, record] of document.getMap('nodes')) {
        if (!record?.value) continue
        const value = collaborativeNode(record.value)
        if (!sameGraph(value, record.value)) {
          document.getMap('nodes').set(id, { ...record, value })
          sanitized = true
        }
      }
      for (const [id, record] of document.getMap('edges')) {
        if (!record?.value) continue
        const value = collaborativeEdge(record.value)
        if (!sameGraph(value, record.value)) {
          document.getMap('edges').set(id, { ...record, value })
          sanitized = true
        }
      }
    }, 'sanitize-restored-log')
    const nodeIds = new Set([...materialized.nodes.map((node) => node.id), ...document.getMap('nodes').keys()])
    const edgeIds = new Set([...materialized.edges.map((edge) => edge.id), ...document.getMap('edges').keys()])
    graph = materializeGraph(document, materialized, nodeIds, edgeIds)
    needsCompaction ||= sanitized || !sameGraph(materialized, graph)
  }
  return {
    document,
    graph,
    graphRevision: Number.isInteger(state.graphRevision) ? state.graphRevision : 1,
    needsCompaction,
  }
}

/**
 * 一个项目对应一个持久化 Y.Doc 房间。调用方只负责提供三种 Adapter 行为：
 * 初始状态、追加增量、压缩快照；Yjs 恢复与图谱物化全部封装在模块内部。
 */
export function createCanvasCollaborationRoom({ state, append, compact, reload, compactEvery = 64 }) {
  const restored = restoredRoomState(state)
  let document = restored.document
  let graph = restored.graph
  let graphRevision = restored.graphRevision
  let needsCompaction = restored.needsCompaction
  let requiresReload = false
  let applyChain = Promise.resolve()

  const replaceState = (nextState) => {
    const next = restoredRoomState(nextState)
    document.destroy()
    document = next.document
    graph = next.graph
    graphRevision = next.graphRevision
    needsCompaction = next.needsCompaction
    requiresReload = false
  }

  const restorePersistedState = async (actorId, fallbackGraph) => {
    requiresReload = true
    if (fallbackGraph) graph = clone(fallbackGraph)
    if (typeof reload !== 'function') return false
    try {
      replaceState(await reload(actorId))
      return true
    } catch {
      return false
    }
  }

  const ensurePersistedState = async (actorId) => {
    if (!requiresReload) return
    if (await restorePersistedState(actorId)) return
    throw new Error('画布权威状态暂时无法恢复。')
  }

  const applyUpdate = async (encodedUpdate, actorId, {
    persist = true,
    mutationId,
    syncProtocolEpoch,
    committedGraphRevision,
    attempt = 0,
  } = {}) => {
    if (persist) await ensurePersistedState(actorId)
    else if (requiresReload) throw new Error('画布权威状态暂时无法恢复。')
    const update = updateFromBase64(encodedUpdate)
    const stateVector = Y.encodeStateVector(document)
    let applied = false
    let sanitized = false
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
    if (applied) {
      for (const id of changedNodeIds) {
        const record = document.getMap('nodes').get(id)
        if (!record?.value) continue
        const value = collaborativeNode(record.value)
        if (!sameGraph(value, record.value)) {
          document.getMap('nodes').set(id, { ...record, value })
          sanitized = true
        }
      }
      for (const id of changedEdgeIds) {
        const record = document.getMap('edges').get(id)
        if (!record?.value) continue
        const value = collaborativeEdge(record.value)
        if (!sameGraph(value, record.value)) {
          document.getMap('edges').set(id, { ...record, value })
          sanitized = true
        }
      }
    }
    const previousGraph = clone(graph)
    if (applied) graph = materializeGraph(document, graph, changedNodeIds, changedEdgeIds)
    if (!persist) {
      if (Number.isInteger(committedGraphRevision)) graphRevision = Math.max(graphRevision, committedGraphRevision)
      return { applied, previousGraph, graph: clone(graph), graphRevision }
    }
    const durableUpdate = sanitized
      ? updateToBase64(Y.encodeStateAsUpdate(document, stateVector))
      : encodedUpdate
    let saved
    try {
      saved = await append({
        update: durableUpdate,
        idempotencyUpdate: encodedUpdate,
        graph: clone(graph),
        mutationId,
        syncProtocolEpoch,
        expectedGraphRevision: graphRevision,
      }, actorId)
    } catch (error) {
      const restored = await restorePersistedState(actorId, previousGraph)
      if (error?.code === canvasGraphConflictCode && restored && attempt < 3) {
        return applyUpdate(encodedUpdate, actorId, { persist, mutationId, syncProtocolEpoch, attempt: attempt + 1 })
      }
      throw error
    }
    if (saved.duplicate && typeof reload === 'function'
      && !await restorePersistedState(actorId, previousGraph)) {
      throw new Error('画布权威状态暂时无法恢复。')
    }
    graphRevision = Math.max(graphRevision, Number(saved.graphRevision ?? graphRevision))
    if (!saved.duplicate && saved.updateCount >= compactEvery) {
      try {
        await compact({
          snapshot: updateToBase64(Y.encodeStateAsUpdate(document)),
          graph: clone(graph),
          expectedGraphRevision: graphRevision,
        }, actorId)
        needsCompaction = false
      } catch {
        // 增量已经 durable commit；快照只是优化，失败不得阻断 ACK/广播。
        needsCompaction = true
        await restorePersistedState(actorId, graph)
      }
    }
    return {
      applied,
      previousGraph,
      graph: clone(graph),
      ...saved,
      ...(saved.duplicate ? (saved.update ? { update: saved.update } : {}) : { update: durableUpdate }),
      graphRevision,
    }
  }

  const commitGraphMutation = async (mutate, actorId, {
    mutationId,
    syncProtocolEpoch,
    attempt = 0,
  } = {}) => {
    await ensurePersistedState(actorId)
    const previousGraph = clone(graph)
    const nextGraph = mutate(clone(graph))
    if (nextGraph === undefined) return { changed: false, applied: false, previousGraph, graph: clone(graph), graphRevision }
    if (!Array.isArray(nextGraph?.nodes) || !Array.isArray(nextGraph?.edges)) {
      throw new TypeError('画布图谱格式无效。')
    }
    const nextMaterialized = persistableGraph(nextGraph)
    if (sameGraph(previousGraph, nextMaterialized)) {
      return { changed: false, applied: false, previousGraph, graph: clone(graph), graphRevision }
    }
    const currentCollaborative = collaborativeGraph(previousGraph)
    const nextCollaborative = collaborativeGraph(nextMaterialized)
    const stateVector = Y.encodeStateVector(document)
    document.transact(() => {
      updateRecords(document.getMap('nodes'), currentCollaborative.nodes, nextCollaborative.nodes)
      updateRecords(document.getMap('edges'), currentCollaborative.edges, nextCollaborative.edges)
    }, 'server-graph-mutation')
    graph = nextMaterialized
    const encodedUpdate = updateToBase64(Y.encodeStateAsUpdate(document, stateVector))
    let saved
    try {
      saved = await append({
        update: encodedUpdate,
        ...(mutationId ? { idempotencyUpdate: `server:${mutationId}` } : {}),
        graph: clone(graph),
        mutationId,
        syncProtocolEpoch,
        expectedGraphRevision: graphRevision,
      }, actorId)
    } catch (error) {
      const restored = await restorePersistedState(actorId, previousGraph)
      if (error?.code === canvasGraphConflictCode && restored && attempt < 3) {
        return commitGraphMutation(mutate, actorId, { mutationId, syncProtocolEpoch, attempt: attempt + 1 })
      }
      throw error
    }
    if (saved.duplicate && typeof reload === 'function'
      && !await restorePersistedState(actorId, previousGraph)) {
      throw new Error('画布权威状态暂时无法恢复。')
    }
    graphRevision = Math.max(graphRevision, Number(saved.graphRevision ?? graphRevision))
    if (!saved.duplicate && saved.updateCount >= compactEvery) {
      try {
        await compact({
          snapshot: updateToBase64(Y.encodeStateAsUpdate(document)),
          graph: clone(graph),
          expectedGraphRevision: graphRevision,
        }, actorId)
        needsCompaction = false
      } catch {
        needsCompaction = true
        await restorePersistedState(actorId, graph)
      }
    }
    return {
      changed: true,
      applied: true,
      previousGraph,
      graph: clone(graph),
      ...saved,
      ...(saved.duplicate ? (saved.update ? { update: saved.update } : {}) : { update: encodedUpdate }),
      graphRevision,
    }
  }

  return {
    graph: () => clone(graph),
    stateUpdate() {
      if (requiresReload) throw new Error('画布权威状态暂时无法恢复。')
      return updateToBase64(Y.encodeStateAsUpdate(document))
    },
    syncState(stateVector) {
      const decodedStateVector = updateFromBase64(stateVector)
      const run = applyChain.then(() => {
        if (requiresReload) throw new Error('画布权威状态暂时无法恢复。')
        return {
          graphRevision,
          update: updateToBase64(Y.encodeStateAsUpdate(document, decodedStateVector)),
        }
      })
      applyChain = run.catch(() => undefined)
      return run
    },
    replaceBaseGraph(nextGraph, actorId, authoritativeGraphRevision = graphRevision) {
      if (!Array.isArray(nextGraph?.nodes) || !Array.isArray(nextGraph?.edges)) throw new TypeError('画布图谱格式无效。')
      const run = applyChain.then(async () => {
        await ensurePersistedState(actorId)
        const previousGraph = clone(graph)
        const materialized = persistableGraph(nextGraph)
        const changed = !sameGraph(graph, materialized)
        if (!changed && !needsCompaction) return { changed: false, graph: clone(graph) }
        graph = materialized
        const synchronized = collaborativeGraph(materialized)
        document.transact(() => {
          replaceRecords(document.getMap('nodes'), synchronized.nodes)
          replaceRecords(document.getMap('edges'), synchronized.edges)
        }, 'http-authoritative-graph')
        try {
          await compact({
            snapshot: updateToBase64(Y.encodeStateAsUpdate(document)),
            graph: clone(graph),
            expectedGraphRevision: authoritativeGraphRevision,
          }, actorId)
        } catch (error) {
          await restorePersistedState(actorId, previousGraph)
          throw error
        }
        graphRevision = Math.max(graphRevision, authoritativeGraphRevision)
        needsCompaction = false
        return { changed, graph: clone(graph) }
      })
      applyChain = run.catch(() => undefined)
      return run
    },
    applyUpdate(encodedUpdate, actorId, options) {
      const run = applyChain.then(() => applyUpdate(encodedUpdate, actorId, options))
      applyChain = run.catch(() => undefined)
      return run
    },
    commitGraphMutation(mutate, actorId, options) {
      if (typeof mutate !== 'function') throw new TypeError('画布图谱更新器无效。')
      const run = applyChain.then(() => commitGraphMutation(mutate, actorId, options))
      applyChain = run.catch(() => undefined)
      return run
    },
    applyPersistedUpdate(encodedUpdate, committedGraphRevision) {
      const run = applyChain.then(() => applyUpdate(encodedUpdate, undefined, { persist: false, committedGraphRevision }))
      applyChain = run.catch(() => undefined)
      return run
    },
    reloadPersistedState(actorId) {
      if (typeof reload !== 'function') throw new TypeError('画布房间缺少持久化重载能力。')
      const run = applyChain.then(async () => {
        if (!await restorePersistedState(actorId)) throw new Error('画布权威状态暂时无法恢复。')
        return { graph: clone(graph), graphRevision }
      })
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
