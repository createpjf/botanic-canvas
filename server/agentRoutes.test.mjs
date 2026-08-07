import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentRouteHandler } from './agentRoutes.mjs'

const runInput = {
  projectId: 'project-concurrent',
  plan: {
    intent: 'initial_generation',
    instruction: '生成一张海边人像',
    summary: '海边人像',
    prompt: '自然光海边人像',
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
    constraints: [],
    output: { mode: 'single', count: 1, candidatesPerItem: 1 },
    contextSnapshot: [{ nodeId: 'asset-1', label: '参考人物', kind: '素材', mediaKind: 'image' }],
  },
  branches: [{ id: 'branch-1', label: '海边人像' }],
}

test('Agent Run 首次创建返回并广播锁内持久化后的权威记录', async () => {
  const published = []
  const responses = []
  const handler = createAgentRouteHandler({
    config: {},
    productStore: {
      projectAccess: async () => ({ exists: true, role: 'owner' }),
      readAgentRun: async () => undefined,
      putAgentRun: async (_userId, run) => ({ ...run, status: 'running', updatedAt: run.updatedAt + 1 }),
    },
    json: (_response, status, body) => { responses.push({ status, body }); return true },
    readJson: async () => runInput,
    requireUser: async () => ({ id: 'user-1' }),
    publishAgentRunUpdated: async (event) => { published.push(event) },
  })

  await handler(
    { method: 'POST', headers: { 'idempotency-key': 'agent-run-concurrent' } },
    {},
    new URL('http://botanic.test/api/agent-runs'),
    {},
    'request-1',
  )

  assert.equal(responses[0]?.status, 201)
  assert.equal(responses[0]?.body.run.status, 'running')
  assert.equal(published[0]?.run.status, 'running')
  assert.equal(published[0]?.run.id, responses[0]?.body.run.id)
})

test('Agent Run 创建与幂等复用产生不含创作内容的结构化运行事件', async () => {
  const events = []
  const stored = { id: 'agent_run_existing', projectId: runInput.projectId, status: 'queued', branches: [], createdAt: 1, updatedAt: 1, plan: runInput.plan }
  const shared = {
    config: {},
    json: () => true,
    readJson: async () => runInput,
    requireUser: async () => ({ id: 'user-1' }),
    publishAgentRunUpdated: async () => {},
    observeAgentRun: (event) => events.push(event),
  }

  const createHandler = createAgentRouteHandler({
    ...shared,
    productStore: {
      projectAccess: async () => ({ exists: true, role: 'owner' }),
      readAgentRun: async () => undefined,
      putAgentRun: async (_userId, run) => run,
    },
  })
  await createHandler(
    { method: 'POST', headers: { 'idempotency-key': 'agent-run-observed' } },
    {},
    new URL('http://botanic.test/api/agent-runs'),
    {},
    'request-create',
  )

  const reuseHandler = createAgentRouteHandler({
    ...shared,
    productStore: {
      projectAccess: async () => ({ exists: true, role: 'owner' }),
      readAgentRun: async () => stored,
    },
  })
  await reuseHandler(
    { method: 'POST', headers: { 'idempotency-key': 'agent-run-reused' } },
    {},
    new URL('http://botanic.test/api/agent-runs'),
    {},
    'request-reuse',
  )

  assert.equal(events.length, 2)
  assert.deepEqual(events.map(({ type, requestId, projectId, status }) => ({ type, requestId, projectId, status })), [
    { type: 'created', requestId: 'request-create', projectId: runInput.projectId, status: 'queued' },
    { type: 'submission_reused', requestId: 'request-reuse', projectId: runInput.projectId, status: 'queued' },
  ])
  assert.equal(events.every((event) => Number.isFinite(event.durationMs) && event.durationMs >= 0), true)
  assert.doesNotMatch(JSON.stringify(events), /生成一张海边人像|自然光海边人像|参考人物/)
})

test('Agent 阅读位置增量更新写入当前成员回执，不修改共享会话', async () => {
  const responses = []
  const storedReceipts = []
  const remoteSession = {
    id: 'session-reading', title: '远端新标题', executionMode: 'auto', contextNodeIds: ['node-remote'],
    messages: [{ id: 'message-reading', role: 'assistant', kind: 'text', content: '阅读到这里', createdAt: 10 }],
    createdAt: 1, updatedAt: 20,
  }
  const handler = createAgentRouteHandler({
    config: {},
    productStore: {
      projectAccess: async () => ({ exists: true, role: 'owner' }),
      readAgentState: async () => ({ sessions: [remoteSession] }),
      putAgentSessionReadReceipt: async (userId, projectId, sessionId, receipt) => {
        storedReceipts.push({ userId, projectId, sessionId, receipt })
        return { sessionId, ...receipt }
      },
    },
    json: (_response, status, body) => { responses.push({ status, body }); return true },
    error: (_response, status, code, message) => { responses.push({ status, body: { error: { code, message } } }); return true },
    readJson: async () => ({ messageId: 'message-reading' }),
    text: (value) => String(value),
    requireUser: async () => ({ id: 'user-1' }),
  })

  await handler(
    { method: 'PATCH', headers: {} },
    {},
    new URL('http://botanic.test/api/projects/project-reading/agent-sessions/session-reading/reading-anchor'),
    { agentSessionReadingAnchor: ['reading-anchor', 'project-reading', 'session-reading'] },
    'request-reading',
  )

  assert.equal(responses[0]?.status, 200)
  assert.equal(storedReceipts[0]?.userId, 'user-1')
  assert.equal(storedReceipts[0]?.projectId, 'project-reading')
  assert.equal(storedReceipts[0]?.sessionId, 'session-reading')
  assert.equal(storedReceipts[0]?.receipt.messageId, 'message-reading')
  assert.ok(storedReceipts[0]?.receipt.updatedAt >= remoteSession.updatedAt)
  assert.equal(responses[0]?.body.receipt.messageId, 'message-reading')
})
