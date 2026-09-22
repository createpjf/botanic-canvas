// Isolated synthetic benchmark. No real tools, project reads, environment files, or production hooks.
import { createHash } from 'node:crypto'
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline/promises'
import { estimateAgentContextTokens } from '../server/agent/context/agentContextBudget.mjs'
import { classifyResponse } from './evalAgentDecisionO5.mjs'
import { syntheticTools, toolScenarios, toolOptions, toolLabels, toolQuestion, toolSearchVersion } from './fixtures/agentToolSearchO5.mjs'

const model = 'this-that-model-1.0'
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const ratio = (n, d) => d ? n / d : null
const sum = (values) => values.reduce((a, b) => a + b, 0)
const mean = (values) => ratio(sum(values), values.length)
const latency = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  return { n: sorted.length, p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null }
}
const names = syntheticTools.map((t) => t.name)
const risky = new Set(syntheticTools.filter((t) => t.risk !== 'read').map((t) => t.name))
const gold = (s, name) => s.required.includes(name) ? 'needed' : s.uncertain.includes(name) ? 'insufficient' : 'not_needed'
const schemaTokens = (ids) => estimateAgentContextTokens(JSON.stringify(syntheticTools.filter((t) => ids.includes(t.name))
  .map(({ name, description, parameters }) => ({ type: 'function', function: { name, description, parameters } }))))

export function toolRequest(scenario, tool) {
  const state = JSON.stringify({ 请求: scenario.request, 已知状态: scenario.context,
    候选工具: { 名称: tool.name, 作用: tool.description, 风险: tool.risk } })
  if (Buffer.byteLength(state + toolQuestion) > 2400) throw new Error('invalid_synthetic_input')
  return { model, messages: [{ role: 'user', content: state }, { role: 'user', content: toolQuestion }],
    stream: false, temperature: 1, max_tokens: 32,
    response_format: { type: 'json_schema', json_schema: { name: 'tool_suitability', strict: true, schema: {
      type: 'object', properties: { intent: { type: 'string', enum: toolOptions } },
      required: ['intent'], additionalProperties: false,
    } } } }
}

export function toolResponse(data) {
  const { label, score } = classifyResponse(data, toolOptions)
  if (score === null) throw new Error('missing_probability_distribution')
  return { prediction: toolLabels[toolOptions.indexOf(label)], score,
    probabilities: Object.fromEntries(toolLabels.map((name, i) => [name, data.this_that.probabilities[toolOptions[i]]])) }
}

export function keywordShortlist(scenario) {
  // ponytail: literal Chinese bigrams only; experimental comparator, not production semantic retrieval.
  const bigrams = (value) => new Set([...value.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)]
    .flatMap(([word]) => [...word].slice(1).map((_, i) => [...word].slice(i, i + 2).join(''))))
  const query = bigrams(scenario.request + scenario.context)
  return syntheticTools.map((t) => ({ name: t.name, tie: hash(t.name),
    score: [...bigrams(t.description)].filter((word) => query.has(word)).length }))
    .sort((a, b) => b.score - a.score || a.tie.localeCompare(b.tie)).slice(0, 3).map((t) => t.name)
}

