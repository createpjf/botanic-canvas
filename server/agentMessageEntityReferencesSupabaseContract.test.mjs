import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const adapter = readFileSync(new URL('./store/supabaseProductStore.mjs', import.meta.url), 'utf8')

function between(startText, endText) {
  const start = adapter.indexOf(startText)
  const end = adapter.indexOf(endText, start + startText.length)
  assert.notEqual(start, -1, `缺少 ${startText}`)
  assert.notEqual(end, -1, `无法确定 ${startText} 边界`)
  return adapter.slice(start, end)
}

test('Supabase 三个 Message 写路径都显式声明 entityReferences 保留能力', () => {
  const direct = between('async putAgentMessage(', 'async putAgentMemoryItem(')
  const sync = between('async function syncAgentStateFromDocument(', 'async function assertAgentDerivedFieldWriterAvailable(')
  const capabilityProbe = between('async function assertAgentDerivedFieldWriterAvailable(', 'async function generationFenceRpc(')

  for (const source of [direct, sync, capabilityProbe]) {
    assert.match(source, /p_preserve_entity_references:\s*true/u)
  }
  assert.match(sync, /p_preserve_thread_summary:\s*true/u)
  assert.match(capabilityProbe, /p_preserve_thread_summary:\s*true/u)
})

test('direct PUT 与 Canvas sync 都把 entityReferences 冲突稳定映射为同一业务码', () => {
  const direct = between('async putAgentMessage(', 'async putAgentMemoryItem(')
  const sync = between('async function syncAgentStateFromDocument(', 'async function assertAgentDerivedFieldWriterAvailable(')
  for (const source of [direct, sync]) {
    assert.match(source, /23514/u)
    assert.match(source, /AGENT_MESSAGE_ENTITY_REFERENCES_CONFLICT/u)
  }
})
