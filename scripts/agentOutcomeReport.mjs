#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { aggregateAgentOutcomes, createAgentOutcomes, formatAgentOutcomeRecap } from '../server/observability/agentOutcomeMetrics.mjs'

function value(args, flag) {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

function usage(message) {
  if (message) console.error(message)
  console.error('用法:')
  console.error('  npm run metrics:outcomes -- <snapshot.json> [--turn <turn-id>]')
  console.error('  npm run metrics:outcomes -- --project <id> --user <id> [--since <ISO|ms>] [--until <ISO|ms>] [--turn <id>]')
  process.exitCode = 1
}

async function loadSnapshot(args) {
  const projectId = value(args, '--project')
  if (!projectId) {
    const inputPath = args[0]
    if (!inputPath || inputPath.startsWith('--')) return usage('缺少 snapshot 文件或 --project。')
    const snapshot = JSON.parse(await readFile(inputPath, 'utf8'))
    const requiredCollections = ['turns', 'runs', 'jobs', 'reviewTasks', 'manifests']
    const missing = requiredCollections.filter((key) => !Array.isArray(snapshot?.[key]))
    if (missing.length) throw new TypeError(`Agent Outcome 快照缺少集合：${missing.join('、')}`)
    return snapshot
  }

  const userId = value(args, '--user')
  if (!userId) return usage('Store 模式必须提供 --user。')
  const [{ createProductRuntime }, { readAgentOutcomeSnapshot }] = await Promise.all([
    import('../server/runtime.mjs'),
    import('../server/observability/agentOutcomeStoreReader.mjs'),
  ])
  // ProductStore 的结构化运维事件默认写 stdout；CLI 的 stdout 必须保持为单个 JSON。
  const originalLog = console.log
  console.log = (...entries) => console.error(...entries)
  let runtime
  try {
    runtime = await createProductRuntime()
    return await readAgentOutcomeSnapshot({
      productStore: runtime.productStore,
      userId,
      projectId,
      since: value(args, '--since'),
      until: value(args, '--until'),
    })
  } finally {
    await runtime?.productStore.close?.()
    console.log = originalLog
  }
}

const args = process.argv.slice(2)
const snapshot = await loadSnapshot(args)
if (snapshot) {
  const turnId = value(args, '--turn')
  const outcomes = createAgentOutcomes(snapshot)
  const selected = turnId ? outcomes.filter((outcome) => outcome.turnId === turnId) : outcomes
  if (turnId && !selected.length) {
    usage(`找不到 Agent Turn：${turnId}`)
  } else {
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      ...(snapshot.projectId ? { source: { projectId: snapshot.projectId, userId: snapshot.userId, window: snapshot.window } } : {}),
      metrics: aggregateAgentOutcomes(selected),
      outcomes: selected.map((outcome) => ({ ...outcome, recap: formatAgentOutcomeRecap(outcome) })),
    }, null, 2))
  }
}
