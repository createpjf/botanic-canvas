import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentCompatibilityTurn } from './agentCompatibilityTurn.mjs'

function httpStubs() {
  return {
    request: { once() {}, off() {}, aborted: false, headers: {} },
    response: { once() {}, off() {}, destroyed: false, writableEnded: false },
  }
}

function stubSubmission(captured) {
  const durableTurn = {
    id: 'turn-1', projectId: 'project-1', ownerId: 'user-1',
    idempotencyKey: 'key-1', status: 'succeeded', createdAt: 1, updatedAt: 2,
    result: { kind: 'chat', runtimeOperation: 'chat', response: { reply: 'ok' } },
  }
  return () => ({
    submit: (command) => {
      captured.push(command)
      return {
        turnId: durableTurn.id,
        accepted: Promise.resolve(durableTurn),
        execution: Promise.resolve({ turn: durableTurn, result: durableTurn.result }),
      }
    },
  })
}

test('兼容 Turn 注入 enricher 时 resolveOptions 带同一实例；未配置则不出现该键', async () => {
  const enricher = async () => ({ content: 'x', source: 'deterministic' })
  const base = {
    config: {},
    productStore: {},
    durableSubagentRunner: undefined,
    observeAgentContext: () => {},
    persistUsageAnchor: () => async () => {},
  }
  const runCase = async (enrichAgentContextCheckpoint) => {
    const captured = []
    const execute = createAgentCompatibilityTurn({
      ...base,
      turnSubmission: stubSubmission(captured),
      ...(enrichAgentContextCheckpoint ? { enrichAgentContextCheckpoint } : {}),
    })
    const { request, response } = httpStubs()
    const outcome = await execute({
      operation: 'chat',
      request,
      response,
      user: { id: 'user-1' },
      projectId: 'project-1',
      requestId: 'request-1',
      idempotencyKey: 'key-1',
      input: { mode: 'conversation', projectId: 'project-1' },
      resolveOptions: {},
    })
    assert.equal(outcome.body.response.reply, 'ok')
    return captured[0].resolveOptions
  }
  const withEnricher = await runCase(enricher)
  assert.equal(withEnricher.enrichAgentContextCheckpoint, enricher)
  const withoutEnricher = await runCase(undefined)
  assert.equal('enrichAgentContextCheckpoint' in withoutEnricher, false)
})
