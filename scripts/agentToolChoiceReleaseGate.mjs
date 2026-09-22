// Offline evidence gate only: no credentials, provider calls, production reads or release approval.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual, parseArgs } from 'node:util'
import { measureChoice, prepareChoiceRequests } from './evalAgentToolChoiceO5.mjs'
import { choiceScenarios, choiceVersion } from './fixtures/agentToolChoiceO5.mjs'
import { syntheticTools } from './fixtures/agentToolSearchO5.mjs'

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const evidencePath = (kind) => new URL(`../docs/research/O5_TOOL_CHOICE_V2_${kind}_2026-09-22.json`, import.meta.url)
const sourceFiles = ['./evalAgentToolChoiceO5.mjs', './fixtures/agentToolChoiceO5.mjs', './evalAgentToolSearchO5.mjs',
  './fixtures/agentToolSearchO5.mjs', './evalAgentDecisionO5.mjs', '../server/agent/context/agentContextBudget.mjs']
const requireEvidence = (valid, reason) => { if (!valid) throw new Error(reason) }

export function verifyToolChoiceEvidence(preflight, report) {
  const requests = prepareChoiceRequests()
  const implementation = Object.fromEntries(sourceFiles.map((file) => [file,
    createHash('sha256').update(readFileSync(new URL(file, import.meta.url))).digest('hex')]))
  for (const evidence of [preflight, report]) {
    requireEvidence(evidence?.version === choiceVersion && evidence.model === 'this-that-model-1.0'
      && evidence.scope === 'synthetic-paired-tool-advice-only' && evidence.productionAdmission === false,
    'invalid_evidence_scope')
    requireEvidence(evidence.datasetSha256 === hash({ syntheticTools, choiceScenarios })
      && evidence.requestSha256 === hash(requests) && isDeepStrictEqual(evidence.syntheticQueries, choiceScenarios)
      && isDeepStrictEqual(evidence.implementationSha256, implementation), 'evidence_or_source_drift')
  }
  requireEvidence(preflight.status === 'prepared_not_evaluated' && preflight.rows?.length === 0
    && preflight.attemptedRequests === 0 && preflight.stopped === null
    && Date.parse(preflight.finishedAt) <= Date.parse(report.startedAt)
    && isDeepStrictEqual(preflight.protocol, report.protocol), 'invalid_preflight')
  requireEvidence(report.status === 'synthetic_evaluated_not_production_ready' && report.stopped === null
    && report.attemptedRequests === requests.length && report.rows?.length === requests.length
    && isDeepStrictEqual(report.responseModels, ['this-that-model-1.0']), 'incomplete_evidence')
  // Match every ordered query/tool/arm pair, not just the aggregate count or saved gate boolean.
  for (const [index, row] of report.rows.entries()) {
    const expected = requests[index]
    requireEvidence(['queryId', 'tool', 'variant', 'split'].every((key) => row?.[key] === expected[key]), 'invalid_pair')
    const labels = row.variant === 'v1' ? ['needed', 'not_needed', 'insufficient'] : ['needed', 'not_needed']
    const probabilities = ['needed', 'not_needed', 'insufficient'].map((label) => row.probabilities?.[label])
    requireEvidence(labels.includes(row.prediction)
      && probabilities.every((p) => Number.isFinite(p) && p >= 0 && p <= 1)
      && Math.abs(probabilities.reduce((a, b) => a + b, 0) - 1) < 0.00001
      && row.score === row.probabilities[row.prediction] && row.score === Math.max(...probabilities)
      && (row.variant !== 'v2' || row.probabilities.insufficient === 0)
      && Number.isFinite(row.ms) && row.ms >= 0
      && (row.promptTokens === null || (Number.isSafeInteger(row.promptTokens) && row.promptTokens >= 0)), 'invalid_prediction')
  }
  const holdout = choiceScenarios.filter((scenario) => scenario.split === 'holdout')
  const metrics = Object.fromEntries(['v1', 'v2'].map((variant) => [variant, measureChoice(holdout, report.rows, variant)]))
  const v2 = metrics.v2
  const reasons = []
  if (v2.withSameStateGuard.recall !== 1) reasons.push('required_tool_recall_below_100_percent')
  if (v2.withSameStateGuard.noToolFalseAccepts !== 0) reasons.push('no_tool_false_accepts')
  if (v2.modelOnly.readOnlyRiskyQueries !== 0 || v2.withSameStateGuard.readOnlyRiskyQueries !== 0) reasons.push('read_only_risky_advice')
  return {
    status: reasons.length ? 'blocked_quality' : 'quality_passed_not_release_approval',
    evidenceVerified: true, completedRequests: report.rows.length, qualityPassed: reasons.length === 0, reasons,
    productionAdmission: false,
    notVerified: ['production_tool_mapping', 'upstream_state_extraction', 'main_model_and_execution',
      'classifier_quota_and_durable_recovery', 'production_data_authorization', 'rollout_and_rollback'],
    holdout: Object.fromEntries(Object.entries(metrics).map(([variant, m]) => [variant, {
      modelOnly: m.modelOnly, withSameStateGuard: m.withSameStateGuard,
      serialQueryLatency: m.serialQueryLatency, reportedPromptTokens: m.reportedPromptTokens,
      actualCatalogReduction: m.actualCatalogReduction,
    }])),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { preflight: { type: 'string' }, results: { type: 'string' } } })
    const read = (path) => JSON.parse(readFileSync(path, 'utf8'))
    const result = verifyToolChoiceEvidence(read(values.preflight ?? evidencePath('PREFLIGHT')),
      read(values.results ?? evidencePath('RESULTS')))
    console.log(JSON.stringify(result, null, 2))
    process.exitCode = result.qualityPassed ? 0 : 1
  } catch {
    // Do not print source text, arbitrary input paths or driver errors in a release log.
    console.error('O5_TOOL_CHOICE_UNVERIFIED: evidence_missing_invalid_or_source_drift')
    process.exitCode = 2
  }
}
