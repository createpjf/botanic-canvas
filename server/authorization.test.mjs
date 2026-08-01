import assert from 'node:assert/strict'
import test from 'node:test'
import {
  projectPermissionDecision,
  workspacePermissionDecision,
} from './authorization.mjs'

test('项目角色权限矩阵区分读取、编辑、成员管理、删除与审计', () => {
  assert.equal(projectPermissionDecision('viewer', 'read'), 'allow')
  assert.equal(projectPermissionDecision('viewer', 'edit'), 'forbidden')
  assert.equal(projectPermissionDecision('editor', 'edit'), 'allow')
  assert.equal(projectPermissionDecision('editor', 'manage-members'), 'forbidden')
  assert.equal(projectPermissionDecision('owner', 'delete'), 'allow')
  assert.equal(projectPermissionDecision('owner', 'read-audit'), 'allow')
  assert.equal(projectPermissionDecision(undefined, 'read'), 'forbidden')
})

test('工作区敏感权限只授予启用的 Owner', () => {
  assert.equal(workspacePermissionDecision({ role: 'owner', status: 'active' }, 'manage-members'), 'allow')
  assert.equal(workspacePermissionDecision({ role: 'owner', status: 'active' }, 'manage-library'), 'allow')
  assert.equal(workspacePermissionDecision({ role: 'owner', status: 'active' }, 'read-audit'), 'allow')
  assert.equal(workspacePermissionDecision({ role: 'member', status: 'active' }, 'manage-library'), 'forbidden')
  assert.equal(workspacePermissionDecision({ role: 'owner', status: 'disabled' }, 'read-audit'), 'forbidden')
})
