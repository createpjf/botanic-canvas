import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAgentSubagentTranscript, createAgentSubagentProcessor } from './agentSubagentProcessor.mjs'

function fixture() {
  const descriptor = {
    id: 'subagent-1', ownerId: 'user-1', projectId: 'project-1', sessionId: 'session-subagent-1',
    status: 'active', cancelGeneration: 0, lastEnqueuedSequence: 2, settledThroughSequence: 0,
    outputKind: 'proposal', budget: { maxActivations: 8, maxSteps: 3, maxToolCalls: 4, timeoutMs: 45_000 },
    dispatch: { generation: 2, activationSequence: 1, leaseToken: 'private', leaseExpiresAt: 999 },
  }
  const activation = { id: 'activation-1', sequence: 1, turnId: 'turn-1', cancelGeneration: 0 }
  const turn = {
    id: 'turn-1', ownerId: 'user-1', projectId: 'project-1', sessionId: descriptor.sessionId,
    idempotencyKey: 'turn-key-1', status: 'queued',
    request: { runtimeOperation: 'subagent', input: { inputMessage: { id: 'message-1', content: '先研究品牌' } } },
  }
  return { descriptor, activation, turn }
}

test('Subagent transcript 严格按 activation sequence，而非消息写入时间', () => {
  const transcript = buildAgentSubagentTranscript([
    {
      activation: { id: 'activation-2', sequence: 2, input: { content: '再对比竞品' } },
      turn: { request: { runtimeOperation: 'subagent', input: { inputMessage: { content: '再对比竞品' } } } },
    },
    {
      activation: { id: 'activation-1', sequence: 1 },
      turn: {
        request: { runtimeOperation: 'subagent', input: { inputMessage: { content: '先研究品牌' } } },
        result: { runtimeOperation: 'subagent', output: { summary: '品牌结论' } },
      },
    },
  ], 2)

  assert.deepEqual(transcript, [
    { role: 'user', content: '先研究品牌' },
    { role: 'assistant', content: '{"summary":"品牌结论"}' },
    { role: 'user', content: '再对比竞品' },
  ])
})

test('Processor 双重 claim 后执行 Turn、原子 settle 并立即 handoff 下一 activation', async () => {
  const { descriptor, activation, turn } = fixture()
  let storedTurn = structuredClone(turn)
  const calls = []
  const nextActivation = { id: 'activation-2', sequence: 2, turnId: 'turn-2', cancelGeneration: 0 }
  const productStore = {
    async claimAgentSubagentActivation(command) {
      calls.push(['claim', command])
      return { kind: 'claimed', changed: true, subagent: descriptor, activation, turn }
    },
    async listAgentSubagentActivationsForWorker() {
      return [{ activation, turn }, { activation: nextActivation, turn: {
        request: { runtimeOperation: 'subagent', input: { inputMessage: { content: '继续' } } },
      } }]
    },
    async readAgentTurn() { return structuredClone(storedTurn) },
    async settleAgentSubagentActivation(command) {
      calls.push(['settle', command])
      return {
        kind: 'settled', changed: true,
        subagent: { ...descriptor, settledThroughSequence: 1, dispatch: undefined },
        nextActivation: { activation: nextActivation, turn: { id: 'turn-2' } },
      }
    },
    async readAgentSubagentForWorker() { return descriptor },
  }
  const runnerInputs = []
  const turnRuntime = {
    async execute(input) {
      calls.push(['turn.execute', { id: input.id, request: input.request }])
      const result = await input.resolve({
        signal: new AbortController().signal,
        onEvent() {},
        saveCheckpoint() {},
      })
      storedTurn = { ...storedTurn, status: 'completed', result }
      return { turn: storedTurn, result }
    },
  }
  const enqueued = []
  const processor = createAgentSubagentProcessor({
    productStore,
    turnRuntime,
    leaseTokenFactory: () => 'descriptor-lease-1',
    buildRegistry: async () => ({ registry: true }),
    enqueue: async (identity) => { enqueued.push(identity); return true },
    runSubagent: async (input) => {
      runnerInputs.push(input)
      return { output: { summary: '完成' }, toolCalls: [] }
    },
  })

  assert.deepEqual(await processor({ subagentId: descriptor.id, activationId: activation.id }), {
    kind: 'settled', changed: true, turnStatus: 'completed', handedOff: true,
  })
  assert.equal(runnerInputs.length, 1)
  assert.equal(runnerInputs[0].descriptor.id, descriptor.id)
  assert.deepEqual(runnerInputs[0].messages, [{ role: 'user', content: '先研究品牌' }])
  assert.equal(storedTurn.result.kind, 'subagent_result')
  assert.deepEqual(storedTurn.result.output, { summary: '完成' })
  assert.deepEqual(calls.at(-1)[1], {
    subagentId: 'subagent-1', activationId: 'activation-1', leaseToken: 'descriptor-lease-1',
    executionGeneration: 2, cancelGeneration: 0,
  })
  assert.deepEqual(enqueued, [{ subagentId: 'subagent-1', activationId: 'activation-2' }])
})

