import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentActionExecution } from './agentActionExecution.mjs'

function fakeReceiptStore() {
  const receipts = new Map()
  let failSucceededSettlementOnce = false
  return {
    receipts,
    failNextSucceededSettlement() {
      failSucceededSettlementOnce = true
    },
    async claimAgentActionReceipt(userId, claim) {
      const existing = receipts.get(claim.id)
      if (!existing) {
        const receipt = { ...structuredClone(claim), ownerId: userId }
        receipts.set(claim.id, receipt)
        return { kind: 'claimed', receipt: structuredClone(receipt) }
      }
      if (existing.ownerId !== userId
        || existing.projectId !== claim.projectId
        || existing.intentHash !== claim.intentHash
        || existing.actionBindingHash !== claim.actionBindingHash) {
        return { kind: 'conflict', receipt: structuredClone(existing) }
      }
      if (!existing.status || existing.status === 'succeeded') {
        return { kind: 'replay', receipt: structuredClone(existing) }
      }
      if (existing.status === 'failed' && existing.replayPolicy === 'safe' && claim.replayPolicy === 'safe') {
        const receipt = {
          ...existing,
          ...structuredClone(claim),
          ownerId: userId,
          status: 'running',
        }
        delete receipt.error
        receipts.set(claim.id, receipt)
        return { kind: 'claimed', receipt: structuredClone(receipt) }
      }
      if (existing.status === 'running') {
        return { kind: 'in_progress', receipt: structuredClone(existing) }
      }
      return { kind: existing.status, receipt: structuredClone(existing) }
    },
    async settleAgentActionReceipt(userId, settlement) {
      if (settlement.status === 'succeeded' && failSucceededSettlementOnce) {
        failSucceededSettlementOnce = false
        throw Object.assign(new Error('回执写入失败'), { code: 'STORE_UNAVAILABLE' })
      }
      const existing = receipts.get(settlement.id)
      if (!existing || existing.ownerId !== userId || existing.projectId !== settlement.projectId) {
        throw Object.assign(new Error('未找到行动回执。'), { code: 'AGENT_ACTION_RECEIPT_NOT_FOUND' })
      }
      if (existing.leaseToken !== settlement.leaseToken || existing.status !== 'running') {
        throw Object.assign(new Error('行动执行租约已失效。'), { code: 'AGENT_ACTION_LEASE_STALE' })
      }
      const receipt = { ...existing, ...structuredClone(settlement) }
      receipts.set(receipt.id, receipt)
      return structuredClone(receipt)
    },
  }
}

function action(overrides = {}) {
  return {
    userId: 'user-1',
    projectId: 'project-1',
    receiptId: 'receipt-1',
    toolCallId: 'call-1',
    name: 'mcp_call',
    arguments: { server: 'notion', tool: 'create_page' },
    ...overrides,
  }
}

test('两个 Runtime 实例竞争同一行动时只有原子 claim 的胜者执行副作用', async () => {
  const productStore = fakeReceiptStore()
  const firstRuntime = createAgentActionExecution({ productStore, timeoutMs: 1_000 })
  const secondRuntime = createAgentActionExecution({ productStore, timeoutMs: 1_000 })
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let executions = 0

  const first = firstRuntime.execute(action({
    executor: async () => {
      executions += 1
      await gate
      return { output: { pageId: 'page-1' }, toolCall: { id: 'call-1', name: 'mcp_call' } }
    },
  }))

  await assert.rejects(
    secondRuntime.execute(action({ executor: async () => { executions += 1 } })),
    (caught) => caught?.code === 'AGENT_ACTION_IN_PROGRESS' && caught?.statusCode === 409,
  )
  release()
  const result = await first
  assert.equal(result.output.pageId, 'page-1')
  assert.equal(executions, 1)

  const replayed = await secondRuntime.execute(action({ executor: async () => { executions += 1 } }))
  assert.equal(replayed.output.pageId, 'page-1')
  assert.equal(executions, 1, '完成回执必须直接重放，不能再次调用 executor')
})

test('同一回执标识绑定 intent hash，换工具参数重放会明确冲突', async () => {
  const productStore = fakeReceiptStore()
  const runtime = createAgentActionExecution({ productStore })
  await runtime.execute(action({ executor: async () => ({ output: { ok: true } }) }))

  await assert.rejects(
    runtime.execute(action({
      arguments: { server: 'notion', tool: 'delete_page' },
      executor: async () => ({ output: { deleted: true } }),
    })),
    (caught) => caught?.code === 'AGENT_ACTION_INTENT_CONFLICT' && caught?.statusCode === 409,
  )
})

test('同 receipt/intent 的不同 Session Message binding 不得共用执行或成功回执', async () => {
  const productStore = fakeReceiptStore()
  const runtime = createAgentActionExecution({ productStore })
  let executions = 0
  await runtime.execute(action({
    actionBindingHash: 'binding-session-a-message-a',
    executor: async () => { executions += 1; return { output: { ok: true } } },
  }))

  await assert.rejects(
    runtime.execute(action({
      actionBindingHash: 'binding-session-b-message-b',
      executor: async () => { executions += 1; return { output: { leaked: true } } },
    })),
    (caught) => caught?.code === 'AGENT_ACTION_INTENT_CONFLICT' && caught?.statusCode === 409,
  )
  assert.equal(executions, 1)
})

