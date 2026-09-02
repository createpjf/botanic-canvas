import assert from 'node:assert/strict'
import test from 'node:test'
import { downloadSupabaseObject } from './supabaseObjectStore.mjs'

test('Supabase Storage 下载把调用方 signal 传入第三参数', async () => {
  const controller = new AbortController()
  let received
  const result = await downloadSupabaseObject({
    async download(path, options, parameters) {
      received = { path, options, parameters }
      return {
        data: { type: 'image/png', async arrayBuffer() { return Uint8Array.from([1, 2, 3]).buffer } },
        error: null,
      }
    },
  }, 'projects/project-a/media.png', { signal: controller.signal })

  assert.equal(received.path, 'projects/project-a/media.png')
  assert.deepEqual(received.options, {})
  assert.equal(received.parameters.signal, controller.signal)
  assert.deepEqual(result, { body: Buffer.from([1, 2, 3]), contentType: 'image/png' })
})

test('Supabase Storage 下载取消后不进入 arrayBuffer', async () => {
  const controller = new AbortController()
  let arrayBufferCalls = 0
  await assert.rejects(downloadSupabaseObject({
    async download() {
      controller.abort(new Error('cancelled by generation'))
      return {
        data: {
          type: 'image/png',
          async arrayBuffer() { arrayBufferCalls += 1; return new ArrayBuffer(0) },
        },
        error: null,
      }
    },
  }, 'projects/project-a/media.png', { signal: controller.signal }), /cancelled by generation/u)
  assert.equal(arrayBufferCalls, 0)
})
