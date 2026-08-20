import assert from 'node:assert/strict'
import test from 'node:test'
import {
  botanicAgentVisionBriefing,
  botanicAgentVisionCandidates,
  describeBotanicAgentContextImages,
} from './botanicAgentVision.mjs'

const runtimeConfig = {
  flockApiBaseUrl: 'https://api.flock.example/v1',
  flockApiKey: 'flock-secret',
  agentVisionModel: 'gemini-flash',
}

const document = {
  id: 'project-vision',
  nodes: [
    { id: 'asset-mia', type: 'asset', data: { kind: 'asset', name: 'Mia 肖像', role: '模特', image: '/api/media/media-mia', mediaKind: 'image' } },
    { id: 'asset-inline', type: 'asset', data: { kind: 'asset', name: '内联图', image: 'data:image/png;base64,QUJD' } },
    { id: 'asset-video', type: 'asset', data: { kind: 'asset', name: '视频素材', image: '/api/media/media-video', mediaKind: 'video' } },
    { id: 'asset-blob', type: 'asset', data: { kind: 'asset', name: '本地图', image: 'blob:http://localhost/x' } },
    { id: 'asset-external', type: 'asset', data: { kind: 'asset', name: '外链图', image: 'https://example.com/a.png' } },
    { id: 'text-1', type: 'text', data: { kind: 'text', content: '文字' } },
    { id: 'result-1', type: 'result', data: { kind: 'result', label: '首图 01', image: '/api/media/media-result', status: 'ready' } },
  ],
}

function visionResponse(text) {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 })
}

test('看图候选只认当前画布上可解析的图片素材与结果', () => {
  const candidates = botanicAgentVisionCandidates(document, [
    'asset-mia', 'asset-mia', 'asset-inline', 'asset-video', 'asset-blob', 'asset-external', 'text-1', 'result-1', 'missing',
  ])
  assert.deepEqual(candidates.map((item) => item.nodeId), ['asset-mia', 'asset-inline', 'result-1'])
  assert.equal(candidates[0].role, '模特')
})

test('识别引用图片：项目媒体经归属校验解析，内联图直通，主轮之外不发多余请求', async () => {
  const requests = []
  const resolved = []
  const descriptions = await describeBotanicAgentContextImages({
    document,
    contextNodeIds: ['asset-mia', 'asset-inline'],
    runtimeConfig,
    cache: new Map(),
    resolveMedia: async (mediaId) => {
      resolved.push(mediaId)
      return { mimeType: 'image/jpeg', buffer: Buffer.from('mia-bytes') }
    },
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) })
      return visionResponse('海边自然光人像，柔和暖调，浅景深。')
    },
  })

  assert.deepEqual(resolved, ['media-mia'])
  assert.equal(requests.length, 2)
  assert.ok(requests.every((request) => request.url === 'https://api.flock.example/v1/chat/completions'))
  assert.ok(requests.every((request) => request.body.model === 'gemini-flash'))
  // 并发识别不保证顺序：按图片内容找对应请求。项目媒体解析成 data URL，内联图直通。
  const imageParts = requests.map((request) => request.body.messages[1].content.find((part) => part.type === 'image_url').image_url.url)
  assert.ok(imageParts.includes('data:image/jpeg;base64,' + Buffer.from('mia-bytes').toString('base64')))
  assert.ok(imageParts.includes('data:image/png;base64,QUJD'))
  assert.deepEqual(descriptions.map((item) => item.nodeId), ['asset-mia', 'asset-inline'])
  assert.match(descriptions[0].description, /海边自然光/)
})

test('同一张图第二轮命中缓存，不再调用视觉模型；单张失败不影响其它', async () => {
  const cache = new Map()
  let calls = 0
  const run = () => describeBotanicAgentContextImages({
    document,
    contextNodeIds: ['asset-mia', 'asset-inline'],
    runtimeConfig,
    cache,
    resolveMedia: async () => ({ mimeType: 'image/png', buffer: Buffer.from('bytes') }),
    fetchImpl: async (_url, init) => {
      calls += 1
      const body = JSON.parse(init.body)
      // 内联图那张永远失败：它不该拖垮另一张。
      if (JSON.stringify(body).includes('QUJD')) return new Response('boom', { status: 502 })
      return visionResponse('棚拍商品图，顶光，深色背景。')
    },
  })

  const first = await run()
  assert.deepEqual(first.map((item) => item.nodeId), ['asset-mia'])
  assert.equal(calls, 2)
  const second = await run()
  assert.deepEqual(second.map((item) => item.nodeId), ['asset-mia'])
  // 成功那张命中缓存；失败那张会再试一次。
  assert.equal(calls, 3)
})

test('视觉模型或密钥未配置时静默返回空，不发任何请求', async () => {
  let calls = 0
  const fetchImpl = async () => { calls += 1; return visionResponse('x') }
  assert.deepEqual(await describeBotanicAgentContextImages({
    document, contextNodeIds: ['asset-inline'], cache: new Map(),
    runtimeConfig: { ...runtimeConfig, agentVisionModel: '' }, fetchImpl,
  }), [])
  assert.deepEqual(await describeBotanicAgentContextImages({
    document, contextNodeIds: ['asset-inline'], cache: new Map(),
    runtimeConfig: { ...runtimeConfig, flockApiKey: '' }, fetchImpl,
  }), [])
  assert.equal(calls, 0)
})

test('视觉描述段落列出每张图，并禁止模型虚构描述之外的细节', () => {
  const briefing = botanicAgentVisionBriefing([
    { nodeId: 'asset-mia', label: 'Mia 肖像', role: '模特', description: '自然光半身人像。' },
  ])
  assert.match(briefing, /Mia 肖像：自然光半身人像。/)
  assert.match(briefing, /不要声称看到了描述之外的细节/)
  assert.equal(botanicAgentVisionBriefing([]), '')
})
