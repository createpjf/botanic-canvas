import assert from 'node:assert/strict'
import test from 'node:test'
import { generateImages, GenerationError, persistedGenerationJob, publicGenerationJob, resolveGenerationInputMedia, validateGenerationInput } from './generationProvider.mjs'

const image = 'data:image/png;base64,iVBORw0KGgo='

/**
 * 构造 PNG 文件头包含指定尺寸。用于测试像素校验。
 */
function pngOfSize(width, height) {
  const buffer = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'ascii')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

test('生成任务持久化保留幂等键，公开状态只按需返回提交者幂等键', () => {
  const job = {
    id: 'job-agent', ownerId: 'user-a', projectId: 'project-a', status: 'queued', kind: 'generation',
    createdAt: 1, updatedAt: 1, batchCount: 1, settings: { model: 'gpt-image-2' }, outputs: [],
    rawInput: { projectId: 'project-a' }, agentRun: { runId: 'run-a', branchId: 'branch-a' },
    promptNodeId: 'prompt-a', generateNodeId: 'generate-a', resultNodeId: 'result-a', parentNodeId: 'parent-a',
    idempotencyKey: 'gen_test_key_123456', projectWritebackPending: true,
    executionVersion: 2,
    execution: { generation: 2, leaseToken: 'private-lease', leaseExpiresAt: 99 },
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
  assert.deepEqual(persistedGenerationJob(job).execution, job.execution)
  assert.equal(persistedGenerationJob(job).executionVersion, 2)
  assert.equal(publicGenerationJob(job).execution, undefined)
  assert.equal(publicGenerationJob(job).executionVersion, undefined)
  assert.equal(JSON.stringify(publicGenerationJob(job)).includes('private-lease'), false)
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

test('参考图像素超上限时被拒，理由是像素总数而不是长边', async () => {
  const { resolveGenerationInputMedia, GenerationError } = await import('./generationProvider.mjs')
  const { imagePixelSize, MEDIA_LIMITS } = await import('./mediaFormats.mjs')

  // 5000×4000 = 20 MP，超过 4096×4096 接收预算。12.2 MP 的 iPhone 原图现在
  // 低于 Nano Banana 4K 方图，必须能被重新接收，不能再当超限夹具。
  const oversized = pngOfSize(5000, 4000)
  assert.deepEqual(imagePixelSize(oversized), { width: 5000, height: 4000 })

  const input = {
    references: [{ mediaId: 'media_oversized', mediaKind: 'image' }],
    parent: undefined,
    mask: undefined,
  }
  const resolveMedia = async () => ({ mimeType: 'image/png', buffer: oversized })

  await assert.rejects(
    () => resolveGenerationInputMedia(input, resolveMedia),
    (error) => {
      assert.ok(error instanceof GenerationError)
      assert.equal(error.code, 'IMAGE_TOO_LARGE_PIXELS')
      // 必须报出实际尺寸和真正被违反的上限（像素总数），而不是转述供应商英文。
      assert.match(error.message, /5000×4000/)
      assert.match(error.message, new RegExp(String(Math.round(MEDIA_LIMITS.maxCanonicalPixels / 10_000))))
      // 拒绝判据只看像素总数：文案不能再指向长边，那不是这条规则判的。
      assert.doesNotMatch(error.message, /长边/)
      return true
    },
  )
})

test('像素在上限内的参考图正常通过', async () => {
  const { resolveGenerationInputMedia } = await import('./generationProvider.mjs')
  // 1280×1707 = 2.2 MP，生产上实测通过的那张。
  const ok = pngOfSize(1280, 1707)
  const resolved = await resolveGenerationInputMedia(
    { references: [{ mediaId: 'media_ok', mediaKind: 'image' }] },
    async () => ({ mimeType: 'image/png', buffer: ok }),
  )
  assert.equal(resolved.references.length, 1)
  assert.equal(resolved.references[0].mimeType, 'image/png')
})

test('App 自己能生成的尺寸必须能被重新接收：2K、8.29MP 自定义窗与 4K 方图', async () => {
  const { resolveGenerationInputMedia } = await import('./generationProvider.mjs')

  // 2048×2048 = 4.19 MP：2K + 1:1 目录预设，也是默认分辨率（见
  // CanvasWorkspace.tsx）。精修 / 局部重绘会把上一次生成结果原样传回来当
  // parent —— 旧的「长边 ≤ 2048」判据会把这个尺寸自己拒了，且长边已经是
  // 2048，用户没有任何能做的下一步。这条是那次生产 bug 的回归钉子。
  const square2K = pngOfSize(2048, 2048)
  const resolvedSquare = await resolveGenerationInputMedia(
    { references: [{ mediaId: 'media_2k_square', mediaKind: 'image' }] },
    async () => ({ mimeType: 'image/png', buffer: square2K }),
  )
  assert.equal(resolvedSquare.references.length, 1)

  // 3840×2160 = 8.29 MP：落在 gpt-image-2 自定义尺寸窗内。
  const wide = pngOfSize(3840, 2160)
  const resolvedWide = await resolveGenerationInputMedia(
    { references: [{ mediaId: 'media_wide', mediaKind: 'image' }] },
    async () => ({ mimeType: 'image/png', buffer: wide }),
  )
  assert.equal(resolvedWide.references.length, 1)

  // 4096×4096 = 16.78 MP：Nano Banana 4K 方图，必须能被重新接收。
  const square4K = pngOfSize(4096, 4096)
  const resolved4K = await resolveGenerationInputMedia(
    { references: [{ mediaId: 'media_4k_square', mediaKind: 'image' }] },
    async () => ({ mimeType: 'image/png', buffer: square4K }),
  )
  assert.equal(resolved4K.references.length, 1)

  // 4032×3024 = 12.2 MP：曾经当超限夹具的 iPhone 原图，现在低于 4K 接收预算。
  const iphone = pngOfSize(4032, 3024)
  const resolvedIphone = await resolveGenerationInputMedia(
    { references: [{ mediaId: 'media_iphone', mediaKind: 'image' }] },
    async () => ({ mimeType: 'image/png', buffer: iphone }),
  )
  assert.equal(resolvedIphone.references.length, 1)
})

test('读不出尺寸时不拦', async () => {
  // 尺寸读不出来不代表超限。拦住它会把一类正常输入误杀。
  const { resolveGenerationInputMedia } = await import('./generationProvider.mjs')
  const opaque = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(40)])
  const resolved = await resolveGenerationInputMedia(
    { references: [{ mediaId: 'media_opaque', mediaKind: 'image' }] },
    async () => ({ mimeType: 'image/jpeg', buffer: opaque }),
  )
  assert.equal(resolved.references.length, 1)
})

test('供应商拒绝时不把英文原文转述给用户，但日志留得住', async () => {
  const { providerRejectionError } = await import('./generationProvider.mjs')
  const upstream = 'Invalid image file or mode for image 1, please check your image file. '
    + 'If you believe this is an error, contact us at help.openai.com and include the request ID req_abc'
  const error = providerRejectionError(upstream, 'req_abc123')

  assert.equal(error.code, 'PROVIDER_REJECTED')
  // 用户不该被指去联系供应商 —— 他既不是客户，也无从判断该说什么。
  assert.doesNotMatch(error.message, /help\.openai\.com/)
  assert.doesNotMatch(error.message, /contact us/i)
  // 但要给可执行的下一步，和一个能对上日志的请求号。
  assert.match(error.message, /req_abc123/)
  assert.match(error.message, /提示词|参考素材|输出规格/)
  // 原文必须留在结构化字段里，运维要靠它诊断。
  assert.equal(error.upstreamMessage, upstream)
})

test('没有上游原文时也给得出可执行的话', async () => {
  const { providerRejectionError } = await import('./generationProvider.mjs')
  const error = providerRejectionError(undefined, undefined)
  assert.equal(error.code, 'PROVIDER_REJECTED')
  assert.match(error.message, /提示词|参考素材|输出规格/)
  assert.equal(error.upstreamMessage, undefined)
})

test('dataUrl 参考图像素超上限时被拒', async () => {
  // dataUrl 路径在 validateGenerationInput 时已填充 buffer，直接进 resolve 的早期分支。
  // 若不加像素守卫，超过接收预算的参考会原样通过。
  const { resolveGenerationInputMedia, GenerationError } = await import('./generationProvider.mjs')
  const { imagePixelSize, MEDIA_LIMITS } = await import('./mediaFormats.mjs')

  const oversized = pngOfSize(5000, 4000)
  assert.deepEqual(imagePixelSize(oversized), { width: 5000, height: 4000 })

  const input = {
    references: [{ buffer: oversized, mimeType: 'image/png', mediaKind: 'image' }],
    parent: undefined,
    mask: undefined,
  }

  await assert.rejects(
    () => resolveGenerationInputMedia(input, async () => { throw new Error('should not be called') }),
    (error) => {
      assert.ok(error instanceof GenerationError)
      assert.equal(error.code, 'IMAGE_TOO_LARGE_PIXELS')
      assert.match(error.message, /5000×4000/)
      assert.match(error.message, new RegExp(String(Math.round(MEDIA_LIMITS.maxCanonicalPixels / 10_000))))
      assert.doesNotMatch(error.message, /长边/)
      return true
    },
  )
})

test('dataUrl 父版本图像素超上限时被拒', async () => {
  // 精修任务会从客户端拿 parent，也走 dataUrl 路径。
  const { resolveGenerationInputMedia, GenerationError } = await import('./generationProvider.mjs')
  const { imagePixelSize, MEDIA_LIMITS } = await import('./mediaFormats.mjs')

  const oversized = pngOfSize(5000, 4000)
  assert.deepEqual(imagePixelSize(oversized), { width: 5000, height: 4000 })

  const input = {
    references: [],
    parent: { buffer: oversized, mimeType: 'image/png', mediaKind: 'image' },
    mask: undefined,
  }

  await assert.rejects(
    () => resolveGenerationInputMedia(input, async () => { throw new Error('should not be called') }),
    (error) => {
      assert.ok(error instanceof GenerationError)
      assert.equal(error.code, 'IMAGE_TOO_LARGE_PIXELS')
      assert.match(error.message, /5000×4000/)
      assert.match(error.message, new RegExp(String(Math.round(MEDIA_LIMITS.maxCanonicalPixels / 10_000))))
      assert.doesNotMatch(error.message, /长边/)
      return true
    },
  )
})

test('提交时携带 dataUrl 的超限参考图在 validateGenerationInput 阶段就被拒，不必等 Worker 才发现', () => {
  // 像素守卫原本只在 Worker 侧的 resolveGenerationInputMedia 里跑；dataUrl 提交在
  // validateGenerationInput 阶段就已经解出 buffer，能在这里查就不该拖到 Worker 才建一个
  // 注定失败的 Job。这条测试锁的是提交阶段的行为，上面几条锁的是 Worker 侧的兜底。
  const oversizedDataUrl = `data:image/png;base64,${pngOfSize(5000, 4000).toString('base64')}`
  assert.throws(() => validateGenerationInput({
    projectId: 'project-a', kind: 'generation', prompt: '香氛商品主图', batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '1K' },
    recipe: { references: [{ name: '主商品', dataUrl: oversizedDataUrl }] },
  }, { models: ['gpt-image-2'], maximumBatchCount: 8, maximumReferenceBytes: 1024 * 1024 }),
  (error) => error instanceof GenerationError && error.code === 'IMAGE_TOO_LARGE_PIXELS')
})

