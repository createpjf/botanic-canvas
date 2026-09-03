// @ts-check
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import postgres from 'postgres'
import { createCanvasCollaborationRoom } from '../server/canvas/canvasCollaborationRoom.mjs'

const targetEpoch = 2

function cutoverError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

function graphFrom(value) {
  const graph = typeof value === 'string' ? JSON.parse(value) : structuredClone(value)
  if (!Array.isArray(graph?.nodes) || !Array.isArray(graph?.edges)) {
    throw cutoverError('画布图谱格式无效。', 'CANVAS_SYNC_CUTOVER_INVALID_GRAPH')
  }
  return graph
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const graphHash = (graph) => sha256(canonicalJson(graph))

function roomFor(state) {
  const unreachable = async () => { throw new Error('预检不得写入持久层。') }
  return createCanvasCollaborationRoom({ state, append: unreachable, compact: unreachable })
}

export async function prepareCanvasSyncEpoch2Candidate(state) {
  const graph = graphFrom(state?.graph)
  const graphRevision = Number(state?.graphRevision)
  const syncProtocolEpoch = Number(state?.syncProtocolEpoch ?? 1)
  const updates = Array.isArray(state?.updates) ? state.updates : []
  if (!Number.isInteger(graphRevision) || graphRevision < 1 || syncProtocolEpoch !== 1
    || updates.some((update) => typeof update !== 'string' || !update)) {
    throw cutoverError('画布协作状态不满足 epoch 2 预检条件。', 'CANVAS_SYNC_CUTOVER_INVALID_STATE')
  }

  const rooms = []
  try {
    const rebased = roomFor({ ...state, graph, graphRevision, syncProtocolEpoch: 1, updates })
    rooms.push(rebased)
    const materializedGraph = rebased.graph()
    const snapshot = rebased.stateUpdate()

    const currentLog = roomFor({ ...state, graph, graphRevision, syncProtocolEpoch: 2, updates })
    rooms.push(currentLog)
    const logDriftDetected = !isDeepStrictEqual(currentLog.graph(), materializedGraph)

    const verified = roomFor({
      graph: materializedGraph,
      graphRevision,
      syncProtocolEpoch: targetEpoch,
      snapshot,
      updates: [],
    })
    rooms.push(verified)
    const candidateGraph = verified.graph()
    const matchesMaterializedGraph = isDeepStrictEqual(candidateGraph, materializedGraph)
    if (!matchesMaterializedGraph) {
      throw cutoverError('epoch 2 候选快照与当前画布不一致。', 'CANVAS_SYNC_CUTOVER_CANDIDATE_DRIFT')
    }

    return {
      graph: candidateGraph,
      snapshot,
      sourceGraphHash: graphHash(graph),
      graphHash: graphHash(candidateGraph),
      snapshotHash: sha256(snapshot),
      snapshotBytes: Buffer.from(snapshot, 'base64').byteLength,
      logDriftDetected,
      matchesMaterializedGraph,
    }
  } finally {
    await Promise.all(rooms.map((room) => room.destroy()))
  }
}

async function loadCutoverState(sql, projectId, lock = false) {
  const rows = lock
    ? await sql`
      select graph, revision as "graphRevision", sync_protocol_epoch as "syncProtocolEpoch",
        yjs_snapshot as snapshot
      from canvas_graphs where project_id = ${projectId} for update
    `
    : await sql`
      select graph, revision as "graphRevision", sync_protocol_epoch as "syncProtocolEpoch",
        yjs_snapshot as snapshot
      from canvas_graphs where project_id = ${projectId}
    `
  const [row] = rows
  if (!row) throw cutoverError('未找到项目画布。', 'CANVAS_SYNC_CUTOVER_NOT_FOUND')

  const updates = await sql`
    select update_base64 as update from canvas_graph_updates
    where project_id = ${projectId} and update_base64 is not null
    order by graph_revision asc nulls first, id asc
  `
  const [indexes] = await sql`
    select
      coalesce(bool_or(indexname = 'canvas_graph_updates_mutation_idx'
        and indexdef ilike 'create unique index%'), false) as "mutationIdentityIndex",
      coalesce(bool_or(indexname = 'canvas_graph_updates_revision_idx'
        and indexdef ilike 'create unique index%'), false) as "revisionIndex"
    from pg_indexes
    where schemaname = current_schema() and tablename = 'canvas_graph_updates'
  `
  const [identityBackfill] = await sql`
    select count(*)::int as "invalidIdentityRows"
    from canvas_graph_updates
    where project_id = ${projectId} and (mutation_id is null or payload_sha256 is null)
  `
  const [writers] = await sql`
    select
      (select count(*)::int from generation_jobs where project_id = ${projectId}
        and (status in ('queued', 'running') or payload->>'projectWritebackPending' = 'true')) as "generationJobs",
      (select count(*)::int from agent_runs where project_id = ${projectId}
        and status in ('queued', 'executing', 'running')) as "agentRuns",
      (select count(*)::int from agent_turns where project_id = ${projectId}
        and status in ('queued', 'running', 'cancelling')) as "agentTurns"
  `
  return {
    graph: graphFrom(row.graph),
    graphRevision: Number(row.graphRevision),
    syncProtocolEpoch: Number(row.syncProtocolEpoch ?? 1),
    snapshot: row.snapshot ?? undefined,
    updates: updates.map(({ update }) => update),
    schema: {
      mutationIdentityIndex: indexes?.mutationIdentityIndex === true,
      revisionIndex: indexes?.revisionIndex === true,
      invalidIdentityRows: Number(identityBackfill?.invalidIdentityRows ?? 0),
    },
    activeWriters: {
      generationJobs: Number(writers?.generationJobs ?? 0),
      agentRuns: Number(writers?.agentRuns ?? 0),
      agentTurns: Number(writers?.agentTurns ?? 0),
    },
  }
}

function schemaReady(state) {
  return state.schema.mutationIdentityIndex
    && state.schema.revisionIndex
    && state.schema.invalidIdentityRows === 0
}

function blockerReasons(state, candidate) {
  const reasons = []
  if (state.syncProtocolEpoch !== 1) reasons.push(`当前 epoch 为 ${state.syncProtocolEpoch}`)
  if (!schemaReady(state)) reasons.push('Canvas Sync V2 数据库索引或历史提交身份未就绪')
  if (state.activeWriters.generationJobs) reasons.push(`有 ${state.activeWriters.generationJobs} 个生成任务仍在执行或待写回`)
  if (state.activeWriters.agentRuns) reasons.push(`有 ${state.activeWriters.agentRuns} 个 Agent Run 未结束`)
  if (state.activeWriters.agentTurns) reasons.push(`有 ${state.activeWriters.agentTurns} 个 Agent Turn 未结束`)
  if (candidate?.logDriftDetected) reasons.push('epoch 2 日志重建结果与物化图谱不一致')
  if (candidate && !candidate.matchesMaterializedGraph) reasons.push('候选快照与当前画布不一致')
  return reasons
}

function reportFor(mode, projectId, state, candidate) {
  const reasons = blockerReasons(state, candidate)
  return {
    mode,
    projectId,
    eligible: reasons.length === 0,
    reasons,
    current: {
      syncProtocolEpoch: state.syncProtocolEpoch,
      graphRevision: state.graphRevision,
      activeUpdateCount: state.updates.length,
      hasSnapshot: Boolean(state.snapshot),
      schemaReady: schemaReady(state),
      schema: state.schema,
      sourceGraphHash: candidate?.sourceGraphHash ?? graphHash(state.graph),
      logDriftDetected: candidate?.logDriftDetected,
      ...state.activeWriters,
    },
    ...(candidate ? {
      candidate: {
        graphHash: candidate.graphHash,
        snapshotHash: candidate.snapshotHash,
        snapshotBytes: candidate.snapshotBytes,
        matchesMaterializedGraph: candidate.matchesMaterializedGraph,
      },
    } : {}),
  }
}

async function verifyCanvasSyncEpoch2(sql, projectId) {
  return sql.begin('isolation level repeatable read read only', async (tx) => {
    const state = await loadCutoverState(tx, projectId)
    const candidate = state.syncProtocolEpoch === targetEpoch
      ? await prepareCanvasSyncEpoch2Candidate({ ...state, syncProtocolEpoch: 1 })
      : undefined
    const reasons = []
    if (state.syncProtocolEpoch !== targetEpoch) reasons.push(`当前 epoch 为 ${state.syncProtocolEpoch}`)
    if (!schemaReady(state)) reasons.push('Canvas Sync V2 数据库索引或历史提交身份未就绪')
    if (candidate?.logDriftDetected) reasons.push('epoch 2 日志重建结果与物化图谱不一致')
    return {
      mode: 'verify',
      projectId,
      verified: reasons.length === 0,
      reasons,
      syncProtocolEpoch: state.syncProtocolEpoch,
      graphRevision: state.graphRevision,
      activeUpdateCount: state.updates.length,
      logDriftDetected: candidate?.logDriftDetected,
      schemaReady: schemaReady(state),
      ...state.activeWriters,
    }
  })
}

export async function runCanvasSyncEpoch2Cutover({ sql, projectId, apply = false, verify = false, expectedRevision }) {
  if (typeof sql !== 'function') throw new TypeError('缺少 PostgreSQL 连接。')
  if (typeof projectId !== 'string' || !projectId.trim()) throw new TypeError('必须指定单个 projectId。')
  if (apply && verify) throw new TypeError('--apply 与 --verify 不能同时使用。')
  if (verify) return verifyCanvasSyncEpoch2(sql, projectId.trim())

  if (!apply) {
    return sql.begin('isolation level repeatable read read only', async (tx) => {
      const state = await loadCutoverState(tx, projectId.trim())
      const candidate = state.syncProtocolEpoch === 1
        ? await prepareCanvasSyncEpoch2Candidate(state)
        : undefined
      return reportFor('dry-run', projectId.trim(), state, candidate)
    })
  }
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new TypeError('--apply 必须同时提供有效的 --expected-revision。')
  }

  const applied = await sql.begin('isolation level serializable read write', async (tx) => {
    const state = await loadCutoverState(tx, projectId.trim(), true)
    if (state.syncProtocolEpoch >= targetEpoch) {
      throw cutoverError('该项目已进入 epoch 2。', 'CANVAS_SYNC_CUTOVER_ALREADY_APPLIED')
    }
    if (state.graphRevision !== expectedRevision) {
      throw cutoverError(
        `画布 revision 已从 ${expectedRevision} 变为 ${state.graphRevision}，请重新 dry-run。`,
        'CANVAS_SYNC_CUTOVER_STATE_CHANGED',
      )
    }
    const candidate = await prepareCanvasSyncEpoch2Candidate(state)
    const report = reportFor('apply', projectId.trim(), state, candidate)
    if (!report.eligible) {
      const error = cutoverError(`Canary 切换被阻止：${report.reasons.join('；')}。`, 'CANVAS_SYNC_CUTOVER_BLOCKED')
      error.reasons = report.reasons
      throw error
    }

    const timestamp = Date.now()
    const [updated] = await tx`
      update canvas_graphs
      set yjs_snapshot = ${candidate.snapshot}, sync_protocol_epoch = ${targetEpoch},
        updated_at = greatest(updated_at, ${timestamp})
      where project_id = ${projectId.trim()} and revision = ${expectedRevision} and sync_protocol_epoch = 1
      returning revision as "graphRevision", sync_protocol_epoch as "syncProtocolEpoch"
    `
    if (!updated) {
      throw cutoverError('画布在切换前发生变化，请重新 dry-run。', 'CANVAS_SYNC_CUTOVER_STATE_CHANGED')
    }
    await tx`
      update canvas_graph_updates set update_base64 = null, compacted_at = ${timestamp}
      where project_id = ${projectId.trim()} and update_base64 is not null
    `
    return {
      ...report,
      applied: true,
      fromEpoch: 1,
      toEpoch: targetEpoch,
      compactedUpdateCount: state.updates.length,
    }
  })
  const verification = await verifyCanvasSyncEpoch2(sql, projectId.trim())
  if (!verification.verified) {
    const error = cutoverError(
      '项目已切到 epoch 2，但切后校验失败；请停止扩大范围并执行 --verify。',
      'CANVAS_SYNC_CUTOVER_POSTFLIGHT_FAILED',
    )
    error.verification = verification
    throw error
  }
  return { ...applied, verification }
}

