/**
 * ProductStore 是项目、Agent、生成任务和审计持久化的服务端 seam。
 * 核心方法必须由每个 Adapter 提供；只在特定部署存在的能力按完整方法组声明，
 * 调用方先检查能力，不能依赖可选链猜测 Adapter 形状。
 */
export const productStoreCoreMethods = Object.freeze([
  'authenticate',
  'createUser',
  'listProjects',
  'readProject',
  'projectAccess',
  'canEditProject',
  'writeProject',
  'deleteProject',
  'addProjectMember',
  'loadCanvasCollaboration',
  'appendCanvasGraphUpdate',
  'compactCanvasGraphUpdates',
  'readGlobalAssetLibrary',
  'writeGlobalAssetLibrary',
  'deleteGlobalAsset',
  'readAgentState',
  'putAgentSessionReadReceipt',
  'putAgentSession',
  'putAgentMessage',
  'putAgentMemoryItem',
  'deleteAgentMemoryItem',
  'listAgentArtifacts',
  'putAgentSkill',
  'listAgentSkills',
  'putAgentActionReceipt',
  'readAgentActionReceipt',
  'putGenerationJob',
  'refreshGenerationArtifacts',
  'putAgentRun',
  'readAgentRun',
  'readAgentRunForWorker',
  'listAgentRunsForProject',
  'readGenerationJob',
  'listGenerationJobsForProject',
  'readGenerationJobForWorker',
  'recoverGenerationJobs',
  'recoverStaleGenerationJobs',
  'listAuditEvents',
  'listWorkspaceAuditEvents',
  'recordSecurityAuditEvent',
])

export const productStoreCapabilities = Object.freeze({
  authAssurance: Object.freeze(['authAssurance']),
  workspaceMembers: Object.freeze(['listUsers', 'updateUser']),
  inviteResend: Object.freeze(['resendUserInvite']),
  mediaObjects: Object.freeze(['createMediaObject', 'readMediaObject']),
  userProvisioning: Object.freeze(['ensureAuthenticatedUser', 'readUser']),
  lifecycle: Object.freeze(['close']),
})

function missingMethods(store, methods) {
  return methods.filter((method) => typeof store?.[method] !== 'function')
}

export function productStoreSupports(store, capability) {
  const methods = productStoreCapabilities[capability]
  if (!methods) throw new Error(`未知 ProductStore 能力：${capability}`)
  return missingMethods(store, methods).length === 0
}

export function assertProductStoreContract(store, { adapter = 'ProductStore' } = {}) {
  const missing = missingMethods(store, productStoreCoreMethods)
  if (missing.length) {
    throw new Error(`${adapter} 缺少 ProductStore 核心方法：${missing.join(', ')}`)
  }
  return store
}
