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
  projectAgentState: /^\/api\/projects\/([^/]+)\/agent-state$/,
  projectAgentArtifacts: /^\/api\/projects\/([^/]+)\/agent-artifacts$/,
  agentSession: /^\/api\/projects\/([^/]+)\/agent-sessions\/([^/]+)$/,
  agentSessionReadingAnchor: /^\/api\/projects\/([^/]+)\/agent-sessions\/([^/]+)\/reading-anchor$/,
  agentMessage: /^\/api\/projects\/([^/]+)\/agent-sessions\/([^/]+)\/messages\/([^/]+)$/,
  agentMemory: /^\/api\/projects\/([^/]+)\/agent-memory\/([^/]+)$/,
  projectMedia: /^\/api\/projects\/([^/]+)\/media$/,
  agentRun: /^\/api\/agent-runs\/([^/]+)$/,
  agentRunTrace: /^\/api\/agent-runs\/([^/]+)\/trace$/,
  agentRunCancel: /^\/api\/agent-runs\/([^/]+)\/cancel$/,
  agentBranchRetry: /^\/api\/agent-runs\/([^/]+)\/branches\/([^/]+)\/retry$/,
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
