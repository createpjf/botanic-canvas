import assert from 'node:assert/strict'
import test from 'node:test'
import { executeAgentRunCancellation, executeAgentRunOperation } from './useAgentRunOperations.ts'
import { agentPlanCancellationPending, agentPlanCancellationRun, agentRunStopConfirmed, assertAgentPlanSubmissionActive, preserveAgentPlanStop } from '../../domain/agentPlanCancellation.ts'
import { botanicAgentBranchId, botanicAgentSubmissionKey } from '../../domain/agentRuntimeFeed.ts'
import { pendingBotanicAgentAutoSubmission, type BotanicAgentMessage, type BotanicAgentRun } from '../../domain/agent.ts'
import type { GenerationJob } from '../../domain/canvas.ts'

test('普通取消先保存 Message，网络断开后刷新仍接续取消，确认后原请求不误停新 attempt', async () => {
  let stored: BotanicAgentMessage | undefined
  const message = { id: 'agent-run-stop-request', kind: 'notice', role: 'assistant', runId: 'run-1', status: 'pending', createdAt: 10, turnCancellationRequestedAt: 10 } as BotanicAgentMessage
  const run = { id: 'run-1', status: 'running', branches: [] } as unknown as BotanicAgentRun
  const save = (message: BotanicAgentMessage) => { stored = JSON.parse(JSON.stringify(message)) }
  await assert.rejects(executeAgentRunCancellation(message, save, async () => {
    assert.equal(stored?.status, 'pending')
    throw new Error('network offline before server')
  }), /offline/)
  assert.equal(agentPlanCancellationPending(stored!, run, []), true)
  await executeAgentRunCancellation(stored!, save, async () => true)
  assert.equal(stored?.status, 'answered')
  assert.equal(agentPlanCancellationPending(stored!, run, []), false)
  assert.equal(agentPlanCancellationPending({ ...message, id: 'old-plan', kind: 'plan', turnCancellationRequestedAt: 100_000 }, run, [], [stored!]), false)
  assert.equal(agentPlanCancellationPending({ ...message, id: 'agent-run-stop-next' }, run, [], [stored!]), true)
})

test('停止意图未保存不调用取消；false/ACK 记录保存失败不伪装请求已处理', async () => {
  const message = { id: 'agent-run-stop-request', kind: 'notice', runId: 'run-1', status: 'pending', createdAt: 10, turnCancellationRequestedAt: 10 } as BotanicAgentMessage
  let calls = 0; let stored = message
  await assert.rejects(executeAgentRunCancellation(message, () => { throw new Error('storage full') }, async () => { calls++; return true }), /storage full/)
  assert.equal(calls, 0)
  assert.equal(await executeAgentRunCancellation(message, (message) => { stored = message }, async () => false), false)
  assert.equal(stored.status, 'pending')
  await assert.rejects(executeAgentRunCancellation(message, (message) => { if (message.status === 'answered') throw new Error('receipt storage full'); stored = message }, async () => true), /receipt storage full/)
  assert.equal(stored.status, 'pending')
})

test('旧计划提交中停止：迟到回执与刷新保留停止，精确定位原 Run 且不重发生成', () => {
  const message = { id: 'plan-stop', kind: 'plan', role: 'assistant', status: 'pending', plan: { instruction: '原指令', prompt: '原图', settings: {}, output: { count: 1 } } } as BotanicAgentMessage
  const stopped = { ...message, turnCancellationRequestedAt: 10 }
  const restored = JSON.parse(JSON.stringify(preserveAgentPlanStop({ ...message, status: 'failed' }, [stopped]))) as BotanicAgentMessage
  const key = botanicAgentSubmissionKey(message.id, message.plan!)
  const run = { id: 'original', status: 'queued', branches: [{ id: botanicAgentBranchId(key, 0), jobIds: [], status: 'queued' }] } as unknown as BotanicAgentRun
  assert.equal(restored.turnCancellationRequestedAt, 10)
  assert.equal(agentPlanCancellationRun(restored, [{ ...run, id: 'other', branches: [] }, run])?.id, 'original')
  assert.equal(agentPlanCancellationRun(restored, [{ ...run, id: 'ambiguous' }, run]), undefined)
  assert.equal(agentPlanCancellationPending(restored, run, []), true)
  assert.throws(() => assertAgentPlanSubmissionActive([restored], key), { code: 'AGENT_PLAN_STOP_REQUESTED' })
  assert.equal(pendingBotanicAgentAutoSubmission([{ ...restored, status: 'pending', turnId: 'turn', plan: { ...restored.plan!, turnId: 'turn' } }], 'auto'), undefined)
})

test('停止恢复不猜 Run；缺 Job/ACK 不判已停，已确认后不取消新的显式重试', () => {
  const message = { id: 'plan-stop', runId: 'original', turnCancellationRequestedAt: 10 } as BotanicAgentMessage
  const branch = { id: 'branch-1', status: 'cancelled', updatedAt: 20, activeJobId: 'job-1', jobIds: ['job-1'] } as BotanicAgentRun['branches'][number]
  const run = { id: 'original', status: 'cancelled', branches: [branch] } as BotanicAgentRun
  const job = { id: 'job-1', status: 'cancelled', cancel: { requestedAt: 11, signalRequired: true, workerReleased: false } } as GenerationJob
  assert.equal(agentRunStopConfirmed(run, []), false)
  assert.equal(agentRunStopConfirmed(run, [job]), false)
  assert.equal(agentRunStopConfirmed(run, [{ ...job, cancel: undefined }]), false)
  assert.equal(agentPlanCancellationRun(message, [{ ...run, id: 'other' }]), undefined)
  assert.equal(agentPlanCancellationPending(message, run, []), true)
  assert.equal(agentPlanCancellationPending(message, run, [job]), true)
  job.cancel = { ...job.cancel!, workerReleased: true, signalAcknowledgedAt: 21 }
  assert.equal(agentRunStopConfirmed(run, [job]), true)
  assert.equal(agentRunStopConfirmed({ ...run, status: 'running' }, [job]), false)
  const retried = { ...run, status: 'running', branches: [{ ...branch, status: 'running', activeJobId: 'job-2', jobIds: ['job-1', 'job-2'] }] } as BotanicAgentRun
  assert.equal(agentPlanCancellationPending(message, retried, [job, { id: 'job-2', status: 'running' } as GenerationJob]), false)
})

test('同一 Run 连点或跨面板操作只提交一次，不重试其他分支', async () => {
  const pending = new Set<string>()
  const calls: string[] = []
  let finish!: (result: boolean) => void
  const request = executeAgentRunOperation(pending, 'run-1', () => {
    calls.push('branch-failed')
    return new Promise<boolean>((resolve) => { finish = resolve })
  })
  assert.equal(await executeAgentRunOperation(pending, 'run-1', async () => { calls.push('duplicate'); return true }), 'busy')
  finish(true)
  assert.equal(await request, 'succeeded')
  assert.deepEqual(calls, ['branch-failed'])
  assert.equal(pending.size, 0)
})

test('Store 返回 false 或抛错都保留失败事实，并释放重试入口', async () => {
  const pending = new Set<string>()
  assert.equal(await executeAgentRunOperation(pending, 'run-1', async () => false), 'failed')
  await assert.rejects(executeAgentRunOperation(pending, 'run-1', async () => { throw new Error('offline') }), /offline/)
  assert.equal(pending.size, 0)
  assert.equal(await executeAgentRunOperation(pending, 'run-1', async () => true), 'succeeded')
})
