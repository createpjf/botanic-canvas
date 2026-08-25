function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

/**
 * 比较只返回可解释的分支摘要，不把媒体 URL、Prompt 原文或隐藏推理复制到比较读模型。
 * Run、Generation Job、Artifact 与 Review 仍各自保留权威记录。
 */
export function compareBotanicAgentRunBranches({ run, jobs = [], artifacts = [], reviews = [] } = {}) {
  if (!run) return undefined
  const jobsByBranch = new Map()
  for (const job of jobs) {
    const branchId = job?.agentRun?.branchId
    if (!branchId) continue
    const current = jobsByBranch.get(branchId) ?? []
    current.push(job)
    jobsByBranch.set(branchId, current)
  }
  const artifactsByBranch = new Map()
  for (const artifact of artifacts) {
    const branchId = artifact?.provenance?.branchId
    if (!branchId) continue
    artifactsByBranch.set(branchId, (artifactsByBranch.get(branchId) ?? 0) + 1)
  }
  const reviewByNode = new Map((reviews ?? []).flatMap((review) => (review.items ?? []).map((item) => [item.nodeId, { verdict: item.verdict, note: item.note }])) )
  const branches = (run.branches ?? []).map((branch) => {
    const branchJobs = jobsByBranch.get(branch.id) ?? []
    const outputCount = Math.max(
      Number(branch.outputCount) || 0,
      branchJobs.reduce((sum, job) => sum + (Array.isArray(job.outputs) ? job.outputs.length : 0), 0),
      artifactsByBranch.get(branch.id) ?? 0,
    )
    const review = branchJobs.flatMap((job) => job.outputs ?? []).map((output) => reviewByNode.get(output.nodeId)).find(Boolean)
    return {
      id: branch.id,
      label: branch.label,
      status: branch.status,
      attempt: branch.attempt,
      outputCount,
      jobCount: branchJobs.length,
      ...(review ? { review: clone(review) } : {}),
    }
  })
  const bestNodeIds = new Set((reviews ?? []).map((review) => review.bestNodeId).filter(Boolean))
  const recommendedBranchId = branches.find((branch) => {
    const branchJobs = jobsByBranch.get(branch.id) ?? []
    return branchJobs.some((job) => (job.outputs ?? []).some((output) => bestNodeIds.has(output.nodeId)))
  })?.id
  return {
    runId: run.id,
    projectId: run.projectId,
    status: run.status,
    lineage: run.lineage ? clone(run.lineage) : undefined,
    branches,
    ...(recommendedBranchId ? { recommendedBranchId } : {}),
  }
}
