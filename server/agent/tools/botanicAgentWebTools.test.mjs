import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentToolRuntimeError } from './agentToolRuntime.mjs'
import { createBotanicAgentWebResearchTools } from './botanicAgentWebTools.mjs'

function searchTool(webResearch) {
  return createBotanicAgentWebResearchTools(webResearch).find((tool) => tool.name === 'web_search')
}

function fetchTool(webResearch) {
  return createBotanicAgentWebResearchTools(webResearch).find((tool) => tool.name === 'web_fetch')
}

test('配额用尽时 web_fetch 在出网前失败，且失败也计次', async () => {
  const consumed = []
  let fetches = 0
  const webResearch = {
    consumeQuota: async () => {
      consumed.push('web')
      return { allowed: false, remaining: 0, retryAfterSeconds: 12 }
    },
    lookup: async () => ['1.1.1.1'],
    fetchImpl: async () => {
      fetches += 1
      return new Response('<html><p>不该请求</p></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    },
  }

  await assert.rejects(
    fetchTool(webResearch).execute({ url: 'https://www.andlight.cn/' }),
    (error) => error instanceof AgentToolRuntimeError && error.code === 'WEB_QUOTA_EXCEEDED',
  )
  assert.equal(consumed.length, 1)
  assert.equal(fetches, 0)
})

test('web_search 成功与失败都先记配额', async () => {
  const consumed = []
  const webResearch = {
    apiKey: 'test-search-key',
    consumeQuota: async () => {
      consumed.push('web')
      return { allowed: true, remaining: 3, retryAfterSeconds: 0 }
    },
    fetchImpl: async () => new Response('not-json', { status: 502 }),
  }

  await assert.rejects(
    searchTool(webResearch).execute({ query: '和光品牌' }),
    (error) => error instanceof AgentToolRuntimeError && error.code === 'WEB_SEARCH_FAILED',
  )
  assert.equal(consumed.length, 1)
})
