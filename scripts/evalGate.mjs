// @ts-check
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { diffEvalSuites, evaluateReleaseGate, runAgentEvalSuite } from '../server/agentEvalSuite.mjs'

/**
 * 发布 Eval Gate。
 *
 * 只跑随仓库的固定回归集，不读生产项目、不调用真实 Provider、不产生任何模型费用。
 * 因此它可以在每次提交上跑，而「真实 Provider Smoke」是另一条需要独立测试项目、
 * 明确额度与人工授权的路径，不在这里。
 *
 * 用法：
 *   node scripts/evalGate.mjs                      跑一遍并给出结论
 *   node scripts/evalGate.mjs --save <file>        保存本次结果，供之后对比
 *   node scripts/evalGate.mjs --baseline <file>    与基线对比并输出前后差异
 */

const datasetPath = fileURLToPath(new URL('./fixtures/agentEvalRegressionSet.json', import.meta.url))

function argumentValue(flag) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const dataset = JSON.parse(readFileSync(datasetPath, 'utf8'))
const suite = await runAgentEvalSuite({ dataset })
const gate = evaluateReleaseGate(suite)

console.log(`Eval 回归集：${suite.caseCount} 条样本，其中 ${suite.expectationCount} 条声明了期望结论。`)
console.log(`确定性层失败样本：${suite.deterministicFailures} 条（这些样本本来就该失败）。`)
// 单元测试通过率不是创意质量证明，因此这里显式区分两者的口径。
console.log(`带保留的结论：${suite.partiallyVerifiedCount} 条未跑视觉层，判据记为无法验证而非通过。`)

const savePath = argumentValue('--save')
if (savePath) {
  writeFileSync(savePath, JSON.stringify(suite, null, 2))
  console.log(`已保存本次结果：${savePath}`)
}

const baselinePath = argumentValue('--baseline')
if (baselinePath) {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
  const diff = diffEvalSuites(baseline, suite)
  console.log(`与基线对比：回退 ${diff.regressed} 条，改善 ${diff.improved} 条。`)
  for (const change of diff.changes) {
    console.log(`  - ${change.id}: ${change.status} ${change.from ?? '—'} → ${change.to ?? '—'}`)
  }
  if (diff.regressed) {
    console.error('Eval Gate 失败：相对基线出现质量回退。')
    process.exit(1)
  }
}

if (!gate.passed) {
  console.error(`Eval Gate 失败（${gate.code}）：${gate.message}`)
  for (const mismatch of gate.mismatches) {
    console.error(`  - ${mismatch.id}: 期望 ${mismatch.expected}，实际 ${mismatch.actual}`)
  }
  process.exit(1)
}

console.log(`Eval Gate 通过：${gate.message}`)