test('原子 claim 存储不可用时返回稳定 503，不退化成通用 500', async () => {
  const productStore = {
    async claimAgentActionReceipt() {
      throw Object.assign(new Error('迁移尚未部署'), { code: 'AGENT_ACTION_ATOMIC_CLAIM_REQUIRED' })
    },
    async settleAgentActionReceipt() {
      throw new Error('claim 失败后不应 settle')
    },
  }
  const runtime = createAgentActionExecution({ productStore })

  await assert.rejects(
    runtime.execute(action({ executor: async () => ({ output: { impossible: true } }) })),
    (caught) => caught?.code === 'AGENT_ACTION_CLAIM_FAILED' && caught?.statusCode === 503,
  )
})

test('行动超时会传播 AbortSignal 并持久化 uncertain，不能假装副作用没有发生', async () => {
  const productStore = fakeReceiptStore()
  const runtime = createAgentActionExecution({ productStore, timeoutMs: 5 })
  let observedSignal

  await assert.rejects(
    runtime.execute(action({
      executor: async ({ signal }) => {
        observedSignal = signal
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      },
    })),
    (caught) => caught?.code === 'AGENT_ACTION_TIMEOUT' && caught?.statusCode === 504,
  )

  assert.equal(observedSignal.aborted, true)
  const receipt = productStore.receipts.get('receipt-1')
  assert.equal(receipt.status, 'uncertain')
  assert.equal(receipt.error.code, 'AGENT_ACTION_OUTCOME_UNKNOWN')

  await assert.rejects(
    runtime.execute(action({ executor: async () => ({ output: { duplicated: true } }) })),
    (caught) => caught?.code === 'AGENT_ACTION_OUTCOME_UNKNOWN' && caught?.statusCode === 409,
  )
})

test('明确失败按 replayPolicy 收口：safe 记 failed，never 记 uncertain', async () => {
  const productStore = fakeReceiptStore()
  const runtime = createAgentActionExecution({ productStore })

  await assert.rejects(
    runtime.execute(action({
      receiptId: 'receipt-never',
      replayPolicy: 'never',
      executor: async () => { throw new Error('外部响应丢失') },
    })),
    (caught) => caught?.code === 'AGENT_ACTION_OUTCOME_UNKNOWN' && caught?.statusCode === 409,
  )
  assert.equal(productStore.receipts.get('receipt-never').status, 'uncertain')

  await assert.rejects(
    runtime.execute(action({
      receiptId: 'receipt-safe',
      replayPolicy: 'safe',
      executor: async () => { throw new Error('校验失败') },
    })),
    /校验失败/u,
  )
  assert.equal(productStore.receipts.get('receipt-safe').status, 'failed')
})

test('safe 行动明确失败后可用同一回执重试，uncertain 仍禁止重放', async () => {
  const productStore = fakeReceiptStore()
  const runtime = createAgentActionExecution({ productStore })
  let executions = 0

  await assert.rejects(
    runtime.execute(action({
      receiptId: 'receipt-safe-retry',
      replayPolicy: 'safe',
      executor: async () => {
        executions += 1
        throw new Error('明确失败')
      },
    })),
    /明确失败/u,
  )

  const result = await runtime.execute(action({
    receiptId: 'receipt-safe-retry',
    replayPolicy: 'safe',
    executor: async () => {
      executions += 1
      return { output: { ok: true } }
    },
  }))

  assert.equal(executions, 2)
  assert.equal(result.output.ok, true)
  assert.equal(productStore.receipts.get('receipt-safe-retry').status, 'succeeded')
  assert.equal(productStore.receipts.get('receipt-safe-retry').error, undefined)
})

test('executor 已成功但完成回执写入失败时，即使 safe 也必须落 uncertain', async () => {
  const productStore = fakeReceiptStore()
  const runtime = createAgentActionExecution({ productStore })
  let executions = 0
  productStore.failNextSucceededSettlement()

  await assert.rejects(
    runtime.execute(action({
      receiptId: 'receipt-settle-failed',
      replayPolicy: 'safe',
      executor: async () => {
        executions += 1
        return { output: { ok: true } }
      },
    })),
    (caught) => caught?.code === 'AGENT_ACTION_OUTCOME_UNKNOWN' && caught?.statusCode === 409,
  )

  assert.equal(productStore.receipts.get('receipt-settle-failed').status, 'uncertain')
  await assert.rejects(
    runtime.execute(action({
      receiptId: 'receipt-settle-failed',
      replayPolicy: 'safe',
      executor: async () => { executions += 1 },
    })),
    (caught) => caught?.code === 'AGENT_ACTION_OUTCOME_UNKNOWN',
  )
  assert.equal(executions, 1)
})

test('never 行动在副作用前的已知失败落 failed，不伪报可能已生效', async () => {
  const productStore = fakeReceiptStore()
  const runtime = createAgentActionExecution({ productStore })
  const invalid = Object.assign(new Error('参数无效'), {
    code: 'TOOL_ARGUMENTS_INVALID',
    statusCode: 422,
    outcomeKnown: true,
  })

  await assert.rejects(
    runtime.execute(action({
      receiptId: 'receipt-known-failure',
      replayPolicy: 'never',
      executor: async () => { throw invalid },
    })),
    (caught) => caught === invalid,
  )
  assert.equal(productStore.receipts.get('receipt-known-failure').status, 'failed')
  assert.equal(productStore.receipts.get('receipt-known-failure').error.code, 'TOOL_ARGUMENTS_INVALID')
})
