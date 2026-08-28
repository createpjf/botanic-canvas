import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AgentProviderContextOverflowError,
  throwIfAgentProviderContextOverflow,
} from './agentProviderContextOverflow.mjs'

test('仅归一明确的 400/413/422 context overflow', () => {
  for (const status of [400, 413, 422]) {
    assert.throws(
      () => throwIfAgentProviderContextOverflow(status, JSON.stringify({
        error: { code: 'context_length_exceeded', message: 'maximum context length exceeded' },
      })),
      (error) => error instanceof AgentProviderContextOverflowError
        && error.code === 'AGENT_CONTEXT_OVERFLOW'
        && error.statusCode === 422,
    )
  }

  for (const [status, body] of [
    [401, 'maximum context length exceeded'],
    [429, 'prompt is too long'],
    [500, 'context_length_exceeded'],
    [400, 'invalid request'],
    [413, 'uploaded file is too large'],
  ]) {
    assert.doesNotThrow(() => throwIfAgentProviderContextOverflow(status, body))
  }
})

test('只检查正文前 16k，抛出的错误绝不保留 Provider body', () => {
  const secret = 'provider-secret-body'
  assert.doesNotThrow(() => throwIfAgentProviderContextOverflow(
    400,
    `${'x'.repeat(16_000)} maximum context length exceeded`,
  ))

  let caught
  try {
    throwIfAgentProviderContextOverflow(422, `prompt is too long ${secret}`)
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof AgentProviderContextOverflowError)
  assert.equal('body' in caught, false)
  assert.equal('cause' in caught, false)
  assert.doesNotMatch(JSON.stringify(caught), new RegExp(secret, 'u'))
  assert.doesNotMatch(String(caught.stack), new RegExp(secret, 'u'))
})
