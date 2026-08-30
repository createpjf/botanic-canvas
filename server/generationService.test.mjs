import assert from 'node:assert/strict'
import test from 'node:test'
import { generateMedia } from './generationService.mjs'
import { encodeRgbaPng } from './imageOverlay.mjs'

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
