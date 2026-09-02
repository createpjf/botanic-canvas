import assert from 'node:assert/strict'
import test from 'node:test'
import {
  adaptAgentRunOperationalEvent,
  agentRunOperationalPayload,
  writeAgentRunOperationalEvent,
} from './agentRunObservability.mjs'
import { AGENT_SEMANTIC_EVENT_NAMES } from '../../observability/agentSemanticEvent.mjs'

test('Agent 运行日志只保留运维字段，不泄露 Prompt、媒体或用户内容', () => {
  const payload = agentRunOperationalPayload({
    type: 'worker_completed',
    projectId: 'project-a',
    runId: 'run-a',
    jobId: 'job-a',
    status: 'succeeded',
    outputCount: 2,
    queueDurationMs: 120,
    projectWritebackPending: false,
    prompt: '私密提示词',
    media: ['private-image'],
    email: 'user@example.com',
  }, '2026-08-07T00:00:00.000Z')

  assert.deepEqual(payload, {
    event: 'agent.run.worker_completed',
    occurredAt: '2026-08-07T00:00:00.000Z',
    projectId: 'project-a',
    runId: 'run-a',
    traceId: 'agent-trace:run-a',
    status: 'succeeded',
    jobId: 'job-a',
    queueDurationMs: 120,
    outputCount: 2,
    projectWritebackPending: false,
  })
  assert.doesNotMatch(JSON.stringify(payload), /私密提示词|private-image|example\.com/)
})

test('Agent 日志写入失败不会打断业务链路', () => {
  assert.doesNotThrow(() => writeAgentRunOperationalEvent({ type: 'created' }, {
    log() { throw new Error('日志服务不可用') },
  }))
})

test('旧 agent.run 输入可旁路适配为固定 semantic lifecycle，且不携带任意 message', () => {
  const semantic = adaptAgentRunOperationalEvent({
    type: 'worker_failed',
    requestId: 'request-a',
    projectId: 'project-a',
    runId: 'run-a',
    branchId: 'branch-a',
    jobId: 'job-a',
    status: 'failed',
    durationMs: 123,
    code: 'PROVIDER_TIMEOUT',
    retryable: true,
    message: 'https://private.example?token=secret',
    prompt: '私密提示词',
    traceId: '0123456789abcdef0123456789abcdef',
    spanId: '0123456789abcdef',
  }, '2026-08-07T00:00:00.000Z')

  assert.equal(semantic.event, AGENT_SEMANTIC_EVENT_NAMES.RUN_LIFECYCLE)
  assert.equal(semantic.phase, 'execution')
  assert.equal(semantic.outcome, 'failed')
  assert.equal(semantic.traceId, '0123456789abcdef0123456789abcdef')
  assert.deepEqual(semantic.error, { code: 'PROVIDER_TIMEOUT', retryable: true })
  assert.doesNotMatch(JSON.stringify(semantic), /private|secret|私密|message|prompt/u)
  assert.equal(adaptAgentRunOperationalEvent({ type: 'future_unknown_event' }), undefined)
})

test('旁路双写保持 legacy 原事件不变，semantic logger 失败也不影响 legacy', () => {
  const legacy = []
  const semantic = []
  writeAgentRunOperationalEvent({
    type: 'worker_completed', projectId: 'project-a', runId: 'run-a', status: 'succeeded', outputCount: 2,
  }, {
    log(line) { legacy.push(JSON.parse(line)) },
  }, {
    semanticLogger: { log(line) { semantic.push(JSON.parse(line)) } },
  })

  assert.equal(legacy.length, 1)
  assert.equal(legacy[0].event, 'agent.run.worker_completed')
  assert.equal(semantic.length, 1)
  assert.equal(semantic[0].event, AGENT_SEMANTIC_EVENT_NAMES.RUN_LIFECYCLE)

  assert.doesNotThrow(() => writeAgentRunOperationalEvent({ type: 'created' }, {
    log(line) { legacy.push(JSON.parse(line)) },
  }, {
    semanticLogger: { log() { throw new Error('semantic sink 不可用') } },
  }))
  assert.equal(legacy.length, 2)
})