test('提交时携带 dataUrl 的超限父版本图在 validateGenerationInput 阶段就被拒', () => {
  const oversizedDataUrl = `data:image/png;base64,${pngOfSize(5000, 4000).toString('base64')}`
  assert.throws(() => validateGenerationInput({
    projectId: 'project-a', kind: 'refinement', prompt: '换背景', batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '1K' },
    parent: { name: '父版本', dataUrl: oversizedDataUrl },
    recipe: { references: [] },
  }, { models: ['gpt-image-2'], maximumBatchCount: 8, maximumReferenceBytes: 1024 * 1024 }),
  (error) => error instanceof GenerationError && error.code === 'IMAGE_TOO_LARGE_PIXELS')
})

test('提交时携带 dataUrl 的超限局部重绘蒙版在 validateGenerationInput 阶段就被拒', () => {
  const oversizedDataUrl = `data:image/png;base64,${pngOfSize(5000, 4000).toString('base64')}`
  assert.throws(() => validateGenerationInput({
    projectId: 'project-a', kind: 'refinement', prompt: '只重绘选区为夜景', batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '1K' },
    parent: { name: '父版本', dataUrl: image },
    recipe: { references: [], mask: { dataUrl: oversizedDataUrl } },
  }, { models: ['gpt-image-2'], maximumBatchCount: 8, maximumReferenceBytes: 1024 * 1024 }),
  (error) => error instanceof GenerationError && error.code === 'IMAGE_TOO_LARGE_PIXELS')
})