export function measureToolSearch(scenarios, rows) {
  const queryResults = scenarios.map((s) => {
    const found = names.map((name) => rows.find((r) => r.queryId === s.id && r.tool === name))
    const complete = found.every(Boolean)
    const selected = complete ? found.filter((r) => r.prediction === 'needed').map((r) => r.tool) : []
    const fallback = !complete ? 'incomplete' : found.some((r) => r.prediction === 'insufficient') ? 'uncertain'
      : !selected.length ? 'empty' : null
    return { queryId: s.id, required: s.required, readOnly: s.readOnly, complete, selected,
      keyword: keywordShortlist(s), effective: fallback ? names : selected, fallback,
      modelMs: complete ? sum(found.map((r) => r.ms)) : null }
  })
  const complete = queryResults.filter((q) => q.complete)
  const pairs = scenarios.flatMap((s) => names.map((name) => {
    const row = rows.find((r) => r.queryId === s.id && r.tool === name)
    return row ? { ...row, gold: gold(s, name) } : null
  })).filter(Boolean)
  const selection = (qs, field) => {
    const positives = qs.filter((q) => q.required.length)
    const negatives = qs.filter((q) => !q.required.length)
    const tp = sum(qs.map((q) => q[field].filter((id) => q.required.includes(id)).length))
    return { queries: qs.length, selectedTools: sum(qs.map((q) => q[field].length)), truePositives: tp,
      requiredTools: sum(qs.map((q) => q.required.length)), recall: ratio(tp, sum(qs.map((q) => q.required.length))),
      precision: ratio(tp, sum(qs.map((q) => q[field].length))),
      positiveQueries: positives.length, allRequiredCovered: positives.filter((q) => q.required.every((id) => q[field].includes(id))).length,
      exactSets: qs.filter((q) => q.required.length === q[field].length && q.required.every((id) => q[field].includes(id))).length,
      noToolQueries: negatives.length, noToolFalseAccepts: negatives.filter((q) => q[field].length).length,
      readOnlyQueries: qs.filter((q) => q.readOnly).length,
      readOnlyRiskyQueries: qs.filter((q) => q.readOnly && q[field].some((id) => risky.has(id))).length,
      schemaTokensTotalEstimate: sum(qs.map((q) => schemaTokens(q[field]))),
      schemaReductionEstimate: qs.length ? 1 - sum(qs.map((q) => schemaTokens(q[field]))) / (schemaTokens(names) * qs.length) : null }
  }
  const confusion = Object.fromEntries(toolLabels.map((g) => [g,
    Object.fromEntries(toolLabels.map((p) => [p, pairs.filter((r) => r.gold === g && r.prediction === p).length]))]))
  const perClass = Object.fromEntries(toolLabels.map((label) => {
    const support = pairs.filter((r) => r.gold === label).length
    const predicted = pairs.filter((r) => r.prediction === label).length
    const correct = confusion[label][label]
    return [label, { support, predicted, correct, precision: ratio(correct, predicted), recall: ratio(correct, support),
      f1: support + predicted ? 2 * correct / (support + predicted) : 0 }]
  }))
  const raw = selection(complete, 'selected')
  return { queries: scenarios.length, completedQueries: complete.length, completedPairs: pairs.length,
    keywordAll: selection(queryResults, 'keyword'), keywordPaired: selection(complete, 'keyword'), classifierOnly: raw,
    catalogAfterFallback: selection(complete, 'effective'), fallbackQueries: complete.filter((q) => q.fallback).length,
    fallbackRescuedQueries: complete.filter((q) => q.fallback && q.required.some((id) => !q.selected.includes(id))).length,
    fullCatalog: { toolsPerQuery: names.length, requiredAvailabilityRecall: 1, schemaTokensPerQueryEstimate: schemaTokens(names),
      mainModelSelectionAccuracy: null },
    classification: { accuracy: mean(pairs.map((r) => Number(r.gold === r.prediction))),
      macroF1: pairs.length ? mean(Object.values(perClass).map((v) => v.f1)) : null, perClass, confusion },
    callLatency: latency(pairs.map((r) => r.ms)), serialQueryLatency: latency(complete.map((q) => q.modelMs)),
    endToEndLatency: null, argumentValidity: null, executionSuccess: null,
    gate: complete.length === scenarios.length && raw.recall === 1 && raw.noToolFalseAccepts === 0 && raw.readOnlyRiskyQueries === 0,
    queryResults }
}

