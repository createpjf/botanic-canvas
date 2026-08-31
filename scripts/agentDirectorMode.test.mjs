import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// 导演模式的编排层不变量：执行权在服务端，浏览器是观察者与幂等兜底。
// 行为断言在 server/agentRoutes.test.mjs 与 src/domain/agent.test.ts。
const bridge = readFileSync(new URL('../src/features/canvas/useCanvasAgentExecutionBridge.ts', import.meta.url), 'utf8')
const workspace = readFileSync(new URL('../src/features/agent/AgentWorkspace.tsx', import.meta.url), 'utf8')

function between(source, from, to) {
  const start = source.indexOf(from)
  assert.notEqual(start, -1, `找不到锚点：${from}`)
  const end = source.indexOf(to, start)
  assert.notEqual(end, -1, `找不到锚点：${to}`)
  return source.slice(start, end)
}

test('服务端已提交的 Run 不再补打浏览器三跳，但空 queued 保留幂等兜底', () => {
  const confirm = between(bridge, 'const creation = await createPersistentBotanicAgentRun', 'const execution = await executePersistentBotanicAgentRun(projectId, runId, {')
  assert.match(confirm, /serverSubmitted/)
  assert.match(confirm, /branch\.activeJobId \|\| branch\.jobIds\.length/)
  // 服务端已提交时优先用响应里的工作流增量；整份刷新只是旧服务端的回退。
  assert.match(confirm, /creation\.canvasPatch\) await applyAgentWorkflowPatch/)
  // 旧版服务端或队列暂不可用时必须仍能走原路径，否则升级窗口内任务会卡死。
  assert.match(confirm, /executePersistentBotanicAgentRun/)
})

test('自动模式失败分支只自动重试一次，且判定归领域函数', () => {
  const retry = between(workspace, '// 导演回看', '// 结果自评')
  assert.match(retry, /session\?\.executionMode !== 'auto'/)
  assert.match(retry, /botanicAgentAutoRetryTargets\(/)
  assert.match(retry, /autoRetriedBranchesRef/)
})
