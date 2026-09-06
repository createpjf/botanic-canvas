import assert from 'node:assert/strict'
import test from 'node:test'
import { retryCanvasRealtimeSync, type CanvasRealtimeRetryAttempt } from './canvasRealtimeRetry.ts'

test('两个同步重试入口共用本次请求，发起成功不改同步权威状态，旧项目响应不落地', async () => {
  let finish!: () => void
  let current = true
  let calls = 0
  const states: unknown[] = []
  const presentation = { realtimeRetryError: '修改未被接受，本地修改仍保留。请重新打开项目。' }
  const inFlight: { current: CanvasRealtimeRetryAttempt | null } = { current: null }
  const collaboration = { retryBlocked: () => { calls += 1; return new Promise<void>((resolve) => { finish = resolve }) } }
  const input = { projectId: 'project-1', collaboration, inFlight, isCurrent: () => current, onState: (state: unknown) => { states.push(state); Object.assign(presentation, state) }, locale: 'zh-CN' as const }
  const first = retryCanvasRealtimeSync(input)
  const second = retryCanvasRealtimeSync(input)
  assert.equal(first, second)
  await Promise.resolve()
  assert.equal(calls, 1)
  finish()
  await first
  assert.equal(presentation.realtimeRetryError, '修改未被接受，本地修改仍保留。请重新打开项目。', '发起重试不代表所有失败项已恢复，保留原因直到权威状态更新')
  assert.deepEqual(states, [{ realtimeRetrying: true }, { realtimeRetrying: false }])
  assert.equal(inFlight.current, null)

  states.length = 0
  const previous = retryCanvasRealtimeSync(input)
  await Promise.resolve()
  current = false
  finish()
  await previous
  assert.deepEqual(states, [{ realtimeRetrying: true }], '切项目后旧请求不能更新新界面')
  assert.equal(inFlight.current, null)
})

test('无协作实例或重试失败必须拒绝，保留安全原因并允许再次操作', async () => {
  const states: { realtimeRetrying?: boolean; realtimeRetryError?: string }[] = []
  const inFlight: { current: CanvasRealtimeRetryAttempt | null } = { current: null }
  const input = { projectId: 'project-1', collaboration: null, inFlight, isCurrent: () => true, onState: (state: typeof states[number]) => states.push(state), locale: 'zh-CN' as const }
  await assert.rejects(retryCanvasRealtimeSync(input), { code: 'CANVAS_COLLABORATION_UNAVAILABLE' })
  assert.equal(states[1].realtimeRetryError, '协作连接不可用，请重新打开项目。')
  assert.equal(states.at(-1)?.realtimeRetrying, false)
  assert.equal(inFlight.current, null)

  const collaboration = { retryBlocked: async () => { throw Object.assign(new Error('private transport payload'), { code: 'PERMISSION_REVOKED' }) } }
  states.length = 0
  await assert.rejects(retryCanvasRealtimeSync({ ...input, collaboration }), { code: 'PERMISSION_REVOKED' })
  assert.equal(states[1].realtimeRetryError, '没有画布编辑权限，请恢复权限后重试。')
  assert.equal(states.at(-1)?.realtimeRetrying, false)
})
