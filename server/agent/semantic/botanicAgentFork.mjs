import { createHash } from 'node:crypto'
import { BotanicAgentRunError } from './botanicAgentRun.mjs'

const terminalSourceStatuses = new Set(['completed', 'partial'])

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function text(value, label, maximum = 500) {
  if (typeof value !== 'string' || !value.trim()) throw new BotanicAgentRunError(400, 'INVALID_AGENT_FORK', `${label}不能为空。`)
  const normalized = value.trim()
  if (normalized.length > maximum) throw new BotanicAgentRunError(400, 'INVALID_AGENT_FORK', `${label}过长。`)
  return normalized
}

function stableBranchId(runId, branchId, promptDelta) {
  const digest = createHash('sha256').update(`${runId}:${branchId}:${promptDelta}`).digest('base64url').slice(0, 24)
  return `branch_fork_${digest}`
}

/**
 * 从已完成 Run 的一个分支创建新的、可独立提交的 Run 输入。
 * Fork 只复制不可变创作上下文，不复制旧 Run 的 Job、结果或待执行行动。
 */
export function createForkedAgentRunInput(sourceRun, { branchId, promptDelta, now = Date.now() } = {}) {
  if (!sourceRun || !terminalSourceStatuses.has(sourceRun.status)) {
    throw new BotanicAgentRunError(409, 'AGENT_RUN_NOT_FORKABLE', '只有已完成或部分完成的 Agent Run 才能分叉。')
  }
  const sourceBranch = sourceRun.branches?.find((branch) => branch.id === branchId)
    ?? sourceRun.branches?.find((branch) => branch.status === 'succeeded')
  if (!sourceBranch || sourceBranch.status !== 'succeeded') throw new BotanicAgentRunError(409, 'AGENT_BRANCH_NOT_FORKABLE', '只能从已成功的 Agent 分支分叉。')
  const delta = text(promptDelta, '分叉变化', 1_000)
  const sourcePlan = clone(sourceRun.plan)
  const parentPrompt = text(sourcePlan?.prompt, '父版本 Prompt', 12_000)
  const selectedResultNodeId = text(sourcePlan?.selectedResultNodeId, '父结果节点', 160)
  const prompt = `${parentPrompt}\n\n分叉变化：${delta}`
  const rootRunId = sourceRun.lineage?.rootRunId ?? sourceRun.id
  const nextBranchId = stableBranchId(sourceRun.id, sourceBranch.id, delta)
  const nextPlan = {
    ...sourcePlan,
    intent: 'continue_generation',
    instruction: delta,
    summary: `从「${sourceBranch.label ?? '已选结果'}」分叉：${delta.slice(0, 80)}`,
    selectedResultNodeId,
    prompt,
    output: { mode: 'single', count: 1, candidatesPerItem: 1 },
    // 旧行动和调用轨迹不能在分叉时重复执行；上下文/记忆/Skill 绑定继续沿用。
    actions: undefined,
    toolCalls: undefined,
  }
  return {
    projectId: sourceRun.projectId,
    lineage: {
      relation: 'fork',
      parentRunId: sourceRun.id,
      parentBranchId: sourceBranch.id,
      rootRunId,
      createdAt: now,
    },
    plan: nextPlan,
    branches: [{
      id: nextBranchId,
      label: `分叉 · ${delta.slice(0, 36)}`,
      variation: { label: '分叉变化', promptDelta: delta, values: [] },
    }],
  }
}

export function forkedAgentRunIdForIdempotency(userId, sourceRunId, idempotencyKey) {
  const digest = createHash('sha256').update(`${userId}:${sourceRunId}:${idempotencyKey}`).digest('hex').slice(0, 32)
  return `agent_run_fork_${digest}`
}
