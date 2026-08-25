import assert from 'node:assert/strict'
import test from 'node:test'
import { generateImages, GenerationError, persistedGenerationJob, publicGenerationJob, resolveGenerationInputMedia, validateGenerationInput } from './generationProvider.mjs'

const image = 'data:image/png;base64,iVBORw0KGgo='

test('生成任务持久化保留幂等键，公开状态只按需返回提交者幂等键', () => {
  const job = {
    id: 'job-agent', ownerId: 'user-a', projectId: 'project-a', status: 'queued', kind: 'generation',
    createdAt: 1, updatedAt: 1, batchCount: 1, settings: { model: 'gpt-image-2' }, outputs: [],
    rawInput: { projectId: 'project-a' }, agentRun: { runId: 'run-a', branchId: 'branch-a' },
    promptNodeId: 'prompt-a', generateNodeId: 'generate-a', resultNodeId: 'result-a', parentNodeId: 'parent-a',
    idempotencyKey: 'gen_test_key_123456', projectWritebackPending: true,
  }
  assert.deepEqual(persistedGenerationJob(job).agentRun, job.agentRun)
  assert.equal(persistedGenerationJob(job).generateNodeId, 'generate-a')
  assert.equal(persistedGenerationJob(job).promptNodeId, 'prompt-a')
  assert.equal(persistedGenerationJob(job).parentNodeId, 'parent-a')
  assert.deepEqual(publicGenerationJob(job).agentRun, job.agentRun)
  assert.equal(publicGenerationJob(job).promptNodeId, 'prompt-a')
  assert.equal(publicGenerationJob(job).parentNodeId, 'parent-a')
  assert.equal(persistedGenerationJob(job).idempotencyKey, job.idempotencyKey)
  assert.equal(publicGenerationJob(job).idempotencyKey, undefined)
  assert.equal(publicGenerationJob(job, { includeIdempotencyKey: true }).idempotencyKey, job.idempotencyKey)
  assert.equal(publicGenerationJob(job).projectWritebackPending, true)
})

test('生成配方在进入 Redis 队列前完成模型、尺寸和图片约束校验', () => {
  const input = validateGenerationInput({
    projectId: 'project-a', kind: 'generation', prompt: '香氛商品主图', batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
    recipe: { references: [{ name: '主商品', role: '商品', primary: true, dataUrl: image }] },
  }, { models: ['gpt-image-2'], maximumBatchCount: 8, maximumReferenceBytes: 1024 })
  assert.equal(input.references[0].mimeType, 'image/png')
  assert.equal(input.settings.aspectRatio, '3:4')
  assert.throws(() => validateGenerationInput({
    projectId: 'project-a', kind: 'generation', prompt: 'x', batchCount: 1,
    settings: { model: 'other-model', aspectRatio: '1:1', resolution: '1K' },
    recipe: { references: [{ dataUrl: image }] },
  }, { models: ['gpt-image-2'], maximumBatchCount: 8, maximumReferenceBytes: 1024 }), (error) => error instanceof GenerationError && error.code === 'INVALID_REQUEST')
})

test('纯文字图片生成允许空参考，精修与局部重绘仍需要基准图', () => {
  const context = { models: ['gpt-image-2'], maximumBatchCount: 8, maximumReferenceBytes: 1024 }
  const direct = validateGenerationInput({
    projectId: 'project-a', kind: 'generation', prompt: '一张海边广告图', batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
    recipe: { references: [] },
  }, context)
  assert.deepEqual(direct.references, [])
  assert.throws(() => validateGenerationInput({
    projectId: 'project-a', kind: 'refinement', prompt: '换背景', batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
    recipe: { references: [] },
  }, context), (error) => error instanceof GenerationError && error.code === 'INVALID_REFERENCE')
})

test('已入库的私有参考图只保存 mediaId，Worker 执行时才读取图片字节', async () => {
  const input = validateGenerationInput({
    projectId: 'project-a', kind: 'generation', prompt: '香氛商品主图', batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '1K' },
    recipe: { references: [{ name: '主商品', role: '商品', primary: true, mediaId: 'media_example-1' }] },
  }, { models: ['gpt-image-2'], maximumBatchCount: 8, maximumReferenceBytes: 1024 })
  assert.equal(input.references[0].mediaId, 'media_example-1')
  assert.equal(input.references[0].buffer, undefined)

  const resolved = await resolveGenerationInputMedia(input, async (mediaId) => ({
    mimeType: 'image/png', buffer: Buffer.from(mediaId),
  }))
  assert.equal(resolved.references[0].buffer.toString(), 'media_example-1')
})

