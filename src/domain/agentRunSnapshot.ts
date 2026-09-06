import { botanicAgentImageContext, type AgentReferenceBinding, type BotanicAgentRun, type BotanicAgentRunSnapshot, type BotanicAgentRunStatus } from './agent.ts'
import type { GenerationRecipe } from './canvas.ts'

/** 服务端 Run → Turn 是权威关联；浏览器沿用已有 plan.turnId 展示，不推断或补写服务端。 */
export function mergeBotanicAgentRunSnapshot(
  run: BotanicAgentRun,
  snapshot: BotanicAgentRunSnapshot,
): BotanicAgentRun {
  if (run.id !== snapshot.id) return run
  const linkedRun = !run.plan.turnId && snapshot.turnId
    ? { ...run, plan: { ...run.plan, turnId: snapshot.turnId } }
    : run
  // 身份补齐不受进度时间戳限制；但迟到的进度仍不能覆盖已显示的终态。
  const activeStatuses: BotanicAgentRunStatus[] = ['awaiting_confirmation', 'queued', 'executing', 'running']
  const settlesActiveRun = activeStatuses.includes(run.status) && !activeStatuses.includes(snapshot.status)
  if (snapshot.updatedAt <= run.updatedAt && !settlesActiveRun) return linkedRun
  return {
    ...linkedRun,
    status: snapshot.status,
    branches: snapshot.branches,
    completedBranchCount: snapshot.completedBranchCount,
    failedBranchCount: snapshot.failedBranchCount,
    updatedAt: snapshot.updatedAt,
    error: snapshot.status === 'failed'
      ? snapshot.branches.find((branch) => branch.error)?.error
      : undefined,
  }
}

export function upsertBotanicAgentRunSnapshot(
  runs: BotanicAgentRun[],
  snapshot: BotanicAgentRunSnapshot,
  rootRecipe?: GenerationRecipe,
): BotanicAgentRun[] {
  const existing = runs.find((run) => run.id === snapshot.id)
  if (existing) {
    const merged = mergeBotanicAgentRunSnapshot(existing, snapshot)
    if (merged === existing) return runs
    return runs.map((run) => run.id === snapshot.id ? merged : run)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }
  if (!snapshot.plan) return runs
  const initialGeneration = snapshot.plan.intent === 'initial_generation'
  const recipe = initialGeneration ? undefined : rootRecipe ?? {
    references: [],
    prompt: snapshot.plan.prompt,
    batchCount: Math.max(1, snapshot.plan.output.candidatesPerItem),
    settings: snapshot.plan.settings,
  }
  const references: AgentReferenceBinding[] = initialGeneration
    ? botanicAgentImageContext(snapshot.plan.contextSnapshot)
      .map((item) => ({
        source: 'context_node', id: item.nodeId, label: item.label,
        ...(item.role ? { role: item.role } : {}),
      }))
    : [
      ...(snapshot.plan.selectedResultNodeId
        ? [{ source: 'selected_result' as const, id: snapshot.plan.selectedResultNodeId, label: '父结果' }]
        : []),
      ...(recipe?.references ?? []).map((reference) => ({
        source: 'root_recipe' as const,
        id: reference.nodeId,
        label: reference.name,
        role: reference.role,
      })),
    ]
  const restored: BotanicAgentRun = {
    id: snapshot.id,
    status: snapshot.status,
    plan: {
      ...snapshot.plan,
      ...(snapshot.turnId ? { turnId: snapshot.turnId } : {}),
      references,
      ...(recipe ? { rootRecipe: recipe } : {}),
    },
    branches: snapshot.branches,
    completedBranchCount: snapshot.completedBranchCount,
    failedBranchCount: snapshot.failedBranchCount,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    error: snapshot.status === 'failed'
      ? snapshot.branches.find((branch) => branch.error)?.error
      : undefined,
  }
  return [restored, ...runs].sort((a, b) => b.updatedAt - a.updatedAt)
}
