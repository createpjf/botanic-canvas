/**
 * ProductStore 是项目、Agent、生成任务和审计持久化的服务端 seam。
 * 核心方法必须由每个 Adapter 提供；只在特定部署存在的能力按完整方法组声明，
 * 调用方先检查能力，不能依赖可选链猜测 Adapter 形状。
 */
/**
 * 非终态 Turn。孤儿回收只看这几个状态：终态 Turn 已经结束，不该被重新拾起。
 * 与 `turnReclaim.mjs` 的同名集合保持一致 —— 那边判「怎么处理」，这里定「捞哪些」。
 */
export const nonTerminalAgentTurnStatuses = Object.freeze(['queued', 'running', 'waiting_user', 'cancelling'])

/**
 * Turn 事件分页参数。三个 Adapter 共用同一份规格化，避免各自写一套默认值与上限 ——
 * 那会让「同一个游标在不同 Adapter 上返回不同结果」这种最难查的差异出现。
 *
 * `after` 是 `(turnId, sequence)` 游标：只返回该序号**之后**的事件。缺省为 null
 * 表示从头读。
 */
export function normalizeTurnEventPage(options = {}) {
  const raw = options ?? {}
  const after = Number.isInteger(raw.after) && raw.after >= 0 ? raw.after : null
  return { after, limit: Math.max(1, Math.min(Number(raw.limit) || 200, 500)) }
}

/**
 * 陈旧 Turn 扫描参数。
 *
 * 租约下限 30 秒：比这更短会抢走仍在推进的 Turn —— 一次慢的模型调用就可能超过
 * 几秒不更新 updated_at。默认 2 分钟。
 */
export function normalizeStaleTurnQuery(options = {}) {
  const raw = options ?? {}
  const leaseMs = Math.max(30_000, Number(raw.leaseMs) || 120_000)
  const now = Number.isInteger(raw.now) ? raw.now : Date.now()
  return {
    olderThan: Number.isInteger(raw.olderThan) ? raw.olderThan : now - leaseMs,
    // 清扫是周期性的，一次只取一小批：单次捞太多会让一个慢批次拖住后续所有清扫。
    limit: Math.max(1, Math.min(Number(raw.limit) || 25, 200)),
  }
}

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
  'listCollaborationActivities',
  'putCollaborationActivity',
  'putCollaborationActivityReceipt',
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
  'putAgentTurn',
  'readAgentTurn',
  'readAgentTurnForWorker',
  'listAgentTurnsForProject',
  // 跨项目扫描超过租约未推进的非终态 Turn。与 readAgentTurnForWorker 一样是
  // Worker 侧方法：清扫是系统行为，没有发起它的用户，因此不做成员校验。
  'listStaleAgentTurns',
  'appendAgentTurnEvent',
  'listAgentTurnEvents',
  'putAgentReview',
  'readAgentReview',
  'listAgentReviewsForRun',
  'putAgentReviewDecision',
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
