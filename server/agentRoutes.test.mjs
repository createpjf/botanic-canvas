import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentRouteHandler, createServerSentEventWriter } from './agentRoutes.mjs'

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

test('导演模式：创建 Run 后服务端直接提交生成，浏览器拿到已执行的快照', async () => {
  const submitted = []
  const events = []
  const responses = []
  const handler = createAgentRouteHandler({
    config: {},
    productStore: {
      projectAccess: async () => ({ exists: true, role: 'owner' }),
      readAgentRun: async () => undefined,
      putAgentRun: async (_userId, run) => run,
    },
    agentRunGeneration: {
      submitGeneration: async (userId, projectId, runId) => {
        submitted.push({ userId, projectId, runId })
        return {
          run: {
            id: runId, projectId, status: 'executing', createdAt: 1, updatedAt: 2, plan: runInput.plan,
            branches: [{ id: 'branch-1', label: '海边人像', status: 'queued', attempt: 0, jobIds: ['job-1'], activeJobId: 'job-1', outputCount: 0, updatedAt: 2 }],
          },
          jobs: [{ id: 'job-1' }],
          workflows: [],
        }
      },
    },
    json: (_response, status, body) => { responses.push({ status, body }); return true },
    readJson: async () => runInput,
    requireUser: async () => ({ id: 'user-1' }),
    publishAgentRunUpdated: async () => {},
    observeAgentRun: (event) => events.push(event),
  })

  await handler(
    { method: 'POST', headers: { 'idempotency-key': 'agent-run-director' } },
    {},
    new URL('http://botanic.test/api/agent-runs'),
    {},
    'request-director',
  )

  assert.equal(responses[0]?.status, 201)
  assert.equal(responses[0]?.body.run.status, 'executing')
  assert.equal(responses[0]?.body.run.branches[0].activeJobId, 'job-1')
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].userId, 'user-1')
  assert.equal(submitted[0].projectId, runInput.projectId)
  assert.deepEqual(events.map((event) => event.type), ['created', 'auto_submitted'])
})