test('模型能力约束会阻止 H3 使用错误分辨率或时长', () => {
  const modelOptions = [{
    id: 'MiniMax-H3',
    mediaKind: 'video',
    aspectRatios: ['1:1', '3:4', '9:16', '16:9'],
    resolutions: ['2K'],
    durations: [4, 5, 6],
  }]
  const rawInput = {
    projectId: 'project-a', kind: 'generation', prompt: '人物手持商品缓慢转身', batchCount: 1,
    settings: { model: 'MiniMax-H3', aspectRatio: '3:4', resolution: '2K', duration: 5 },
    recipe: { references: [{ name: '首帧', role: '首图', primary: true, dataUrl: image }] },
  }
  const input = validateGenerationInput(rawInput, {
    models: modelOptions,
    maximumBatchCount: 8,
    maximumReferenceBytes: 1024,
  })
  assert.equal(input.settings.duration, 5)

  assert.throws(() => validateGenerationInput({
    ...rawInput,
    settings: { ...rawInput.settings, duration: 3 },
  }, {
    models: modelOptions,
    maximumBatchCount: 8,
    maximumReferenceBytes: 1024,
  }), (error) => error instanceof GenerationError && error.code === 'INVALID_REQUEST')
})

test('H3 接受带角色的视频素材，并阻止图片模型接收视频', async () => {
  const models = [{
    id: 'MiniMax-H3',
    mediaKind: 'video',
    aspectRatios: ['1:1'],
    resolutions: ['2K'],
    durations: [5],
  }, {
    id: 'gpt-image-2',
    mediaKind: 'image',
    aspectRatios: ['1:1'],
    resolutions: ['1K'],
  }]
  const rawInput = {
    projectId: 'project-a', kind: 'generation', prompt: '延续镜头运动', batchCount: 1,
    settings: { model: 'MiniMax-H3', aspectRatio: '1:1', resolution: '2K', duration: 5 },
    recipe: { references: [{ name: '上段视频', mediaKind: 'video', inputRole: 'reference_video', mediaId: 'media_video-1' }] },
  }
  const input = validateGenerationInput(rawInput, {
    models,
    maximumBatchCount: 8,
    maximumReferenceBytes: 1024,
  })
  assert.equal(input.references[0].mediaKind, 'video')
  assert.equal(input.references[0].inputRole, 'reference_video')

  const resolved = await resolveGenerationInputMedia(input, async () => ({
    mimeType: 'video/mp4', buffer: Buffer.from('video'),
  }))
  assert.equal(resolved.references[0].mimeType, 'video/mp4')

  assert.throws(() => validateGenerationInput({
    ...rawInput,
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
  }, {
    models,
    maximumBatchCount: 8,
    maximumReferenceBytes: 1024,
  }), (error) => error instanceof GenerationError && error.code === 'INVALID_REFERENCE')
})

test('gpt-image-2 接受 16:9 目录和自定义像素，并对齐到 16 的倍数', () => {
  const models = [{
    id: 'gpt-image-2',
    mediaKind: 'image',
    aspectRatios: ['1:1', '16:9', '4:3', '3:4', '4:5', '9:16'],
    resolutions: ['1K', '2K'],
    supportsCustomSize: true,
  }]
  const widescreen = validateGenerationInput({
    projectId: 'project-a', kind: 'generation', prompt: '横图主图', batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '16:9', resolution: '2K' },
    recipe: { references: [{ name: '主商品', role: '商品', primary: true, dataUrl: image }] },
  }, { models, maximumBatchCount: 8, maximumReferenceBytes: 1024 })
  assert.equal(widescreen.settings.aspectRatio, '16:9')

  const custom = validateGenerationInput({
    projectId: 'project-a', kind: 'generation', prompt: '横图主图', batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '2K', outputWidth: 1920, outputHeight: 1080 },
    recipe: { references: [{ name: '主商品', role: '商品', primary: true, dataUrl: image }] },
  }, { models, maximumBatchCount: 8, maximumReferenceBytes: 1024 })
  assert.equal(custom.settings.outputWidth, 1920)
  assert.equal(custom.settings.outputHeight, 1088)
  assert.equal(custom.settings.aspectRatio, '16:9')

  assert.throws(() => validateGenerationInput({
    projectId: 'project-a', kind: 'generation', prompt: '横图主图', batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '2K', outputWidth: 100, outputHeight: 100 },
    recipe: { references: [{ name: '主商品', role: '商品', primary: true, dataUrl: image }] },
  }, { models, maximumBatchCount: 8, maximumReferenceBytes: 1024 }), (error) => error instanceof GenerationError && error.code === 'INVALID_REQUEST')
})

