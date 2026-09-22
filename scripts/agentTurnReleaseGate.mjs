import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import postgres from 'postgres'

const terminal = new Set(['completed', 'failed', 'cancelled'])
const statuses = new Set([...terminal, 'queued', 'running', 'waiting_user', 'cancelling', 'unknown'])
const countValue = (value) => /^(0|[1-9]\d*)$/u.test(String(value)) && Number.isSafeInteger(Number(value))
  ? Number(value) : undefined

// An operator must hold the external maintenance fence throughout the cutover.
// This read-only inventory neither closes admission nor authorizes a deployment.
export async function inspectAgentTurnRelease({ sql, expectedDatabase, quiesced = false }) {
  if (typeof expectedDatabase !== 'string' || !expectedDatabase.trim()) throw new TypeError('Expected database is required')
  return sql.begin('isolation level repeatable read read only', async (tx) => {
    await tx`select set_config('statement_timeout', '15000', true)`
    // row_security=off does not bypass RLS: PostgreSQL errors instead of returning a filtered zero.
    await tx`select set_config('row_security', 'off', true)`
    const [target] = await tx`select current_database() as database, transaction_timestamp() as "checkedAt"`
    const reasons = []
    if (target?.database !== expectedDatabase) reasons.push('DATABASE_TARGET_MISMATCH')
    if (quiesced !== true) reasons.push('ALL_TURN_CREATORS_MUST_BE_QUIESCED')
    const rows = await tx`
      select case when status in ('queued', 'running', 'waiting_user', 'cancelling', 'completed', 'failed', 'cancelled')
          then status else 'unknown' end as status,
        count(*)::text as count,
        count(*) filter (where status is distinct from payload->>'status')::text as inconsistent
      from public.agent_turns group by 1 order by 1
    `
    const counts = {}
    let inconsistent = 0
    if (!Array.isArray(rows)) throw new TypeError('Invalid inventory')
    for (const row of rows) {
      const count = countValue(row.count)
      const invalid = countValue(row.inconsistent)
      if (!statuses.has(row.status) || count === undefined || invalid === undefined || invalid > count
        || Object.hasOwn(counts, row.status)) {
        reasons.push('INVALID_INVENTORY')
        continue
      }
      counts[row.status] = count
      inconsistent += invalid
      if (!terminal.has(row.status) && count > 0) reasons.push(`NONTERMINAL_${row.status.toUpperCase()}`)
    }
    if (inconsistent > 0) reasons.push('COLUMN_PAYLOAD_STATUS_MISMATCH')
    return {
      scope: 'all-public-agent-turns', database: target?.database, checkedAt: target?.checkedAt,
      quiescedAttested: quiesced === true, eligible: reasons.length === 0,
      counts, inconsistent, reasons: [...new Set(reasons)],
    }
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let sql
  try {
    const { values } = parseArgs({ options: {
      'expected-database': { type: 'string' }, quiesced: { type: 'boolean', default: false },
    } })
    const connection = process.env.AGENT_TURN_RELEASE_DATABASE_URL
    if (!connection || !values['expected-database']) throw new TypeError('Missing explicit target')
    sql = postgres(connection, { max: 1, connect_timeout: 10, idle_timeout: 5, onnotice: () => {} })
    const report = await inspectAgentTurnRelease({ sql, expectedDatabase: values['expected-database'], quiesced: values.quiesced })
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = report.eligible ? 0 : 1
  } catch {
    // Driver errors can contain connection details. Never print them or fall back to a local store.
    console.error('TURN_RELEASE_GATE_UNVERIFIED: 请核对显式数据库目标、只读访问、RLS 完整可见性与连接；未通过发布检查。')
    process.exitCode = 2
  } finally {
    if (sql) await sql.end({ timeout: 5 }).catch(() => { process.exitCode = 2 })
  }
}
