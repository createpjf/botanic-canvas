import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { productStoreCoreMethods } from './store/productStoreContract.mjs'

const postgres = readFileSync(new URL('./store/postgresProductStore.mjs', import.meta.url), 'utf8')
const supabase = readFileSync(new URL('./store/supabaseProductStore.mjs', import.meta.url), 'utf8')

function method(source, name, nextName) {
  const start = source.indexOf(`async ${name}`)
  const end = source.indexOf(`async ${nextName}`, start + 1)
  assert.notEqual(start, -1, `缺少 ${name}`)
  assert.notEqual(end, -1, `无法定位 ${name} 边界`)
  return source.slice(start, end)
}

test('ProductStore 核心契约包含稳定 Generation Recovery 分页', () => {
  assert.equal(productStoreCoreMethods.includes('listRecoverableGenerationJobs'), true)
})

test('PostgreSQL 三类 Recovery 使用 bigint epoch-ms keyset，同毫秒以 id 破 tie', () => {
  const runs = method(postgres, 'listRunsWithFailedBranches', 'listProjectsWithActiveWorkflowRuns')
  const reviews = method(postgres, 'listPendingAgentReviewTasks', 'putAgentReview')
  const jobs = method(postgres, 'listRecoverableGenerationJobs', 'recoverGenerationJobs')
  for (const [source, alias] of [[runs, 'r'], [reviews, 't'], [jobs, 'g']]) {
    assert.match(source, /normalize(?:UpdatedAtId|PendingAgentReview)RecoveryPage/u)
    assert.match(source, new RegExp(alias + '\\.updated_at > \\$\\{after\\.updatedAt\\}', 'u'))
    assert.match(source, new RegExp(alias + '\\.updated_at = \\$\\{after\\.updatedAt\\}[\\s\\S]*' + alias + '\\.id > \\$\\{after\\.id\\}', 'u'))
    assert.match(source, new RegExp('order by ' + alias + '\\.updated_at asc, ' + alias + '\\.id asc', 'u'))
    assert.doesNotMatch(source, /to_timestamp\(/u, 'Direct PostgreSQL 的 updated_at 是 bigint，不得和 timestamptz 混比')
  }
  assert.match(runs, /updated_at as "updatedAt"/u)
  assert.match(reviews, /updated_at as "updatedAt"/u)
  assert.match(jobs, /updated_at as "updatedAt"/u)
  assert.match(reviews, /updated_at <= \$\{olderThan\}/u)
})

test('Supabase Recovery 只调用三个 service-role RPC 并在缺迁移时 fail closed', () => {
  assert.match(supabase, /async function recoveryKeysetRpc[\s\S]*AGENT_RECOVERY_KEYSET_REQUIRED/u)
  for (const [methodName, nextName, rpc] of [
    ['listRunsWithFailedBranches', 'listProjectsWithActiveWorkflowRuns', 'botanic_list_runs_with_failed_branches'],
    ['listPendingAgentReviewTasks', 'putAgentReview', 'botanic_list_pending_agent_review_tasks'],
    ['listRecoverableGenerationJobs', 'recoverGenerationJobs', 'botanic_list_recoverable_generation_jobs'],
  ]) {
    const source = method(supabase, methodName, nextName)
    assert.match(source, /normalize(?:UpdatedAtId|PendingAgentReview)RecoveryPage/u)
    assert.match(source, new RegExp(`recoveryKeysetRpc\\('${rpc}'`))
    assert.match(source, /p_after_updated_at_ms/u)
    assert.match(source, /p_after_id/u)
    assert.match(source, /p_limit/u)
    assert.doesNotMatch(source, /supabase\.from\(/u)
  }
  const reviews = method(supabase, 'listPendingAgentReviewTasks', 'putAgentReview')
  assert.match(reviews, /p_older_than_ms/u)
})