test('mediaId 提交阶段没有字节可查，像素守卫仍只能留给 Worker 侧兜底——预期的不对称，不是遗漏', () => {
  const input = validateGenerationInput({
    projectId: 'project-a', kind: 'generation', prompt: '香氛商品主图', batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '1K' },
    recipe: { references: [{ name: '主商品', mediaId: 'media_oversized-1' }] },
  }, { models: ['gpt-image-2'], maximumBatchCount: 8, maximumReferenceBytes: 1024 })
  assert.equal(input.references[0].mediaId, 'media_oversized-1')
  assert.equal(input.references[0].buffer, undefined)
})

test('无 parent 且标识参考排在首位时，蒙版按重排后的底图定尺寸', async () => {
  // 缺陷：物化点按 references[0] 定尺寸，而供应商收到的首图是
  // orderCompositionReferences 重排后的 —— 标识图会被挪到队尾。
  // 两者不一致时，发出去的是「蒙版尺寸 ≠ image[]#1 尺寸」这对无效组合。
  const { validateGenerationInput, resolveGenerationInputMedia } = await import('./generationProvider.mjs')
  const { imagePixelSize } = await import('./mediaFormats.mjs')
  const { regionMaskAlphaAt } = await import('./regionMaskPng.mjs')

  const references = [
    { name: '品牌 Logo.png', mediaId: 'media_logo' },      // 命中标识正则，会被排到队尾
    { name: '棚拍人像', mediaId: 'media_portrait' },        // 真正的底图
  ]
  const input = validateGenerationInput({
    projectId: 'project-mask-order',
    kind: 'generation',                                    // 不能是 refinement：那会在 :251 要求 parent
    prompt: '把右半边换成纯色',
    batchCount: 1,                                         // 注意：batchCount 在 body 顶层，不在 recipe 里
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
    recipe: { references, maskRegion: { x: 0.5, y: 0, width: 0.5, height: 1 } },
  }, {
    models: [{ id: 'gpt-image-2', provider: 'openai', mediaKind: 'image', aspectRatios: ['1:1'], resolutions: ['1K'], supportsMask: true }],
    maximumBatchCount: 4,
    maximumReferenceBytes: 8 * 1024 * 1024,
  })

  // 按 mediaId 分发不同尺寸 —— 常量返回会让两张图尺寸相同，测试永远绿。
  const bytes = { media_logo: pngOfSize(64, 64), media_portrait: pngOfSize(20, 10) }
  const resolved = await resolveGenerationInputMedia(input, async (mediaId) => ({
    mimeType: 'image/png',
    buffer: bytes[mediaId],
  }))

  // 主观察点：蒙版尺寸必须取自人像（20×10），不是 Logo（64×64）。
  assert.deepEqual(imagePixelSize(resolved.mask.buffer), { width: 20, height: 10 })
  // 辅观察点：右半透明（重绘）、左半不透明（保持）。
  // 正确基准宽 20，右半从 x=10 起，列 15 应透明；错误基准宽 64，右半从 x=32 起，列 15 会是不透明。
  assert.equal(regionMaskAlphaAt(resolved.mask.buffer, 15, 0), 0)
  assert.equal(regionMaskAlphaAt(resolved.mask.buffer, 5, 0), 255)
})

