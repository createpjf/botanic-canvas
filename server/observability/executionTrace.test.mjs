import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EXECUTION_STAGES,
  executionTraceId,
  isExecutionStage,
  redactSensitive,
  stageError,
} from './executionTrace.mjs'

test('阶段词表覆盖失败可定位原则要求的全部环节，并含显式 unknown', () => {
  for (const stage of ['turn', 'compile', 'approval', 'queue', 'provider', 'media', 'canvas', 'artifact', 'review', 'delivery']) {
    assert.ok(isExecutionStage(stage), `词表缺少阶段 ${stage}`)
  }
  // 判不出来时要有明确的「不知道」，而不是被迫猜一个具体阶段。
  assert.ok(isExecutionStage('unknown'))
  assert.equal(isExecutionStage('provider_maybe'), false)
  assert.equal(isExecutionStage(undefined), false)
  assert.equal(new Set(EXECUTION_STAGES).size, EXECUTION_STAGES.length, '词表不得有重复项')
})

test('trace 标识优先使用已传播的值，其次 Turn，再退到 Run 与 Job', () => {
  // 已传播的永远优先：trace 的正确模型是起始实体生成一次、下游携带。
  assert.equal(executionTraceId({ traceId: 'trace-abc', turnId: 't', runId: 'r' }), 'trace-abc')
  // Turn 在场时以 Turn 为根，同一 Turn 委托的多个 Run 才能归到一条链路。
  assert.equal(executionTraceId({ turnId: 'turn-1', runId: 'run-1' }), 'agent-trace:turn:turn-1')
  // 既有格式保持不变，本次改动不改任何现有 ID。
  assert.equal(executionTraceId({ runId: 'run-1' }), 'agent-trace:run-1')
  // 没有 Turn 也没有 Run 的路径（HTTP 直接生成、Workflow 批量项）仍可关联。
  assert.equal(executionTraceId({ jobId: 'job-1' }), 'agent-trace:job:job-1')
  assert.equal(executionTraceId({}), undefined)
  assert.equal(executionTraceId(), undefined)
})

test('错误摘要脱敏内联媒体、URL、密钥与 JWT', () => {
  assert.equal(
    redactSensitive('provider 返回 https://cdn.example.com/private/a.png?sig=abc 失败'),
    'provider 返回 [redacted-url] 失败',
  )
  assert.equal(redactSensitive('输入 data:image/png;base64,iVBORw0KGgoAAAANSUhEUg 太大'), '输入 [redacted-inline-media] 太大')
  assert.equal(redactSensitive('key sk-abcdefghijklmnop 无效'), 'key [redacted-key] 无效')
  assert.equal(redactSensitive('Authorization: Bearer abcdefghijklmnopqrst'), 'Authorization: [redacted-token]')
  assert.match(redactSensitive('token eyJhbGciOiJI.eyJzdWIiOiIx.QWERTY'), /\[redacted-jwt\]/u)
  assert.equal(redactSensitive(''), '')
  assert.equal(redactSensitive(undefined), '')
  assert.equal(redactSensitive('x'.repeat(900)).length, 500)
})

test('阶段错误把未知阶段收敛为 unknown，不抛错也不猜具体阶段', () => {
  assert.deepEqual(stageError({ stage: 'provider', code: 'PROVIDER_TIMEOUT', recoverable: true }), {
    stage: 'provider', code: 'PROVIDER_TIMEOUT', recoverable: true,
  })
  // 可观测性不得改变业务状态，因此分类不出来时不能再抛第二个错误。
  assert.deepEqual(stageError({ stage: '队列相关', code: 'X' }), { stage: 'unknown', code: 'X' })
  assert.deepEqual(stageError({}), { stage: 'unknown', code: 'UNSPECIFIED_ERROR' })
  // 消息同样脱敏。
  assert.deepEqual(stageError({ stage: 'media', message: '上传到 https://s3.example.com/x 失败' }), {
    stage: 'media', code: 'UNSPECIFIED_ERROR', message: '上传到 [redacted-url] 失败',
  })
})
