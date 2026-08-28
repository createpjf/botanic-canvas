/**
 * 动态 HTTP 路径的单一目录。处理器仍按业务顺序执行，但路径形状不再散落在请求函数中。
 */
export const botanicHttpRoutePatterns = Object.freeze({
  document: /^\/api\/projects\/([^/]+)\/document$/,
  project: /^\/api\/projects\/([^/]+)$/,
  projectMembers: /^\/api\/projects\/([^/]+)\/members$/,
  projectAudit: /^\/api\/projects\/([^/]+)\/audit$/,
  projectCollaborationActivities: /^\/api\/projects\/([^/]+)\/collaboration-activities$/,
  projectCollaborationReceipt: /^\/api\/projects\/([^/]+)\/collaboration-activity-receipt$/,
  projectGenerationJobs: /^\/api\/projects\/([^/]+)\/generation-jobs$/,
  projectGenerationReconcile: /^\/api\/projects\/([^/]+)\/reconcile-generation-results$/,
  projectProductionWorkflows: /^\/api\/projects\/([^/]+)\/production-workflows$/,
  projectProductionWorkflow: /^\/api\/projects\/([^/]+)\/production-workflows\/([^/]+)$/,
  projectProductionWorkflowRuns: /^\/api\/projects\/([^/]+)\/production-workflows\/([^/]+)\/runs$/,
  projectProductionWorkflowRun: /^\/api\/projects\/([^/]+)\/production-workflow-runs\/([^/]+)$/,
  projectAgentRuns: /^\/api\/projects\/([^/]+)\/agent-runs$/,
  projectAgentSkills: /^\/api\/projects\/([^/]+)\/agent-skills$/,
  agentSkillCatalog: /^\/api\/agent-skill-catalog$/,
  projectAgentState: /^\/api\/projects\/([^/]+)\/agent-state$/,
  projectAgentSessions: /^\/api\/projects\/([^/]+)\/agent-sessions$/,
  agentSessionMessages: /^\/api\/projects\/([^/]+)\/agent-sessions\/([^/]+)\/messages$/,
  projectAgentArtifacts: /^\/api\/projects\/([^/]+)\/agent-artifacts$/,
  agentSession: /^\/api\/projects\/([^/]+)\/agent-sessions\/([^/]+)$/,
  agentSessionReadingAnchor: /^\/api\/projects\/([^/]+)\/agent-sessions\/([^/]+)\/reading-anchor$/,
  agentMessage: /^\/api\/projects\/([^/]+)\/agent-sessions\/([^/]+)\/messages\/([^/]+)$/,
  agentMemory: /^\/api\/projects\/([^/]+)\/agent-memory\/([^/]+)$/,
  projectMedia: /^\/api\/projects\/([^/]+)\/media$/,
  agentRun: /^\/api\/agent-runs\/([^/]+)$/,
  agentRunFork: /^\/api\/agent-runs\/([^/]+)\/fork$/,
  agentRunCompare: /^\/api\/agent-runs\/([^/]+)\/compare$/,
  agentRunTrace: /^\/api\/agent-runs\/([^/]+)\/trace$/,
  agentRunCancel: /^\/api\/agent-runs\/([^/]+)\/cancel$/,
  agentBranchRetry: /^\/api\/agent-runs\/([^/]+)\/branches\/([^/]+)\/retry$/,
  agentTurns: /^\/api\/agent-turns$/,
  agentTurnStream: /^\/api\/agent-turns\/stream$/,
  agentTurn: /^\/api\/agent-turns\/([^/]+)$/,
  agentTurnCancel: /^\/api\/agent-turns\/([^/]+)\/cancel$/,
  agentReviewDecision: /^\/api\/agent-reviews\/([^/]+)\/decision$/,
  // 评审任务（ADR 0006）。与上面按 Run+locale 的展示型 review 不同：任务是可恢复的
  // 派生实体，逐候选给出结论与人工决定。
  agentRunReviewTasks: /^\/api\/agent-runs\/([^/]+)\/review-tasks$/,
  agentReviewTaskDecisions: /^\/api\/agent-review-tasks\/([^/]+)\/decisions$/,
  agentReviewTaskCancel: /^\/api\/agent-review-tasks\/([^/]+)\/cancel$/,
  agentReviewTaskReconciliation: /^\/api\/agent-review-tasks\/([^/]+)\/reconciliation$/,
  projectProductionWorkflowRunManifest: /^\/api\/projects\/([^/]+)\/production-workflow-runs\/([^/]+)\/manifest$/,
  // 交付包下载（Epic 7）。装哪些文件完全由清单决定，这条路由不再判断一次。
  projectProductionWorkflowRunPackage: /^\/api\/projects\/([^/]+)\/production-workflow-runs\/([^/]+)\/package$/,
  // 项目当前生效的品牌规则（Epic 9.1）。解析在服务端做，界面不重算覆盖优先级 ——
  // 两份实现对不上时的表现是「界面说这条生效，生成却没按它来」。
  projectBrandKit: /^\/api\/projects\/([^/]+)\/brand-kit$/,
  globalAsset: /^\/api\/global-assets\/([^/]+)$/,
  generationJob: /^\/api\/generation-jobs\/([^/]+)(?:\/(cancel))?$/,
  media: /^\/api\/media\/([^/]+)$/,
  user: /^\/api\/users\/([^/]+)$/,
  userInviteResend: /^\/api\/users\/([^/]+)\/resend-invite$/,
})

export function matchBotanicHttpRoutes(pathname) {
  return Object.fromEntries(
    Object.entries(botanicHttpRoutePatterns).map(([name, pattern]) => [name, pathname.match(pattern)]),
  )
}
