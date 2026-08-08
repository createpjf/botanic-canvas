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

test('Agent 执行链路从权威 Run、Job 与 Artifact 生成安全关联快照', async () => {
  const responses = []
  const run = {
    id: 'run-trace', projectId: 'project-trace', status: 'completed', createdAt: 10, updatedAt: 50,
    plan: { plannerModel: 'deepseek-v4-pro', prompt: '不应返回' },
    branches: [{ id: 'branch-1', status: 'succeeded', attempt: 0, jobIds: ['job-1'], outputCount: 1, updatedAt: 50 }],
  }
  const handler = createAgentRouteHandler({
    config: {},
    productStore: {
      projectAccess: async () => ({ exists: true, role: 'owner' }),
      readAgentRun: async () => run,
      readGenerationJob: async () => ({ id: 'job-1', status: 'succeeded', createdAt: 20, updatedAt: 50, outputs: [{ id: 'output-1' }] }),
      listAgentArtifacts: async () => [{ id: 'artifact-1', provenance: { runId: 'run-trace' }, origin: { jobId: 'job-1' }, url: 'https://private.example/media' }],
    },
    json: (_response, status, body) => { responses.push({ status, body }); return true },
    error: (_response, status, code, message) => { responses.push({ status, body: { error: { code, message } } }); return true },
    requireUser: async () => ({ id: 'user-1' }),
  })

  await handler(
    { method: 'GET', headers: {} },
    {},
    new URL('http://botanic.test/api/agent-runs/run-trace/trace'),
    { agentRunTrace: ['trace', 'run-trace'] },
    'request-trace',
  )

  assert.equal(responses[0]?.status, 200)
  assert.equal(responses[0]?.body.trace.traceId, 'agent-trace:run-trace')
  assert.deepEqual(responses[0]?.body.trace.links.jobIds, ['job-1'])
  assert.deepEqual(responses[0]?.body.trace.links.artifactIds, ['artifact-1'])
  assert.doesNotMatch(JSON.stringify(responses[0]?.body), /不应返回|private\.example/)
})

test('Editor 不能越权执行外部工具，过期审批也不能绕过服务端校验', async () => {
  const requestBody = {
    projectId: 'project-governed', name: 'mcp_call', toolCallId: 'call-mcp-1', confirmed: true,
    approval: { projectId: 'project-governed', toolCallId: 'call-mcp-1', approvedAt: 1, expiresAt: 2 },
    arguments: { server: 'assets', tool: 'search', arguments: {} },
  }
  const shared = {
    config: {},
    readJson: async () => requestBody,
    text: (value) => String(value),
    requireUser: async () => ({ id: 'user-1' }),
    json: () => true,
    error: () => true,
  }
  const editorHandler = createAgentRouteHandler({
    ...shared,
    productStore: { projectAccess: async () => ({ exists: true, role: 'editor' }) },
  })
  await assert.rejects(
    () => editorHandler(
      { method: 'POST', headers: { 'idempotency-key': 'external-editor-action-1' } }, {},
      new URL('http://botanic.test/api/agent-actions'), {}, 'request-editor',
    ),
    (caught) => caught?.code === 'PROJECT_ACCESS_FORBIDDEN',
  )

  const ownerHandler = createAgentRouteHandler({
    ...shared,
    productStore: { projectAccess: async () => ({ exists: true, role: 'owner' }) },
  })
  await assert.rejects(
    () => ownerHandler(
      { method: 'POST', headers: { 'idempotency-key': 'external-expired-action-1' } }, {},
      new URL('http://botanic.test/api/agent-actions'), {}, 'request-owner',
    ),
    (caught) => caught?.code === 'ACTION_APPROVAL_REQUIRED',
  )
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

test('Agent 消息独立写入后产生可定位协作活动并实时广播', async () => {
  const responses = []
  const activities = []
  const published = []
  const message = { id: 'message-1', role: 'user', kind: 'text', content: '继续优化', createdAt: 20 }
  const handler = createAgentRouteHandler({
    config: {},
    productStore: {
      projectAccess: async () => ({ exists: true, role: 'owner' }),
      putAgentMessage: async () => message,
      readAgentState: async () => ({ sessions: [{ id: 'session-1', title: '海边方向', messages: [message] }] }),
      putCollaborationActivity: async (_userId, projectId, input) => {
        const activity = { ...input, actorId: 'user-1', actorName: 'Leo', occurredAt: 30, count: 1 }
        activities.push({ projectId, activity })
        return activity
      },
    },
    json: (_response, status, body) => { responses.push({ status, body }); return true },
    readJson: async () => message,
    requireUser: async () => ({ id: 'user-1' }),
    publishCollaborationActivity: (event) => { published.push(event) },
  })

  await handler(
    { method: 'PUT', headers: {} },
    {},
    new URL('http://botanic.test/api/projects/project-1/agent-sessions/session-1/messages/message-1'),
    { agentMessage: ['agent-message', 'project-1', 'session-1', 'message-1'] },
    'request-message',
  )

  assert.equal(responses[0]?.status, 200)
  assert.deepEqual(activities[0], {
    projectId: 'project-1',
    activity: {
      id: 'agent-message-message-1', kind: 'conversation', summary: '更新了对话「海边方向」',
      target: { kind: 'message', sessionId: 'session-1', messageId: 'message-1' },
      actorId: 'user-1', actorName: 'Leo', occurredAt: 30, count: 1,
    },
  })
  assert.deepEqual(published[0], { projectId: 'project-1', activity: activities[0].activity })
})

test('Agent 会话设置仅在真实变化时产生协作动态', async () => {
  const activities = []
  let stored = {
    id: 'session-settings', title: '原始标题', executionMode: 'manual', contextNodeIds: [],
    createdAt: 10, updatedAt: 10,
  }
  const handler = createAgentRouteHandler({
    config: {},
    productStore: {
      projectAccess: async () => ({ exists: true, role: 'owner' }),
      readAgentState: async () => ({ sessions: [stored] }),
      putAgentSession: async (_userId, _projectId, session) => { stored = session; return session },
      putCollaborationActivity: async (_userId, _projectId, input) => {
        activities.push(input)
        return { ...input, actorId: 'user-1', actorName: 'Leo', occurredAt: 30, count: 1 }
      },
    },
    json: () => true,
    readJson: async () => ({ ...stored, title: '新标题', updatedAt: 20 }),
    requireUser: async () => ({ id: 'user-1' }),
    publishCollaborationActivity: async () => {},
  })
  const request = { method: 'PUT', headers: {} }
  const url = new URL('http://botanic.test/api/projects/project-1/agent-sessions/session-settings')
  const matches = { agentSession: ['agent-session', 'project-1', 'session-settings'] }

  await handler(request, {}, url, matches, 'request-session-change')
  await handler(request, {}, url, matches, 'request-session-same')

  assert.equal(activities.length, 1)
  assert.equal(activities[0].summary, '更新了对话设置「新标题」')
})
