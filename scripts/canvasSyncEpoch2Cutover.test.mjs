import assert from 'node:assert/strict'
import test from 'node:test'
import * as Y from 'yjs'
import { createCanvasCollaborationRoom } from '../server/canvas/canvasCollaborationRoom.mjs'
import { runCanvasSyncEpoch2Cutover } from './canvasSyncEpoch2Cutover.mjs'

function snapshotFor(graph) {
  const document = new Y.Doc()
  graph.nodes.forEach((node, order) => document.getMap('nodes').set(node.id, { order, value: node }))
  graph.edges.forEach((edge, order) => document.getMap('edges').set(edge.id, { order, value: edge }))
  return Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64')
}

function fakeSql(state) {
  const metrics = { writes: 0, transactions: [] }
  const queryFor = (target) => {
    const query = async (strings, ...values) => {
      const text = strings.join('?').replace(/\s+/g, ' ').trim().toLowerCase()
      if (text.includes('from pg_indexes')) {
        return [{
          mutationIdentityIndex: target.mutationIdentityIndex ?? true,
          revisionIndex: target.revisionIndex ?? true,
        }]
      }
      if (text.includes('as "invalididentityrows"')) {
        return [{ invalidIdentityRows: target.invalidIdentityRows ?? 0 }]
      }
      if (text.startsWith('select') && text.includes('from canvas_graphs')) {
        return [{
          graph: structuredClone(target.graph),
          graphRevision: target.revision,
          syncProtocolEpoch: target.epoch,
          snapshot: target.snapshot,
        }]
      }
      if (text.startsWith('select') && text.includes('from canvas_graph_updates')) {
        return target.updates.filter((row) => row.update).map((row) => ({ update: row.update }))
      }
      if (text.startsWith('select') && text.includes('from generation_jobs')) {
        return [{
          generationJobs: target.generationJobs ?? 0,
          agentRuns: target.agentRuns ?? 0,
          agentTurns: target.agentTurns ?? 0,
        }]
      }
      if (text.startsWith('update canvas_graphs')) {
        metrics.writes += 1
        const [snapshot, epoch, updatedAt, projectId, expectedRevision] = values
        if (projectId !== target.projectId || expectedRevision !== target.revision || target.epoch !== 1) return []
        target.snapshot = snapshot
        target.epoch = epoch
        target.updatedAt = updatedAt
        return [{ graphRevision: target.revision, syncProtocolEpoch: target.epoch }]
      }
      if (text.startsWith('update canvas_graph_updates')) {
        metrics.writes += 1
        const [compactedAt] = values
        target.updates.forEach((row) => {
          if (row.update) {
            row.update = null
            row.compactedAt = compactedAt
          }
        })
        return []
      }
      throw new Error(`测试 SQL 未覆盖：${text}`)
    }
    query.json = (value) => structuredClone(value)
    query.begin = async (options, run) => {
      if (typeof options === 'function') [run, options] = [options, '']
      metrics.transactions.push(options)
      const draft = structuredClone(target)
      const result = await run(queryFor(draft))
      Object.assign(target, draft)
      return result
    }
    return query
  }
  return { sql: queryFor(state), metrics }
}

const node = (id, x, label) => ({
  id,
  type: 'text',
  position: { x, y: 20 },
  data: { kind: 'text', label, content: label },
})

test('dry-run 零写入，apply 原子写入等价 epoch 2 快照并压缩旧增量', async () => {
  const currentGraph = { nodes: [node('node-a', 400, '当前'), node('node-b', 640, '新增')], edges: [] }
  const state = {
    projectId: 'project-canary',
    graph: structuredClone(currentGraph),
    revision: 7,
    epoch: 1,
    snapshot: snapshotFor({ nodes: [node('node-a', 40, '旧版')], edges: [] }),
    updates: [{ update: snapshotFor({ nodes: [node('node-a', 80, '旧增量')], edges: [] }) }],
  }
  const database = fakeSql(state)

  const dryRun = await runCanvasSyncEpoch2Cutover({ sql: database.sql, projectId: state.projectId })
  assert.equal(dryRun.mode, 'dry-run')
  assert.equal(dryRun.eligible, true)
  assert.equal(dryRun.current.schemaReady, true)
  assert.equal(dryRun.current.logDriftDetected, true)
  assert.equal(dryRun.candidate.matchesMaterializedGraph, true)
  assert.equal(database.metrics.writes, 0)
  assert.match(database.metrics.transactions[0], /read only/u)

  const applied = await runCanvasSyncEpoch2Cutover({
    sql: database.sql,
    projectId: state.projectId,
    apply: true,
    expectedRevision: dryRun.current.graphRevision,
  })
  assert.equal(applied.applied, true)
  assert.equal(applied.verification.verified, true)
  assert.equal(applied.verification.logDriftDetected, false)
  assert.equal(state.epoch, 2)
  assert.ok(state.snapshot)
  assert.ok(state.updates.every((row) => row.update === null))

  const room = createCanvasCollaborationRoom({
    state: {
      graph: state.graph,
      graphRevision: state.revision,
      syncProtocolEpoch: state.epoch,
      snapshot: state.snapshot,
      updates: [],
    },
    append: async () => { throw new Error('测试不应追加') },
    compact: async () => { throw new Error('测试不应压缩') },
  })
  assert.deepEqual(room.graph(), currentGraph)
  await room.destroy()

  const verified = await runCanvasSyncEpoch2Cutover({ sql: database.sql, projectId: state.projectId, verify: true })
  assert.equal(verified.mode, 'verify')
  assert.equal(verified.verified, true)
})

test('apply 锁定后发现 revision 已变化时拒绝切换且零写入', async () => {
  const state = {
    projectId: 'project-raced',
    graph: { nodes: [node('node-a', 400, '新版本')], edges: [] },
    revision: 8,
    epoch: 1,
    snapshot: undefined,
    updates: [],
  }
  const database = fakeSql(state)

  await assert.rejects(
    runCanvasSyncEpoch2Cutover({
      sql: database.sql,
      projectId: state.projectId,
      apply: true,
      expectedRevision: 7,
    }),
    (error) => error?.code === 'CANVAS_SYNC_CUTOVER_STATE_CHANGED',
  )
  assert.equal(database.metrics.writes, 0)
  assert.equal(state.epoch, 1)
  assert.equal(state.snapshot, undefined)
})
