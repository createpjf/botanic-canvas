import assert from 'node:assert/strict'
import test from 'node:test'
import { generateImages, GenerationError, resolveGenerationInputMedia, validateGenerationInput } from './generationProvider.mjs'

const image = 'data:image/png;base64,iVBORw0KGgo='

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

test('多张候选拆成独立请求，确保每张都有对应输出', async () => {
  const originalFetch = globalThis.fetch
  let requestCount = 0
  globalThis.fetch = async () => {
    requestCount += 1
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
      persistImage: async (value) => value.dataUrl,
    })
    assert.equal(result.outputs.length, 2)
    assert.deepEqual(result.outputs.map((output) => output.id), ['job-a-output-1', 'job-a-output-2'])
    assert.equal(requestCount, 2)
    assert.equal(result.missingOutputCount, 0)
    assert.equal(result.partialError, undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
})