test('不支持自定义像素的模型拒绝宽高，字符串模型目录仍允许 gpt-image-2 的 16:9', () => {
  assert.throws(() => validateGenerationInput({
    projectId: 'project-a', kind: 'generation', prompt: '横图主图', batchCount: 1,
    settings: { model: 'image-01', aspectRatio: '16:9', resolution: '1K', outputWidth: 1920, outputHeight: 1080 },
    recipe: { references: [{ name: '主商品', role: '商品', primary: true, dataUrl: image }] },
  }, {
    models: [{ id: 'image-01', mediaKind: 'image', aspectRatios: ['1:1', '16:9'], resolutions: ['1K'] }],
    maximumBatchCount: 8,
    maximumReferenceBytes: 1024,
  }), (error) => error instanceof GenerationError && error.code === 'INVALID_REQUEST')

  const input = validateGenerationInput({
    projectId: 'project-a', kind: 'generation', prompt: '横图主图', batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '16:9', resolution: '1K' },
    recipe: { references: [{ name: '主商品', role: '商品', primary: true, dataUrl: image }] },
  }, { models: ['gpt-image-2'], maximumBatchCount: 8, maximumReferenceBytes: 1024 })
  assert.equal(input.settings.aspectRatio, '16:9')
})

test('gpt-image-2 自定义尺寸写入对齐后的 Provider size', async () => {
  const originalFetch = globalThis.fetch
  let size
  globalThis.fetch = async (_url, init) => {
    size = init.body.get('size')
    return new Response(JSON.stringify({
      data: [{ b64_json: 'iVBORw0KGgo=' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    await generateImages({
      id: 'job-custom-size',
      kind: 'generation',
      batchCount: 1,
      prompt: '香氛商品主图',
      settings: { model: 'gpt-image-2', aspectRatio: '16:9', resolution: '2K', outputWidth: 1920, outputHeight: 1080 },
      references: [{ name: '主商品', role: '商品', primary: true, mimeType: 'image/png', buffer: Buffer.from('reference') }],
    }, {
      apiBaseUrl: 'https://example.test',
      apiKey: 'test-key',
      jobId: 'job-custom-size',
      persistImage: async (value) => value.dataUrl,
    })
    assert.equal(size, '1920x1088')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('无参考图片时使用 images/generations 纯文字入口', async () => {
  const originalFetch = globalThis.fetch
  let request
  globalThis.fetch = async (url, init) => {
    request = { url, init }
    return new Response(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgo=' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
  try {
    await generateImages({
      id: 'job-direct', kind: 'generation', batchCount: 1,
      prompt: '海边自然光下的香氛广告图',
      settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '1K' },
      references: [],
    }, {
      apiBaseUrl: 'https://example.test',
      apiKey: 'test-key',
      jobId: 'job-direct',
      persistImage: async (value) => value.dataUrl,
    })
    assert.equal(request.url, 'https://example.test/v1/images/generations')
    assert.equal(request.init.headers['Content-Type'], 'application/json')
    const body = JSON.parse(request.init.body)
    assert.equal(body.model, 'gpt-image-2')
    assert.match(body.prompt, /创意目标：海边自然光下的香氛广告图/u)
    assert.equal(body.n, 1)
    assert.equal(body.output_format, 'png')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('多张候选拆成独立请求，确保每张都有对应输出', async () => {
  const originalFetch = globalThis.fetch
  let requestCount = 0
  let activeRequests = 0
  let maximumActiveRequests = 0
  globalThis.fetch = async () => {
    requestCount += 1
    activeRequests += 1
    maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests)
    await new Promise((resolve) => setTimeout(resolve, 5))
    activeRequests -= 1
    return new Response(JSON.stringify({
      data: [{ b64_json: 'iVBORw0KGgo=' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const result = await generateImages({
      id: 'job-a',
      kind: 'refinement',
      refinementMode: 'faithful',
      batchCount: 2,
      prompt: '保持商品主体，探索不同构图',
      settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '1K' },
      references: [{ name: '主商品', role: '商品', primary: true, mimeType: 'image/png', buffer: Buffer.from('reference') }],
      parent: { name: '父版本', mimeType: 'image/png', buffer: Buffer.from('parent') },
    }, {
      apiBaseUrl: 'https://example.test',
      apiKey: 'test-key',
      jobId: 'job-a',
      variantConcurrency: 2,
      persistImage: async (value) => value.dataUrl,
    })
    assert.equal(result.outputs.length, 2)
    assert.deepEqual(result.outputs.map((output) => output.id), ['job-a-output-1', 'job-a-output-2'])
    assert.equal(requestCount, 2)
    assert.equal(maximumActiveRequests, 2)
    assert.equal(result.missingOutputCount, 0)
    assert.equal(result.partialError, undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('供应商网络中断会返回可操作的中文错误，而不是暴露 Failed to fetch', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch') }
  try {
    await assert.rejects(generateImages({
      id: 'job-network-error',
      kind: 'generation',
      batchCount: 1,
      prompt: '香氛商品主图',
      settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '1K' },
      references: [{ name: '主商品', role: '商品', primary: true, mimeType: 'image/png', buffer: Buffer.from('reference') }],
    }, {
      apiBaseUrl: 'https://example.test',
      apiKey: 'test-key',
      jobId: 'job-network-error',
      persistImage: async (value) => value.dataUrl,
    }), (error) => error instanceof GenerationError
      && error.code === 'PROVIDER_UNAVAILABLE'
      && error.message === '图像服务连接中断，请稍后重试。')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('局部重绘蒙版：PNG 进校验并随任务展平，非 PNG 与不支持的模型被拒', async () => {
  const jpegMask = 'data:image/jpeg;base64,/9j/4AAQ'
  const base = {
    projectId: 'project-a', kind: 'refinement', prompt: '只替换背景为海边', batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '1K' },
    parent: { name: '父版本', dataUrl: image },
  }
  const context = { models: ['gpt-image-2'], maximumBatchCount: 8, maximumReferenceBytes: 1024 }

  const input = validateGenerationInput({
    ...base,
    recipe: { references: [], mask: { dataUrl: image } },
  }, context)
  assert.equal(input.mask.mimeType, 'image/png')

  assert.throws(() => validateGenerationInput({
    ...base,
    recipe: { references: [], mask: { dataUrl: jpegMask } },
  }, context), (error) => error instanceof GenerationError && error.code === 'INVALID_MASK')

  assert.throws(() => validateGenerationInput({
    ...base,
    settings: { model: 'image-01', aspectRatio: '3:4', resolution: '1K' },
    recipe: { references: [], mask: { dataUrl: image } },
  }, {
    ...context,
    models: [{ id: 'image-01', mediaKind: 'image', aspectRatios: ['3:4'], resolutions: ['1K'] }],
  }), (error) => error instanceof GenerationError && error.code === 'INVALID_MASK')
})

test('mediaId 蒙版在 Worker 解析后仍必须是 PNG', async () => {
  const input = validateGenerationInput({
    projectId: 'project-a', kind: 'refinement', prompt: '只替换背景', batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '1K' },
    parent: { name: '父版本', dataUrl: image },
    recipe: { references: [], mask: { mediaId: 'media_mask-1' } },
  }, { models: ['gpt-image-2'], maximumBatchCount: 8, maximumReferenceBytes: 1024 })
  assert.equal(input.mask.mediaId, 'media_mask-1')

  const resolved = await resolveGenerationInputMedia(input, async () => ({ mimeType: 'image/png', buffer: Buffer.from('mask') }))
  assert.equal(resolved.mask.buffer.toString(), 'mask')

  await assert.rejects(
    resolveGenerationInputMedia(input, async () => ({ mimeType: 'image/jpeg', buffer: Buffer.from('mask') })),
    (error) => error instanceof GenerationError && error.code === 'INVALID_MASK',
  )
})

test('带蒙版的任务把 mask 作为独立表单字段发给 images/edits', async () => {
  const originalFetch = globalThis.fetch
  const forms = []
  globalThis.fetch = async (_url, init) => {
    forms.push(init.body)
    return new Response(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgo=' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
  try {
    await generateImages({
      id: 'job-mask',
      kind: 'refinement',
      refinementMode: 'faithful',
      batchCount: 1,
      prompt: '只重绘蒙版区域为盛开花丛',
      settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '1K' },
      references: [],
      parent: { name: '父版本', mimeType: 'image/png', buffer: Buffer.from('parent') },
      mask: { mimeType: 'image/png', buffer: Buffer.from('mask-bytes') },
    }, {
      apiBaseUrl: 'https://example.test',
      apiKey: 'test-key',
      jobId: 'job-mask',
      persistImage: async (value) => value.dataUrl,
    })
    const mask = forms[0].get('mask')
    assert.ok(mask)
    assert.equal(mask.type, 'image/png')
    assert.equal(Buffer.from(await mask.arrayBuffer()).toString(), 'mask-bytes')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('多图合成时标识参考排在人像之后发给 images/edits', async () => {
  const originalFetch = globalThis.fetch
  const forms = []
  globalThis.fetch = async (_url, init) => {
    forms.push(init.body)
    return new Response(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgo=' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
  try {
    await generateImages({
      id: 'job-compose',
      kind: 'generation',
      batchCount: 1,
      prompt: '勋章图案严格还原文字标识。',
      settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
      references: [
        { name: 'logo-full 2', role: '参考', mimeType: 'image/png', buffer: Buffer.from('logo-bytes') },
        { name: '棚拍人像', role: '模特', mimeType: 'image/png', buffer: Buffer.from('portrait-bytes') },
      ],
    }, {
      apiBaseUrl: 'https://example.test',
      apiKey: 'test-key',
      jobId: 'job-compose',
      persistImage: async (value) => value.dataUrl,
    })
    const images = forms[0].getAll('image[]')
    assert.equal(images.length, 2)
    assert.equal(images[0].name, 'reference-1.png')
    assert.equal(Buffer.from(await images[0].arrayBuffer()).toString(), 'portrait-bytes')
    assert.equal(Buffer.from(await images[1].arrayBuffer()).toString(), 'logo-bytes')
    assert.match(forms[0].get('prompt'), /GPT Image 多图编辑/)
    assert.match(forms[0].get('prompt'), /必须忠实复原/)
    assert.equal(forms[0].get('quality'), 'high')
    assert.equal(forms[0].has('input_fidelity'), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('选区矩形在 Worker 落成与基准图同尺寸的 PNG 蒙版', async () => {
  const { buildRegionMaskPng } = await import('./regionMaskPng.mjs')
  const { imagePixelSize } = await import('./mediaFormats.mjs')
  const parentPng = buildRegionMaskPng({ width: 20, height: 10 }, { x: 0, y: 0, width: 1, height: 1 })
  const input = validateGenerationInput({
    projectId: 'project-a', kind: 'refinement', prompt: '只把右半边换成夜景', batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '1K' },
    parent: { name: '父版本', mediaId: 'media_parent-1' },
    recipe: { references: [], maskRegion: { x: 0.5, y: 0, width: 0.5, height: 1 } },
  }, { models: ['gpt-image-2'], maximumBatchCount: 8, maximumReferenceBytes: 4096 })
  assert.deepEqual(input.maskRegion, { x: 0.5, y: 0, width: 0.5, height: 1 })
  assert.equal(input.mask, undefined)

  const resolved = await resolveGenerationInputMedia(input, async () => ({ mimeType: 'image/png', buffer: parentPng }))
  assert.deepEqual(imagePixelSize(resolved.mask.buffer), { width: 20, height: 10 })

  // 过小或非法选区在校验阶段就被拒绝。
  assert.throws(() => validateGenerationInput({
    projectId: 'project-a', kind: 'refinement', prompt: 'x', batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '1K' },
    parent: { name: '父版本', dataUrl: image },
    recipe: { references: [], maskRegion: { x: 0.9, y: 0.9, width: 0.005, height: 0.005 } },
  }, { models: ['gpt-image-2'], maximumBatchCount: 8, maximumReferenceBytes: 1024 }), (error) => error instanceof GenerationError && error.code === 'INVALID_MASK')
})
