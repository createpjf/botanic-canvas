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

/**
 * 一个角色在项目内拥有的全部能力。
 *
 * 下发给客户端的是**能力集合**，不是角色。界面若拿到角色再自己映射一遍权限，
 * 就出现了第二份权威 —— 两份映射迟早漂移，而漂移的表现是「按钮显示了但一点就 403」
 * 或更糟的「该藏的没藏」。这里与 `projectPermissionDecision` 读同一张表。
 *
 * **隐藏不是鉴权。** 服务端始终是唯一的鉴权边界；这份集合只用于不给用户看他点不动的
 * 入口，不能被当成安全措施。
 *
 * @param {string | undefined} role
 */
export function projectCapabilities(role) {
  return [...(projectPermissions[role] ?? [])]
}

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
  error.statusCode = 403
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
