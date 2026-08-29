import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const messageSource = readFileSync(new URL('./AgentConversationMessage.tsx', import.meta.url), 'utf8')
const runtimeTraceSource = readFileSync(new URL('./useAgentRuntimeTrace.ts', import.meta.url), 'utf8')
const workspaceSource = readFileSync(new URL('./AgentWorkspace.tsx', import.meta.url), 'utf8')

test('用户消息只在同步失败时显示可重试提示', () => {
  assert.doesNotMatch(messageSource, /等待联网|等待同步|正在同步/u)
  assert.match(messageSource, /同步失败/u)
  assert.match(messageSource, /onRetryDelivery/u)
})

test('Run 从执行中进入终态后不保留底部实时步骤', () => {
  assert.match(
    runtimeTraceSource,
    /if \(phase === 'executing' && !shouldRestoreBotanicAgentRuntimeSteps\(latestRun\.status\)\)/u,
  )
})

test('同一 Run 只向一条对话消息投影执行时间线', () => {
  assert.match(workspaceSource, /const timelineMessageIdByRun = new Map<string, string>\(\)/u)
  assert.match(workspaceSource, /timelineMessageIdByRun\.get\(message\.runId\) !== message\.id/u)
})
