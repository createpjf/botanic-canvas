const projectPermissions = Object.freeze({
  owner: new Set([
    'read', 'edit', 'create-generation', 'delete-content', 'modify-workflow',
    'execute-external-tool', 'manage-members', 'delete-project', 'read-audit', 'read-operational',
  ]),
  editor: new Set(['read', 'edit', 'create-generation', 'delete-content', 'modify-workflow']),
  viewer: new Set(['read']),
})

const workspacePermissions = Object.freeze({
  owner: new Set(['manage-members', 'manage-library', 'read-audit']),
  member: new Set(),
})

export function projectPermissionDecision(role, permission) {
  return role && projectPermissions[role]?.has(permission) ? 'allow' : 'forbidden'
}

export function workspacePermissionDecision(user, permission) {
  if (!user || user.status === 'disabled') return 'forbidden'
  return workspacePermissions[user.role]?.has(permission) ? 'allow' : 'forbidden'
}

export function productAuthorizationError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

export function assertProjectPermission(role, permission, code = 'PROJECT_ACCESS_FORBIDDEN') {
  if (projectPermissionDecision(role, permission) === 'allow') return
  throw productAuthorizationError('你没有执行该项目操作的权限。', code)
}

export function assertWorkspacePermission(user, permission, code = 'WORKSPACE_ACCESS_FORBIDDEN') {
  if (workspacePermissionDecision(user, permission) === 'allow') return
  throw productAuthorizationError('你没有执行该工作区操作的权限。', code)
}