test('导演模式：提交暂不可用时 Run 保持 queued，由恢复器兜底；幂等重放会补提交', async () => {
  const events = []
  const responses = []
  const storedQueued = {
    id: 'agent_run_deferred', projectId: runInput.projectId, status: 'queued', createdAt: 1, updatedAt: 1,
    plan: runInput.plan,
    branches: [{ id: 'branch-1', label: '海边人像', status: 'queued', attempt: 0, jobIds: [], outputCount: 0, updatedAt: 1 }],
  }
  const shared = {
    config: {},
    json: (_response, status, body) => { responses.push({ status, body }); return true },
    readJson: async () => runInput,
    requireUser: async () => ({ id: 'user-1' }),
    publishAgentRunUpdated: async () => {},
    observeAgentRun: (event) => events.push(event),
  }

  // 首次创建：队列不可用，提交抛错 → 201 且 Run 仍是 queued。
  // 创建后 catch 里会再读一次快照；让第一次读（幂等检查）为空、之后返回 queued 原样。
  let readCount = 0
  const failingHandler = createAgentRouteHandler({
    ...shared,
    productStore: {
      projectAccess: async () => ({ exists: true, role: 'owner' }),
      readAgentRun: async () => { readCount += 1; return readCount === 1 ? undefined : storedQueued },
      putAgentRun: async () => storedQueued,
    },
    agentRunGeneration: { submitGeneration: async () => { throw new Error('QUEUE_UNAVAILABLE') } },
  })
  await failingHandler(
    { method: 'POST', headers: { 'idempotency-key': 'agent-run-deferred' } },
    {},
    new URL('http://botanic.test/api/agent-runs'),
    {},
    'request-deferred',
  )
  assert.equal(responses[0]?.status, 201)
  assert.equal(responses[0]?.body.run.status, 'queued')
  assert.ok(events.some((event) => event.type === 'auto_submit_deferred'))

  // 幂等重放：existing 是空 queued → 补提交并返回已执行快照。
  const resubmitted = []
  const reuseHandler = createAgentRouteHandler({
    ...shared,
    productStore: {
      projectAccess: async () => ({ exists: true, role: 'owner' }),
      readAgentRun: async () => storedQueued,
      putAgentRun: async () => { throw new Error('幂等重放不应重建 Run') },
    },
    agentRunGeneration: {
      submitGeneration: async (_userId, _projectId, runId) => {
        resubmitted.push(runId)
        return {
          run: { ...storedQueued, status: 'executing', branches: [{ ...storedQueued.branches[0], jobIds: ['job-1'], activeJobId: 'job-1' }] },
          jobs: [{ id: 'job-1' }],
          workflows: [],
        }
      },
    },
  })
  await reuseHandler(
    { method: 'POST', headers: { 'idempotency-key': 'agent-run-deferred' } },
    {},
    new URL('http://botanic.test/api/agent-runs'),
    {},
    'request-replay',
  )
  assert.deepEqual(resubmitted, ['agent_run_deferred'])
  assert.equal(responses[1]?.status, 200)
  assert.equal(responses[1]?.body.run.status, 'executing')
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

test('Skill 执行超时会收口为明确失败，不把 Agent 行动永远留在 running', async () => {
  const body = {
    projectId: 'project-skill-timeout', name: 'skill_apply', toolCallId: 'call-skill-timeout',
    confirmed: true, arguments: { skillId: 'project-skill' },
  }
  const handler = createAgentRouteHandler({
    config: { agentActionTimeoutMs: 5 },
    productStore: {
      projectAccess: async () => ({ exists: true, role: 'owner' }),
      readAgentActionReceipt: async () => undefined,
      listAgentSkills: async () => new Promise(() => {}),
    },
    json: () => true,
    error: () => true,
    readJson: async () => body,
    text: (value) => String(value),
    requireUser: async () => ({ id: 'user-1' }),
  })
  const request = handler(
    { method: 'POST', headers: { 'idempotency-key': 'skill-timeout-0001' } }, {},
    new URL('http://botanic.test/api/agent-actions'), {}, 'request-skill-timeout',
  )
  const result = Promise.race([
    request,
    new Promise((_, reject) => setTimeout(() => reject(new Error('test timeout')), 50)),
  ])
  await assert.rejects(result, (caught) => caught?.code === 'AGENT_ACTION_TIMEOUT')
})

test('工作流创建回执携带已持久化的节点与连线，客户端可在提交生成前直接显示', async () => {
  const responses = []
  const workflow = {
    promptNode: { id: 'prompt-1', type: 'text', position: { x: 100, y: 0 }, data: { kind: 'text', content: '海边人像' } },
    generateNode: { id: 'generate-1', type: 'generate', position: { x: 100, y: 172 }, data: { kind: 'generate', status: 'idle' } },
    resultNode: { id: 'result-1', type: 'result', position: { x: 560, y: 172 }, data: { kind: 'result', taskStatus: 'draft' } },
    edges: [
      { id: 'prompt-generate', source: 'prompt-1', target: 'generate-1', data: { role: 'prompt' } },
      { id: 'generate-result', source: 'generate-1', target: 'result-1', data: { role: 'output' } },
    ],
    promptNodeId: 'prompt-1', generateNodeId: 'generate-1', resultNodeId: 'result-1',
  }
  const result = {
    document: { id: 'project-workflow', updatedAt: 50, nodes: [workflow.promptNode, workflow.generateNode, workflow.resultNode], edges: workflow.edges },
    jobs: [], workflows: [workflow],
  }
  const handler = createAgentRouteHandler({
    config: {},
    productStore: {
      projectAccess: async () => ({ exists: true, role: 'owner' }),
      readAgentActionReceipt: async () => undefined,
      putAgentActionReceipt: async () => {},
    },
    agentRunGeneration: {
      prepareProjectExecution: async () => ({ project: { revision: 1, graphRevision: 1 }, prepared: result }),
      persistWorkflow: async () => ({ document: result.document, revision: 2, graphRevision: 2 }),
    },
    json: (_response, status, body) => { responses.push({ status, body }); return true },
    error: () => true,
    readJson: async () => ({
      projectId: 'project-workflow', name: 'workflow_create', toolCallId: 'call-workflow',
      confirmed: true, arguments: { planId: 'run-workflow' },
    }),
    text: (value) => String(value),
    requireUser: async () => ({ id: 'user-1' }),
  })

  await handler(
    { method: 'POST', headers: { 'idempotency-key': 'agent-workflow-run-workflow' } }, {},
    new URL('http://botanic.test/api/agent-actions'), {}, 'request-workflow',
  )

  assert.equal(responses[0]?.status, 200)
  assert.deepEqual(responses[0]?.body.output.canvasPatch.nodes.map((node) => node.id), ['prompt-1', 'generate-1', 'result-1'])
  assert.deepEqual(responses[0]?.body.output.canvasPatch.edges.map((edge) => edge.id), ['prompt-generate', 'generate-result'])
})

function fakeServerResponse() {
  return {
    writableEnded: false,
    destroyed: false,
    head: undefined,
    chunks: [],
    flushHeadersCalls: 0,
    flushCalls: 0,
    writeHead(statusCode, headers) { this.head = { statusCode, headers } },
    write(chunk) { this.chunks.push(chunk) },
    flushHeaders() { this.flushHeadersCalls += 1 },
    flush() { this.flushCalls += 1 },
    end() { this.writableEnded = true },
  }
}

test('SSE 写出器打开通道时写禁用缓冲的响应头，并按事件边界分隔', () => {
  const response = fakeServerResponse()
  const sse = createServerSentEventWriter(response, { heartbeatMs: 0 })

  assert.equal(sse.started, false)
  assert.equal(response.head, undefined)

  sse.send({ type: 'answer', step: 0, delta: '你好' })
  assert.equal(sse.started, true)
  assert.equal(response.head.statusCode, 200)
  assert.match(response.head.headers['Content-Type'], /text\/event-stream/)
  assert.equal(response.head.headers['Cache-Control'], 'no-cache, no-store')
  // HTTP/2 不允许 Connection；代理压缩会把流式缓冲成一次性返回。
  assert.equal(response.head.headers.Connection, undefined)
  assert.equal(response.head.headers['Content-Encoding'], 'none')
  assert.equal(response.head.headers['X-Accel-Buffering'], 'no')

  const firstHead = response.head
  sse.send({ type: 'done', response: { answer: '你好', mode: 'conversation' } })
  assert.equal(response.head, firstHead)
  assert.deepEqual(response.chunks, [
    ': keep-alive\n\n',
    'data: {"type":"answer","step":0,"delta":"你好"}\n\n',
    'data: {"type":"done","response":{"answer":"你好","mode":"conversation"}}\n\n',
  ])

  sse.end()
  assert.equal(response.writableEnded, true)
  // 响应结束后不再写出，也不会重复 end。
  assert.equal(sse.send({ type: 'answer', step: 1, delta: '晚了' }), false)
  assert.equal(response.chunks.length, 3)
  assert.equal(sse.end(), true)
})

test('SSE 写出器在模型还没吐事件前就打开通道，并用注释心跳保持代理不断流', () => {
  const response = fakeServerResponse()
  const beats = []
  let cleared
  const sse = createServerSentEventWriter(response, {
    heartbeatMs: 15,
    scheduleHeartbeat(fn) {
      beats.push(fn)
      return 7
    },
    unscheduleHeartbeat(id) {
      cleared = id
    },
  })

  sse.start()
  assert.equal(sse.started, true)
  assert.equal(response.flushHeadersCalls, 1)
  assert.deepEqual(response.chunks, [': keep-alive\n\n'])

  beats[0]()
  assert.equal(response.chunks.at(-1), ': keep-alive\n\n')
  assert.equal(response.flushCalls, 2)

  sse.send({ type: 'tool', step: 0, toolCall: { name: 'web_search' } })
  assert.equal(response.chunks.at(-1), 'data: {"type":"tool","step":0,"toolCall":{"name":"web_search"}}\n\n')

  sse.end()
  assert.equal(cleared, 7)
  const afterEnd = response.chunks.length
  beats[0]()
  assert.equal(response.chunks.length, afterEnd)
})

test('取消 Agent Run 会广播到 Worker，正在执行的生成才会真的停下', async () => {
  // 这里过去只写库加出队：Worker 是独立进程，看不到 cancelled，会把 Provider
  // 调用跑完才发现结果没人要 —— 用户停掉任务后槽位仍被占着。
  const run = {
    id: 'run-cancel', projectId: 'project-cancel', ownerId: 'user-1', status: 'executing',
    createdAt: 1, updatedAt: 2, plan: runInput.plan,
    branches: [
      { id: 'branch-1', label: '排队中', status: 'queued', attempt: 0, jobIds: ['job-queued'], activeJobId: 'job-queued', outputCount: 0, updatedAt: 2 },
      { id: 'branch-2', label: '执行中', status: 'running', attempt: 0, jobIds: ['job-running'], activeJobId: 'job-running', outputCount: 0, updatedAt: 2 },
    ],
  }
  const jobs = {
    'job-queued': { id: 'job-queued', projectId: 'project-cancel', status: 'queued', settings: { model: 'gpt-image-2' } },
    'job-running': { id: 'job-running', projectId: 'project-cancel', status: 'running', settings: { model: 'gpt-image-2' } },
  }
  const written = []
  const persisted = []
  const dequeued = []
  const broadcast = []
  const responses = []
  const handler = createAgentRouteHandler({
    config: { modelOptions: [{ id: 'gpt-image-2', provider: 'openai' }] },
    productStore: {
      projectAccess: async () => ({ exists: true, role: 'owner' }),
      readAgentRun: async () => structuredClone(run),
      putAgentRun: async (_userId, next) => next,
      readGenerationJob: async (_userId, jobId) => jobs[jobId],
      putGenerationJob: async (_userId, job) => { written.push(job) },
    },
    agentRunGeneration: { persistJobState: async (_userId, _projectId, job) => persisted.push(job.id) },
    redisQueue: { cancel: async (jobId) => dequeued.push(jobId) },
    publishCancel: async (event) => broadcast.push(event),
    json: (_response, status, body) => { responses.push({ status, body }); return true },
    requireUser: async () => ({ id: 'user-1' }),
    publishAgentRunUpdated: async () => {},
  })

  await handler(
    { method: 'POST', headers: {} },
    {},
    new URL('http://botanic.test/api/agent-runs/run-cancel/cancel'),
    { agentRunCancel: ['path', 'run-cancel'] },
    'request-cancel',
  )

  assert.equal(responses.at(-1)?.status, 200)
  assert.deepEqual(written.map((job) => job.id).sort(), ['job-queued', 'job-running'])
  assert.ok(written.every((job) => job.status === 'cancelled'))
  assert.deepEqual(persisted.sort(), ['job-queued', 'job-running'])
  assert.deepEqual(dequeued.sort(), ['job-queued', 'job-running'])
  assert.deepEqual(broadcast.map((event) => event.id).sort(), ['job-queued', 'job-running'])
  // 计费归因照实分开记，并标明是「停 Run」而不是用户单点某一张。
  const byId = new Map(written.map((job) => [job.id, job.cancel]))
  assert.equal(byId.get('job-queued').billing, 'none')
  assert.equal(byId.get('job-running').billing, 'possible')
  assert.ok(written.every((job) => job.cancel.reason === 'agent-run'))
})

test('读取 Turn 时按权威边反查这次回合确认出的 Run', async () => {
  // linkedRunIds 是读时派生：Turn 记录会被 execute() 整条覆盖写，反写会被清掉。
  const responses = []
  const queried = []
  const handler = createAgentRouteHandler({
    config: {},
    productStore: {
      projectAccess: async () => ({ exists: true, role: 'owner' }),
      readAgentTurn: async () => ({
        id: 'turn-1', version: 2, ownerId: 'user-1', projectId: 'project-1',
        idempotencyKey: 'key-1', status: 'completed', createdAt: 1, updatedAt: 2,
      }),
      listAgentTurnEvents: async () => [
        { id: 'e1', turnId: 'turn-1', sequence: 1, type: 'turn.started' },
        { id: 'e2', turnId: 'turn-1', sequence: 4, type: 'turn.completed' },
      ],
      listAgentRunsForTurn: async (userId, projectId, turnId) => {
        queried.push({ userId, projectId, turnId })
        return [{ id: 'run-first' }, { id: 'run-second' }]
      },
    },
    json: (_response, status, body) => { responses.push({ status, body }); return true },
    requireUser: async () => ({ id: 'user-1' }),
  })

  await handler(
    { method: 'GET', headers: {} },
    {},
    new URL('http://botanic.test/api/agent-turns/turn-1'),
    { agentTurn: ['path', 'turn-1'] },
    'request-turn',
  )

  assert.equal(responses.at(-1)?.status, 200)
  assert.deepEqual(responses.at(-1)?.body.turn.linkedRunIds, ['run-first', 'run-second'])
  // 续读游标同时给出，客户端不必为了知道读到哪再拉一次全部事件。
  assert.equal(responses.at(-1)?.body.turn.lastSequence, 4)
  assert.deepEqual(queried, [{ userId: 'user-1', projectId: 'project-1', turnId: 'turn-1' }])
})

test('Run 绑定固定 Skill 版本与内容摘要，内置 Skill 也不例外', async () => {
  // 缺版本或摘要就等于允许出现无法重放的 Run（ADR 0006）。
  const stored = []
  const responses = []
  const handler = createAgentRouteHandler({
    config: {},
    productStore: {
      projectAccess: async () => ({ exists: true, role: 'owner' }),
      readAgentRun: async () => undefined,
      putAgentRun: async (_userId, run) => { stored.push(run); return run },
      readAgentState: async () => ({ memory: [] }),
      listAgentSkills: async () => [{
        id: 'skill-project', projectId: runInput.projectId, name: '项目 Skill',
        instructions: '锁定人物', lifecycle: 'published', status: 'active',
        version: 4, contentHash: 'hash-skill-4',
      }],
    },
    json: (_response, status, body) => { responses.push({ status, body }); return true },
    readJson: async () => ({
      ...runInput,
      plan: {
        ...runInput.plan,
        // 客户端只提交身份；版本与摘要由服务端在确认瞬间固定。
        skillBindings: [{ id: 'skill-project' }, { id: 'controlled_edit' }],
      },
    }),
    requireUser: async () => ({ id: 'user-1' }),
    publishAgentRunUpdated: async () => {},
  })

  await handler(
    { method: 'POST', headers: { 'idempotency-key': 'agent-run-skill-binding' } },
    {},
    new URL('http://botanic.test/api/agent-runs'),
    {},
    'request-binding',
  )

  assert.equal(responses.at(-1)?.status, 201)
  const bindings = stored.at(-1)?.plan?.skillBindings ?? []
  assert.deepEqual(bindings.map((binding) => binding.id), ['skill-project', 'controlled_edit'])
  assert.equal(bindings[0].version, 4)
  assert.equal(bindings[0].contentHash, 'hash-skill-4')
  // 内置 Skill 的版本与摘要随代码确定，同样写进绑定。
  assert.equal(bindings[1].version, 1)
  assert.ok(bindings[1].contentHash)
})

function reviewTaskFixture() {
  return {
    id: 'review_task_1', projectId: 'project-1', ownerId: 'user-1', runId: 'run-1',
    status: 'completed', attempt: 1,
    qualityPolicy: { version: 1, requiredCriteria: ['identity'], humanDecisionRequired: true },
    qualityPolicyFingerprint: 'policy-fp', planFingerprint: 'plan-fp',
    coverage: { strategy: 'all', totalCandidates: 2, reviewedCandidates: 2, skippedCandidates: 0, artifactIds: ['artifact-1', 'artifact-2'] },
    results: [
      { id: 'r1', taskId: 'review_task_1', projectId: 'project-1', artifactId: 'artifact-1', verdict: 'pass', candidateStatus: 'pending_human', criteria: [] },
      { id: 'r2', taskId: 'review_task_1', projectId: 'project-1', artifactId: 'artifact-2', verdict: 'fail', candidateStatus: 'pending_human', criteria: [] },
    ],
    createdAt: 1, updatedAt: 2,
  }
}

function reviewHandler({ tasks = [reviewTaskFixture()], runs = {}, stored = [], published = [], responses = [] } = {}) {
  return {
    responses,
    stored,
    handler: createAgentRouteHandler({
      config: {},
      productStore: {
        projectAccess: async () => ({ exists: true, role: 'owner' }),
        readAgentReviewTask: async (_userId, id) => tasks.find((task) => task.id === id),
        listAgentReviewTasksForRun: async () => tasks,
        putAgentReviewTask: async (_userId, task) => { stored.push(task); return task },
        readAgentRun: async (_userId, id) => runs[id],
        putAgentRun: async (_userId, run) => { stored.push(run); return run },
      },
      json: (_response, status, body) => { responses.push({ status, body }); return true },
      error: (_response, status, code, message) => { responses.push({ status, body: { error: { code, message } } }); return true },
      readJson: async () => reviewHandler.body,
      requireUser: async () => ({ id: 'user-1' }),
      publishAgentRunUpdated: async (event) => { published.push(event) },
    }),
  }
}

test('评审任务读模型暴露覆盖策略与被跳过的候选数', async () => {
  const { handler, responses } = reviewHandler({ runs: { 'run-1': { id: 'run-1', projectId: 'project-1' } } })
  await handler(
    { method: 'GET', headers: {} }, {},
    new URL('http://botanic.test/api/agent-runs/run-1/review-tasks'),
    { agentRunReviewTasks: ['path', 'run-1'] }, 'request-review-read',
  )
  assert.equal(responses.at(-1)?.status, 200)
  const task = responses.at(-1)?.body.tasks[0]
  assert.equal(task.coverage.strategy, 'all')
  assert.equal(task.coverage.skippedCandidates, 0)
  assert.equal(task.results.length, 2)
  // ownerId 不外发。
  assert.equal(task.ownerId, undefined)
})

test('批量人工决定逐候选落库，重复提交幂等', async () => {
  reviewHandler.body = {
    decisions: [
      { artifactId: 'artifact-1', decision: 'accepted' },
      { artifactId: 'artifact-2', decision: 'rejected', note: '背景过曝' },
    ],
  }
  const stored = []
  const { handler, responses } = reviewHandler({ stored })
  const send = () => handler(
    { method: 'POST', headers: { 'idempotency-key': 'review-decision-batch-1' } }, {},
    new URL('http://botanic.test/api/agent-review-tasks/review_task_1/decisions'),
    { agentReviewTaskDecisions: ['path', 'review_task_1'] }, 'request-decision',
  )
  await send()
  assert.equal(responses.at(-1)?.status, 200)
  const body = responses.at(-1)?.body
  assert.deepEqual(body.decisions.map((item) => item.artifactId), ['artifact-1', 'artifact-2'])
  // 批量共享 commandId，但逐候选各自落库。
  assert.equal(new Set(body.decisions.map((item) => item.commandId)).size, 1)
  assert.equal(new Set(body.decisions.map((item) => item.id)).size, 2)
  // 候选状态被更新，但原结论与 Artifact 不被覆盖。
  assert.equal(body.task.results.find((item) => item.artifactId === 'artifact-1').candidateStatus, 'accepted')
  assert.equal(body.task.results.find((item) => item.artifactId === 'artifact-2').verdict, 'fail')

  await send()
  const repeated = responses.at(-1)?.body
  assert.equal(repeated.task.decisions.length, 2)
})

test('决定的候选必须在本次评审覆盖范围内', async () => {
  reviewHandler.body = { artifactId: 'artifact-outside', decision: 'accepted' }
  const { handler, responses } = reviewHandler()
  await handler(
    { method: 'POST', headers: { 'idempotency-key': 'review-decision-outside' } }, {},
    new URL('http://botanic.test/api/agent-review-tasks/review_task_1/decisions'),
    { agentReviewTaskDecisions: ['path', 'review_task_1'] }, 'request-decision-outside',
  )
  assert.equal(responses.at(-1)?.status, 409)
  assert.equal(responses.at(-1)?.body.error.code, 'AGENT_REVIEW_ARTIFACT_NOT_COVERED')
})

test('请求重试产生关联原 Run 与原 Artifact 的新 Run，原结果不被覆盖', async () => {
  reviewHandler.body = { artifactId: 'artifact-1', decision: 'retry_requested' }
  const sourceRun = {
    id: 'run-1', projectId: 'project-1', ownerId: 'user-1', status: 'completed',
    plan: {
      intent: 'replace_scene', instruction: '换场景', summary: '换场景',
      selectedResultNodeId: 'result-1', prompt: '换成海边。',
      settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
      constraints: [], output: { mode: 'single', count: 1, candidatesPerItem: 1 },
    },
    branches: [{ id: 'branch-a', label: '海边', status: 'succeeded', attempt: 0, jobIds: ['job-a'], outputCount: 1, updatedAt: 1 }],
    createdAt: 1, updatedAt: 2,
  }
  const stored = []
  const { handler, responses } = reviewHandler({ runs: { 'run-1': sourceRun }, stored })
  await handler(
    { method: 'POST', headers: { 'idempotency-key': 'review-decision-retry' } }, {},
    new URL('http://botanic.test/api/agent-review-tasks/review_task_1/decisions'),
    { agentReviewTaskDecisions: ['path', 'review_task_1'] }, 'request-decision-retry',
  )

  assert.equal(responses.at(-1)?.status, 200)
  const retry = responses.at(-1)?.body.retryRuns?.[0]
  assert.equal(retry.artifactId, 'artifact-1')
  const created = stored.find((item) => item.id === retry.runId)
  assert.equal(created.lineage.parentRunId, 'run-1')
  assert.equal(created.lineage.reviewTaskId, 'review_task_1')
  assert.equal(created.lineage.sourceArtifactId, 'artifact-1')
  // 重试请求让候选回到待评审，不标记为拒绝，也不覆盖原结论。
  assert.equal(responses.at(-1)?.body.task.results.find((item) => item.artifactId === 'artifact-1').candidateStatus, 'pending_review')
})

test('运维只读工具接入回合：模型能拿到真实任务状态，且不含媒体地址', async () => {
  // 「不根据对话文案猜任务状态」的落点：工具在回合注册表里，且返回结构化实体状态。
  const { createBotanicAgentOperationalToolDefinitions } = await import('./botanicAgentOperationalTools.mjs')
  const definitions = createBotanicAgentOperationalToolDefinitions({
    readRun: async () => ({ id: 'run-1', status: 'partial', branches: [{ id: 'b', status: 'failed', attempt: 1 }] }),
  })
  assert.deepEqual(definitions.map((tool) => tool.name), ['agent_run_read'])
  const result = await definitions[0].execute({ runId: 'run-1' })
  assert.equal(result.run.status, 'partial')
})

test('写工具按项目角色进注册表：Viewer 一个都拿不到', async () => {
  const { createBotanicAgentActionToolRegistry } = await import('./botanicAgentTools.mjs')
  const executors = {
    cancelRun: async () => ({}), decideReview: async () => ({}),
    promoteArtifact: async () => ({}), retryWorkflowFailed: async () => ({}),
  }
  const viewer = createBotanicAgentActionToolRegistry({ role: 'viewer', ...executors })
  assert.equal(viewer.get('agent_run_cancel'), undefined)
  assert.equal(viewer.get('review_decide'), undefined)

  const editor = createBotanicAgentActionToolRegistry({ role: 'editor', ...executors })
  assert.ok(editor.get('agent_run_cancel'))
  assert.ok(editor.get('review_decide'))
  // 全部需要确认：会花钱或改变可交付状态的动作不能因为「Agent 说要做」就执行。
  assert.equal(editor.get('agent_run_cancel').requiresConfirmation, true)
  assert.equal(editor.get('review_decide').requiresConfirmation, true)
})

test('服务端权限表与工具暴露判定同源，不会出现看不到却调得动', async () => {
  const { agentToolPermission } = await import('./agentActionGovernance.mjs')
  const { OPERATIONAL_ACTION_TOOLS, operationalActionToolsForRole } = await import('./botanicAgentOperationalTools.mjs')
  const { projectPermissionDecision } = await import('./authorization.mjs')
  for (const role of ['viewer', 'editor', 'owner']) {
    const exposed = new Set(operationalActionToolsForRole(role))
    for (const name of OPERATIONAL_ACTION_TOOLS) {
      const serverAllows = projectPermissionDecision(role, agentToolPermission(name)) === 'allow'
      assert.equal(exposed.has(name), serverAllows, `${role} 对 ${name} 的暴露与放行判定不一致`)
    }
  }
})
