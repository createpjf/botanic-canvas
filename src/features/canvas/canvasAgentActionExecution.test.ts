import assert from 'node:assert/strict'
import test from 'node:test'
import {
  projectAcceptedAgentRunBestEffort,
  preserveCanvasAgentActionError,
} from './canvasAgentActionExecution.ts'

class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(
    message: string,
    status: number,
    code: string,
  ) {
    super(message)
    this.name = 'ProductApiError'
    this.status = status
    this.code = code
  }
}

test('画布行动边界本地化错误时保留 API 错误身份、状态码与业务码', () => {
  const source = new ApiError('raw timeout', 504, 'AGENT_ACTION_TIMEOUT')

  const localized = preserveCanvasAgentActionError(source, '行动结果未知，请人工核对。')

  assert.equal(localized, source)
  assert.ok(localized instanceof ApiError)
  assert.equal(localized.message, '行动结果未知，请人工核对。')
  assert.equal(localized.status, 504)
  assert.equal(localized.code, 'AGENT_ACTION_TIMEOUT')
})

test('Run 已被服务端接受后，本地投影与 Canvas flush 失败不能把计划降级为提交失败', async () => {
  const calls: string[] = []
  const settlement = await projectAcceptedAgentRunBestEffort({
    apply: () => {
      calls.push('apply')
      throw new Error('local projection failed')
    },
    flush: async () => {
      calls.push('flush')
      throw Object.assign(new Error('unrelated canvas conflict'), { status: 409, code: 'PROJECT_CONFLICT' })
    },
  })

  assert.deepEqual(calls, ['apply', 'flush'])
  assert.deepEqual(settlement, { applied: false, flushed: false })
})
