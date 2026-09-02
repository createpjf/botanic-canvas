import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('TurnOutputPreview在三Adapter共用fence, Supabase迁移原子写元数据并由终态trigger清除', async () => {
  const [contract, local, postgres, supabase, migration] = await Promise.all([
    read('../../store/productStoreContract.mjs'),
    read('../../store/productStore.mjs'),
    read('../../store/postgresProductStore.mjs'),
    read('../../store/supabaseProductStore.mjs'),
    read('../../../supabase/migrations/20260901120000_agent_turn_output_preview.sql'),
  ])
  assert.match(contract, /agentTurnOutputPreviewCommitDecision.*turn\.outputPreview = previewDecision\.preview/su)
  assert.match(contract, /delete turn\.outputPreview.*kind: 'finalized'/su)
  assert.match(local, /commitAgentTurnExecution.*committedAgentTurnExecution/su)
  assert.match(postgres, /commitAgentTurnExecution.*for update.*committedAgentTurnExecution/su)
  assert.match(supabase, /outputPreview.*botanic_commit_agent_turn_output_preview/su)
  assert.match(migration, /pg_advisory_xact_lock.*execution_version.*lease_token/su)
  assert.match(migration, /turn\.output_preview\.updated.*insert into public\.agent_turn_events.*update public\.agent_turns/su)
  assert.match(migration, /event_value - 'payload'.*charCount/su)
  assert.doesNotMatch(migration.match(/insert into public\.agent_turn_events.*?stored_event :=/su)?.[0] ?? '', /preview->>'text'/u)
  assert.match(migration, /new\.payload :=.*- 'outputPreview'/u)
  assert.match(migration, /before insert or update on public\.agent_turns/u)
  assert.match(migration, /grant execute on function public\.botanic_commit_agent_turn_output_preview.*to service_role/su)
})
