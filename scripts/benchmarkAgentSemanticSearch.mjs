// 本地合成基准：仅注入假 embedding Provider，不读取项目、凭据或真实会话。
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { queryCanvasWithSemanticSearch } from '../server/canvas/canvasAgentSemanticSearch.mjs'

const document = {
  nodes: Array.from({ length: 500 }, (_, i) => ({ id: `node-${i}`, type: 'text', data: { label: `候选${i}`, content: '春日植物' } })),
  edges: [],
}
const trials = { cold: [], warm: [] }
const requests = { cold: [], warm: [] }
for (let sample = 0; sample < 10; sample++) {
  const config = { enabled: true, apiBaseUrl: 'https://synthetic.invalid', apiKey: 'synthetic', model: `bench-${sample}` }
  for (const phase of ['cold', 'warm']) {
    let count = 0
    const start = performance.now()
    const result = await queryCanvasWithSemanticSearch(document, { mode: 'semantic', query: '植物', limit: 10 }, config, async (_url, init) => {
      count++
      await delay(2, undefined, { signal: init.signal })
      return { ok: true, json: async () => ({ data: JSON.parse(init.body).input.map(() => ({ embedding: [1, 0] })) }) }
    })
    trials[phase].push(performance.now() - start)
    requests[phase].push(count)
    assert.equal(result.search.degraded, false)
    assert.equal(result.nodes.length, 10)
  }
}
for (const phase of ['cold', 'warm']) {
  const sorted = trials[phase].sort((a, b) => a - b)
  console.log(JSON.stringify({ phase, samples: sorted.length, candidates: 500, fakeBatchDelayMs: 2,
    p50Ms: Number(sorted[4].toFixed(2)), p95Ms: Number(sorted[9].toFixed(2)), requests: requests[phase],
    environment: { node: process.version, platform: process.platform, arch: process.arch },
  }))
}