test('标识参考不在首位时行为不变', async () => {
  // 守护用例：修复前后恒绿，锁住 orderCompositionReferences 的稳定分桶 ——
  // 底图本来就在队首时，重排不该改变任何东西。
  const { validateGenerationInput, resolveGenerationInputMedia } = await import('./generationProvider.mjs')
  const { imagePixelSize } = await import('./mediaFormats.mjs')

  const references = [
    { name: '棚拍人像', mediaId: 'media_portrait' },
    { name: '品牌 Logo.png', mediaId: 'media_logo' },
  ]
  const input = validateGenerationInput({
    projectId: 'project-mask-order-2',
    kind: 'generation',
    prompt: '把右半边换成纯色',
    batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
    recipe: { references, maskRegion: { x: 0.5, y: 0, width: 0.5, height: 1 } },
  }, {
    models: [{ id: 'gpt-image-2', provider: 'openai', mediaKind: 'image', aspectRatios: ['1:1'], resolutions: ['1K'], supportsMask: true }],
    maximumBatchCount: 4,
    maximumReferenceBytes: 8 * 1024 * 1024,
  })

  const bytes = { media_logo: pngOfSize(64, 64), media_portrait: pngOfSize(20, 10) }
  const resolved = await resolveGenerationInputMedia(input, async (mediaId) => ({
    mimeType: 'image/png',
    buffer: bytes[mediaId],
  }))
  assert.deepEqual(imagePixelSize(resolved.mask.buffer), { width: 20, height: 10 })
})

