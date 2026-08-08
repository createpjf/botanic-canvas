import test from 'node:test'
import assert from 'node:assert/strict'
import { matchBotanicHttpRoutes } from './httpRouteTable.mjs'

test('动态 HTTP 路由目录区分项目、Agent、任务与用户资源', () => {
  assert.deepEqual(matchBotanicHttpRoutes('/api/projects/project-1/document').document?.slice(1), ['project-1'])
  assert.deepEqual(matchBotanicHttpRoutes('/api/projects/project-1/agent-sessions/session-1/messages/message-1').agentMessage?.slice(1), ['project-1', 'session-1', 'message-1'])
  assert.deepEqual(matchBotanicHttpRoutes('/api/agent-runs/run-1/branches/branch-1/retry').agentBranchRetry?.slice(1), ['run-1', 'branch-1'])
  assert.deepEqual(matchBotanicHttpRoutes('/api/agent-runs/run-1/trace').agentRunTrace?.slice(1), ['run-1'])
  assert.deepEqual(matchBotanicHttpRoutes('/api/generation-jobs/job-1/cancel').generationJob?.slice(1), ['job-1', 'cancel'])
  assert.deepEqual(matchBotanicHttpRoutes('/api/users/user-1/resend-invite').userInviteResend?.slice(1), ['user-1'])
  assert.deepEqual(matchBotanicHttpRoutes('/api/projects/project-1/collaboration-activities').projectCollaborationActivities?.slice(1), ['project-1'])
  assert.deepEqual(matchBotanicHttpRoutes('/api/projects/project-1/collaboration-activity-receipt').projectCollaborationReceipt?.slice(1), ['project-1'])
})

test('路由匹配严格限制层级，不把未知子路径误交给动态处理器', () => {
  const matches = matchBotanicHttpRoutes('/api/projects/project-1/document/unknown')
  assert.equal(Object.values(matches).some(Boolean), false)
})
