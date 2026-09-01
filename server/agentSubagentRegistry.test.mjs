import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentSubagentProjectRegistry } from './agentSubagentRegistry.mjs'

test('Subagent Registry 只暴露服务端只读定义，画布投影剔除媒体与 Prompt', async () => {
  const productStore = {
    async readProject() {
      return {
        document: {
          nodes: [{
            id: 'node-1', type: 'result',
            data: { title: '候选图', image: 'data:image/png;base64,secret', prompt: 'private prompt' },
          }],
          edges: [{ id: 'edge-1', source: 'a', target: 'b' }],
        },
      }
    },
    async readAgentRun() {},
    async listAgentArtifacts() { return [] },
  }
  const { registry } = await createAgentSubagentProjectRegistry({
    productStore, userId: 'user-1', projectId: 'project-1', config: {},
  })

  assert.ok(registry.names().includes('canvas_read'))
  assert.equal(registry.names().some((name) => /submit|cancel|write/u.test(name)), false)
  const output = await registry.execute('canvas_read', {})
  assert.deepEqual(output, {
    nodeCount: 1,
    edgeCount: 1,
    nodes: [{ id: 'node-1', type: 'result', label: '候选图' }],
    omittedNodeCount: 0,
  })
  assert.doesNotMatch(JSON.stringify(output), /base64|private prompt/u)
})

test('联网工具沿用 canonical journal 恢复语义，并共用服务端配额', async () => {
  const quotas = []
  const { registry } = await createAgentSubagentProjectRegistry({
    productStore: { async readProject() { return { document: { nodes: [], edges: [] } } } },
    userId: 'user-1',
    projectId: 'project-1',
    config: { webSearch: { apiKey: 'test-key', searchUrl: 'https://example.test/search', extractUrl: 'https://example.test/extract' } },
    consumeWebResearchQuota: async (userId) => { quotas.push(userId); return { allowed: true } },
  })

  // journal(H6B):completed 复用 durable envelope,dispatched 无结果收口 outcome-unknown;
  // 与根 Turn/Chat/Planner 同一语义,不再按入口分叉。
  assert.equal(registry.get('web_search')?.recovery, 'journal')
  assert.equal(registry.get('web_fetch')?.recovery, 'journal')
  // 不真实调用 Provider；Registry 内闭包已经绑定同一 userId 的 quota seam。
  assert.deepEqual(quotas, [])
})

test('Subagent Registry 对不存在项目 fail closed', async () => {
  await assert.rejects(
    createAgentSubagentProjectRegistry({
      productStore: { async readProject() {} }, userId: 'user-1', projectId: 'missing',
    }),
    (error) => error?.code === 'AGENT_SUBAGENT_PROJECT_NOT_FOUND' && error?.statusCode === 404,
  )
})
