import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const worker = readFileSync(new URL('../server/worker.mjs', import.meta.url), 'utf8')

test('Worker 用既有生成与深取消服务构造 Run 提交恢复器', () => {
  assert.match(worker, /import \{ createAgentRunSubmissionSweep \} from '\.\/agentRunSubmissionSweep\.mjs'/u)
  const composition = worker.slice(
    worker.indexOf('const sweepQueuedAgentRuns = createAgentRunSubmissionSweep'),
    worker.indexOf('cancelStaleAgentTurn ='),
  )
  assert.match(composition, /productStore:\s*runtime\.productStore/u)
  assert.match(composition, /submitGeneration:[\s\S]*agentRunGeneration\.submitGeneration\(/u)
  assert.match(composition, /cancelAgentRun:[\s\S]*agentCancellation\.cancelAgentRun\(/u)
})

test('run.submit 同时拥有消费者与周期调度，避免只声明不执行', () => {
  assert.match(worker, /'run\.submit':\s*\(\)\s*=>\s*sweepQueuedAgentRuns\(\)/u)
  assert.match(worker, /\['run\.submit',\s*30_000\]/u)
})
