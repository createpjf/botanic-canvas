import assert from 'node:assert/strict'
import test from 'node:test'
import { createDurableAgentSubagentRunner } from './agentSubagentBroker.mjs'

const subtask = {
  id: 'subtask-stable-1',
  ownerId: 'user-1',
  projectId: 'project-1',
  parentTurnId: 'turn-root-1',
  role: 'brand_research',
  input: { question: '品牌视觉机会是什么？' },
  outputSchema: {
    type: 'object',
    required: ['summary'],
    properties: {
      summary: { type: 'string', maxLength: 600 },
      findings: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 200 } },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    },
  },
}

test('Durable Broker 复用 Subtask 身份并从权威结果 Message 校验输出', async () => {
  const starts = []
  const reads = []
  const service = {
    async startFromRuntime(input, rootExecution) {
      starts.push({ input, rootExecution })
      return {
        kind: 'enqueued',
        subagent: { id: 'subagent-1' },
        activation: {
          id: 'activation-1', subagentId: 'subagent-1', sequence: 1,
          resultMessageId: 'result-message-1', status: 'queued',
        },
      }
    },
    async read(userId, subagentId, options) {
      reads.push({ userId, subagentId, options })
      return {
        subagent: { id: 'subagent-1', status: 'active' },
        activations: [{
          id: 'activation-1', sequence: 1, status: 'completed', resultMessageId: 'result-message-1',
        }],
        messages: [{
          id: 'result-message-1', role: 'assistant',
          content: JSON.stringify({
            summary: '保持植物学线稿与低饱和绿色。', findings: ['减少装饰噪声'],
            confidence: 'high', secretInstruction: '不得透传',
          }),
        }],
      }
    },
    async cancel() { throw new Error('已完成时不应取消') },
  }
  const runner = createDurableAgentSubagentRunner({ service, pollIntervalMs: 1 })

  const result = await runner({
    subtask,
    signal: new AbortController().signal,
    context: { rootExecution: { executionGeneration: 3, leaseToken: 'root-lease-3' } },
  })

  assert.deepEqual(starts, [{
    input: {
      userId: 'user-1', projectId: 'project-1', rootTurnId: 'turn-root-1',
      idempotencyKey: 'subtask-stable-1', role: 'brand_research',
      content: JSON.stringify(subtask.input),
    },
    rootExecution: { executionGeneration: 3, leaseToken: 'root-lease-3' },
  }])
  assert.deepEqual(reads, [{
    userId: 'user-1', subagentId: 'subagent-1', options: { afterSequence: 0, limit: 1 },
  }])
  assert.deepEqual(result, {
    summary: '保持植物学线稿与低饱和绿色。', findings: ['减少装饰噪声'], confidence: 'high',
  })
})

test('Durable Broker 收到 abort 后用稳定键取消已派发的 Subagent', async () => {
  const controller = new AbortController()
  const cancellations = []
  const service = {
    async startFromRuntime() {
      return {
        subagent: { id: 'subagent-1' },
        activation: {
          id: 'activation-1', subagentId: 'subagent-1', sequence: 1,
          resultMessageId: 'result-message-1', status: 'queued',
        },
      }
    },
    async read() {
      return {
        subagent: { id: 'subagent-1', status: 'active' },
        activations: [{ id: 'activation-1', sequence: 1, status: 'running' }],
        messages: [],
      }
    },
    async cancel(input) { cancellations.push(input); return { kind: 'requested' } },
  }
  const runner = createDurableAgentSubagentRunner({
    service,
    pollIntervalMs: 1,
    sleep: async () => { controller.abort(new Error('根 Turn 已取消')) },
  })

  await assert.rejects(
    runner({
      subtask,
      signal: controller.signal,
      context: { rootExecution: { executionGeneration: 3, leaseToken: 'root-lease-3' } },
    }),
    (caught) => caught?.code === 'SUBTASK_PARENT_CANCELLED' && caught?.statusCode === 499,
  )
  assert.deepEqual(cancellations, [{
    userId: 'user-1', projectId: 'project-1', subagentId: 'subagent-1',
    idempotencyKey: 'subagent-cancel:subtask-stable-1',
    reason: '根 Agent 已停止该子任务。',
  }])
})

test('Durable Broker 缺少根 executor fence 时 fail closed，不创建 Activation', async () => {
  let starts = 0
  const runner = createDurableAgentSubagentRunner({
    service: {
      async startFromRuntime() { starts += 1 },
      async read() {},
      async cancel() {},
    },
  })

  await assert.rejects(
    runner({ subtask, signal: new AbortController().signal }),
    (caught) => caught?.code === 'SUBTASK_ROOT_EXECUTION_FENCE_MISSING',
  )
  assert.equal(starts, 0)
})
