import assert from 'node:assert/strict'
import test from 'node:test'
import { requireProjectPermission } from './projectAuthorization.mjs'

test('已存在项目的跨账号访问统一拒绝为 403', async () => {
  const store = { async projectAccess() { return { exists: true, role: undefined } } }
  await assert.rejects(
    () => requireProjectPermission(store, 'other-user', 'project-a', 'read'),
    (error) => error?.statusCode === 403 && error?.code === 'PROJECT_ACCESS_FORBIDDEN',
  )
})

test('不存在项目保持 404，避免把缺失对象误报为权限问题', async () => {
  const store = { async projectAccess() { return { exists: false, role: undefined } } }
  await assert.rejects(
    () => requireProjectPermission(store, 'user-a', 'missing-project', 'read'),
    (error) => error?.statusCode === 404 && error?.code === 'PROJECT_NOT_FOUND',
  )
})

test('编辑者可写但不能管理成员，Owner 可执行全部项目敏感操作', async () => {
  const editorStore = { async projectAccess() { return { exists: true, role: 'editor' } } }
  assert.deepEqual(await requireProjectPermission(editorStore, 'editor', 'project-a', 'edit'), { exists: true, role: 'editor' })
  await assert.rejects(
    () => requireProjectPermission(editorStore, 'editor', 'project-a', 'manage-members'),
    (error) => error?.statusCode === 403,
  )
  const ownerStore = { async projectAccess() { return { exists: true, role: 'owner' } } }
  assert.equal((await requireProjectPermission(ownerStore, 'owner', 'project-a', 'read-audit')).role, 'owner')
})