test('Provider 失败已由 Turn Runtime durable 收口时仍 settle，BullMQ 不重复调用', async () => {
  const { descriptor, activation, turn } = fixture()
  let storedTurn = structuredClone(turn)
  let settlements = 0
  const productStore = {
    async claimAgentSubagentActivation() { return { kind: 'claimed', subagent: descriptor, activation, turn } },
    async listAgentSubagentActivationsForWorker() { return [{ activation, turn }] },
    async readAgentTurn() { return storedTurn },
    async settleAgentSubagentActivation() { settlements += 1; return { kind: 'settled', changed: true, subagent: { ...descriptor, settledThroughSequence: 1 } } },
    async readAgentSubagentForWorker() { return descriptor },
  }
  const processor = createAgentSubagentProcessor({
    productStore,
    turnRuntime: {
      async execute() {
        storedTurn = { ...storedTurn, status: 'failed', error: { code: 'PROVIDER_FAILED' } }
        throw Object.assign(new Error('provider failed'), { code: 'PROVIDER_FAILED' })
      },
    },
    runSubagent: async () => { throw new Error('not reached') },
  })

  const result = await processor({ subagentId: descriptor.id, activationId: activation.id })
  assert.equal(result.turnStatus, 'failed')
  assert.equal(settlements, 1)
})

test('cancelling descriptor 由专用恢复编排收口，不启动 Provider', async () => {
  const source = fixture()
  const cancelling = {
    ...source.descriptor,
    status: 'cancelling',
    cancellation: { signalId: 'signal-1', generation: 1 },
  }
  let providerCalls = 0
  const converged = []
  const processor = createAgentSubagentProcessor({
    productStore: {
      async claimAgentSubagentActivation() {
        return { kind: 'cancelling', changed: false, subagent: cancelling, activation: source.activation }
      },
      settleAgentSubagentActivation() {},
    },
    turnRuntime: { execute() {} },
    runSubagent: async () => { providerCalls += 1 },
    convergeCancellation: async (descriptor) => {
      converged.push(descriptor.id)
      return { kind: 'finalized', changed: true, subagent: { ...descriptor, status: 'cancelled' } }
    },
  })

  const result = await processor({ subagentId: cancelling.id, activationId: source.activation.id })
  assert.equal(result.kind, 'finalized')
  assert.deepEqual(converged, ['subagent-1'])
  assert.equal(providerCalls, 0)
})

test('Processor 构造与输入均 fail closed', async () => {
  assert.throws(() => createAgentSubagentProcessor({}), /ProductStore/u)
  const processor = createAgentSubagentProcessor({
    productStore: { claimAgentSubagentActivation() {}, settleAgentSubagentActivation() {} },
    turnRuntime: { execute() {} },
    runSubagent() {},
  })
  await assert.rejects(processor({}), /激活身份/u)
})