function cliOptions(argv) {
  const options = { apply: false, dryRun: false, verify: false }
  const valueAfter = (index, flag) => {
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new TypeError(`${flag} 缺少值。`)
    return value
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--project') {
      options.projectId = valueAfter(index, argument)
      index += 1
    } else if (argument === '--expected-revision') {
      options.expectedRevision = Number(valueAfter(index, argument))
      index += 1
    }
    else if (argument === '--apply') options.apply = true
    else if (argument === '--dry-run') options.dryRun = true
    else if (argument === '--verify') options.verify = true
    else if (argument === '--help' || argument === '-h') options.help = true
    else throw new TypeError(`未知参数：${argument}`)
  }
  if ([options.apply, options.dryRun, options.verify].filter(Boolean).length > 1) {
    throw new TypeError('--dry-run、--apply 与 --verify 只能选择一个。')
  }
  if (!options.apply && options.expectedRevision !== undefined) {
    throw new TypeError('--expected-revision 只能与 --apply 同时使用。')
  }
  return options
}

async function main() {
  const options = cliOptions(process.argv.slice(2))
  if (options.help) {
    process.stdout.write('用法：node scripts/canvasSyncEpoch2Cutover.mjs --project <id> [--dry-run | --apply --expected-revision <n> | --verify]\n')
    return
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL 未配置。')
  const sql = postgres(process.env.DATABASE_URL, {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: {
      application_name: 'botanic-canvas-epoch2-cutover',
      statement_timeout: 30_000,
      lock_timeout: 5_000,
    },
  })
  try {
    const report = await runCanvasSyncEpoch2Cutover({
      sql,
      projectId: options.projectId,
      apply: options.apply,
      verify: options.verify,
      expectedRevision: options.expectedRevision,
    })
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if ((report.mode === 'dry-run' && !report.eligible) || (report.mode === 'verify' && !report.verified)) {
      process.exitCode = 2
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? 'CANVAS_SYNC_CUTOVER_FAILED'}: ${error?.message ?? error}\n`)
    process.exitCode = 1
  })
}
