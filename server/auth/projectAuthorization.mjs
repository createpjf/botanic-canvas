import { projectPermissionDecision } from './authorization.mjs'

export class ProjectAuthorizationError extends Error {
  constructor(statusCode, code, message) {
    super(message)
    this.statusCode = statusCode
    this.code = code
  }
}

export async function requireProjectPermission(productStore, userId, projectId, permission, options = {}) {
  const access = await productStore.projectAccess(userId, projectId)
  if (!access.exists) {
    if (options.allowMissing) return access
    throw new ProjectAuthorizationError(404, 'PROJECT_NOT_FOUND', '未找到项目。')
  }
  if (projectPermissionDecision(access.role, permission) !== 'allow') {
    throw new ProjectAuthorizationError(403, 'PROJECT_ACCESS_FORBIDDEN', '你没有执行该项目操作的权限。')
  }
  return access
}
