import assert from 'node:assert/strict'
import test from 'node:test'
import {
  sameWorkspaceLocation,
  workspaceHash,
  workspaceLocationFromHash,
} from './canvasWorkspaceNavigation.ts'

test('工作区 hash 往返保留包含空格和中文的项目标识', () => {
  const location = { view: 'canvas' as const, projectId: '夏日 项目/01' }
  const hash = workspaceHash(location)

  assert.equal(hash, '#/canvas/%E5%A4%8F%E6%97%A5%20%E9%A1%B9%E7%9B%AE%2F01')
  assert.deepEqual(workspaceLocationFromHash(hash), location)
})

test('工作区路由拒绝空项目和畸形编码', () => {
  assert.equal(workspaceLocationFromHash('#/canvas/'), null)
  assert.equal(workspaceLocationFromHash('#/canvas/%E0%A4%A'), null)
  assert.equal(workspaceLocationFromHash('#/unknown'), null)
})

test('工作区位置比较同时检查视图和项目', () => {
  assert.equal(sameWorkspaceLocation({ view: 'canvas', projectId: 'a' }, { view: 'canvas', projectId: 'a' }), true)
  assert.equal(sameWorkspaceLocation({ view: 'canvas', projectId: 'a' }, { view: 'canvas', projectId: 'b' }), false)
  assert.equal(sameWorkspaceLocation({ view: 'projects' }, { view: 'projects' }), true)
})
