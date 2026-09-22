// Offline experiment only: synthetic in-memory records, no environment files or real project reads.
import { createHash } from 'node:crypto'
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline/promises'
import { queryCanvasForAgent } from '../server/canvas/canvasAgentQuery.mjs'
import { createAgentOperationalReaders } from '../server/observability/agentOperationalReaders.mjs'
import { selectBotanicAgentMemory } from '../server/agent/semantic/botanicAgentMemory.mjs'
import { classifyResponse } from './evalAgentDecisionO5.mjs'
import { candidateScenarios, candidateVersion, candidateLabels, candidateOptions, candidateQuestion } from './fixtures/agentCandidateO5.mjs'

const model = 'this-that-model-1.0'
const sourceNames = { canvas: '当前画布文字记录', artifacts: '历史产物文字摘要', rules: '已保存规则正文' }
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const ratio = (n, d) => d ? n / d : null
const mean = (values) => ratio(values.reduce((sum, value) => sum + value, 0), values.length)
const latency = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  return { n: sorted.length, p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null }
}

export function candidateRequest(scenario, candidate) {
  const state = { 检索请求: scenario.request, 来源: sourceNames[scenario.source],
    候选: { 标题: candidate.title, 正文: candidate.description } }
  const serialized = JSON.stringify(state)
  if (!sourceNames[scenario.source] || Buffer.byteLength(serialized + candidateQuestion) > 1800) throw new Error('invalid_synthetic_input')
  return {
    model, messages: [{ role: 'user', content: serialized }, { role: 'user', content: candidateQuestion }],
    stream: false, temperature: 1, max_tokens: 32,
    response_format: { type: 'json_schema', json_schema: { name: 'candidate_match', strict: true, schema: {
      type: 'object', properties: { intent: { type: 'string', enum: candidateOptions } },
      required: ['intent'], additionalProperties: false,
    } } },
  }
}

export function candidateResponse(data) {
  const { label, score } = classifyResponse(data, candidateOptions)
  if (score === null) throw new Error('missing_probability_distribution')
  return { prediction: candidateLabels[candidateOptions.indexOf(label)], score,
    probabilities: Object.fromEntries(candidateLabels.map((name, i) => [name, data.this_that.probabilities[candidateOptions[i]]])) }
}

export async function prepareCandidates(scenarios = candidateScenarios) {
  const prepared = []
  for (const scenario of scenarios) {
    const start = performance.now()
    let found
    if (scenario.source === 'canvas') {
      const document = { nodes: scenario.candidates.map((c) => ({ id: c.id, type: 'text',
        data: { label: c.title, content: c.description }, position: { x: 0, y: 0 } })), edges: [] }
      found = queryCanvasForAgent(document, { mode: 'keyword', query: scenario.query, limit: 3 }).nodes
        .map((c) => ({ id: c.id, title: c.label, description: c.content ?? '' }))
    } else if (scenario.source === 'artifacts') {
      // Synthetic Store seam only. Chronological order is frozen independently of gold.
      const records = scenario.candidates.map((c, i) => ({ id: c.id, kind: 'image', label: c.title, createdAt: 1_790_000_000_000 - i }))
      const productStore = { listAgentArtifacts: async () => records }
      const readers = createAgentOperationalReaders({ productStore, userId: 'synthetic', projectId: 'synthetic' })
      found = (await readers.searchArtifacts({ query: scenario.query, kind: 'image', limit: 3 })).artifacts
        .map((c) => ({ id: c.id, title: c.label, description: '' }))
    } else if (scenario.source === 'rules') {
      const memory = scenario.candidates.map((c, i) => ({ id: c.id, kind: 'rule', content: c.description,
        status: 'active', source: 'human', scope: 'project', confidence: 'confirmed', updatedAt: 1_790_000_000_000 - i }))
      found = selectBotanicAgentMemory(memory, { query: scenario.query, limit: 3 }).items
        .map((c) => ({ id: c.id, title: '', description: c.content }))
    } else throw new Error('invalid_synthetic_input')
    prepared.push({ ...scenario, baselineMs: performance.now() - start,
      poolGold: scenario.candidates.map(({ id, gold }) => ({ id, gold })),
      candidates: found.map((c) => {
        const gold = scenario.candidates.find((item) => item.id === c.id)
        if (!gold) throw new Error('unknown_baseline_candidate')
        return { ...c, gold: gold.gold, rationale: gold.rationale }
      }) })
  }
  return prepared
}

