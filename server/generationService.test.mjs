import assert from 'node:assert/strict'
import test from 'node:test'
import jpeg from 'jpeg-js'
import { generateMedia } from './generationService.mjs'
import { gptImage2CustomSizeLimits } from './generationOutputSize.mjs'
import { encodeRgbaPng } from './imageOverlay.mjs'
import { imagePixelSize } from './mediaFormats.mjs'

function solidPng(width, height, rgba) {
  const pixels = Buffer.alloc(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    pixels.set(rgba, index * 4)
  }
  return encodeRgbaPng({ width, height, rgba: pixels })
}

test('显式 overlay 贴标识走像素合成，不调用 OpenAI', async () => {
  const result = await generateMedia({
    prompt: '添加flock.io的logo',
    composeMode: 'overlay',
    batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K' },
    maskRegion: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 },
    parent: { name: '人像', mimeType: 'image/png', buffer: solidPng(8, 8, [12, 12, 12, 255]) },
    references: [{ name: 'logo-full 2', mimeType: 'image/png', buffer: solidPng(4, 4, [0, 200, 0, 255]) }],
  }, {
    config: { models: ['gpt-image-2'], apiKey: 'must-not-be-used' },
    jobId: 'job-overlay-gate',
    persistImage: async (image) => image.dataUrl,
  })
  assert.equal(result.outputs[0].id, 'job-overlay-gate-output-1')
  assert.match(result.outputs[0].image, /^data:image\/png;base64,/)
})

test('Flock 模型走 flock Adapter，未配置密钥时失败可见', async () => {
  await assert.rejects(() => generateMedia({
    prompt: '海边主视觉',
    batchCount: 1,
    settings: { model: 'gemini-3.1-flash-image-preview', aspectRatio: '3:4', resolution: '2K' },
  }, {
    config: {
      modelOptions: [{ id: 'gemini-3.1-flash-image-preview', provider: 'flock', mediaKind: 'image' }],
      flockApiBaseUrl: 'https://api.flock.io/v1',
    },
    jobId: 'job-flock-route',
    persistImage: async () => '/x',
  }), (error) => error.code === 'PROVIDER_NOT_CONFIGURED')
})

test('GPT 提交前把手机原图归一到供应商像素窗', async () => {
  const source = jpeg.encode({
    width: 4032,
    height: 3024,
    data: Buffer.alloc(4032 * 3024 * 4, 160),
  }, 80).data
  const output = solidPng(2, 2, [12, 34, 56, 255])
  const originalFetch = globalThis.fetch
  let submittedImage
  globalThis.fetch = async (_url, init) => {
    submittedImage = init.body.get('image[]')
    return new Response(JSON.stringify({ data: [{ b64_json: output.toString('base64') }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    await generateMedia({
      prompt: '保留商品，换成海边背景',
      batchCount: 1,
      settings: { model: 'gpt-image-2', aspectRatio: '16:9', resolution: '1K' },
      references: [{ name: '手机照片', mimeType: 'image/jpeg', buffer: source }],
    }, {
      config: { models: ['gpt-image-2'], apiBaseUrl: 'https://images.test', apiKey: 'test-key' },
      jobId: 'job-phone-photo',
      persistImage: async (image) => image.dataUrl,
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.ok(submittedImage instanceof Blob)
  const size = imagePixelSize(Buffer.from(await submittedImage.arrayBuffer()))
  assert.ok(size)
  assert.ok(size.width * size.height <= gptImage2CustomSizeLimits.maxPixels)
})
