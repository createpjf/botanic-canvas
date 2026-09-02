import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('readProject 读路径不合并 Agent 消息', () => {
  for (const path of ['../server/store/postgresProductStore.mjs', '../server/store/supabaseProductStore.mjs', '../server/store/productStore.mjs']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8')
    assert.match(source, /includeMessages:\s*false/)
    assert.match(source, /mergeAgentStateIntoDocument\([\s\S]*?\{ includeMessages: false \}/)
  }
})

test('阅读锚点路由不再先读全量 Agent 状态', () => {
  const source = readFileSync(new URL('../server/agentRoutes.mjs', import.meta.url), 'utf8')
  const handler = source.slice(source.indexOf('if (agentSessionReadingAnchorMatch)'), source.indexOf('if (agentSessionMatch)'))
  assert.match(handler, /putAgentSessionReadReceipt/)
  assert.doesNotMatch(handler, /readAgentState/)
})

test('会话 CAS 不预读 Agent 状态，消息协作摘要只读无消息视图', () => {
  const source = readFileSync(new URL('../server/agentRoutes.mjs', import.meta.url), 'utf8')
  const messageRoute = readFileSync(new URL('../server/agentMessageRoutes.mjs', import.meta.url), 'utf8')
  const sessionHandler = source.slice(source.indexOf('if (agentSessionMatch)'), source.indexOf('if (agentMessageMatch)'))
  const messageHandler = source.slice(source.indexOf('if (agentMessageMatch)'), source.indexOf('if (agentMemoryMatch)'))
  assert.match(sessionHandler, /compareAndSetAgentSessionSettings/)
  assert.doesNotMatch(sessionHandler, /readAgentState/)
  assert.match(messageHandler, /handleAgentMessageRoute/)
  assert.match(messageRoute, /includeMessages:\s*false/)
})

test('规划与知识绑定只读记忆，不拉会话消息', () => {
  const source = readFileSync(new URL('../server/agentRoutes.mjs', import.meta.url), 'utf8')
  assert.match(source, /readAgentState\(userId, input\.projectId, \{ includeMessages: false \}\)/)
  assert.match(source, /readAgentState\(user\.id, validatedInput\.projectId, \{ includeMessages: false \}\)/)
})

test('Artifact 分页游标实现仍从 botanicArtifactIndex 导入', () => {
  const source = readFileSync(new URL('../server/agentRoutes.mjs', import.meta.url), 'utf8')
  assert.match(source, /decodeArtifactCursor/)
  assert.match(source, /encodeArtifactCursor/)
  assert.match(source, /botanicArtifactIndex/)
})

test('writeProject 落库前剥离 agentSessions 内嵌消息', () => {
  for (const path of ['../server/store/postgresProductStore.mjs', '../server/store/supabaseProductStore.mjs', '../server/store/productStore.mjs']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8')
    assert.match(source, /stripAgentMessagesFromDocument/)
  }
})

test('独立 Message 写入保留 mentions 与 updatedAt，供权威线程按原身份回放', () => {
  const apiSource = readFileSync(new URL('../src/lib/agentApi.ts', import.meta.url), 'utf8')
  const submitMessage = apiSource.slice(
    apiSource.indexOf('export async function submitPersistentBotanicAgentMessage'),
    apiSource.indexOf('export async function submitPersistentBotanicAgentSession'),
  )
  const bodySource = readFileSync(new URL('../src/domain/agentMessagePersistence.ts', import.meta.url), 'utf8')
  assert.match(submitMessage, /input\.sessionId/u)
  assert.doesNotMatch(submitMessage, /submitPersistentBotanicAgentSession/u)
  assert.match(submitMessage, /persistentBotanicAgentMessageBody\(input\.message\)/u)
  assert.match(bodySource, /message\.mentions/u)
  assert.match(bodySource, /message\.updatedAt/u)
  assert.match(bodySource, /message\.turnId/u)
  assert.match(bodySource, /message\.turnCancellationRequestedAt/u)
})

test('Session 写入显式发送空 Skill 数组，可卸载最后一个 Skill', () => {
  const apiSource = readFileSync(new URL('../src/lib/agentApi.ts', import.meta.url), 'utf8')
  const submitSession = apiSource.slice(apiSource.indexOf('export async function submitPersistentBotanicAgentSession'))

  assert.match(submitSession, /mountedSkillIds:\s*session\.mountedSkillIds\s*\?\?\s*\[\]/u)
})
