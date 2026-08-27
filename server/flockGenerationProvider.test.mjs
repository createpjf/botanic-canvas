import assert from 'node:assert/strict'
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
  model: 'gemini-3.1-pro-preview',
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

test('无参考走 images/generations，并写入比例、清晰度、thinking 与 search', () => {
  const request = buildFlockImageRequest({
    prompt: '海边主视觉',
    settings: nanoSettings,
    references: [],
  })
  assert.equal(request.path, '/images/generations')
  assert.equal(request.body.model, 'gemini-3.1-pro-preview')
  assert.equal(request.body.n, 1)
  assert.equal(request.body.aspect_ratio, '21:9')
  assert.equal(request.body.image_size, '4K')
  assert.equal(request.body.thinking_level, 'high')
  assert.deepEqual(request.body.tools, [{ type: 'google_search', search_types: ['web_search', 'image_search'] }])
  assert.match(request.body.prompt, /海边主视觉/)
})

test('有参考或父图走 chat/completions，最多带 14 张 image_url', () => {
  const extras = Array.from({ length: 16 }, (_, index) => reference(`参考 ${index + 1}`, index + 1))
  const request = buildFlockImageRequest({
    prompt: '提高清晰度',
    settings: { ...nanoSettings, thinkingLevel: 'minimal', searchGrounding: false },
    parent: reference('父图', 0),
    references: extras,
  })
  assert.equal(request.path, '/chat/completions')
  assert.equal(request.body.thinking_level, 'minimal')
  assert.equal('tools' in request.body, false)
  const parts = request.body.messages[0].content
  assert.equal(parts[0].type, 'text')
  assert.equal(parts.filter((part) => part.type === 'image_url').length, 14)
})

test('searchGrounding 默认开，显式关闭才去掉 tools', () => {
  assert.ok(flockImageRequestFields({}).tools)
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
  }), (error) => error instanceof GenerationError && error.code === 'EMPTY_PROVIDER_RESPONSE')
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
