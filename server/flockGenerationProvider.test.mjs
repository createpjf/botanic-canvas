import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { GenerationError } from './generationProvider.mjs'
import {
  buildFlockImageRequest,
  flockImageRequestFields,
  generateFlockImages,
} from './flockGenerationProvider.mjs'
import { encodeRgbaPng } from './imageOverlay.mjs'

const png = encodeRgbaPng({
  width: 2,
  height: 2,
  rgba: Buffer.from([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 255, 255,
  ]),
})
const pngBase64 = png.toString('base64')

const nanoSettings = {
  model: 'gemini-3.1-flash-image-preview',
  aspectRatio: '21:9',
  resolution: '4K',
  thinkingLevel: 'high',
  searchGrounding: true,
}

function reference(name = '商品', tint = 0) {
  const pixels = Buffer.from([
    255, tint, 0, 255, 0, 255, tint, 255,
    tint, 0, 255, 255, 255, 255, 255, 255,
  ])
  return {
    name,
    role: '商品',
    mimeType: 'image/png',
    buffer: encodeRgbaPng({ width: 2, height: 2, rgba: pixels }),
    mediaKind: 'image',
  }
}

async function requestPayload(request) {
  const text = typeof request.body === 'string'
    ? request.body
    : await new Response(request.body).text()
  return JSON.parse(text)
}

function imageRequestResponse({ status = 200, headers = {}, body = Buffer.alloc(0), inspect } = {}) {
  return (url, options, onResponse) => {
    const request = new EventEmitter()
    request.end = () => {
      inspect?.(url, options)
      const response = new PassThrough()
      response.statusCode = status
      response.headers = headers
      onResponse(response)
      response.end(body)
    }
    return request
  }
}

test('无参考走 images/generations，并写入比例、清晰度、thinking 与 search', async () => {
  const request = buildFlockImageRequest({
    prompt: '海边主视觉',
    settings: nanoSettings,
    references: [],
  })
  const body = await requestPayload(request)
  assert.equal(request.path, '/images/generations')
  assert.equal(body.model, 'gemini-3.1-flash-image-preview')
  assert.equal(body.n, 1)
  assert.equal(body.aspect_ratio, '21:9')
  assert.equal(body.image_size, '4K')
  assert.equal(body.thinking_level, 'high')
  assert.deepEqual(body.tools, [{ type: 'google_search', search_types: ['web_search', 'image_search'] }])
  assert.match(body.prompt, /海边主视觉/)
})

test('有参考或父图流式写 chat/completions，最多带 14 张 image_url', async () => {
  const extras = Array.from({ length: 16 }, (_, index) => reference(`参考 ${index + 1}`, index + 1))
  const request = buildFlockImageRequest({
    prompt: '提高清晰度',
    settings: { ...nanoSettings, thinkingLevel: 'minimal', searchGrounding: false },
    parent: reference('父图', 0),
    references: extras,
  })
  const body = await requestPayload(request)
  assert.equal(request.path, '/chat/completions')
  assert.equal(request.duplex, 'half')
  assert.equal(body.thinking_level, 'minimal')
  assert.equal('tools' in body, false)
  const parts = body.messages[0].content
  assert.equal(parts[0].type, 'text')
  assert.equal(parts.filter((part) => part.type === 'image_url').length, 14)
})

test('searchGrounding 与 thinking 只按已冻结的模型设置发送', () => {
  assert.ok(flockImageRequestFields({ searchGrounding: true, thinkingLevel: 'high' }).tools)
  assert.equal(flockImageRequestFields({ searchGrounding: true, thinkingLevel: 'high' }).thinking_level, 'high')
  assert.equal('tools' in flockImageRequestFields({}), false)
  assert.equal('thinking_level' in flockImageRequestFields({}), false)
  assert.equal('tools' in flockImageRequestFields({ searchGrounding: false }), false)
})

