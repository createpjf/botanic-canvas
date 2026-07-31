import assert from 'node:assert/strict'
import test from 'node:test'
import { productRequestTimeoutFor } from './productRequestPolicy.ts'

test('提示词润色等待窗口长于 Flock 服务端窗口，普通业务请求仍保持快速失败', () => {
  assert.equal(productRequestTimeoutFor('/api/projects'), 15_000)
  assert.equal(productRequestTimeoutFor('/api/prompt-refinements'), 45_000)
})
