import assert from 'node:assert/strict'
import test from 'node:test'
import { agentRunOperationalPayload, writeAgentRunOperationalEvent } from './agentRunObservability.mjs'

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