test('文生图从 data[].b64_json 收图', async () => {
  const persisted = []
  const result = await generateFlockImages({
    prompt: '香氛主图',
    batchCount: 1,
    settings: nanoSettings,
    references: [],
  }, {
    apiBaseUrl: 'https://api.flock.io/v1',
    apiKey: 'flock-key',
    jobId: 'job-flock-b64',
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.flock.io/v1/images/generations')
      assert.equal(init.headers.Authorization, 'Bearer flock-key')
      assert.equal(init.headers['x-litellm-api-key'], 'flock-key')
      assert.equal(init.redirect, 'error')
      return new Response(JSON.stringify({ data: [{ b64_json: pngBase64 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
    persistMedia: async (media) => {
      persisted.push(media)
      return '/api/media/flock-1'
    },
  })
  assert.equal(result.outputs[0].image, '/api/media/flock-1')
  assert.equal(result.missingOutputCount, 0)
  assert.equal(persisted[0].mimeType, 'image/png')
})

test('图生图从 chat message 的 image_url 收图', async () => {
  const result = await generateFlockImages({
    prompt: '提高清晰度',
    batchCount: 1,
    settings: nanoSettings,
    parent: reference('父图'),
  }, {
    apiBaseUrl: 'https://api.flock.io/v1',
    apiKey: 'flock-key',
    jobId: 'job-flock-chat',
    fetchImpl: async (url) => {
      assert.equal(url, 'https://api.flock.io/v1/chat/completions')
      return new Response(JSON.stringify({
        choices: [{ message: { content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${pngBase64}` } }] } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
    persistMedia: async () => '/api/media/flock-chat',
  })
  assert.equal(result.outputs[0].image, '/api/media/flock-chat')
})

test('Provider 图片 URL 拒绝内网、跳转与超大响应', async () => {
  for (const scenario of ['private', 'redirect', 'oversized']) {
    let downloadRequests = 0
    await assert.rejects(() => generateFlockImages({
      prompt: '香氛主图', batchCount: 1, settings: nanoSettings, references: [],
    }, {
      apiBaseUrl: 'https://api.flock.io/v1', apiKey: 'flock-key', jobId: `job-${scenario}`,
      fetchImpl: async (url) => {
        assert.equal(url, 'https://api.flock.io/v1/images/generations')
        const candidateUrl = scenario === 'private'
          ? 'https://169.254.169.254/latest/meta-data'
          : 'https://1.1.1.1/image.png'
        return new Response(JSON.stringify({ data: [{ url: candidateUrl }] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      },
      imageRequestImpl: imageRequestResponse({
        status: scenario === 'redirect' ? 302 : 200,
        headers: scenario === 'oversized' ? { 'content-length': String(33 * 1024 * 1024) } : {},
        inspect: (_url, options) => {
          downloadRequests += 1
          assert.equal(typeof options.lookup, 'function')
        },
      }),
      persistMedia: async () => '/unused',
    }), (error) => error instanceof GenerationError && error.code === 'EMPTY_PROVIDER_RESPONSE')
    assert.equal(downloadRequests, scenario === 'private' ? 0 : 1)
  }
})

test('Provider 图片 URL 固定首次校验的公网 IP，连接阶段不再解析 DNS', async () => {
  let dnsLookups = 0
  let pinnedAddress
  const result = await generateFlockImages({
    prompt: '香氛主图', batchCount: 1, settings: nanoSettings, references: [],
  }, {
    apiBaseUrl: 'https://api.flock.io/v1', apiKey: 'flock-key', jobId: 'job-pinned-url',
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/image.png' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }),
    lookup: async () => {
      dnsLookups += 1
      return ['93.184.216.34']
    },
    imageRequestImpl: imageRequestResponse({
      body: png,
      inspect: (_url, options) => {
        options.lookup('cdn.example', {}, (error, address) => {
          assert.ifError(error)
          pinnedAddress = address
        })
      },
    }),
    persistMedia: async () => '/api/media/pinned',
  })

  assert.equal(dnsLookups, 1)
  assert.equal(pinnedAddress, '93.184.216.34')
  assert.equal(result.outputs[0].image, '/api/media/pinned')
})

test('Provider JSON 在解析前按 Content-Length 拒绝超大响应', async () => {
  await assert.rejects(() => generateFlockImages({
    prompt: '香氛主图', batchCount: 1, settings: nanoSettings, references: [],
  }, {
    apiBaseUrl: 'https://api.flock.io/v1', apiKey: 'flock-key', jobId: 'job-large-json',
    fetchImpl: async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': String(60 * 1024 * 1024) },
    }),
    persistMedia: async () => '/unused',
  }), (error) => error instanceof GenerationError && error.code === 'INVALID_PROVIDER_RESPONSE')
})

test('同一 Worker 的 Flock 请求串行化，避免多任务同时放大媒体内存', async () => {
  let providerCalls = 0
  let activeRequests = 0
  let maximumActiveRequests = 0
  let releaseFirst
  let markFirstStarted
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve })
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  const fetchImpl = async () => {
    const call = providerCalls
    providerCalls += 1
    activeRequests += 1
    maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests)
    if (call === 0) {
      markFirstStarted()
      await firstGate
    }
    activeRequests -= 1
    return new Response(JSON.stringify({ data: [{ b64_json: pngBase64 }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
  const run = (jobId) => generateFlockImages({
    prompt: '香氛主图', batchCount: 1, settings: nanoSettings, references: [],
  }, {
    apiBaseUrl: 'https://api.flock.io/v1', apiKey: 'flock-key', jobId,
    fetchImpl,
    persistMedia: async () => `/api/media/${jobId}`,
  })

  const first = run('job-serial-1')
  await firstStarted
  const second = run('job-serial-2')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(providerCalls, 1)
  releaseFirst()
  await Promise.all([first, second])
  assert.equal(providerCalls, 2)
  assert.equal(maximumActiveRequests, 1)
})

test('回包没有图片时失败可见', async () => {
  await assert.rejects(() => generateFlockImages({
    prompt: '香氛主图',
    batchCount: 1,
    settings: nanoSettings,
    references: [],
  }, {
    apiBaseUrl: 'https://api.flock.io/v1',
    apiKey: 'flock-key',
    jobId: 'job-flock-empty',
    fetchImpl: async () => new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    persistMedia: async () => '/api/media/unused',
  }), (error) => {
    assert.deepEqual(error.providerResponseSummary, {
      type: 'object', candidateCount: 0, keys: ['data'], dataCount: 0,
    })
    return error instanceof GenerationError && error.code === 'EMPTY_PROVIDER_RESPONSE'
  })
})

test('网络或跳转失败归一化为批次级故障，不继续请求剩余候选', async () => {
  let requests = 0
  await assert.rejects(() => generateFlockImages({
    prompt: '香氛主图', batchCount: 3, settings: nanoSettings, references: [],
  }, {
    apiBaseUrl: 'https://api.flock.io/v1', apiKey: 'flock-key', jobId: 'job-network-failed',
    fetchImpl: async (_url, init) => {
      requests += 1
      assert.equal(init.redirect, 'error')
      throw new TypeError('fetch failed')
    },
    persistMedia: async () => '/unused',
  }), (error) => error instanceof GenerationError && error.code === 'PROVIDER_UNAVAILABLE')
  assert.equal(requests, 1)
})

test('Provider 回包流中断后停止批次，不继续请求剩余候选', async () => {
  let requests = 0
  await assert.rejects(() => generateFlockImages({
    prompt: '香氛主图', batchCount: 3, settings: nanoSettings, references: [],
  }, {
    apiBaseUrl: 'https://api.flock.io/v1', apiKey: 'flock-key', jobId: 'job-stream-failed',
    fetchImpl: async () => {
      requests += 1
      return new Response(new ReadableStream({
        start(controller) { controller.error(new Error('socket reset')) },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
    persistMedia: async () => '/unused',
  }), (error) => error instanceof GenerationError && error.code === 'PROVIDER_UNAVAILABLE')
  assert.equal(requests, 1)
})

test('媒体持久化失败后停止批次，避免继续产生不可保存的付费结果', async () => {
  let requests = 0
  await assert.rejects(() => generateFlockImages({
    prompt: '香氛主图', batchCount: 3, settings: nanoSettings, references: [],
  }, {
    apiBaseUrl: 'https://api.flock.io/v1', apiKey: 'flock-key', jobId: 'job-persist-failed',
    fetchImpl: async () => {
      requests += 1
      return new Response(JSON.stringify({ data: [{ b64_json: pngBase64 }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    },
    persistMedia: async () => { throw new Error('storage unavailable') },
  }), /storage unavailable/u)
  assert.equal(requests, 1)
})

test('未配置 Flock 密钥时失败可见', async () => {
  await assert.rejects(() => generateFlockImages({
    prompt: '香氛主图',
    batchCount: 1,
    settings: nanoSettings,
  }, {
    apiBaseUrl: 'https://api.flock.io/v1',
    apiKey: '',
    jobId: 'job-flock-no-key',
    persistMedia: async () => '/x',
  }), (error) => error instanceof GenerationError && error.code === 'PROVIDER_NOT_CONFIGURED')
})
