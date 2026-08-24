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

  // 夹具是 4 字节假数据，认不出文件头：规格只报字节数与声明类型，不猜尺寸 ——
  // 评审第 1 层据此判「无法验证」，而不是默认通过。
  assert.deepEqual(result.outputs, [
    { id: 'job-image-output-1', image: '/api/media/1', mediaKind: 'image', spec: { byteSize: 4, declaredMimeType: 'image/jpeg' } },
    { id: 'job-image-output-2', image: '/api/media/2', mediaKind: 'image', spec: { byteSize: 4, declaredMimeType: 'image/jpeg' } },
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
    spec: { byteSize: persisted[0].buffer.length, declaredMimeType: 'video/mp4' },
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

test('MiniMax H3 把首尾帧与参考视频转换为官方 content 对象', async () => {
  const submittedPayloads = []
  const run = (references, jobId) => generateMiniMaxVideos({
    kind: 'generation',
    prompt: '镜头自然过渡',
    batchCount: 1,
    settings: { model: 'MiniMax-H3', aspectRatio: '16:9', resolution: '2K', duration: 6 },
    references,
  }, {
    apiBaseUrl: 'https://api.minimax.io',
    apiKey: 'test-key',
    jobId,
    sleep: async () => undefined,
    fetchImpl: async (url, init = {}) => {
      if (url.endsWith('/v2/video_generation')) {
        submittedPayloads.push(JSON.parse(init.body))
        return new Response(JSON.stringify({ task_id: `${jobId}-task` }), { status: 200 })
      }
      if (url.includes('/v2/query/video_generation/')) {
        return new Response(JSON.stringify({ task: { status: 'succeeded', content: { url: 'https://cdn.example/result.mp4' } } }), { status: 200 })
      }
      return new Response(Buffer.from('video'), { status: 200, headers: { 'content-type': 'video/mp4' } })
    },
    persistMedia: async () => `/api/media/${jobId}`,
  })

  await run([
    { name: '首帧', role: '场景', inputRole: 'first_frame', mediaKind: 'image', mimeType: 'image/png', buffer: Buffer.from('start') },
    { name: '尾帧', role: '场景', inputRole: 'last_frame', mediaKind: 'image', mimeType: 'image/png', buffer: Buffer.from('end') },
  ], 'frames')
  await run([
    { name: '上游视频', role: '首图', inputRole: 'reference_video', mediaKind: 'video', mimeType: 'video/mp4', buffer: Buffer.from('clip') },
  ], 'video-ref')

  assert.deepEqual(submittedPayloads[0].content.slice(1).map((item) => [item.type, item.role]), [
    ['image_url', 'first_frame'],
    ['image_url', 'last_frame'],
  ])
  assert.equal(submittedPayloads[0].ratio, 'adaptive')
  assert.deepEqual(submittedPayloads[1].content.slice(1).map((item) => [item.type, item.role]), [
    ['video_url', 'reference_video'],
  ])
  assert.match(submittedPayloads[1].content[1].video_url.url, /^data:video\/mp4;base64,/)
})

test('MiniMax H3 扩展画面使用 reference_image 并保留 4:3 输出比例', async () => {
  let submittedPayload
  await generateMiniMaxVideos({
    kind: 'generation',
    prompt: '在不拉伸人物的前提下补全左右环境',
    batchCount: 1,
    settings: { model: 'MiniMax-H3', aspectRatio: '4:3', resolution: '2K', duration: 5 },
    references: [{
      name: '方形参考图',
      role: '首图',
      inputRole: 'reference_image',
      mediaKind: 'image',
      mimeType: 'image/png',
      buffer: Buffer.from('square-image'),
    }],
  }, {
    apiBaseUrl: 'https://api.minimax.io',
    apiKey: 'test-key',
    jobId: 'expand-to-4-3',
    sleep: async () => undefined,
    fetchImpl: async (url, init = {}) => {
      if (url.endsWith('/v2/video_generation')) {
        submittedPayload = JSON.parse(init.body)
        return new Response(JSON.stringify({ task_id: 'expand-task' }), { status: 200 })
      }
      if (url.includes('/v2/query/video_generation/')) {
        return new Response(JSON.stringify({ task: { status: 'succeeded', content: { url: 'https://cdn.example/expanded.mp4' } } }), { status: 200 })
      }
      return new Response(Buffer.from('video'), { status: 200, headers: { 'content-type': 'video/mp4' } })
    },
    persistMedia: async () => '/api/media/expanded-video',
  })

  assert.equal(submittedPayload.ratio, '4:3')
  assert.deepEqual(submittedPayload.content.slice(1).map((item) => [item.type, item.role]), [
    ['image_url', 'reference_image'],
  ])
})
