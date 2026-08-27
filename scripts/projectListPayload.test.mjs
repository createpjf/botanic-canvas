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
  assert.match(postgres, /c\.graph/)
  assert.doesNotMatch(postgres, /p\.document/)
  assert.match(supabase, /canvas_graphs/)
  assert.doesNotMatch(supabase, /revision, document/)
})