test('蒙版尺寸必须与提交给供应商的第一张图相匹配', async () => {
  // 交叉测试：确保 resolveGenerationInputMedia 与 generateImages 对「首张输入图」
  // 的理解同源。都调用 providerInputImages，防止后续对参考排序的改动导致错配。
  // 这是对 orderCompositionReferences 变化的早期预警 —— 任何改动都会同时违反
  // 蒙版与供应商两侧的断言。
  const { validateGenerationInput, resolveGenerationInputMedia, generateImages } = await import('./generationProvider.mjs')
  const { imagePixelSize } = await import('./mediaFormats.mjs')

  const references = [
    { name: '品牌 Logo.png', mediaId: 'media_logo' },      // 标识图，会被排到队尾
    { name: '棚拍人像', mediaId: 'media_portrait' },        // 真正的底图
  ]
  const input = validateGenerationInput({
    projectId: 'project-crossing-test',
    kind: 'generation',
    prompt: '把右半边换成纯色',
    batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
    recipe: { references, maskRegion: { x: 0.5, y: 0, width: 0.5, height: 1 } },
  }, {
    models: [{ id: 'gpt-image-2', provider: 'openai', mediaKind: 'image', aspectRatios: ['1:1'], resolutions: ['1K'], supportsMask: true }],
    maximumBatchCount: 4,
    maximumReferenceBytes: 8 * 1024 * 1024,
  })

  const bytes = { media_logo: pngOfSize(64, 64), media_portrait: pngOfSize(20, 10) }
  const resolved = await resolveGenerationInputMedia(input, async (mediaId) => ({
    mimeType: 'image/png',
    buffer: bytes[mediaId],
  }))

  // 捕获 generateImages 实际发往供应商的内容
  const originalFetch = globalThis.fetch
  let capturedForm
  globalThis.fetch = async (_url, init) => {
    capturedForm = init.body
    return new Response(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgo=' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
  try {
    await generateImages(resolved, {
      apiBaseUrl: 'https://example.test',
      apiKey: 'test-key',
      jobId: 'job-crossing',
      persistImage: async (value) => value.dataUrl,
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  // 提取供应商实际收到的蒙版与第一张图
  const maskBlob = capturedForm.get('mask')
  const imageBlobs = capturedForm.getAll('image[]')
  assert.ok(maskBlob, '蒙版应该被提交')
  assert.ok(imageBlobs.length > 0, '至少应该有一张参考图')

  const maskBuffer = Buffer.from(await maskBlob.arrayBuffer())
  const firstImageBuffer = Buffer.from(await imageBlobs[0].arrayBuffer())

  // 主断言：蒙版尺寸必须与第一张图相同
  const maskSize = imagePixelSize(maskBuffer)
  const firstImageSize = imagePixelSize(firstImageBuffer)
  assert.deepEqual(maskSize, firstImageSize, '蒙版尺寸应该与供应商收到的第一张图相同')
  assert.deepEqual(maskSize, { width: 20, height: 10 }, '应该按人像（20×10）而非 Logo（64×64）定尺寸')
})

test('参考上限按模型：gpt-image-2 第 9 张拒，Nano Banana 允许 14', () => {
  const references = Array.from({ length: 9 }, (_, index) => ({
    name: `参考 ${index + 1}`, role: '场景', dataUrl: image,
  }))
  assert.throws(() => validateGenerationInput({
    projectId: 'project-a', kind: 'generation', prompt: '香氛主图', batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
    recipe: { references },
  }, { models: ['gpt-image-2'], maximumBatchCount: 8, maximumReferenceBytes: 1024 }), (error) => (
    error instanceof GenerationError && error.code === 'INVALID_REFERENCE' && /8/.test(error.message)
  ))

  const fourteen = Array.from({ length: 14 }, (_, index) => ({
    name: `参考 ${index + 1}`, role: '场景', dataUrl: image,
  }))
  const input = validateGenerationInput({
    projectId: 'project-a', kind: 'generation', prompt: '香氛主图', batchCount: 1,
    settings: {
      model: 'gemini-3.1-pro-preview', aspectRatio: '21:9', resolution: '4K',
      searchGrounding: true, thinkingLevel: 'high',
    },
    recipe: { references: fourteen },
  }, {
    models: [{
      id: 'gemini-3.1-pro-preview', provider: 'flock', mediaKind: 'image',
      aspectRatios: ['1:1', '16:9', '4:3', '3:4', '4:5', '9:16', '3:2', '2:3', '5:4', '21:9'],
      resolutions: ['1K', '2K', '4K'],
      supportsMask: false,
      supportsSearchGrounding: true,
      thinkingLevels: ['minimal', 'high'],
      maximumReferences: 14,
    }],
    maximumBatchCount: 8,
    maximumReferenceBytes: 1024,
  })
  assert.equal(input.references.length, 14)
  assert.equal(input.settings.aspectRatio, '21:9')
  assert.equal(input.settings.resolution, '4K')
  assert.equal(input.settings.searchGrounding, true)
  assert.equal(input.settings.thinkingLevel, 'high')
})

test('Nano Banana 明确不支持蒙版', () => {
  assert.throws(() => validateGenerationInput({
    projectId: 'project-a', kind: 'generation', prompt: '局部重绘', batchCount: 1,
    settings: { model: 'gemini-3.1-pro-preview', aspectRatio: '3:4', resolution: '2K' },
    recipe: { references: [{ name: '主商品', role: '商品', dataUrl: image }], mask: { dataUrl: image } },
  }, {
    models: [{
      id: 'gemini-3.1-pro-preview', provider: 'flock', mediaKind: 'image',
      aspectRatios: ['1:1', '3:4'], resolutions: ['1K', '2K', '4K'], supportsMask: false,
    }],
    maximumBatchCount: 8,
    maximumReferenceBytes: 1024,
  }), (error) => error instanceof GenerationError && error.code === 'INVALID_MASK')
})
