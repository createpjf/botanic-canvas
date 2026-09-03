import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AGENT_SEMANTIC_EVENT_NAMES,
  AGENT_SEMANTIC_EVENT_SCHEMA,
  AGENT_SEMANTIC_EVENT_SCHEMA_VERSION,
  createAgentSemanticEvent,
  writeAgentSemanticEvent,
} from './agentSemanticEvent.mjs'

const occurredAt = '2026-08-28T00:00:00.000Z'
const trace = {
  traceId: '0123456789ABCDEF0123456789ABCDEF',
  spanId: '0123456789ABCDEF',
  traceFlags: 1,
}

test('固定 semantic schema 只投影 allowlist，不接收任意 attributes 或敏感内容', () => {
  const event = createAgentSemanticEvent(AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_COMPACTION_RESULT, {
    ...trace,
    projectId: 'project-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    compactionId: 'compaction-1',
    outcome: 'compacted',
    trigger: 'pre_step',
    inputTokensBefore: 8_000,
    inputTokensAfter: 3_000,
    replacedMessageCount: 12,
    durationMs: 25,
    prompt: '私密提示词',
    rawReasoning: '完整思维链',
    reasoning_content: 'Provider 推理',
    providerBody: { output: 'secret' },
    mediaUrl: 'https://private.example/image.png',
    authorization: 'Bearer secret',
    token: 'secret-token',
    message: '任意用户消息',
    attributes: { prompt: '不能进入事件' },
  }, occurredAt)

  assert.deepEqual(event, {
    schema: AGENT_SEMANTIC_EVENT_SCHEMA,
    schemaVersion: AGENT_SEMANTIC_EVENT_SCHEMA_VERSION,
    event: AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_COMPACTION_RESULT,
    occurredAt,
    traceId: '0123456789abcdef0123456789abcdef',
    spanId: '0123456789abcdef',
    traceFlags: 1,
    outcome: 'compacted',
    trigger: 'pre_step',
    projectId: 'project-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    compactionId: 'compaction-1',
    inputTokensBefore: 8_000,
    inputTokensAfter: 3_000,
    replacedMessageCount: 12,
    durationMs: 25,
  })
  assert.doesNotMatch(JSON.stringify(event), /私密|思维链|Provider|private\.example|Bearer|secret|attributes|message/u)
})

test('Canvas 生命周期只投影低基数状态和有界计数', () => {
  const event = createAgentSemanticEvent(AGENT_SEMANTIC_EVENT_NAMES.CANVAS_LIFECYCLE, {
    kind: 'proposal', outcome: 'completed', mode: 'nodes', completeness: 'truncated',
    durationMs: 12, returnedCount: 4, operationCount: 3, changeCount: 5, artifactCount: 1,
    projectId: 'project-secret', prompt: '私密提示词', mediaUrl: 'https://private.example/image.png',
  }, occurredAt)
  assert.deepEqual(event, {
    schema: AGENT_SEMANTIC_EVENT_SCHEMA, schemaVersion: AGENT_SEMANTIC_EVENT_SCHEMA_VERSION,
    event: AGENT_SEMANTIC_EVENT_NAMES.CANVAS_LIFECYCLE, occurredAt,
    kind: 'proposal', outcome: 'completed', mode: 'nodes', completeness: 'truncated',
    durationMs: 12, returnedCount: 4, operationCount: 3, changeCount: 5, artifactCount: 1,
  })
  assert.doesNotMatch(JSON.stringify(event), /secret|私密|private.example/u)
})

test('error 只保留 code 与 retryable，message/stack/cause 不会落日志', () => {
  const event = createAgentSemanticEvent(AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_OVERFLOW_RESULT, {
    outcome: 'failed',
    retryCount: 1,
    error: {
      code: 'AGENT_CONTEXT_OVERFLOW',
      retryable: false,
      message: '包含 Prompt 的异常',
      stack: 'https://private.example',
      cause: { providerBody: 'secret' },
    },
  }, occurredAt)

  assert.deepEqual(event.error, { code: 'AGENT_CONTEXT_OVERFLOW', retryable: false })
  assert.doesNotMatch(JSON.stringify(event), /Prompt|private|providerBody|secret/u)
})

test('rollout 事件固定 feature/cohort/mode，且不记录灰度目标 ID', () => {
  const event = createAgentSemanticEvent(AGENT_SEMANTIC_EVENT_NAMES.ROLLOUT_EVALUATED, {
    ...trace,
    feature: 'AGENT_CONTEXT_COMPACTION_V2',
    decision: 'enabled',
    cohort: 'treatment',
    mode: 'scoped',
    userId: 'user-secret',
    projectId: 'project-secret',
    selector: 'user:user-secret',
  }, occurredAt)

  assert.equal(event.feature, 'AGENT_CONTEXT_COMPACTION_V2')
  assert.equal(event.cohort, 'treatment')
  assert.equal(event.mode, 'scoped')
  assert.equal(event.userId, undefined)
  assert.equal(event.projectId, undefined)
  assert.equal(event.selector, undefined)
})