export function rankCandidates(scenario, rows) {
  const predictions = scenario.candidates.map((c) => rows.find((r) => r.queryId === scenario.id && r.id === c.id))
  const complete = predictions.every(Boolean)
  const matches = complete ? scenario.candidates.filter((_, i) => predictions[i].prediction === 'match') : []
  matches.sort((a, b) => predictions[scenario.candidates.indexOf(b)].probabilities.match
    - predictions[scenario.candidates.indexOf(a)].probabilities.match)
  const promoted = new Set(matches.map((c) => c.id))
  const order = [...matches, ...scenario.candidates.filter((c) => !promoted.has(c.id))].map((c) => c.id)
  return { complete, order, suggestedId: matches[0]?.id ?? null }
}

export function measureCandidates(scenarios, rows) {
  const assessments = scenarios.map((s) => {
    const ranked = rankCandidates(s, rows)
    const goldFor = (id) => s.poolGold.find((c) => c.id === id)?.gold
    const baselineOrder = s.candidates.map((c) => c.id)
    const positive = s.poolGold.some((c) => c.gold === 'match')
    const reciprocalRank = (ids) => {
      const index = ids.findIndex((id) => goldFor(id) === 'match')
      return index < 0 ? 0 : 1 / (index + 1)
    }
    return { queryId: s.id, source: s.source, category: s.category, positive, ...ranked, baselineOrder,
      baselineCorrect: goldFor(baselineOrder[0]) === 'match', rerankedCorrect: goldFor(ranked.order[0]) === 'match',
      baselineRR: reciprocalRank(baselineOrder), rerankedRR: reciprocalRank(ranked.order),
      retrievedRelevant: s.candidates.filter((c) => c.gold === 'match').length,
      poolRelevant: s.poolGold.filter((c) => c.gold === 'match').length,
      suggestionCorrect: ranked.suggestedId ? goldFor(ranked.suggestedId) === 'match' : null,
      harmfulPromotions: ranked.order.filter((id, i) => goldFor(id) !== 'match' && i < baselineOrder.indexOf(id)).length }
  })
  const complete = assessments.filter((q) => q.complete)
  const positives = complete.filter((q) => q.positive)
  const negatives = complete.filter((q) => !q.positive)
  const suggestions = complete.filter((q) => q.suggestedId)
  const pairs = scenarios.flatMap((s) => s.candidates.map((c) => {
    const row = rows.find((r) => r.queryId === s.id && r.id === c.id)
    return row ? { ...row, gold: c.gold } : null
  })).filter(Boolean)
  const confusion = Object.fromEntries(candidateLabels.map((gold) => [gold,
    Object.fromEntries(candidateLabels.map((predicted) => [predicted, pairs.filter((r) => r.gold === gold && r.prediction === predicted).length]))]))
  const perClass = Object.fromEntries(candidateLabels.map((label) => {
    const support = pairs.filter((r) => r.gold === label).length
    const predicted = pairs.filter((r) => r.prediction === label).length
    const correct = confusion[label][label]
    return [label, { support, predicted, correct, precision: ratio(correct, predicted), recall: ratio(correct, support),
      f1: support + predicted ? 2 * correct / (support + predicted) : 0 }]
  }))
  const basePositives = assessments.filter((q) => q.positive)
  return {
    queries: scenarios.length, completedQueries: complete.length, expectedPairs: scenarios.reduce((n, s) => n + s.candidates.length, 0),
    completedPairs: pairs.length,
    baselineAll: { positiveQueries: basePositives.length, top1Correct: basePositives.filter((q) => q.baselineCorrect).length,
      hitAt1: mean(basePositives.map((q) => Number(q.baselineCorrect))), mrr: mean(basePositives.map((q) => q.baselineRR)),
      recallAt3: ratio(assessments.reduce((n, q) => n + q.retrievedRelevant, 0), assessments.reduce((n, q) => n + q.poolRelevant, 0)) },
    rankingPaired: { positiveQueries: positives.length, baselineTop1Correct: positives.filter((q) => q.baselineCorrect).length,
      rerankedTop1Correct: positives.filter((q) => q.rerankedCorrect).length,
      baselineHitAt1: mean(positives.map((q) => Number(q.baselineCorrect))), rerankedHitAt1: mean(positives.map((q) => Number(q.rerankedCorrect))),
      baselineMrr: mean(positives.map((q) => q.baselineRR)), rerankedMrr: mean(positives.map((q) => q.rerankedRR)),
      improvedQueries: positives.filter((q) => !q.baselineCorrect && q.rerankedCorrect).length,
      regressedQueries: positives.filter((q) => q.baselineCorrect && !q.rerankedCorrect).length,
      harmfulCandidatePromotions: complete.reduce((n, q) => n + q.harmfulPromotions, 0) },
    suggestions: { queries: complete.length, offered: suggestions.length,
      correct: suggestions.filter((q) => q.suggestionCorrect).length,
      coverage: ratio(suggestions.length, complete.length), precision: mean(suggestions.map((q) => Number(q.suggestionCorrect))),
      positiveQueriesWithoutSuggestion: positives.filter((q) => !q.suggestedId).length,
      noMatchQueries: negatives.length, noMatchFalseAccepts: negatives.filter((q) => q.suggestedId).length },
    classification: { accuracy: mean(pairs.map((r) => Number(r.gold === r.prediction))),
      macroF1: pairs.length ? mean(Object.values(perClass).map((c) => c.f1)) : null, perClass, confusion,
      multiclassBrier: mean(pairs.map((r) => candidateLabels.reduce((n, l) => n + (r.probabilities[l] - Number(l === r.gold)) ** 2, 0))),
      highScore: { n: pairs.filter((r) => r.score >= 0.95).length, errors: pairs.filter((r) => r.score >= 0.95 && r.prediction !== r.gold).length } },
    baselineLatency: latency(scenarios.map((s) => s.baselineMs)), candidateCallLatency: latency(pairs.map((r) => r.ms)),
    serialQueryModelLatency: latency(complete.map((q) => pairs.filter((r) => r.queryId === q.queryId).reduce((n, r) => n + r.ms, 0))),
    queryResults: assessments,
  }
}

