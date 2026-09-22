import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { verifyToolChoiceEvidence } from './agentToolChoiceReleaseGate.mjs'
import { choiceScenarios } from './fixtures/agentToolChoiceO5.mjs'

const read = (kind) => JSON.parse(readFileSync(new URL(`../docs/research/O5_TOOL_CHOICE_V2_${kind}_2026-09-22.json`, import.meta.url), 'utf8'))

test('离线重算完整配对证据；质量通过也不等于生产放行', () => {
  const preflight = read('PREFLIGHT'), report = read('RESULTS')
  report.metrics = { holdout: { v2: { gate: true } } } // Saved summaries are not the source of truth.
  const result = verifyToolChoiceEvidence(preflight, report)
  assert.equal(result.status, 'blocked_quality')
  assert.equal(result.completedRequests, 384)
  assert.equal(result.holdout.v2.withSameStateGuard.truePositives, 20)
  assert.equal(result.holdout.v2.withSameStateGuard.requiredTools, 21)
  assert.deepEqual(result.reasons, ['required_tool_recall_below_100_percent', 'no_tool_false_accepts'])
  // Artificial perfect rows test the gate branch, not additional model evidence.
  for (const row of report.rows) {
    row.prediction = choiceScenarios.find((s) => s.id === row.queryId).required.includes(row.tool) ? 'needed' : 'not_needed'
    row.probabilities = Object.fromEntries(['needed', 'not_needed', 'insufficient'].map((p) => [p, Number(p === row.prediction)]))
    row.score = 1
  }
  const ideal = verifyToolChoiceEvidence(preflight, report)
  assert.equal(ideal.qualityPassed, true)
  assert.equal(ideal.productionAdmission, false)
  const cli = spawnSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(
    "globalThis.fetch=()=>{throw new Error('unexpected_network')}"),
  new URL('./agentToolChoiceReleaseGate.mjs', import.meta.url).pathname], { encoding: 'utf8', timeout: 10000 })
  assert.equal(cli.status, 1, cli.stderr)
  assert.equal(JSON.parse(cli.stdout).status, 'blocked_quality')
})

test('缺失、重复、来源漂移和非法预测不能以部分成功放行', () => {
  const preflight = read('PREFLIGHT'), report = read('RESULTS')
  assert.throws(() => verifyToolChoiceEvidence(preflight, { ...report, rows: report.rows.slice(1) }), /incomplete_evidence/u)
  assert.throws(() => verifyToolChoiceEvidence(preflight, { ...report, rows: [report.rows[1], ...report.rows.slice(1)] }), /invalid_pair/u)
  assert.throws(() => verifyToolChoiceEvidence(preflight, { ...report, datasetSha256: 'changed' }), /drift/u)
  assert.throws(() => verifyToolChoiceEvidence(preflight, { ...report, implementationSha256: {} }), /drift/u)
  assert.throws(() => verifyToolChoiceEvidence(preflight, { ...report, rows: [
    { ...report.rows[0], prediction: 'unknown' }, ...report.rows.slice(1),
  ] }), /invalid_prediction/u)
})
