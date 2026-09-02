import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAgentExecutionTrace, agentExecutionTraceId } from './agentExecutionTrace.mjs'

test('执行链路用稳定 Run 关联标识串联 Planner、Skill、工具、Job 与 Artifact', () => {
  const run = {
    id: 'run-1', projectId: 'project-1', status: 'partial', createdAt: 100, updatedAt: 500,
    plan: {
      plannerModel: 'deepseek-v4-pro',
      toolCalls: [{ id: 'tool-1', name: 'generation_submit', label: '提交生成', status: 'succeeded', risk: 'costly', requiresConfirmation: true }],
    },
    branches: [
      { id: 'branch-a', status: 'succeeded', attempt: 0, jobIds: ['job-a'], outputCount: 1, updatedAt: 400 },
      { id: 'branch-b', status: 'failed', attempt: 1, jobIds: ['job-b-1', 'job-b-2'], activeJobId: 'job-b-2', outputCount: 0, error: '失败', updatedAt: 500 },
    ],
  }
  const jobs = [
    { id: 'job-a', status: 'succeeded', createdAt: 180, updatedAt: 400, outputs: [{ id: 'out-a' }], projectWritebackPending: false },
    { id: 'job-b-2', status: 'failed', createdAt: 220, updatedAt: 500, outputs: [], error: '失败', projectWritebackPending: true, projectWritebackAttempts: 2 },
  ]
  const artifacts = [{ id: 'generation:job-a:out-a', provenance: { runId: 'run-1' }, origin: { jobId: 'job-a', outputId: 'out-a' } }]

  const trace = buildAgentExecutionTrace({ run, jobs, artifacts, sessionId: 'session-1', messageId: 'message-1' })

  assert.equal(trace.traceId, agentExecutionTraceId('run-1'))
  assert.equal(trace.links.sessionId, 'session-1')
  assert.equal(trace.links.messageId, 'message-1')
  assert.equal(trace.links.plannerModel, 'deepseek-v4-pro')
  assert.deepEqual(trace.links.toolCallIds, ['tool-1'])
  assert.deepEqual(trace.links.jobIds, ['job-a', 'job-b-2'])
  assert.deepEqual(trace.links.artifactIds, ['generation:job-a:out-a'])
  assert.equal(trace.failure.stage, 'writeback')
  assert.equal(trace.failure.code, 'PROJECT_WRITEBACK_PENDING')
  assert.equal(trace.metrics.retryCount, 1)
  assert.equal(trace.metrics.outputCount, 1)
  assert.equal(trace.metrics.writebackComplete, false)
})

test('执行链路不返回 Prompt、媒体地址或 Provider 原始请求', () => {
  const trace = buildAgentExecutionTrace({
    run: { id: 'run-secret', projectId: 'project-1', status: 'failed', createdAt: 1, updatedAt: 2, plan: { prompt: '私密 Prompt' }, branches: [] },
    jobs: [{ id: 'job-secret', status: 'failed', rawInput: { prompt: 'secret', image: 'data:image/png;base64,AAAA' }, createdAt: 1, updatedAt: 2 }],
    artifacts: [{ id: 'artifact-secret', url: 'https://private.example/image.png', provenance: { runId: 'run-secret' } }],
  })
  assert.doesNotMatch(JSON.stringify(trace), /私密|base64|private\.example|rawInput/)
})
