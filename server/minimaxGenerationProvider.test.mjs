import assert from 'node:assert/strict'
import test from 'node:test'
import { generateMiniMaxImages, generateMiniMaxVideos } from './minimaxGenerationProvider.mjs'

const jpegBase64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')

test('MiniMax image-01 一次请求稳定返回 N 个独立图片输出', async () => {
  const persisted = []
  const result = await generateMiniMaxImages({
    kind: 'generation',
    prompt: '香氛商品置于夏日窗台',
    batchCount: 2,
    settings: { model: 'image-01', aspectRatio: '3:4', resolution: '2K' },
    references: [{
      name: '模特',
      role: '模特',
      primary: true,
      mimeType: 'image/jpeg',
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    }],
  }, {
    apiBaseUrl: 'https://api.minimax.io',
    apiKey: 'test-key',
    jobId: 'job-image',
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.minimax.io/v1/image_generation')
      assert.equal(init.method, 'POST')
      assert.equal(init.headers.Authorization, 'Bearer test-key')
      const payload = JSON.parse(init.body)
      assert.equal(payload.model, 'image-01')
      assert.equal(payload.aspect_ratio, '3:4')
      assert.equal(payload.response_format, 'base64')
      assert.equal(payload.n, 2)
      assert.deepEqual(payload.subject_reference.map((item) => item.type), ['character'])
      assert.match(payload.subject_reference[0].image_file, /^data:image\/jpeg;base64,/)
      return new Response(JSON.stringify({
        data: { image_base64: [jpegBase64, jpegBase64] },
        base_resp: { status_code: 0, status_msg: 'success' },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
    persistMedia: async (media) => {
      persisted.push(media)
      return `/api/media/${persisted.length}`
    },
  })

  assert.deepEqual(result.outputs, [
    { id: 'job-image-output-1', image: '/api/media/1', mediaKind: 'image' },
    { id: 'job-image-output-2', image: '/api/media/2', mediaKind: 'image' },
  ])
  assert.equal(result.missingOutputCount, 0)
  assert.deepEqual(persisted.map((media) => media.mimeType), ['image/jpeg', 'image/jpeg'])
})

test('MiniMax H3 提交异步任务、轮询完成并持久化 MP4 输出', async () => {
  const requests = []
  const persisted = []
  const result = await generateMiniMaxVideos({
    kind: 'generation',
    prompt: '人物手持香水缓慢转身，镜头轻推',
    batchCount: 1,
    settings: { model: 'MiniMax-H3', aspectRatio: '3:4', resolution: '2K', duration: 5 },
    references: [{
      name: '首帧',
      role: '首图',
      primary: true,
      mimeType: 'image/png',
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    }],
  }, {
    apiBaseUrl: 'https://api.minimax.io',
    apiKey: 'test-key',
    jobId: 'job-video',
    pollIntervalMs: 1,
    sleep: async () => undefined,
    fetchImpl: async (url, init = {}) => {
      requests.push({ url, init })
      if (url.endsWith('/v2/video_generation')) {
        const payload = JSON.parse(init.body)
        assert.equal(payload.model, 'MiniMax-H3')
        assert.equal(payload.resolution, '2K')
        assert.equal(payload.duration, 5)
        assert.equal(payload.ratio, 'adaptive')
        assert.deepEqual(payload.content.map((item) => [item.type, item.role]), [
          ['text', undefined],
          ['image_url', 'first_frame'],
        ])
        assert.match(payload.content[1].image_url.url, /^data:image\/png;base64,/)
        return new Response(JSON.stringify({ task_id: 'h3-task-1' }), { status: 200 })
      }
      if (url.endsWith('/v2/query/video_generation/h3-task-1')) {
        const queryCount = requests.filter((request) => request.url.includes('/v2/query/')).length
        return new Response(JSON.stringify(queryCount === 1
          ? { task: { id: 'h3-task-1', status: 'running' } }
          : { task: { id: 'h3-task-1', status: 'succeeded', content: { url: 'https://cdn.example/video.mp4' } } }), { status: 200 })
      }
      assert.equal(url, 'https://cdn.example/video.mp4')
      return new Response(Buffer.from('fake-mp4'), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      })
    },
    persistMedia: async (media) => {
      persisted.push(media)
      return '/api/media/video-1'
    },
  })

  assert.deepEqual(result.outputs, [{
    id: 'job-video-output-1',
    image: '/api/media/video-1',
    mediaKind: 'video',
  }])
  assert.equal(result.missingOutputCount, 0)
  assert.equal(persisted[0].mimeType, 'video/mp4')
  assert.equal(persisted[0].mediaKind, 'video')
})

test('MiniMax H3 的 N 个候选拥有独立任务与稳定输出 ID', async () => {
  let submitted = 0
  const result = await generateMiniMaxVideos({
    kind: 'generation',
    prompt: '产品广告短片',
    batchCount: 2,
    settings: { model: 'MiniMax-H3', aspectRatio: '16:9', resolution: '2K', duration: 4 },
    references: [{ name: '首帧', role: '首图', mimeType: 'image/png', buffer: Buffer.from('image') }],
  }, {
    apiBaseUrl: 'https://api.minimax.io',
    apiKey: 'test-key',
    jobId: 'job-video-batch',
    sleep: async () => undefined,
    fetchImpl: async (url) => {
      if (url.endsWith('/v2/video_generation')) {
        submitted += 1
        return new Response(JSON.stringify({ task_id: `task-${submitted}` }), { status: 200 })
      }
      if (url.includes('/v2/query/video_generation/')) {
        return new Response(JSON.stringify({
          task: { status: 'succeeded', content: { url: `https://cdn.example/${submitted}.mp4` } },
        }), { status: 200 })
      }
      return new Response(Buffer.from('video'), { status: 200, headers: { 'content-type': 'video/mp4' } })
    },
    persistMedia: async (_media) => `/api/media/video-${submitted}`,
  })

  assert.equal(submitted, 2)
  assert.deepEqual(result.outputs.map((output) => output.id), [
    'job-video-batch-output-1',
    'job-video-batch-output-2',
  ])
  assert.equal(result.missingOutputCount, 0)
})

test('MiniMax H3 的上游失败状态会结束轮询并返回可操作错误', async () => {
  await assert.rejects(() => generateMiniMaxVideos({
    kind: 'generation',
    prompt: '产品广告短片',
    batchCount: 1,
    settings: { model: 'MiniMax-H3', aspectRatio: '16:9', resolution: '2K', duration: 4 },
    references: [{ name: '首帧', role: '首图', mimeType: 'image/png', buffer: Buffer.from('image') }],
  }, {
    apiBaseUrl: 'https://api.minimax.io',
    apiKey: 'test-key',
    jobId: 'job-video-failed',
    sleep: async () => undefined,
    fetchImpl: async (url) => url.endsWith('/v2/video_generation')
      ? new Response(JSON.stringify({ task_id: 'task-failed' }), { status: 200 })
      : new Response(JSON.stringify({ task: { status: 'failed' } }), { status: 200 }),
    persistMedia: async () => '/api/media/unexpected',
  }), (error) => error.code === 'PROVIDER_REJECTED' && /生成失败/.test(error.message))
})
