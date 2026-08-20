import assert from 'node:assert/strict'
import test from 'node:test'
import { botanicAgentReviewCandidates, reviewBotanicAgentRunResults } from './botanicAgentReview.mjs'

const runtimeConfig = {
  flockApiBaseUrl: 'https://api.flock.example/v1',
  flockApiKey: 'flock-secret',
  agentVisionModel: 'gemini-flash',
}

const run = {
  id: 'run-1', status: 'completed',
  plan: { instruction: '三档肤色人像', prompt: '自然光半身人像，保持身份。' },
  branches: [
    { id: 'branch-a', label: '白皙' },
    { id: 'branch-b', label: '深棕' },
    { id: 'branch-c', label: '未回填' },
  ],
}

const document = {
  id: 'project-1',
  nodes: [
    { id: 'result-b', type: 'result', data: { label: '深棕', image: 'data:image/png;base64,REVFUA==', agentRun: { runId: 'run-1', branchId: 'branch-b' } } },
    { id: 'result-a', type: 'result', data: { label: '白皙', image: 'data:image/png;base64,RkFJUg==', agentRun: { runId: 'run-1', branchId: 'branch-a' } } },
    { id: 'result-video', type: 'result', data: { label: '视频', image: '/api/media/v', mediaKind: 'video', agentRun: { runId: 'run-1', branchId: 'branch-c' } } },
    { id: 'result-other', type: 'result', data: { label: '别的任务', image: 'data:image/png;base64,WA==', agentRun: { runId: 'run-2', branchId: 'x' } } },
  ],
}

function reviewResponse(payload) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { status: 200 })
}

test('评审候选按分支顺序收集已回填的图片结果', () => {
  const candidates = botanicAgentReviewCandidates(run, document)
  assert.deepEqual(candidates.map((item) => [item.nodeId, item.branchLabel]), [
    ['result-a', '白皙'],
    ['result-b', '深棕'],
  ])
})

test('一次调用评整批：结果图与编号对照进请求，结论映射回节点', async () => {
  const requests = []
  const review = await reviewBotanicAgentRunResults({
    run,
    document,
    runtimeConfig,
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) })
      return reviewResponse({
        summary: '整体达标，深棕肤色偏灰。',
        best: 1,
        items: [
          { index: 1, verdict: 'pass', note: '光线柔和，身份保持好。' },
          { index: 2, verdict: 'adjust', note: '肤色偏灰，可提高暖调。' },
          { index: 99, verdict: 'pass', note: '幻觉编号应被丢弃' },
        ],
      })
    },
  })

  assert.equal(requests.length, 1)
  assert.equal(requests[0].body.model, 'gemini-flash')
  const userParts = requests[0].body.messages[1].content
  assert.match(userParts[0].text, /创作诉求：三档肤色人像/)
  assert.match(userParts[0].text, /1=「白皙」 2=「深棕」/)
  assert.equal(userParts.filter((part) => part.type === 'image_url').length, 2)

  assert.equal(review.summary, '整体达标，深棕肤色偏灰。')
  assert.equal(review.bestNodeId, 'result-a')
  assert.deepEqual(review.items, [
    { nodeId: 'result-a', branchLabel: '白皙', verdict: 'pass', note: '光线柔和，身份保持好。' },
    { nodeId: 'result-b', branchLabel: '深棕', verdict: 'adjust', note: '肤色偏灰，可提高暖调。' },
  ])
})

test('非终态、未配置视觉、无可评结果或模型输出不可解析时都返回空', async () => {
  const fetchImpl = async () => reviewResponse({ summary: 'x', items: [{ index: 1, verdict: 'pass', note: '' }] })
  assert.equal(await reviewBotanicAgentRunResults({
    run: { ...run, status: 'running' }, document, runtimeConfig, fetchImpl,
  }), undefined)
  assert.equal(await reviewBotanicAgentRunResults({
    run, document, runtimeConfig: { ...runtimeConfig, agentVisionModel: '' }, fetchImpl,
  }), undefined)
  assert.equal(await reviewBotanicAgentRunResults({
    run, document: { id: 'project-1', nodes: [] }, runtimeConfig, fetchImpl,
  }), undefined)
  assert.equal(await reviewBotanicAgentRunResults({
    run, document, runtimeConfig,
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: '这不是 JSON' } }] }), { status: 200 }),
  }), undefined)
})