async function main() {
  const { values } = parseArgs({ options: { remote: { type: 'boolean', default: false },
    'key-stdin': { type: 'boolean', default: false }, output: { type: 'string' } } })
  if (values.remote && !values.output) throw new Error('remote_requires_new_output')
  const prepared = await prepareCandidates()
  const ordered = ['dev', 'holdout'].flatMap((split) => prepared.filter((s) => s.split === split)
    .flatMap((s) => s.candidates.map((c) => ({ queryId: s.id, split, id: c.id, body: candidateRequest(s, c) }))))
  if (ordered.length !== 90) throw new Error('unexpected_request_count')
  const report = {
    startedAt: new Date().toISOString(), version: candidateVersion, model, modelRevision: null,
    scope: 'synthetic-offline-only', productionAdmission: false,
    goldSource: 'agent-authored synthetic text evidence; not independently human-adjudicated',
    protocol: { plannedRequests: 90, devQueries: 12, holdoutQueries: 18, candidatesPerQuery: 3,
      language: 'zh', promptVariants: 1, thresholdTuning: false,
      rerank: 'promote argmax match by P(match); preserve other order; no match or incomplete => original order',
      sourceAndQuery: 'fixed synthetic tool inputs; no Planner or source routing evaluation',
      rules: 'display-only comparison; never remove or deactivate confirmed standing rules',
      recall: 'controlled three-candidate pools; Recall@3 is a ceiling check, not full retrieval quality',
      decision: 'holdout net top1 gain, no top1 regression, no no-match false acceptance required to justify further validation; never automatic production admission',
      noRetry: true },
    datasetSha256: hash(candidateScenarios), requestSha256: hash(ordered),
    implementationSha256: Object.fromEntries(['./evalAgentCandidateO5.mjs', './fixtures/agentCandidateO5.mjs',
      './evalAgentDecisionO5.mjs', '../server/canvas/canvasAgentQuery.mjs', '../server/observability/agentOperationalReaders.mjs',
      '../server/agent/semantic/botanicAgentMemory.mjs'].map((file) => [file, createHash('sha256').update(readFileSync(new URL(file, import.meta.url))).digest('hex')])),
    syntheticQueries: prepared.map(({ baselineMs, ...s }) => s), candidateRows: [],
    pricing: null, responseModels: [], reportedCostHeaders: { count: 0, total: 0 },
    usage: { reportedCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    attemptedRequests: 0, stopped: null,
  }
  // Reserve a new artifact before any request: never overwrite earlier evidence or pay then fail on EEXIST.
  const fd = values.output ? openSync(values.output, 'wx', 0o600) : null
  try {
    if (values.remote) {
      let key = process.env.FLOCK_O5_API_KEY
      if (values['key-stdin']) {
        const rl = createInterface({ input: process.stdin })
        console.error('O5 candidate credential input ready (terminal echo must be disabled).')
        key = await rl.question('')
        rl.close()
      }
      if (!key?.trim()) throw new Error('missing_key')
      const headers = { 'Content-Type': 'application/json', 'x-litellm-api-key': key.trim() }
      const pricing = await fetch('https://api.flock.io/model/info', { headers, redirect: 'error', signal: AbortSignal.timeout(25000) })
      if (!pricing.ok) throw new Error('pricing_unverified')
      const info = (await pricing.json()).data?.find((m) => m.model_name === model)?.model_info
      const cost = (v) => Number.isFinite(v) && v >= 0 ? v : null
      report.pricing = { source: 'https://api.flock.io/model/info', checkedAt: new Date().toISOString(),
        inputCostPerToken: cost(info?.input_cost_per_token), outputCostPerToken: cost(info?.output_cost_per_token),
        costPerRequest: cost(info?.input_cost_per_request), actualBill: null }
      for (const item of ordered) {
        const start = performance.now()
        report.attemptedRequests++
        try {
          const response = await fetch('https://api.flock.io/v1/chat/completions', {
            method: 'POST', headers, body: JSON.stringify(item.body), redirect: 'error', signal: AbortSignal.timeout(25000),
          })
          const rawCost = response.headers.get('x-litellm-response-cost')
          const cost = rawCost?.trim() ? Number(rawCost) : NaN
          if (Number.isFinite(cost) && cost >= 0) { report.reportedCostHeaders.count++; report.reportedCostHeaders.total += cost }
          if (!response.ok) { report.stopped = { queryId: item.queryId, id: item.id, reason: `http_${response.status}` }; break }
          const data = await response.json()
          const result = candidateResponse(data)
          if (typeof data.model === 'string' && !report.responseModels.includes(data.model)) report.responseModels.push(data.model)
          const usage = data.usage
          if (['prompt_tokens', 'completion_tokens', 'total_tokens'].every((k) => Number.isSafeInteger(usage?.[k]) && usage[k] >= 0)) {
            report.usage.reportedCalls++; report.usage.promptTokens += usage.prompt_tokens
            report.usage.completionTokens += usage.completion_tokens; report.usage.totalTokens += usage.total_tokens
          }
          report.candidateRows.push({ queryId: item.queryId, split: item.split, id: item.id, ...result, ms: performance.now() - start })
          if (report.candidateRows.length % 15 === 0) console.error(`O5 candidates ${report.candidateRows.length}/90 complete`)
        } catch {
          report.stopped = { queryId: item.queryId, id: item.id, reason: 'network_or_protocol_error' }
          break // An uncertain/billed attempt is never automatically repeated.
        }
      }
    }
  } catch (error) {
    report.stopped = { reason: ['missing_key', 'pricing_unverified'].includes(error?.message) ? error.message : 'remote_preflight_error' }
  } finally {
    report.finishedAt = new Date().toISOString()
    report.status = report.stopped ? 'incomplete' : values.remote ? 'synthetic_evaluated_not_production_ready' : 'prepared_not_evaluated'
    report.metrics = Object.fromEntries(['dev', 'holdout'].map((split) => [split,
      measureCandidates(prepared.filter((s) => s.split === split), report.candidateRows)]))
    report.bySource = Object.fromEntries(Object.keys(sourceNames).map((source) => [source,
      measureCandidates(prepared.filter((s) => s.split === 'holdout' && s.source === source), report.candidateRows)]))
    const result = JSON.stringify(report, null, 2) + '\n'
    if (fd !== null) { try { writeFileSync(fd, result) } finally { closeSync(fd) } } else console.log(result)
  }
  if (report.stopped) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const reason = error?.code === 'EEXIST' ? 'output_exists_no_requests_sent'
      : ['remote_requires_new_output', 'invalid_synthetic_input', 'unexpected_request_count'].includes(error?.message) ? error.message : 'preflight_or_report_error'
    console.error(`O5_CANDIDATE_UNVERIFIED: ${reason}；没有接入生产。`)
    process.exitCode = 2
  })
}
