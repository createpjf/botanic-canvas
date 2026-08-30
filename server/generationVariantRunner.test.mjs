import assert from 'node:assert/strict'
import test from 'node:test'
import { generateFlockImages } from './flockGenerationProvider.mjs'
import { generateImages } from './generationProvider.mjs'
import { encodeRgbaPng } from './imageOverlay.mjs'

const pngBase64 = encodeRgbaPng({
  width: 2,
  height: 2,
  rgba: Buffer.from([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 255, 255,
  ]),
}).toString('base64')

function imageJob(provider, batchCount) {
  return {
    prompt: '香氛主视觉',
    batchCount,
    settings: provider === 'flock'
      ? {
          model: 'gemini-3.1-flash-image-preview',
          aspectRatio: '3:4',
          resolution: '2K',
          thinkingLevel: 'high',
          searchGrounding: true,
        }
      : { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '1K' },
    references: [],
  }
}

async function runProvider(provider, {
  batchCount,
  completedVariants = [],
  responses,
  onVariant,
  onRequest,
}) {
  let requestCount = 0
  const fetchImpl = async () => {
    const response = responses[requestCount]
    requestCount += 1
    onRequest?.()
    return response
  }
  const jobId = `job-${provider}-variants`
  const options = {
    apiBaseUrl: 'https://provider.example/v1',
    apiKey: 'test-key',
    jobId,
    completedVariants,
    onVariant,
  }

  if (provider === 'flock') {
    const result = await generateFlockImages(imageJob(provider, batchCount), {
      ...options,
      fetchImpl,
      persistMedia: async () => `/api/media/${provider}`,
    })
    return { result, requestCount, jobId }
  }

  const originalFetch = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    const result = await generateImages(imageJob(provider, batchCount), {
      ...options,
      variantConcurrency: 1,
      persistImage: async () => `/api/media/${provider}`,
    })
    return { result, requestCount, jobId }
  } finally {
    globalThis.fetch = originalFetch
  }
}

function successfulResponse() {
  return new Response(JSON.stringify({ data: [{ b64_json: pngBase64 }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function rejectedResponse(status, requestId) {
  return new Response(JSON.stringify({ error: { message: `upstream ${requestId}` } }), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': requestId },
  })
}

for (const provider of ['openai', 'flock']) {
  test(`${provider} 共用候选 runner：恢复不重复请求，生命周期与部分成功保持一致`, async () => {
    const events = []
    const recovered = { id: `job-${provider}-variants-output-1`, image: '/api/media/recovered' }
    const { result, requestCount, jobId } = await runProvider(provider, {
      batchCount: 3,
      completedVariants: [{ index: 0, status: 'succeeded', output: recovered }],
      responses: [rejectedResponse(429, 'second'), successfulResponse()],
      onVariant: async (event) => { events.push(event) },
    })

    assert.equal(requestCount, provider === 'flock' ? 1 : 2, '已完成的 index=0 不应再次调用 Provider')
    assert.deepEqual(result.outputs.map((output) => output.id), provider === 'flock'
      ? [recovered.id]
      : [recovered.id, `${jobId}-output-3`])
    assert.equal(result.missingOutputCount, provider === 'flock' ? 2 : 1)
    assert.match(result.partialError, provider === 'flock' ? /1\/3.*缺少的 2 张/u : /2\/3.*缺少的 1 张/u)
    assert.deepEqual(events.map(({ index, status }) => ({ index, status })), [
      { index: 1, status: 'running' },
      { index: 1, status: 'failed' },
      ...(provider === 'flock' ? [] : [
        { index: 2, status: 'running' },
        { index: 2, status: 'succeeded' },
      ]),
    ])
    assert.equal(typeof events[1].error, 'string')
    if (provider !== 'flock') assert.equal(typeof events[3].output?.image, 'string')
  })

  test(`${provider} 共用候选 runner：全失败抛首错，并保留 Adapter 的快速失败策略`, async () => {
    const events = []
    let requestCount = 0
    const responses = [
      rejectedResponse(429, 'first'),
      rejectedResponse(500, 'second'),
    ]
    await assert.rejects(() => runProvider(provider, {
      batchCount: 2,
      responses,
      onRequest: () => { requestCount += 1 },
      onVariant: async (event) => { events.push(event) },
    }), (error) => error?.code === 'PROVIDER_RATE_LIMITED')

    const expectedEvents = [
      { index: 0, status: 'running' },
      { index: 0, status: 'failed' },
      ...(provider === 'flock' ? [] : [
        { index: 1, status: 'running' },
        { index: 1, status: 'failed' },
      ]),
    ]
    assert.equal(requestCount, provider === 'flock' ? 1 : 2)
    assert.deepEqual(events.map(({ index, status }) => ({ index, status })), expectedEvents)
  })

  test(`${provider} 共用候选 runner：非致命错误全部结算后仍抛索引最小的首错`, async () => {
    let requestCount = 0
    await assert.rejects(() => runProvider(provider, {
      batchCount: 2,
      responses: [
        rejectedResponse(422, 'first'),
        rejectedResponse(422, 'second'),
      ],
      onRequest: () => { requestCount += 1 },
    }), (error) => (
      error?.code === 'PROVIDER_REJECTED'
      && /first/u.test(error.message)
      && !/second/u.test(error.message)
    ))
    assert.equal(requestCount, 2)
  })
}
