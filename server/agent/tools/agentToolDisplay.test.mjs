import assert from 'node:assert/strict'
import test from 'node:test'
import { safeAgentToolDisplayValue } from './agentToolDisplay.mjs'

test('Tool Activity 参数与输出保留结构，同时脱敏并限制大小', () => {
  const cyclic = { ok: true }
  cyclic.self = cyclic
  const safe = safeAgentToolDisplayValue({
    prompt: '夏日海边',
    apiKey: 'provider-secret',
    authorization: 'Bearer abcdefghijklmnopqrst',
    imageBytes: 'raw-media',
    reasoning_content: 'hidden chain',
    url: 'https://example.com/a?signature=private-signature&size=large',
    callback() {},
    cyclic,
  })
  const serialized = JSON.stringify(safe)
  const bounded = safeAgentToolDisplayValue({
    wide: Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`field${index}`, 'x'.repeat(2_000)])),
  })

  assert.equal(safe.prompt, '夏日海边')
  assert.equal(safe.apiKey, '[REDACTED]')
  assert.equal(safe.imageBytes, '[REDACTED_MEDIA]')
  assert.equal(safe.reasoning_content, '[REDACTED_REASONING]')
  assert.equal(safe.cyclic.self, '[CIRCULAR]')
  assert.equal(safe.url, '[REDACTED_URL]')
  assert.equal(safe.callback, '[UNSUPPORTED]')
  assert.doesNotMatch(serialized, /provider-secret|private-signature|hidden chain|raw-media/u)
  assert.ok(JSON.stringify(bounded).length <= 12_000)
  assert.equal(safeAgentToolDisplayValue(Object.defineProperty({}, 'broken', { enumerable: true, get() { throw new Error('boom') } })), '[UNAVAILABLE]')
})
