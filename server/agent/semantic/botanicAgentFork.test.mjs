import assert from 'node:assert/strict'
import test from 'node:test'
import { createForkedAgentRunInput, forkedAgentRunIdForIdempotency } from './botanicAgentFork.mjs'

const source = {
  id: 'run-parent', projectId: 'project-a', status: 'completed',
  plan: { intent: 'initial_generation', selectedResultNodeId: 'result-a', prompt: '白底产品图', output: { mode: 'single', count: 1, candidatesPerItem: 1 }, actions: [{ id: 'old' }] },
  branches: [{ id: 'branch-a', label: '首图', status: 'succeeded', outputCount: 1 }],
}

test('Fork 复制创作上下文但不复制旧行动与任务', () => {
  const input = createForkedAgentRunInput(source, { branchId: 'branch-a', promptDelta: '改为黄昏海边', now: 100 })
  assert.equal(input.projectId, 'project-a')
  assert.equal(input.plan.selectedResultNodeId, 'result-a')
  assert.match(input.plan.prompt, /白底产品图[\s\S]*黄昏海边/)
  assert.equal(input.plan.actions, undefined)
  assert.equal(input.branches.length, 1)
  assert.equal(input.lineage.parentRunId, 'run-parent')
})

test('Fork 只接受成功分支并生成稳定幂等 Run ID', () => {
  assert.throws(() => createForkedAgentRunInput({ ...source, branches: [{ ...source.branches[0], status: 'failed' }] }, { promptDelta: '变化' }), /成功的 Agent 分支/)
  assert.equal(forkedAgentRunIdForIdempotency('user-a', 'run-parent', 'key'), forkedAgentRunIdForIdempotency('user-a', 'run-parent', 'key'))
})
