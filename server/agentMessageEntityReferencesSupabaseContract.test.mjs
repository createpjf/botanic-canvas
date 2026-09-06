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
    assert.match(source, /p_preserve_clarification_answers:\s*true/u)
  }
  assert.match(sync, /p_preserve_thread_summary:\s*true/u)
  assert.match(capabilityProbe, /p_preserve_thread_summary:\s*true/u)
})

test('direct PUT 与 Canvas sync 共用冲突翻译，确认与引用冲突不丢业务码', () => {
  const direct = between('async putAgentMessage(', 'async putAgentMemoryItem(')
  const sync = between('async function syncAgentStateFromDocument(', 'async function assertAgentDerivedFieldWriterAvailable(')
  assert.match(direct, /fail\(error\)/u)
  assert.match(sync, /fail\(rpcError\)/u)
  const common = between('function fail(', 'function userFromProfile(')
  assert.match(common, /23514/u)
  assert.match(common, /AGENT_MESSAGE_ENTITY_REFERENCES_CONFLICT/u)
  assert.match(common, /AGENT_MESSAGE_ANSWER_CONFLICT/u)
  assert.match(common, /throw productError\(conflict\[1\], conflict\[0\]\)/u)
})