async function main() {
  const { values } = parseArgs({ options: { remote: { type: 'boolean', default: false },
    'key-stdin': { type: 'boolean', default: false }, output: { type: 'string' } } })
  if (values.remote && !values.output) throw new Error('remote_requires_new_output')
  const ordered = toolScenarios.flatMap((s) => [...syntheticTools].sort((a, b) => hash(s.id + a.name).localeCompare(hash(s.id + b.name)))
    .map((t) => ({ queryId: s.id, tool: t.name, split: s.split, body: toolRequest(s, t) })))
  if (ordered.length !== 192) throw new Error('unexpected_request_count')
  const report = { startedAt: new Date().toISOString(), version: toolSearchVersion, model, modelRevision: null,
    scope: 'synthetic-tool-suitability-only', productionAdmission: false,
    goldSource: 'agent-authored synthetic required capability sets; not independently human-adjudicated',
    protocol: { plannedRequests: 192, devQueries: 8, holdoutQueries: 16, toolsPerQuery: 8, promptVariants: 1,
      thresholdTuning: false, noRetry: true, decision: 'required recall=1; no read-only risky recommendations; no no-tool false accepts',
      keyword: 'experimental bigram overlap top3, not current production baseline',
      fallback: 'incomplete, any insufficient or no needed => original full authorized catalog; not successful classification',
      notEvaluated: ['real tools', 'main model', 'arguments', 'tool ordering', 'authorization', 'end-to-end latency', 'production distribution'] },
    datasetSha256: hash({ tools: syntheticTools, scenarios: toolScenarios }), requestSha256: hash(ordered),
    implementationSha256: Object.fromEntries(['./evalAgentToolSearchO5.mjs', './fixtures/agentToolSearchO5.mjs',
      './evalAgentDecisionO5.mjs', '../server/agent/context/agentContextBudget.mjs'].map((file) =>
      [file, createHash('sha256').update(readFileSync(new URL(file, import.meta.url))).digest('hex')])),
    syntheticTools, syntheticQueries: toolScenarios, rows: [], attemptedRequests: 0, stopped: null,
    pricing: null, responseModels: [], reportedCostHeaders: { count: 0, total: 0 },
    usage: { reportedCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 } }
  const fd = values.output ? openSync(values.output, 'wx', 0o600) : null
  try {
    if (values.remote) {
      let key = process.env.FLOCK_O5_API_KEY
      if (values['key-stdin']) {
        const rl = createInterface({ input: process.stdin })
        console.error('O5 tool search credential input ready (terminal echo must be disabled).')
        key = await rl.question(''); rl.close()
      }
      if (!key?.trim()) throw new Error('missing_key')
      const headers = { 'Content-Type': 'application/json', 'x-litellm-api-key': key.trim() }
      const pricing = await fetch('https://api.flock.io/model/info', { headers, redirect: 'error', signal: AbortSignal.timeout(25000) })
      if (!pricing.ok) throw new Error('pricing_unverified')
      const info = (await pricing.json()).data?.find((m) => m.model_name === model)?.model_info
      if (!info) throw new Error('pricing_unverified')
      const cost = (value) => Number.isFinite(value) && value >= 0 ? value : null
      report.pricing = { source: 'https://api.flock.io/model/info', checkedAt: new Date().toISOString(),
        inputCostPerToken: cost(info.input_cost_per_token), outputCostPerToken: cost(info.output_cost_per_token),
        costPerRequest: cost(info.input_cost_per_request), actualBill: null }
      for (const item of ordered) {
        report.attemptedRequests++
        const start = performance.now()
        try {
          const response = await fetch('https://api.flock.io/v1/chat/completions', { method: 'POST', headers,
            body: JSON.stringify(item.body), redirect: 'error', signal: AbortSignal.timeout(25000) })
          const rawCost = response.headers.get('x-litellm-response-cost')
          const reportedCost = rawCost?.trim() ? Number(rawCost) : NaN
          if (Number.isFinite(reportedCost) && reportedCost >= 0) { report.reportedCostHeaders.count++; report.reportedCostHeaders.total += reportedCost }
          if (!response.ok) { report.stopped = { queryId: item.queryId, tool: item.tool, reason: `http_${response.status}` }; break }
          const data = await response.json()
          const result = toolResponse(data)
          if (typeof data.model === 'string' && !report.responseModels.includes(data.model)) report.responseModels.push(data.model)
          const usage = data.usage
          if (['prompt_tokens', 'completion_tokens', 'total_tokens'].every((k) => Number.isSafeInteger(usage?.[k]) && usage[k] >= 0)) {
            report.usage.reportedCalls++; report.usage.promptTokens += usage.prompt_tokens
            report.usage.completionTokens += usage.completion_tokens; report.usage.totalTokens += usage.total_tokens
          }
          report.rows.push({ queryId: item.queryId, tool: item.tool, split: item.split, ...result, ms: performance.now() - start,
            promptTokens: usage?.prompt_tokens ?? null })
          if (report.rows.length % 16 === 0) console.error(`O5 tool search ${report.rows.length}/192 complete`)
        } catch {
          report.stopped = { queryId: item.queryId, tool: item.tool, reason: 'network_or_protocol_error' }
          break
        }
      }
    }
  } catch (error) {
    report.stopped = { reason: ['missing_key', 'pricing_unverified'].includes(error?.message) ? error.message : 'remote_preflight_error' }
  } finally {
    report.finishedAt = new Date().toISOString()
    report.status = report.stopped ? 'incomplete' : values.remote ? 'synthetic_evaluated_not_production_ready' : 'prepared_not_evaluated'
    report.metrics = Object.fromEntries(['dev', 'holdout'].map((split) => [split,
      measureToolSearch(toolScenarios.filter((s) => s.split === split), report.rows)]))
    const serialized = JSON.stringify(report, null, 2) + '\n'
    if (fd !== null) { try { writeFileSync(fd, serialized) } finally { closeSync(fd) } } else console.log(serialized)
  }
  if (report.stopped) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const reason = error?.code === 'EEXIST' ? 'output_exists_no_requests_sent'
      : ['remote_requires_new_output', 'invalid_synthetic_input', 'unexpected_request_count'].includes(error?.message) ? error.message : 'preflight_or_report_error'
    console.error(`O5_TOOL_SEARCH_UNVERIFIED: ${reason}；没有接入生产。`)
    process.exitCode = 2
  })
}