test('六类事件都要求固定 enum，不接受动态事件名或动态状态', () => {
  assert.throws(
    () => createAgentSemanticEvent('botanic.agent.custom', {}, occurredAt),
    /event name/u,
  )
  assert.throws(
    () => createAgentSemanticEvent(AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_SHADOW_EVALUATED, {
      outcome: 'maybe', trigger: 'pre_step',
    }, occurredAt),
    /shadow outcome/u,
  )
  assert.throws(
    () => createAgentSemanticEvent(AGENT_SEMANTIC_EVENT_NAMES.ROLLOUT_EVALUATED, {
      feature: 'AGENT_UNKNOWN_FLAG', decision: 'enabled', cohort: 'treatment',
    }, occurredAt),
    /rollout feature/u,
  )
})

test('ID、计数、耗时、Token 与 W3C Trace 均有严格边界', () => {
  const compaction = (overrides = {}) => createAgentSemanticEvent(
    AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_COMPACTION_RESULT,
    { outcome: 'compacted', trigger: 'pre_step', ...overrides },
    occurredAt,
  )

  assert.throws(() => compaction({ projectId: 'https://private.example/project' }), /projectId/u)
  assert.throws(() => compaction({ replacedMessageCount: -1 }), /replacedMessageCount/u)
  assert.throws(() => compaction({ durationMs: 7 * 24 * 60 * 60 * 1_000 + 1 }), /durationMs/u)
  assert.throws(() => compaction({ inputTokensBefore: 1, inputTokensAfter: 2 }), /token delta/u)
  assert.throws(() => compaction({ traceId: '0'.repeat(32), spanId: '1'.repeat(16) }), /trace correlation/u)
  assert.throws(() => compaction({ traceId: '1'.repeat(32) }), /trace correlation/u)
  assert.throws(() => compaction({ traceFlags: 1 }), /traceFlags/u)

  const anchor = createAgentSemanticEvent(AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_USAGE_ANCHOR_RESULT, {
    outcome: 'persisted', inputTokens: 10, outputTokens: 5, totalTokens: 15,
  }, occurredAt)
  assert.equal(anchor.totalTokens, 15)
  assert.throws(() => createAgentSemanticEvent(AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_USAGE_ANCHOR_RESULT, {
    outcome: 'persisted', inputTokens: 10, outputTokens: 5, totalTokens: 14,
  }, occurredAt), /totalTokens/u)

  const stream = createAgentSemanticEvent(AGENT_SEMANTIC_EVENT_NAMES.HARNESS_LIFECYCLE, {
    kind: 'provider', outcome: 'stream_completed', durationMs: 420, chunkCount: 8, maxChunkGapMs: 65,
    prompt: '不得记录', turnId: 'turn-secret',
  }, occurredAt)
  assert.deepEqual({
    outcome: stream.outcome, durationMs: stream.durationMs,
    chunkCount: stream.chunkCount, maxChunkGapMs: stream.maxChunkGapMs,
  }, { outcome: 'stream_completed', durationMs: 420, chunkCount: 8, maxChunkGapMs: 65 })
  assert.equal(stream.prompt, undefined)
  const preview = createAgentSemanticEvent(AGENT_SEMANTIC_EVENT_NAMES.HARNESS_LIFECYCLE, {
    kind: 'preview', outcome: 'preview_cancelled', reason: 'CANCELLED',
    writeCount: 4, maxCharCount: 2_048, nonEmptyCount: 1, content: '不得记录',
  }, occurredAt)
  assert.deepEqual({
    kind: preview.kind, outcome: preview.outcome, reason: preview.reason,
    writeCount: preview.writeCount, maxCharCount: preview.maxCharCount, nonEmptyCount: preview.nonEmptyCount,
  }, { kind: 'preview', outcome: 'preview_cancelled', reason: 'CANCELLED', writeCount: 4, maxCharCount: 2_048, nonEmptyCount: 1 })
  assert.equal(preview.content, undefined)
})

test('writer 对 schema、序列化和 logger 故障全部 fail-open', () => {
  assert.doesNotThrow(() => writeAgentSemanticEvent('unknown', { prompt: 'secret' }, {
    log() { throw new Error('不应执行') },
  }, occurredAt))
  assert.equal(writeAgentSemanticEvent('unknown', {}, console, occurredAt), undefined)
  assert.doesNotThrow(() => writeAgentSemanticEvent(
    AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_OVERFLOW_RESULT,
    { outcome: 'recovered', retryCount: 1 },
    { log() { throw new Error('日志服务不可用') } },
    occurredAt,
  ))

  const lines = []
  const written = writeAgentSemanticEvent(
    AGENT_SEMANTIC_EVENT_NAMES.CONTEXT_OVERFLOW_RESULT,
    { outcome: 'recovered', retryCount: 1 },
    { log(line) { lines.push(JSON.parse(line)) } },
    occurredAt,
  )
  assert.equal(lines.length, 1)
  assert.deepEqual(lines[0], written)
})
