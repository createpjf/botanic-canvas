#!/usr/bin/env node
// Harness 指标聚合 CLI(H7 发布门禁出口)。
//
// 输入:JSONL 日志(stdin 或文件参数)——API/Worker 进程 stdout 中的
// botanic.agent.semantic 行会被原样采集;其他行自动跳过。
//
//   node scripts/harnessMetrics.mjs < worker.log
//   node scripts/harnessMetrics.mjs worker.log api.log
//
// 退出码:零容忍不变量(started_after_cancel/completed_after_cancel/duplicate_dispatch)
// 任一 > 0 时为 1,可直接用作发布门禁。
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { aggregateOperationalMetrics } from '../server/agentOperationalMetrics.mjs'

const files = process.argv.slice(2)
const sources = files.length
  ? files.map((file) => createReadStream(file, 'utf8'))
  : [process.stdin]

const events = []
for (const source of sources) {
  const lines = createInterface({ input: source, crlfDelay: Infinity })
  for await (const line of lines) {
    const start = line.indexOf('{')
    if (start < 0) continue
    try {
      const parsed = JSON.parse(line.slice(start))
      if (parsed && typeof parsed.event === 'string') events.push(parsed)
    } catch { /* 非 JSON 行跳过 */ }
  }
}

const metrics = aggregateOperationalMetrics(events)
const { harness } = metrics
// producer coverage(H7 0B):区分「有生产 emit 点、值为 0」与「尚无 producer,0 不可信」。
// provider.retry 保持 H3C Gate 关闭;call_timeout 由 Change Set 1 的 Provider owner 提供。
const producerCoverage = {
  startedAfterCancelCount: 'active',
  completedAfterCancelCount: 'active',
  duplicateDispatchCount: 'active',
  cancelP50LatencyMs: 'active',
  cancelP95LatencyMs: 'active',
  providerCallTimeoutCount: 'pending_provider_module',
  providerRetryCount: 'retry_policy_disabled',
}
console.log(JSON.stringify({ sampleCount: metrics.sampleCount, producerCoverage, harness }, null, 2))

const violations = [
  ['startedAfterCancelCount', harness.startedAfterCancelCount],
  ['completedAfterCancelCount', harness.completedAfterCancelCount],
  ['duplicateDispatchCount', harness.duplicateDispatchCount],
].filter(([, value]) => value > 0)
if (violations.length) {
  console.error('零容忍不变量违例: ' + violations.map(([name, value]) => name + '=' + value).join(', '))
  process.exit(1)
}
