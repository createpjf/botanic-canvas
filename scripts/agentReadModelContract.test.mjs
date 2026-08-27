import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('readProject 读路径不合并 Agent 消息', () => {
  for (const path of ['../server/postgresProductStore.mjs', '../server/supabaseProductStore.mjs', '../server/productStore.mjs']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8')
    assert.match(source, /includeMessages:\s*false/)
    assert.match(source, /mergeAgentStateIntoDocument\([\s\S]*?\{ includeMessages: false \}/)
  }
})

test('writeProject 落库前剥离 agentSessions 内嵌消息', () => {
  for (const path of ['../server/postgresProductStore.mjs', '../server/supabaseProductStore.mjs', '../server/productStore.mjs']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8')
    assert.match(source, /stripAgentMessagesFromDocument/)
  }
})
