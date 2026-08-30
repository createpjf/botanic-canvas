import assert from 'node:assert/strict'
import test from 'node:test'

import { recoverPendingAgentTurn } from './agentTurnRecovery.ts'

test('缺少 durable Turn 与请求快照时 fail closed', async () => {
  await assert.rejects(() => recoverPendingAgentTurn({
    projectId: 'project-1',
    message: {
      id: 'message-1', role: 'user', kind: 'text', content: '继续', createdAt: 1,
    },
    request: {
      projectId: 'project-1',
      sessionId: 'session-1',
      inputMessage: { id: 'message-1', content: '继续' },
      locale: 'zh-CN',
      contextNodeIds: [],
      hasTarget: false,
    },
    initialTurnId: '',
    signal: new AbortController().signal,
    onEvent: () => {},
    onAccepted: () => {},
    ensureMessageDurable: async () => {},
    cancellationRequested: () => false,
    ensureCancellation: async () => {},
    submitTurn: async () => { throw new Error('不得提交') },
    observeTurn: async () => { throw new Error('不得观察') },
    createError: (message, status, code) => Object.assign(new Error(message), { status, code }),
  }), { code: 'AGENT_TURN_REQUEST_SNAPSHOT_MISSING' })
})
