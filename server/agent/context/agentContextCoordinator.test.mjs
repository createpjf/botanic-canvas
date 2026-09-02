import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentContextCoordinator } from './agentContextCoordinator.mjs'
import { agentContextStateCompareAndSetDecision } from './agentContextPersistence.mjs'

const message = (id, role, content, updatedAt) => ({
  id, role, kind: 'text', content, createdAt: updatedAt, updatedAt,
})

function storeFixture({ conflictOnce = false } = {}) {
  let state = { version: 2, sessionId: 'session-1', projectId: 'project-1', revision: 0, updatedAt: 0 }
  const ledger = []
  let conflicted = false
  return {
    get state() { return structuredClone(state) },
    get ledger() { return structuredClone(ledger) },
    async readAgentContextState() { return structuredClone(state) },
    async listAgentContextCompactions(_userId, _projectId, _sessionId, options) {
      const compactions = ledger
        .filter((entry) => entry.compaction && entry.sequence > options.afterSequence)
        .slice(0, options.limit)
        .map((entry) => ({ ...structuredClone(entry.compaction), sequence: entry.sequence, createdAt: entry.createdAt }))
      return { compactions }
    },
    async compareAndSetAgentContextState(_userId, command) {
      if (conflictOnce && !conflicted) {
        conflicted = true
        return { kind: 'conflict', changed: false, state: structuredClone(state) }
      }
      const replayEntry = ledger.find((entry) => entry.idempotencyKey === command.idempotencyKey)
      const decision = agentContextStateCompareAndSetDecision({
        state,
        replayEntry,
        command,
        ownerId: 'user-1',
        observedAt: 100 + state.revision,
      })
      if (decision.changed) {
        state = structuredClone(decision.state)
        ledger.push(structuredClone(decision.ledgerEntry))
      }
      const { ledgerEntry: _ledgerEntry, ...publicDecision } = decision
      return structuredClone(publicDecision)
    },
  }
}

const policies = {
  models: {
    'test-model': {
      contextWindowTokens: 4_096,
      outputReserveTokens: 512,
      safetyMarginTokens: 128,
      autoCompactRatio: 0.5,
      retainRecentRatio: 0.1,
    },
  },
}

function longHistory() {
  return Array.from({ length: 12 }, (_, index) => message(
    `m-${index + 1}`, index % 2 ? 'assistant' : 'user', `消息 ${index + 1} ${'中'.repeat(300)}`, index + 1,
  ))
}

test('Coordinator 原子提交 checkpoint 并返回可冻结的 Snapshot V2', async () => {
  const store = storeFixture()
  const coordinator = createAgentContextCoordinator({ productStore: store, policies })
  const result = await coordinator.resolve({
    userId: 'user-1', projectId: 'project-1', sessionId: 'session-1', model: 'test-model',
    messages: longHistory(), currentMessageId: 'm-11',
  })
  assert.equal(result.kind, 'compacted')
  assert.equal(result.snapshot.version, 2)
  assert.equal(result.snapshot.compactionHead.id, result.compaction.id)
  assert.equal(result.snapshot.contextStateRevision, 1)
  assert.ok(result.snapshot.checkpoint.content)
  assert.equal(result.snapshot.messages.some((entry) => entry.id === 'm-11'), true)
  assert.equal(store.ledger.length, 1)
})

test('Coordinator CAS 冲突后重读一次，不产生重复 ledger', async () => {
  const store = storeFixture({ conflictOnce: true })
  const coordinator = createAgentContextCoordinator({ productStore: store, policies })
  const result = await coordinator.resolve({
    userId: 'user-1', projectId: 'project-1', sessionId: 'session-1', model: 'test-model',
    messages: longHistory(), currentMessageId: 'm-11',
  })
  assert.equal(result.kind, 'compacted')
  assert.equal(store.ledger.length, 1)
})

test('Coordinator 同一 manual idempotency key 重放同一 checkpoint', async () => {
  const store = storeFixture()
  const coordinator = createAgentContextCoordinator({ productStore: store, policies })
  const input = {
    userId: 'user-1', projectId: 'project-1', sessionId: 'session-1', model: 'test-model',
    messages: longHistory(), currentMessageId: 'm-11', force: true, trigger: 'manual',
    idempotencyKey: 'manual-key-1',
  }
  const first = await coordinator.resolve(input)
  const second = await coordinator.resolve(input)
  assert.equal(first.kind, 'compacted')
  assert.equal(second.kind, 'reused')
  assert.equal(store.ledger.length, 1)
})
