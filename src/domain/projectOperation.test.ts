import assert from 'node:assert/strict'
import test from 'node:test'
import { projectOperationDisposition } from './projectOperation.ts'

test('异步结果只在原项目仍为当前项目且请求仍为最新时回写', () => {
  assert.equal(projectOperationDisposition({
    originProjectId: 'project-a',
    activeProjectId: 'project-a',
    requestId: 3,
    latestRequestId: 3,
  }), 'apply')
})

test('用户切换项目后，旧项目异步结果转为后台完成且不写入当前画布', () => {
  assert.equal(projectOperationDisposition({
    originProjectId: 'project-a',
    activeProjectId: 'project-b',
    requestId: 3,
    latestRequestId: 3,
  }), 'detached')
})

test('同一项目较旧的异步响应不得覆盖较新的用户意图', () => {
  assert.equal(projectOperationDisposition({
    originProjectId: 'project-a',
    activeProjectId: 'project-a',
    requestId: 2,
    latestRequestId: 3,
  }), 'superseded')
})
