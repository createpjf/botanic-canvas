import assert from 'node:assert/strict'
import test from 'node:test'
import { agentToolPermission, assertFreshActionApproval, createActionApprovalToken, sanitizeAuditEvent } from './agentActionGovernance.mjs'

test('Agent 行动按生成、工作流与外部工具映射到服务端权限', () => {
  assert.equal(agentToolPermission('generation_submit'), 'create-generation')
  assert.equal(agentToolPermission('workflow_create'), 'modify-workflow')
  assert.equal(agentToolPermission('skill_apply'), 'modify-workflow')
  assert.equal(agentToolPermission('skill_publish'), 'modify-workflow')
  assert.equal(agentToolPermission('mcp_call'), 'execute-external-tool')
})

test('高风险行动审批绑定项目、工具调用并会过期', () => {
  const common = {
    secret: 'test-secret', userId: 'user-1', projectId: 'project-1', actionName: 'mcp_call',
    toolCallId: 'call-1', argumentsValue: { server: 'assets', tool: 'search' }, idempotencyKey: 'action-1', now: 1_000,
  }
  const approval = createActionApprovalToken({ ...common, now: 900, ttlMs: 200 })
  assert.doesNotThrow(() => assertFreshActionApproval({ confirmed: true, approval }, common))
  const expired = createActionApprovalToken({ ...common, now: 700, ttlMs: 200 })
  assert.throws(() => assertFreshActionApproval({
    confirmed: true,
    approval: expired,
  }, common), /审批已失效/)
  assert.throws(() => assertFreshActionApproval({ confirmed: true, approval }, { ...common, argumentsValue: { tool: 'delete' } }), /不匹配/)
  assert.throws(() => assertFreshActionApproval({ confirmed: true }, {
    ...common,
  }), /需要明确审批/)
})

test('安全日志导出移除密钥、Prompt、私有媒体地址与原始请求', () => {
  const safe = sanitizeAuditEvent({
    id: 'audit-1', actorId: 'user-1', projectId: 'project-1', action: 'agent-action.failed', createdAt: 100,
    detail: { result: 'failed', runId: 'run-1', apiKey: 'secret', prompt: 'private prompt', mediaUrl: 'https://private/media', request: { token: 'x' } },
  })
  assert.deepEqual(safe.detail, { result: 'failed', runId: 'run-1' })
  assert.doesNotMatch(JSON.stringify(safe), /secret|private prompt|private\/media|token/)
})
