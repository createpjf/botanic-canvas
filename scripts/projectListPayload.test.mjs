import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function listProjectsSource(path) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
  const start = source.indexOf('async listProjects(')
  assert.notEqual(start, -1, `${path} 缺少 listProjects`)
  const end = source.indexOf('\n    async ', start + 1)
  assert.notEqual(end, -1, `${path} 无法截取 listProjects`)
  return source.slice(start, end)
}

test('Postgres / Supabase 项目列表不得读取整份 document JSONB', () => {
  const postgres = listProjectsSource('../server/postgresProductStore.mjs')
  const supabase = listProjectsSource('../server/supabaseProductStore.mjs')
  assert.match(postgres, /c\.graph->/)
  assert.doesNotMatch(postgres, /p\.document/)
  assert.match(supabase, /canvas_graphs/)
  assert.doesNotMatch(supabase, /revision, document/)
})

test('Postgres 项目列表摘要在 SQL 内计算，不传输整份 graph', () => {
  const postgres = listProjectsSource('../server/postgresProductStore.mjs')
  assert.match(postgres, /jsonb_array_length/)
  assert.doesNotMatch(postgres, /c\.graph,/)
})

test('Postgres Agent 消息读取按会话截断，避免单会话膨胀顶满语句超时', () => {
  const source = readFileSync(new URL('../server/postgresProductStore.mjs', import.meta.url), 'utf8')
  assert.match(source, /row_number\(\) over \(partition by session_id order by updated_at desc\)/)
  assert.match(source, /recency <= \$\{agentEntityLimits\.messagesPerSession\}/)
})
