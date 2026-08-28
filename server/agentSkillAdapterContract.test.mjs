// @ts-check

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { productStoreCoreMethods } from './productStoreContract.mjs'

const adapters = [
  ['Local', readFileSync(new URL('./productStore.mjs', import.meta.url), 'utf8')],
  ['PostgreSQL', readFileSync(new URL('./postgresProductStore.mjs', import.meta.url), 'utf8')],
  ['Supabase', readFileSync(new URL('./supabaseProductStore.mjs', import.meta.url), 'utf8')],
]

function methodSource(source, name, nextName) {
  const signatures = [`async ${name}(`, `${name}(`]
  const starts = signatures.map((signature) => source.indexOf(signature)).filter((value) => value >= 0)
  assert.ok(starts.length, `${name} missing`)
  const start = Math.min(...starts)
  const nextSignatures = [`async ${nextName}(`, `${nextName}(`]
  const ends = nextSignatures.map((signature) => source.indexOf(signature, start + 1)).filter((value) => value > start)
  assert.ok(ends.length, `${nextName} missing after ${name}`)
  return source.slice(start, Math.min(...ends))
}

test('Skill 历史版本读取是三个 ProductStore Adapter 的核心契约', () => {
  assert.equal(productStoreCoreMethods.includes('readAgentSkillVersion'), true)
  for (const [name, source] of adapters) {
    assert.match(source, /persistedAgentSkillVersion/u, name)
    assert.match(source, /(?:async )?readAgentSkillVersion\(/u, name)
  }
})

test('Skill 写入只持久化领域快照，Adapter 不增版本、不重算 hash、不截断历史', () => {
  for (const [name, source] of adapters) {
    const put = methodSource(source, 'putAgentSkill', 'listAgentSkills')
    assert.match(put, /agentSkillPersistenceDecision\(/u, name)
    assert.match(put, /decision\.kind === 'replay'/u, name)
    assert.doesNotMatch(put, /createHash|slice\(-20\)|const\s+version\s*=|const\s+contentHash\s*=|const\s+versions\s*=/u, name)
  }
})

test('历史版本读取绕过 active 目录过滤，仍按项目成员边界鉴权', () => {
  for (const [name, source] of adapters) {
    const read = methodSource(source, 'readAgentSkillVersion', 'putAgentActionReceipt')
    assert.match(read, /persistedAgentSkillVersion\(/u, name)
    assert.doesNotMatch(read, /status\s*=\s*'active'|status\s*!==\s*'archived'/u, name)
  }

  const localRead = methodSource(adapters[0][1], 'readAgentSkillVersion', 'putAgentActionReceipt')
  assert.match(localRead, /canAccess\(project, userId\)/u)
  for (const [, source] of adapters.slice(1)) {
    const read = methodSource(source, 'readAgentSkillVersion', 'putAgentActionReceipt')
    assert.match(read, /memberRole\(projectId, userId\)/u)
    assert.match(read, /project_id/u)
  }
})
